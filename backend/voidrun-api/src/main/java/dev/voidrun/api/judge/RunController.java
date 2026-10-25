package dev.voidrun.api.judge;

import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.api.outbox.OutboxWriter;
import dev.voidrun.api.ratelimit.RateLimiter;
import dev.voidrun.api.security.CurrentUser;
import dev.voidrun.api.web.ApiException;
import dev.voidrun.api.web.CorrelationIdFilter;
import dev.voidrun.common.Language;
import dev.voidrun.common.Topics;
import dev.voidrun.common.events.JudgeJob;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The editor's Run button: the caller's code against the public samples or
 * their own input. Judged by the same workers as submissions but on its own
 * topic, and never affects a verdict.
 */
@RestController
@RequestMapping("/api/v1/runs")
public class RunController {

    /** Upper bound for {@code ?wait_ms}: long enough to cover a typical run, short of proxy timeouts. */
    static final long MAX_WAIT_MS = 10_000;
    private static final long POLL_MS = 150;

    public record CreateRunRequest(String problemId, String language, String sourceCode, String mode, String stdin) {}

    public record CreateRunResponse(UUID runId, String status) {}

    public record RunCase(
            int position, String label, String input, String expectedOutput, String stdout, String stderr,
            boolean stdoutTruncated, boolean stderrTruncated, String execStatus, Boolean passed, Integer timeMs,
            Long memoryBytes, Integer exitCode, Integer signal) {}

    public record Run(
            UUID runId, String problemSlug, String language, String mode, String status, String outcome,
            String compileOutput, Integer compileTimeMs, List<RunCase> cases, Instant createdAt,
            Instant finishedAt, String message) {}

    private final JdbcClient jdbc;
    private final OutboxWriter outbox;
    private final RateLimiter limiter;
    private final TransactionTemplate tx;
    private final VoidRunProperties props;

    public RunController(JdbcClient jdbc, OutboxWriter outbox, RateLimiter limiter, TransactionTemplate tx,
            VoidRunProperties props) {
        this.jdbc = jdbc;
        this.outbox = outbox;
        this.limiter = limiter;
        this.tx = tx;
        this.props = props;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    CreateRunResponse create(@AuthenticationPrincipal Jwt jwt, @RequestBody CreateRunRequest req) {
        UUID userId = CurrentUser.id(jwt);
        // Executing code is the most expensive thing the platform does.
        limiter.check("run", userId.toString(), "too many runs; please wait before running again");

        Language language = SourceRules.language(req.language());
        String mode = mode(req.mode());
        SourceRules.source(req.sourceCode(), props.limits());
        String stdin = req.stdin() == null ? "" : req.stdin();
        if (stdin.getBytes(StandardCharsets.UTF_8).length > props.limits().maxInputBytes()) {
            throw ApiException.badRequest("stdin must be at most " + props.limits().maxInputBytes() + " bytes");
        }
        if (mode.equals("SAMPLES") && !stdin.isEmpty()) {
            throw ApiException.badRequest("stdin is only accepted when mode is \"custom\"");
        }
        UUID problemId = SourceRules.runnableProblem(jdbc, req.problemId(), userId);
        if (mode.equals("SAMPLES")) {
            long samples = jdbc.sql("SELECT count(*) FROM test_cases WHERE problem_id = ? AND is_sample")
                    .param(problemId)
                    .query(Long.class)
                    .single();
            if (samples == 0) {
                throw ApiException.badRequest("this problem has no public samples; supply custom input instead");
            }
        }

        String correlationId = CorrelationIdFilter.current();
        UUID runId = tx.execute(status -> {
            UUID id = jdbc.sql("""
                            INSERT INTO runs (user_id, problem_id, language, source_code, mode, stdin, expires_at,
                                              correlation_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""")
                    .params(userId, problemId, language.id(), req.sourceCode(), mode, stdin,
                            Timestamp.from(Instant.now().plus(props.runRetention())), correlationId)
                    .query(UUID.class)
                    .single();
            outbox.append(Topics.RUNS, id.toString(), "run.created", id, JudgeJob.run(id, correlationId),
                    correlationId);
            return id;
        });
        return new CreateRunResponse(runId, "QUEUED");
    }

    /**
     * The run, held open until it finishes or {@code wait_ms} passes. Waiting
     * here is on a database row, not on a compiler, and the request runs on a
     * virtual thread, so a held request costs almost nothing.
     */
    @GetMapping("/{id}")
    Run get(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
            @RequestParam(name = "wait_ms", required = false) Long waitMs) throws InterruptedException {
        UUID userId = CurrentUser.id(jwt);
        long deadline = System.currentTimeMillis() + Math.max(0, Math.min(waitMs == null ? 0 : waitMs, MAX_WAIT_MS));
        while (true) {
            Run run = load(id, userId);
            if (run.status().equals("FINISHED") || System.currentTimeMillis() >= deadline) {
                return run;
            }
            Thread.sleep(POLL_MS);
        }
    }

    private Run load(UUID id, UUID userId) {
        Run run = jdbc.sql("""
                        SELECT r.*, p.slug AS problem_slug FROM runs r JOIN problems p ON p.id = r.problem_id
                        WHERE r.id = ? AND r.user_id = ?""")
                .params(id, userId)
                .query((rs, i) -> mapRun(rs))
                .optional()
                .orElseThrow(() -> ApiException.notFound("run not found"));
        if (!run.status().equals("FINISHED")) {
            return run;
        }
        List<RunCase> cases = jdbc.sql("SELECT * FROM run_cases WHERE run_id = ? ORDER BY position")
                .param(id)
                .query((rs, i) -> new RunCase(rs.getInt("position"), rs.getString("label"), rs.getString("input"),
                        rs.getString("expected_output"), rs.getString("stdout"), rs.getString("stderr"),
                        rs.getBoolean("stdout_truncated"), rs.getBoolean("stderr_truncated"),
                        rs.getString("exec_status"), (Boolean) rs.getObject("passed"),
                        (Integer) rs.getObject("time_ms"), (Long) rs.getObject("memory_bytes"),
                        (Integer) rs.getObject("exit_code"), (Integer) rs.getObject("signal")))
                .list();
        return new Run(run.runId(), run.problemSlug(), run.language(), run.mode(), run.status(), run.outcome(),
                run.compileOutput(), run.compileTimeMs(), cases, run.createdAt(), run.finishedAt(), run.message());
    }

    private static Run mapRun(ResultSet rs) throws SQLException {
        String outcome = rs.getString("outcome");
        Timestamp finished = rs.getTimestamp("finished_at");
        return new Run(rs.getObject("id", UUID.class), rs.getString("problem_slug"), rs.getString("language"),
                rs.getString("mode"), rs.getString("status"), outcome, rs.getString("compile_output"),
                (Integer) rs.getObject("compile_time_ms"), List.of(), rs.getTimestamp("created_at").toInstant(),
                finished == null ? null : finished.toInstant(),
                "INTERNAL_ERROR".equals(outcome) ? "The judge could not run your code. Please try again." : null);
    }

    private static String mode(String raw) {
        String m = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
        return switch (m) {
            case "", "samples" -> "SAMPLES";
            case "custom" -> "CUSTOM";
            default -> throw ApiException.badRequest("mode must be \"samples\" or \"custom\"");
        };
    }
}

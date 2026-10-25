package dev.voidrun.api.judge;

import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.api.outbox.OutboxWriter;
import dev.voidrun.api.ratelimit.RateLimiter;
import dev.voidrun.api.security.CurrentUser;
import dev.voidrun.api.web.ApiException;
import dev.voidrun.api.web.CorrelationIdFilter;
import dev.voidrun.api.web.Page;
import dev.voidrun.common.Language;
import dev.voidrun.common.Topics;
import dev.voidrun.common.Verdict;
import dev.voidrun.common.events.JudgeJob;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
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
 * Submissions judged against hidden tests. Accepting one is a single
 * transaction that writes the submission and its outbox event together, so an
 * accepted submission can never be lost between the database and Kafka.
 */
@RestController
@RequestMapping("/api/v1/submissions")
public class SubmissionController {

    public record CreateSubmissionRequest(String problemId, String language, String sourceCode) {}

    public record CreateSubmissionResponse(UUID submissionId, String status) {}

    public record SubmissionSummary(
            UUID submissionId, String problemSlug, String problemTitle, String language, String status,
            String verdict, int passedTests, int totalTests, Integer executionTimeMs, Long memoryBytes,
            Instant createdAt) {}

    public record Submission(
            UUID submissionId, String problemSlug, String problemTitle, String language, String status,
            String verdict, int passedTests, int totalTests, Integer executionTimeMs, Long memoryBytes,
            Instant createdAt, String username, int score, int maxScore, Integer failedCasePosition,
            Instant finishedAt, String sourceCode, String compileOutput, String message) {}

    public record TestResult(
            int position, boolean isSample, String verdict, Integer executionTimeMs, Long memoryBytes,
            int pointsAwarded) {}

    public record TestResults(
            UUID submissionId, String status, String verdict, int passedTests, int totalTests,
            List<TestResult> results) {}

    private static final String SELECT = """
            SELECT s.*, p.slug AS problem_slug, p.title AS problem_title, u.username
            FROM submissions s JOIN problems p ON p.id = s.problem_id JOIN users u ON u.id = s.user_id""";

    private final JdbcClient jdbc;
    private final OutboxWriter outbox;
    private final RateLimiter limiter;
    private final TransactionTemplate tx;
    private final VoidRunProperties props;

    public SubmissionController(JdbcClient jdbc, OutboxWriter outbox, RateLimiter limiter, TransactionTemplate tx,
            VoidRunProperties props) {
        this.jdbc = jdbc;
        this.outbox = outbox;
        this.limiter = limiter;
        this.tx = tx;
        this.props = props;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    CreateSubmissionResponse create(@AuthenticationPrincipal Jwt jwt, @RequestBody CreateSubmissionRequest req) {
        UUID userId = CurrentUser.id(jwt);
        limiter.check("submit", userId.toString(), "too many submissions; please wait before submitting again");
        Language language = SourceRules.language(req.language());
        SourceRules.source(req.sourceCode(), props.limits());
        UUID problemId = SourceRules.practiceProblem(jdbc, req.problemId(), userId);
        long tests = jdbc.sql("SELECT count(*) FROM test_cases WHERE problem_id = ?")
                .param(problemId)
                .query(Long.class)
                .single();
        if (tests == 0) {
            throw ApiException.badRequest("this problem has no test cases yet and cannot be judged");
        }

        String correlationId = CorrelationIdFilter.current();
        UUID id = tx.execute(status -> {
            UUID sid = jdbc.sql("""
                            INSERT INTO submissions (user_id, problem_id, language, source_code, correlation_id)
                            VALUES (?, ?, ?, ?, ?) RETURNING id""")
                    .params(userId, problemId, language.id(), req.sourceCode(), correlationId)
                    .query(UUID.class)
                    .single();
            outbox.append(Topics.SUBMISSIONS, sid.toString(), "submission.created", sid,
                    JudgeJob.submission(sid, correlationId), correlationId);
            return sid;
        });
        return new CreateSubmissionResponse(id, "QUEUED");
    }

    @GetMapping
    Page<SubmissionSummary> list(
            @AuthenticationPrincipal Jwt jwt,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer limit,
            @RequestParam(required = false) String problem,
            @RequestParam(required = false) String verdict,
            @RequestParam(required = false) String language) {
        Page.Request p = Page.Request.of(page, limit);
        StringBuilder where = new StringBuilder(" WHERE s.user_id = ?");
        List<Object> args = new ArrayList<>(List.of(CurrentUser.id(jwt)));
        if (problem != null && !problem.isBlank()) {
            where.append(" AND p.slug = ?");
            args.add(problem.trim());
        }
        if (verdict != null && !verdict.isBlank()) {
            String v = verdict.trim().toUpperCase(Locale.ROOT);
            if (Arrays.stream(Verdict.values()).noneMatch(x -> x.name().equals(v))) {
                throw ApiException.badRequest("unknown verdict " + verdict);
            }
            where.append(" AND s.verdict = ?");
            args.add(v);
        }
        if (language != null && !language.isBlank()) {
            where.append(" AND s.language = ?");
            args.add(SourceRules.language(language).id());
        }
        long total = jdbc.sql("SELECT count(*) FROM submissions s JOIN problems p ON p.id = s.problem_id" + where)
                .params(args)
                .query(Long.class)
                .single();
        List<Object> pageArgs = new ArrayList<>(args);
        pageArgs.add(p.limit());
        pageArgs.add(p.offset());
        List<SubmissionSummary> items = jdbc.sql(SELECT + where + " ORDER BY s.created_at DESC LIMIT ? OFFSET ?")
                .params(pageArgs)
                .query((rs, i) -> summary(rs))
                .list();
        return p.wrap(items, total);
    }

    /** Owner or admin only; anyone else gets 404, which does not confirm the id exists. */
    @GetMapping("/{id}")
    Submission get(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return visible(jwt, id, (rs, i) -> {
            SubmissionSummary s = summary(rs);
            Timestamp finished = rs.getTimestamp("finished_at");
            return new Submission(s.submissionId(), s.problemSlug(), s.problemTitle(), s.language(), s.status(),
                    s.verdict(), s.passedTests(), s.totalTests(), s.executionTimeMs(), s.memoryBytes(), s.createdAt(),
                    rs.getString("username"), rs.getInt("score"), rs.getInt("max_score"),
                    (Integer) rs.getObject("failed_case_position"), finished == null ? null : finished.toInstant(),
                    rs.getString("source_code"), rs.getString("compile_output"),
                    "INTERNAL_ERROR".equals(s.verdict())
                            ? "The judge could not finish this submission. Please submit again."
                            : null);
        });
    }

    /** Per-test outcomes. Never the hidden inputs or expected outputs. */
    @GetMapping("/{id}/test-results")
    TestResults testResults(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        SubmissionSummary s = visible(jwt, id, (rs, i) -> summary(rs));
        List<TestResult> results = jdbc.sql("""
                        SELECT position, is_sample, verdict, execution_time_ms, memory_bytes, points_awarded
                        FROM submission_results WHERE submission_id = ? ORDER BY position""")
                .param(id)
                .query((rs, i) -> new TestResult(rs.getInt("position"), rs.getBoolean("is_sample"),
                        rs.getString("verdict"), (Integer) rs.getObject("execution_time_ms"),
                        (Long) rs.getObject("memory_bytes"), rs.getInt("points_awarded")))
                .list();
        return new TestResults(id, s.status(), s.verdict(), s.passedTests(), s.totalTests(), results);
    }

    private <T> T visible(Jwt jwt, UUID id, org.springframework.jdbc.core.RowMapper<T> mapper) {
        boolean admin = CurrentUser.isAdmin(jwt);
        return jdbc.sql(SELECT + " WHERE s.id = ? AND (s.user_id = ? OR ?)")
                .params(id, CurrentUser.id(jwt), admin)
                .query(mapper)
                .optional()
                .orElseThrow(() -> ApiException.notFound("submission not found"));
    }

    /** Lifecycle and outcome flattened into one field: QUEUED, RUNNING, or the verdict. */
    static String flatStatus(String status, String verdict) {
        return "FINISHED".equals(status) && verdict != null ? verdict : status;
    }

    private static SubmissionSummary summary(ResultSet rs) throws SQLException {
        String verdict = rs.getString("verdict");
        return new SubmissionSummary(rs.getObject("id", UUID.class), rs.getString("problem_slug"),
                rs.getString("problem_title"), rs.getString("language"), flatStatus(rs.getString("status"), verdict),
                verdict, rs.getInt("passed_tests"), rs.getInt("total_tests"), (Integer) rs.getObject("max_time_ms"),
                (Long) rs.getObject("max_memory_bytes"), rs.getTimestamp("created_at").toInstant());
    }
}

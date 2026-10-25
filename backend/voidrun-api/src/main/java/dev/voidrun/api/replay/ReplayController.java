package dev.voidrun.api.replay;

import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.api.judge.SourceRules;
import dev.voidrun.api.outbox.OutboxWriter;
import dev.voidrun.api.ratelimit.RateLimiter;
import dev.voidrun.api.security.CurrentUser;
import dev.voidrun.api.web.ApiException;
import dev.voidrun.api.web.CorrelationIdFilter;
import dev.voidrun.common.Language;
import dev.voidrun.common.Topics;
import dev.voidrun.common.events.ReplayJob;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
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
 * The editor's Debug button: record the caller's program once, then step
 * through the recording forwards and backwards.
 *
 * <p>Recording is slow (every source line is single-stepped under LLDB), so it
 * is queued on its own topic and recorded by a worker; the request returns at
 * once. Stepping never re-runs the program: each page of steps is rebuilt from
 * the stored keyframes and deltas.
 */
@RestController
@RequestMapping("/api/v1/replays")
public class ReplayController {

    static final long MAX_WAIT_MS = 10_000;
    static final int MAX_PAGE = 200;
    private static final long POLL_MS = 150;

    public record CreateReplayRequest(String problemId, String language, String sourceCode, String stdin) {}

    public record CreateReplayResponse(UUID replayId, String status) {}

    private final JdbcClient jdbc;
    private final OutboxWriter outbox;
    private final RateLimiter limiter;
    private final TransactionTemplate tx;
    private final VoidRunProperties props;
    private final ReplayStore store;

    public ReplayController(JdbcClient jdbc, OutboxWriter outbox, RateLimiter limiter, TransactionTemplate tx,
            VoidRunProperties props, ReplayStore store) {
        this.jdbc = jdbc;
        this.outbox = outbox;
        this.limiter = limiter;
        this.tx = tx;
        this.props = props;
        this.store = store;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    CreateReplayResponse create(@AuthenticationPrincipal Jwt jwt, @RequestBody CreateReplayRequest req) {
        UUID userId = CurrentUser.id(jwt);
        limiter.check("replay", userId.toString(), "too many debug sessions; please wait before starting another");

        Language language = SourceRules.language(req.language());
        if (language != Language.CPP17) {
            throw ApiException.badRequest("step-by-step replay is available for C++17 only");
        }
        SourceRules.source(req.sourceCode(), props.limits());
        String stdin = req.stdin() == null ? "" : req.stdin();
        if (stdin.getBytes(StandardCharsets.UTF_8).length > props.limits().maxInputBytes()) {
            throw ApiException.badRequest("stdin must be at most " + props.limits().maxInputBytes() + " bytes");
        }
        UUID problemId = req.problemId() == null || req.problemId().isBlank()
                ? null
                : SourceRules.runnableProblem(jdbc, req.problemId(), userId);

        String correlationId = CorrelationIdFilter.current();
        UUID replayId = tx.execute(status -> {
            UUID id = jdbc.sql("""
                            INSERT INTO replays (user_id, problem_id, language, source_code, stdin, expires_at,
                                                 correlation_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id""")
                    .params(userId, problemId, language.id(), req.sourceCode(), stdin,
                            Timestamp.from(Instant.now().plus(props.replay().retention())), correlationId)
                    .query(UUID.class)
                    .single();
            outbox.append(Topics.REPLAYS, id.toString(), "replay.requested", id, ReplayJob.of(id, correlationId),
                    correlationId);
            return id;
        });
        return new CreateReplayResponse(replayId, "QUEUED");
    }

    /** The replay and, once recorded, its outline; held open until it finishes or {@code wait_ms} passes. */
    @GetMapping("/{id}")
    ReplayStore.Replay get(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
            @RequestParam(name = "wait_ms", required = false) Long waitMs) throws InterruptedException {
        UUID userId = CurrentUser.id(jwt);
        long deadline = System.currentTimeMillis() + Math.max(0, Math.min(waitMs == null ? 0 : waitMs, MAX_WAIT_MS));
        while (true) {
            ReplayStore.Row row = store.row(id, userId).orElseThrow(() -> ApiException.notFound("replay not found"));
            if (row.finished() || System.currentTimeMillis() >= deadline) {
                return store.describe(row);
            }
            Thread.sleep(POLL_MS);
        }
    }

    /** Steps {@code from .. from + count - 1}, each with its call stack, variables and output so far. */
    @GetMapping("/{id}/steps")
    ReplayStore.StepPage steps(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id,
            @RequestParam(defaultValue = "0") int from, @RequestParam(defaultValue = "50") int count) {
        if (from < 0) {
            throw ApiException.badRequest("from must not be negative");
        }
        if (count < 1 || count > MAX_PAGE) {
            throw ApiException.badRequest("count must be between 1 and " + MAX_PAGE);
        }
        ReplayStore.Row row = store.row(id, CurrentUser.id(jwt))
                .orElseThrow(() -> ApiException.notFound("replay not found"));
        if (!row.finished()) {
            throw ApiException.conflict("REPLAY_NOT_READY", "the replay is still being recorded");
        }
        return store.steps(row, from, count);
    }
}

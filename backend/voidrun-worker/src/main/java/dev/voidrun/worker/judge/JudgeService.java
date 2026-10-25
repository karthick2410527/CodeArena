package dev.voidrun.worker.judge;

import dev.voidrun.common.Language;
import dev.voidrun.common.Topics;
import dev.voidrun.common.Verdict;
import dev.voidrun.common.events.VerdictEvent;
import dev.voidrun.worker.WorkerProperties;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Judges runs and submissions.
 *
 * <p>Every job is claimed with {@code UPDATE ... WHERE status <> 'FINISHED'}
 * and finished the same way, in one transaction with its per-test rows, so a
 * redelivered or duplicated Kafka message can never produce a second verdict:
 * a finished job is acknowledged without being judged again, and of two
 * workers racing on the same job only the first result is kept.
 */
@Service
public class JudgeService {

    private static final Logger log = LoggerFactory.getLogger(JudgeService.class);

    /** The job can never be judged (unknown language); straight to the dead-letter topic. */
    public static final class UnjudgeableException extends RuntimeException {
        public UnjudgeableException(String message) {
            super(message);
        }
    }

    private record Claimed(UUID problemId, Language language, String source, String mode, String stdin,
            UUID contestId, UUID userId) {}

    private record Limits(int timeLimitMs, int memoryLimitMb) {}

    private record TestCase(UUID id, int position, String label, String input, String expected, boolean sample,
            int points) {}

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final Sandbox sandbox;
    private final String workerId;
    private final int keptOutputChars;

    public JudgeService(JdbcClient jdbc, TransactionTemplate tx, Sandbox sandbox, WorkerProperties props) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.sandbox = sandbox;
        this.workerId = props.id();
        this.keptOutputChars = props.judge().keptOutputBytes();
    }

    // ---- runs ------------------------------------------------------------------

    /** Returns false when there was nothing to do: the run is gone, expired or already finished. */
    public boolean judgeRun(UUID runId) throws IOException, InterruptedException {
        Optional<Claimed> claimed = jdbc.sql("""
                        UPDATE runs
                        SET status = 'RUNNING', attempts = attempts + 1, claimed_by = ?, claimed_at = now()
                        WHERE id = ? AND status <> 'FINISHED' AND expires_at > now()
                        RETURNING problem_id, language, source_code, mode, stdin""")
                .params(workerId, runId)
                .query((rs, i) -> new Claimed(rs.getObject("problem_id", UUID.class), language(rs.getString("language")),
                        rs.getString("source_code"), rs.getString("mode"), rs.getString("stdin"), null, null))
                .optional();
        if (claimed.isEmpty()) {
            log.info("run {} is already finished or no longer exists; nothing to judge", runId);
            return false;
        }
        Claimed job = claimed.get();
        Limits limits = limits(job.problemId());
        List<TestCase> cases = job.mode().equals("CUSTOM")
                ? List.of(new TestCase(null, 1, "Custom input", job.stdin(), null, false, 0))
                : samples(job.problemId());

        long started = System.nanoTime();
        try (Sandbox.Session session = sandbox.open(job.language(), job.source(), limits.memoryLimitMb())) {
            Sandbox.Compilation compiled = session.compile();
            if (!compiled.ok()) {
                return finishRun(runId, "COMPILATION_ERROR", compiled, List.of(), started);
            }
            List<Object[]> rows = new ArrayList<>();
            ExecStatus worst = ExecStatus.OK;
            for (TestCase c : cases) {
                Sandbox.Execution e = session.execute(c.input(), limits.timeLimitMs(), limits.memoryLimitMb());
                Boolean passed = c.expected() == null
                        ? null
                        : e.status() == ExecStatus.OK && OutputCompare.matches(e.stdout(), c.expected());
                if (e.status() != ExecStatus.OK && worst == ExecStatus.OK) {
                    worst = e.status();
                }
                rows.add(new Object[] {runId, c.position(), c.label(), c.input(), c.expected(), cap(e.stdout()),
                        cap(e.stderr()), e.stdoutTruncated(), e.stderrTruncated(), e.status().name(), passed,
                        e.timeMs(), e.memoryBytes(), e.exitCode(), e.signal()});
            }
            return finishRun(runId, runOutcome(worst), compiled, rows, started);
        }
    }

    private boolean finishRun(UUID runId, String outcome, Sandbox.Compilation compiled, List<Object[]> cases,
            long started) {
        Boolean stored = tx.execute(status -> {
            int n = jdbc.sql("""
                            UPDATE runs
                            SET status = 'FINISHED', outcome = ?, compile_output = ?, compile_time_ms = ?,
                                finished_at = now()
                            WHERE id = ? AND status <> 'FINISHED'""")
                    .params(outcome, cap(compiled.output()), compiled.cached() ? null : compiled.timeMs(), runId)
                    .update();
            if (n == 0) {
                return false;
            }
            for (Object[] row : cases) {
                jdbc.sql("""
                                INSERT INTO run_cases (run_id, position, label, input, expected_output, stdout, stderr,
                                                       stdout_truncated, stderr_truncated, exec_status, passed, time_ms,
                                                       memory_bytes, exit_code, signal)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT (run_id, position) DO NOTHING""")
                        .params(row)
                        .update();
            }
            return true;
        });
        log.info("run {} judged: {} ({} cases{}) in {} ms{}", runId, outcome, cases.size(),
                compiled.cached() ? ", cached build" : "", (System.nanoTime() - started) / 1_000_000,
                Boolean.TRUE.equals(stored) ? "" : " (already finished elsewhere; discarded)");
        return Boolean.TRUE.equals(stored);
    }

    static String runOutcome(ExecStatus worst) {
        return switch (worst) {
            case OK -> "OK";
            case NON_ZERO_EXIT, SIGNALLED -> "RUNTIME_ERROR";
            case TIME_LIMIT -> "TIME_LIMIT_EXCEEDED";
            case MEMORY_LIMIT -> "MEMORY_LIMIT_EXCEEDED";
            case OUTPUT_LIMIT -> "OUTPUT_LIMIT_EXCEEDED";
        };
    }

    // ---- submissions -----------------------------------------------------------

    public boolean judgeSubmission(UUID submissionId) throws IOException, InterruptedException {
        Optional<Claimed> claimed = jdbc.sql("""
                        UPDATE submissions
                        SET status = 'RUNNING', attempts = attempts + 1, claimed_by = ?, claimed_at = now()
                        WHERE id = ? AND status <> 'FINISHED'
                        RETURNING problem_id, language, source_code, contest_id, user_id""")
                .params(workerId, submissionId)
                .query((rs, i) -> new Claimed(rs.getObject("problem_id", UUID.class), language(rs.getString("language")),
                        rs.getString("source_code"), null, null, rs.getObject("contest_id", UUID.class),
                        rs.getObject("user_id", UUID.class)))
                .optional();
        if (claimed.isEmpty()) {
            log.info("submission {} is already finished or no longer exists; nothing to judge", submissionId);
            return false;
        }
        Claimed job = claimed.get();
        Limits limits = limits(job.problemId());
        List<TestCase> tests = jdbc.sql("""
                        SELECT id, position, input, expected_output, is_sample, points FROM test_cases
                        WHERE problem_id = ? ORDER BY position, id""")
                .param(job.problemId())
                .query((rs, i) -> new TestCase(rs.getObject("id", UUID.class), rs.getInt("position"), null,
                        rs.getString("input"), rs.getString("expected_output"), rs.getBoolean("is_sample"),
                        rs.getInt("points")))
                .list();
        if (tests.isEmpty()) {
            throw new UnjudgeableException("problem " + job.problemId() + " has no test cases");
        }
        int maxScore = tests.stream().mapToInt(TestCase::points).sum();

        long started = System.nanoTime();
        try (Sandbox.Session session = sandbox.open(job.language(), job.source(), limits.memoryLimitMb())) {
            Sandbox.Compilation compiled = session.compile();
            if (!compiled.ok()) {
                return finishSubmission(submissionId, new Report(Verdict.COMPILATION_ERROR, compiled.output(), null,
                        0, tests.size(), 0, maxScore, null, null, List.of()), started);
            }
            List<Object[]> results = new ArrayList<>();
            Verdict verdict = Verdict.ACCEPTED;
            Integer failedAt = null;
            int passed = 0;
            int score = 0;
            Integer maxTime = null;
            Long maxMemory = null;
            for (TestCase t : tests) {
                Sandbox.Execution e = session.execute(t.input(), limits.timeLimitMs(), limits.memoryLimitMb());
                Verdict v = testVerdict(e, t.expected());
                maxTime = maxTime == null ? e.timeMs() : Math.max(maxTime, e.timeMs());
                if (e.memoryBytes() != null) {
                    maxMemory = maxMemory == null ? e.memoryBytes() : Math.max(maxMemory, e.memoryBytes());
                }
                int points = v == Verdict.ACCEPTED ? t.points() : 0;
                results.add(new Object[] {submissionId, t.id(), t.position(), t.sample(), v.name(), e.status().name(),
                        e.timeMs(), e.memoryBytes(), points, e.exitCode(), e.signal()});
                if (v != Verdict.ACCEPTED) {
                    // The first failing test decides the verdict; the rest would only cost time.
                    verdict = v;
                    failedAt = t.position();
                    break;
                }
                passed++;
                score += points;
            }
            return finishSubmission(submissionId, new Report(verdict, compiled.output(), failedAt, passed,
                    tests.size(), score, maxScore, maxTime, maxMemory, results), started);
        }
    }

    private record Report(Verdict verdict, String compileOutput, Integer failedAt, int passed, int total, int score,
            int maxScore, Integer maxTimeMs, Long maxMemoryBytes, List<Object[]> results) {}

    private boolean finishSubmission(UUID id, Report r, long started) {
        Boolean stored = tx.execute(status -> {
            int n = jdbc.sql("""
                            UPDATE submissions
                            SET status = 'FINISHED', verdict = ?, compile_output = ?, failed_case_position = ?,
                                passed_tests = ?, total_tests = ?, score = ?, max_score = ?, max_time_ms = ?,
                                max_memory_bytes = ?, finished_at = now()
                            WHERE id = ? AND status <> 'FINISHED'""")
                    .params(r.verdict().name(), cap(r.compileOutput()), r.failedAt(), r.passed(), r.total(), r.score(),
                            r.maxScore(), r.maxTimeMs(), r.maxMemoryBytes(), id)
                    .update();
            if (n == 0) {
                return false;
            }
            for (Object[] row : r.results()) {
                jdbc.sql("""
                                INSERT INTO submission_results (submission_id, test_case_id, position, is_sample,
                                                                verdict, exec_status, execution_time_ms, memory_bytes,
                                                                points_awarded, exit_code, signal)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT (submission_id, test_case_id) DO NOTHING""")
                        .params(row)
                        .update();
            }
            announce(id);
            return true;
        });
        log.info("submission {} judged: {} ({}/{} tests) in {} ms{}", id, r.verdict(), r.passed(), r.total(),
                (System.nanoTime() - started) / 1_000_000,
                Boolean.TRUE.equals(stored) ? "" : " (already finished elsewhere; discarded)");
        return Boolean.TRUE.equals(stored);
    }

    static Verdict testVerdict(Sandbox.Execution e, String expected) {
        return switch (e.status()) {
            case OK -> OutputCompare.matches(e.stdout(), expected) ? Verdict.ACCEPTED : Verdict.WRONG_ANSWER;
            case NON_ZERO_EXIT, SIGNALLED, OUTPUT_LIMIT -> Verdict.RUNTIME_ERROR;
            case TIME_LIMIT -> Verdict.TIME_LIMIT_EXCEEDED;
            case MEMORY_LIMIT -> Verdict.MEMORY_LIMIT_EXCEEDED;
        };
    }

    // ---- giving up ---------------------------------------------------------------

    /**
     * Ends a job whose retries ran out: the user gets INTERNAL_ERROR (the API
     * shows a "please try again" message) instead of waiting forever, and the
     * reason goes to {@code internal_error} and {@code dead_letter_events} for
     * an operator.
     */
    public void giveUp(String kind, UUID id, String reason, String payload, boolean payloadIsJson,
            String correlationId) {
        String why = reason == null ? "retries exhausted" : reason.length() > 2000 ? reason.substring(0, 2000) : reason;
        tx.executeWithoutResult(status -> {
            boolean submission = kind.equals("SUBMISSION");
            if (id != null) {
                jdbc.sql(submission
                                ? """
                                  UPDATE submissions SET status = 'FINISHED', verdict = 'INTERNAL_ERROR',
                                         internal_error = ?, finished_at = now()
                                  WHERE id = ? AND status <> 'FINISHED'"""
                                : """
                                  UPDATE runs SET status = 'FINISHED', outcome = 'INTERNAL_ERROR',
                                         internal_error = ?, finished_at = now()
                                  WHERE id = ? AND status <> 'FINISHED'""")
                        .params(why, id)
                        .update();
            }
            if (submission && id != null) {
                announce(id);
            }
            boolean linked = submission && id != null
                    && jdbc.sql("SELECT count(*) FROM submissions WHERE id = ?").param(id).query(Long.class).single() > 0;
            jdbc.sql("INSERT INTO dead_letter_events (submission_id, event_type, payload, reason, correlation_id) "
                            + "VALUES (?, ?, " + (payloadIsJson ? "?::jsonb" : "to_jsonb(?::text)") + ", ?, ?)")
                    .params(linked ? id : null, submission ? "submission.created" : "run.created", payload, why,
                            correlationId)
                    .update();
        });
        log.warn("{} {} dead-lettered: {}", kind.toLowerCase(), id, why);
    }

    /**
     * For a contest submission, queues a {@code voidrun.verdicts} event in the
     * outbox, inside the transaction that wrote the verdict: the live standings
     * hear about exactly the verdicts that were committed. The API's relay
     * delivers it, keyed by contest so each contest's events stay in order.
     */
    private void announce(UUID submissionId) {
        jdbc.sql("""
                        INSERT INTO outbox_events (topic, message_key, event_type, aggregate_id, payload)
                        SELECT ?, s.contest_id::text, 'verdict.decided', s.id,
                               jsonb_build_object('version', ?, 'contestId', s.contest_id, 'submissionId', s.id,
                                                  'userId', s.user_id, 'verdict', s.verdict)
                        FROM submissions s WHERE s.id = ? AND s.contest_id IS NOT NULL""")
                .params(Topics.VERDICTS, VerdictEvent.CURRENT_VERSION, submissionId)
                .update();
    }

    // ---- helpers -------------------------------------------------------------------

    private static Language language(String id) {
        return Language.find(id).orElseThrow(() -> new UnjudgeableException("unknown language " + id));
    }

    private Limits limits(UUID problemId) {
        return jdbc.sql("SELECT time_limit_ms, memory_limit_mb FROM problems WHERE id = ?")
                .param(problemId)
                .query((rs, i) -> new Limits(rs.getInt("time_limit_ms"), rs.getInt("memory_limit_mb")))
                .single();
    }

    private List<TestCase> samples(UUID problemId) {
        List<TestCase> raw = jdbc.sql("""
                        SELECT id, input, expected_output FROM test_cases
                        WHERE problem_id = ? AND is_sample ORDER BY position, id""")
                .param(problemId)
                .query((rs, i) -> new TestCase(rs.getObject("id", UUID.class), i + 1, "Sample " + (i + 1),
                        rs.getString("input"), rs.getString("expected_output"), true, 0))
                .list();
        return raw;
    }

    private String cap(String s) {
        if (s == null) {
            return "";
        }
        return s.length() <= keptOutputChars ? s : s.substring(0, keptOutputChars);
    }
}

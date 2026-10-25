package dev.voidrun.worker;

import dev.voidrun.common.Language;
import dev.voidrun.recorder.Recording;
import dev.voidrun.recorder.RecordingCodec;
import dev.voidrun.recorder.Termination;
import java.io.IOException;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Records a requested replay and stores it.
 *
 * <p>Safe to run more than once for the same replay, which Kafka's
 * at-least-once delivery requires: a replay that is already FINISHED is not
 * claimed again, and the result is written with
 * {@code WHERE status <> 'FINISHED'}, so of two concurrent recordings of the
 * same replay only the first to finish is kept.
 */
@Service
public class ReplayService {

    private static final Logger log = LoggerFactory.getLogger(ReplayService.class);

    /** Thrown for a job that can never succeed, so it goes straight to the dead-letter topic. */
    public static final class UnrecordableException extends RuntimeException {
        public UnrecordableException(String message) {
            super(message);
        }
    }

    /** The recorder itself failed (the sandbox did not start, the tracer died); worth retrying. */
    public static final class RecorderFailedException extends RuntimeException {
        public RecorderFailedException(String message) {
            super(message);
        }
    }

    private record Claimed(String language, String sourceCode, String stdin) {}

    private final JdbcClient jdbc;
    private final ReplayRecorder recorder;
    private final String workerId;

    public ReplayService(JdbcClient jdbc, ReplayRecorder recorder, WorkerProperties props) {
        this.jdbc = jdbc;
        this.recorder = recorder;
        this.workerId = props.id();
    }

    /** Returns false when there was nothing to do: the replay is gone or already recorded. */
    public boolean record(UUID replayId) throws IOException, InterruptedException {
        Optional<Claimed> claimed = claim(replayId);
        if (claimed.isEmpty()) {
            log.info("replay {} is already finished or no longer exists; nothing to record", replayId);
            return false;
        }
        Claimed job = claimed.get();
        if (Language.find(job.language()).orElse(null) != Language.CPP17) {
            throw new UnrecordableException("replay " + replayId + " is in " + job.language() + ", not C++17");
        }
        long started = System.nanoTime();
        Recording rec = recorder.record(job.sourceCode(), job.stdin());
        if (rec.termination().kind() == Termination.Kind.RECORDER_ERROR) {
            throw new RecorderFailedException(rec.termination().detail());
        }
        boolean stored = finish(replayId, rec);
        log.info("replay {} recorded: {} steps, {} in {} ms{}", replayId, rec.stepCount(), rec.termination().kind(),
                (System.nanoTime() - started) / 1_000_000, stored ? "" : " (already finished elsewhere; discarded)");
        return stored;
    }

    /**
     * Ends a replay that could not be recorded, after its retries ran out:
     * the user sees a failure instead of waiting forever, and an operator
     * finds the job and the reason in {@code dead_letter_events}.
     */
    @Transactional
    public void giveUp(UUID replayId, String reason, String payload, boolean payloadIsJson, String correlationId) {
        int finished = replayId == null ? 0 : jdbc.sql("""
                        UPDATE replays
                        SET status = 'FINISHED', termination = 'RECORDER_ERROR', detail = ?, finished_at = now()
                        WHERE id = ? AND status <> 'FINISHED'""")
                .params(truncate(reason), replayId)
                .update();
        boolean exists = replayId != null && jdbc.sql("SELECT count(*) FROM replays WHERE id = ?")
                .param(replayId).query(Long.class).single() > 0;
        jdbc.sql("INSERT INTO dead_letter_events (replay_id, event_type, payload, reason, correlation_id) VALUES (?, "
                        + "'replay.requested', " + (payloadIsJson ? "?::jsonb" : "to_jsonb(?::text)") + ", ?, ?)")
                .params(exists ? replayId : null, payload, truncate(reason), correlationId)
                .update();
        log.warn("replay {} dead-lettered{}: {}", replayId, finished == 0 ? " (it had already finished)" : "",
                reason);
    }

    private Optional<Claimed> claim(UUID replayId) {
        // A RECORDING row is claimable too: it belonged to a worker that died
        // before acknowledging, which is why the job was redelivered.
        return jdbc.sql("""
                        UPDATE replays
                        SET status = 'RECORDING', attempts = attempts + 1, claimed_by = ?, claimed_at = now()
                        WHERE id = ? AND status <> 'FINISHED' AND expires_at > now()
                        RETURNING language, source_code, stdin""")
                .params(workerId, replayId)
                .query((rs, i) -> new Claimed(rs.getString("language"), rs.getString("source_code"),
                        rs.getString("stdin")))
                .optional();
    }

    private boolean finish(UUID replayId, Recording rec) {
        Termination t = rec.termination();
        return jdbc.sql("""
                        UPDATE replays
                        SET status = 'FINISHED', termination = ?, exit_code = ?, detail = ?, step_count = ?,
                            recording = ?, finished_at = now()
                        WHERE id = ? AND status <> 'FINISHED'""")
                .params(t.kind().name(), t.kind() == Termination.Kind.EXITED ? t.code() : null, truncate(t.detail()),
                        rec.stepCount(), RecordingCodec.encode(rec), replayId)
                .update() == 1;
    }

    private static String truncate(String s) {
        if (s == null) {
            return "";
        }
        return s.length() <= 2000 ? s : s.substring(0, 2000);
    }
}

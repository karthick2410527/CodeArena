package dev.voidrun.common.events;

import java.util.UUID;

/**
 * A request to record an execution for replay, on {@code voidrun.replays}.
 * Like {@link JudgeJob} it carries only the id: the worker reads the source
 * and input from PostgreSQL.
 *
 * @param version       payload schema version, bumped on incompatible change
 * @param replayId      the replay row to fill in
 * @param correlationId request id that created the job, for tracing across processes
 */
public record ReplayJob(int version, UUID replayId, String correlationId) {

    public static final int CURRENT_VERSION = 1;

    public static ReplayJob of(UUID replayId, String correlationId) {
        return new ReplayJob(CURRENT_VERSION, replayId, correlationId);
    }
}

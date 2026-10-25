package dev.voidrun.common.events;

import java.util.UUID;

/**
 * A unit of judge work on Kafka. It carries only identifiers: the worker reads
 * the source and tests from PostgreSQL, so a redelivered or replayed message
 * can never judge stale data, and the message stays small.
 *
 * @param version       payload schema version, bumped on incompatible change
 * @param kind          what {@code id} refers to
 * @param id            the run or submission id
 * @param correlationId request id that created the job, for tracing across processes
 */
public record JudgeJob(int version, Kind kind, UUID id, String correlationId) {

    public static final int CURRENT_VERSION = 1;

    public enum Kind {
        RUN,
        SUBMISSION
    }

    public static JudgeJob run(UUID id, String correlationId) {
        return new JudgeJob(CURRENT_VERSION, Kind.RUN, id, correlationId);
    }

    public static JudgeJob submission(UUID id, String correlationId) {
        return new JudgeJob(CURRENT_VERSION, Kind.SUBMISSION, id, correlationId);
    }
}

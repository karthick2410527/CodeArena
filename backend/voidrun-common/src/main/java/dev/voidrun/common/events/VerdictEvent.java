package dev.voidrun.common.events;

import java.util.UUID;

/**
 * A contest submission has been judged, on {@code voidrun.verdicts}. Written
 * by the worker in the same transaction as the verdict, so a live board can
 * neither miss a verdict nor see one that was rolled back.
 */
public record VerdictEvent(int version, UUID contestId, UUID submissionId, UUID userId, String verdict) {

    public static final int CURRENT_VERSION = 1;

    public static VerdictEvent of(UUID contestId, UUID submissionId, UUID userId, String verdict) {
        return new VerdictEvent(CURRENT_VERSION, contestId, submissionId, userId, verdict);
    }
}

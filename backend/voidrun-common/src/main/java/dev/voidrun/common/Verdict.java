package dev.voidrun.common;

/** The outcome of judging a submission. Stored by name; never rename a constant. */
public enum Verdict {
    ACCEPTED,
    WRONG_ANSWER,
    COMPILATION_ERROR,
    RUNTIME_ERROR,
    TIME_LIMIT_EXCEEDED,
    MEMORY_LIMIT_EXCEEDED,
    INTERNAL_ERROR;

    /**
     * Whether this verdict counts as a failed attempt for contest penalties.
     * A compile error or a judge failure is not the contestant's wrong answer.
     */
    public boolean isPenalised() {
        return this != ACCEPTED && this != COMPILATION_ERROR && this != INTERNAL_ERROR;
    }
}

package dev.voidrun.worker.judge;

/** What one execution did. Stored by name in {@code run_cases} and {@code submission_results}. */
public enum ExecStatus {
    OK,
    NON_ZERO_EXIT,
    SIGNALLED,
    TIME_LIMIT,
    MEMORY_LIMIT,
    OUTPUT_LIMIT
}

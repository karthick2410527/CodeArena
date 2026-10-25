package dev.voidrun.common;

/**
 * Kafka topic names. Each kind of work has its own topic and consumer group,
 * so a burst of one kind (a practice rush, a contest start) never queues
 * behind another.
 */
public final class Topics {

    /** Interactive "Run" against samples or custom input. Latency matters most. */
    public static final String RUNS = "voidrun.runs";
    /** Practice submissions against hidden tests. */
    public static final String SUBMISSIONS = "voidrun.submissions";
    /** Submissions made during a live contest. Highest priority, own worker pool. */
    public static final String CONTEST_SUBMISSIONS = "voidrun.contest-submissions";
    /** Execution recordings for replay. Slow, so isolated from judging. */
    public static final String REPLAYS = "voidrun.replays";
    /**
     * A contest submission's verdict, published by the worker (through the
     * outbox) when it finishes one; keyed by contest id, so each contest's
     * verdicts stay in order. API instances fan them out to live standings.
     */
    public static final String VERDICTS = "voidrun.verdicts";

    private Topics() {}
}

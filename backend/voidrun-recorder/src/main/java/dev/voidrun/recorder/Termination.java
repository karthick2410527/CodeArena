package dev.voidrun.recorder;

/** How a recording ended. {@code code} is the exit status for {@link Kind#EXITED}, else 0. */
public record Termination(Kind kind, int code, String detail) {

    public enum Kind {
        /** The program ran to completion inside the step budget. */
        EXITED,
        /** The program stopped on a signal or hardware exception; the last step is the crash site. */
        CRASHED,
        /** The step budget ran out; the recording is a valid prefix of the execution. */
        STEP_LIMIT,
        /** The wall-clock budget ran out; the recording is a valid prefix of the execution. */
        TIME_LIMIT,
        /** The source did not compile; there are no steps. */
        COMPILE_ERROR,
        /** The recorder itself failed. */
        RECORDER_ERROR;

        static Kind fromProtocol(String kind) {
            return switch (kind) {
                case "exited" -> EXITED;
                case "crashed" -> CRASHED;
                case "step_limit" -> STEP_LIMIT;
                case "time_limit" -> TIME_LIMIT;
                default -> RECORDER_ERROR;
            };
        }
    }

    public Termination {
        detail = detail == null ? "" : detail;
    }

    public static Termination of(Kind kind, String detail) {
        return new Termination(kind, 0, detail);
    }
}

package dev.voidrun.worker.judge;

import dev.voidrun.common.Language;
import java.io.IOException;

/**
 * Where untrusted code is compiled and run. One {@link Session} per job: it is
 * compiled once and then executed once per test.
 *
 * <p>An {@link IOException} means the sandbox itself failed (Docker is down,
 * the image is missing) and the job is worth retrying; anything the program
 * did wrong is a normal result, never an exception.
 */
public interface Sandbox {

    Session open(Language language, String source, int memoryLimitMb) throws IOException, InterruptedException;

    interface Session extends AutoCloseable {

        Compilation compile() throws IOException, InterruptedException;

        Execution execute(String stdin, int timeLimitMs, int memoryLimitMb) throws IOException, InterruptedException;

        @Override
        void close();
    }

    /**
     * @param ok     whether there is something to run
     * @param output compiler diagnostics: the errors when not ok, warnings otherwise
     * @param cached whether a compiled program from an earlier identical source was reused
     */
    record Compilation(boolean ok, String output, int timeMs, boolean cached) {}

    /**
     * @param stdout       what the program printed, in full up to the output limit (for comparison)
     * @param memoryBytes  peak resident memory, when measured
     */
    record Execution(ExecStatus status, String stdout, String stderr, boolean stdoutTruncated,
            boolean stderrTruncated, int timeMs, Long memoryBytes, Integer exitCode, Integer signal) {}
}

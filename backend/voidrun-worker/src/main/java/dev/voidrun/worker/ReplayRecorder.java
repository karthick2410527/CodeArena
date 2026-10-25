package dev.voidrun.worker;

import dev.voidrun.recorder.Recording;
import java.io.IOException;

/** Records one execution. The production one is the sandboxed {@code Recorder}; tests substitute their own. */
@FunctionalInterface
public interface ReplayRecorder {

    Recording record(String source, String stdin) throws IOException, InterruptedException;
}

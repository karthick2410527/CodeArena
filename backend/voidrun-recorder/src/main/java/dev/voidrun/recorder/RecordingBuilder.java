package dev.voidrun.recorder;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Encodes a stream of full per-step states into a {@link Recording}. Only the
 * previous state is held, so memory is one state plus the encoded output no
 * matter how long the stream is.
 */
public final class RecordingBuilder {

    private final int keyframeInterval;
    private final List<Map<String, String>> keyframes = new ArrayList<>();
    private final List<Delta> deltas = new ArrayList<>();
    private Map<String, String> previous = Map.of();

    public RecordingBuilder(int keyframeInterval) {
        if (keyframeInterval < 1) {
            throw new IllegalArgumentException("keyframeInterval must be >= 1");
        }
        this.keyframeInterval = keyframeInterval;
    }

    public void add(Map<String, String> state) {
        Map<String, String> copy = new HashMap<>(state);
        if (deltas.size() % keyframeInterval == 0) {
            keyframes.add(Map.copyOf(copy));
        }
        deltas.add(Delta.between(previous, copy));
        previous = copy;
    }

    public int steps() {
        return deltas.size();
    }

    public Recording build(byte[] stdout, String compileOutput, Termination termination) {
        return new Recording(keyframeInterval, keyframes, deltas, stdout, compileOutput, termination);
    }
}

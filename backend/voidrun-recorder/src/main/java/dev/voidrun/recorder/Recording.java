package dev.voidrun.recorder;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * A recorded execution, stored as keyframes plus deltas.
 *
 * <p>{@code deltas.get(i)} turns the state at step {@code i - 1} into the state
 * at step {@code i} (step 0's delta starts from the empty state), so the
 * deltas alone describe the whole execution. {@code keyframes.get(k)} is the
 * full state at step {@code k * keyframeInterval}; they are redundant, and
 * exist so that any step can be rebuilt by applying at most
 * {@code keyframeInterval - 1} deltas to the nearest keyframe at or before
 * it, instead of replaying from the start.
 */
public record Recording(
        int keyframeInterval,
        List<Map<String, String>> keyframes,
        List<Delta> deltas,
        byte[] stdout,
        String compileOutput,
        Termination termination) {

    public Recording {
        if (keyframeInterval < 1) {
            throw new IllegalArgumentException("keyframeInterval must be >= 1");
        }
        int expected = deltas.isEmpty() ? 0 : (deltas.size() - 1) / keyframeInterval + 1;
        if (keyframes.size() != expected) {
            throw new IllegalArgumentException(
                    "expected " + expected + " keyframes for " + deltas.size() + " steps, got " + keyframes.size());
        }
        keyframes = keyframes.stream().map(Map::copyOf).toList();
        deltas = List.copyOf(deltas);
        stdout = stdout.clone();
        compileOutput = compileOutput == null ? "" : compileOutput;
    }

    public static Recording withoutSteps(byte[] stdout, String compileOutput, Termination termination) {
        return new Recording(1, List.of(), List.of(), stdout, compileOutput, termination);
    }

    public int stepCount() {
        return deltas.size();
    }

    @Override
    public byte[] stdout() {
        return stdout.clone();
    }

    /** The first {@code bytes} bytes of the program's output, decoded as UTF-8. */
    public String stdoutPrefix(long bytes) {
        int n = (int) Math.max(0, Math.min(bytes, stdout.length));
        return new String(stdout, 0, n, StandardCharsets.UTF_8);
    }

    /** Total entries stored, keyframes included: what the recording costs to keep. */
    public long storedEntries() {
        long n = 0;
        for (Map<String, String> k : keyframes) {
            n += k.size();
        }
        for (Delta d : deltas) {
            n += d.size();
        }
        return n;
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof Recording r
                && keyframeInterval == r.keyframeInterval
                && keyframes.equals(r.keyframes)
                && deltas.equals(r.deltas)
                && Arrays.equals(stdout, r.stdout)
                && compileOutput.equals(r.compileOutput)
                && termination.equals(r.termination);
    }

    @Override
    public int hashCode() {
        return 31 * deltas.hashCode() + Arrays.hashCode(stdout);
    }

    @Override
    public String toString() {
        return "Recording[steps=" + stepCount() + ", keyframes=" + keyframes.size() + ", termination=" + termination + "]";
    }
}

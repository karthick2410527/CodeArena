package dev.voidrun.recorder;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * A position in a {@link Recording} that can move forward, backward or jump.
 *
 * <p>Moving forward applies the next delta. Moving backward, or jumping more
 * than one keyframe interval ahead, reloads the nearest keyframe at or before
 * the target and applies at most {@code keyframeInterval - 1} deltas, so every
 * move costs O(interval) regardless of how long the recording is.
 */
public final class ReplayCursor {

    private final Recording recording;
    private final Map<String, String> state = new HashMap<>();
    private int step = -1;

    public ReplayCursor(Recording recording) {
        this.recording = recording;
        if (recording.stepCount() > 0) {
            seek(0);
        }
    }

    public Recording recording() {
        return recording;
    }

    /** Current step, or -1 for a recording with no steps. */
    public int step() {
        return step;
    }

    public Map<String, String> state() {
        return Collections.unmodifiableMap(state);
    }

    public StepView view() {
        return StepView.of(step, state, recording);
    }

    public boolean hasNext() {
        return step + 1 < recording.stepCount();
    }

    public boolean hasPrevious() {
        return step > 0;
    }

    public boolean forward() {
        if (!hasNext()) {
            return false;
        }
        recording.deltas().get(++step).applyTo(state);
        return true;
    }

    public boolean back() {
        if (!hasPrevious()) {
            return false;
        }
        seek(step - 1);
        return true;
    }

    /** Moves to {@code target}, clamped to the recording. */
    public void seek(int target) {
        int n = recording.stepCount();
        if (n == 0) {
            return;
        }
        target = Math.max(0, Math.min(target, n - 1));
        int interval = recording.keyframeInterval();
        int keyframeStep = (target / interval) * interval;
        if (target < step || step < keyframeStep) {
            state.clear();
            state.putAll(recording.keyframes().get(target / interval));
            step = keyframeStep;
        }
        while (step < target) {
            recording.deltas().get(++step).applyTo(state);
        }
    }

    /** The full state at {@code target}, without moving this cursor. */
    public static Map<String, String> stateAt(Recording recording, int target) {
        ReplayCursor c = new ReplayCursor(recording);
        c.seek(target);
        return Map.copyOf(c.state);
    }
}

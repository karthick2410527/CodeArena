package dev.voidrun.recorder;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.stream.IntStream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.Test;

class ReplayCursorTest {

    /** A random walk over a small key space: values change, keys appear and disappear. */
    static List<Map<String, String>> randomStates(long seed, int steps) {
        Random r = new Random(seed);
        List<Map<String, String>> states = new ArrayList<>();
        Map<String, String> s = new HashMap<>();
        for (int i = 0; i < steps; i++) {
            int changes = r.nextInt(4);
            for (int c = 0; c < changes; c++) {
                String key = "f" + r.nextInt(3) + ".v.x" + r.nextInt(6);
                if (r.nextInt(4) == 0) {
                    s.remove(key);
                } else {
                    s.put(key, Integer.toString(r.nextInt(10)));
                }
            }
            s.put("line", Integer.toString(1 + r.nextInt(30)));
            states.add(Map.copyOf(s));
        }
        return states;
    }

    static Recording encode(List<Map<String, String>> states, int interval) {
        RecordingBuilder b = new RecordingBuilder(interval);
        states.forEach(b::add);
        return b.build(new byte[0], "", Termination.of(Termination.Kind.EXITED, ""));
    }

    @ParameterizedTest
    @ValueSource(ints = {1, 2, 3, 7, 32, 1000})
    void everyAccessPathReconstructsTheRecordedState(int interval) {
        List<Map<String, String>> states = randomStates(interval, 250);
        Recording rec = encode(states, interval);
        assertEquals(states.size(), rec.stepCount());
        assertEquals((states.size() - 1) / interval + 1, rec.keyframes().size());

        ReplayCursor forward = new ReplayCursor(rec);
        for (int i = 0; i < states.size(); i++) {
            assertEquals(states.get(i), forward.state(), "forward walk at step " + i);
            assertEquals(i + 1 < states.size(), forward.forward());
        }

        ReplayCursor backward = new ReplayCursor(rec);
        backward.seek(states.size() - 1);
        for (int i = states.size() - 1; i >= 0; i--) {
            assertEquals(states.get(i), backward.state(), "backward step at " + i);
            assertEquals(i > 0, backward.back());
        }

        List<Integer> order = new ArrayList<>(IntStream.range(0, states.size()).boxed().toList());
        Collections.shuffle(order, new Random(42));
        ReplayCursor jumper = new ReplayCursor(rec);
        for (int target : order) {
            jumper.seek(target);
            assertEquals(target, jumper.step());
            assertEquals(states.get(target), jumper.state(), "seek to " + target);
        }
    }

    @Test
    void deltasStoreFarLessThanFullStatesWhenLittleChanges() {
        List<Map<String, String>> states = new ArrayList<>();
        Map<String, String> s = new HashMap<>();
        for (int k = 0; k < 200; k++) s.put("f0.v.a[" + k + "]", "0");
        for (int i = 0; i < 500; i++) {
            s.put("f0.v.a[" + (i % 200) + "]", Integer.toString(i));
            s.put("line", Integer.toString(i % 7));
            states.add(Map.copyOf(s));
        }
        Recording rec = encode(states, 50);
        long full = states.stream().mapToLong(Map::size).sum();
        assertTrue(rec.storedEntries() * 5 < full, rec.storedEntries() + " vs " + full);
    }

    @Test
    void seekClampsToTheRecording() {
        Recording rec = encode(randomStates(7, 10), 4);
        ReplayCursor c = new ReplayCursor(rec);
        c.seek(99);
        assertEquals(9, c.step());
        assertFalse(c.forward());
        c.seek(-5);
        assertEquals(0, c.step());
        assertFalse(c.back());
    }

    @Test
    void emptyRecordingHasNoPosition() {
        Recording rec = Recording.withoutSteps(new byte[0], "error", Termination.of(Termination.Kind.COMPILE_ERROR, ""));
        ReplayCursor c = new ReplayCursor(rec);
        assertEquals(-1, c.step());
        assertFalse(c.forward());
        assertFalse(c.back());
        c.seek(3);
        assertEquals(-1, c.step());
        assertTrue(c.state().isEmpty());
    }

    @Test
    void deltaRecordsOnlyWhatChanged() {
        Delta d = Delta.between(Map.of("a", "1", "b", "2", "c", "3"), Map.of("a", "1", "b", "9", "d", "4"));
        assertEquals(Map.of("b", "9", "d", "4"), d.set());
        assertEquals(List.of("c"), List.copyOf(d.removed()));
        Map<String, String> state = new HashMap<>(Map.of("a", "1", "b", "2", "c", "3"));
        d.applyTo(state);
        assertEquals(Map.of("a", "1", "b", "9", "d", "4"), state);
    }

    @Test
    void recordingRejectsInconsistentKeyframes() {
        assertThrows(IllegalArgumentException.class, () -> new Recording(2, List.of(), List.of(Delta.EMPTY),
                new byte[0], "", Termination.of(Termination.Kind.EXITED, "")));
    }
}

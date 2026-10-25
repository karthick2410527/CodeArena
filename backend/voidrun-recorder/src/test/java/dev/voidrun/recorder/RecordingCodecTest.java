package dev.voidrun.recorder;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RecordingCodecTest {

    private static Recording sample(int steps, int interval) {
        RecordingBuilder b = new RecordingBuilder(interval);
        ReplayCursorTest.randomStates(7, steps).forEach(b::add);
        return b.build("héllo\n".getBytes(StandardCharsets.UTF_8), "warning: unused\n",
                new Termination(Termination.Kind.EXITED, 3, "exited with status 3"));
    }

    @Test
    void roundTripsEveryField() {
        Recording r = sample(500, 16);
        Recording back = RecordingCodec.decode(RecordingCodec.encode(r));
        assertEquals(r, back);
        assertEquals(r.keyframeInterval(), back.keyframeInterval());
        assertArrayEquals(r.stdout(), back.stdout());
        assertEquals(r.termination(), back.termination());
        for (int step : new int[] {0, 1, 15, 16, 17, 250, 499}) {
            assertEquals(ReplayCursor.stateAt(r, step), ReplayCursor.stateAt(back, step), "step " + step);
        }
    }

    @Test
    void roundTripsARecordingWithoutSteps() {
        Recording r = Recording.withoutSteps(new byte[0], "main.cpp:1: error: expected ';'".repeat(5000),
                Termination.of(Termination.Kind.COMPILE_ERROR, "compilation failed"));
        assertEquals(r, RecordingCodec.decode(RecordingCodec.encode(r)));
    }

    @Test
    void repeatedKeysCompressWell() {
        Recording r = sample(2000, 32);
        long raw = 0;
        for (Map<String, String> k : r.keyframes()) {
            for (var e : k.entrySet()) raw += e.getKey().length() + e.getValue().length();
        }
        for (Delta d : r.deltas()) {
            for (var e : d.set().entrySet()) raw += e.getKey().length() + e.getValue().length();
            for (String k : d.removed()) raw += k.length();
        }
        int encoded = RecordingCodec.encode(r).length;
        assertTrue(encoded < raw / 2, "encoded " + encoded + " bytes for " + raw + " bytes of keys and values");
    }

    @Test
    void rejectsWhatItDidNotWrite() {
        assertThrows(IllegalArgumentException.class, () -> RecordingCodec.decode("not gzip".getBytes()));
        byte[] good = RecordingCodec.encode(sample(10, 4));
        assertThrows(IllegalArgumentException.class,
                () -> RecordingCodec.decode(Arrays.copyOf(good, good.length / 2)));
        assertThrows(IllegalArgumentException.class, () -> RecordingCodec.decode(gzip(new byte[] {0, 0, 0, 1})));
    }

    private static byte[] gzip(byte[] data) {
        try {
            var bytes = new java.io.ByteArrayOutputStream();
            try (var out = new java.util.zip.GZIPOutputStream(bytes)) {
                out.write(data);
            }
            return bytes.toByteArray();
        } catch (java.io.IOException e) {
            throw new AssertionError(e);
        }
    }

    @Test
    void deltasSurviveIntact() {
        Recording r = sample(64, 8);
        List<Delta> back = RecordingCodec.decode(RecordingCodec.encode(r)).deltas();
        assertEquals(r.deltas(), back);
    }
}

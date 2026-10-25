package dev.voidrun.recorder;

import static java.util.Map.entry;
import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class StepViewTest {

    @Test
    void decodesFramesVariablesAndOutputPrefix() {
        RecordingBuilder b = new RecordingBuilder(4);
        b.add(Map.ofEntries(
                entry("line", "3"), entry("depth", "2"), entry("out", "3"),
                entry("f0.fn", "main"), entry("f0.line", "7"), entry("f0.v.v[10]", "a"), entry("f0.v.v[2]", "b"),
                entry("f0.t.v", "std::vector<int>"),
                entry("f1.fn", "sq(int)"), entry("f1.line", "3"), entry("f1.v.x", "4")));
        Recording rec = b.build("12\n34".getBytes(StandardCharsets.UTF_8), "", Termination.of(Termination.Kind.EXITED, ""));

        StepView v = new ReplayCursor(rec).view();
        assertEquals(0, v.step());
        assertEquals(3, v.line());
        assertEquals(2, v.depth());
        assertEquals("12\n", v.stdout());
        assertEquals(2, v.frames().size());

        StepView.Frame main = v.frames().get(0);
        assertEquals(0, main.index());
        assertEquals("main", main.function());
        assertEquals(7, main.line());
        assertEquals(Map.of("v", "std::vector<int>"), main.types());
        assertEquals(List.of("v[2]", "v[10]"),
                StepView.sortedVariables(main).stream().map(Map.Entry::getKey).toList());
        assertEquals("sq(int)", v.frames().get(1).function());
    }

    @Test
    void naturalOrderComparesDigitRunsAsNumbers() {
        List<String> keys = new java.util.ArrayList<>(List.of("a[10]", "a[9]", "a[0]", "b", "a[100]", "a"));
        keys.sort(StepView.NATURAL);
        assertEquals(List.of("a", "a[0]", "a[9]", "a[10]", "a[100]", "b"), keys);
    }
}

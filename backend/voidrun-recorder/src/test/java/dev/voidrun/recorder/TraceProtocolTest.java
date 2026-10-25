package dev.voidrun.recorder;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class TraceProtocolTest {

    private static Termination read(String trace, List<Map<String, String>> into) throws IOException {
        return TraceProtocol.read(new BufferedReader(new StringReader(trace)), into::add);
    }

    @Test
    void readsStepsAndTermination() throws IOException {
        List<Map<String, String>> steps = new ArrayList<>();
        Termination end = read("""
                STEP
                K\tline\t5
                K\tf0.v.s\t"a\\tb\\nc\\\\d"
                STEP
                K\tline\t6
                END\texited\t3\tbye\\n
                """, steps);
        assertEquals(2, steps.size());
        assertEquals(Map.of("line", "5", "f0.v.s", "\"a\tb\nc\\d\""), steps.get(0));
        assertEquals(Map.of("line", "6"), steps.get(1));
        assertEquals(new Termination(Termination.Kind.EXITED, 3, "bye\n"), end);
    }

    @Test
    void emptyValuesSurvive() throws IOException {
        List<Map<String, String>> steps = new ArrayList<>();
        read("STEP\nK\tf0.v.x\t\nEND\tcrashed\t0\t\n", steps);
        assertEquals(Map.of("f0.v.x", ""), steps.get(0));
    }

    @Test
    void aTruncatedTraceKeepsItsStepsAndEndsAsRecorderError() throws IOException {
        List<Map<String, String>> steps = new ArrayList<>();
        Termination end = read("STEP\nK\tline\t1\nSTEP\nK\tline\t2\n", steps);
        assertEquals(2, steps.size());
        assertEquals(Termination.Kind.RECORDER_ERROR, end.kind());
    }

    @Test
    void unknownRecordsAreRejected() {
        assertThrows(IOException.class, () -> read("BOGUS\n", new ArrayList<>()));
        assertThrows(IOException.class, () -> read("K\tline\t1\n", new ArrayList<>()));
    }

    @Test
    void unknownEndKindIsARecorderError() throws IOException {
        assertEquals(Termination.Kind.RECORDER_ERROR, read("END\tweird\t0\t\n", new ArrayList<>()).kind());
    }
}

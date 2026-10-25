package dev.voidrun.recorder;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

/**
 * Records real programs with a real compiler and LLDB, so it only runs when
 * one is available:
 * <ul>
 *   <li>{@code VOIDRUN_RECORDER_IMAGE=voidrun-recorder:latest} records inside
 *       the sandbox image through Docker, exactly as the worker does;</li>
 *   <li>{@code VOIDRUN_CXX} names a host g++ that has {@code <bits/stdc++.h>}
 *       (e.g. {@code g++-16} on macOS with Homebrew GCC), with a python3 that
 *       can import lldb.</li>
 * </ul>
 */
@EnabledIf("toolchainAvailable")
class RecorderIntegrationTest {

    private static final String IMAGE = System.getenv("VOIDRUN_RECORDER_IMAGE");

    static boolean toolchainAvailable() {
        String cxx = System.getenv("VOIDRUN_CXX");
        return (IMAGE != null && !IMAGE.isBlank()) || (cxx != null && !cxx.isBlank());
    }

    private final Recorder recorder = new Recorder(
            (IMAGE != null && !IMAGE.isBlank() ? RecorderConfig.docker(IMAGE) : RecorderConfig.defaults())
                    .withKeyframeInterval(5));

    private static final String FIB = """
            #include <bits/stdc++.h>
            using namespace std;
            long long fib(int n) {
                if (n < 2) return n;
                long long a = fib(n - 1);
                long long b = fib(n - 2);
                return a + b;
            }
            int main() {
                int n;
                cin >> n;
                vector<long long> memo(n + 1);
                for (int i = 0; i <= n; i++) {
                    memo[i] = fib(i);
                }
                cout << memo[n] << endl;
            }
            """;

    /** Fast I/O turns cout's buffering on; output must still appear as each line runs. */
    private static final String FAST_IO = """
            #include <bits/stdc++.h>
            using namespace std;
            void print(int i) {
                if (i == 4) return;
                cout << i << '\\n';
                print(i + 1);
            }
            int main() {
                ios::sync_with_stdio(false);
                cin.tie(nullptr);
                print(0);
                cout << "done";
                return 0;
            }
            """;

    @Test
    void outputShowsUpAsItIsPrintedEvenWithFastIo() throws Exception {
        Recording rec = recorder.record(FAST_IO, "");
        assertEquals(Termination.Kind.EXITED, rec.termination().kind());
        assertEquals("0\n1\n2\n3\ndone", rec.stdoutPrefix(Long.MAX_VALUE));

        ReplayCursor c = new ReplayCursor(rec);
        boolean sawPartial = false;
        do {
            StepView v = c.view();
            StepView.Frame top = v.frames().get(v.frames().size() - 1);
            // Entering print(3): 0, 1 and 2 have been printed, nothing after them yet.
            if (top.function().startsWith("print") && v.line() == 5 && "3".equals(top.variables().get("i"))) {
                assertEquals("0\n1\n2\n", v.stdout());
                sawPartial = true;
            }
        } while (c.forward());
        assertTrue(sawPartial, "never stopped at print(3)");
    }

    @Test
    void recordsRecursionAndReplaysItBothWays() throws Exception {
        Recording rec = recorder.record(FIB, "4\n");
        assertEquals(Termination.Kind.EXITED, rec.termination().kind());
        assertEquals("3\n", rec.stdoutPrefix(Long.MAX_VALUE));

        ReplayCursor c = new ReplayCursor(rec);
        int maxDepth = 0;
        boolean sawFibOfTwoReturning = false;
        do {
            StepView v = c.view();
            maxDepth = Math.max(maxDepth, v.depth());
            StepView.Frame top = v.frames().get(v.frames().size() - 1);
            assertEquals(v.line(), top.line());
            if (top.function().startsWith("fib") && top.line() == 7 && "2".equals(top.variables().get("n"))) {
                assertEquals("1", top.variables().get("a"));
                assertEquals("0", top.variables().get("b"));
                sawFibOfTwoReturning = true;
            }
            // Locals are hidden until their declaration has executed.
            if (top.function().startsWith("fib") && top.line() <= 5) {
                assertFalse(top.variables().containsKey("a"), "a shown before it is initialised");
            }
        } while (c.forward());
        assertEquals(5, maxDepth, "main -> fib(4) -> fib(3) -> fib(2) -> fib(1)");

        // `int n;` compiles to no code, so execution never stops on its line;
        // n still shows once a later line (the read) has run.
        ReplayCursor read = new ReplayCursor(rec);
        while (read.view().line() != 14 && read.forward()) {}
        assertEquals(14, read.view().line());
        assertEquals("4", read.view().frames().get(0).variables().get("n"));
        assertTrue(sawFibOfTwoReturning);

        List<Map<String, String>> forward = new java.util.ArrayList<>();
        ReplayCursor f = new ReplayCursor(rec);
        do forward.add(Map.copyOf(f.state())); while (f.forward());
        for (int i = rec.stepCount() - 1; i >= 0; i--) {
            assertEquals(forward.get(i), c.state(), "backward step " + i);
            c.back();
        }
    }

    @Test
    void stdoutOffsetAdvancesWithEachWrite() throws Exception {
        Recording rec = recorder.record("""
                #include <cstdio>
                int main() {
                    printf("a");
                    printf("bc");
                    return 0;
                }
                """, "");
        ReplayCursor c = new ReplayCursor(rec);
        List<String> outputs = new java.util.ArrayList<>();
        do outputs.add(c.view().stdout()); while (c.forward());
        assertEquals(List.of("", "a", "abc"), outputs.stream().distinct().toList());
    }

    @Test
    void crashEndsOnTheFaultingLineWithTheStackIntact() throws Exception {
        Recording rec = recorder.record("""
                int deref(int *p, int k) {
                    if (k == 0)
                        return *p;
                    return deref(p, k - 1) + 1;
                }
                int main() {
                    int *q = nullptr;
                    return deref(q, 2);
                }
                """, "");
        assertEquals(Termination.Kind.CRASHED, rec.termination().kind());
        ReplayCursor c = new ReplayCursor(rec);
        c.seek(rec.stepCount() - 1);
        StepView v = c.view();
        assertEquals(3, v.line());
        assertEquals(4, v.depth());
        assertEquals("0", v.frames().get(3).variables().get("k"));
    }

    @Test
    void infiniteLoopIsCutAtTheStepBudget() throws Exception {
        Recording rec = new Recorder(RecorderConfig.defaults().withMaxSteps(50)).record("""
                int main() {
                    long s = 0;
                    for (long i = 0;; i++) {
                        s += i;
                    }
                }
                """, "");
        assertEquals(Termination.Kind.STEP_LIMIT, rec.termination().kind());
        assertEquals(50, rec.stepCount());
    }

    @Test
    void singleLineInfiniteLoopIsCutByTheClock() throws Exception {
        RecorderConfig base = RecorderConfig.defaults();
        RecorderConfig config = new RecorderConfig(base.compiler(), base.python(), base.launcher(), base.maxSteps(),
                Duration.ofSeconds(2), base.compileTimeout(), base.maxOutputBytes(), base.keyframeInterval());
        Recording rec = new Recorder(config).record("int main() { while (true) {} }\n", "");
        assertEquals(Termination.Kind.TIME_LIMIT, rec.termination().kind());
        assertTrue(rec.stepCount() >= 1, "the step that was stuck is kept");
    }

    @Test
    void compileErrorHasNoStepsAndKeepsTheDiagnostics() throws Exception {
        Recording rec = recorder.record("int main() { int x = ; }\n", "");
        assertEquals(Termination.Kind.COMPILE_ERROR, rec.termination().kind());
        assertEquals(0, rec.stepCount());
        assertTrue(rec.compileOutput().contains("error"), rec.compileOutput());
    }
}

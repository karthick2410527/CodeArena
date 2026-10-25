package dev.voidrun.recorder;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Records a C++ file and steps through it in the terminal.
 *
 * <pre>
 *   java dev.voidrun.recorder.RecorderCli prog.cpp [input.txt] [--max-steps N] [--docker IMAGE] [--verify]
 *
 *   n / Enter   next step          b       previous step
 *   g N         go to step N       e       last step
 *   q           quit
 * </pre>
 *
 * {@code --verify} skips the stepper and instead rebuilds every step both by
 * walking forward and by seeking from a keyframe, and checks that the two
 * agree; it exits non-zero if they do not. {@code --docker IMAGE} compiles
 * and traces inside the recorder sandbox image instead of on the host.
 */
public final class RecorderCli {

    public static void main(String[] args) throws Exception {
        Path source = null;
        Path input = null;
        boolean verify = false;
        RecorderConfig config = RecorderConfig.defaults();
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--verify" -> verify = true;
                case "--max-steps" -> config = config.withMaxSteps(Integer.parseInt(args[++i]));
                case "--keyframe-interval" -> config = config.withKeyframeInterval(Integer.parseInt(args[++i]));
                case "--docker" -> {
                    String image = args[++i];
                    config = config.withTools("g++", "python3").withLauncher(RecorderConfig.dockerLauncher(image));
                }
                default -> {
                    if (source == null) source = Path.of(args[i]);
                    else input = Path.of(args[i]);
                }
            }
        }
        if (source == null) {
            System.err.println("usage: RecorderCli prog.cpp [input.txt] [--max-steps N] [--keyframe-interval K] [--docker IMAGE] [--verify]");
            System.exit(2);
        }

        String code = Files.readString(source);
        String stdin = input == null ? "" : Files.readString(input);
        long started = System.nanoTime();
        Recording rec = new Recorder(config).record(code, stdin);
        long millis = (System.nanoTime() - started) / 1_000_000;

        PrintStream out = System.out;
        long fullEntries = 0;
        ReplayCursor walk = new ReplayCursor(rec);
        for (int i = 0; i < rec.stepCount(); i++) {
            fullEntries += walk.state().size();
            walk.forward();
        }
        out.printf("recorded %d steps in %d ms, ended %s %s%n", rec.stepCount(), millis, rec.termination().kind(),
                rec.termination().detail().isEmpty() ? "" : "(" + rec.termination().detail() + ")");
        out.printf("stored %d entries in %d keyframes + %d deltas (full states would be %d)%n",
                rec.storedEntries(), rec.keyframes().size(), rec.stepCount(), fullEntries);
        if (!rec.compileOutput().isBlank()) {
            out.println(rec.compileOutput().strip());
        }

        if (verify) {
            System.exit(verify(rec, out) ? 0 : 1);
        }
        if (rec.stepCount() > 0) {
            step(rec, code.lines().toList(), out);
        }
    }

    static boolean verify(Recording rec, PrintStream out) {
        ReplayCursor forward = new ReplayCursor(rec);
        ReplayCursor seeker = new ReplayCursor(rec);
        ReplayCursor backward = new ReplayCursor(rec);
        backward.seek(rec.stepCount() - 1);
        List<Map<String, String>> expected = new ArrayList<>(rec.stepCount());
        for (int i = 0; i < rec.stepCount(); i++) {
            expected.add(Map.copyOf(forward.state()));
            forward.forward();
        }
        for (int i = rec.stepCount() - 1; i >= 0; i--) {
            seeker.seek(i);
            if (!seeker.state().equals(expected.get(i)) || !backward.state().equals(expected.get(i))) {
                out.println("MISMATCH at step " + i);
                return false;
            }
            backward.back();
        }
        out.println("verified: forward walk, keyframe seek and backward steps agree on all " + rec.stepCount() + " steps");
        return true;
    }

    private static void step(Recording rec, List<String> lines, PrintStream out) throws IOException {
        ReplayCursor c = new ReplayCursor(rec);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        print(c.view(), rec, lines, out);
        String cmd;
        while ((cmd = in.readLine()) != null) {
            cmd = cmd.strip();
            if (cmd.equals("q")) {
                return;
            } else if (cmd.isEmpty() || cmd.equals("n")) {
                if (!c.forward()) out.println("(at the last step)");
            } else if (cmd.equals("b")) {
                if (!c.back()) out.println("(at the first step)");
            } else if (cmd.equals("e")) {
                c.seek(rec.stepCount() - 1);
            } else if (cmd.startsWith("g ")) {
                try {
                    c.seek(Integer.parseInt(cmd.substring(2).strip()));
                } catch (NumberFormatException e) {
                    out.println("usage: g <step>");
                    continue;
                }
            } else {
                out.println("n next · b back · g N goto · e end · q quit");
                continue;
            }
            print(c.view(), rec, lines, out);
        }
    }

    private static void print(StepView v, Recording rec, List<String> lines, PrintStream out) {
        String src = v.line() >= 1 && v.line() <= lines.size() ? lines.get(v.line() - 1).strip() : "";
        out.printf("%n── step %d/%d ── line %d: %s%n", v.step(), rec.stepCount() - 1, v.line(), src);
        for (int i = v.frames().size() - 1; i >= 0; i--) {
            StepView.Frame f = v.frames().get(i);
            out.printf("  #%d %s  (line %d)%n", f.index(), f.function(), f.line());
            for (Map.Entry<String, String> e : StepView.sortedVariables(f)) {
                out.printf("      %-18s = %s%n", e.getKey(), e.getValue());
            }
        }
        if (!v.stdout().isEmpty()) {
            out.println("  stdout: " + v.stdout().replace("\n", "⏎"));
        }
        if (v.step() == rec.stepCount() - 1 && rec.termination().kind() != Termination.Kind.EXITED) {
            out.println("  ⚠ " + rec.termination().kind() + ": " + rec.termination().detail());
        }
    }
}

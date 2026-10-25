package dev.voidrun.recorder;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * A step decoded from the flat key space the tracer emits into frames and
 * variables, which is the shape a client renders. See {@code vr_trace.py} for
 * the key layout.
 */
public record StepView(int step, int line, int depth, List<Frame> frames, String stdout) {

    /** A user stack frame; {@code index} 0 is main. Variables are keyed by path, e.g. {@code v[2]} or {@code p.x}. */
    public record Frame(int index, String function, int line, Map<String, String> variables, Map<String, String> types) {}

    static StepView of(int step, Map<String, String> state, Recording recording) {
        TreeMap<Integer, FrameBuilder> frames = new TreeMap<>();
        for (Map.Entry<String, String> e : state.entrySet()) {
            String key = e.getKey();
            if (key.length() < 2 || key.charAt(0) != 'f' || !Character.isDigit(key.charAt(1))) {
                continue;
            }
            int dot = key.indexOf('.');
            if (dot < 0) {
                continue;
            }
            int index = Integer.parseInt(key, 1, dot, 10);
            FrameBuilder f = frames.computeIfAbsent(index, i -> new FrameBuilder());
            String rest = key.substring(dot + 1);
            if (rest.equals("fn")) {
                f.function = e.getValue();
            } else if (rest.equals("line")) {
                f.line = parseInt(e.getValue());
            } else if (rest.startsWith("v.")) {
                f.variables.put(rest.substring(2), e.getValue());
            } else if (rest.startsWith("t.")) {
                f.types.put(rest.substring(2), e.getValue());
            }
        }
        List<Frame> out = new ArrayList<>(frames.size());
        frames.forEach((i, f) -> out.add(new Frame(i, f.function, f.line, Map.copyOf(f.variables), Map.copyOf(f.types))));
        long outBytes = parseLong(state.get("out"));
        return new StepView(step, parseInt(state.get("line")), parseInt(state.get("depth")), List.copyOf(out),
                recording.stdoutPrefix(outBytes));
    }

    /** Variables of {@code frame} in natural order, so {@code v[2]} sorts before {@code v[10]}. */
    public static List<Map.Entry<String, String>> sortedVariables(Frame frame) {
        List<Map.Entry<String, String>> vars = new ArrayList<>(frame.variables().entrySet());
        vars.sort(Map.Entry.comparingByKey(NATURAL));
        return vars;
    }

    static final Comparator<String> NATURAL = (a, b) -> {
        int i = 0, j = 0;
        while (i < a.length() && j < b.length()) {
            char ca = a.charAt(i), cb = b.charAt(j);
            if (Character.isDigit(ca) && Character.isDigit(cb)) {
                int si = i, sj = j;
                while (i < a.length() && Character.isDigit(a.charAt(i))) i++;
                while (j < b.length() && Character.isDigit(b.charAt(j))) j++;
                String na = a.substring(si, i).replaceFirst("^0+(?=.)", "");
                String nb = b.substring(sj, j).replaceFirst("^0+(?=.)", "");
                int c = na.length() != nb.length() ? Integer.compare(na.length(), nb.length()) : na.compareTo(nb);
                if (c != 0) return c;
            } else {
                if (ca != cb) return Character.compare(ca, cb);
                i++;
                j++;
            }
        }
        return Integer.compare(a.length() - i, b.length() - j);
    };

    private static int parseInt(String s) {
        return (int) parseLong(s);
    }

    private static long parseLong(String s) {
        if (s == null) {
            return 0;
        }
        try {
            return Long.parseLong(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static final class FrameBuilder {
        String function = "?";
        int line;
        final Map<String, String> variables = new TreeMap<>();
        final Map<String, String> types = new TreeMap<>();
    }
}

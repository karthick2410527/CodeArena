package dev.voidrun.recorder;

import java.io.BufferedReader;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;

/** Reads the tracer's line protocol; the format is documented in {@code vr_trace.py}. */
final class TraceProtocol {

    private TraceProtocol() {}

    /**
     * Streams each recorded state to {@code onStep} and returns how the trace
     * ended. A stream that stops without an END record (the tracer was killed
     * or crashed) ends as {@link Termination.Kind#RECORDER_ERROR}; every step
     * read before that is still delivered.
     */
    static Termination read(BufferedReader in, Consumer<Map<String, String>> onStep) throws IOException {
        Map<String, String> current = null;
        String line;
        while ((line = in.readLine()) != null) {
            String[] f = line.split("\t", -1);
            switch (f[0]) {
                case "STEP" -> {
                    if (current != null) {
                        onStep.accept(current);
                    }
                    current = new HashMap<>();
                }
                case "K" -> {
                    if (current == null || f.length != 3) {
                        throw new IOException("malformed trace record: " + line);
                    }
                    current.put(unescape(f[1]), unescape(f[2]));
                }
                case "END" -> {
                    if (current != null) {
                        onStep.accept(current);
                    }
                    if (f.length != 4) {
                        throw new IOException("malformed trace record: " + line);
                    }
                    return new Termination(Termination.Kind.fromProtocol(f[1]), Integer.parseInt(f[2]), unescape(f[3]));
                }
                default -> throw new IOException("unknown trace record: " + line);
            }
        }
        if (current != null) {
            onStep.accept(current);
        }
        return Termination.of(Termination.Kind.RECORDER_ERROR, "tracer ended without a result");
    }

    static String unescape(String s) {
        if (s.indexOf('\\') < 0) {
            return s;
        }
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\\' || i + 1 == s.length()) {
                b.append(c);
                continue;
            }
            char n = s.charAt(++i);
            b.append(switch (n) {
                case 't' -> '\t';
                case 'n' -> '\n';
                case 'r' -> '\r';
                default -> n;
            });
        }
        return b.toString();
    }
}

package dev.voidrun.worker.judge;

/**
 * Output comparison: whitespace-normalised, then exact.
 *
 * <ol>
 *   <li>{@code \r\n} and {@code \r} become {@code \n};</li>
 *   <li>trailing spaces and tabs are removed from every line;</li>
 *   <li>trailing blank lines are removed;</li>
 *   <li>what remains must match exactly.</li>
 * </ol>
 *
 * A trailing newline is how a program happens to print, not a wrong answer;
 * but once whitespace is normalised, {@code 1 2} and {@code 12} differ and so
 * do {@code 0.5} and {@code 0.50}. Nothing is rounded or reordered, so the rule
 * can never accept a wrong answer by being generous.
 */
final class OutputCompare {

    private OutputCompare() {}

    static String normalize(String raw) {
        String[] lines = raw.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
        StringBuilder out = new StringBuilder(raw.length());
        int end = lines.length;
        while (end > 0 && stripTrailing(lines[end - 1]).isEmpty()) {
            end--;
        }
        for (int i = 0; i < end; i++) {
            if (i > 0) {
                out.append('\n');
            }
            out.append(stripTrailing(lines[i]));
        }
        return out.toString();
    }

    static boolean matches(String actual, String expected) {
        return normalize(actual).equals(normalize(expected));
    }

    private static String stripTrailing(String line) {
        int n = line.length();
        while (n > 0 && (line.charAt(n - 1) == ' ' || line.charAt(n - 1) == '\t')) {
            n--;
        }
        return line.substring(0, n);
    }
}

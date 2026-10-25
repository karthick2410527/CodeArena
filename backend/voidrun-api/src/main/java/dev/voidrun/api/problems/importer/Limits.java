package dev.voidrun.api.problems.importer;

import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Shared helpers: reading "2 seconds" / "256 megabytes", clamping to this judge's limits, tags and slugs. */
final class Limits {

    static final int MIN_TIME_MS = 100;
    static final int MAX_TIME_MS = 10_000;
    static final int MIN_MEMORY_MB = 16;
    static final int MAX_MEMORY_MB = 512;

    private static final Pattern NUMBER = Pattern.compile("(\\d+(?:\\.\\d+)?)");

    private Limits() {}

    /** "1 second", "2.5 seconds", "2 sec", "1500 ms" to milliseconds; 0 when unreadable. */
    static int timeMs(String text) {
        Matcher m = NUMBER.matcher(text == null ? "" : text);
        if (!m.find()) {
            return 0;
        }
        double v = Double.parseDouble(m.group(1));
        return (int) Math.round(text.toLowerCase(Locale.ROOT).contains("ms") ? v : v * 1000);
    }

    /** "256 megabytes", "1024 MiB", "256 MB" to megabytes; 0 when unreadable. */
    static int memoryMb(String text) {
        Matcher m = NUMBER.matcher(text == null ? "" : text);
        if (!m.find()) {
            return 0;
        }
        double v = Double.parseDouble(m.group(1));
        String t = text.toLowerCase(Locale.ROOT);
        return (int) Math.round(t.contains("kilobyte") || t.contains("kib") || t.contains(" kb") ? v / 1024
                : t.contains("gigabyte") || t.contains("gib") || t.contains(" gb") ? v * 1024 : v);
    }

    static int clampTime(int ms, List<String> warnings) {
        if (ms <= 0) {
            warnings.add("The time limit could not be read; it is set to 1 second.");
            return 1000;
        }
        int c = Math.max(MIN_TIME_MS, Math.min(MAX_TIME_MS, ms));
        if (c != ms) {
            warnings.add("The original time limit (" + ms + " ms) is outside this judge's range; it is set to " + c + " ms.");
        }
        return c;
    }

    static int clampMemory(int mb, List<String> warnings) {
        if (mb <= 0) {
            warnings.add("The memory limit could not be read; it is set to 256 MB.");
            return 256;
        }
        int c = Math.max(MIN_MEMORY_MB, Math.min(MAX_MEMORY_MB, mb));
        if (c != mb) {
            warnings.add("The original memory limit (" + mb + " MB) is outside this judge's range; it is set to " + c + " MB.");
        }
        return c;
    }

    /** "brute force" to "brute-force"; drops anything the tag rules reject. */
    static String tag(String raw) {
        String t = raw.trim().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
        return t.isEmpty() || t.length() > 40 ? null : t;
    }

    static String slug(String text) {
        String s = text.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("(^-|-$)", "");
        if (s.length() > 64) {
            s = s.substring(0, 64).replaceAll("-$", "");
        }
        return s.isEmpty() ? "imported-problem" : s;
    }
}

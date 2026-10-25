package dev.voidrun.worker.judge;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Compiled programs keyed by everything that decides the output:
 * {@code sha256(runner image, compile command, source)}. The same source
 * resubmitted, a Run followed by a Submit, or a rejudge skips the compiler.
 *
 * <p>Each entry is a directory holding the files the compile produced plus
 * the compiler's warnings, written under a temporary name and renamed into
 * place, so a reader never sees half an entry. The cache is bounded by entry
 * count; the least recently used entries are evicted. It is a pure
 * optimisation: any failure here falls back to compiling.
 */
final class CompileCache {

    private static final Logger log = LoggerFactory.getLogger(CompileCache.class);
    private static final String WARNINGS = ".warnings";

    private final Path root;
    private final int maxEntries;

    CompileCache(Path root, int maxEntries) {
        this.root = root;
        this.maxEntries = maxEntries;
    }

    static String key(String image, List<String> compile, String source) {
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            for (String part : List.of(image, String.join("\u0000", compile), source)) {
                sha.update(part.getBytes(StandardCharsets.UTF_8));
                sha.update((byte) 0x1f);
            }
            return HexFormat.of().formatHex(sha.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Copies a cached build into {@code work}; returns its warnings, or empty on a miss. */
    Optional<String> restore(String key, Path work) {
        if (root == null) {
            return Optional.empty();
        }
        Path entry = root.resolve(key);
        if (!Files.isDirectory(entry)) {
            return Optional.empty();
        }
        try (Stream<Path> files = Files.list(entry)) {
            for (Path f : files.toList()) {
                if (!f.getFileName().toString().equals(WARNINGS)) {
                    Files.copy(f, work.resolve(f.getFileName().toString()), StandardCopyOption.REPLACE_EXISTING,
                            StandardCopyOption.COPY_ATTRIBUTES);
                }
            }
            Files.setLastModifiedTime(entry, FileTime.from(Instant.now()));
            Path warnings = entry.resolve(WARNINGS);
            return Optional.of(Files.exists(warnings) ? Files.readString(warnings) : "");
        } catch (IOException | UncheckedIOException e) {
            log.warn("compile cache entry {} unreadable, compiling instead: {}", key, e.toString());
            return Optional.empty();
        }
    }

    void store(String key, List<Path> artifacts, String warnings) {
        if (root == null) {
            return;
        }
        Path entry = root.resolve(key);
        if (Files.isDirectory(entry)) {
            return;
        }
        Path staging = root.resolve(".tmp-" + key + "-" + Thread.currentThread().threadId());
        try {
            Files.createDirectories(staging);
            for (Path a : artifacts) {
                Files.copy(a, staging.resolve(a.getFileName().toString()), StandardCopyOption.COPY_ATTRIBUTES);
            }
            Files.writeString(staging.resolve(WARNINGS), warnings);
            Files.move(staging, entry, StandardCopyOption.ATOMIC_MOVE);
            evict();
        } catch (IOException | UncheckedIOException e) {
            log.warn("could not cache compiled program {}: {}", key, e.toString());
            deleteQuietly(staging);
        }
    }

    private void evict() throws IOException {
        List<Path> entries;
        try (Stream<Path> s = Files.list(root)) {
            entries = s.filter(p -> !p.getFileName().toString().startsWith(".tmp-")).toList();
        }
        if (entries.size() <= maxEntries) {
            return;
        }
        entries.stream()
                .sorted(Comparator.comparing(CompileCache::modified))
                .limit(entries.size() - maxEntries)
                .forEach(CompileCache::deleteQuietly);
    }

    private static FileTime modified(Path p) {
        try {
            return Files.getLastModifiedTime(p);
        } catch (IOException e) {
            return FileTime.fromMillis(0);
        }
    }

    static void deleteQuietly(Path dir) {
        try (Stream<Path> paths = Files.walk(dir)) {
            paths.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // best effort
                }
            });
        } catch (IOException | UncheckedIOException ignored) {
            // already gone
        }
    }
}

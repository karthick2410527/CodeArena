package dev.voidrun.recorder;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

/**
 * Records a C++ program's execution for step-through replay.
 *
 * <p>This is deliberately a separate path from judging. The judge compiles
 * with optimisation and runs at full speed; the recorder compiles with
 * {@code -g -O0} and single-steps every source line under LLDB, which is
 * orders of magnitude slower and is bounded by a step budget rather than by
 * the problem's time limit. A recording is never used to decide a verdict.
 */
public final class Recorder {

    static final String SOURCE = "main.cpp";
    static final String BINARY = "main";
    static final String STDIN = "stdin.txt";
    static final String STDOUT = "stdout.txt";
    static final String TRACER = "vr_trace.py";
    static final String PRELUDE = "vr_prelude.h";

    private final RecorderConfig config;
    private final Path workRoot;

    public Recorder(RecorderConfig config) {
        this(config, null);
    }

    /**
     * @param workRoot where per-recording working directories are created, or
     *                 null for the system temp directory. A worker that runs in
     *                 a container and starts sandboxes through the host's Docker
     *                 daemon needs a directory mounted at the same path on both
     *                 sides, because the daemon resolves {@code -v {work}:/work}
     *                 on the host.
     */
    public Recorder(RecorderConfig config, Path workRoot) {
        this.config = config;
        this.workRoot = workRoot;
    }

    public Recording record(String source, String stdin) throws IOException, InterruptedException {
        Path work = workRoot == null
                ? Files.createTempDirectory("voidrun-rec-")
                : Files.createTempDirectory(Files.createDirectories(workRoot), "voidrun-rec-");
        try {
            if (!config.launcher().isEmpty()) {
                // The sandbox runs as its own unprivileged user, which must be
                // able to write the binary and the program's output here. The
                // directory name is random and it is deleted afterwards.
                openToSandbox(work);
            }
            return record(work, source, stdin);
        } finally {
            deleteRecursively(work);
        }
    }

    private Recording record(Path work, String source, String stdin) throws IOException, InterruptedException {
        copyResource(TRACER, work);
        copyResource(PRELUDE, work);
        Files.writeString(work.resolve(SOURCE), source);
        Files.writeString(work.resolve(STDIN), stdin == null ? "" : stdin);

        Compile compile = compile(work);
        if (!compile.ok) {
            return Recording.withoutSteps(new byte[0], compile.output, compile.termination);
        }

        RecordingBuilder builder = new RecordingBuilder(config.keyframeInterval());
        Termination end = trace(work, builder);
        return builder.build(readStdout(work), compile.output, end);
    }

    private record Compile(boolean ok, String output, Termination termination) {}

    private Compile compile(Path work) throws IOException, InterruptedException {
        List<String> cmd = launcher(work);
        cmd.addAll(List.of(config.compiler(), "-std=c++17", "-g", "-O0", "-fno-omit-frame-pointer",
                "-include", PRELUDE, SOURCE, "-o", BINARY));
        Process p = new ProcessBuilder(cmd).directory(work.toFile()).redirectErrorStream(true).start();
        p.getOutputStream().close();
        // Compiler diagnostics can be large; drain them concurrently so the
        // compiler never blocks on a full pipe.
        StreamCapture out = StreamCapture.start(p.getInputStream(), 64 * 1024);
        if (!p.waitFor(config.compileTimeout().toMillis(), TimeUnit.MILLISECONDS)) {
            p.destroyForcibly().waitFor();
            return new Compile(false, out.text(), Termination.of(Termination.Kind.COMPILE_ERROR,
                    "compilation exceeded " + config.compileTimeout().toSeconds() + "s"));
        }
        String text = out.text();
        if (p.exitValue() != 0) {
            return new Compile(false, text, Termination.of(Termination.Kind.COMPILE_ERROR, "compilation failed"));
        }
        return new Compile(true, text, null);
    }

    private Termination trace(Path work, RecordingBuilder builder) throws IOException, InterruptedException {
        List<String> cmd = launcher(work);
        double seconds = config.maxTraceTime().toMillis() / 1000.0;
        cmd.addAll(List.of(config.python(), TRACER,
                "--binary", BINARY, "--source", SOURCE, "--stdin", STDIN, "--stdout", STDOUT,
                "--max-steps", Integer.toString(config.maxSteps()),
                "--max-seconds", Double.toString(seconds)));
        Process p = new ProcessBuilder(cmd)
                .directory(work.toFile())
                .redirectError(work.resolve("tracer.log").toFile())
                .start();
        p.getOutputStream().close();

        // The tracer enforces its own time budget; this is the backstop for a
        // tracer that is wedged inside LLDB and never reaches its check.
        Thread watchdog = Thread.ofVirtual().start(() -> {
            try {
                if (!p.waitFor(config.maxTraceTime().toMillis() + 10_000, TimeUnit.MILLISECONDS)) {
                    p.destroyForcibly();
                }
            } catch (InterruptedException ignored) {
                p.destroyForcibly();
            }
        });

        Termination end;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            end = TraceProtocol.read(r, builder::add);
        } finally {
            p.waitFor();
            watchdog.interrupt();
        }
        if (end.kind() == Termination.Kind.RECORDER_ERROR && end.detail().equals("tracer ended without a result")) {
            String log = tail(work.resolve("tracer.log"), 2000);
            end = Termination.of(Termination.Kind.RECORDER_ERROR,
                    "tracer exited with status " + p.exitValue() + (log.isEmpty() ? "" : ": " + log));
        }
        return end;
    }

    private List<String> launcher(Path work) {
        return new ArrayList<>(config.launcher().stream().map(a -> a.replace("{work}", work.toString())).toList());
    }

    private byte[] readStdout(Path work) throws IOException {
        Path out = work.resolve(STDOUT);
        if (!Files.exists(out)) {
            return new byte[0];
        }
        try (InputStream in = Files.newInputStream(out)) {
            return in.readNBytes(config.maxOutputBytes());
        }
    }

    private static void openToSandbox(Path dir) throws IOException {
        try {
            Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwxrwxrwx"));
        } catch (UnsupportedOperationException ignored) {
            // Not a POSIX file system; the sandbox's mount decides access.
        }
    }

    private static void copyResource(String name, Path dir) throws IOException {
        try (InputStream in = Recorder.class.getResourceAsStream(name)) {
            if (in == null) {
                throw new IOException("missing recorder resource " + name);
            }
            Files.copy(in, dir.resolve(name), StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static String tail(Path file, int maxChars) {
        try {
            String s = Files.readString(file).strip();
            return s.length() <= maxChars ? s : s.substring(s.length() - maxChars);
        } catch (IOException e) {
            return "";
        }
    }

    private static void deleteRecursively(Path dir) {
        try (Stream<Path> paths = Files.walk(dir)) {
            paths.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            });
        } catch (IOException | UncheckedIOException ignored) {
            // A leftover temp directory is not worth failing a recording over.
        }
    }

    /** Drains a stream on a virtual thread, keeping at most {@code cap} bytes. */
    private static final class StreamCapture {
        private final FutureTask<byte[]> task;

        private StreamCapture(InputStream in, int cap) {
            this.task = new FutureTask<>(() -> {
                try (in) {
                    byte[] kept = in.readNBytes(cap);
                    in.transferTo(OutputStream.nullOutputStream());
                    return kept;
                }
            });
            Thread.ofVirtual().start(task);
        }

        static StreamCapture start(InputStream in, int cap) {
            return new StreamCapture(in, cap);
        }

        String text() throws InterruptedException {
            try {
                return new String(task.get(), StandardCharsets.UTF_8);
            } catch (ExecutionException e) {
                return "";
            }
        }
    }
}

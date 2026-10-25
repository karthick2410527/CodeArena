package dev.voidrun.worker.judge;

import dev.voidrun.common.Language;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Runs each job in its own throwaway container of the runner image, started
 * through the Docker daemon:
 *
 * <pre>
 *   --network none --read-only --tmpfs /tmp --cap-drop ALL
 *   --security-opt no-new-privileges --user 65534:65534 --pids-limit 256
 *   --memory / --memory-swap (no swap) --cpus 1 --ulimit nofile
 * </pre>
 *
 * The container is started once per job ({@code sleep infinity}); the compile
 * and every test are {@code docker exec}s of {@code vr-run}, which applies the
 * per-test CPU, address-space and output limits and measures time and peak
 * memory from inside, so container start-up never counts against a time
 * limit. The job's directory is bind-mounted at {@code /work}; when the worker
 * itself runs in a container it must be the same path for the worker and the
 * daemon.
 */
public final class DockerSandbox implements Sandbox {

    private static final Logger log = LoggerFactory.getLogger(DockerSandbox.class);
    private static final int COMPILE_TIMEOUT_MS = 30_000;
    /** Output beyond this is OUTPUT_LIMIT; what is stored is capped separately. */
    private static final long OUTPUT_LIMIT_BYTES = 16L * 1024 * 1024;
    private static final int SIGKILL = 9;
    private static final int SIGXCPU = 24;
    private static final int SIGXFSZ = 25;

    private final String image;
    private final Path workRoot;
    private final int keptOutputBytes;
    private final CompileCache cache;

    public DockerSandbox(String image, Path workRoot, int keptOutputBytes, Path cacheDir, int cacheEntries) {
        this.image = image;
        this.workRoot = workRoot;
        this.keptOutputBytes = keptOutputBytes;
        this.cache = new CompileCache(cacheDir, cacheEntries);
    }

    @Override
    public Session open(Language language, String source, int memoryLimitMb) throws IOException, InterruptedException {
        Toolchain tc = Toolchain.of(language);
        Path work = workRoot == null
                ? Files.createTempDirectory("voidrun-judge-")
                : Files.createTempDirectory(Files.createDirectories(workRoot), "voidrun-judge-");
        String name = "voidrun-judge-" + HexFormat.of().toHexDigits(ThreadLocalRandom.current().nextLong());
        try {
            // The sandbox user must be able to write the build and the outputs.
            Files.setPosixFilePermissions(work, PosixFilePermissions.fromString("rwxrwxrwx"));
            Files.writeString(work.resolve(tc.sourceFile()), source);
            // Room for the compiler and, for the JVM, its overhead above the heap.
            int containerMb = Math.max(1024, memoryLimitMb * 2 + 256);
            Proc started = Proc.run(List.of("docker", "run", "-d", "--name", name,
                    "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,size=128m",
                    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534",
                    "--pids-limit", "256", "--memory", containerMb + "m", "--memory-swap", containerMb + "m",
                    "--cpus", "1", "--ulimit", "nofile=256:256",
                    "-e", "HOME=/tmp", "-e", "TMPDIR=/tmp",
                    "-v", work + ":/work", "-w", "/work", image, "sleep", "infinity"), 60_000);
            if (started.exit() != 0) {
                throw new IOException("could not start the sandbox: " + firstLine(started.stderr()));
            }
        } catch (IOException | InterruptedException | RuntimeException e) {
            remove(name);
            CompileCache.deleteQuietly(work);
            throw e;
        }
        return new DockerSession(language, tc, source, work, name);
    }

    private final class DockerSession implements Session {
        private final Language language;
        private final Toolchain tc;
        private final String source;
        private final Path work;
        private final String container;
        private int seq;

        DockerSession(Language language, Toolchain tc, String source, Path work, String container) {
            this.language = language;
            this.tc = tc;
            this.source = source;
            this.work = work;
            this.container = container;
        }

        @Override
        public Compilation compile() throws IOException, InterruptedException {
            if (!tc.compiled()) {
                return new Compilation(true, "", 0, false);
            }
            String key = CompileCache.key(image, tc.compile(), source);
            Optional<String> cached = cache.restore(key, work);
            if (cached.isPresent()) {
                return new Compilation(true, cached.get(), 0, true);
            }
            Set<String> before = listing();
            Result r = vrRun(COMPILE_TIMEOUT_MS, COMPILE_TIMEOUT_MS, 0, "/dev/null", "compile.out", "compile.err",
                    tc.compile());
            String output = (read(work.resolve("compile.err")).text() + read(work.resolve("compile.out")).text())
                    .strip();
            boolean ok = !r.timedOut() && r.exit() != null && r.exit() == 0
                    && Files.exists(work.resolve(tc.artifact()));
            if (r.timedOut()) {
                output = "compilation took longer than " + COMPILE_TIMEOUT_MS / 1000 + "s";
            } else if (!ok && output.isEmpty()) {
                output = "compilation failed";
            }
            if (ok) {
                List<Path> artifacts = new ArrayList<>();
                for (String f : listing()) {
                    if (!before.contains(f) && !f.startsWith("compile.")) {
                        artifacts.add(work.resolve(f));
                    }
                }
                cache.store(key, artifacts, output);
            }
            return new Compilation(ok, output, r.wallMs(), false);
        }

        @Override
        public Execution execute(String stdin, int timeLimitMs, int memoryLimitMb)
                throws IOException, InterruptedException {
            int n = ++seq;
            String in = "t" + n + ".in";
            String out = "t" + n + ".out";
            String err = "t" + n + ".err";
            Files.writeString(work.resolve(in), stdin == null ? "" : stdin);
            try {
                int limit = timeLimitMs * tc.timeFactor();
                // Wall-clock backstop for a program that sleeps or blocks instead of computing.
                Result r = vrRun(limit * 2 + 1000, limit, tc.addressSpaceMb(language, memoryLimitMb), in, out, err,
                        tc.run(language, memoryLimitMb));
                Captured o = read(work.resolve(out));
                Captured e = read(work.resolve(err));
                ExecStatus status = classify(r, limit, memoryLimitMb, e.text());
                return new Execution(status, o.text(), e.text(), o.truncated(), e.truncated(), r.wallMs(),
                        r.maxRssKb() * 1024L, r.exit(), r.signal());
            } finally {
                for (String f : List.of(in, out, err)) {
                    Files.deleteIfExists(work.resolve(f));
                }
            }
        }

        private ExecStatus classify(Result r, int limitMs, int memoryLimitMb, String stderr) {
            if (r.timedOut() || r.cpuMs() > limitMs || Integer.valueOf(SIGXCPU).equals(r.signal())) {
                return ExecStatus.TIME_LIMIT;
            }
            if (Integer.valueOf(SIGXFSZ).equals(r.signal())) {
                return ExecStatus.OUTPUT_LIMIT;
            }
            boolean outOfMemory = switch (language) {
                case CPP17 -> r.maxRssKb() > memoryLimitMb * 1024L || stderr.contains("std::bad_alloc");
                case JAVA21 -> stderr.contains("java.lang.OutOfMemoryError");
                case NODE22 -> stderr.contains("heap out of memory");
            };
            // A SIGKILL that was not our timeout is the container's OOM killer.
            if (outOfMemory || Integer.valueOf(SIGKILL).equals(r.signal())) {
                return ExecStatus.MEMORY_LIMIT;
            }
            if (r.signal() != null) {
                return ExecStatus.SIGNALLED;
            }
            return r.exit() == 0 ? ExecStatus.OK : ExecStatus.NON_ZERO_EXIT;
        }

        private Result vrRun(int wallMs, int cpuMs, int addressSpaceMb, String in, String out, String err,
                List<String> command) throws IOException, InterruptedException {
            List<String> cmd = new ArrayList<>(List.of("docker", "exec", container, "vr-run",
                    Integer.toString(wallMs), Integer.toString(cpuMs), Integer.toString(addressSpaceMb),
                    Long.toString(OUTPUT_LIMIT_BYTES), in, out, err, "--"));
            cmd.addAll(command);
            Proc p = Proc.run(cmd, wallMs + 30_000L);
            if (p.exit() != 0) {
                throw new IOException("sandbox exec failed (" + p.exit() + "): " + firstLine(p.stderr()));
            }
            return Result.parse(p.stdout());
        }

        private Set<String> listing() throws IOException {
            try (Stream<Path> s = Files.list(work)) {
                return new HashSet<>(s.map(f -> f.getFileName().toString()).toList());
            }
        }

        private Captured read(Path file) throws IOException {
            if (!Files.exists(file)) {
                return new Captured("", false);
            }
            long size = Files.size(file);
            int keep = (int) Math.min(size, OUTPUT_LIMIT_BYTES);
            try (InputStream s = Files.newInputStream(file)) {
                byte[] b = s.readNBytes(keep);
                return new Captured(new String(b, StandardCharsets.UTF_8), size > keptOutputBytes);
            }
        }

        @Override
        public void close() {
            remove(container);
            CompileCache.deleteQuietly(work);
        }
    }

    private record Captured(String text, boolean truncated) {}

    /** vr-run's report line. */
    record Result(int wallMs, int cpuMs, long maxRssKb, boolean timedOut, Integer exit, Integer signal) {
        static Result parse(String line) throws IOException {
            Map<String, String> f = new java.util.HashMap<>();
            for (String kv : line.strip().split("\\s+")) {
                int eq = kv.indexOf('=');
                if (eq > 0) {
                    f.put(kv.substring(0, eq), kv.substring(eq + 1));
                }
            }
            if (!f.containsKey("wall_ms") || (!f.containsKey("exit") && !f.containsKey("signal"))) {
                throw new IOException("unexpected vr-run output: " + line.strip());
            }
            return new Result(Integer.parseInt(f.get("wall_ms")), Integer.parseInt(f.get("cpu_ms")),
                    Long.parseLong(f.get("maxrss_kb")), "1".equals(f.get("timed_out")),
                    f.containsKey("exit") ? Integer.valueOf(f.get("exit")) : null,
                    f.containsKey("signal") ? Integer.valueOf(f.get("signal")) : null);
        }
    }

    private static void remove(String container) {
        try {
            Proc.run(List.of("docker", "rm", "-f", container), 30_000);
        } catch (IOException | InterruptedException e) {
            log.warn("could not remove sandbox container {}: {}", container, e.toString());
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private static String firstLine(String s) {
        String t = s.strip();
        int nl = t.indexOf('\n');
        return nl < 0 ? t : t.substring(0, nl);
    }

    /** A finished docker command; output is small (ids, vr-run's one line, error messages). */
    record Proc(int exit, String stdout, String stderr) {
        static Proc run(List<String> cmd, long timeoutMs) throws IOException, InterruptedException {
            Process p = new ProcessBuilder(cmd).start();
            p.getOutputStream().close();
            byte[][] streams = new byte[2][];
            Thread o = Thread.ofVirtual().start(() -> streams[0] = drain(p.getInputStream()));
            Thread e = Thread.ofVirtual().start(() -> streams[1] = drain(p.getErrorStream()));
            if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
                p.destroyForcibly().waitFor();
                throw new IOException("timed out: " + String.join(" ", cmd.subList(0, Math.min(3, cmd.size()))));
            }
            o.join();
            e.join();
            return new Proc(p.exitValue(), new String(streams[0], StandardCharsets.UTF_8),
                    new String(streams[1], StandardCharsets.UTF_8));
        }

        private static byte[] drain(InputStream in) {
            try (in) {
                byte[] kept = in.readNBytes(64 * 1024);
                in.transferTo(java.io.OutputStream.nullOutputStream()); // never leave the process blocked on a full pipe
                return kept;
            } catch (IOException ex) {
                return new byte[0];
            }
        }
    }
}

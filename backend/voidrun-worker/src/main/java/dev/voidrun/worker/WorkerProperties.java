package dev.voidrun.worker;

import java.net.InetAddress;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Everything under {@code voidrun.worker.*}.
 *
 * @param id     names this worker in claimed rows and logs; defaults to the host name
 * @param replay execution recording
 * @param judge  judging runs and submissions
 */
@ConfigurationProperties("voidrun.worker")
public record WorkerProperties(String id, Replay replay, Judge judge) {

    public WorkerProperties {
        id = id == null || id.isBlank() ? defaultId() : id;
        replay = replay == null ? new Replay(null, List.of(), null, 0, null) : replay;
        judge = judge == null ? new Judge(null, null, null, 0, 0) : judge;
    }

    /**
     * @param image           the runner image every job is compiled and run in
     * @param workDir         where per-job directories go; same rule as {@link Replay#workDir}
     * @param cacheDir        compiled-program cache; empty disables it
     * @param cacheEntries    compiled programs kept before the least recently used are evicted
     * @param keptOutputBytes program output stored per test (the whole output is still compared)
     */
    public record Judge(String image, String workDir, String cacheDir, int cacheEntries, int keptOutputBytes) {
        public Judge {
            image = image == null || image.isBlank() ? "voidrun-runner:latest" : image;
            cacheEntries = cacheEntries <= 0 ? 500 : cacheEntries;
            keptOutputBytes = keptOutputBytes <= 0 ? 64 * 1024 : keptOutputBytes;
        }

        public Path workPath() {
            return workDir == null || workDir.isBlank() ? null : Path.of(workDir);
        }

        public Path cachePath() {
            return cacheDir == null || cacheDir.isBlank() ? null : Path.of(cacheDir);
        }
    }

    /**
     * @param image    the sandbox image compiles and traces run in
     * @param launcher replaces the default {@code docker run ... image} prefix, e.g. to add runtime flags
     * @param workDir  where per-recording directories go; must be the same path for this process and the Docker
     *                 daemon when the worker itself runs in a container
     * @param maxSteps source steps recorded before a recording is cut short
     * @param maxTime  wall-clock budget for one trace
     */
    public record Replay(String image, List<String> launcher, String workDir, int maxSteps, Duration maxTime) {
        public Replay {
            image = image == null || image.isBlank() ? "voidrun-recorder:latest" : image;
            launcher = launcher == null ? List.of() : List.copyOf(launcher);
            maxSteps = maxSteps <= 0 ? 2000 : maxSteps;
            maxTime = maxTime == null ? Duration.ofSeconds(20) : maxTime;
        }

        /** The work directory, or null for the system temp directory. */
        public Path workPath() {
            return workDir == null || workDir.isBlank() ? null : Path.of(workDir);
        }
    }

    private static String defaultId() {
        try {
            return InetAddress.getLocalHost().getHostName();
        } catch (Exception e) {
            return "worker-" + UUID.randomUUID().toString().substring(0, 8);
        }
    }
}

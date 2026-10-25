package dev.voidrun.recorder;

import java.time.Duration;
import java.util.List;

/**
 * Settings for {@link Recorder}.
 *
 * @param compiler         C++ compiler; must provide {@code <bits/stdc++.h>}, so g++ rather than Apple clang
 * @param python           a python3 that can import LLDB's python module
 * @param launcher         command prefix that every compile and trace runs under; empty runs
 *                         directly on the host. {@code {work}} is replaced with the recording's
 *                         working directory, and commands use paths relative to it, so a
 *                         {@code docker run -v {work}:/work -w /work voidrun-recorder} prefix
 *                         runs both steps inside the recorder image
 * @param maxSteps         recorded source steps before the recording is cut short
 * @param maxTraceTime     wall-clock budget for tracing
 * @param compileTimeout   wall-clock budget for compiling
 * @param maxOutputBytes   program stdout kept with the recording
 * @param keyframeInterval steps between full snapshots
 */
public record RecorderConfig(
        String compiler,
        String python,
        List<String> launcher,
        int maxSteps,
        Duration maxTraceTime,
        Duration compileTimeout,
        int maxOutputBytes,
        int keyframeInterval) {

    public RecorderConfig {
        launcher = List.copyOf(launcher);
    }

    /** Defaults, overridable with VOIDRUN_CXX and VOIDRUN_PYTHON. */
    public static RecorderConfig defaults() {
        return new RecorderConfig(
                env("VOIDRUN_CXX", "g++"),
                env("VOIDRUN_PYTHON", "python3"),
                List.of(),
                2000,
                Duration.ofSeconds(20),
                Duration.ofSeconds(30),
                64 * 1024,
                32);
    }

    /**
     * Defaults that compile and trace inside {@code image} (see
     * {@code docker/recorder.Dockerfile}), one throwaway container per step:
     * no network, a read-only root, no capabilities, and bounded processes,
     * memory and CPU. The image's own g++ and python3 are used, whatever the
     * host has.
     */
    public static RecorderConfig docker(String image) {
        return defaults().withTools("g++", "python3").withLauncher(dockerLauncher(image));
    }

    public static List<String> dockerLauncher(String image) {
        return List.of("docker", "run", "--rm", "-i",
                "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,size=64m",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--pids-limit", "256", "--memory", "512m", "--memory-swap", "512m", "--cpus", "1",
                "-e", "HOME=/tmp", "-v", "{work}:/work", "-w", "/work", image);
    }

    public RecorderConfig withTools(String compiler, String python) {
        return new RecorderConfig(compiler, python, launcher, maxSteps, maxTraceTime, compileTimeout, maxOutputBytes,
                keyframeInterval);
    }

    public RecorderConfig withLauncher(List<String> launcher) {
        return new RecorderConfig(compiler, python, launcher, maxSteps, maxTraceTime, compileTimeout, maxOutputBytes,
                keyframeInterval);
    }

    public RecorderConfig withMaxTraceTime(Duration maxTraceTime) {
        return new RecorderConfig(compiler, python, launcher, maxSteps, maxTraceTime, compileTimeout, maxOutputBytes,
                keyframeInterval);
    }

    public RecorderConfig withMaxSteps(int maxSteps) {
        return new RecorderConfig(compiler, python, launcher, maxSteps, maxTraceTime, compileTimeout, maxOutputBytes,
                keyframeInterval);
    }

    public RecorderConfig withKeyframeInterval(int keyframeInterval) {
        return new RecorderConfig(compiler, python, launcher, maxSteps, maxTraceTime, compileTimeout, maxOutputBytes,
                keyframeInterval);
    }

    private static String env(String name, String fallback) {
        String v = System.getenv(name);
        return v == null || v.isBlank() ? fallback : v;
    }
}

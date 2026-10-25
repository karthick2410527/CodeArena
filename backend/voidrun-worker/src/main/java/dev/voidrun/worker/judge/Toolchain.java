package dev.voidrun.worker.judge;

import dev.voidrun.common.Language;
import java.util.List;

/**
 * How each language is compiled and run inside the runner image. Fixed here,
 * on the server: a request only ever picks a language id, never a command.
 *
 * @param sourceFile   where the submitted source is written
 * @param compile      the compile command, or empty for an interpreted language
 * @param artifact     a file the compile must produce for it to count as a success
 * @param timeFactor   multiplier on the problem's time limit, for runtimes that start a VM
 */
record Toolchain(String sourceFile, List<String> compile, String artifact, int timeFactor) {

    static Toolchain of(Language language) {
        return switch (language) {
            // -I finds the image's precompiled <bits/stdc++.h>, built with exactly these flags.
            case CPP17 -> new Toolchain("main.cpp",
                    List.of("g++", "-std=c++17", "-O2", "-pipe", "-I/opt/voidrun/pch", "-o", "main", "main.cpp"),
                    "main", 1);
            case JAVA21 -> new Toolchain("Main.java",
                    List.of("javac", "-J-Xmx512m", "-J-XX:+UseSerialGC", "-encoding", "UTF-8", "-d", ".", "Main.java"),
                    "Main.class", 2);
            case NODE22 -> new Toolchain("main.js", List.of(), null, 2);
        };
    }

    boolean compiled() {
        return !compile.isEmpty();
    }

    /** The run command for a memory limit; the heap-managing runtimes get it as their own heap cap. */
    List<String> run(Language language, int memoryLimitMb) {
        return switch (language) {
            case CPP17 -> List.of("./main");
            case JAVA21 -> List.of("java", "-Xmx" + memoryLimitMb + "m", "-Xss64m", "-XX:+UseSerialGC",
                    "-XX:-UsePerfData", "-cp", ".", "Main");
            case NODE22 -> List.of("node", "--max-old-space-size=" + memoryLimitMb, "--stack-size=32000", "main.js");
        };
    }

    /**
     * Address-space limit in MB, or 0 for none. Native code gets one, so an
     * oversized allocation fails inside the program (std::bad_alloc) instead
     * of the whole sandbox being OOM-killed; the JVM and V8 reserve far more
     * address space than they use, so they are capped by their heap flags.
     */
    int addressSpaceMb(Language language, int memoryLimitMb) {
        return language == Language.CPP17 ? memoryLimitMb + 64 : 0;
    }
}

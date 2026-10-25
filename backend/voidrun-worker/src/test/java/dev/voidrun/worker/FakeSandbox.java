package dev.voidrun.worker;

import dev.voidrun.common.Language;
import dev.voidrun.worker.judge.ExecStatus;
import dev.voidrun.worker.judge.Sandbox;
import java.io.IOException;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A judge sandbox that "runs" a program by summing the numbers in its input,
 * which is what a-plus-b wants, unless the source says otherwise:
 * {@code compile-error}, {@code wrong} (prints 0), {@code slow-on-3} (time
 * limit on the third test), {@code crash} (SIGSEGV), {@code sandbox-down}
 * (the sandbox fails every time) or {@code sandbox-flaky} (fails once).
 */
public class FakeSandbox implements Sandbox {

    final Map<String, AtomicInteger> opens = new ConcurrentHashMap<>();

    public int opensFor(String source) {
        AtomicInteger n = opens.get(source);
        return n == null ? 0 : n.get();
    }

    @Override
    public Session open(Language language, String source, int memoryLimitMb) throws IOException {
        int n = opens.computeIfAbsent(source, s -> new AtomicInteger()).incrementAndGet();
        if (source.contains("sandbox-down") || (source.contains("sandbox-flaky") && n == 1)) {
            throw new IOException("could not start the sandbox: Cannot connect to the Docker daemon");
        }
        return new Session() {
            int executed;

            @Override
            public Compilation compile() {
                return source.contains("compile-error")
                        ? new Compilation(false, "main.cpp:1:1: error: expected unqualified-id", 40, false)
                        : new Compilation(true, "", 40, false);
            }

            @Override
            public Execution execute(String stdin, int timeLimitMs, int memoryLimitMb) {
                executed++;
                if (source.contains("crash")) {
                    return new Execution(ExecStatus.SIGNALLED, "", "", false, false, 3, 1024L, null, 11);
                }
                if (source.contains("slow-on-3") && executed == 3) {
                    return new Execution(ExecStatus.TIME_LIMIT, "", "", false, false, timeLimitMs + 1, 1024L, null, 9);
                }
                long sum = Arrays.stream(stdin.trim().split("\\s+")).filter(t -> !t.isEmpty())
                        .mapToLong(Long::parseLong).sum();
                String out = source.contains("wrong") ? "0\n" : sum + "\n";
                return new Execution(ExecStatus.OK, out, "", false, false, 5 + executed, 2_000_000L, 0, null);
            }

            @Override
            public void close() {}
        };
    }
}

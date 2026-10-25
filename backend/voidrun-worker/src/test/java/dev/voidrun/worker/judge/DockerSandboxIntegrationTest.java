package dev.voidrun.worker.judge;

import static org.assertj.core.api.Assertions.assertThat;

import dev.voidrun.common.Language;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Real programs in the real runner image through Docker, as the worker runs
 * them. Needs the image: {@code make runner-image}, then
 * {@code VOIDRUN_RUNNER_IMAGE=voidrun-runner:latest}.
 */
@EnabledIfEnvironmentVariable(named = "VOIDRUN_RUNNER_IMAGE", matches = ".+")
class DockerSandboxIntegrationTest {

    private static Path cache;
    private static DockerSandbox sandbox;

    @BeforeAll
    static void setUp() throws Exception {
        cache = Files.createTempDirectory("voidrun-cache-test-");
        sandbox = new DockerSandbox(System.getenv("VOIDRUN_RUNNER_IMAGE"), null, 64 * 1024, cache, 10);
    }

    @AfterAll
    static void tearDown() {
        CompileCache.deleteQuietly(cache);
    }

    private static final String SUM = """
            #include <bits/stdc++.h>
            using namespace std;
            int main() { long long a, b; cin >> a >> b; cout << a + b << "\\n"; }
            """;

    @Test
    void cppCompilesOnceRunsEachTestAndReusesTheBuild() throws Exception {
        try (Sandbox.Session s = sandbox.open(Language.CPP17, SUM, 256)) {
            Sandbox.Compilation c = s.compile();
            assertThat(c.ok()).as(c.output()).isTrue();
            assertThat(c.cached()).isFalse();
            Sandbox.Execution e = s.execute("3 5\n", 1000, 256);
            assertThat(e.status()).isEqualTo(ExecStatus.OK);
            assertThat(e.stdout()).isEqualTo("8\n");
            assertThat(e.timeMs()).isLessThan(500);
            assertThat(e.memoryBytes()).isPositive();
            assertThat(s.execute("-1 1", 1000, 256).stdout()).isEqualTo("0\n");
        }
        try (Sandbox.Session s = sandbox.open(Language.CPP17, SUM, 256)) {
            Sandbox.Compilation again = s.compile();
            assertThat(again.cached()).isTrue();
            assertThat(s.execute("40 2", 1000, 256).stdout()).isEqualTo("42\n");
        }
    }

    @Test
    void cppFailuresAreClassified() throws Exception {
        assertThat(run(Language.CPP17, "int main(){ volatile long x = 0; while (true) x++; }", "").status())
                .isEqualTo(ExecStatus.TIME_LIMIT);
        assertThat(run(Language.CPP17, "int main(){ int *p = nullptr; return *p; }", "").status())
                .isEqualTo(ExecStatus.SIGNALLED);
        assertThat(run(Language.CPP17, "int main(){ return 3; }", "").exitCode()).isEqualTo(3);
        assertThat(run(Language.CPP17, """
                #include <bits/stdc++.h>
                int main(){ std::vector<long long> v(200'000'000, 1); std::cout << v.back(); }
                """, "").status()).isEqualTo(ExecStatus.MEMORY_LIMIT);
        assertThat(run(Language.CPP17, """
                #include <bits/stdc++.h>
                int main(){ std::string s(1 << 20, 'x'); while (true) std::cout << s; }
                """, "").status()).isEqualTo(ExecStatus.OUTPUT_LIMIT);
    }

    @Test
    void compileErrorsComeBackAsDiagnostics() throws Exception {
        try (Sandbox.Session s = sandbox.open(Language.CPP17, "int main() { return x; }", 256)) {
            Sandbox.Compilation c = s.compile();
            assertThat(c.ok()).isFalse();
            assertThat(c.output()).contains("main.cpp:1", "was not declared");
        }
        try (Sandbox.Session s = sandbox.open(Language.JAVA21, "public class Main { int x = ; }", 256)) {
            assertThat(s.compile().ok()).isFalse();
        }
    }

    @Test
    void javaRunsAndHitsItsHeapLimit() throws Exception {
        Sandbox.Execution ok = run(Language.JAVA21, """
                import java.util.*;
                public class Main {
                    public static void main(String[] args) {
                        Scanner in = new Scanner(System.in);
                        System.out.println(in.nextLong() + in.nextLong());
                    }
                }
                """, "20 22");
        assertThat(ok.status()).as(ok.stderr()).isEqualTo(ExecStatus.OK);
        assertThat(ok.stdout()).isEqualTo("42\n");
        assertThat(run(Language.JAVA21, """
                public class Main {
                    public static void main(String[] args) {
                        long[][] a = new long[1000][];
                        for (int i = 0; i < a.length; i++) a[i] = new long[1_000_000];
                    }
                }
                """, "").status()).isEqualTo(ExecStatus.MEMORY_LIMIT);
    }

    @Test
    void nodeRunsWithoutACompileStep() throws Exception {
        Sandbox.Execution ok = run(Language.NODE22, """
                const [a, b] = require("fs").readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);
                console.log(a + b);
                """, "1 2");
        assertThat(ok.status()).as(ok.stderr()).isEqualTo(ExecStatus.OK);
        assertThat(ok.stdout()).isEqualTo("3\n");
        Sandbox.Execution thrown = run(Language.NODE22, "throw new Error('boom');", "");
        assertThat(thrown.status()).isEqualTo(ExecStatus.NON_ZERO_EXIT);
        assertThat(thrown.stderr()).contains("boom");
    }

    @Test
    void theSandboxHasNoNetwork() throws Exception {
        Sandbox.Execution e = run(Language.NODE22, """
                require("net").connect(80, "1.1.1.1")
                  .on("error", (err) => { console.log("blocked " + err.code); })
                  .on("connect", () => { console.log("connected"); process.exit(0); });
                """, "");
        assertThat(e.stdout()).startsWith("blocked");
    }

    private static Sandbox.Execution run(Language language, String source, String stdin) throws Exception {
        try (Sandbox.Session s = sandbox.open(language, source, 256)) {
            Sandbox.Compilation c = s.compile();
            assertThat(c.ok()).as(c.output()).isTrue();
            return s.execute(stdin, 1000, 256);
        }
    }
}

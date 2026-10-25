package dev.voidrun.api.problems.importer;

import static org.assertj.core.api.Assertions.assertThat;

import org.jsoup.Jsoup;
import org.junit.jupiter.api.Test;

/** The two parsers against pages shaped like the real sites (made-up problems). */
class ParsersTest {

    static final String CODEFORCES = ParsersTestPages.CODEFORCES;

    static final String ATCODER = """
            <html><body>
            <span class="h2">B - Lucky Sum <a href="#">Editorial</a></span>
            <p>Time Limit: 2 sec / Memory Limit: 1024 MiB</p>
            <div id="task-statement"><span class="lang">
              <span class="lang-ja"><div class="part"><section><h3>問題文</h3><p>日本語</p></section></div></span>
              <span class="lang-en">
                <p>Score : <var>200</var> points</p>
                <div class="part"><section><h3>Problem Statement</h3><p>Given <var>N</var>, print <var>N+1</var>.</p></section></div>
                <div class="part"><section><h3>Constraints</h3><ul><li><var>1 \\leq N \\leq 10</var></li></ul></section></div>
                <div class="io-style">
                  <div class="part"><section><h3>Input</h3><p>Input is given as <var>N</var>.</p></section></div>
                  <div class="part"><section><h3>Output</h3><p>Print the answer.</p></section></div>
                </div>
                <div class="part"><section><h3>Sample Input 1</h3><pre>4
            </pre></section></div>
                <div class="part"><section><h3>Sample Output 1</h3><pre>5
            </pre></section></div>
              </span>
            </span></div>
            </body></html>""";

    @Test
    void readsACodeforcesProblem() {
        CodeforcesParser.Ref ref = CodeforcesParser.ref("/contest/1999/problem/a");
        assertThat(ref.id()).isEqualTo("1999A");
        ImportedProblem p = CodeforcesParser.parse(Jsoup.parse(CODEFORCES, "https://codeforces.com/"), ref);

        assertThat(p.title()).isEqualTo("Twin Piles");
        assertThat(p.slug()).isEqualTo("twin-piles");
        assertThat(p.timeLimitMs()).isEqualTo(2000);
        assertThat(p.memoryLimitMb()).isEqualTo(256);
        assertThat(p.difficulty()).isEqualTo("EASY");
        assertThat(p.tags()).containsExactly("brute-force", "math");
        assertThat(p.description())
                .startsWith("You have $n$ stones. Split them into **two** piles.")
                .contains("- Each pile is non-empty.")
                .contains("## Input\n\nOne integer $n$ ($1 \\le n \\le 100$).")
                .contains("## Output\n\nPrint YES or NO.")
                .contains("## Notes\n\nEight splits into four and four.")
                .doesNotContain("$$$");
        assertThat(p.samples()).extracting(ImportedProblem.Sample::input).containsExactly("8\n", "3\nx\n");
        assertThat(p.samples()).extracting(ImportedProblem.Sample::output).containsExactly("YES\n", "NO\n");
        assertThat(p.sourceUrl()).isEqualTo("https://codeforces.com/problemset/problem/1999/A");
        assertThat(p.warnings()).isEmpty();
    }

    @Test
    void aBotCheckPageIsNotAProblem() {
        assertThat(CodeforcesParser.parse(Jsoup.parse("<html><body>Just a moment...</body></html>"),
                CodeforcesParser.ref("/problemset/problem/4/A"))).isNull();
    }

    @Test
    void readsAnAtCoderTaskInEnglishAndClampsItsMemory() {
        AtCoderParser.Ref ref = AtCoderParser.ref("/contests/abc999/tasks/abc999_b");
        ImportedProblem p = AtCoderParser.parse(Jsoup.parse(ATCODER, "https://atcoder.jp/"), ref);

        assertThat(p.title()).isEqualTo("Lucky Sum");
        assertThat(p.timeLimitMs()).isEqualTo(2000);
        assertThat(p.memoryLimitMb()).isEqualTo(512);
        assertThat(p.warnings()).anyMatch(w -> w.contains("1024 MB"));
        assertThat(p.difficulty()).isEqualTo("EASY");
        assertThat(p.description())
                .startsWith("Given $N$, print $N+1$.")
                .contains("## Input")
                .contains("## Output")
                .doesNotContain("日本語")
                .doesNotContain("Sample");
        assertThat(p.constraints()).isEqualTo("- $1 \\leq N \\leq 10$");
        assertThat(p.samples()).containsExactly(new ImportedProblem.Sample("4\n", "5\n"));
        assertThat(p.sourceUrl()).isEqualTo("https://atcoder.jp/contests/abc999/tasks/abc999_b");
    }

    @Test
    void linksAreRecognisedOnlyInTheirKnownShapes() {
        assertThat(CodeforcesParser.ref("/problemset/problem/4/A")).isNotNull();
        assertThat(CodeforcesParser.ref("/gym/100001/problem/B").gym()).isTrue();
        assertThat(CodeforcesParser.ref("/blog/entry/1")).isNull();
        assertThat(AtCoderParser.ref("/contests/arc100/tasks/arc100_c")).isNotNull();
        assertThat(AtCoderParser.ref("/users/someone")).isNull();
    }

    @Test
    void limitsAreReadInTheirUsualWordings() {
        assertThat(Limits.timeMs("1 second")).isEqualTo(1000);
        assertThat(Limits.timeMs("2.5 seconds")).isEqualTo(2500);
        assertThat(Limits.timeMs("1500 ms")).isEqualTo(1500);
        assertThat(Limits.memoryMb("256 megabytes")).isEqualTo(256);
        assertThat(Limits.memoryMb("1024 MiB")).isEqualTo(1024);
        assertThat(Limits.tag("Brute Force")).isEqualTo("brute-force");
    }
}

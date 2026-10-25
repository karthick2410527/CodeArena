package dev.voidrun.api.problems.importer;

import static org.assertj.core.api.Assertions.assertThat;

import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.junit.jupiter.api.Test;

/** Editorials in the shapes the two sites use (made-up content). */
class EditorialParserTest {

    @Test
    void findsTheWrittenTutorialNotTheVideo() {
        Document page = Jsoup.parse("""
                <div class="roundbox"><a href="/blog/entry/111" title="Round 1">Announcement (en)</a>
                <a href="/blog/entry/333" title="Video Tutorial">Video Tutorial (en)</a>
                <a href="/blog/entry/222?locale=en" title="Round 1 Editorial">Tutorial #2 (en)</a></div>""",
                "https://codeforces.com/problemset/problem/1999/A");
        assertThat(EditorialParser.codeforcesTutorialLink(page)).isEqualTo("https://codeforces.com/blog/entry/222");
    }

    @Test
    void fillsATutorialThatLoadsLater() {
        Document blog = Jsoup.parse("""
                <div class="ttypography">
                  <p><a href="/contest/1999/problem/A">1999A - Twin Piles</a></p>
                  <div class="spoiler"><b class="spoiler-title">Tutorial</b><div class="spoiler-content">
                    <div class="problemTutorial" problemcode="1999A">Tutorial is loading...</div></div></div>
                  <p><a href="/contest/1999/problem/B">1999B - Next</a></p>
                </div>""", "https://codeforces.com/blog/entry/222");
        var section = EditorialParser.codeforcesSectionElement(blog, "1999", "A");
        var lazy = section.selectFirst(".problemTutorial");
        EditorialParser.fillTutorial(lazy, "<h3><a href='/contest/1999/problem/A'>1999A - Twin Piles</a></h3>"
                + "<div class=\"ttypography\"><p>Even $$$n$$$ splits evenly.</p></div>");
        assertThat(HtmlToMarkdown.convert(section))
                .contains("**Tutorial**")
                .contains("Even $n$ splits evenly.")
                .doesNotContain("loading")
                .doesNotContain("Twin Piles");
    }

    @Test
    void takesOnlyThisProblemsPartOfTheTutorialPost() {
        Document blog = Jsoup.parse("""
                <div class="ttypography">
                  <p>Thanks for participating!</p>
                  <p><a href="/contest/1999/problem/A">1999A - Twin Piles</a></p>
                  <p>Split $$$n$$$ in half when it is even.</p>
                  <div class="spoiler"><b class="spoiler-title">Code</b><div class="spoiler-content"><pre>print(n % 2 == 0)</pre></div></div>
                  <p><a href="/contest/1999/problem/B">1999B - Next One</a></p>
                  <p>Not this one.</p>
                </div>""", "https://codeforces.com/blog/entry/222");
        String md = EditorialParser.codeforcesSection(blog, "1999", "A");
        assertThat(md).startsWith("Split $n$ in half when it is even.")
                .contains("**Code**")
                .contains("```\nprint(n % 2 == 0)\n```")
                .doesNotContain("Not this one")
                .doesNotContain("Thanks for participating")
                .doesNotContain("Twin Piles");
        assertThat(EditorialParser.codeforcesSection(blog, "1999", "C")).isNull();
    }

    @Test
    void picksAtCodersOfficialEditorialAndReadsItsMath() {
        Document list = Jsoup.parse("""
                <ul><li><a href="/contests/abc999/editorial/50">Editorial</a> by fan</li>
                <li><span class="label">Official</span> <a href="/contests/abc999/editorial/42">Editorial</a> by admin</li>
                <li><a href="/contests/abc999/editorial">All editorials</a></li></ul>""", "https://atcoder.jp/");
        assertThat(EditorialParser.atcoderEditorialLink(list, "abc999"))
                .isEqualTo("https://atcoder.jp/contests/abc999/editorial/42");
        Document both = Jsoup.parse("""
                <ul><li>Official <a href="/contests/abc999/editorial/7">解説</a> by writer</li>
                <li>Official <a href="/contests/abc999/editorial/8">Editorial</a> by <a href="/users/en_translator">en_translator</a></li></ul>""",
                "https://atcoder.jp/");
        assertThat(EditorialParser.atcoderEditorialLink(both, "abc999")).isEqualTo("https://atcoder.jp/contests/abc999/editorial/8");

        Document page = Jsoup.parse("""
                <div id="main-container"><div id="editorial"><p>Print \\(N+1\\) for every \\(N\\).</p>
                <p>\\[ \\sum_{i=1}^{N} i \\]</p></div></div>""", "https://atcoder.jp/");
        String md = EditorialParser.atcoderEditorial(page);
        assertThat(md).startsWith("Print $N+1$ for every $N$.").contains("$$\\sum_{i=1}^{N} i$$");
        assertThat(EditorialParser.mostlyJapanese(md)).isFalse();
        assertThat(EditorialParser.mostlyJapanese("解説：入力を読み、出力します。")).isTrue();
    }

    @Test
    void readsTheWriteUpOnAnAtCoderEditorialPageWithoutTheNavigation() {
        Document page = Jsoup.parse("""
                <div id="main-container"><div class="row">
                  <div id="contest-nav-tabs" class="col-sm-12"><a href="/home">Back to Home</a></div>
                  <div class="col-sm-12">
                    <span class="label">Official</span><h2>A - Example Editorial</h2><hr>
                    <div><p>Check each \\(i\\) in order.</p><pre class="prettyprint">print(1)</pre></div>
                    <hr><p class="small">Posted by admin</p>
                  </div>
                </div></div>""", "https://atcoder.jp/");
        assertThat(EditorialParser.atcoderEditorial(page))
                .isEqualTo("Check each $i$ in order.\n\n```\nprint(1)\n```");
    }
}

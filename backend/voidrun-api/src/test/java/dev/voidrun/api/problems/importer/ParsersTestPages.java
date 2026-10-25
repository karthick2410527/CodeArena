package dev.voidrun.api.problems.importer;

/** A made-up problem in the shape of a Codeforces page, shared by the importer tests. */
public final class ParsersTestPages {

    private ParsersTestPages() {}

    public static final String CODEFORCES = """
            <html><body>
            <div class="problem-statement">
              <div class="header">
                <div class="title">A. Twin Piles</div>
                <div class="time-limit"><div class="property-title">time limit per test</div>2 seconds</div>
                <div class="memory-limit"><div class="property-title">memory limit per test</div>256 megabytes</div>
              </div>
              <div><p>You have $$$n$$$ stones. Split them into <span class="tex-font-style-bf">two</span> piles.</p>
                   <ul><li>Each pile is non-empty.</li><li>Piles are equal.</li></ul></div>
              <div class="input-specification"><div class="section-title">Input</div>
                   <p>One integer $$$n$$$ ($$$1 \\le n \\le 100$$$).</p></div>
              <div class="output-specification"><div class="section-title">Output</div><p>Print YES or NO.</p></div>
              <div class="sample-tests">
                <div class="sample-test">
                  <div class="input"><pre><div class="test-example-line">8</div></pre></div>
                  <div class="output"><pre>YES<br/></pre></div>
                  <div class="input"><pre><div class="test-example-line">3</div><div class="test-example-line">x</div></pre></div>
                  <div class="output"><pre>NO</pre></div>
                </div>
              </div>
              <div class="note"><div class="section-title">Note</div><p>Eight splits into four and four.</p></div>
            </div>
            <span class="tag-box">brute force</span><span class="tag-box">math</span><span class="tag-box">*800</span>
            </body></html>""";
}

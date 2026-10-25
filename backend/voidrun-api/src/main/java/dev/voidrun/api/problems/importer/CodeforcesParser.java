package dev.voidrun.api.problems.importer;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;

/** Reads a Codeforces problem page ({@code .problem-statement}). */
final class CodeforcesParser {

    /** /problemset/problem/4/A, /contest/4/problem/A, /gym/100001/problem/B */
    static final Pattern URL = Pattern.compile(
            "^/(?:problemset/problem/(\\d+)/([A-Za-z]\\d?)|(contest|gym)/(\\d+)/problem/([A-Za-z]\\d?))/?$");

    private CodeforcesParser() {}

    record Ref(String contestId, String index, boolean gym) {
        String id() {
            return contestId + index;
        }

        String pageUrl() {
            return gym ? "https://codeforces.com/gym/" + contestId + "/problem/" + index
                    : "https://codeforces.com/problemset/problem/" + contestId + "/" + index;
        }
    }

    static Ref ref(String path) {
        Matcher m = URL.matcher(path);
        if (!m.matches()) {
            return null;
        }
        return m.group(1) != null
                ? new Ref(m.group(1), m.group(2).toUpperCase(Locale.ROOT), false)
                : new Ref(m.group(4), m.group(5).toUpperCase(Locale.ROOT), m.group(3).equals("gym"));
    }

    /** @return null when the page has no statement (e.g. a bot check page instead) */
    static ImportedProblem parse(Document doc, Ref ref) {
        Element st = doc.selectFirst(".problem-statement");
        if (st == null) {
            return null;
        }
        List<String> warnings = new ArrayList<>();
        Element header = st.selectFirst(".header");
        String title = header == null ? "" : text(header.selectFirst(".title"));
        // "A. Watermelon" -> "Watermelon"
        title = title.replaceFirst("^[A-Za-z]\\d?\\.\\s*", "");
        int time = Limits.timeMs(valueOf(header, ".time-limit"));
        int memory = Limits.memoryMb(valueOf(header, ".memory-limit"));

        StringBuilder md = new StringBuilder();
        Element legend = null;
        for (Element child : st.children()) {
            if (child.classNames().isEmpty() && child.normalName().equals("div")) {
                legend = child;
                break;
            }
        }
        if (legend != null) {
            md.append(HtmlToMarkdown.convert(legend));
        } else {
            warnings.add("The statement text could not be found; write it in.");
        }
        section(md, "Input", st.selectFirst(".input-specification"));
        section(md, "Output", st.selectFirst(".output-specification"));
        section(md, "Interaction", st.selectFirst(".interaction-specification"));
        section(md, "Notes", st.selectFirst(".note"));

        List<ImportedProblem.Sample> samples = new ArrayList<>();
        Elements inputs = st.select(".sample-test .input pre");
        Elements outputs = st.select(".sample-test .output pre");
        for (int i = 0; i < Math.min(inputs.size(), outputs.size()); i++) {
            samples.add(new ImportedProblem.Sample(preText(inputs.get(i)), preText(outputs.get(i))));
        }
        if (samples.isEmpty()) {
            warnings.add("No sample tests were found.");
        }

        LinkedHashSet<String> tags = new LinkedHashSet<>();
        Integer rating = null;
        for (Element tagEl : doc.select(".tag-box")) {
            String t = tagEl.text().trim();
            if (t.startsWith("*") && t.substring(1).matches("\\d+")) {
                rating = Integer.parseInt(t.substring(1));
            } else {
                String clean = Limits.tag(t);
                if (clean != null && tags.size() < 10) {
                    tags.add(clean);
                }
            }
        }
        return new ImportedProblem("codeforces", ref.id(), ref.pageUrl(), Limits.slug(title), title,
                HtmlToMarkdown.tidy(md.toString()), "", difficulty(rating, ref.index()),
                Limits.clampTime(time, warnings), Limits.clampMemory(memory, warnings), List.copyOf(tags), samples,
                warnings);
    }

    /** Codeforces rating when known, else the problem's letter in its round. */
    static String difficulty(Integer rating, String index) {
        if (rating != null) {
            return rating <= 1300 ? "EASY" : rating <= 1900 ? "MEDIUM" : "HARD";
        }
        char c = index.isEmpty() ? 'A' : index.charAt(0);
        return c <= 'B' ? "EASY" : c <= 'D' ? "MEDIUM" : "HARD";
    }

    private static void section(StringBuilder md, String heading, Element el) {
        if (el == null) {
            return;
        }
        Element copy = el.clone();
        copy.select(".section-title").remove();
        String body = HtmlToMarkdown.convert(copy);
        if (!body.isBlank()) {
            md.append("\n\n## ").append(heading).append("\n\n").append(body);
        }
    }

    /** Sample text: newer pages split lines into div.test-example-line, older ones use br. */
    static String preText(Element pre) {
        Elements lines = pre.select("div.test-example-line");
        if (!lines.isEmpty()) {
            List<String> out = new ArrayList<>();
            for (Element l : lines) {
                out.add(l.wholeText());
            }
            return String.join("\n", out).strip() + "\n";
        }
        Element copy = pre.clone();
        copy.select("br").before("\n").remove();
        return copy.wholeText().strip() + "\n";
    }

    private static String valueOf(Element header, String selector) {
        if (header == null) {
            return "";
        }
        Element el = header.selectFirst(selector);
        if (el == null) {
            return "";
        }
        Element copy = el.clone();
        copy.select(".property-title").remove();
        return copy.text();
    }

    private static String text(Element el) {
        return el == null ? "" : el.text().trim();
    }
}

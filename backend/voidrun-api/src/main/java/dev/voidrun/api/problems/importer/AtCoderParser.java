package dev.voidrun.api.problems.importer;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;

/** Reads an AtCoder task page ({@code #task-statement}, English part). */
final class AtCoderParser {

    /** /contests/abc300/tasks/abc300_a */
    static final Pattern URL = Pattern.compile("^/contests/([a-z0-9_-]+)/tasks/([a-z0-9_]+)/?$");
    private static final Pattern LIMITS = Pattern.compile(
            "Time Limit:\\s*([0-9.]+\\s*\\w+)\\s*/\\s*Memory Limit:\\s*([0-9.]+\\s*\\w+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern SCORE = Pattern.compile("Score\\s*:?\\s*(\\d+)", Pattern.CASE_INSENSITIVE);

    private AtCoderParser() {}

    record Ref(String contest, String task) {
        String pageUrl() {
            return "https://atcoder.jp/contests/" + contest + "/tasks/" + task + "?lang=en";
        }

        String sourceUrl() {
            return "https://atcoder.jp/contests/" + contest + "/tasks/" + task;
        }
    }

    static Ref ref(String path) {
        Matcher m = URL.matcher(path);
        return m.matches() ? new Ref(m.group(1), m.group(2)) : null;
    }

    static ImportedProblem parse(Document doc, Ref ref) {
        Element statement = doc.selectFirst("#task-statement");
        if (statement == null) {
            return null;
        }
        Element en = statement.selectFirst("span.lang-en");
        Element body = en != null ? en : statement;
        List<String> warnings = new ArrayList<>();

        String title = "";
        Element h = doc.selectFirst("span.h2");
        if (h != null) {
            Element copy = h.clone();
            copy.select("a, span").remove();
            // "A - Welcome" -> "Welcome"
            title = copy.text().trim().replaceFirst("^[A-Za-z]\\w*\\s*-\\s*", "");
        }
        int time = 0;
        int memory = 0;
        Matcher lm = LIMITS.matcher(doc.text());
        if (lm.find()) {
            time = Limits.timeMs(lm.group(1));
            memory = Limits.memoryMb(lm.group(2));
        }
        Integer score = null;
        Matcher sm = SCORE.matcher(body.text());
        if (sm.find()) {
            score = Integer.parseInt(sm.group(1));
        }

        StringBuilder md = new StringBuilder();
        String constraints = "";
        List<String> sampleIn = new ArrayList<>();
        List<String> sampleOut = new ArrayList<>();
        for (Element section : body.select("div.part > section")) {
            Element heading = section.selectFirst("h3");
            if (heading == null) {
                continue;
            }
            String name = heading.text().trim();
            String lower = name.toLowerCase(Locale.ROOT);
            Element copy = section.clone();
            copy.select("h3").first().remove();
            if (lower.startsWith("sample input")) {
                Element pre = copy.selectFirst("pre");
                sampleIn.add(pre == null ? "" : pre.wholeText().strip() + "\n");
            } else if (lower.startsWith("sample output")) {
                Element pre = copy.selectFirst("pre");
                sampleOut.add(pre == null ? "" : pre.wholeText().strip() + "\n");
            } else if (lower.equals("constraints")) {
                constraints = HtmlToMarkdown.convert(copy);
            } else if (lower.equals("problem statement")) {
                md.append(HtmlToMarkdown.convert(copy));
            } else {
                md.append("\n\n## ").append(name).append("\n\n").append(HtmlToMarkdown.convert(copy));
            }
        }
        if (md.isEmpty()) {
            warnings.add("The statement text could not be found; write it in.");
        }
        List<ImportedProblem.Sample> samples = new ArrayList<>();
        for (int i = 0; i < Math.min(sampleIn.size(), sampleOut.size()); i++) {
            samples.add(new ImportedProblem.Sample(sampleIn.get(i), sampleOut.get(i)));
        }
        if (samples.isEmpty()) {
            warnings.add("No sample tests were found.");
        }
        if (title.isEmpty()) {
            title = ref.task();
            warnings.add("The title could not be read.");
        }
        String difficulty = score == null ? "MEDIUM" : score <= 200 ? "EASY" : score <= 400 ? "MEDIUM" : "HARD";
        return new ImportedProblem("atcoder", ref.task(), ref.sourceUrl(), Limits.slug(title), title,
                HtmlToMarkdown.tidy(md.toString()), constraints, difficulty, Limits.clampTime(time, warnings),
                Limits.clampMemory(memory, warnings), List.of(), samples, warnings);
    }
}

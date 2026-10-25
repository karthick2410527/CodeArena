package dev.voidrun.api.problems.importer;

import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;

/** Finds and reads editorials: Codeforces tutorial blog posts and AtCoder editorial pages. */
final class EditorialParser {

    private static final Pattern CF_PROBLEM_LINK = Pattern.compile(
            "/(?:contest/(\\d+)/problem|problemset/problem/(\\d+))/([A-Za-z]\\d?)(?:[/?#].*)?$");

    private EditorialParser() {}

    /**
     * The written tutorial among a Codeforces problem page's contest materials:
     * one titled "Editorial" first, else one called "Tutorial", never the video
     * or the discussion stream.
     */
    static String codeforcesTutorialLink(Document problemPage) {
        String tutorial = null;
        for (Element a : problemPage.select("a[href*=/blog/entry/]")) {
            String t = (a.text() + " " + a.attr("title")).toLowerCase(Locale.ROOT);
            if (t.contains("video") || t.contains("stream")) {
                continue;
            }
            String url = a.absUrl("href").replaceFirst("\\?.*$", "");
            if (a.attr("title").toLowerCase(Locale.ROOT).contains("editorial")) {
                return url;
            }
            if (tutorial == null && (t.contains("tutorial") || t.contains("editorial") || t.contains("разбор"))) {
                tutorial = url;
            }
        }
        return tutorial;
    }

    /**
     * One problem's part of a Codeforces tutorial post: from the block that
     * links to the problem up to the block that links to the next problem of
     * the same round. Null when the post never links to it.
     */
    static String codeforcesSection(Document blog, String contestId, String index) {
        Element section = codeforcesSectionElement(blog, contestId, index);
        return section == null ? null : HtmlToMarkdown.convert(section);
    }

    /** As {@link #codeforcesSection}, before conversion, so lazily loaded tutorials can be filled in first. */
    static Element codeforcesSectionElement(Document blog, String contestId, String index) {
        Element body = blog.selectFirst(".ttypography");
        if (body == null) {
            return null;
        }
        List<Element> blocks = body.children();
        int start = -1;
        for (int i = 0; i < blocks.size() && start < 0; i++) {
            if (linksTo(blocks.get(i), contestId, index) == Link.THIS) {
                start = i;
            }
        }
        if (start < 0) {
            return null;
        }
        Element section = new Element("div");
        for (int i = start; i < blocks.size(); i++) {
            Element b = blocks.get(i);
            if (i > start && linksTo(b, contestId, index) == Link.OTHER) {
                break;
            }
            section.appendChild(b.clone());
        }
        // The heading line that names the problem is already the problem's own title.
        Element first = section.child(0);
        if (first.text().length() < 120 && first.select("a").size() == 1) {
            first.remove();
        }
        return section;
    }

    /** Puts a lazily loaded tutorial's HTML (the JSON {@code html} field) in place of its placeholder. */
    static void fillTutorial(Element placeholder, String html) {
        Element loaded = org.jsoup.Jsoup.parseBodyFragment(html).body();
        // It repeats the problem's name as a heading; the problem already has one.
        loaded.select("h3:has(a[href*=/problem/])").remove();
        placeholder.empty();
        placeholder.appendChildren(loaded.childNodesCopy());
    }

    private enum Link { NONE, THIS, OTHER }

    private static Link linksTo(Element block, String contestId, String index) {
        Link found = Link.NONE;
        for (Element a : block.select("a[href]")) {
            Matcher m = CF_PROBLEM_LINK.matcher(a.attr("href"));
            if (!m.find()) {
                continue;
            }
            String contest = m.group(1) != null ? m.group(1) : m.group(2);
            if (!contest.equals(contestId)) {
                continue;
            }
            if (m.group(3).equalsIgnoreCase(index)) {
                return Link.THIS;
            }
            found = Link.OTHER;
        }
        return found;
    }

    /**
     * The best editorial on an AtCoder task's editorial list: an official one in
     * English (the "Editorial" by en_translator), else any official one, else
     * any in English, else the first.
     */
    static String atcoderEditorialLink(Document list, String contest) {
        String prefix = "/contests/" + contest + "/editorial/";
        String best = null;
        int bestScore = -1;
        for (Element a : list.select("a[href^=" + prefix + "]")) {
            if (!a.attr("href").substring(prefix.length()).matches("\\d+")) {
                continue;
            }
            Element li = a.closest("li");
            String row = li == null ? "" : li.text().toLowerCase(Locale.ROOT);
            boolean official = row.contains("official");
            boolean english = a.text().trim().equalsIgnoreCase("editorial") || row.contains("en_translator");
            int score = (official ? 2 : 0) + (english ? 1 : 0);
            if (score > bestScore) {
                best = a.absUrl("href");
                bestScore = score;
            }
        }
        return best;
    }

    /** The write-up on an AtCoder editorial page. */
    static String atcoderEditorial(Document page) {
        Element body = page.selectFirst("#editorial");
        if (body == null) {
            // The column with the editorial's title: label, h2, hr, then the write-up's div.
            Element column = page.selectFirst("#main-container div.col-sm-12:has(> h2)");
            if (column == null) {
                return null;
            }
            boolean pastTitle = false;
            for (Element child : column.children()) {
                if (child.normalName().equals("h2")) {
                    pastTitle = true;
                } else if (pastTitle && child.normalName().equals("div")) {
                    body = child;
                    break;
                }
            }
            if (body == null) {
                return null;
            }
        }
        return HtmlToMarkdown.convert(body);
    }

    /** True when most letters are Japanese, so the author knows to translate. */
    static boolean mostlyJapanese(String text) {
        long ja = text.codePoints().filter(c -> (c >= 0x3040 && c <= 0x30ff) || (c >= 0x4e00 && c <= 0x9fff)).count();
        long latin = text.codePoints().filter(c -> (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')).count();
        return ja > latin;
    }
}

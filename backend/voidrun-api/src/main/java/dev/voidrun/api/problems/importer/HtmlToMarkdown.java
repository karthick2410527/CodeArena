package dev.voidrun.api.problems.importer;

import java.util.regex.Pattern;
import org.jsoup.nodes.Element;
import org.jsoup.nodes.Node;
import org.jsoup.nodes.TextNode;

/**
 * Turns a problem statement's HTML into the Markdown the editor and the problem
 * page use: paragraphs, lists, bold and italics, code, images and links, and
 * TeX kept as {@code $...$} (Codeforces writes {@code $$$...$$$}; AtCoder uses
 * {@code <var>}).
 */
final class HtmlToMarkdown {

    private static final Pattern CF_DISPLAY_MATH = Pattern.compile("\\$\\$\\$\\$\\$\\$(.+?)\\$\\$\\$\\$\\$\\$", Pattern.DOTALL);
    private static final Pattern CF_INLINE_MATH = Pattern.compile("\\$\\$\\$(.+?)\\$\\$\\$", Pattern.DOTALL);
    private static final Pattern BLANK_LINES = Pattern.compile("\\n{3,}");
    // MathJax delimiters AtCoder editorials use: \( inline \) and \[ display \].
    private static final Pattern PAREN_MATH = Pattern.compile("\\\\\\((.+?)\\\\\\)", Pattern.DOTALL);
    private static final Pattern BRACKET_MATH = Pattern.compile("\\\\\\[(.+?)\\\\\\]", Pattern.DOTALL);

    private HtmlToMarkdown() {}

    /** The Markdown of {@code el}'s children. */
    static String convert(Element el) {
        StringBuilder out = new StringBuilder();
        children(el, out);
        return tidy(out.toString());
    }

    static String tidy(String md) {
        String s = CF_DISPLAY_MATH.matcher(md).replaceAll(m -> "\n\n\\$\\$" + quote(m.group(1).trim()) + "\\$\\$\n\n");
        s = CF_INLINE_MATH.matcher(s).replaceAll(m -> "\\$" + quote(m.group(1).trim()) + "\\$");
        s = BRACKET_MATH.matcher(s).replaceAll(m -> "\n\n\\$\\$" + quote(m.group(1).trim()) + "\\$\\$\n\n");
        s = PAREN_MATH.matcher(s).replaceAll(m -> "\\$" + quote(m.group(1).trim()) + "\\$");
        s = s.replace(' ', ' ').replaceAll("[ \\t]+\\n", "\n");
        return BLANK_LINES.matcher(s).replaceAll("\n\n").trim();
    }

    private static String quote(String s) {
        return s.replace("\\", "\\\\").replace("$", "\\$");
    }

    private static void children(Node parent, StringBuilder out) {
        for (Node n : parent.childNodes()) {
            node(n, out);
        }
    }

    private static void node(Node n, StringBuilder out) {
        if (n instanceof TextNode t) {
            out.append(t.getWholeText().replaceAll("\\s+", " "));
            return;
        }
        if (!(n instanceof Element e)) {
            return;
        }
        String cls = e.className();
        switch (e.normalName()) {
            case "p", "div", "section", "center" -> block(e, out);
            case "br" -> out.append("  \n");
            case "b", "strong" -> wrap(e, "**", out);
            case "i", "em" -> wrap(e, "*", out);
            case "code", "tt", "kbd" -> out.append('`').append(e.text()).append('`');
            case "var" -> out.append('$').append(e.text().trim()).append('$');
            case "pre" -> out.append("\n\n```\n").append(e.wholeText().strip()).append("\n```\n\n");
            case "ul" -> list(e, out, false);
            case "ol" -> list(e, out, true);
            case "h1", "h2", "h3", "h4", "h5" -> out.append("\n\n### ").append(e.text().trim()).append("\n\n");
            case "img" -> {
                String src = e.absUrl("src");
                if (!src.isEmpty()) {
                    out.append("![").append(e.attr("alt")).append("](").append(src).append(')');
                }
            }
            case "a" -> {
                String href = e.absUrl("href");
                String text = convertInline(e);
                out.append(href.isEmpty() ? text : "[" + text + "](" + href + ")");
            }
            case "table" -> table(e, out);
            case "script", "style" -> { }
            case "span" -> {
                if (cls.contains("tex-font-style-bf")) {
                    wrap(e, "**", out);
                } else if (cls.contains("tex-font-style-it")) {
                    wrap(e, "*", out);
                } else if (cls.contains("tex-font-style-tt")) {
                    out.append('`').append(e.text()).append('`');
                } else {
                    children(e, out);
                }
            }
            default -> children(e, out);
        }
    }

    private static String convertInline(Element e) {
        StringBuilder b = new StringBuilder();
        children(e, b);
        return b.toString().trim();
    }

    private static void block(Element e, StringBuilder out) {
        out.append("\n\n");
        children(e, out);
        out.append("\n\n");
    }

    private static void wrap(Element e, String mark, StringBuilder out) {
        String inner = convertInline(e);
        if (!inner.isEmpty()) {
            out.append(mark).append(inner).append(mark);
        }
    }

    private static void list(Element e, StringBuilder out, boolean ordered) {
        out.append("\n\n");
        int i = 1;
        for (Element li : e.children()) {
            if (!li.normalName().equals("li")) {
                continue;
            }
            String item = tidy(convertInline(li)).replace("\n", "\n   ");
            out.append(ordered ? (i++ + ". ") : "- ").append(item).append('\n');
        }
        out.append('\n');
    }

    private static void table(Element e, StringBuilder out) {
        out.append("\n\n");
        boolean first = true;
        for (Element tr : e.select("tr")) {
            StringBuilder row = new StringBuilder("|");
            int cells = 0;
            for (Element cell : tr.children()) {
                row.append(' ').append(convertInline(cell).replace("|", "\\|")).append(" |");
                cells++;
            }
            out.append(row).append('\n');
            if (first) {
                out.append("|").append(" --- |".repeat(Math.max(1, cells))).append('\n');
                first = false;
            }
        }
        out.append('\n');
    }
}

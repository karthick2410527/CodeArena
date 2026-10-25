package dev.voidrun.api.problems.importer;

import dev.voidrun.api.web.ApiException;
import java.io.IOException;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Reads a Codeforces or AtCoder problem link into an {@link ImportedProblem}. */
@Service
public class ProblemImporter {

    private static final Logger log = LoggerFactory.getLogger(ProblemImporter.class);

    private final PageFetcher fetcher;
    private final JsonMapper json;

    public ProblemImporter(PageFetcher fetcher, JsonMapper json) {
        this.fetcher = fetcher;
        this.json = json;
    }

    public ImportedProblem importFrom(String link) {
        URI uri;
        try {
            uri = URI.create(link == null ? "" : link.trim());
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest("that is not a link");
        }
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
        String path = uri.getPath() == null ? "" : uri.getPath();
        if (host.endsWith("codeforces.com")) {
            CodeforcesParser.Ref ref = CodeforcesParser.ref(path);
            if (ref == null) {
                throw ApiException.badRequest(
                        "use a Codeforces problem link, e.g. https://codeforces.com/problemset/problem/4/A");
            }
            return codeforces(ref);
        }
        if (host.equals("atcoder.jp")) {
            AtCoderParser.Ref ref = AtCoderParser.ref(path);
            if (ref == null) {
                throw ApiException.badRequest(
                        "use an AtCoder task link, e.g. https://atcoder.jp/contests/abc300/tasks/abc300_a");
            }
            try {
                ImportedProblem p = AtCoderParser.parse(fetcher.html(ref.pageUrl()), ref);
                if (p == null) {
                    throw ApiException.badGateway("AtCoder's page had no problem statement; check the link");
                }
                return p;
            } catch (IOException e) {
                log.info("atcoder import failed for {}: {}", ref.sourceUrl(), e.getMessage());
                throw ApiException.badGateway("couldn't reach AtCoder (" + e.getMessage() + "); try again in a minute");
            }
        }
        throw ApiException.badRequest("only Codeforces and AtCoder links can be imported");
    }

    /**
     * The editorial for a Codeforces or AtCoder problem link: Codeforces's
     * tutorial post (this problem's part of it), or AtCoder's official editorial.
     */
    public ImportedEditorial editorialFor(String link) {
        URI uri;
        try {
            uri = URI.create(link == null ? "" : link.trim());
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest("that is not a link");
        }
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
        String path = uri.getPath() == null ? "" : uri.getPath();
        List<String> warnings = new ArrayList<>();
        try {
            if (host.endsWith("codeforces.com")) {
                CodeforcesParser.Ref ref = CodeforcesParser.ref(path);
                if (ref == null) {
                    throw ApiException.badRequest("use a Codeforces problem link");
                }
                String tutorial = EditorialParser.codeforcesTutorialLink(fetcher.html(ref.pageUrl()));
                if (tutorial == null) {
                    throw ApiException.notFound("this Codeforces problem has no tutorial linked");
                }
                PageFetcher.BlogPage blog = fetcher.codeforcesBlog(tutorial);
                org.jsoup.nodes.Element section =
                        EditorialParser.codeforcesSectionElement(blog.doc(), ref.contestId(), ref.index());
                if (section != null) {
                    for (org.jsoup.nodes.Element lazy : section.select(".problemTutorial[problemcode]")) {
                        String body = fetcher.codeforcesTutorial(blog, lazy.attr("problemcode"));
                        String html = body == null ? null : json.readTree(body).path("html").asString(null);
                        if (html != null) {
                            EditorialParser.fillTutorial(lazy, html);
                        } else {
                            lazy.remove();
                            warnings.add("Part of the tutorial loads only in a browser; open the link to copy it.");
                        }
                    }
                }
                String text = section == null ? null : HtmlToMarkdown.convert(section);
                if (text == null || text.isBlank()) {
                    warnings.add("The tutorial doesn't mark where this problem's part starts; it is linked instead.");
                    text = "";
                }
                return new ImportedEditorial(text, tutorial, warnings);
            }
            if (host.equals("atcoder.jp")) {
                AtCoderParser.Ref ref = AtCoderParser.ref(path);
                if (ref == null) {
                    throw ApiException.badRequest("use an AtCoder task link");
                }
                String list = ref.sourceUrl() + "/editorial?editorialLang=en";
                String url = EditorialParser.atcoderEditorialLink(fetcher.html(list), ref.contest());
                if (url == null) {
                    // Not every task has an English write-up.
                    url = EditorialParser.atcoderEditorialLink(fetcher.html(ref.sourceUrl() + "/editorial"), ref.contest());
                }
                if (url == null) {
                    throw ApiException.notFound("this AtCoder task has no editorial yet");
                }
                String text = EditorialParser.atcoderEditorial(fetcher.html(url + "?lang=en"));
                if (text == null || text.isBlank()) {
                    warnings.add("The editorial page couldn't be read; it is linked instead.");
                    text = "";
                } else if (EditorialParser.mostlyJapanese(text)) {
                    warnings.add("This editorial is only in Japanese; translate it before you publish.");
                }
                return new ImportedEditorial(text, url, warnings);
            }
        } catch (IOException e) {
            log.info("editorial import failed for {}: {}", link, e.getMessage());
            throw ApiException.badGateway("couldn't read the editorial (" + e.getMessage() + "); try again in a minute");
        }
        throw ApiException.badRequest("only Codeforces and AtCoder editorials can be imported");
    }

    /**
     * The problem page when Codeforces serves it; it sometimes answers automated
     * requests with a bot check instead, and then the public API still gives the
     * name, rating and tags.
     */
    private ImportedProblem codeforces(CodeforcesParser.Ref ref) {
        String why;
        try {
            ImportedProblem p = CodeforcesParser.parse(fetcher.html(ref.pageUrl()), ref);
            if (p != null) {
                return p;
            }
            why = "Codeforces showed a check page instead of the problem";
        } catch (IOException e) {
            why = "Codeforces didn't serve the page (" + e.getMessage() + ")";
        }
        log.info("codeforces page import failed for {}: {}; trying the API", ref.id(), why);
        if (ref.gym()) {
            throw ApiException.badGateway(why + ". Gym problems can't be read through the API; try again later.");
        }
        try {
            JsonNode root = json.readTree(fetcher.json(
                    "https://codeforces.com/api/contest.standings?contestId=" + ref.contestId() + "&from=1&count=1"));
            for (JsonNode p : root.path("result").path("problems")) {
                if (!ref.index().equalsIgnoreCase(p.path("index").asString(""))) {
                    continue;
                }
                String name = p.path("name").asString(ref.id());
                Integer rating = p.has("rating") ? p.path("rating").asInt() : null;
                List<String> tags = new ArrayList<>();
                for (JsonNode t : p.path("tags")) {
                    String clean = Limits.tag(t.asString(""));
                    if (clean != null && tags.size() < 10) {
                        tags.add(clean);
                    }
                }
                List<String> warnings = new ArrayList<>(List.of(
                        why + ", so only the name, rating and tags were imported: write the statement, limits"
                                + " and samples."));
                return new ImportedProblem("codeforces", ref.id(), ref.pageUrl(), Limits.slug(name), name, "", "",
                        CodeforcesParser.difficulty(rating, ref.index()), 1000, 256, tags, List.of(), warnings);
            }
            throw ApiException.badRequest("Codeforces has no problem " + ref.id());
        } catch (IOException e) {
            throw ApiException.badGateway(why + ", and its API is unreachable too; try again in a minute");
        }
    }
}

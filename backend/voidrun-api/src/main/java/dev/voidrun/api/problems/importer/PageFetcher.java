package dev.voidrun.api.problems.importer;

import java.io.IOException;
import java.util.Set;
import org.jsoup.Connection;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.springframework.stereotype.Component;

/**
 * Downloads pages from the judges we import from, and nowhere else: redirects
 * are followed by hand and only to those same hosts, so a link can never make
 * the server fetch an internal address.
 */
@Component
public class PageFetcher {

    static final Set<String> HOSTS = Set.of("codeforces.com", "www.codeforces.com", "m1.codeforces.com",
            "m2.codeforces.com", "m3.codeforces.com", "atcoder.jp");
    private static final String AGENT = "VoidRun problem importer (+https://github.com/voidrun; contact the site admin)";

    public Document html(String url) throws IOException {
        return Jsoup.parse(fetch(url, "text/html").body(), url);
    }

    public String json(String url) throws IOException {
        return fetch(url, "application/json").body();
    }

    /** A Codeforces blog post, and the session that can ask it for the tutorials it loads lazily. */
    public record BlogPage(Document doc, java.util.Map<String, String> cookies, String csrf) {}

    public BlogPage codeforcesBlog(String url) throws IOException {
        Connection.Response res = fetch(url, "text/html");
        Document doc = Jsoup.parse(res.body(), url);
        org.jsoup.nodes.Element meta = doc.selectFirst("meta[name=X-Csrf-Token]");
        return new BlogPage(doc, res.cookies(), meta == null ? null : meta.attr("content"));
    }

    /**
     * The HTML of one problem's tutorial in a blog post that shows "Tutorial is
     * loading…": Codeforces serves it from /data/problemTutorial to the same
     * session. Null when it won't.
     */
    public String codeforcesTutorial(BlogPage blog, String problemCode) throws IOException {
        if (blog.csrf() == null) {
            return null;
        }
        Connection.Response res = Jsoup.connect("https://codeforces.com/data/problemTutorial")
                .userAgent(AGENT)
                .cookies(blog.cookies())
                .header("X-Csrf-Token", blog.csrf())
                .header("X-Requested-With", "XMLHttpRequest")
                .data("problemCode", problemCode)
                .data("csrf_token", blog.csrf())
                .method(Connection.Method.POST)
                .timeout(10_000)
                .maxBodySize(3 * 1024 * 1024)
                .followRedirects(false)
                .ignoreHttpErrors(true)
                .ignoreContentType(true)
                .execute();
        return res.statusCode() == 200 ? res.body() : null;
    }

    private Connection.Response fetch(String url, String accept) throws IOException {
        String next = url;
        for (int hop = 0; hop < 4; hop++) {
            String host = java.net.URI.create(next).getHost();
            if (!next.startsWith("https://") || host == null || !HOSTS.contains(host.toLowerCase())) {
                throw new IOException("refusing to fetch " + next);
            }
            Connection.Response res = Jsoup.connect(next)
                    .userAgent(AGENT)
                    .header("Accept", accept)
                    .header("Accept-Language", "en")
                    .timeout(10_000)
                    .maxBodySize(3 * 1024 * 1024)
                    .followRedirects(false)
                    .ignoreHttpErrors(true)
                    .ignoreContentType(true)
                    .execute();
            int code = res.statusCode();
            if (code >= 300 && code < 400 && res.hasHeader("Location")) {
                next = java.net.URI.create(next).resolve(res.header("Location")).toString();
                continue;
            }
            if (code != 200) {
                throw new IOException(host + " answered " + code);
            }
            return res;
        }
        throw new IOException("too many redirects");
    }
}

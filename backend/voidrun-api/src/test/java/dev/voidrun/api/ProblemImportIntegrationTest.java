package dev.voidrun.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import dev.voidrun.api.problems.importer.PageFetcher;
import java.io.IOException;
import org.hamcrest.Matchers;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/** Import from a link, against canned pages instead of the real sites. */
class ProblemImportIntegrationTest extends ApiTestSupport {

    @TestConfiguration
    static class CannedPages {
        @Bean
        @Primary
        PageFetcher cannedFetcher() {
            return new PageFetcher() {
                @Override
                public Document html(String url) throws IOException {
                    if (url.contains("/problemset/problem/1999/A")) {
                        return Jsoup.parse(dev.voidrun.api.problems.importer.ParsersTestPages.CODEFORCES, url);
                    }
                    if (url.contains("/problemset/problem/4/A")) {
                        return Jsoup.parse("<html><body>Just a moment...</body></html>", url);
                    }
                    throw new IOException("unexpected " + url);
                }

                @Override
                public String json(String url) throws IOException {
                    if (url.contains("contestId=4&")) {
                        return """
                                {"status":"OK","result":{"problems":[
                                  {"index":"A","name":"Melon Split","rating":800,"tags":["brute force","math"]}]}}""";
                    }
                    throw new IOException("unexpected " + url);
                }
            };
        }
    }

    @Test
    void importsAPageAndFallsBackToTheApiBehindABotCheck() throws Exception {
        TestUser author = register();
        String body = mvc.perform(json(post("/api/v1/studio/problems/import"),
                        "{\"url\":\"https://codeforces.com/contest/1999/problem/A\"}")
                        .header("Authorization", author.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.platform").value("codeforces"))
                .andExpect(jsonPath("$.title").value("Twin Piles"))
                .andExpect(jsonPath("$.time_limit_ms").value(2000))
                .andExpect(jsonPath("$.samples.length()").value(2))
                .andExpect(jsonPath("$.source_url").value("https://codeforces.com/problemset/problem/1999/A"))
                .andReturn().getResponse().getContentAsString();

        mvc.perform(json(post("/api/v1/studio/problems/import"), "{\"url\":\"https://codeforces.com/problemset/problem/4/A\"}")
                        .header("Authorization", author.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("Melon Split"))
                .andExpect(jsonPath("$.description").value(""))
                .andExpect(jsonPath("$.tags[0]").value("brute-force"))
                .andExpect(jsonPath("$.warnings[0]").value(Matchers.containsString("only the name, rating and tags")));

        // The imported link is kept as the problem's source.
        String id = JsonPath.read(mvc.perform(json(post("/api/v1/studio/problems"), """
                        {"slug":"%s","title":"Twin Piles","description":"Rewritten.","difficulty":"EASY",
                         "time_limit_ms":2000,"memory_limit_mb":256,"source_url":"%s"}"""
                        .formatted(unique("twin"), JsonPath.read(body, "$.source_url")))
                        .header("Authorization", author.bearer()))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString(), "$.id");
        mvc.perform(get("/api/v1/studio/problems/" + id).header("Authorization", author.bearer()))
                .andExpect(jsonPath("$.source_url").value("https://codeforces.com/problemset/problem/1999/A"));
    }

    @Test
    void refusesOtherSitesAndUnknownShapes() throws Exception {
        TestUser author = register();
        for (String url : new String[] {"https://example.com/problem/1", "http://localhost:8080/api",
                "https://codeforces.com/blog/entry/1", "not a link"}) {
            mvc.perform(json(post("/api/v1/studio/problems/import"), "{\"url\":\"" + url + "\"}")
                            .header("Authorization", author.bearer()))
                    .andExpect(status().isBadRequest());
        }
        mvc.perform(json(post("/api/v1/studio/problems"), """
                        {"slug":"%s","title":"X","description":"Y","difficulty":"EASY","time_limit_ms":1000,
                         "memory_limit_mb":256,"source_url":"javascript:alert(1)"}""".formatted(unique("x")))
                        .header("Authorization", author.bearer()))
                .andExpect(status().isBadRequest());
    }
}

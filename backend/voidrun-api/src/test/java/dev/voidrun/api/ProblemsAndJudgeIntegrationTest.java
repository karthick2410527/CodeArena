package dev.voidrun.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import java.util.Map;
import java.util.UUID;
import org.hamcrest.Matchers;
import org.junit.jupiter.api.Test;

class ProblemsAndJudgeIntegrationTest extends ApiTestSupport {

    private static final String CPP = "#include <bits/stdc++.h>\\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;}";

    @Test
    void seededProblemSetIsPaginatedAndFilterable() throws Exception {
        mvc.perform(get("/api/v1/problems").param("limit", "5"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(5))
                .andExpect(jsonPath("$.page").value(1))
                .andExpect(jsonPath("$.limit").value(5))
                .andExpect(jsonPath("$.total").value(Matchers.greaterThan(5)))
                .andExpect(jsonPath("$.items[0].slug").value("a-plus-b"))
                .andExpect(jsonPath("$.items[0].time_limit_ms").isNumber());
        mvc.perform(get("/api/v1/problems").param("difficulty", "hard"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[*].difficulty").value(Matchers.everyItem(Matchers.is("HARD"))));
        mvc.perform(get("/api/v1/problems").param("q", "plus"))
                .andExpect(jsonPath("$.items[0].slug").value("a-plus-b"));
        mvc.perform(get("/api/v1/problems").param("limit", "51")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/problems").param("difficulty", "IMPOSSIBLE")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/tags"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].name").isString())
                .andExpect(jsonPath("$[0].count").isNumber());
    }

    @Test
    void problemDetailShowsSamplesButNeverHiddenTests() throws Exception {
        String body = mvc.perform(get("/api/v1/problems/a-plus-b"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("A Plus B"))
                .andExpect(jsonPath("$.samples.length()").value(Matchers.greaterThan(0)))
                .andReturn().getResponse().getContentAsString();
        long samples = jdbc.sql("SELECT count(*) FROM test_cases tc JOIN problems p ON p.id = tc.problem_id"
                + " WHERE p.slug = 'a-plus-b' AND tc.is_sample").query(Long.class).single();
        assertThat((Integer) JsonPath.read(body, "$.samples.length()")).isEqualTo((int) samples);
        mvc.perform(get("/api/v1/problems/does-not-exist")).andExpect(status().isNotFound());
    }

    @Test
    void healthAndReadiness() throws Exception {
        mvc.perform(get("/api/v1/health")).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ok"));
        mvc.perform(get("/api/v1/ready"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ready"))
                .andExpect(jsonPath("$.database").value(true))
                .andExpect(jsonPath("$.redis").value(true));
    }

    @Test
    void editorMetadata() throws Exception {
        mvc.perform(get("/api/v1/languages"))
                .andExpect(jsonPath("$[*].id").value(Matchers.contains("cpp17", "java21", "node22")))
                .andExpect(jsonPath("$[0].monaco_id").value("cpp"))
                .andExpect(jsonPath("$[0].starter_code").value(Matchers.containsString("bits/stdc++.h")));
        mvc.perform(get("/api/v1/limits")).andExpect(jsonPath("$.max_source_bytes").value(65536));
    }

    @Test
    void submissionAndItsOutboxEventCommitTogether() throws Exception {
        TestUser u = register();
        String body = mvc.perform(json(post("/api/v1/submissions"),
                        "{\"problem_id\":\"a-plus-b\",\"language\":\"cpp17\",\"source_code\":\"%s\"}".formatted(CPP))
                        .header("Authorization", u.bearer()))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.status").value("QUEUED"))
                .andReturn().getResponse().getContentAsString();
        UUID id = UUID.fromString(JsonPath.read(body, "$.submission_id"));

        Map<String, Object> event = jdbc.sql("""
                        SELECT topic, message_key, event_type, payload::text AS payload
                        FROM outbox_events WHERE aggregate_id = ?""")
                .param(id).query().singleRow();
        assertThat(event).containsEntry("topic", "voidrun.submissions")
                .containsEntry("message_key", id.toString())
                .containsEntry("event_type", "submission.created");
        // published_at is the relay's to set, moments later; ReplayIntegrationTest follows an event to Kafka.
        assertThat((String) event.get("payload")).contains("\"kind\": \"SUBMISSION\"", "\"id\": \"" + id + "\"",
                "\"version\": 1", "\"correlationId\"");

        mvc.perform(get("/api/v1/submissions/" + id).header("Authorization", u.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("QUEUED"))
                .andExpect(jsonPath("$.verdict").value(Matchers.nullValue()))
                .andExpect(jsonPath("$.username").value(u.username()))
                .andExpect(jsonPath("$.source_code").value(Matchers.containsString("cin")));
        mvc.perform(get("/api/v1/submissions").header("Authorization", u.bearer()))
                .andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.items[0].problem_slug").value("a-plus-b"));
        mvc.perform(get("/api/v1/submissions/" + id + "/test-results").header("Authorization", u.bearer()))
                .andExpect(jsonPath("$.results.length()").value(0));

        TestUser stranger = register();
        mvc.perform(get("/api/v1/submissions/" + id).header("Authorization", stranger.bearer()))
                .andExpect(status().isNotFound());
        TestUser admin = admin();
        mvc.perform(get("/api/v1/submissions/" + id).header("Authorization", admin.bearer()))
                .andExpect(status().isOk());
    }

    @Test
    void submissionValidation() throws Exception {
        TestUser u = register();
        mvc.perform(json(post("/api/v1/submissions"),
                        "{\"problem_id\":\"a-plus-b\",\"language\":\"python3\",\"source_code\":\"x\"}")
                        .header("Authorization", u.bearer()))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.message").value(Matchers.containsString("cpp17, java21, node22")));
        mvc.perform(json(post("/api/v1/submissions"),
                        "{\"problem_id\":\"a-plus-b\",\"language\":\"cpp17\",\"source_code\":\"  \"}")
                        .header("Authorization", u.bearer()))
                .andExpect(status().isBadRequest());
        mvc.perform(json(post("/api/v1/submissions"),
                        "{\"problem_id\":\"nope\",\"language\":\"cpp17\",\"source_code\":\"x\"}")
                        .header("Authorization", u.bearer()))
                .andExpect(status().isNotFound());
        mvc.perform(json(post("/api/v1/submissions"), "{\"problem_id\":\"a-plus-b\",\"language\":\"cpp17\",\"source_code\":\"x\"}"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void runsAreQueuedOnTheirOwnTopicAndWaitIsBounded() throws Exception {
        TestUser u = register();
        mvc.perform(json(post("/api/v1/runs"),
                        "{\"problem_id\":\"a-plus-b\",\"language\":\"cpp17\",\"source_code\":\"%s\",\"stdin\":\"1 2\"}"
                                .formatted(CPP))
                        .header("Authorization", u.bearer()))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.message").value(Matchers.containsString("custom")));

        String body = mvc.perform(json(post("/api/v1/runs"),
                        "{\"problem_id\":\"a-plus-b\",\"language\":\"node22\",\"source_code\":\"console.log(3)\","
                                + "\"mode\":\"custom\",\"stdin\":\"1 2\"}")
                        .header("Authorization", u.bearer()))
                .andExpect(status().isAccepted())
                .andReturn().getResponse().getContentAsString();
        UUID id = UUID.fromString(JsonPath.read(body, "$.run_id"));
        String topic = jdbc.sql("SELECT topic FROM outbox_events WHERE aggregate_id = ?").param(id)
                .query(String.class).single();
        assertThat(topic).isEqualTo("voidrun.runs");

        long started = System.currentTimeMillis();
        mvc.perform(get("/api/v1/runs/" + id).param("wait_ms", "400").header("Authorization", u.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("QUEUED"))
                .andExpect(jsonPath("$.mode").value("CUSTOM"))
                .andExpect(jsonPath("$.problem_slug").value("a-plus-b"));
        assertThat(System.currentTimeMillis() - started).isBetween(350L, 5_000L);

        TestUser stranger = register();
        mvc.perform(get("/api/v1/runs/" + id).header("Authorization", stranger.bearer()))
                .andExpect(status().isNotFound());
    }

    @Test
    void adminManagesProblemsAndTests() throws Exception {
        TestUser admin = admin();
        String slug = unique("p").toLowerCase();
        String created = mvc.perform(json(post("/api/v1/admin/problems"), """
                        {"slug":"%s","title":"Sum It","description":"Add numbers.","difficulty":"easy",
                         "time_limit_ms":1000,"memory_limit_mb":256,"tags":["Math","math"," arrays "]}"""
                        .formatted(slug))
                        .header("Authorization", admin.bearer()))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.published").value(false))
                .andExpect(jsonPath("$.difficulty").value("EASY"))
                .andExpect(jsonPath("$.tags").value(Matchers.contains("arrays", "math")))
                .andReturn().getResponse().getContentAsString();
        String id = JsonPath.read(created, "$.id");

        mvc.perform(get("/api/v1/problems/" + slug)).andExpect(status().isNotFound());
        mvc.perform(json(post("/api/v1/admin/problems"), """
                        {"slug":"%s","title":"x","description":"x","difficulty":"EASY","time_limit_ms":1,"memory_limit_mb":64}"""
                        .formatted(slug))
                        .header("Authorization", admin.bearer()))
                .andExpect(status().isConflict());

        mvc.perform(json(post("/api/v1/admin/problems/" + id + "/test-cases"),
                        "{\"input\":\"1 2\",\"expected_output\":\"3\",\"is_sample\":true}")
                        .header("Authorization", admin.bearer()))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.position").value(1));
        String hidden = mvc.perform(json(post("/api/v1/admin/problems/" + id + "/test-cases"),
                        "{\"input\":\"5 5\",\"expected_output\":\"10\"}")
                        .header("Authorization", admin.bearer()))
                .andExpect(jsonPath("$.position").value(2))
                .andReturn().getResponse().getContentAsString();

        mvc.perform(json(patch("/api/v1/admin/problems/" + id), "{\"published\":true,\"title\":\"Sum It Up\"}")
                        .header("Authorization", admin.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("Sum It Up"))
                .andExpect(jsonPath("$.description").value("Add numbers."))
                .andExpect(jsonPath("$.sample_count").value(1))
                .andExpect(jsonPath("$.hidden_count").value(1));
        mvc.perform(get("/api/v1/problems/" + slug))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.samples.length()").value(1));

        mvc.perform(delete("/api/v1/admin/test-cases/" + JsonPath.read(hidden, "$.id"))
                        .header("Authorization", admin.bearer()))
                .andExpect(status().isNoContent());
        mvc.perform(get("/api/v1/admin/problems").param("q", slug).header("Authorization", admin.bearer()))
                .andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.items[0].hidden_count").value(0));
    }
}

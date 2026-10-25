package dev.voidrun.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import dev.voidrun.recorder.Recording;
import dev.voidrun.recorder.RecordingBuilder;
import dev.voidrun.recorder.RecordingCodec;
import dev.voidrun.recorder.Termination;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.hamcrest.Matchers;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

class ReplayIntegrationTest extends ApiTestSupport {

    private static final String CPP = "int main(){int n=5;return 0;}";

    @Autowired
    LocalKafka kafka;

    private UUID createReplay(TestUser u) throws Exception {
        String body = mvc.perform(json(post("/api/v1/replays"),
                        "{\"problem_id\":\"a-plus-b\",\"language\":\"cpp17\",\"source_code\":\"%s\",\"stdin\":\"3 4\"}"
                                .formatted(CPP))
                        .header("Authorization", u.bearer()))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.status").value("QUEUED"))
                .andReturn().getResponse().getContentAsString();
        return UUID.fromString(JsonPath.read(body, "$.replay_id"));
    }

    @Test
    void aRequestedReplayIsRelayedToItsKafkaTopic() throws Exception {
        UUID id = createReplay(register());

        Map<String, Object> event = jdbc.sql(
                        "SELECT topic, event_type, payload::text AS payload FROM outbox_events WHERE aggregate_id = ?")
                .param(id).query().singleRow();
        assertThat(event).containsEntry("topic", "voidrun.replays").containsEntry("event_type", "replay.requested");

        ConsumerRecord<String, String> record = consumeFrom("voidrun.replays", id.toString());
        assertThat(record.value()).contains("\"replayId\": \"" + id + "\"", "\"version\": 1");
        assertThat(new String(record.headers().lastHeader("voidrun-event-type").value(), StandardCharsets.UTF_8))
                .isEqualTo("replay.requested");
        assertThat(jdbc.sql("SELECT published_at IS NOT NULL FROM outbox_events WHERE aggregate_id = ?")
                .param(id).query(Boolean.class).single()).isTrue();
    }

    @Test
    void stepsThroughARecordingForwardsFromAnyStep() throws Exception {
        TestUser u = register();
        UUID id = createReplay(u);
        finish(id, sampleRecording());

        mvc.perform(get("/api/v1/replays/" + id).header("Authorization", u.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("FINISHED"))
                .andExpect(jsonPath("$.problem_slug").value("a-plus-b"))
                .andExpect(jsonPath("$.source_code").value(CPP))
                .andExpect(jsonPath("$.stdin").value("3 4"))
                .andExpect(jsonPath("$.step_count").value(5))
                .andExpect(jsonPath("$.termination.kind").value("EXITED"))
                .andExpect(jsonPath("$.termination.exit_code").value(0))
                .andExpect(jsonPath("$.stdout").value("1 2\n25\n"))
                .andExpect(jsonPath("$.timeline[0]").value(Matchers.contains(3, 1)))
                .andExpect(jsonPath("$.timeline[3]").value(Matchers.contains(1, 2)))
                .andExpect(jsonPath("$.timeline[4]").value(Matchers.contains(6, 1)));

        // A page in the middle, rebuilt from the nearest keyframe.
        mvc.perform(get("/api/v1/replays/" + id + "/steps").param("from", "2").param("count", "2")
                        .header("Authorization", u.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.from").value(2))
                .andExpect(jsonPath("$.total").value(5))
                .andExpect(jsonPath("$.steps.length()").value(2))
                .andExpect(jsonPath("$.steps[0].line").value(5))
                .andExpect(jsonPath("$.steps[0].stdout_length").value(4))
                .andExpect(jsonPath("$.steps[0].frames[0].function").value("main"))
                // Natural order: the vector, then its elements, then n.
                .andExpect(jsonPath("$.steps[0].frames[0].variables[*].name").value(Matchers.contains(
                        "n", "v", "v[0]", "v[1]")))
                .andExpect(jsonPath("$.steps[0].frames[0].variables[1].type").value("std::vector<int>"))
                .andExpect(jsonPath("$.steps[0].frames[0].variables[2].type").doesNotExist())
                .andExpect(jsonPath("$.steps[0].frames[0].variables[0].changed").value(false))
                .andExpect(jsonPath("$.steps[0].frames[0].variables[2].changed").value(true))
                // The call: a second frame on top of main.
                .andExpect(jsonPath("$.steps[1].depth").value(2))
                .andExpect(jsonPath("$.steps[1].frames[1].function").value("sq(int)"))
                .andExpect(jsonPath("$.steps[1].frames[1].variables[0].name").value("x"))
                .andExpect(jsonPath("$.steps[1].frames[1].variables[0].changed").value(true));

        // The last step: the call has returned, so its frame is gone.
        mvc.perform(get("/api/v1/replays/" + id + "/steps").param("from", "4").param("count", "50")
                        .header("Authorization", u.bearer()))
                .andExpect(jsonPath("$.steps.length()").value(1))
                .andExpect(jsonPath("$.steps[0].frames.length()").value(1))
                .andExpect(jsonPath("$.steps[0].stdout_length").value(7));
        mvc.perform(get("/api/v1/replays/" + id + "/steps").param("from", "9").header("Authorization", u.bearer()))
                .andExpect(jsonPath("$.steps.length()").value(0));
        mvc.perform(get("/api/v1/replays/" + id + "/steps").param("count", "0").header("Authorization", u.bearer()))
                .andExpect(status().isBadRequest());
    }

    @Test
    void aReplayBelongsToWhoeverRequestedIt() throws Exception {
        TestUser owner = register();
        UUID id = createReplay(owner);
        TestUser other = register();
        mvc.perform(get("/api/v1/replays/" + id).header("Authorization", other.bearer()))
                .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/replays/" + id + "/steps").header("Authorization", other.bearer()))
                .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/replays/" + id)).andExpect(status().isUnauthorized());
    }

    @Test
    void anUnrecordedReplayWaitsAndHasNoStepsYet() throws Exception {
        TestUser u = register();
        UUID id = createReplay(u);
        long started = System.currentTimeMillis();
        mvc.perform(get("/api/v1/replays/" + id).param("wait_ms", "400").header("Authorization", u.bearer()))
                .andExpect(jsonPath("$.status").value("QUEUED"))
                .andExpect(jsonPath("$.termination").doesNotExist());
        assertThat(System.currentTimeMillis() - started).isBetween(350L, 5_000L);
        mvc.perform(get("/api/v1/replays/" + id + "/steps").header("Authorization", u.bearer()))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("REPLAY_NOT_READY"));
    }

    @Test
    void onlyCppCanBeRecorded() throws Exception {
        TestUser u = register();
        mvc.perform(json(post("/api/v1/replays"),
                        "{\"language\":\"java21\",\"source_code\":\"class Main{}\"}")
                        .header("Authorization", u.bearer()))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.message").value(Matchers.containsString("C++17")));
        mvc.perform(json(post("/api/v1/replays"), "{\"language\":\"cpp17\",\"source_code\":\"  \"}")
                        .header("Authorization", u.bearer()))
                .andExpect(status().isBadRequest());
        // No problem is fine: a replay can be of any program.
        mvc.perform(json(post("/api/v1/replays"), "{\"language\":\"cpp17\",\"source_code\":\"int main(){}\"}")
                        .header("Authorization", u.bearer()))
                .andExpect(status().isAccepted());
    }

    @Test
    void aRecorderFailureIsReportedWithoutItsInternals() throws Exception {
        TestUser u = register();
        UUID id = createReplay(u);
        jdbc.sql("""
                        UPDATE replays SET status = 'FINISHED', termination = 'RECORDER_ERROR',
                               detail = 'tracer exited with status 1: /var/lib/voidrun/work/x', finished_at = now()
                        WHERE id = ?""")
                .param(id).update();
        mvc.perform(get("/api/v1/replays/" + id).header("Authorization", u.bearer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.termination.kind").value("RECORDER_ERROR"))
                .andExpect(jsonPath("$.termination.detail").value(""))
                .andExpect(jsonPath("$.message").value(Matchers.containsString("could not record")))
                .andExpect(jsonPath("$.step_count").value(0));
        mvc.perform(get("/api/v1/replays/" + id + "/steps").header("Authorization", u.bearer()))
                .andExpect(jsonPath("$.steps.length()").value(0));
    }

    /** Five steps of: main declares n and v, prints, calls sq(n), prints again. */
    private static Recording sampleRecording() {
        RecordingBuilder b = new RecordingBuilder(2);
        Map<String, String> s = new HashMap<>(Map.of("line", "3", "depth", "1", "out", "0", "f0.fn", "main",
                "f0.line", "3"));
        b.add(s);
        s.putAll(Map.of("line", "4", "f0.line", "4", "f0.v.n", "5", "f0.t.n", "int"));
        b.add(s);
        s.putAll(Map.of("line", "5", "f0.line", "5", "out", "4", "f0.v.v", "size=2", "f0.v.v[0]", "1",
                "f0.v.v[1]", "2", "f0.t.v", "std::vector<int>"));
        b.add(s);
        s.putAll(Map.of("line", "1", "depth", "2", "f1.fn", "sq(int)", "f1.line", "1", "f1.v.x", "5",
                "f1.t.x", "int"));
        b.add(s);
        for (String k : List.of("f1.fn", "f1.line", "f1.v.x", "f1.t.x")) {
            s.remove(k);
        }
        s.putAll(Map.of("line", "6", "depth", "1", "f0.line", "6", "out", "7"));
        b.add(s);
        return b.build("1 2\n25\n".getBytes(StandardCharsets.UTF_8), "",
                new Termination(Termination.Kind.EXITED, 0, "exited with status 0"));
    }

    /** What the worker does once it has recorded. */
    private void finish(UUID id, Recording rec) {
        jdbc.sql("""
                        UPDATE replays SET status = 'FINISHED', termination = ?, exit_code = ?, detail = ?,
                               step_count = ?, recording = ?, finished_at = now()
                        WHERE id = ?""")
                .params(rec.termination().kind().name(), rec.termination().code(), rec.termination().detail(),
                        rec.stepCount(), RecordingCodec.encode(rec), id)
                .update();
    }

    private ConsumerRecord<String, String> consumeFrom(String topic, String key) {
        Properties p = new Properties();
        p.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, kafka.bootstrapServers());
        p.put(ConsumerConfig.GROUP_ID_CONFIG, "test-" + UUID.randomUUID());
        p.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        try (KafkaConsumer<String, String> c = new KafkaConsumer<>(p, new StringDeserializer(),
                new StringDeserializer())) {
            c.subscribe(List.of(topic));
            long deadline = System.currentTimeMillis() + 30_000;
            while (System.currentTimeMillis() < deadline) {
                for (ConsumerRecord<String, String> r : c.poll(Duration.ofMillis(500))) {
                    if (key.equals(r.key())) {
                        return r;
                    }
                }
            }
        }
        throw new AssertionError("no record with key " + key + " on " + topic);
    }
}

package dev.voidrun.worker;

import static org.assertj.core.api.Assertions.assertThat;

import dev.voidrun.common.Topics;
import dev.voidrun.recorder.Recording;
import dev.voidrun.recorder.RecordingCodec;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Recording replays from {@code voidrun.replays}, with a fake recorder. */
class ReplayWorkerIntegrationTest extends WorkerIntegrationTestSupport {

    @Test
    void recordsARequestedReplayAndStoresIt() throws Exception {
        String source = "int main(){} // " + UUID.randomUUID();
        UUID id = requestReplay(source, "hello");
        publish(id.toString(), job(id));

        awaitFinished(id);
        Map<String, Object> row = jdbc.sql("""
                        SELECT status, termination, exit_code, step_count, attempts, claimed_by
                        FROM replays WHERE id = ?""").param(id).query().singleRow();
        assertThat(row).containsEntry("status", "FINISHED").containsEntry("termination", "EXITED")
                .containsEntry("exit_code", 0).containsEntry("step_count", 3).containsEntry("attempts", 1)
                .containsEntry("claimed_by", "test-worker");
        byte[] blob = jdbc.sql("SELECT recording FROM replays WHERE id = ?").param(id)
                .query((rs, i) -> rs.getBytes(1)).single();
        Recording rec = RecordingCodec.decode(blob);
        assertThat(rec.stepCount()).isEqualTo(3);
        assertThat(new String(rec.stdout(), StandardCharsets.UTF_8)).isEqualTo("hello");
    }

    @Test
    void aDuplicateDeliveryIsAcknowledgedWithoutRecordingAgain() throws Exception {
        String source = "int main(){} // dup " + UUID.randomUUID();
        UUID id = requestReplay(source, "");
        publish(id.toString(), job(id));
        publish(id.toString(), job(id));
        // Same key, so the same partition: once this one is recorded, both
        // copies before it have been consumed.
        UUID marker = requestReplay("int main(){} // marker " + UUID.randomUUID(), "");
        publish(id.toString(), job(marker));

        awaitFinished(marker);
        assertThat(recorder.callsFor(source)).isEqualTo(1);
        assertThat(jdbc.sql("SELECT attempts FROM replays WHERE id = ?").param(id).query(Integer.class).single())
                .isEqualTo(1);
    }

    @Test
    void aTransientFailureIsRetriedFromTheRetryTopic() throws Exception {
        String source = "int main(){} // flaky " + UUID.randomUUID();
        UUID id = requestReplay(source, "");
        publish(id.toString(), job(id));

        awaitFinished(id);
        assertThat(jdbc.sql("SELECT termination FROM replays WHERE id = ?").param(id).query(String.class).single())
                .isEqualTo("EXITED");
        assertThat(recorder.callsFor(source)).isEqualTo(2);
    }

    @Test
    void aJobThatKeepsFailingEndsInTheDeadLetterTopic() throws Exception {
        String source = "int main(){} // boom " + UUID.randomUUID();
        UUID id = requestReplay(source, "");
        publish(id.toString(), job(id));

        awaitFinished(id);
        assertThat(jdbc.sql("SELECT termination FROM replays WHERE id = ?").param(id).query(String.class).single())
                .isEqualTo("RECORDER_ERROR");
        assertThat(recorder.callsFor(source)).isEqualTo(3);
        Map<String, Object> dead = jdbc.sql(
                        "SELECT event_type, reason, payload->>'replayId' AS replay FROM dead_letter_events WHERE replay_id = ?")
                .param(id).query().singleRow();
        assertThat(dead).containsEntry("event_type", "replay.requested").containsEntry("replay", id.toString());
        assertThat((String) dead.get("reason")).contains("sandbox did not start");
    }

    @Test
    void aMalformedJobSkipsTheRetriesAndIsDeadLettered() throws Exception {
        UUID id = requestReplay("int main(){} // " + UUID.randomUUID(), "");
        publish(id.toString(), "{not json");

        awaitFinished(id);
        assertThat(jdbc.sql("SELECT termination FROM replays WHERE id = ?").param(id).query(String.class).single())
                .isEqualTo("RECORDER_ERROR");
        assertThat(jdbc.sql("SELECT payload #>> '{}' FROM dead_letter_events WHERE replay_id = ?").param(id)
                .query(String.class).single()).isEqualTo("{not json");
    }

    private UUID requestReplay(String source, String stdin) {
        return jdbc.sql("""
                        INSERT INTO replays (user_id, language, source_code, stdin, expires_at)
                        VALUES (?, 'cpp17', ?, ?, now() + interval '1 day') RETURNING id""")
                .params(newUser(), source, stdin).query(UUID.class).single();
    }

    private static String job(UUID id) {
        return "{\"version\":1,\"replayId\":\"" + id + "\",\"correlationId\":\"test\"}";
    }

    private void publish(String key, String value) throws Exception {
        publish(Topics.REPLAYS, key, value);
    }

    private void awaitFinished(UUID id) throws InterruptedException {
        awaitStatus("replays", id, "FINISHED");
    }
}

package dev.voidrun.worker.judge;

import dev.voidrun.common.events.JudgeJob;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

/** Reading {@link JudgeJob} messages, shared by the run and submission listeners. */
final class JudgeJobs {

    static final String CORRELATION_HEADER = "voidrun-correlation-id";
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private JudgeJobs() {}

    static JudgeJob parse(ConsumerRecord<String, String> record, JudgeJob.Kind expected) {
        try {
            JudgeJob job = JSON.readValue(record.value(), JudgeJob.class);
            if (job.id() == null || job.kind() != expected) {
                throw new JudgeService.UnjudgeableException("not a " + expected + " job: " + record.value());
            }
            if (job.version() > JudgeJob.CURRENT_VERSION) {
                throw new JudgeService.UnjudgeableException("job version " + job.version()
                        + " is newer than this worker understands");
            }
            return job;
        } catch (JacksonException e) {
            throw new JudgeService.UnjudgeableException("malformed judge job: " + e.getOriginalMessage());
        }
    }

    static boolean isJson(String value) {
        try {
            JSON.readTree(value);
            return value != null;
        } catch (JacksonException e) {
            return false;
        }
    }

    static UUID idFromKey(String key) {
        try {
            return key == null ? null : UUID.fromString(key);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    static String correlationId(ConsumerRecord<?, ?> record) {
        var h = record.headers().lastHeader(CORRELATION_HEADER);
        return h == null ? null : new String(h.value(), StandardCharsets.UTF_8);
    }
}

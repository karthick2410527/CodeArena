package dev.voidrun.worker;

import dev.voidrun.common.Topics;
import dev.voidrun.common.events.ReplayJob;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.kafka.annotation.BackOff;
import org.springframework.kafka.annotation.DltHandler;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.annotation.RetryableTopic;
import org.springframework.kafka.retrytopic.DltStrategy;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.kafka.support.KafkaHeaders;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

/**
 * Consumes {@code voidrun.replays}.
 *
 * <ul>
 *   <li>One record per poll and a manual, immediate commit after the result is
 *       in PostgreSQL: a worker that dies mid-recording leaves the offset
 *       uncommitted, and the job is redelivered to another worker.</li>
 *   <li>A failure is not retried in place, which would hold up every job
 *       behind it on the partition. It moves to {@code voidrun.replays-retry-<delay ms>}
 *       with exponential backoff, and after the last attempt to
 *       {@code voidrun.replays-dlt}, whose handler ends the replay as a
 *       recorder error and records a dead letter.</li>
 * </ul>
 */
@Component
public class ReplayListener {

    private static final Logger log = LoggerFactory.getLogger(ReplayListener.class);
    private static final String CORRELATION_HEADER = "voidrun-correlation-id";

    private final ReplayService replays;
    private final JsonMapper json = JsonMapper.builder().build();

    public ReplayListener(ReplayService replays) {
        this.replays = replays;
    }

    @RetryableTopic(
            attempts = "${voidrun.worker.replay.attempts:3}",
            backOff = @BackOff(delayString = "${voidrun.worker.replay.retry-delay-ms:2000}", multiplier = 2.0),
            exclude = ReplayService.UnrecordableException.class,
            dltStrategy = DltStrategy.FAIL_ON_ERROR,
            numPartitions = "${voidrun.worker.topic-partitions:3}",
            replicationFactor = "${voidrun.worker.topic-replication-factor:1}")
    @KafkaListener(id = "replay-recorder", topics = Topics.REPLAYS, groupId = "voidrun-replay-recorders",
            concurrency = "${voidrun.worker.replay.concurrency:1}")
    public void onReplay(ConsumerRecord<String, String> record, Acknowledgment ack) throws Exception {
        ReplayJob job = parse(record);
        MDC.put("correlationId", job.correlationId() == null ? "" : job.correlationId());
        try {
            replays.record(job.replayId());
            ack.acknowledge();
        } finally {
            MDC.remove("correlationId");
        }
    }

    @DltHandler
    public void onDeadLetter(ConsumerRecord<String, String> record,
            @Header(name = KafkaHeaders.EXCEPTION_MESSAGE, required = false) String error, Acknowledgment ack) {
        UUID id = parseId(record.key());
        boolean isJson = isJson(record.value());
        replays.giveUp(id, error == null ? "retries exhausted" : error, record.value(), isJson,
                header(record, CORRELATION_HEADER));
        ack.acknowledge();
    }

    private ReplayJob parse(ConsumerRecord<String, String> record) {
        try {
            ReplayJob job = json.readValue(record.value(), ReplayJob.class);
            if (job.replayId() == null) {
                throw new ReplayService.UnrecordableException("replay job without a replayId");
            }
            if (job.version() > ReplayJob.CURRENT_VERSION) {
                throw new ReplayService.UnrecordableException("replay job version " + job.version()
                        + " is newer than this worker understands");
            }
            return job;
        } catch (JacksonException e) {
            throw new ReplayService.UnrecordableException("malformed replay job: " + e.getOriginalMessage());
        }
    }

    private boolean isJson(String value) {
        try {
            json.readTree(value);
            return value != null;
        } catch (JacksonException e) {
            return false;
        }
    }

    private static UUID parseId(String key) {
        try {
            return key == null ? null : UUID.fromString(key);
        } catch (IllegalArgumentException e) {
            log.warn("dead-lettered replay job has a key that is not a replay id: {}", key);
            return null;
        }
    }

    private static String header(ConsumerRecord<?, ?> record, String name) {
        org.apache.kafka.common.header.Header h = record.headers().lastHeader(name);
        return h == null ? null : new String(h.value(), StandardCharsets.UTF_8);
    }
}

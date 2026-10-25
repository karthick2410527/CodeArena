package dev.voidrun.api.outbox;

import dev.voidrun.api.config.VoidRunProperties;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Delivers outbox rows to Kafka.
 *
 * <p>Each pass claims a batch with {@code FOR UPDATE SKIP LOCKED}, so any
 * number of API instances can relay at once without sending a row twice
 * concurrently, publishes it, and stamps {@code published_at} in the same
 * transaction. A row whose send fails is retried later with exponential
 * backoff; nothing is dropped.
 *
 * <p>Delivery is at least once: if the commit fails after Kafka acknowledged
 * a send, the row is sent again. Consumers are built for that: they finish
 * work with a guarded {@code UPDATE ... WHERE status <> 'FINISHED'}, so a
 * duplicate is acknowledged without redoing anything.
 */
@Component
@ConditionalOnProperty(name = "voidrun.outbox.relay-enabled", havingValue = "true", matchIfMissing = true)
public class OutboxRelay {

    public static final String EVENT_TYPE_HEADER = "voidrun-event-type";
    public static final String CORRELATION_HEADER = "voidrun-correlation-id";

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);
    private static final long SEND_TIMEOUT_MS = 10_000;
    private static final long MAX_BACKOFF_SECONDS = 60;

    private record Pending(long id, String topic, String key, String eventType, String payload,
            String correlationId, int attempts) {}

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final KafkaTemplate<String, String> kafka;
    private final int batchSize;

    public OutboxRelay(JdbcClient jdbc, TransactionTemplate tx, KafkaTemplate<String, String> kafka,
            VoidRunProperties props) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.kafka = kafka;
        this.batchSize = Math.max(1, props.outbox().batchSize());
    }

    @Scheduled(fixedDelayString = "${voidrun.outbox.poll-interval-ms:200}")
    public void relay() {
        try {
            // Keep going while there is a backlog; a short batch means it is drained.
            while (relayBatch() == batchSize) {
                if (Thread.currentThread().isInterrupted()) {
                    return;
                }
            }
        } catch (RuntimeException e) {
            log.warn("outbox relay pass failed, retrying on the next tick: {}", e.toString());
        }
    }

    /** One claimed batch; returns how many rows it claimed. */
    int relayBatch() {
        Integer claimed = tx.execute(status -> {
            List<Pending> rows = jdbc.sql("""
                            SELECT id, topic, message_key, event_type, payload::text AS payload, correlation_id,
                                   publish_attempts
                            FROM outbox_events
                            WHERE published_at IS NULL AND next_attempt_at <= now()
                            -- Contest submissions jump the queue: a contest's clock is running.
                            ORDER BY (topic = 'voidrun.contest-submissions') DESC, id
                            LIMIT ?
                            FOR UPDATE SKIP LOCKED""")
                    .param(batchSize)
                    .query((rs, i) -> new Pending(rs.getLong("id"), rs.getString("topic"),
                            rs.getString("message_key"), rs.getString("event_type"), rs.getString("payload"),
                            rs.getString("correlation_id"), rs.getInt("publish_attempts")))
                    .list();
            if (rows.isEmpty()) {
                return 0;
            }
            // Send the whole batch before waiting on any of it, so a batch
            // costs about one broker round trip rather than one per row.
            List<CompletableFuture<SendResult<String, String>>> sends = new ArrayList<>(rows.size());
            for (Pending row : rows) {
                sends.add(send(row));
            }
            List<Long> published = new ArrayList<>(rows.size());
            for (int i = 0; i < rows.size(); i++) {
                Pending row = rows.get(i);
                try {
                    sends.get(i).get(SEND_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                    published.add(row.id());
                } catch (ExecutionException | TimeoutException e) {
                    backOff(row, e instanceof ExecutionException ? e.getCause() : e);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    backOff(row, e);
                }
            }
            if (!published.isEmpty()) {
                jdbc.sql("UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id IN (:ids)")
                        .param("ids", published)
                        .update();
            }
            return rows.size();
        });
        return claimed == null ? 0 : claimed;
    }

    private CompletableFuture<SendResult<String, String>> send(Pending row) {
        ProducerRecord<String, String> record = new ProducerRecord<>(row.topic(), row.key(), row.payload());
        record.headers().add(EVENT_TYPE_HEADER, row.eventType().getBytes(StandardCharsets.UTF_8));
        if (row.correlationId() != null) {
            record.headers().add(CORRELATION_HEADER, row.correlationId().getBytes(StandardCharsets.UTF_8));
        }
        try {
            return kafka.send(record);
        } catch (RuntimeException e) {
            // send() itself throws when metadata cannot be fetched in time.
            return CompletableFuture.failedFuture(e);
        }
    }

    private void backOff(Pending row, Throwable cause) {
        long delay = Math.min(MAX_BACKOFF_SECONDS, 1L << Math.min(row.attempts(), 6));
        String error = String.valueOf(cause);
        jdbc.sql("""
                        UPDATE outbox_events
                        SET publish_attempts = publish_attempts + 1, last_error = ?,
                            next_attempt_at = now() + make_interval(secs => ?)
                        WHERE id = ?""")
                .params(error.length() > 1000 ? error.substring(0, 1000) : error, (double) delay, row.id())
                .update();
        log.warn("outbox event {} ({} on {}) not delivered, retrying in {}s: {}", row.id(), row.eventType(),
                row.topic(), delay, error);
    }
}

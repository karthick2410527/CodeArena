package dev.voidrun.api.outbox;

import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

/**
 * Appends an event to the transactional outbox. It must run inside the
 * caller's transaction (it refuses to start its own), so the event commits
 * together with the row it announces, or not at all. A relay delivers it to
 * Kafka afterwards.
 *
 * <p>Payloads use their own camelCase mapper, independent of the HTTP API's
 * snake_case, so the Kafka contract does not move when the web contract does.
 */
@Component
public class OutboxWriter {

    private final JdbcClient jdbc;
    private final JsonMapper json = JsonMapper.builder().build();

    public OutboxWriter(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void append(String topic, String key, String eventType, UUID aggregateId, Object payload,
            String correlationId) {
        jdbc.sql("""
                        INSERT INTO outbox_events (topic, message_key, event_type, aggregate_id, payload, correlation_id)
                        VALUES (?, ?, ?, ?, ?::jsonb, ?)""")
                .params(topic, key, eventType, aggregateId, json.writeValueAsString(payload), correlationId)
                .update();
    }
}

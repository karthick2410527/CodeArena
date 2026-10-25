package dev.voidrun.api.outbox;

import dev.voidrun.api.config.VoidRunProperties;
import dev.voidrun.common.Topics;
import java.util.stream.Stream;
import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.kafka.core.KafkaAdmin;

/**
 * Declares the work topics the outbox publishes to, so they exist with the
 * intended partition count before anything is sent, rather than whatever a
 * broker's auto-create default happens to be. Retry and dead-letter topics
 * belong to the consumers and are declared by the workers.
 */
@Configuration(proxyBeanMethods = false)
class KafkaTopicsConfig {

    @Bean
    KafkaAdmin.NewTopics voidrunTopics(VoidRunProperties props) {
        VoidRunProperties.Outbox o = props.outbox();
        return new KafkaAdmin.NewTopics(Stream.of(Topics.RUNS, Topics.SUBMISSIONS, Topics.CONTEST_SUBMISSIONS,
                        Topics.REPLAYS, Topics.VERDICTS)
                .map(t -> TopicBuilder.name(t).partitions(o.partitions()).replicas(o.replicationFactor()).build())
                .toArray(NewTopic[]::new));
    }
}

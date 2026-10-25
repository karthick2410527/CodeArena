package dev.voidrun.worker;

import com.github.dockerjava.api.model.ExposedPort;
import com.github.dockerjava.api.model.PortBinding;
import com.github.dockerjava.api.model.Ports;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.ServerSocket;
import java.util.concurrent.ThreadLocalRandom;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;

/**
 * A single-node KRaft broker for tests, configured the way docker-compose.yml
 * runs one.
 *
 * <p>Testcontainers' own KafkaContainer rewrites the advertised listeners in a
 * start-up hook, and on Docker 29 the broker never sees the rewrite: it
 * starts with {@code 0.0.0.0} advertised and exits. Binding a host port chosen
 * up front lets the advertised address be a plain environment variable.
 */
public class LocalKafka extends GenericContainer<LocalKafka> {

    private int port;

    public LocalKafka() {
        super(DockerImageName.parse("apache/kafka:3.9.0"));
        withEnv("KAFKA_NODE_ID", "1");
        withEnv("KAFKA_PROCESS_ROLES", "broker,controller");
        withEnv("KAFKA_CONTROLLER_QUORUM_VOTERS", "1@localhost:9093");
        withEnv("KAFKA_LISTENERS", "PLAINTEXT://:9092,CONTROLLER://:9093");
        withEnv("KAFKA_LISTENER_SECURITY_PROTOCOL_MAP", "PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT");
        withEnv("KAFKA_CONTROLLER_LISTENER_NAMES", "CONTROLLER");
        withEnv("KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR", "1");
        withEnv("KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR", "1");
        withEnv("KAFKA_TRANSACTION_STATE_LOG_MIN_ISR", "1");
        withEnv("KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS", "0");
        withCreateContainerCmdModifier(cmd -> cmd
                .withExposedPorts(ExposedPort.tcp(9092))
                .getHostConfig()
                .withPortBindings(new PortBinding(Ports.Binding.bindPort(port), ExposedPort.tcp(9092))));
        waitingFor(Wait.forLogMessage(".*Kafka Server started.*", 1));
    }

    /**
     * Picks the host port at start, outside the ephemeral range Docker itself
     * allocates published ports from, and tries another if Docker reports it
     * taken anyway.
     */
    @Override
    public void start() {
        RuntimeException last = null;
        for (int attempt = 0; attempt < 5; attempt++) {
            port = freePort();
            withEnv("KAFKA_ADVERTISED_LISTENERS", "PLAINTEXT://localhost:" + port);
            try {
                super.start();
                return;
            } catch (RuntimeException e) {
                last = e;
                stop();
            }
        }
        throw last;
    }

    public String bootstrapServers() {
        return "localhost:" + port;
    }

    private static int freePort() {
        for (int i = 0; i < 50; i++) {
            int candidate = ThreadLocalRandom.current().nextInt(21_000, 29_000);
            try (ServerSocket s = new ServerSocket(candidate)) {
                return candidate;
            } catch (IOException taken) {
                // try another
            }
        }
        throw new UncheckedIOException(new IOException("no free port for the test Kafka broker"));
    }
}

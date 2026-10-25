package dev.voidrun.worker;

import dev.voidrun.common.Topics;
import dev.voidrun.recorder.Recording;
import dev.voidrun.recorder.RecordingBuilder;
import dev.voidrun.recorder.Termination;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.test.context.DynamicPropertyRegistrar;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * The worker against real PostgreSQL (with the API's migrations and seed) and
 * real Kafka, with the recorder and the judge's sandbox replaced by fakes
 * whose behaviour each test picks through the program's source. One Spring
 * context, and so one set of containers, is shared by every subclass.
 */
@SpringBootTest(properties = {
        "spring.flyway.enabled=true",
        // The seed's problem statements contain "${...}"; migrations use no placeholders.
        "spring.flyway.placeholder-replacement=false",
        "voidrun.worker.id=test-worker",
        "voidrun.worker.replay.attempts=3",
        "voidrun.worker.replay.retry-delay-ms=200",
        "voidrun.worker.judge.attempts=3",
        "voidrun.worker.judge.retry-delay-ms=200",
})
@Import(WorkerIntegrationTestSupport.Infrastructure.class)
public abstract class WorkerIntegrationTestSupport {

    @TestConfiguration(proxyBeanMethods = false)
    static class Infrastructure {
        @Bean
        @ServiceConnection
        PostgreSQLContainer postgres() {
            return new PostgreSQLContainer(DockerImageName.parse("postgres:16-alpine"));
        }

        @Bean
        LocalKafka kafka() {
            return new LocalKafka();
        }

        @Bean
        DynamicPropertyRegistrar kafkaProperties(LocalKafka kafka) {
            return registry -> registry.add("spring.kafka.bootstrap-servers", kafka::bootstrapServers);
        }

        @Bean
        @Primary
        FakeRecorder fakeRecorder() {
            return new FakeRecorder();
        }

        @Bean
        @Primary
        FakeSandbox fakeSandbox() {
            return new FakeSandbox();
        }
    }

    /**
     * Records three steps, except: a source containing {@code boom} always
     * fails, and one containing {@code flaky} fails on its first attempt only.
     */
    public static class FakeRecorder implements ReplayRecorder {
        final Map<String, AtomicInteger> calls = new ConcurrentHashMap<>();

        @Override
        public Recording record(String source, String stdin) throws IOException {
            int n = calls.computeIfAbsent(source, s -> new AtomicInteger()).incrementAndGet();
            if (source.contains("boom") || (source.contains("flaky") && n == 1)) {
                throw new IOException("sandbox did not start");
            }
            RecordingBuilder b = new RecordingBuilder(2);
            for (int line = 1; line <= 3; line++) {
                b.add(Map.of("line", Integer.toString(line), "depth", "1", "out", "0", "f0.fn", "main",
                        "f0.line", Integer.toString(line)));
            }
            return b.build(stdin.getBytes(StandardCharsets.UTF_8), "",
                    new Termination(Termination.Kind.EXITED, 0, "exited with status 0"));
        }

        int callsFor(String source) {
            AtomicInteger n = calls.get(source);
            return n == null ? 0 : n.get();
        }
    }

    @Autowired
    protected JdbcClient jdbc;

    @Autowired
    protected KafkaTemplate<String, String> kafka;

    @Autowired
    protected FakeRecorder recorder;

    @Autowired
    protected FakeSandbox sandbox;

    protected UUID newUser() {
        return jdbc.sql("INSERT INTO users (username) VALUES (?) RETURNING id")
                .param("w" + UUID.randomUUID().toString().substring(0, 8)).query(UUID.class).single();
    }

    protected void publish(String topic, String key, String value) throws Exception {
        kafka.send(topic, key, value).get();
    }

    protected void awaitStatus(String table, UUID id, String status) throws InterruptedException {
        await(() -> status.equals(jdbc.sql("SELECT status FROM " + table + " WHERE id = ?").param(id)
                .query(String.class).single()), table + " " + id + " to be " + status);
    }

    protected static void await(BooleanSupplier condition, String what) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 60_000;
        while (!condition.getAsBoolean()) {
            if (System.currentTimeMillis() > deadline) {
                throw new AssertionError("timed out waiting for " + what);
            }
            Thread.sleep(100);
        }
    }
}

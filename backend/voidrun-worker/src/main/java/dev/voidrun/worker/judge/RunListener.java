package dev.voidrun.worker.judge;

import dev.voidrun.common.Topics;
import dev.voidrun.common.events.JudgeJob;
import org.apache.kafka.clients.consumer.ConsumerRecord;
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

/**
 * Consumes {@code voidrun.runs}: the editor's Run button. Someone is waiting
 * on the page, so these have their own consumer group and worker pool and
 * never queue behind a burst of submissions.
 *
 * <p>Same delivery rules as every worker topic: one record per poll, the
 * offset committed only after the result is in PostgreSQL, failures moved to
 * retry topics with backoff instead of blocking the partition, and a
 * dead-letter topic whose handler ends the job as INTERNAL_ERROR.
 */
@Component
public class RunListener {

    private final JudgeService judge;

    public RunListener(JudgeService judge) {
        this.judge = judge;
    }

    @RetryableTopic(
            attempts = "${voidrun.worker.judge.attempts:3}",
            backOff = @BackOff(delayString = "${voidrun.worker.judge.retry-delay-ms:1000}", multiplier = 2.0),
            exclude = JudgeService.UnjudgeableException.class,
            dltStrategy = DltStrategy.FAIL_ON_ERROR,
            numPartitions = "${voidrun.worker.topic-partitions:3}",
            replicationFactor = "${voidrun.worker.topic-replication-factor:1}")
    @KafkaListener(id = "run-judge", topics = Topics.RUNS, groupId = "voidrun-run-judges",
            concurrency = "${voidrun.worker.judge.run-concurrency:2}")
    public void onRun(ConsumerRecord<String, String> record, Acknowledgment ack) throws Exception {
        JudgeJob job = JudgeJobs.parse(record, JudgeJob.Kind.RUN);
        MDC.put("correlationId", job.correlationId() == null ? "" : job.correlationId());
        try {
            judge.judgeRun(job.id());
            ack.acknowledge();
        } finally {
            MDC.remove("correlationId");
        }
    }

    @DltHandler
    public void onDeadLetter(ConsumerRecord<String, String> record,
            @Header(name = KafkaHeaders.EXCEPTION_MESSAGE, required = false) String error, Acknowledgment ack) {
        judge.giveUp("RUN", JudgeJobs.idFromKey(record.key()), error, record.value(),
                JudgeJobs.isJson(record.value()), JudgeJobs.correlationId(record));
        ack.acknowledge();
    }
}

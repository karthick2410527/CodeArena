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
 * Consumes {@code voidrun.submissions}: practice submissions against the hidden tests.
 *
 * <p>Same delivery rules as every worker topic: one record per poll, the
 * offset committed only after the result is in PostgreSQL, failures moved to
 * retry topics with backoff instead of blocking the partition, and a
 * dead-letter topic whose handler ends the job as INTERNAL_ERROR.
 */
@Component
public class SubmissionListener {

    private final JudgeService judge;

    public SubmissionListener(JudgeService judge) {
        this.judge = judge;
    }

    @RetryableTopic(
            attempts = "${voidrun.worker.judge.attempts:3}",
            backOff = @BackOff(delayString = "${voidrun.worker.judge.retry-delay-ms:1000}", multiplier = 2.0),
            exclude = JudgeService.UnjudgeableException.class,
            dltStrategy = DltStrategy.FAIL_ON_ERROR,
            numPartitions = "${voidrun.worker.topic-partitions:3}",
            replicationFactor = "${voidrun.worker.topic-replication-factor:1}")
    @KafkaListener(id = "submission-judge", topics = Topics.SUBMISSIONS, groupId = "voidrun-submission-judges",
            concurrency = "${voidrun.worker.judge.submission-concurrency:2}")
    public void onSubmission(ConsumerRecord<String, String> record, Acknowledgment ack) throws Exception {
        JudgeJob job = JudgeJobs.parse(record, JudgeJob.Kind.SUBMISSION);
        MDC.put("correlationId", job.correlationId() == null ? "" : job.correlationId());
        try {
            judge.judgeSubmission(job.id());
            ack.acknowledge();
        } finally {
            MDC.remove("correlationId");
        }
    }

    @DltHandler
    public void onDeadLetter(ConsumerRecord<String, String> record,
            @Header(name = KafkaHeaders.EXCEPTION_MESSAGE, required = false) String error, Acknowledgment ack) {
        judge.giveUp("SUBMISSION", JudgeJobs.idFromKey(record.key()), error, record.value(),
                JudgeJobs.isJson(record.value()), JudgeJobs.correlationId(record));
        ack.acknowledge();
    }
}

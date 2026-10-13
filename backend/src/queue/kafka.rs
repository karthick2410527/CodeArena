//! Apache Kafka driver.
//!
//! * **Producer** — idempotent, `acks=all`, keyed by submission id so all
//!   events for one submission land on the same partition in order.
//! * **Consumer** — a real consumer group (`KAFKA_GROUP_ID`). Offsets are
//!   committed **manually, after** judging finishes, so a worker that dies
//!   mid-job has its partition reassigned and the job redelivered. That is
//!   at-least-once, which is why
//!   [`crate::judge::submissions::claim`] is guarded and idempotent.
//! * **Dead-letter topic** — a job that cannot succeed is produced to
//!   `KAFKA_DLQ_TOPIC` *and* recorded in `dead_letter_events`, so it is
//!   inspectable even if the broker is unavailable.
//!
//! Requires the `kafka` cargo feature, which builds librdkafka from source.

use super::{Delivery, JudgeJob, QueueError, Receipt};
use crate::config::Config;
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{CommitMode, Consumer as _, StreamConsumer};
use rdkafka::error::KafkaError;
use rdkafka::message::{Header, OwnedHeaders};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::{Message, Offset, TopicPartitionList};
use std::time::Duration;

fn transport(e: impl std::fmt::Display) -> QueueError {
    QueueError::Transport(e.to_string())
}

/// Produces judge jobs.
#[derive(Clone)]
pub struct KafkaPublisher {
    producer: FutureProducer,
    topic: String,
    dlq_topic: String,
}

impl KafkaPublisher {
    pub fn new(config: &Config) -> Result<Self, QueueError> {
        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", &config.kafka_brokers)
            // Wait for all in-sync replicas: a publish that returns Ok is durable.
            .set("acks", "all")
            // No silent duplicates from internal producer retries.
            .set("enable.idempotence", "true")
            .set("message.timeout.ms", "10000")
            .set("compression.type", "lz4")
            .set("client.id", format!("codearena-api-{}", config.worker_id))
            .create()
            .map_err(transport)?;
        Ok(Self {
            producer,
            topic: config.kafka_topic.clone(),
            dlq_topic: config.kafka_dlq_topic.clone(),
        })
    }

    async fn send(
        &self,
        topic: &str,
        job: &JudgeJob,
        extra: Option<(&str, &str)>,
    ) -> Result<(), QueueError> {
        let payload = serde_json::to_vec(job)
            .map_err(|e| QueueError::Malformed(format!("cannot encode job: {e}")))?;
        let key = job.submission_id.to_string();
        let mut headers = OwnedHeaders::new().insert(Header {
            key: "event_type",
            value: Some(JudgeJob::EVENT_TYPE),
        });
        if let Some(cid) = job.correlation_id.as_deref() {
            headers = headers.insert(Header {
                key: "correlation_id",
                value: Some(cid),
            });
        }
        if let Some((k, v)) = extra {
            headers = headers.insert(Header {
                key: k,
                value: Some(v),
            });
        }
        let record = FutureRecord::to(topic)
            .key(&key)
            .payload(&payload)
            .headers(headers);

        match self.producer.send(record, Duration::from_secs(10)).await {
            Ok(_) => Ok(()),
            Err((e, _msg)) => Err(transport(e)),
        }
    }

    pub async fn publish(&self, job: &JudgeJob) -> Result<(), QueueError> {
        self.send(&self.topic.clone(), job, None).await
    }

    pub async fn publish_dead_letter(
        &self,
        job: &JudgeJob,
        reason: &str,
    ) -> Result<(), QueueError> {
        self.send(&self.dlq_topic.clone(), job, Some(("dlq_reason", reason)))
            .await
    }
}

/// Consumes judge jobs as part of a consumer group.
pub struct KafkaConsumer {
    consumer: StreamConsumer,
    topic: String,
    poll_interval: Duration,
}

impl KafkaConsumer {
    pub fn new(config: &Config) -> Result<Self, QueueError> {
        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", &config.kafka_brokers)
            .set("group.id", &config.kafka_group_id)
            // Offsets are committed by hand, after the verdict is persisted.
            .set("enable.auto.commit", "false")
            // A new group starts at the beginning so no queued work is skipped.
            .set("auto.offset.reset", "earliest")
            .set("session.timeout.ms", "45000")
            .set("max.poll.interval.ms", "300000")
            .set(
                "client.id",
                format!("codearena-worker-{}", config.worker_id),
            )
            .create()
            .map_err(transport)?;
        consumer
            .subscribe(&[config.kafka_topic.as_str()])
            .map_err(transport)?;
        tracing::info!(
            brokers = %config.kafka_brokers,
            topic = %config.kafka_topic,
            group = %config.kafka_group_id,
            "subscribed to Kafka"
        );
        Ok(Self {
            consumer,
            topic: config.kafka_topic.clone(),
            poll_interval: config.queue_poll_interval,
        })
    }

    pub async fn next(&self) -> Result<Option<Delivery>, QueueError> {
        // A bounded wait keeps the worker loop responsive to shutdown signals.
        let received = tokio::time::timeout(
            self.poll_interval.max(Duration::from_millis(200)) * 5,
            self.consumer.recv(),
        )
        .await;
        let message = match received {
            Err(_) => return Ok(None), // nothing available right now
            Ok(Err(KafkaError::NoMessageReceived)) => return Ok(None),
            Ok(Err(e)) => return Err(transport(e)),
            Ok(Ok(m)) => m,
        };

        let partition = message.partition();
        let offset = message.offset();
        let Some(payload) = message.payload() else {
            tracing::warn!(partition, offset, "Kafka message with no payload; skipping");
            self.commit(partition, offset)?;
            return Ok(None);
        };
        match serde_json::from_slice::<JudgeJob>(payload) {
            Ok(job) => Ok(Some(Delivery {
                job,
                // Kafka does not expose a delivery count; the authoritative
                // attempt counter is `submissions.attempts`.
                delivery_count: 1,
                receipt: Receipt::Kafka { partition, offset },
            })),
            Err(e) => {
                // Unreadable messages are skipped rather than blocking the
                // partition forever.
                tracing::error!(partition, offset, error = %e, "unreadable Kafka payload; skipping");
                self.commit(partition, offset)?;
                Ok(None)
            }
        }
    }

    fn commit(&self, partition: i32, offset: i64) -> Result<(), QueueError> {
        let mut tpl = TopicPartitionList::new();
        // Committing `offset + 1` marks this message as consumed.
        tpl.add_partition_offset(&self.topic, partition, Offset::Offset(offset + 1))
            .map_err(transport)?;
        self.consumer
            .commit(&tpl, CommitMode::Sync)
            .map_err(transport)
    }

    pub async fn ack(&self, receipt: &Receipt) -> Result<(), QueueError> {
        let Receipt::Kafka { partition, offset } = receipt else {
            return Err(QueueError::Transport(
                "receipt does not belong to the Kafka driver".into(),
            ));
        };
        self.commit(*partition, *offset)
    }

    /// Leaves the offset uncommitted so the job is redelivered after the delay.
    pub async fn nack(
        &self,
        receipt: &Receipt,
        delay: Duration,
        reason: &str,
    ) -> Result<(), QueueError> {
        let Receipt::Kafka { partition, offset } = receipt else {
            return Err(QueueError::Transport(
                "receipt does not belong to the Kafka driver".into(),
            ));
        };
        tracing::warn!(
            partition,
            offset,
            reason,
            delay_ms = delay.as_millis() as u64,
            "job not acknowledged; it will be redelivered"
        );
        // Rewind to this message so the next poll returns it again, after a
        // pause that gives a transient failure time to clear.
        let mut tpl = TopicPartitionList::new();
        tpl.add_partition_offset(&self.topic, *partition, Offset::Offset(*offset))
            .map_err(transport)?;
        self.consumer.assign(&tpl).map_err(transport)?;
        tokio::time::sleep(delay).await;
        Ok(())
    }
}

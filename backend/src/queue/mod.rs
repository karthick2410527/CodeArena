//! The judge job queue.
//!
//! ## The dual-write problem, and what is actually done about it
//!
//! `POST /submissions` has to do two things: persist a `QUEUED` submission and
//! make a job available to workers. A database commit and a Kafka publish are
//! **not** atomic — a crash between them either loses the job or advertises a
//! submission that does not exist.
//!
//! This project does not pretend otherwise. Instead, the submission row and an
//! `outbox_events` row are written in **one PostgreSQL transaction**
//! ([`outbox::enqueue`]). Delivery is then a separate, retryable step:
//!
//! * **Kafka driver** — [`outbox::publish_pending`] moves unpublished rows to
//!   the topic and stamps `published_at`. If the broker is down, rows stay
//!   pending and are retried with backoff; nothing is lost.
//! * **PostgreSQL driver** — the outbox table *is* the queue. Workers claim
//!   rows with a visibility timeout, so a worker that dies mid-job simply has
//!   its job redelivered.
//!
//! Both give **at-least-once** delivery, which is why
//! [`crate::judge::submissions::claim`] is idempotent and guarded.
//!
//! On top of that, [`outbox::reconcile_stale`] re-enqueues submissions that are
//! still unfinished long after their job was delivered — the case where a
//! worker acknowledged a message and then crashed.

pub mod outbox;

#[cfg(feature = "kafka")]
pub mod kafka;

use crate::config::{Config, QueueDriver};
use crate::observability::metrics;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

/// The message put on the queue.
///
/// Deliberately minimal: an id and the metadata needed to route and trace the
/// job. Source code and test data stay in PostgreSQL, so the queue never
/// carries hidden test data and a topic dump leaks nothing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JudgeJob {
    pub submission_id: Uuid,
    pub problem_id: Uuid,
    pub user_id: Uuid,
    pub language: String,
    /// Follows the request through API logs, the queue and the worker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    pub enqueued_at: chrono::DateTime<chrono::Utc>,
}

impl JudgeJob {
    pub const EVENT_TYPE: &'static str = "submission.created";
}

#[derive(Debug, thiserror::Error)]
pub enum QueueError {
    #[error("queue transport failure: {0}")]
    Transport(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("malformed job payload: {0}")]
    Malformed(String),
}

/// A job handed to a worker, plus whatever the driver needs to acknowledge it.
#[derive(Debug)]
pub struct Delivery {
    pub job: JudgeJob,
    /// How many times this job has been delivered (1 on first delivery).
    pub delivery_count: i32,
    pub receipt: Receipt,
}

/// Driver-specific acknowledgement handle.
#[derive(Debug, Clone)]
pub enum Receipt {
    /// `outbox_events.id`.
    Outbox(i64),
    /// Kafka commits by offset; the consumer holds the position itself.
    #[cfg(feature = "kafka")]
    Kafka { partition: i32, offset: i64 },
}

/// Publishes jobs. Held by the API (to write outbox rows) and by the outbox
/// publisher (to move them onward).
#[derive(Clone)]
pub enum Publisher {
    /// The outbox table is the queue; nothing else to do.
    Postgres,
    #[cfg(feature = "kafka")]
    Kafka(kafka::KafkaPublisher),
}

impl Publisher {
    pub async fn from_config(config: &Config) -> Result<Self, QueueError> {
        match config.queue_driver {
            QueueDriver::Postgres => Ok(Self::Postgres),
            #[cfg(feature = "kafka")]
            QueueDriver::Kafka => Ok(Self::Kafka(kafka::KafkaPublisher::new(config)?)),
            #[cfg(not(feature = "kafka"))]
            QueueDriver::Kafka => Err(QueueError::Transport(
                "this binary was built without the `kafka` feature".into(),
            )),
        }
    }

    pub fn driver(&self) -> &'static str {
        match self {
            Self::Postgres => "postgres",
            #[cfg(feature = "kafka")]
            Self::Kafka(_) => "kafka",
        }
    }

    /// Delivers a job to the transport. For the PostgreSQL driver this is a
    /// no-op: the row written inside the API's transaction *is* the delivery.
    pub async fn publish(&self, job: &JudgeJob) -> Result<(), QueueError> {
        // `job` is unused when the crate is built without the `kafka` feature,
        // because the PostgreSQL driver needs nothing from it.
        let _ = job;
        let result = match self {
            Self::Postgres => Ok(()),
            #[cfg(feature = "kafka")]
            Self::Kafka(p) => p.publish(job).await,
        };
        metrics::record_queue_publish(self.driver(), if result.is_ok() { "ok" } else { "error" });
        result
    }

    /// Sends a job that will never succeed to the dead-letter path, so it can
    /// be inspected and replayed instead of disappearing.
    pub async fn dead_letter(
        &self,
        pool: &PgPool,
        job: &JudgeJob,
        reason: &str,
    ) -> Result<(), QueueError> {
        // The database record is authoritative and always written, so a
        // dead-lettered job is inspectable even with Kafka down.
        outbox::record_dead_letter(pool, job, reason).await?;
        #[cfg(feature = "kafka")]
        if let Self::Kafka(p) = self {
            if let Err(e) = p.publish_dead_letter(job, reason).await {
                tracing::warn!(error = %e, "dead-letter topic publish failed; database record kept");
            }
        }
        metrics::record_dead_letter(reason);
        Ok(())
    }
}

/// Consumes jobs. Lives in the worker.
pub enum Consumer {
    Postgres(outbox::OutboxConsumer),
    #[cfg(feature = "kafka")]
    Kafka(kafka::KafkaConsumer),
}

impl Consumer {
    pub async fn from_config(config: &Config, pool: PgPool) -> Result<Self, QueueError> {
        match config.queue_driver {
            QueueDriver::Postgres => Ok(Self::Postgres(outbox::OutboxConsumer::new(
                pool,
                config.claim_timeout,
                config.queue_poll_interval,
            ))),
            #[cfg(feature = "kafka")]
            QueueDriver::Kafka => Ok(Self::Kafka(kafka::KafkaConsumer::new(config)?)),
            #[cfg(not(feature = "kafka"))]
            QueueDriver::Kafka => Err(QueueError::Transport(
                "this binary was built without the `kafka` feature".into(),
            )),
        }
    }

    pub fn driver(&self) -> &'static str {
        match self {
            Self::Postgres(_) => "postgres",
            #[cfg(feature = "kafka")]
            Self::Kafka(_) => "kafka",
        }
    }

    /// Waits for the next job. `Ok(None)` means "nothing right now".
    pub async fn next(&mut self) -> Result<Option<Delivery>, QueueError> {
        match self {
            Self::Postgres(c) => c.next().await,
            #[cfg(feature = "kafka")]
            Self::Kafka(c) => c.next().await,
        }
    }

    /// The job is done (whatever the verdict) and must not be redelivered.
    pub async fn ack(&self, delivery: &Delivery) -> Result<(), QueueError> {
        match self {
            Self::Postgres(c) => c.ack(&delivery.receipt).await,
            #[cfg(feature = "kafka")]
            Self::Kafka(c) => c.ack(&delivery.receipt).await,
        }
    }

    /// The job failed transiently: redeliver it after `delay`.
    pub async fn nack(
        &self,
        delivery: &Delivery,
        delay: std::time::Duration,
        reason: &str,
    ) -> Result<(), QueueError> {
        match self {
            Self::Postgres(c) => c.nack(&delivery.receipt, delay, reason).await,
            #[cfg(feature = "kafka")]
            Self::Kafka(c) => c.nack(&delivery.receipt, delay, reason).await,
        }
    }
}

/// Bounded exponential backoff: `base * 2^(attempt-1)`, capped at 60s.
pub fn backoff(base: std::time::Duration, attempt: i32) -> std::time::Duration {
    let shift = attempt.clamp(1, 10) - 1;
    let factor = 1u32 << shift;
    std::cmp::min(base * factor, std::time::Duration::from_secs(60))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn jobs_round_trip_as_json() {
        let job = JudgeJob {
            submission_id: Uuid::new_v4(),
            problem_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            language: "cpp17".into(),
            correlation_id: Some("abc123".into()),
            enqueued_at: chrono::Utc::now(),
        };
        let raw = serde_json::to_string(&job).unwrap();
        let back: JudgeJob = serde_json::from_str(&raw).unwrap();
        assert_eq!(job, back);
    }

    #[test]
    fn jobs_never_carry_code_or_test_data() {
        let job = JudgeJob {
            submission_id: Uuid::new_v4(),
            problem_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            language: "cpp17".into(),
            correlation_id: None,
            enqueued_at: chrono::Utc::now(),
        };
        let raw = serde_json::to_string(&job).unwrap();
        for forbidden in ["source", "code", "expected", "input", "test"] {
            assert!(
                !raw.contains(forbidden),
                "queue payload must not contain {forbidden:?}: {raw}"
            );
        }
    }

    #[test]
    fn a_missing_correlation_id_is_optional_on_the_wire() {
        let raw = r#"{"submission_id":"00000000-0000-0000-0000-000000000001",
                      "problem_id":"00000000-0000-0000-0000-000000000002",
                      "user_id":"00000000-0000-0000-0000-000000000003",
                      "language":"cpp17",
                      "enqueued_at":"2026-01-01T00:00:00Z"}"#;
        let job: JudgeJob = serde_json::from_str(raw).unwrap();
        assert_eq!(job.correlation_id, None);
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        let base = Duration::from_millis(500);
        assert_eq!(backoff(base, 1), Duration::from_millis(500));
        assert_eq!(backoff(base, 2), Duration::from_secs(1));
        assert_eq!(backoff(base, 3), Duration::from_secs(2));
        assert_eq!(backoff(base, 10), Duration::from_secs(60));
        // Never unbounded, whatever the attempt number.
        assert_eq!(backoff(base, 9999), Duration::from_secs(60));
        // Nonsensical attempts behave like the first one.
        assert_eq!(backoff(base, 0), Duration::from_millis(500));
    }
}

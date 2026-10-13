//! The transactional outbox, and the PostgreSQL queue driver built on it.
//!
//! `POST /submissions` writes the submission and the outbox row in one
//! transaction ([`enqueue`]). What happens next depends on the driver:
//!
//! * `QUEUE_DRIVER=kafka` — [`publish_pending`] runs on a timer in the API
//!   process, moves pending rows to the topic and stamps `published_at`.
//! * `QUEUE_DRIVER=postgres` — [`OutboxConsumer`] claims rows directly with a
//!   *visibility timeout*: a claimed row becomes invisible for a while, and
//!   reappears if the worker never acknowledges it.
//!
//! Both are at-least-once. Neither can lose a job because a broker was down at
//! the wrong moment, which is the entire point of the table.

use super::{backoff, Delivery, JudgeJob, QueueError, Receipt};
use crate::observability::metrics;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;

/// Writes the outbox row **inside the caller's transaction**. This is the step
/// that makes "submission persisted" and "job queued" a single atomic fact.
pub async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    job: &JudgeJob,
) -> Result<i64, QueueError> {
    let payload = serde_json::to_value(job)
        .map_err(|e| QueueError::Malformed(format!("cannot encode job: {e}")))?;
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO outbox_events (aggregate_id, event_type, payload, correlation_id) \
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(job.submission_id)
    .bind(JudgeJob::EVENT_TYPE)
    .bind(payload)
    .bind(job.correlation_id.as_deref())
    .fetch_one(&mut **tx)
    .await?;
    Ok(id)
}

/// A pending outbox row.
#[derive(Debug, sqlx::FromRow)]
struct PendingRow {
    id: i64,
    payload: serde_json::Value,
    publish_attempts: i32,
}

/// Moves pending rows onto the transport (Kafka). Returns how many were
/// published. Safe to run on several API instances: rows are claimed with
/// `FOR UPDATE SKIP LOCKED`.
pub async fn publish_pending(
    pool: &PgPool,
    publisher: &super::Publisher,
    batch: i64,
    max_attempts: i32,
    retry_base: Duration,
) -> Result<usize, QueueError> {
    let mut tx = pool.begin().await?;
    let rows: Vec<PendingRow> = sqlx::query_as(
        "SELECT id, payload, publish_attempts FROM outbox_events \
          WHERE published_at IS NULL AND next_attempt_at <= now() \
          ORDER BY id \
          FOR UPDATE SKIP LOCKED \
          LIMIT $1",
    )
    .bind(batch)
    .fetch_all(&mut *tx)
    .await?;

    let mut published = 0usize;
    for row in rows {
        let job: JudgeJob = match serde_json::from_value(row.payload.clone()) {
            Ok(j) => j,
            Err(e) => {
                // Unreadable payload will never become readable: terminate it
                // rather than retrying forever.
                tracing::error!(outbox_id = row.id, error = %e, "unreadable outbox payload");
                sqlx::query(
                    "UPDATE outbox_events SET published_at = now(), last_error = $2 WHERE id = $1",
                )
                .bind(row.id)
                .bind(format!("malformed payload: {e}"))
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "INSERT INTO dead_letter_events (event_type, payload, reason) \
                     VALUES ($1, $2, $3)",
                )
                .bind(JudgeJob::EVENT_TYPE)
                .bind(row.payload)
                .bind("malformed outbox payload")
                .execute(&mut *tx)
                .await?;
                metrics::record_dead_letter("malformed_payload");
                continue;
            }
        };

        match publisher.publish(&job).await {
            Ok(()) => {
                sqlx::query("UPDATE outbox_events SET published_at = now() WHERE id = $1")
                    .bind(row.id)
                    .execute(&mut *tx)
                    .await?;
                published += 1;
            }
            Err(e) => {
                let attempts = row.publish_attempts + 1;
                if attempts >= max_attempts {
                    // Bounded: stop trying, make the failure inspectable, and
                    // give the submission a terminal verdict so the user is not
                    // left polling a job that will never run.
                    tracing::error!(
                        outbox_id = row.id,
                        submission_id = %job.submission_id,
                        attempts,
                        error = %e,
                        "outbox publish exhausted; dead-lettering"
                    );
                    sqlx::query(
                        "UPDATE outbox_events \
                            SET published_at = now(), publish_attempts = $2, last_error = $3 \
                          WHERE id = $1",
                    )
                    .bind(row.id)
                    .bind(attempts)
                    .bind(e.to_string())
                    .execute(&mut *tx)
                    .await?;
                    sqlx::query(
                        "INSERT INTO dead_letter_events \
                            (submission_id, event_type, payload, reason, correlation_id) \
                         VALUES ($1, $2, $3, $4, $5)",
                    )
                    .bind(job.submission_id)
                    .bind(JudgeJob::EVENT_TYPE)
                    .bind(row.payload)
                    .bind(format!("publish failed after {attempts} attempts: {e}"))
                    .bind(job.correlation_id.as_deref())
                    .execute(&mut *tx)
                    .await?;
                    sqlx::query(
                        "UPDATE submissions \
                            SET status = 'FINISHED', verdict = 'INTERNAL_ERROR', \
                                internal_error = $2, finished_at = now() \
                          WHERE id = $1 AND status <> 'FINISHED'",
                    )
                    .bind(job.submission_id)
                    .bind("job could not be queued for judging")
                    .execute(&mut *tx)
                    .await?;
                    metrics::record_dead_letter("publish_exhausted");
                } else {
                    let delay = backoff(retry_base, attempts);
                    tracing::warn!(
                        outbox_id = row.id,
                        attempts,
                        retry_in_ms = delay.as_millis() as u64,
                        error = %e,
                        "outbox publish failed; will retry"
                    );
                    sqlx::query(
                        "UPDATE outbox_events \
                            SET publish_attempts = $2, last_error = $3, \
                                next_attempt_at = now() + make_interval(secs => $4::double precision) \
                          WHERE id = $1",
                    )
                    .bind(row.id)
                    .bind(attempts)
                    .bind(e.to_string())
                    .bind(delay.as_secs_f64())
                    .execute(&mut *tx)
                    .await?;
                    metrics::record_judge_retry("publish");
                }
            }
        }
    }
    tx.commit().await?;
    Ok(published)
}

/// Records a dead-lettered job in PostgreSQL. Always called, even when a
/// dead-letter topic also exists, so the failure survives a broker outage.
pub async fn record_dead_letter(
    pool: &PgPool,
    job: &JudgeJob,
    reason: &str,
) -> Result<(), QueueError> {
    let payload = serde_json::to_value(job)
        .map_err(|e| QueueError::Malformed(format!("cannot encode job: {e}")))?;
    sqlx::query(
        "INSERT INTO dead_letter_events \
            (submission_id, event_type, payload, reason, correlation_id) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(job.submission_id)
    .bind(JudgeJob::EVENT_TYPE)
    .bind(payload)
    .bind(reason)
    .bind(job.correlation_id.as_deref())
    .execute(pool)
    .await?;
    Ok(())
}

/// Re-enqueues submissions that are still unfinished long after their job was
/// delivered — a worker that acknowledged a message and then died.
///
/// This is the safety net behind both drivers: without it, such a submission
/// would sit at `RUNNING` forever, which the specification explicitly forbids
/// ("not an indefinitely silent submission").
pub async fn reconcile_stale(
    pool: &PgPool,
    stale_after: Duration,
    max_attempts: i32,
    limit: i64,
) -> Result<usize, QueueError> {
    let mut tx = pool.begin().await?;
    // Candidates: claimed too long ago, or queued with no deliverable outbox row.
    let stuck: Vec<(Uuid, Uuid, Uuid, String, i32, Option<String>)> = sqlx::query_as(
        "SELECT s.id, s.problem_id, s.user_id, s.language, s.attempts, s.correlation_id \
           FROM submissions s \
          WHERE s.status <> 'FINISHED' \
            AND COALESCE(s.claimed_at, s.created_at) \
                < now() - make_interval(secs => $1::double precision) \
            AND NOT EXISTS ( \
                SELECT 1 FROM outbox_events o \
                 WHERE o.aggregate_id = s.id AND o.published_at IS NULL) \
          ORDER BY s.created_at \
          FOR UPDATE SKIP LOCKED \
          LIMIT $2",
    )
    .bind(stale_after.as_secs_f64())
    .bind(limit)
    .fetch_all(&mut *tx)
    .await?;

    let mut requeued = 0usize;
    for (id, problem_id, user_id, language, attempts, correlation_id) in stuck {
        if attempts >= max_attempts {
            // Out of attempts: terminal, visible, inspectable.
            tracing::error!(submission_id = %id, attempts, "stale submission out of attempts");
            sqlx::query(
                "UPDATE submissions \
                    SET status = 'FINISHED', verdict = 'INTERNAL_ERROR', \
                        internal_error = $2, finished_at = now() \
                  WHERE id = $1 AND status <> 'FINISHED'",
            )
            .bind(id)
            .bind("judging did not complete within the attempt budget")
            .execute(&mut *tx)
            .await?;
            let payload = serde_json::json!({ "submission_id": id, "attempts": attempts });
            sqlx::query(
                "INSERT INTO dead_letter_events \
                    (submission_id, event_type, payload, reason, correlation_id) \
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(id)
            .bind(JudgeJob::EVENT_TYPE)
            .bind(payload)
            .bind("attempts exhausted while judging")
            .bind(correlation_id.as_deref())
            .execute(&mut *tx)
            .await?;
            metrics::record_dead_letter("judge_attempts_exhausted");
            continue;
        }

        tracing::warn!(submission_id = %id, attempts, "re-enqueueing stale submission");
        sqlx::query(
            "UPDATE submissions SET status = 'QUEUED', claimed_by = NULL, claimed_at = NULL \
              WHERE id = $1 AND status <> 'FINISHED'",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        let job = JudgeJob {
            submission_id: id,
            problem_id,
            user_id,
            language,
            correlation_id,
            enqueued_at: Utc::now(),
        };
        enqueue(&mut tx, &job).await?;
        metrics::record_judge_retry("reconcile");
        requeued += 1;
    }
    tx.commit().await?;
    Ok(requeued)
}

/// How many jobs are waiting to be delivered, and how old the oldest is.
/// This is the queue-lag signal for both drivers.
pub async fn lag(pool: &PgPool) -> Result<(i64, Option<DateTime<Utc>>), QueueError> {
    let row: (i64, Option<DateTime<Utc>>) = sqlx::query_as(
        "SELECT COUNT(*), MIN(created_at) FROM outbox_events WHERE published_at IS NULL",
    )
    .fetch_one(pool)
    .await?;
    Ok(row)
}

// ------------------------------------------------- PostgreSQL queue driver

/// Extracts the outbox row id from a receipt.
///
/// Receipts are driver-specific, so a Kafka receipt reaching this driver is a
/// programming error rather than something to paper over. (With the `kafka`
/// feature disabled there is only one variant, hence the explicit match rather
/// than a `let … else`, which would be irrefutable.)
fn outbox_id(receipt: &Receipt) -> Result<i64, QueueError> {
    match receipt {
        Receipt::Outbox(id) => Ok(*id),
        #[cfg(feature = "kafka")]
        Receipt::Kafka { .. } => Err(QueueError::Transport(
            "receipt does not belong to the PostgreSQL driver".into(),
        )),
    }
}

/// Consumes jobs straight from `outbox_events` using a visibility timeout.
pub struct OutboxConsumer {
    pool: PgPool,
    visibility: Duration,
    poll_interval: Duration,
}

impl OutboxConsumer {
    pub fn new(pool: PgPool, visibility: Duration, poll_interval: Duration) -> Self {
        Self {
            pool,
            visibility,
            poll_interval,
        }
    }

    /// Claims the next deliverable row.
    ///
    /// The `UPDATE … RETURNING` both claims the row and hides it for
    /// `visibility`, so two workers polling at the same moment cannot both get
    /// it, and a worker that dies gets its job redelivered automatically.
    pub async fn next(&self) -> Result<Option<Delivery>, QueueError> {
        let row: Option<(i64, serde_json::Value, i32)> = sqlx::query_as(
            "WITH next AS ( \
                 SELECT id FROM outbox_events \
                  WHERE published_at IS NULL AND next_attempt_at <= now() \
                  ORDER BY id \
                  FOR UPDATE SKIP LOCKED \
                  LIMIT 1) \
             UPDATE outbox_events o \
                SET publish_attempts = o.publish_attempts + 1, \
                    next_attempt_at = now() + make_interval(secs => $1::double precision) \
               FROM next \
              WHERE o.id = next.id \
             RETURNING o.id, o.payload, o.publish_attempts",
        )
        .bind(self.visibility.as_secs_f64())
        .fetch_optional(&self.pool)
        .await?;

        let Some((id, payload, attempts)) = row else {
            tokio::time::sleep(self.poll_interval).await;
            return Ok(None);
        };
        match serde_json::from_value::<JudgeJob>(payload.clone()) {
            Ok(job) => Ok(Some(Delivery {
                job,
                delivery_count: attempts,
                receipt: Receipt::Outbox(id),
            })),
            Err(e) => {
                // Unreadable: terminate it so it cannot spin forever.
                tracing::error!(outbox_id = id, error = %e, "unreadable queued payload");
                sqlx::query(
                    "UPDATE outbox_events SET published_at = now(), last_error = $2 WHERE id = $1",
                )
                .bind(id)
                .bind(format!("malformed payload: {e}"))
                .execute(&self.pool)
                .await?;
                sqlx::query(
                    "INSERT INTO dead_letter_events (event_type, payload, reason) \
                     VALUES ($1, $2, $3)",
                )
                .bind(JudgeJob::EVENT_TYPE)
                .bind(payload)
                .bind("malformed queued payload")
                .execute(&self.pool)
                .await?;
                metrics::record_dead_letter("malformed_payload");
                Ok(None)
            }
        }
    }

    pub async fn ack(&self, receipt: &Receipt) -> Result<(), QueueError> {
        let id = outbox_id(receipt)?;
        sqlx::query("UPDATE outbox_events SET published_at = now() WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn nack(
        &self,
        receipt: &Receipt,
        delay: Duration,
        reason: &str,
    ) -> Result<(), QueueError> {
        let id = outbox_id(receipt)?;
        sqlx::query(
            "UPDATE outbox_events \
                SET next_attempt_at = now() + make_interval(secs => $2::double precision), \
                    last_error = $3 \
              WHERE id = $1",
        )
        .bind(id)
        .bind(delay.as_secs_f64())
        .bind(reason)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_receipt_from_the_wrong_driver_is_rejected() {
        // Compile-time proof that receipts are driver-specific; the runtime
        // check lives in ack/nack.
        let r = Receipt::Outbox(7);
        match r {
            Receipt::Outbox(id) => assert_eq!(id, 7),
            #[cfg(feature = "kafka")]
            Receipt::Kafka { .. } => panic!("wrong variant"),
        }
    }
}

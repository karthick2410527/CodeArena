//! The judge worker.
//!
//! One process, four concurrent loops:
//!
//! | Loop | Job |
//! |---|---|
//! | submissions | consume the queue, judge against hidden tests |
//! | runs | claim `runs` rows, execute samples/custom input |
//! | maintenance | heartbeat, re-enqueue stale work, purge expired runs |
//! | publisher | move outbox rows to Kafka (Kafka driver only) |
//!
//! All of them stop on `Ctrl-C`/`SIGTERM` so a rolling restart does not abandon
//! a claimed job: the loops finish what they are doing, and anything still
//! claimed is recovered by the maintenance loop on another instance.
//!
//! ## Bounded retries
//!
//! A *transient* failure (sandbox could not start, database blipped) leaves the
//! submission claimed, does not acknowledge the message, and asks for
//! redelivery after [`crate::queue::backoff`]. The attempt counter lives in
//! `submissions.attempts`, so the budget is enforced across worker restarts and
//! across redeliveries, not per process. When it runs out the job is
//! dead-lettered and the submission gets a terminal `INTERNAL_ERROR` — never an
//! indefinite silence.

use crate::config::Config;
use crate::judge::{runs, submissions};
use crate::observability::metrics;
use crate::queue::{backoff, outbox, Consumer, Publisher};
use crate::runner::Runner;
use sqlx::PgPool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use uuid::Uuid;

/// Counters reported through the heartbeat.
#[derive(Default)]
pub struct WorkerStats {
    pub submissions_judged: AtomicU64,
    pub runs_executed: AtomicU64,
    pub failures: AtomicU64,
}

/// Shared worker context.
pub struct WorkerContext {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub runner: Runner,
    pub stats: WorkerStats,
    /// Set when shutdown has been requested.
    pub shutdown: Arc<Notify>,
    pub stopping: Arc<std::sync::atomic::AtomicBool>,
}

impl WorkerContext {
    pub fn new(pool: PgPool, config: Arc<Config>) -> Self {
        let runner = Runner::from_config(&config);
        Self {
            pool,
            config,
            runner,
            stats: WorkerStats::default(),
            shutdown: Arc::new(Notify::new()),
            stopping: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Relaxed)
    }

    pub fn request_shutdown(&self) {
        self.stopping.store(true, Ordering::Relaxed);
        self.shutdown.notify_waiters();
    }

    /// Sleeps, unless shutdown is requested first.
    async fn sleep_or_stop(&self, d: Duration) {
        tokio::select! {
            _ = tokio::time::sleep(d) => {}
            _ = self.shutdown.notified() => {}
        }
    }
}

/// Registers this worker and refreshes its heartbeat.
pub async fn heartbeat(ctx: &WorkerContext, current: Option<Uuid>) {
    let result = sqlx::query(
        "INSERT INTO worker_heartbeats \
            (worker_id, queue_driver, runner_strategy, version, submissions_judged, \
             runs_executed, failures, current_submission_id) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) \
         ON CONFLICT (worker_id) DO UPDATE SET \
             last_seen_at = now(), \
             queue_driver = EXCLUDED.queue_driver, \
             runner_strategy = EXCLUDED.runner_strategy, \
             version = EXCLUDED.version, \
             submissions_judged = EXCLUDED.submissions_judged, \
             runs_executed = EXCLUDED.runs_executed, \
             failures = EXCLUDED.failures, \
             current_submission_id = EXCLUDED.current_submission_id",
    )
    .bind(&ctx.config.worker_id)
    .bind(ctx.config.queue_driver.as_str())
    .bind(ctx.config.runner_strategy.as_str())
    .bind(env!("CARGO_PKG_VERSION"))
    .bind(ctx.stats.submissions_judged.load(Ordering::Relaxed) as i64)
    .bind(ctx.stats.runs_executed.load(Ordering::Relaxed) as i64)
    .bind(ctx.stats.failures.load(Ordering::Relaxed) as i64)
    .bind(current)
    .execute(&ctx.pool)
    .await;
    if let Err(e) = result {
        // A missed heartbeat makes this worker look unhealthy, which is the
        // correct, visible outcome — so log it and carry on.
        tracing::warn!(error = %e, "heartbeat failed");
    }
}

/// Consumes judge jobs until shutdown.
pub async fn run_submission_loop(ctx: Arc<WorkerContext>, mut consumer: Consumer) {
    tracing::info!(
        worker_id = %ctx.config.worker_id,
        driver = consumer.driver(),
        "submission loop started"
    );
    while !ctx.is_stopping() {
        let delivery = match consumer.next().await {
            Ok(Some(d)) => d,
            Ok(None) => continue,
            Err(e) => {
                tracing::error!(error = %e, "queue read failed");
                ctx.stats.failures.fetch_add(1, Ordering::Relaxed);
                ctx.sleep_or_stop(Duration::from_secs(1)).await;
                continue;
            }
        };

        let submission_id = delivery.job.submission_id;
        let correlation = delivery
            .job
            .correlation_id
            .clone()
            .unwrap_or_else(crate::observability::new_correlation_id);
        let span = tracing::info_span!(
            "judge",
            %submission_id,
            correlation_id = %correlation,
            delivery = delivery.delivery_count
        );
        let _guard = span.enter();

        heartbeat(&ctx, Some(submission_id)).await;

        // Guarded claim. The three rejections are deliberately handled
        // differently.
        let claimed = submissions::claim(
            &ctx.pool,
            submission_id,
            &ctx.config.worker_id,
            ctx.config.max_judge_attempts,
        )
        .await;

        match claimed {
            Ok(Ok(submission)) => {
                let attempt = submission.attempts;
                drop(_guard);
                match submissions::judge(&ctx.pool, &ctx.runner, &ctx.config, submission).await {
                    Ok(report) => {
                        ctx.stats.submissions_judged.fetch_add(1, Ordering::Relaxed);
                        if let Err(e) = consumer.ack(&delivery).await {
                            tracing::error!(error = %e, "could not acknowledge a judged job");
                        }
                        tracing::debug!(verdict = report.verdict.as_str(), "job acknowledged");
                    }
                    Err(e) => {
                        // Infrastructure failure: this is what the attempt
                        // budget exists for.
                        ctx.stats.failures.fetch_add(1, Ordering::Relaxed);
                        submissions::release(&ctx.pool, submission_id).await;
                        if attempt >= ctx.config.max_judge_attempts {
                            tracing::error!(
                                %submission_id, attempt, error = %e,
                                "judge attempts exhausted; dead-lettering"
                            );
                            submissions::finish_with_internal_error(
                                &ctx.pool,
                                submission_id,
                                &format!("judging failed after {attempt} attempts: {e}"),
                            )
                            .await;
                            let publisher = Publisher::Postgres;
                            if let Err(e) = publisher
                                .dead_letter(&ctx.pool, &delivery.job, "judge attempts exhausted")
                                .await
                            {
                                tracing::error!(error = %e, "could not record dead letter");
                            }
                            // Acknowledge: redelivering it cannot help.
                            let _ = consumer.ack(&delivery).await;
                        } else {
                            let delay = backoff(ctx.config.judge_retry_base, attempt);
                            metrics::record_judge_retry("judge");
                            tracing::warn!(
                                %submission_id, attempt, error = %e,
                                retry_in_ms = delay.as_millis() as u64,
                                "transient judge failure; will retry"
                            );
                            if let Err(e) = consumer.nack(&delivery, delay, &e.to_string()).await {
                                tracing::error!(error = %e, "could not requeue a failed job");
                            }
                        }
                    }
                }
            }
            // Already judged: a duplicate delivery. Acknowledge and move on —
            // this is the case that must not produce a conflicting result.
            Ok(Err(submissions::ClaimRejection::AlreadyFinished)) => {
                tracing::info!(%submission_id, "duplicate delivery for a finished submission; ignored");
                drop(_guard);
                let _ = consumer.ack(&delivery).await;
            }
            Ok(Err(submissions::ClaimRejection::NotFound)) => {
                tracing::warn!(%submission_id, "job refers to a submission that no longer exists");
                drop(_guard);
                let _ = consumer.ack(&delivery).await;
            }
            Ok(Err(submissions::ClaimRejection::AttemptsExhausted)) => {
                tracing::error!(%submission_id, "attempt budget exhausted; dead-lettering");
                drop(_guard);
                submissions::finish_with_internal_error(
                    &ctx.pool,
                    submission_id,
                    "judging exceeded the attempt budget",
                )
                .await;
                let publisher = Publisher::Postgres;
                let _ = publisher
                    .dead_letter(&ctx.pool, &delivery.job, "attempt budget exhausted")
                    .await;
                let _ = consumer.ack(&delivery).await;
            }
            Err(e) => {
                tracing::error!(%submission_id, error = %e, "claim failed");
                ctx.stats.failures.fetch_add(1, Ordering::Relaxed);
                drop(_guard);
                let _ = consumer
                    .nack(&delivery, Duration::from_secs(1), "claim failed")
                    .await;
            }
        }
        heartbeat(&ctx, None).await;
    }
    tracing::info!("submission loop stopped");
}

/// Claims and executes queued runs until shutdown.
pub async fn run_run_loop(ctx: Arc<WorkerContext>) {
    tracing::info!("run loop started");
    while !ctx.is_stopping() {
        let claimed = runs::claim_next(
            &ctx.pool,
            &ctx.config.worker_id,
            ctx.config.claim_timeout.as_secs() as i64,
        )
        .await;
        let run = match claimed {
            Ok(Some(r)) => r,
            Ok(None) => {
                ctx.sleep_or_stop(ctx.config.queue_poll_interval).await;
                continue;
            }
            Err(e) => {
                tracing::error!(error = %e, "could not claim a run");
                ctx.stats.failures.fetch_add(1, Ordering::Relaxed);
                ctx.sleep_or_stop(Duration::from_secs(1)).await;
                continue;
            }
        };

        let run_id = run.id;
        let attempts = run.attempts;
        let span = tracing::info_span!(
            "run",
            %run_id,
            correlation_id = run.correlation_id.as_deref().unwrap_or("-")
        );
        let _guard = span.enter();
        let max_attempts = ctx.config.max_judge_attempts;
        drop(_guard);

        match runs::execute_run(&ctx.pool, &ctx.runner, run).await {
            Ok(outcome) => {
                ctx.stats.runs_executed.fetch_add(1, Ordering::Relaxed);
                tracing::debug!(%run_id, outcome = outcome.as_str(), "run finished");
            }
            Err(e) => {
                ctx.stats.failures.fetch_add(1, Ordering::Relaxed);
                if attempts >= max_attempts {
                    // Terminal: the user gets a clear "try again" instead of a
                    // run stuck at RUNNING forever.
                    runs::finish_internal(
                        &ctx.pool,
                        run_id,
                        &format!("run failed after {attempts} attempts: {e}"),
                    )
                    .await;
                } else {
                    tracing::warn!(%run_id, attempts, error = %e, "transient run failure; requeueing");
                    metrics::record_judge_retry("run");
                    runs::requeue(&ctx.pool, run_id).await;
                    ctx.sleep_or_stop(backoff(ctx.config.judge_retry_base, attempts))
                        .await;
                }
            }
        }
    }
    tracing::info!("run loop stopped");
}

/// Heartbeat, stale-work recovery and retention cleanup.
pub async fn run_maintenance_loop(ctx: Arc<WorkerContext>) {
    tracing::info!("maintenance loop started");
    let interval = Duration::from_secs(10)
        .min(ctx.config.claim_timeout / 3)
        .max(Duration::from_secs(1));
    let mut ticks: u64 = 0;
    while !ctx.is_stopping() {
        heartbeat(&ctx, None).await;

        // Recover submissions whose worker died after acknowledging the job.
        match outbox::reconcile_stale(
            &ctx.pool,
            ctx.config.claim_timeout,
            ctx.config.max_judge_attempts,
            20,
        )
        .await
        {
            Ok(n) if n > 0 => tracing::warn!(requeued = n, "recovered stale submissions"),
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e, "reconciliation failed"),
        }

        // Runs are ephemeral; drop expired ones every ~minute.
        ticks += 1;
        if ticks % 6 == 0 {
            match runs::purge_expired(&ctx.pool).await {
                Ok(n) if n > 0 => tracing::info!(deleted = n, "purged expired runs"),
                Ok(_) => {}
                Err(e) => tracing::error!(error = %e, "run purge failed"),
            }
        }

        if let Ok((queued, running)) = submissions::backlog(&ctx.pool).await {
            metrics::set_gauge("codearena_submissions_queued", queued);
            metrics::set_gauge("codearena_submissions_running", running);
        }
        if let Ok((backlog, _)) = outbox::lag(&ctx.pool).await {
            metrics::set_gauge("codearena_queue_backlog", backlog);
        }
        metrics::set_labelled_gauge(
            "codearena_worker_up",
            ("worker_id", ctx.config.worker_id.clone()),
            1,
        );

        ctx.sleep_or_stop(interval).await;
    }
    // Mark this worker as gone rather than leaving a stale "healthy" row.
    let _ = sqlx::query("DELETE FROM worker_heartbeats WHERE worker_id = $1")
        .bind(&ctx.config.worker_id)
        .execute(&ctx.pool)
        .await;
    tracing::info!("maintenance loop stopped");
}

/// Serves the worker's own `/metrics` and `/health`.
///
/// The API and the worker are separate processes with separate registries, so
/// verdict counts and judge-duration histograms exist *here* and nowhere else.
/// Without this endpoint they could not be scraped at all.
pub async fn run_metrics_server(ctx: Arc<WorkerContext>) {
    let addr = ctx.config.worker_metrics_addr.trim();
    if addr.is_empty() || !ctx.config.metrics_enabled {
        tracing::info!("worker metrics endpoint disabled");
        return;
    }
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            // Not fatal: judging matters more than observability.
            tracing::error!(addr, error = %e, "cannot bind the worker metrics endpoint");
            return;
        }
    };
    tracing::info!(addr, "worker metrics on http://{addr}/metrics");

    let worker_id = ctx.config.worker_id.clone();
    let app = axum::Router::new()
        .route(
            "/metrics",
            axum::routing::get(|| async {
                (
                    [("content-type", "text/plain; version=0.0.4")],
                    metrics::render(),
                )
            }),
        )
        .route(
            "/health",
            axum::routing::get(move || {
                let worker_id = worker_id.clone();
                async move {
                    axum::Json(serde_json::json!({
                        "status": "ok",
                        "worker_id": worker_id,
                        "version": env!("CARGO_PKG_VERSION"),
                    }))
                }
            }),
        );

    let shutdown = ctx.shutdown.clone();
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(async move { shutdown.notified().await })
        .await;
    if let Err(e) = served {
        tracing::error!(error = %e, "worker metrics endpoint stopped");
    }
}

/// Moves committed outbox rows onto Kafka. Only needed for the Kafka driver;
/// under the PostgreSQL driver the rows *are* the queue.
pub async fn run_publisher_loop(ctx: Arc<WorkerContext>, publisher: Publisher) {
    if publisher.driver() == "postgres" {
        return;
    }
    tracing::info!("outbox publisher started");
    while !ctx.is_stopping() {
        match outbox::publish_pending(
            &ctx.pool,
            &publisher,
            50,
            ctx.config.max_judge_attempts,
            ctx.config.judge_retry_base,
        )
        .await
        {
            Ok(n) if n > 0 => tracing::debug!(published = n, "outbox flushed"),
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e, "outbox publish cycle failed"),
        }
        ctx.sleep_or_stop(ctx.config.queue_poll_interval).await;
    }
    tracing::info!("outbox publisher stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_start_at_zero() {
        let s = WorkerStats::default();
        assert_eq!(s.submissions_judged.load(Ordering::Relaxed), 0);
        assert_eq!(s.runs_executed.load(Ordering::Relaxed), 0);
        assert_eq!(s.failures.load(Ordering::Relaxed), 0);
    }
}

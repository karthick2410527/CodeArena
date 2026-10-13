//! `codearena-worker` — the only process that executes submitted code.
//!
//! It consumes judge jobs, claims queued runs, compiles and executes them in a
//! restricted sandbox, and writes verdicts back to PostgreSQL. Run as many as
//! you like: the Kafka consumer group and the PostgreSQL visibility timeout
//! both distribute work safely, and every state change is guarded.

use codearena_api::{
    config::{Config, RunnerStrategy},
    observability,
    queue::{Consumer, Publisher},
    worker::{
        heartbeat, run_maintenance_loop, run_metrics_server, run_publisher_loop, run_run_loop,
        run_submission_loop, WorkerContext,
    },
};
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();

    let config = Config::from_env().unwrap_or_else(|e| {
        eprintln!("configuration error: {e}");
        std::process::exit(1);
    });
    observability::init_tracing(
        config.log_format_json,
        "codearena_api=debug,codearena_worker=debug,sqlx=warn",
    );

    if config.runner_strategy == RunnerStrategy::Disabled {
        eprintln!(
            "RUNNER_STRATEGY=disabled: this worker cannot execute anything. \
             Set RUNNER_STRATEGY=docker (recommended) or local."
        );
        std::process::exit(1);
    }
    if config.runner_strategy == RunnerStrategy::Local {
        tracing::warn!(
            "RUNNER_STRATEGY=local shares the host kernel and filesystem with this \
             process. It is intended for development and CI only — see docs/SECURITY.md."
        );
    }

    let pool = PgPoolOptions::new()
        // Each concurrent job needs a connection, plus headroom for
        // maintenance queries.
        .max_connections((config.worker_concurrency as u32 * 2 + 4).max(8))
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await
        .unwrap_or_else(|e| {
            eprintln!("could not connect to PostgreSQL: {e}");
            std::process::exit(1);
        });

    // The worker waits for the API's migrations instead of racing them: two
    // processes applying the same migration set can deadlock.
    wait_for_schema(&pool).await;

    let publisher = Publisher::from_config(&config).await.unwrap_or_else(|e| {
        eprintln!("could not initialise the queue publisher: {e}");
        std::process::exit(1);
    });

    tracing::info!(
        worker_id = %config.worker_id,
        queue_driver = config.queue_driver.as_str(),
        runner_strategy = config.runner_strategy.as_str(),
        concurrency = config.worker_concurrency,
        max_attempts = config.max_judge_attempts,
        "worker starting"
    );

    let config = Arc::new(config);
    let ctx = Arc::new(WorkerContext::new(pool.clone(), Arc::clone(&config)));
    heartbeat(&ctx, None).await;

    let mut tasks = Vec::new();

    // One consumer per concurrent judge slot. With Kafka these are separate
    // members of the same consumer group; with PostgreSQL they claim rows
    // independently via SKIP LOCKED.
    for slot in 0..config.worker_concurrency {
        let consumer = match Consumer::from_config(&config, pool.clone()).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("could not start queue consumer: {e}");
                std::process::exit(1);
            }
        };
        tracing::debug!(slot, "judge slot ready");
        tasks.push(tokio::spawn(run_submission_loop(
            Arc::clone(&ctx),
            consumer,
        )));
    }
    tasks.push(tokio::spawn(run_run_loop(Arc::clone(&ctx))));
    tasks.push(tokio::spawn(run_maintenance_loop(Arc::clone(&ctx))));
    tasks.push(tokio::spawn(run_publisher_loop(
        Arc::clone(&ctx),
        publisher,
    )));
    // Judge metrics live in this process, so they need their own endpoint.
    tasks.push(tokio::spawn(run_metrics_server(Arc::clone(&ctx))));

    shutdown_signal().await;
    tracing::info!("shutdown requested; finishing in-flight work");
    ctx.request_shutdown();

    // Give the loops a moment to finish. Anything still claimed is recovered
    // by the maintenance loop (here or on another instance), so nothing is
    // lost either way.
    let drain = tokio::time::timeout(Duration::from_secs(30), async {
        for t in tasks {
            let _ = t.await;
        }
    })
    .await;
    if drain.is_err() {
        tracing::warn!("workers did not stop within 30s; exiting anyway");
    }
    tracing::info!("worker stopped");
}

/// Blocks until the API has applied the migrations this worker needs.
async fn wait_for_schema(pool: &sqlx::PgPool) {
    for attempt in 1..=60 {
        let ready = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables \
                             WHERE table_name = 'worker_heartbeats')",
        )
        .fetch_one(pool)
        .await;
        match ready {
            Ok(true) => return,
            Ok(false) => {
                if attempt == 1 {
                    tracing::info!("waiting for the API to apply database migrations…");
                }
            }
            Err(e) => tracing::warn!(error = %e, "schema check failed; retrying"),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    eprintln!("database schema is not ready after 2 minutes; is codearena-api running?");
    std::process::exit(1);
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(e) => tracing::warn!(error = %e, "cannot listen for SIGTERM"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

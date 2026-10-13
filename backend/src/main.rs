//! `codearena-api` — the HTTP API.
//!
//! This process validates requests, enforces authorisation and rate limits,
//! and persists rows. It holds no [`codearena_api::runner::Runner`], so there
//! is no code path by which submitted source could be compiled or executed
//! here; that belongs to `codearena-worker`.

use codearena_api::{
    build_router,
    cache::Cache,
    config::{Config, QueueDriver},
    observability,
    queue::{outbox, Publisher},
    ratelimit::RateLimiter,
    state::AppState,
};
use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
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
        "codearena_api=debug,tower_http=info,sqlx=warn",
    );

    let pool = PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await
        .unwrap_or_else(|e| {
            eprintln!("could not connect to PostgreSQL: {e}");
            std::process::exit(1);
        });

    // Applies pending migrations; already-applied ones are skipped.
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("failed to run database migrations");
    tracing::info!("migrations applied");

    let cache = Cache::connect(&config.redis_url, config.problem_cache_ttl).await;
    let limiter = RateLimiter::connect(&config.redis_url, config.rate_limit_enabled).await;
    let publisher = Publisher::from_config(&config).await.unwrap_or_else(|e| {
        eprintln!("could not initialise the queue publisher: {e}");
        std::process::exit(1);
    });

    tracing::info!(
        queue_driver = config.queue_driver.as_str(),
        runner_strategy = config.runner_strategy.as_str(),
        redis = config.redis_enabled(),
        rate_limits = config.rate_limit_enabled,
        "API starting"
    );

    let config = Arc::new(config);
    let state = AppState {
        pool: pool.clone(),
        config: Arc::clone(&config),
        cache,
        limiter,
        publisher: publisher.clone(),
    };

    // With the Kafka driver the API also flushes the outbox, so a job is on the
    // topic within one poll interval even if no worker is running yet. Under
    // the PostgreSQL driver the outbox *is* the queue and must not be touched.
    let publisher_task = if config.queue_driver == QueueDriver::Kafka {
        let pool = pool.clone();
        let config = Arc::clone(&config);
        let publisher = publisher.clone();
        Some(tokio::spawn(async move {
            loop {
                match outbox::publish_pending(
                    &pool,
                    &publisher,
                    50,
                    config.max_judge_attempts,
                    config.judge_retry_base,
                )
                .await
                {
                    Ok(n) if n > 0 => tracing::debug!(published = n, "outbox flushed"),
                    Ok(_) => {}
                    Err(e) => tracing::error!(error = %e, "outbox publish cycle failed"),
                }
                tokio::time::sleep(config.queue_poll_interval).await;
            }
        }))
    } else {
        None
    };

    let bind_addr = config.bind_addr.clone();
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("could not bind {bind_addr}: {e}");
            std::process::exit(1);
        });
    tracing::info!("CodeArena API listening on http://{bind_addr}");

    // `ConnectInfo` gives the rate limiter a client address that no header can
    // forge.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .expect("server error");

    if let Some(t) = publisher_task {
        t.abort();
    }
    tracing::info!("API stopped");
}

/// Ctrl-C or SIGTERM, so a container stop drains in-flight requests.
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
        _ = ctrl_c => tracing::info!("received Ctrl-C; shutting down"),
        _ = terminate => tracing::info!("received SIGTERM; shutting down"),
    }
}

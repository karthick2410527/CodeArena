//! Liveness, readiness and metrics.
//!
//! * `GET /health` — the process is up. No dependency checks, so a load
//!   balancer does not take the whole service out when Redis hiccups.
//! * `GET /ready` — PostgreSQL is reachable (hard requirement) and reports the
//!   state of the optional dependencies. Returns 503 when not ready.
//! * `GET /metrics` — Prometheus text exposition.

use crate::{observability::metrics, state::AppState};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;
use serde_json::json;

pub async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

#[derive(Debug, Serialize)]
pub struct Readiness {
    pub status: &'static str,
    /// Required. `false` means the service cannot serve requests.
    pub database: bool,
    /// Optional: `null` when Redis is not configured at all.
    pub redis: Option<bool>,
    pub queue_driver: &'static str,
    pub runner_strategy: &'static str,
    pub rate_limiting: &'static str,
}

/// GET /api/v1/ready
pub async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    let database = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();
    let redis = if state.config.redis_enabled() {
        Some(state.cache.ping().await)
    } else {
        None
    };

    let body = Readiness {
        status: if database { "ready" } else { "not ready" },
        database,
        redis,
        queue_driver: state.config.queue_driver.as_str(),
        runner_strategy: state.config.runner_strategy.as_str(),
        rate_limiting: if !state.config.rate_limit_enabled {
            "disabled"
        } else if state.limiter.is_distributed() {
            "redis"
        } else {
            "in-process"
        },
    };
    // Redis being down is degradation, not unreadiness: the service works
    // without it.
    let code = if database {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (code, Json(body))
}

/// GET /api/v1/metrics
pub async fn prometheus(State(state): State<AppState>) -> impl IntoResponse {
    if !state.config.metrics_enabled {
        return (StatusCode::NOT_FOUND, String::new()).into_response();
    }
    // Refresh the gauges that are cheap to compute on scrape.
    if let Ok((queued, running)) = crate::judge::submissions::backlog(&state.pool).await {
        metrics::set_gauge("codearena_submissions_queued", queued);
        metrics::set_gauge("codearena_submissions_running", running);
    }
    if let Ok((backlog, oldest)) = crate::queue::outbox::lag(&state.pool).await {
        metrics::set_gauge("codearena_queue_backlog", backlog);
        metrics::set_gauge(
            "codearena_queue_oldest_pending_seconds",
            oldest
                .map(|t| (chrono::Utc::now() - t).num_seconds())
                .unwrap_or(0),
        );
    }
    if let Ok(alive) = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM worker_heartbeats WHERE last_seen_at > now() - interval '60 seconds'",
    )
    .fetch_one(&state.pool)
    .await
    {
        metrics::set_gauge("codearena_workers_alive", alive);
    }

    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        metrics::render(),
    )
        .into_response()
}

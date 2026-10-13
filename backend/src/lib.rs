//! CodeArena API library.
//!
//! The crate builds three binaries:
//!
//! * `codearena-api` — the HTTP API. Validates, authorises and persists. It has
//!   no access to a [`runner::Runner`], so it cannot execute submitted code
//!   even by accident.
//! * `codearena-worker` — claims jobs, compiles and executes them in a sandbox,
//!   writes verdicts. This is the only process that runs untrusted code.
//! * `codearena-dlq` — operator tool for inspecting and replaying
//!   dead-lettered jobs.
//!
//! Module map: [`routes`] (HTTP), [`judge`] (verdicts and comparison),
//! [`runner`] (sandboxing), [`queue`] (outbox, Kafka/PostgreSQL drivers),
//! [`cache`] and [`ratelimit`] (Redis), [`observability`] (tracing, metrics).

pub mod auth;
pub mod cache;
pub mod config;
pub mod error;
pub mod judge;
pub mod observability;
pub mod queue;
pub mod ratelimit;
pub mod routes;
pub mod runner;
pub mod state;
pub mod worker;

use axum::{
    http::{header, HeaderValue, Method},
    middleware,
    routing::{get, patch, post},
    Router,
};
use state::AppState;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

pub fn build_router(state: AppState) -> Router {
    let origin = state
        .config
        .cors_origin
        .parse::<HeaderValue>()
        .expect("CORS_ORIGIN must be a valid header value");
    let cors = CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::HeaderName::from_static(observability::CORRELATION_HEADER),
        ])
        // Lets the browser read the correlation id, so a user can quote it in
        // a bug report.
        .expose_headers([header::HeaderName::from_static(
            observability::CORRELATION_HEADER,
        )]);

    let api = Router::new()
        // ---- health and metrics (Phase 5) ---------------------------------
        .route("/health", get(routes::health::health))
        .route("/ready", get(routes::health::ready))
        .route("/metrics", get(routes::health::prometheus))
        // ---- auth (Phase 1) ----------------------------------------------
        .route("/auth/register", post(routes::auth::register))
        .route("/auth/login", post(routes::auth::login))
        .route("/auth/refresh", post(routes::auth::refresh))
        .route("/auth/logout", post(routes::auth::logout))
        .route("/users/me", get(routes::users::me))
        .route("/users/me/stats", get(routes::users::stats))
        // ---- problems (Phase 1) ------------------------------------------
        .route("/problems", get(routes::problems::list))
        .route("/problems/:slug", get(routes::problems::detail))
        .route("/problems/:slug/samples", get(routes::problems::samples))
        .route("/tags", get(routes::problems::tags))
        // ---- editor & Run service (Phase 2) ------------------------------
        .route("/languages", get(routes::runs::languages))
        .route("/limits", get(routes::runs::limits))
        .route("/runs", post(routes::runs::create))
        .route("/runs/:id", get(routes::runs::get))
        // ---- asynchronous judge (Phase 3) --------------------------------
        .route(
            "/submissions",
            post(routes::submissions::create).get(routes::submissions::list),
        )
        .route("/submissions/:id", get(routes::submissions::get))
        .route(
            "/submissions/:id/test-results",
            get(routes::submissions::test_results),
        )
        // ---- administration (Phase 4) ------------------------------------
        .route(
            "/admin/problems",
            post(routes::admin::create_problem).get(routes::admin::list_problems),
        )
        .route(
            "/admin/problems/:id",
            get(routes::admin::get_problem).patch(routes::admin::update_problem),
        )
        .route(
            "/admin/problems/:id/test-cases",
            get(routes::admin::list_test_cases).post(routes::admin::create_test_case),
        )
        .route(
            "/admin/test-cases/:id",
            patch(routes::admin::update_test_case).delete(routes::admin::delete_test_case),
        )
        // ---- operations (Phase 5) ----------------------------------------
        .route("/admin/workers", get(routes::admin::workers))
        .route("/admin/dead-letters", get(routes::admin::dead_letters))
        .route(
            "/admin/dead-letters/:id/replay",
            post(routes::admin::replay_dead_letter),
        );

    Router::new()
        .nest("/api/v1", api)
        // Correlation id + request metrics. Added after the routes so
        // `MatchedPath` is available to it.
        .layer(middleware::from_fn(observability::middleware))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

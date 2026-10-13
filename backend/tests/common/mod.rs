//! Shared harness for the HTTP integration tests.
//!
//! Each `#[sqlx::test]` gets its own throw-away database with every migration
//! (including the seed) applied, so tests never share state.
//!
//! The app under test is built with [`codearena_api::state::AppState::for_tests`]:
//! a real database, no Redis, no broker and a **disabled** runner. That last
//! point is deliberate — if a change ever made the API process execute code,
//! these tests would fail rather than quietly start compiling things.

#![allow(dead_code)]

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use codearena_api::{
    build_router,
    config::{Config, QueueDriver},
    state::AppState,
};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

pub fn app(pool: PgPool) -> Router {
    build_router(AppState::for_tests(pool, Config::for_tests(String::new())))
}

/// An app with a custom configuration (rate limits, queue driver, …).
pub fn app_with(pool: PgPool, mutate: impl FnOnce(&mut Config)) -> Router {
    let mut config = Config::for_tests(String::new());
    mutate(&mut config);
    build_router(AppState::for_tests(pool, config))
}

/// An app whose rate limiter is a real in-process limiter.
pub fn app_rate_limited(pool: PgPool, mutate: impl FnOnce(&mut Config)) -> Router {
    let mut config = Config::for_tests(String::new());
    config.rate_limit_enabled = true;
    config.queue_driver = QueueDriver::Postgres;
    mutate(&mut config);
    let mut state = AppState::for_tests(pool, config);
    state.limiter = codearena_api::ratelimit::RateLimiter::in_process();
    build_router(state)
}

/// Sends a request and returns `(status, parsed JSON, raw body)`.
pub async fn call(
    app: &Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value, String) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let body = match body {
        Some(b) => {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8_lossy(&bytes).to_string();
    let json = serde_json::from_str(&text).unwrap_or(Value::Null);
    (status, json, text)
}

pub async fn get(app: &Router, uri: &str) -> (StatusCode, Value) {
    let (s, j, _) = call(app, Method::GET, uri, None, None).await;
    (s, j)
}

pub async fn get_auth(app: &Router, uri: &str, token: &str) -> (StatusCode, Value) {
    let (s, j, _) = call(app, Method::GET, uri, Some(token), None).await;
    (s, j)
}

pub async fn post_auth(app: &Router, uri: &str, token: &str, body: Value) -> (StatusCode, Value) {
    let (s, j, _) = call(app, Method::POST, uri, Some(token), Some(body)).await;
    (s, j)
}

pub async fn patch_auth(app: &Router, uri: &str, token: &str, body: Value) -> (StatusCode, Value) {
    let (s, j, _) = call(app, Method::PATCH, uri, Some(token), Some(body)).await;
    (s, j)
}

pub async fn register(app: &Router, name: &str, email: &str, pw: &str) -> (StatusCode, Value) {
    let (s, j, _) = call(
        app,
        Method::POST,
        "/api/v1/auth/register",
        None,
        Some(json!({ "username": name, "email": email, "password": pw })),
    )
    .await;
    (s, j)
}

/// A registered user: `(id, access token)`.
pub struct TestUser {
    pub id: Uuid,
    pub token: String,
    pub username: String,
}

/// Registers a normal user and returns their id and access token.
pub async fn user(app: &Router, name: &str) -> TestUser {
    let (status, body) = register(app, name, &format!("{name}@example.com"), "supersecret1").await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "could not register {name}: {body}"
    );
    TestUser {
        id: Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap(),
        token: body["access_token"].as_str().unwrap().to_string(),
        username: name.to_string(),
    }
}

/// Registers a user, promotes them to ADMIN in the database and logs in again
/// so the token carries the new role.
pub async fn admin(app: &Router, pool: &PgPool, name: &str) -> TestUser {
    let u = user(app, name).await;
    sqlx::query("UPDATE users SET role = 'ADMIN' WHERE id = $1")
        .bind(u.id)
        .execute(pool)
        .await
        .unwrap();
    let (status, body, _) = call(
        app,
        Method::POST,
        "/api/v1/auth/login",
        None,
        Some(json!({ "email": format!("{name}@example.com"), "password": "supersecret1" })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "could not log {name} back in: {body}"
    );
    assert_eq!(body["user"]["role"], "ADMIN");
    TestUser {
        id: u.id,
        token: body["access_token"].as_str().unwrap().to_string(),
        username: u.username,
    }
}

/// Replaces a seeded problem's tests with a known set, and returns its id.
/// Used so a judge test knows exactly what the expected outputs are.
pub async fn set_tests(pool: &PgPool, slug: &str, cases: &[(&str, &str, bool)]) -> Uuid {
    let (problem_id,): (Uuid,) = sqlx::query_as("SELECT id FROM problems WHERE slug = $1")
        .bind(slug)
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM test_cases WHERE problem_id = $1")
        .bind(problem_id)
        .execute(pool)
        .await
        .unwrap();
    for (i, (input, expected, is_sample)) in cases.iter().enumerate() {
        sqlx::query(
            "INSERT INTO test_cases (problem_id, position, input, expected_output, \
                                     is_sample, points) VALUES ($1,$2,$3,$4,$5,$6)",
        )
        .bind(problem_id)
        .bind(i as i32 + 1)
        .bind(input)
        .bind(expected)
        .bind(is_sample)
        .bind(if *is_sample { 0 } else { 1 })
        .execute(pool)
        .await
        .unwrap();
    }
    problem_id
}

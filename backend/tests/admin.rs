//! Administration, authorisation and hardening tests.
//!
//! The focus is the boundary rather than the happy path: what a non-admin
//! cannot do, what no public endpoint will return, and that rate limits and
//! cache invalidation behave as documented.

mod common;

use axum::http::{Method, StatusCode};
use codearena_api::config::RateLimit;
use common::*;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

fn new_problem(slug: &str) -> serde_json::Value {
    json!({
        "slug": slug,
        "title": "Sum Two Numbers",
        "description": "Read two integers and print their sum.",
        "constraints": "- both fit in 64 bits",
        "difficulty": "easy",
        "time_limit_ms": 1000,
        "memory_limit_mb": 256,
        "tags": ["math", "Implementation"]
    })
}

// ------------------------------------------------------------ authorisation

#[sqlx::test]
async fn every_admin_endpoint_refuses_a_normal_user(pool: PgPool) {
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    let problem_id: Uuid = sqlx::query_scalar("SELECT id FROM problems WHERE slug = 'a-plus-b'")
        .fetch_one(&pool)
        .await
        .unwrap();
    let case_id: Uuid = sqlx::query_scalar("SELECT id FROM test_cases LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();

    let endpoints: Vec<(Method, String, Option<serde_json::Value>)> = vec![
        (Method::GET, "/api/v1/admin/problems".into(), None),
        (
            Method::POST,
            "/api/v1/admin/problems".into(),
            Some(new_problem("x")),
        ),
        (
            Method::GET,
            format!("/api/v1/admin/problems/{problem_id}"),
            None,
        ),
        (
            Method::PATCH,
            format!("/api/v1/admin/problems/{problem_id}"),
            Some(json!({ "title": "hacked" })),
        ),
        (
            Method::GET,
            format!("/api/v1/admin/problems/{problem_id}/test-cases"),
            None,
        ),
        (
            Method::POST,
            format!("/api/v1/admin/problems/{problem_id}/test-cases"),
            Some(json!({ "input": "1", "expected_output": "1" })),
        ),
        (
            Method::PATCH,
            format!("/api/v1/admin/test-cases/{case_id}"),
            Some(json!({ "input": "1", "expected_output": "1" })),
        ),
        (
            Method::DELETE,
            format!("/api/v1/admin/test-cases/{case_id}"),
            None,
        ),
        (Method::GET, "/api/v1/admin/workers".into(), None),
        (Method::GET, "/api/v1/admin/dead-letters".into(), None),
        (
            Method::POST,
            "/api/v1/admin/dead-letters/1/replay".into(),
            Some(json!({})),
        ),
    ];

    for (method, uri, body) in endpoints {
        // Authenticated but not an admin.
        let (status, resp, _) =
            call(&app, method.clone(), &uri, Some(&u.token), body.clone()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri} -> {resp}");
        assert_eq!(resp["error"]["code"], "FORBIDDEN");

        // Not authenticated at all.
        let (status, _, _) = call(&app, method.clone(), &uri, None, body).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
}

#[sqlx::test]
async fn a_demoted_admin_loses_access_immediately(pool: PgPool) {
    let app = app(pool.clone());
    let root = admin(&app, &pool, "root").await;
    assert_eq!(
        get_auth(&app, "/api/v1/admin/problems", &root.token)
            .await
            .0,
        StatusCode::OK
    );

    // The token still claims ADMIN, but the role is re-read per request.
    sqlx::query("UPDATE users SET role = 'USER' WHERE id = $1")
        .bind(root.id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = get_auth(&app, "/api/v1/admin/problems", &root.token).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a revoked role must take effect before the token expires"
    );
}

// --------------------------------------------------------------- problem CRUD

#[sqlx::test]
async fn an_admin_created_problem_is_public_only_once_published(pool: PgPool) {
    let app = app(pool.clone());
    let root = admin(&app, &pool, "root").await;

    let (status, created) = post_auth(
        &app,
        "/api/v1/admin/problems",
        &root.token,
        new_problem("sum-two"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["published"], false, "new problems start hidden");
    assert_eq!(created["difficulty"], "EASY", "difficulty is normalised");
    assert_eq!(created["slug"], "sum-two");
    assert_eq!(
        created["tags"].as_array().unwrap().len(),
        2,
        "tags are attached: {created}"
    );

    // Invisible to the public while unpublished.
    assert_eq!(
        get(&app, "/api/v1/problems/sum-two").await.0,
        StatusCode::NOT_FOUND
    );
    let (_, list) = get(&app, "/api/v1/problems?limit=50").await;
    assert!(!list.to_string().contains("sum-two"));

    // Publishing needs tests, and specifically a hidden one.
    let (status, body) = patch_auth(
        &app,
        &format!("/api/v1/admin/problems/{id}"),
        &root.token,
        json!({ "published": true }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    post_auth(
        &app,
        &format!("/api/v1/admin/problems/{id}/test-cases"),
        &root.token,
        json!({ "input": "1 2", "expected_output": "3", "is_sample": true }),
    )
    .await;
    let (status, body) = patch_auth(
        &app,
        &format!("/api/v1/admin/problems/{id}"),
        &root.token,
        json!({ "published": true }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "samples alone are not enough to judge with: {body}"
    );

    post_auth(
        &app,
        &format!("/api/v1/admin/problems/{id}/test-cases"),
        &root.token,
        json!({ "input": "10 20", "expected_output": "30", "is_sample": false }),
    )
    .await;
    let (status, published) = patch_auth(
        &app,
        &format!("/api/v1/admin/problems/{id}"),
        &root.token,
        json!({ "published": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{published}");
    assert_eq!(published["published"], true);
    assert_eq!(published["sample_count"], 1);
    assert_eq!(published["hidden_count"], 1);

    // Now it is in the public catalogue, with the sample but not the hidden test.
    let (status, detail, raw) =
        call(&app, Method::GET, "/api/v1/problems/sum-two", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["samples"].as_array().unwrap().len(), 1);
    assert_eq!(detail["samples"][0]["input"], "1 2");
    assert!(!raw.contains("10 20"), "hidden input leaked: {raw}");
    assert!(!raw.contains("30"), "hidden expected output leaked: {raw}");
}

#[sqlx::test]
async fn problem_input_is_validated(pool: PgPool) {
    let app = app(pool.clone());
    let root = admin(&app, &pool, "root").await;

    let cases = [
        json!({ "slug": "Bad Slug", "title": "t", "description": "d", "difficulty": "EASY",
                "time_limit_ms": 1000, "memory_limit_mb": 256 }),
        json!({ "slug": "ok-slug", "title": "", "description": "d", "difficulty": "EASY",
                "time_limit_ms": 1000, "memory_limit_mb": 256 }),
        json!({ "slug": "ok-slug", "title": "t", "description": "d", "difficulty": "TRIVIAL",
                "time_limit_ms": 1000, "memory_limit_mb": 256 }),
        // Beyond the sandbox's ceilings.
        json!({ "slug": "ok-slug", "title": "t", "description": "d", "difficulty": "EASY",
                "time_limit_ms": 600000, "memory_limit_mb": 256 }),
        json!({ "slug": "ok-slug", "title": "t", "description": "d", "difficulty": "EASY",
                "time_limit_ms": 1000, "memory_limit_mb": 65536 }),
        json!({ "slug": "ok-slug", "title": "t", "description": "d", "difficulty": "EASY",
                "time_limit_ms": 10, "memory_limit_mb": 256 }),
        json!({ "slug": "ok-slug", "title": "t", "description": "d", "difficulty": "EASY",
                "time_limit_ms": 1000, "memory_limit_mb": 256, "tags": ["not a tag"] }),
    ];
    for body in cases {
        let (status, resp) =
            post_auth(&app, "/api/v1/admin/problems", &root.token, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body} -> {resp}");
    }

    // A duplicate slug is a conflict, not a 500.
    post_auth(
        &app,
        "/api/v1/admin/problems",
        &root.token,
        new_problem("dup"),
    )
    .await;
    let (status, _) = post_auth(
        &app,
        "/api/v1/admin/problems",
        &root.token,
        new_problem("dup"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[sqlx::test]
async fn a_patch_changes_only_the_fields_it_names(pool: PgPool) {
    let app = app(pool.clone());
    let root = admin(&app, &pool, "root").await;
    let problem_id: Uuid = sqlx::query_scalar("SELECT id FROM problems WHERE slug = 'a-plus-b'")
        .fetch_one(&pool)
        .await
        .unwrap();

    let (_, before) = get_auth(
        &app,
        &format!("/api/v1/admin/problems/{problem_id}"),
        &root.token,
    )
    .await;

    let (status, after) = patch_auth(
        &app,
        &format!("/api/v1/admin/problems/{problem_id}"),
        &root.token,
        json!({ "title": "A Plus B (revised)" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{after}");
    assert_eq!(after["title"], "A Plus B (revised)");
    // Everything else survives untouched.
    assert_eq!(after["slug"], before["slug"]);
    assert_eq!(after["description"], before["description"]);
    assert_eq!(after["difficulty"], before["difficulty"]);
    assert_eq!(after["time_limit_ms"], before["time_limit_ms"]);
    assert_eq!(after["published"], before["published"]);
    assert_eq!(after["tags"], before["tags"]);
    // And the edit is attributed.
    let updated_by: Option<Uuid> =
        sqlx::query_scalar("SELECT updated_by FROM problems WHERE id = $1")
            .bind(problem_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(updated_by, Some(root.id));
}

// ------------------------------------------------------------- test cases

#[sqlx::test]
async fn test_cases_are_managed_and_bounded(pool: PgPool) {
    let app = app(pool.clone());
    let root = admin(&app, &pool, "root").await;
    let problem_id: Uuid = sqlx::query_scalar("SELECT id FROM problems WHERE slug = 'a-plus-b'")
        .fetch_one(&pool)
        .await
        .unwrap();

    // Listing shows hidden data — to an admin, and only to an admin.
    let (status, cases) = get_auth(
        &app,
        &format!("/api/v1/admin/problems/{problem_id}/test-cases"),
        &root.token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let before = cases.as_array().unwrap().len();
    assert!(before > 0);
    assert!(cases[0]["expected_output"].is_string());

    // Append without naming a position.
    let (status, created) = post_auth(
        &app,
        &format!("/api/v1/admin/problems/{problem_id}/test-cases"),
        &root.token,
        json!({ "input": "7 8", "expected_output": "15", "is_sample": false, "points": 5 }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["points"], 5);
    let case_id = created["id"].as_str().unwrap().to_string();

    // Two cases cannot share a position.
    let (status, _) = post_auth(
        &app,
        &format!("/api/v1/admin/problems/{problem_id}/test-cases"),
        &root.token,
        json!({ "input": "1 1", "expected_output": "2", "position": created["position"] }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Validation.
    for body in [
        json!({ "input": "1", "expected_output": "" }),
        json!({ "input": "1", "expected_output": "2", "points": -1 }),
        json!({ "input": "1", "expected_output": "2", "position": 0 }),
    ] {
        let (status, _) = post_auth(
            &app,
            &format!("/api/v1/admin/problems/{problem_id}/test-cases"),
            &root.token,
            body,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    // Update.
    let (status, updated) = patch_auth(
        &app,
        &format!("/api/v1/admin/test-cases/{case_id}"),
        &root.token,
        json!({ "input": "7 9", "expected_output": "16", "points": 2 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["expected_output"], "16");
    assert_eq!(updated["points"], 2);

    // Delete.
    let (status, _, _) = call(
        &app,
        Method::DELETE,
        &format!("/api/v1/admin/test-cases/{case_id}"),
        Some(&root.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, after) = get_auth(
        &app,
        &format!("/api/v1/admin/problems/{problem_id}/test-cases"),
        &root.token,
    )
    .await;
    assert_eq!(after.as_array().unwrap().len(), before);

    // A missing case is a 404, not a 500.
    let (status, _, _) = call(
        &app,
        Method::DELETE,
        &format!("/api/v1/admin/test-cases/{}", Uuid::new_v4()),
        Some(&root.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn a_published_problem_keeps_at_least_one_hidden_test(pool: PgPool) {
    let app = app(pool.clone());
    let root = admin(&app, &pool, "root").await;
    set_tests(
        &pool,
        "a-plus-b",
        &[("3 5", "8", true), ("1 1", "2", false)],
    )
    .await;

    let hidden_id: Uuid = sqlx::query_scalar(
        "SELECT tc.id FROM test_cases tc JOIN problems p ON p.id = tc.problem_id \
          WHERE p.slug = 'a-plus-b' AND NOT tc.is_sample",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let (status, body, _) = call(
        &app,
        Method::DELETE,
        &format!("/api/v1/admin/test-cases/{hidden_id}"),
        Some(&root.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .contains("unpublish"));
}

// ------------------------------------------------------- cache invalidation

#[sqlx::test]
async fn editing_a_problem_invalidates_the_cached_public_view(pool: PgPool) {
    // The in-process cache is disabled in tests, so this asserts the
    // observable contract: a public read never serves a pre-edit value.
    let app = app(pool.clone());
    let root = admin(&app, &pool, "root").await;
    let problem_id: Uuid = sqlx::query_scalar("SELECT id FROM problems WHERE slug = 'a-plus-b'")
        .fetch_one(&pool)
        .await
        .unwrap();

    // Warm the public read.
    let (_, before) = get(&app, "/api/v1/problems/a-plus-b").await;
    assert_eq!(before["title"], "A Plus B");

    patch_auth(
        &app,
        &format!("/api/v1/admin/problems/{problem_id}"),
        &root.token,
        json!({ "title": "Renamed By Admin" }),
    )
    .await;

    let (_, after) = get(&app, "/api/v1/problems/a-plus-b").await;
    assert_eq!(
        after["title"], "Renamed By Admin",
        "the public view must reflect the edit immediately"
    );

    // Unpublishing removes it from the catalogue right away.
    patch_auth(
        &app,
        &format!("/api/v1/admin/problems/{problem_id}"),
        &root.token,
        json!({ "published": false }),
    )
    .await;
    assert_eq!(
        get(&app, "/api/v1/problems/a-plus-b").await.0,
        StatusCode::NOT_FOUND
    );
}

// ----------------------------------------------------------- rate limiting

#[sqlx::test]
async fn login_is_rate_limited_per_client_address(pool: PgPool) {
    let app = app_rate_limited(pool.clone(), |c| {
        c.rate_limits.login = RateLimit::new(3, 60);
    });
    register(&app, "ada", "ada@example.com", "supersecret1").await;

    // Three wrong passwords are merely unauthorised.
    for attempt in 1..=3 {
        let (status, _, _) = call(
            &app,
            Method::POST,
            "/api/v1/auth/login",
            None,
            Some(json!({ "email": "ada@example.com", "password": "wrong" })),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "attempt {attempt}");
    }

    // The fourth is refused outright, with a Retry-After.
    let (status, body, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/login",
        None,
        Some(json!({ "email": "ada@example.com", "password": "wrong" })),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "RATE_LIMITED");

    // Even the *correct* password is refused: the limit is on the endpoint,
    // not on failures, so it cannot be used to probe credentials.
    let (status, _, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/login",
        None,
        Some(json!({ "email": "ada@example.com", "password": "supersecret1" })),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

#[sqlx::test]
async fn a_forged_forwarded_header_cannot_reset_the_login_limit(pool: PgPool) {
    use axum::body::Body;
    use axum::http::{header, Request};
    use tower::ServiceExt;

    let app = app_rate_limited(pool.clone(), |c| {
        c.rate_limits.login = RateLimit::new(2, 60);
        // No proxies are trusted, so X-Forwarded-For must be ignored.
        c.trusted_proxy_hops = 0;
    });
    register(&app, "ada", "ada@example.com", "supersecret1").await;

    let attempt = |ip: &str| {
        let app = app.clone();
        let ip = ip.to_string();
        async move {
            let req = Request::builder()
                .method(Method::POST)
                .uri("/api/v1/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-forwarded-for", ip)
                .body(Body::from(
                    json!({ "email": "ada@example.com", "password": "wrong" }).to_string(),
                ))
                .unwrap();
            app.oneshot(req).await.unwrap().status()
        }
    };

    assert_eq!(attempt("1.1.1.1").await, StatusCode::UNAUTHORIZED);
    assert_eq!(attempt("2.2.2.2").await, StatusCode::UNAUTHORIZED);
    // A fresh forged address must NOT buy another attempt.
    assert_eq!(
        attempt("3.3.3.3").await,
        StatusCode::TOO_MANY_REQUESTS,
        "the limit must not depend on a client-supplied address"
    );
}

#[sqlx::test]
async fn submitting_is_rate_limited_per_user(pool: PgPool) {
    let app = app_rate_limited(pool.clone(), |c| {
        c.rate_limits.submit = RateLimit::new(2, 60);
    });
    let ada = user(&app, "ada").await;
    let bob = user(&app, "bob").await;
    let body =
        json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "int main(){}" });

    for _ in 0..2 {
        let (status, _) = post_auth(&app, "/api/v1/submissions", &ada.token, body.clone()).await;
        assert_eq!(status, StatusCode::ACCEPTED);
    }
    let (status, _) = post_auth(&app, "/api/v1/submissions", &ada.token, body.clone()).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);

    // Another user is unaffected: the identity is the authenticated user id.
    let (status, _) = post_auth(&app, "/api/v1/submissions", &bob.token, body).await;
    assert_eq!(status, StatusCode::ACCEPTED);
}

#[sqlx::test]
async fn running_is_rate_limited_per_user(pool: PgPool) {
    let app = app_rate_limited(pool.clone(), |c| {
        c.rate_limits.run = RateLimit::new(1, 60);
    });
    let u = user(&app, "ada").await;
    let body =
        json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "int main(){}" });

    assert_eq!(
        post_auth(&app, "/api/v1/runs", &u.token, body.clone())
            .await
            .0,
        StatusCode::ACCEPTED
    );
    let (status, resp) = post_auth(&app, "/api/v1/runs", &u.token, body).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{resp}");
}

// ------------------------------------------------- observability endpoints

#[sqlx::test]
async fn readiness_reports_each_dependency(pool: PgPool) {
    let app = app(pool);
    let (status, body) = get(&app, "/api/v1/ready").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ready");
    assert_eq!(body["database"], true);
    // Redis is not configured in tests, so it reports as absent, not broken.
    assert!(body["redis"].is_null());
    assert_eq!(body["queue_driver"], "postgres");
    assert_eq!(body["runner_strategy"], "disabled");
}

#[sqlx::test]
async fn metrics_are_exposed_in_prometheus_format(pool: PgPool) {
    let app = app(pool);
    // Generate some traffic first.
    get(&app, "/api/v1/problems").await;
    get(&app, "/api/v1/problems/a-plus-b").await;

    let (status, _, text) = call(&app, Method::GET, "/api/v1/metrics", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(text.contains("codearena_http_requests_total"));
    assert!(text.contains("# TYPE"));
    // Routes are recorded as patterns, not concrete paths, so the metric
    // cardinality cannot be blown up by requesting many slugs.
    assert!(text.contains("/api/v1/problems/:slug"));
    assert!(!text.contains("/api/v1/problems/a-plus-b"));
    assert!(text.contains("codearena_queue_backlog"));
}

#[sqlx::test]
async fn every_response_carries_a_correlation_id(pool: PgPool) {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let app = app(pool);
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let generated = res
        .headers()
        .get("x-correlation-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    assert!(
        generated.is_some(),
        "a correlation id must always be returned"
    );

    // A sane client-supplied id is echoed back.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/health")
                .header("x-correlation-id", "my-trace-1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.headers().get("x-correlation-id").unwrap(), "my-trace-1");

    // One that could forge a log line is replaced, not echoed.
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/health")
                .header("x-correlation-id", "bad id with spaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let echoed = res
        .headers()
        .get("x-correlation-id")
        .unwrap()
        .to_str()
        .unwrap();
    assert_ne!(echoed, "bad id with spaces");
    assert!(!echoed.contains(' '));
}

#[sqlx::test]
async fn worker_health_reports_queue_lag_and_stale_workers(pool: PgPool) {
    let app = app(pool.clone());
    let root = admin(&app, &pool, "root").await;

    sqlx::query(
        "INSERT INTO worker_heartbeats \
            (worker_id, queue_driver, runner_strategy, last_seen_at, submissions_judged) \
         VALUES ('fresh', 'postgres', 'local', now(), 12), \
                ('stale', 'postgres', 'local', now() - interval '1 hour', 3)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let (status, body) = get_auth(&app, "/api/v1/admin/workers", &root.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let workers = body["workers"].as_array().unwrap();
    assert_eq!(workers.len(), 2);
    let fresh = workers.iter().find(|w| w["worker_id"] == "fresh").unwrap();
    let stale = workers.iter().find(|w| w["worker_id"] == "stale").unwrap();
    assert_eq!(fresh["healthy"], true);
    assert_eq!(fresh["submissions_judged"], 12);
    assert_eq!(
        stale["healthy"], false,
        "a silent worker must look unhealthy"
    );
    assert!(stale["seconds_since_heartbeat"].as_f64().unwrap() > 1000.0);

    assert_eq!(body["queued_submissions"], 0);
    assert_eq!(body["queue_backlog"], 0);
    assert_eq!(body["unresolved_dead_letters"], 0);
}

#[sqlx::test]
async fn dead_letters_can_be_inspected_and_replayed(pool: PgPool) {
    let app = app(pool.clone());
    let root = admin(&app, &pool, "root").await;
    let ada = user(&app, "ada").await;

    let (_, created) = post_auth(
        &app,
        "/api/v1/submissions",
        &ada.token,
        json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "int main(){}" }),
    )
    .await;
    let submission_id = Uuid::parse_str(created["submission_id"].as_str().unwrap()).unwrap();

    // Simulate exhaustion: terminal INTERNAL_ERROR plus a dead-letter record.
    sqlx::query(
        "UPDATE submissions SET status = 'FINISHED', verdict = 'INTERNAL_ERROR', \
                                attempts = 3, finished_at = now() WHERE id = $1",
    )
    .bind(submission_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO dead_letter_events (submission_id, event_type, payload, reason) \
         VALUES ($1, 'submission.created', '{}'::jsonb, 'judge attempts exhausted')",
    )
    .bind(submission_id)
    .execute(&pool)
    .await
    .unwrap();

    let pending_before: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = $1 AND published_at IS NULL",
    )
    .bind(submission_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let (status, listed) = get_auth(&app, "/api/v1/admin/dead-letters", &root.token).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["total"], 1);
    let entry_id = listed["items"][0]["id"].as_i64().unwrap();
    assert_eq!(listed["items"][0]["reason"], "judge attempts exhausted");

    // Replaying resets the attempt budget and re-queues it.
    let (status, replayed) = post_auth(
        &app,
        &format!("/api/v1/admin/dead-letters/{entry_id}/replay"),
        &root.token,
        json!({ "note": "transient runner outage" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replayed}");
    assert_eq!(replayed["status"], "QUEUED");

    let (status, attempts): (String, i32) =
        sqlx::query_as("SELECT status, attempts FROM submissions WHERE id = $1")
            .bind(submission_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "QUEUED");
    assert_eq!(attempts, 0, "a replay must get a fresh budget");

    let pending_after: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = $1 AND published_at IS NULL",
    )
    .bind(submission_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        pending_after,
        pending_before + 1,
        "the replay must add exactly one queue event"
    );

    // Replaying twice is refused rather than queueing it again.
    let (status, _) = post_auth(
        &app,
        &format!("/api/v1/admin/dead-letters/{entry_id}/replay"),
        &root.token,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Resolved entries are hidden by default, visible on request.
    let (_, pending_only) = get_auth(&app, "/api/v1/admin/dead-letters", &root.token).await;
    assert_eq!(pending_only["total"], 0);
    let (_, all) = get_auth(
        &app,
        "/api/v1/admin/dead-letters?include_resolved=true",
        &root.token,
    )
    .await;
    assert_eq!(all["total"], 1);
    assert!(all["items"][0]["resolution"]
        .as_str()
        .unwrap()
        .contains("transient runner outage"));
}

#[sqlx::test]
async fn admin_lists_are_paginated(pool: PgPool) {
    let app = app(pool.clone());
    let root = admin(&app, &pool, "root").await;

    let (_, page1) = get_auth(&app, "/api/v1/admin/problems?limit=3&page=1", &root.token).await;
    assert_eq!(page1["items"].as_array().unwrap().len(), 3);
    assert_eq!(page1["limit"], 3);
    assert!(page1["total"].as_i64().unwrap() >= 8);

    let (_, page2) = get_auth(&app, "/api/v1/admin/problems?limit=3&page=2", &root.token).await;
    assert_ne!(page1["items"][0]["id"], page2["items"][0]["id"]);

    // Unbounded reads are refused.
    for q in ["limit=0", "limit=9999", "page=0"] {
        let (status, _) = get_auth(&app, &format!("/api/v1/admin/problems?{q}"), &root.token).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "query {q}");
    }

    // Admin listing sees unpublished problems; the public one does not.
    post_auth(
        &app,
        "/api/v1/admin/problems",
        &root.token,
        new_problem("hidden-one"),
    )
    .await;
    let (_, unpublished) =
        get_auth(&app, "/api/v1/admin/problems?published=false", &root.token).await;
    assert!(unpublished.to_string().contains("hidden-one"));
    let (_, public) = get(&app, "/api/v1/problems?limit=50").await;
    assert!(!public.to_string().contains("hidden-one"));
}

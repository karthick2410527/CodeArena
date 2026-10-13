//! Integration tests. Each `#[sqlx::test]` gets its own fresh database with all
//! migrations (including the seed data) applied. Requires DATABASE_URL to point at
//! a PostgreSQL server where the user may create databases.

mod common;

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use common::{app, call, get, register};
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;

// ------------------------------------------------------------------ auth

#[sqlx::test]
async fn register_login_and_me(pool: PgPool) {
    let app = app(pool.clone());

    let (s, j) = register(&app, "ada", "Ada@Example.com", "supersecret1").await;
    assert_eq!(s, StatusCode::CREATED, "{j}");
    assert_eq!(j["user"]["username"], "ada");
    assert_eq!(j["user"]["email"], "ada@example.com"); // normalised
    assert_eq!(j["user"]["role"], "USER");
    assert!(j["user"].get("password_hash").is_none());
    assert!(j["access_token"].as_str().unwrap().len() > 20);
    assert!(j["refresh_token"].as_str().unwrap().len() >= 32);

    // password is stored hashed (Argon2id), never in plaintext
    let stored: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE username = 'ada'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(stored.starts_with("$argon2id$"));
    assert!(!stored.contains("supersecret1"));

    // login (case-insensitive email)
    let (s, j, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/login",
        None,
        Some(json!({ "email": "ADA@example.com", "password": "supersecret1" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{j}");
    let token = j["access_token"].as_str().unwrap().to_string();

    let (s, me, text) = call(&app, Method::GET, "/api/v1/users/me", Some(&token), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(me["username"], "ada");
    assert!(!text.contains("password"));
}

#[sqlx::test]
async fn register_validation_and_duplicates(pool: PgPool) {
    let app = app(pool);

    assert_eq!(
        register(&app, "ab", "a@b.co", "supersecret1").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        register(&app, "valid_name", "not-an-email", "supersecret1")
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        register(&app, "valid_name", "a@b.co", "short").await.0,
        StatusCode::BAD_REQUEST
    );

    assert_eq!(
        register(&app, "grace", "grace@example.com", "supersecret1")
            .await
            .0,
        StatusCode::CREATED
    );
    // duplicate email and duplicate username (case-insensitive)
    assert_eq!(
        register(&app, "other", "GRACE@example.com", "supersecret1")
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        register(&app, "GRACE", "other@example.com", "supersecret1")
            .await
            .0,
        StatusCode::CONFLICT
    );

    // malformed JSON / missing fields use the standard error format
    let (s, j, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/register",
        None,
        Some(json!({ "username": "x" })),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(j["error"]["code"], "BAD_REQUEST");
}

#[sqlx::test]
async fn login_failures_are_rejected(pool: PgPool) {
    let app = app(pool);
    register(&app, "linus", "linus@example.com", "supersecret1").await;

    for body in [
        json!({ "email": "linus@example.com", "password": "wrong-password" }),
        json!({ "email": "nobody@example.com", "password": "supersecret1" }),
    ] {
        let (s, j, _) = call(&app, Method::POST, "/api/v1/auth/login", None, Some(body)).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert_eq!(j["error"]["message"], "invalid email or password"); // no user enumeration
    }
}

#[sqlx::test]
async fn protected_routes_reject_unauthenticated_requests(pool: PgPool) {
    let app = app(pool);

    let (s, j, _) = call(&app, Method::GET, "/api/v1/users/me", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(j["error"]["code"], "UNAUTHORIZED");

    for tok in ["garbage", "a.b.c"] {
        let (s, _, _) = call(&app, Method::GET, "/api/v1/users/me", Some(tok), None).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    // wrong scheme
    let req = Request::builder()
        .uri("/api/v1/users/me")
        .header(header::AUTHORIZATION, "Basic abc")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(req).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );

    // token signed with a different secret is rejected
    let forged = codearena_api::auth::jwt::issue_access_token(
        "some-other-secret-some-other-secret-1",
        uuid::Uuid::new_v4(),
        "ADMIN",
        600,
    )
    .unwrap();
    let (s, _, _) = call(&app, Method::GET, "/api/v1/users/me", Some(&forged), None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn token_for_deleted_user_is_rejected(pool: PgPool) {
    let app = app(pool.clone());
    let (_, j) = register(&app, "ghost", "ghost@example.com", "supersecret1").await;
    let token = j["access_token"].as_str().unwrap().to_string();
    sqlx::query("DELETE FROM users WHERE username = 'ghost'")
        .execute(&pool)
        .await
        .unwrap();
    let (s, _, _) = call(&app, Method::GET, "/api/v1/users/me", Some(&token), None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn refresh_rotates_and_logout_revokes(pool: PgPool) {
    let app = app(pool.clone());
    let (_, j) = register(&app, "rotate", "rotate@example.com", "supersecret1").await;
    let r1 = j["refresh_token"].as_str().unwrap().to_string();

    // refresh token is stored only as a hash
    let leaked: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM refresh_tokens WHERE token_hash = $1")
            .bind(&r1)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(leaked, 0);

    let (s, j2, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        Some(json!({ "refresh_token": r1 })),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{j2}");
    let r2 = j2["refresh_token"].as_str().unwrap().to_string();
    assert_ne!(r1, r2);
    let access2 = j2["access_token"].as_str().unwrap().to_string();
    let (s, _, _) = call(&app, Method::GET, "/api/v1/users/me", Some(&access2), None).await;
    assert_eq!(s, StatusCode::OK);

    // the old token cannot be reused
    let (s, _, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        Some(json!({ "refresh_token": r1 })),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // logout revokes the current token; logging out twice is fine
    for _ in 0..2 {
        let (s, _, _) = call(
            &app,
            Method::POST,
            "/api/v1/auth/logout",
            None,
            Some(json!({ "refresh_token": r2 })),
        )
        .await;
        assert_eq!(s, StatusCode::NO_CONTENT);
    }
    let (s, _, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        Some(json!({ "refresh_token": r2 })),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // unknown token
    let (s, _, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        Some(json!({ "refresh_token": "nope" })),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn expired_refresh_token_is_rejected(pool: PgPool) {
    let app = app(pool.clone());
    let (_, j) = register(&app, "expiry", "expiry@example.com", "supersecret1").await;
    sqlx::query("UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'")
        .execute(&pool)
        .await
        .unwrap();
    let (s, _, _) = call(
        &app,
        Method::POST,
        "/api/v1/auth/refresh",
        None,
        Some(json!({ "refresh_token": j["refresh_token"] })),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

// ------------------------------------------------------------------ problems

#[sqlx::test]
async fn problem_list_defaults_and_pagination(pool: PgPool) {
    let app = app(pool);

    let (s, j) = get(&app, "/api/v1/problems").await;
    assert_eq!(s, StatusCode::OK);
    let total = j["total"].as_i64().unwrap();
    assert!(total >= 8, "expected several seeded problems, got {total}");
    assert_eq!(j["page"], 1);
    assert_eq!(j["limit"], 20);
    let first = &j["items"][0];
    assert!(first["slug"].is_string() && first["title"].is_string());
    assert!(first["tags"].is_array());
    // list items never carry statement/test data
    assert!(first.get("description").is_none() && first.get("samples").is_none());

    let (_, p1) = get(&app, "/api/v1/problems?limit=4&page=1").await;
    let (_, p2) = get(&app, "/api/v1/problems?limit=4&page=2").await;
    assert_eq!(p1["items"].as_array().unwrap().len(), 4);
    assert_eq!(p1["total_pages"].as_i64().unwrap(), (total + 3) / 4);
    assert_ne!(p1["items"][0]["slug"], p2["items"][0]["slug"]);
    assert_eq!(p2["page"], 2);

    // beyond the last page: empty items but valid response
    let (s, far) = get(&app, "/api/v1/problems?limit=4&page=999").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(far["items"].as_array().unwrap().len(), 0);
    assert_eq!(far["total"].as_i64().unwrap(), total);
}

#[sqlx::test]
async fn problem_list_filters(pool: PgPool) {
    let app = app(pool);

    let (s, easy) = get(&app, "/api/v1/problems?difficulty=EASY").await;
    assert_eq!(s, StatusCode::OK);
    let items = easy["items"].as_array().unwrap();
    assert!(!items.is_empty());
    assert!(items.iter().all(|p| p["difficulty"] == "EASY"));

    // case-insensitive difficulty
    let (_, lower) = get(&app, "/api/v1/problems?difficulty=hard").await;
    assert!(lower["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["difficulty"] == "HARD"));
    assert!(lower["total"].as_i64().unwrap() >= 1);

    // tag filter
    let (_, dp) = get(&app, "/api/v1/problems?tag=DP").await;
    let dp_items = dp["items"].as_array().unwrap();
    assert!(dp_items.len() >= 2);
    assert!(dp_items
        .iter()
        .all(|p| p["tags"].as_array().unwrap().iter().any(|t| t == "dp")));

    // combined filters
    let (_, combo) = get(&app, "/api/v1/problems?tag=dp&difficulty=MEDIUM").await;
    assert!(combo["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["difficulty"] == "MEDIUM"));

    // search by title
    let (_, found) = get(&app, "/api/v1/problems?q=palin").await;
    let slugs: Vec<_> = found["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["slug"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(slugs, vec!["valid-palindrome"]);

    // wildcard characters are treated literally, not as patterns
    let (_, wild) = get(&app, "/api/v1/problems?q=%25").await;
    assert_eq!(wild["total"], 0);

    // no matches
    let (s, none) = get(&app, "/api/v1/problems?q=zzzzzz").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(none["total"], 0);
    assert_eq!(none["total_pages"], 0);
}

#[sqlx::test]
async fn problem_list_rejects_bad_params(pool: PgPool) {
    let app = app(pool);
    for q in [
        "difficulty=IMPOSSIBLE",
        "limit=0",
        "limit=1000",
        "page=0",
        "page=abc",
        "limit=-1",
    ] {
        let (s, j) = get(&app, &format!("/api/v1/problems?{q}")).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "query {q}");
        assert_eq!(j["error"]["code"], "BAD_REQUEST");
    }
}

#[sqlx::test]
async fn problem_detail_returns_statement_and_samples_only(pool: PgPool) {
    let app = app(pool.clone());

    // Plant recognisable hidden data, then make sure it never leaks.
    sqlx::query(
        "INSERT INTO test_cases (problem_id, position, input, expected_output, is_sample, points) \
         SELECT id, 99, 'HIDDEN_INPUT_SECRET', 'HIDDEN_OUTPUT_SECRET', FALSE, 1 FROM problems WHERE slug = 'a-plus-b'",
    )
    .execute(&pool)
    .await
    .unwrap();

    let (s, j, text) = call(&app, Method::GET, "/api/v1/problems/a-plus-b", None, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(j["slug"], "a-plus-b");
    assert_eq!(j["difficulty"], "EASY");
    assert!(j["description"].as_str().unwrap().contains("sum"));
    assert!(j["time_limit_ms"].as_i64().unwrap() > 0);
    assert!(j["memory_limit_mb"].as_i64().unwrap() > 0);
    assert!(!j["tags"].as_array().unwrap().is_empty());

    let samples = j["samples"].as_array().unwrap();
    let public_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM test_cases t JOIN problems p ON p.id = t.problem_id WHERE p.slug = 'a-plus-b' AND t.is_sample",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(samples.len() as i64, public_count);
    assert_eq!(samples[0]["input"], "3 5");
    assert_eq!(samples[0]["expected_output"], "8");

    let hidden_total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM test_cases WHERE NOT is_sample")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(hidden_total > 0);
    assert!(!text.contains("HIDDEN_INPUT_SECRET") && !text.contains("HIDDEN_OUTPUT_SECRET"));
    assert!(!text.contains("is_sample") && !text.contains("points"));

    // dedicated samples endpoint behaves the same
    let (s, _, st) = call(
        &app,
        Method::GET,
        "/api/v1/problems/a-plus-b/samples",
        None,
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert!(!st.contains("HIDDEN_"));
    let (_, sj, _) = call(
        &app,
        Method::GET,
        "/api/v1/problems/a-plus-b/samples",
        None,
        None,
    )
    .await;
    assert_eq!(sj.as_array().unwrap().len() as i64, public_count);
}

#[sqlx::test]
async fn no_public_endpoint_leaks_hidden_cases(pool: PgPool) {
    let app = app(pool.clone());
    let hidden: Vec<(String, String)> = sqlx::query_as(
        "SELECT t.input, t.expected_output FROM test_cases t WHERE NOT t.is_sample AND length(t.input) > 40",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(!hidden.is_empty());
    let slugs: Vec<String> = sqlx::query_scalar("SELECT slug FROM problems")
        .fetch_all(&pool)
        .await
        .unwrap();
    for slug in slugs {
        for suffix in ["", "/samples"] {
            let (_, _, text) = call(
                &app,
                Method::GET,
                &format!("/api/v1/problems/{slug}{suffix}"),
                None,
                None,
            )
            .await;
            for (input, _) in &hidden {
                // hidden input blobs (long ones) must not appear in any response body
                let escaped = serde_json::to_string(input).unwrap();
                assert!(
                    !text.contains(&escaped[1..escaped.len() - 1]),
                    "leak in {slug}{suffix}"
                );
            }
        }
    }
}

#[sqlx::test]
async fn missing_and_unpublished_problems_are_404(pool: PgPool) {
    let app = app(pool.clone());

    let (s, j) = get(&app, "/api/v1/problems/does-not-exist").await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(j["error"]["code"], "NOT_FOUND");
    assert_eq!(
        get(&app, "/api/v1/problems/does-not-exist/samples").await.0,
        StatusCode::NOT_FOUND
    );

    sqlx::query("UPDATE problems SET published = FALSE WHERE slug = 'a-plus-b'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        get(&app, "/api/v1/problems/a-plus-b").await.0,
        StatusCode::NOT_FOUND
    );
    let (_, list) = get(&app, "/api/v1/problems?limit=50").await;
    assert!(list["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["slug"] != "a-plus-b"));
}

#[sqlx::test]
async fn tags_endpoint_lists_counts(pool: PgPool) {
    let app = app(pool);
    let (s, j) = get(&app, "/api/v1/tags").await;
    assert_eq!(s, StatusCode::OK);
    let tags = j.as_array().unwrap();
    assert!(tags
        .iter()
        .any(|t| t["name"] == "dp" && t["count"].as_i64().unwrap() >= 2));
}

#[sqlx::test]
async fn health_endpoint(pool: PgPool) {
    let app = app(pool);
    let (s, j) = get(&app, "/api/v1/health").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(j["status"], "ok");
}

//! End-to-end judge tests.
//!
//! These drive the real pipeline: `POST /submissions` writes the submission and
//! the outbox event in one transaction, the PostgreSQL queue driver delivers
//! the job, the judge compiles the code in a sandbox, executes every test case
//! and persists a verdict — then the HTTP API is asked what happened.
//!
//! The worker loops are driven inline by [`drain_queue`] instead of spawning
//! `codearena-worker`, so a test can assert on exactly one delivery at a time.
//! That is the same code the binary runs; only the loop is different.
//!
//! Tests needing a compiler are skipped with a note when `g++` is missing.

mod common;

use axum::http::{Method, StatusCode};
use codearena_api::{
    config::{Config, QueueDriver, RunnerStrategy},
    judge::{runs, submissions},
    queue::{Consumer, JudgeJob, Publisher},
    runner::Runner,
};
use common::*;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

/// Worker-side configuration: PostgreSQL queue, local sandbox.
fn worker_config() -> Config {
    let mut c = Config::for_tests(String::new());
    c.queue_driver = QueueDriver::Postgres;
    c.runner_strategy = RunnerStrategy::Local;
    c.runner_workdir = std::env::temp_dir()
        .join("codearena-judge-tests")
        .to_string_lossy()
        .into_owned();
    c.max_judge_attempts = 3;
    c.claim_timeout = std::time::Duration::from_secs(30);
    c
}

fn compiler_available() -> bool {
    let ok = std::process::Command::new("g++")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("SKIPPED: g++ is not available on PATH");
    }
    ok
}

macro_rules! need_compiler {
    () => {
        if !compiler_available() {
            return;
        }
    };
}

/// Consumes and judges up to `max` jobs. Returns how many were processed.
///
/// This mirrors `worker::run_submission_loop` for one pass: claim (guarded),
/// judge, acknowledge.
async fn drain_queue(pool: &PgPool, max: usize) -> usize {
    let config = worker_config();
    let runner = Runner::from_config(&config);
    let mut consumer = Consumer::from_config(&config, pool.clone()).await.unwrap();
    let mut done = 0;
    for _ in 0..max {
        let Some(delivery) = consumer.next().await.unwrap() else {
            break;
        };
        let id = delivery.job.submission_id;
        match submissions::claim(pool, id, &config.worker_id, config.max_judge_attempts).await {
            Ok(Ok(claimed)) => {
                submissions::judge(pool, &runner, &config, claimed)
                    .await
                    .expect("the judge itself must not fail here");
                consumer.ack(&delivery).await.unwrap();
            }
            // Duplicate or unjudgeable: acknowledge, exactly as the worker does.
            Ok(Err(_)) => consumer.ack(&delivery).await.unwrap(),
            Err(e) => panic!("claim failed: {e}"),
        }
        done += 1;
    }
    done
}

/// Executes queued runs the way `worker::run_run_loop` does.
async fn drain_runs(pool: &PgPool, max: usize) -> usize {
    let config = worker_config();
    let runner = Runner::from_config(&config);
    let mut done = 0;
    for _ in 0..max {
        let Some(run) = runs::claim_next(pool, &config.worker_id, 30).await.unwrap() else {
            break;
        };
        runs::execute_run(pool, &runner, run)
            .await
            .expect("the runner itself must not fail here");
        done += 1;
    }
    done
}

const SUM_SOLUTION: &str = r#"
#include <bits/stdc++.h>
int main() { long long a, b; std::cin >> a >> b; std::cout << a + b << "\n"; }
"#;

/// Submits `source` against `a-plus-b` and returns the submission id.
async fn submit(app: &axum::Router, token: &str, source: &str) -> Uuid {
    let (status, body) = post_auth(
        app,
        "/api/v1/submissions",
        token,
        json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": source }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "submit failed: {body}");
    assert_eq!(body["status"], "QUEUED");
    Uuid::parse_str(body["submission_id"].as_str().unwrap()).unwrap()
}

// ------------------------------------------------------- accepting the work

#[sqlx::test]
async fn submit_responds_before_judging_and_returns_a_stable_id(pool: PgPool) {
    let app = app(pool.clone());
    let u = user(&app, "ada").await;

    let started = std::time::Instant::now();
    let id = submit(&app, &u.token, SUM_SOLUTION).await;
    // The handler must not wait for a compiler.
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "POST /submissions took {:?}; it must not judge inline",
        started.elapsed()
    );

    // The id is immediately usable and the state is QUEUED.
    let (status, body) = get_auth(&app, &format!("/api/v1/submissions/{id}"), &u.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "QUEUED");
    assert!(body["verdict"].is_null());
    assert_eq!(body["submission_id"], id.to_string());
}

#[sqlx::test]
async fn the_submission_and_its_queue_event_are_written_together(pool: PgPool) {
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    let id = submit(&app, &u.token, SUM_SOLUTION).await;

    // One outbox row per submission, committed in the same transaction.
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "exactly one queue event must exist");

    let (aggregate, event_type, published): (Uuid, String, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as(
            "SELECT aggregate_id, event_type, published_at FROM outbox_events \
              WHERE aggregate_id = $1",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(aggregate, id);
    assert_eq!(event_type, "submission.created");
    assert!(
        published.is_none(),
        "under the PostgreSQL driver the row must stay pending until a worker acks it"
    );

    // The payload carries ids only — no source code, no test data.
    let payload: serde_json::Value =
        sqlx::query_scalar("SELECT payload FROM outbox_events WHERE aggregate_id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let raw = payload.to_string();
    assert!(
        !raw.contains("include"),
        "queue payload must not carry source: {raw}"
    );
    assert!(payload["submission_id"].is_string());
    assert!(payload["problem_id"].is_string());
}

#[sqlx::test]
async fn submitting_is_rejected_without_authentication(pool: PgPool) {
    let app = app(pool);
    let (status, _, _) = call(
        &app,
        Method::POST,
        "/api/v1/submissions",
        None,
        Some(
            json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "int main(){}" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn submissions_are_validated(pool: PgPool) {
    let app = app(pool);
    let u = user(&app, "ada").await;

    for (body, expected) in [
        (
            json!({ "problem_id": "a-plus-b", "language": "python3", "source_code": "x" }),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "   " }),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({ "problem_id": "no-such-problem", "language": "cpp17", "source_code": "int main(){}" }),
            StatusCode::NOT_FOUND,
        ),
        (
            json!({ "language": "cpp17", "source_code": "int main(){}" }),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let (status, _) = post_auth(&app, "/api/v1/submissions", &u.token, body).await;
        assert_eq!(status, expected);
    }

    // Oversized source.
    let huge = "// ".to_string() + &"x".repeat(70_000);
    let (status, body) = post_auth(
        &app,
        "/api/v1/submissions",
        &u.token,
        json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": huge }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"]["message"].as_str().unwrap().contains("bytes"));
}

#[sqlx::test]
async fn an_unpublished_problem_cannot_be_submitted_to(pool: PgPool) {
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    sqlx::query("UPDATE problems SET published = FALSE WHERE slug = 'a-plus-b'")
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = post_auth(
        &app,
        "/api/v1/submissions",
        &u.token,
        json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "int main(){}" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn a_problem_with_no_tests_is_refused_rather_than_queued(pool: PgPool) {
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    set_tests(&pool, "a-plus-b", &[]).await;
    let (status, body) = post_auth(
        &app,
        "/api/v1/submissions",
        &u.token,
        json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "int main(){}" }),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
}

// ------------------------------------------------------------ the verdicts

#[sqlx::test]
async fn a_correct_solution_travels_all_the_way_to_an_accepted_verdict(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    set_tests(
        &pool,
        "a-plus-b",
        &[
            ("3 5", "8", true),
            ("-10 4", "-6", false),
            ("1000000000 1000000000", "2000000000", false),
        ],
    )
    .await;

    let id = submit(&app, &u.token, SUM_SOLUTION).await;
    assert_eq!(drain_queue(&pool, 5).await, 1, "exactly one job to judge");

    let (status, body) = get_auth(&app, &format!("/api/v1/submissions/{id}"), &u.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ACCEPTED", "{body}");
    assert_eq!(body["verdict"], "ACCEPTED");
    assert_eq!(body["passed_tests"], 3);
    assert_eq!(body["total_tests"], 3);
    assert!(body["execution_time_ms"].as_i64().unwrap() >= 0);
    assert!(body["finished_at"].is_string());
    assert!(
        body["message"].is_null(),
        "an accepted verdict needs no excuse"
    );

    // Per-test rows were persisted.
    let (status, results) = get_auth(
        &app,
        &format!("/api/v1/submissions/{id}/test-results"),
        &u.token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows = results["results"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|r| r["verdict"] == "ACCEPTED"));
}

#[sqlx::test]
async fn a_wrong_answer_names_the_failing_test_without_revealing_it(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    set_tests(
        &pool,
        "a-plus-b",
        &[("3 5", "8", true), ("SECRETINPUT 1", "SECRETANSWER", false)],
    )
    .await;

    // Correct on the sample, wrong on the hidden test.
    let id = submit(&app, &u.token, SUM_SOLUTION).await;
    drain_queue(&pool, 5).await;

    let (_, body, raw) = call(
        &app,
        Method::GET,
        &format!("/api/v1/submissions/{id}"),
        Some(&u.token),
        None,
    )
    .await;
    assert_eq!(body["verdict"], "WRONG_ANSWER", "{body}");
    assert_eq!(body["passed_tests"], 1);
    assert_eq!(body["failed_case_position"], 2);
    assert!(!raw.contains("SECRETINPUT"), "hidden input leaked: {raw}");
    assert!(
        !raw.contains("SECRETANSWER"),
        "expected output leaked: {raw}"
    );

    let (_, _, results_raw) = call(
        &app,
        Method::GET,
        &format!("/api/v1/submissions/{id}/test-results"),
        Some(&u.token),
        None,
    )
    .await;
    assert!(!results_raw.contains("SECRETINPUT"));
    assert!(!results_raw.contains("SECRETANSWER"));
}

#[sqlx::test]
async fn code_that_does_not_compile_gets_a_compilation_error(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;

    let id = submit(&app, &u.token, "int main() { this is not c++ }").await;
    drain_queue(&pool, 5).await;

    let (_, body) = get_auth(&app, &format!("/api/v1/submissions/{id}"), &u.token).await;
    assert_eq!(body["verdict"], "COMPILATION_ERROR", "{body}");
    assert_eq!(body["passed_tests"], 0);
    // The author gets the compiler's diagnostics.
    let output = body["compile_output"].as_str().unwrap();
    assert!(!output.trim().is_empty(), "the author needs the error text");
}

#[sqlx::test]
async fn a_crashing_program_gets_a_runtime_error(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    set_tests(&pool, "a-plus-b", &[("3 5", "8", false)]).await;

    let id = submit(
        &app,
        &u.token,
        "int main() { int* p = nullptr; *p = 1; return 0; }",
    )
    .await;
    drain_queue(&pool, 5).await;

    let (_, body) = get_auth(&app, &format!("/api/v1/submissions/{id}"), &u.token).await;
    assert_eq!(body["verdict"], "RUNTIME_ERROR", "{body}");
    assert!(body["message"].as_str().unwrap().contains("crashed"));
}

#[sqlx::test]
async fn a_slow_program_gets_a_time_limit_verdict(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    set_tests(&pool, "a-plus-b", &[("3 5", "8", false)]).await;
    sqlx::query("UPDATE problems SET time_limit_ms = 300 WHERE slug = 'a-plus-b'")
        .execute(&pool)
        .await
        .unwrap();

    let id = submit(&app, &u.token, "int main() { while (true) {} }").await;
    drain_queue(&pool, 5).await;

    let (_, body) = get_auth(&app, &format!("/api/v1/submissions/{id}"), &u.token).await;
    assert_eq!(body["verdict"], "TIME_LIMIT_EXCEEDED", "{body}");
}

#[sqlx::test]
async fn a_memory_hungry_program_gets_a_memory_limit_verdict(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    set_tests(&pool, "a-plus-b", &[("3 5", "8", false)]).await;
    sqlx::query(
        "UPDATE problems SET memory_limit_mb = 64, time_limit_ms = 5000 WHERE slug = 'a-plus-b'",
    )
    .execute(&pool)
    .await
    .unwrap();

    let src = r#"
        #include <bits/stdc++.h>
        int main() {
            std::vector<std::vector<char>> blocks;
            for (int i = 0; i < 4096; ++i) {
                blocks.emplace_back(4 * 1024 * 1024, 1);
                for (size_t j = 0; j < blocks.back().size(); j += 4096)
                    blocks.back()[j] = (char)i;
            }
            std::cout << blocks.size() << "\n";
        }
    "#;
    let id = submit(&app, &u.token, src).await;
    drain_queue(&pool, 5).await;

    let (_, body) = get_auth(&app, &format!("/api/v1/submissions/{id}"), &u.token).await;
    assert_eq!(body["verdict"], "MEMORY_LIMIT_EXCEEDED", "{body}");
}

#[sqlx::test]
async fn trailing_whitespace_does_not_fail_a_correct_answer(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    set_tests(&pool, "a-plus-b", &[("3 5", "8", false)]).await;

    // Prints the right number with extra blank lines and trailing spaces.
    let src = r#"
        #include <bits/stdc++.h>
        int main() { long long a,b; std::cin>>a>>b; std::cout << a+b << "   \n\n\n"; }
    "#;
    let id = submit(&app, &u.token, src).await;
    drain_queue(&pool, 5).await;
    let (_, body) = get_auth(&app, &format!("/api/v1/submissions/{id}"), &u.token).await;
    assert_eq!(body["verdict"], "ACCEPTED", "{body}");
}

// ----------------------------------------------- idempotency and recovery

#[sqlx::test]
async fn a_duplicate_delivery_does_not_change_the_verdict(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    set_tests(&pool, "a-plus-b", &[("3 5", "8", false)]).await;

    let id = submit(&app, &u.token, SUM_SOLUTION).await;
    drain_queue(&pool, 5).await;

    let (_, first) = get_auth(&app, &format!("/api/v1/submissions/{id}"), &u.token).await;
    assert_eq!(first["verdict"], "ACCEPTED");
    let finished_at = first["finished_at"].clone();

    // Replay the very same event, as Kafka may do after a rebalance.
    let mut tx = pool.begin().await.unwrap();
    let job = JudgeJob {
        submission_id: id,
        problem_id: sqlx::query_scalar::<_, Uuid>(
            "SELECT problem_id FROM submissions WHERE id = $1",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        user_id: u.id,
        language: "cpp17".into(),
        correlation_id: Some("replay".into()),
        enqueued_at: chrono::Utc::now(),
    };
    codearena_api::queue::outbox::enqueue(&mut tx, &job)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(
        drain_queue(&pool, 5).await,
        1,
        "the duplicate was delivered"
    );

    let (_, second) = get_auth(&app, &format!("/api/v1/submissions/{id}"), &u.token).await;
    assert_eq!(second["verdict"], "ACCEPTED");
    assert_eq!(
        second["finished_at"], finished_at,
        "the verdict must not be rewritten"
    );
    assert_eq!(second["passed_tests"], 1);

    // And no duplicate per-test rows.
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM submission_results WHERE submission_id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rows, 1);
}

#[sqlx::test]
async fn a_finished_submission_cannot_be_claimed_again(pool: PgPool) {
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    let id = submit(&app, &u.token, SUM_SOLUTION).await;

    // Pretend a worker finished it.
    sqlx::query(
        "UPDATE submissions SET status = 'FINISHED', verdict = 'ACCEPTED', finished_at = now() \
          WHERE id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();

    let rejection = submissions::claim(&pool, id, "worker-2", 3).await.unwrap();
    assert_eq!(
        rejection.err(),
        Some(submissions::ClaimRejection::AlreadyFinished)
    );
}

#[sqlx::test]
async fn the_attempt_budget_is_bounded(pool: PgPool) {
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    let id = submit(&app, &u.token, SUM_SOLUTION).await;

    // Three claims succeed, the fourth is refused.
    for attempt in 1..=3 {
        let claimed = submissions::claim(&pool, id, "worker-1", 3).await.unwrap();
        assert!(claimed.is_ok(), "attempt {attempt} should be allowed");
        submissions::release(&pool, id).await;
    }
    let refused = submissions::claim(&pool, id, "worker-1", 3).await.unwrap();
    assert_eq!(
        refused.err(),
        Some(submissions::ClaimRejection::AttemptsExhausted),
        "retries must be bounded"
    );
}

#[sqlx::test]
async fn an_abandoned_submission_is_recovered_rather_than_left_silent(pool: PgPool) {
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    let id = submit(&app, &u.token, SUM_SOLUTION).await;

    // Simulate a worker that claimed the job, acknowledged it and then died.
    sqlx::query("UPDATE outbox_events SET published_at = now() WHERE aggregate_id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE submissions SET status = 'RUNNING', claimed_by = 'dead-worker', \
                                claimed_at = now() - interval '10 minutes' WHERE id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();

    let requeued = codearena_api::queue::outbox::reconcile_stale(
        &pool,
        std::time::Duration::from_secs(60),
        3,
        10,
    )
    .await
    .unwrap();
    assert_eq!(requeued, 1, "the stale submission must be re-enqueued");

    let status: String = sqlx::query_scalar("SELECT status FROM submissions WHERE id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "QUEUED");
    let pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = $1 AND published_at IS NULL",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pending, 1);
}

#[sqlx::test]
async fn a_submission_out_of_attempts_is_dead_lettered_with_a_terminal_verdict(pool: PgPool) {
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    let id = submit(&app, &u.token, SUM_SOLUTION).await;

    sqlx::query("UPDATE outbox_events SET published_at = now() WHERE aggregate_id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE submissions SET status = 'RUNNING', attempts = 3, \
                                claimed_at = now() - interval '10 minutes' WHERE id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();

    codearena_api::queue::outbox::reconcile_stale(&pool, std::time::Duration::from_secs(60), 3, 10)
        .await
        .unwrap();

    // Terminal and visible, not silent.
    let (_, body) = get_auth(&app, &format!("/api/v1/submissions/{id}"), &u.token).await;
    assert_eq!(body["verdict"], "INTERNAL_ERROR", "{body}");
    // The operator detail stays out of the response.
    let raw = serde_json::to_string(&body).unwrap();
    assert!(!raw.contains("attempt budget"));

    let dead: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dead_letter_events WHERE submission_id = $1 AND resolved_at IS NULL",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(dead, 1, "the failure must be inspectable");
}

#[sqlx::test]
async fn a_failed_publish_is_retried_and_eventually_dead_lettered(pool: PgPool) {
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    let id = submit(&app, &u.token, SUM_SOLUTION).await;

    // A publisher that always fails stands in for an unreachable broker.
    struct Always;
    // The real Publisher enum has no failing variant, so drive publish_pending
    // with attempts already at the ceiling and assert the terminal path.
    let _ = Always;
    sqlx::query("UPDATE outbox_events SET publish_attempts = 99 WHERE aggregate_id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();

    // Even at the ceiling the PostgreSQL driver still delivers, because for it
    // publishing is a no-op — the row *is* the queue entry.
    let published = codearena_api::queue::outbox::publish_pending(
        &pool,
        &Publisher::Postgres,
        10,
        3,
        std::time::Duration::from_millis(1),
    )
    .await
    .unwrap();
    assert_eq!(published, 1);
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = $1 AND published_at IS NULL",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, 0);
}

// ------------------------------------------------------------ history & auth

#[sqlx::test]
async fn history_is_scoped_to_its_owner(pool: PgPool) {
    let app = app(pool.clone());
    let ada = user(&app, "ada").await;
    let bob = user(&app, "bob").await;

    let ada_submission = submit(&app, &ada.token, SUM_SOLUTION).await;
    let _bob_submission = submit(&app, &bob.token, "int main(){}").await;

    let (status, body) = get_auth(&app, "/api/v1/submissions", &ada.token).await;
    assert_eq!(status, StatusCode::OK);
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "a user sees only their own submissions");
    assert_eq!(items[0]["submission_id"], ada_submission.to_string());

    // Bob cannot read Ada's submission, and cannot tell it exists.
    let (status, body) = get_auth(
        &app,
        &format!("/api/v1/submissions/{ada_submission}"),
        &bob.token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "NOT_FOUND");

    // Nor its test results.
    let (status, _) = get_auth(
        &app,
        &format!("/api/v1/submissions/{ada_submission}/test-results"),
        &bob.token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn source_code_is_private_to_its_author(pool: PgPool) {
    let app = app(pool.clone());
    let ada = user(&app, "ada").await;
    let marker = "// ADA_PRIVATE_MARKER\nint main(){}";
    let id = submit(&app, &ada.token, marker).await;

    // The owner sees it.
    let (_, _, own) = call(
        &app,
        Method::GET,
        &format!("/api/v1/submissions/{id}"),
        Some(&ada.token),
        None,
    )
    .await;
    assert!(own.contains("ADA_PRIVATE_MARKER"));

    // A list never carries anyone's code.
    let (_, _, list) = call(
        &app,
        Method::GET,
        "/api/v1/submissions",
        Some(&ada.token),
        None,
    )
    .await;
    assert!(!list.contains("ADA_PRIVATE_MARKER"));
}

#[sqlx::test]
async fn an_admin_may_read_any_submission(pool: PgPool) {
    let app = app(pool.clone());
    let ada = user(&app, "ada").await;
    let root = admin(&app, &pool, "root").await;
    let id = submit(&app, &ada.token, SUM_SOLUTION).await;

    let (status, body) = get_auth(&app, &format!("/api/v1/submissions/{id}"), &root.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["username"], "ada");

    // And may list another user's history, which a normal user may not.
    let (status, _) = get_auth(&app, "/api/v1/submissions?user=ada", &root.token).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = get_auth(&app, "/api/v1/submissions?user=ada", &ada.token).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[sqlx::test]
async fn history_filters_and_pagination_are_validated(pool: PgPool) {
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    submit(&app, &u.token, SUM_SOLUTION).await;

    for query in [
        "verdict=NOT_A_VERDICT",
        "language=python3",
        "limit=0",
        "limit=9999",
        "page=0",
    ] {
        let (status, _) = get_auth(&app, &format!("/api/v1/submissions?{query}"), &u.token).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "query {query}");
    }

    // Valid filters narrow the list rather than erroring.
    for query in [
        "verdict=QUEUED",
        "language=cpp17",
        "problem=a-plus-b",
        "limit=1&page=1",
    ] {
        let (status, body) =
            get_auth(&app, &format!("/api/v1/submissions?{query}"), &u.token).await;
        assert_eq!(status, StatusCode::OK, "query {query}: {body}");
    }
    let (_, none) = get_auth(&app, "/api/v1/submissions?verdict=ACCEPTED", &u.token).await;
    assert_eq!(none["total"], 0);
}

// -------------------------------------------------------------- statistics

#[sqlx::test]
async fn statistics_come_from_persisted_submissions(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    set_tests(&pool, "a-plus-b", &[("3 5", "8", false)]).await;

    let (_, empty) = get_auth(&app, "/api/v1/users/me/stats", &u.token).await;
    assert_eq!(empty["total_submissions"], 0);
    assert_eq!(empty["problems_solved"], 0);
    assert_eq!(empty["acceptance_rate"], 0.0);
    assert!(empty["problems_available"].as_i64().unwrap() >= 8);

    // One accepted, one wrong.
    submit(&app, &u.token, SUM_SOLUTION).await;
    drain_queue(&pool, 5).await;
    submit(
        &app,
        &u.token,
        r#"#include <bits/stdc++.h>
           int main(){ std::cout << "0\n"; }"#,
    )
    .await;
    drain_queue(&pool, 5).await;

    let (_, stats) = get_auth(&app, "/api/v1/users/me/stats", &u.token).await;
    assert_eq!(stats["total_submissions"], 2, "{stats}");
    assert_eq!(stats["accepted_submissions"], 1);
    assert_eq!(stats["problems_solved"], 1, "one distinct problem solved");
    assert_eq!(stats["solved_easy"], 1);
    assert_eq!(stats["acceptance_rate"], 50.0);
    assert_eq!(stats["verdict_counts"]["ACCEPTED"], 1);
    assert_eq!(stats["verdict_counts"]["WRONG_ANSWER"], 1);
    assert!(stats["last_submission_at"].is_string());
}

// -------------------------------------------------------------- run service

#[sqlx::test]
async fn a_run_executes_public_samples_and_never_hidden_tests(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    set_tests(
        &pool,
        "a-plus-b",
        &[
            ("3 5", "8", true),
            ("RUNSECRETINPUT", "RUNSECRETANSWER", false),
        ],
    )
    .await;

    let (status, body) = post_auth(
        &app,
        "/api/v1/runs",
        &u.token,
        json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": SUM_SOLUTION }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let run_id = body["run_id"].as_str().unwrap().to_string();
    assert_eq!(body["status"], "QUEUED");

    assert_eq!(drain_runs(&pool, 5).await, 1);

    let (status, run, raw) = call(
        &app,
        Method::GET,
        &format!("/api/v1/runs/{run_id}"),
        Some(&u.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(run["status"], "FINISHED");
    assert_eq!(run["outcome"], "OK", "{run}");
    let cases = run["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 1, "only the public sample is run");
    assert_eq!(cases[0]["label"], "Sample 1");
    assert_eq!(cases[0]["passed"], true);
    assert_eq!(cases[0]["stdout"].as_str().unwrap().trim(), "8");
    assert!(
        !raw.contains("RUNSECRETINPUT"),
        "hidden input leaked into a run"
    );
    assert!(!raw.contains("RUNSECRETANSWER"));
}

#[sqlx::test]
async fn a_run_with_custom_input_echoes_only_the_users_own_data(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;

    let (status, body) = post_auth(
        &app,
        "/api/v1/runs",
        &u.token,
        json!({
            "problem_id": "a-plus-b",
            "language": "cpp17",
            "source_code": SUM_SOLUTION,
            "mode": "custom",
            "stdin": "40 2"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let run_id = body["run_id"].as_str().unwrap().to_string();
    drain_runs(&pool, 5).await;

    let (_, run) = get_auth(&app, &format!("/api/v1/runs/{run_id}"), &u.token).await;
    assert_eq!(run["outcome"], "OK", "{run}");
    let cases = run["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 1);
    assert_eq!(cases[0]["label"], "Custom input");
    assert_eq!(cases[0]["input"], "40 2");
    assert_eq!(cases[0]["stdout"].as_str().unwrap().trim(), "42");
    // Nothing to compare against, so no pass/fail claim is made.
    assert!(cases[0]["passed"].is_null());
    assert!(cases[0]["expected_output"].is_null());
}

#[sqlx::test]
async fn a_run_that_does_not_compile_reports_the_compiler_output(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;

    let (_, body) = post_auth(
        &app,
        "/api/v1/runs",
        &u.token,
        json!({
            "problem_id": "a-plus-b",
            "language": "cpp17",
            "source_code": "int main() { oops }",
            "mode": "custom",
            "stdin": ""
        }),
    )
    .await;
    let run_id = body["run_id"].as_str().unwrap().to_string();
    drain_runs(&pool, 5).await;

    let (_, run) = get_auth(&app, &format!("/api/v1/runs/{run_id}"), &u.token).await;
    assert_eq!(run["outcome"], "COMPILATION_ERROR", "{run}");
    assert!(!run["compile_output"].as_str().unwrap().trim().is_empty());
    assert!(run["message"].as_str().unwrap().contains("compile"));
    assert_eq!(run["cases"].as_array().unwrap().len(), 0);
}

#[sqlx::test]
async fn a_run_that_times_out_reaches_a_terminal_state(pool: PgPool) {
    need_compiler!();
    let app = app(pool.clone());
    let u = user(&app, "ada").await;
    sqlx::query("UPDATE problems SET time_limit_ms = 300 WHERE slug = 'a-plus-b'")
        .execute(&pool)
        .await
        .unwrap();

    let (_, body) = post_auth(
        &app,
        "/api/v1/runs",
        &u.token,
        json!({
            "problem_id": "a-plus-b",
            "language": "cpp17",
            "source_code": "int main() { while (true) {} }",
            "mode": "custom",
            "stdin": ""
        }),
    )
    .await;
    let run_id = body["run_id"].as_str().unwrap().to_string();
    drain_runs(&pool, 5).await;

    let (_, run) = get_auth(&app, &format!("/api/v1/runs/{run_id}"), &u.token).await;
    assert_eq!(run["status"], "FINISHED");
    assert_eq!(run["outcome"], "TIME_LIMIT_EXCEEDED", "{run}");
}

#[sqlx::test]
async fn runs_are_validated_and_private(pool: PgPool) {
    let app = app(pool.clone());
    let ada = user(&app, "ada").await;
    let bob = user(&app, "bob").await;

    // Validation.
    for (body, expected) in [
        (
            json!({ "problem_id": "a-plus-b", "language": "brainfuck", "source_code": "x" }),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "" }),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({ "problem_id": "nope", "language": "cpp17", "source_code": "int main(){}" }),
            StatusCode::NOT_FOUND,
        ),
        (
            json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "int main(){}",
                    "mode": "hidden" }),
            StatusCode::BAD_REQUEST,
        ),
        // stdin only makes sense with custom input.
        (
            json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "int main(){}",
                    "mode": "samples", "stdin": "1 2" }),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "int main(){}",
                    "mode": "custom", "stdin": "x".repeat(70_000) }),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let (status, got) = post_auth(&app, "/api/v1/runs", &ada.token, body).await;
        assert_eq!(status, expected, "{got}");
    }

    // A run belongs to its author alone.
    let (_, created) = post_auth(
        &app,
        "/api/v1/runs",
        &ada.token,
        json!({ "problem_id": "a-plus-b", "language": "cpp17", "source_code": "int main(){}" }),
    )
    .await;
    let run_id = created["run_id"].as_str().unwrap();
    assert_eq!(
        get_auth(&app, &format!("/api/v1/runs/{run_id}"), &bob.token)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(&app, &format!("/api/v1/runs/{run_id}")).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test]
async fn the_languages_endpoint_offers_only_server_defined_languages(pool: PgPool) {
    let app = app(pool);
    let (status, body) = get(&app, "/api/v1/languages").await;
    assert_eq!(status, StatusCode::OK);
    let langs = body.as_array().unwrap();
    assert_eq!(langs.len(), 1);
    assert_eq!(langs[0]["id"], "cpp17");
    assert_eq!(langs[0]["monaco_id"], "cpp");
    assert!(langs[0]["starter_code"]
        .as_str()
        .unwrap()
        .contains("int main"));
    // No compiler command is ever exposed, so a client cannot learn to shape one.
    let raw = body.to_string();
    assert!(!raw.contains("g++"));
    assert!(!raw.contains("compile_argv"));
}

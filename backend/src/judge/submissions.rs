//! The asynchronous judge: evaluating a submission against hidden tests.
//!
//! ## Idempotency
//!
//! Queue delivery is at-least-once, so this pipeline is written to be safe when
//! the same submission arrives twice, in parallel, or after a worker died
//! half-way through:
//!
//! * [`claim`] is a single guarded `UPDATE … WHERE status <> 'FINISHED'`. A
//!   finished submission can never be claimed again, so a duplicate delivery
//!   is dropped rather than re-judged.
//! * The claim also bumps `attempts` and refuses once `max_attempts` is
//!   reached, which is what makes retries bounded.
//! * Per-test rows are written with `ON CONFLICT (submission_id, test_case_id)
//!   DO UPDATE`, so a partial earlier attempt is overwritten, not duplicated.
//! * [`finish`] writes the verdict under the same guard, in one transaction
//!   with the per-test rows.
//!
//! ## Hidden data
//!
//! `test_cases.input` / `expected_output` are read here and nowhere else in the
//! submission path. They are never written into `submission_results` and never
//! returned by an API DTO.

use crate::config::Config;
use crate::judge::compare;
use crate::judge::verdict::{JudgeStatus, Verdict};
use crate::observability::metrics;
use crate::runner::{language, CompileFailure, ExecLimits, ExecStatus, Runner};
use sqlx::{PgPool, Postgres, Transaction};
use std::time::Instant;
use uuid::Uuid;

/// A submission claimed for judging.
#[derive(Debug, sqlx::FromRow)]
pub struct ClaimedSubmission {
    pub id: Uuid,
    pub user_id: Uuid,
    pub problem_id: Uuid,
    pub language: String,
    pub source_code: String,
    pub attempts: i32,
    pub time_limit_ms: i32,
    pub memory_limit_mb: i32,
    pub correlation_id: Option<String>,
}

/// Why a claim did not happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimRejection {
    /// Unknown id (deleted while queued).
    NotFound,
    /// Already judged. The duplicate delivery is simply acknowledged.
    AlreadyFinished,
    /// `attempts` has reached the configured ceiling.
    AttemptsExhausted,
}

/// One hidden or sample test to evaluate.
#[derive(Debug, sqlx::FromRow)]
struct JudgeTestCase {
    id: Uuid,
    position: i32,
    input: String,
    expected_output: String,
    is_sample: bool,
    points: i32,
}

/// Claims a submission for this worker.
///
/// The guard is in SQL so that two workers racing on the same message cannot
/// both win: exactly one `UPDATE` sees `status <> 'FINISHED'` and the attempt
/// budget available.
pub async fn claim(
    pool: &PgPool,
    submission_id: Uuid,
    worker_id: &str,
    max_attempts: i32,
) -> sqlx::Result<Result<ClaimedSubmission, ClaimRejection>> {
    let claimed = sqlx::query_as::<_, ClaimedSubmission>(
        r#"
        UPDATE submissions s
           SET status = 'RUNNING',
               claimed_by = $2,
               claimed_at = now(),
               attempts = s.attempts + 1
          FROM problems p
         WHERE s.id = $1
           AND p.id = s.problem_id
           AND s.status <> 'FINISHED'
           AND s.attempts < $3
        RETURNING s.id, s.user_id, s.problem_id, s.language, s.source_code,
                  s.attempts, s.correlation_id, p.time_limit_ms, p.memory_limit_mb
        "#,
    )
    .bind(submission_id)
    .bind(worker_id)
    .bind(max_attempts)
    .fetch_optional(pool)
    .await?;

    if let Some(c) = claimed {
        return Ok(Ok(c));
    }
    // Work out *why* it could not be claimed, so the caller can decide between
    // acknowledging the message and dead-lettering it.
    let row: Option<(String, i32)> =
        sqlx::query_as("SELECT status, attempts FROM submissions WHERE id = $1")
            .bind(submission_id)
            .fetch_optional(pool)
            .await?;
    Ok(Err(match row {
        None => ClaimRejection::NotFound,
        Some((status, _)) if status == JudgeStatus::Finished.as_str() => {
            ClaimRejection::AlreadyFinished
        }
        Some(_) => ClaimRejection::AttemptsExhausted,
    }))
}

/// Finds the oldest submission that is queued, or whose claiming worker stopped
/// reporting. Used by the PostgreSQL queue driver and by the reconciler that
/// recovers from a worker crash.
pub async fn next_recoverable(
    pool: &PgPool,
    claim_timeout_secs: i64,
) -> sqlx::Result<Option<Uuid>> {
    let mut tx = pool.begin().await?;
    let row: Option<(Uuid,)> = sqlx::query_as(
        r#"
        SELECT id FROM submissions
         WHERE status = 'QUEUED'
            OR (status = 'RUNNING'
                AND claimed_at < now() - make_interval(secs => $1::double precision))
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
        "#,
    )
    .bind(claim_timeout_secs as f64)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row.map(|(id,)| id))
}

/// Loads the tests for a problem: samples first, then hidden, in `position`
/// order. Sample cases are judged too, so a program that fails the published
/// example is told so immediately.
async fn load_tests(pool: &PgPool, problem_id: Uuid) -> sqlx::Result<Vec<JudgeTestCase>> {
    sqlx::query_as::<_, JudgeTestCase>(
        "SELECT id, position, input, expected_output, is_sample, points \
         FROM test_cases WHERE problem_id = $1 \
         ORDER BY is_sample DESC, position, id",
    )
    .bind(problem_id)
    .fetch_all(pool)
    .await
}

/// Outcome of judging one submission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JudgeReport {
    pub verdict: Verdict,
    pub passed_tests: i32,
    pub total_tests: i32,
    pub score: i32,
    pub max_score: i32,
}

/// Judges a claimed submission end to end and persists the result.
///
/// `Err` means the *judge* failed (runner unavailable, database unreachable).
/// The caller decides whether to retry or dead-letter; the submission is left
/// claimed so the reconciler can recover it either way.
pub async fn judge(
    pool: &PgPool,
    runner: &Runner,
    config: &Config,
    submission: ClaimedSubmission,
) -> Result<JudgeReport, crate::runner::RunnerError> {
    let started = Instant::now();
    let id = submission.id;

    let Some(language) = language::find(&submission.language) else {
        let report = finish_with_internal_error(
            pool,
            id,
            &format!(
                "unsupported language {:?} in stored submission",
                submission.language
            ),
        )
        .await;
        return Ok(report);
    };

    let tests = match load_tests(pool, submission.problem_id).await {
        Ok(t) => t,
        Err(e) => {
            return Err(crate::runner::RunnerError::new(format!(
                "cannot load tests: {e}"
            )))
        }
    };
    if tests.is_empty() {
        // A published problem with no tests cannot be judged; that is an
        // operator error, reported honestly rather than as "accepted".
        let report = finish_with_internal_error(pool, id, "problem has no test cases").await;
        return Ok(report);
    }
    let max_score: i32 = tests.iter().map(|t| t.points).sum();

    // --- compile once per submission -------------------------------------
    let compiled = match runner.compile(language, &submission.source_code).await {
        Ok(Ok(c)) => c,
        Ok(Err(failure)) => {
            let message = match failure {
                CompileFailure::Rejected { message } => message,
                CompileFailure::Timeout => "compilation timed out".to_string(),
            };
            let report = JudgeReport {
                verdict: Verdict::CompilationError,
                passed_tests: 0,
                total_tests: tests.len() as i32,
                score: 0,
                max_score,
            };
            finish(pool, id, report, &message, None, &[], None, None).await?;
            metrics::record_verdict(Verdict::CompilationError.as_str(), started.elapsed());
            return Ok(report);
        }
        Err(e) => return Err(e),
    };

    // --- execute every test ----------------------------------------------
    let limits = ExecLimits::clamped(
        submission.time_limit_ms as i64,
        submission.memory_limit_mb as i64,
        runner.limits(),
    );
    let mut results = Vec::with_capacity(tests.len());
    let mut passed = 0i32;
    let mut score = 0i32;
    let mut final_verdict = Verdict::Accepted;
    let mut failed_position: Option<i32> = None;
    let mut max_time_ms: Option<i32> = None;
    let mut max_memory_bytes: Option<i64> = None;

    for test in &tests {
        let outcome = runner.execute(&compiled, &test.input, limits).await?;
        max_time_ms = Some(max_time_ms.unwrap_or(0).max(outcome.time_ms as i32));
        if let Some(m) = outcome.memory_bytes {
            max_memory_bytes = Some(max_memory_bytes.unwrap_or(0).max(m));
        }

        let test_verdict = if outcome.status.is_ok() {
            if compare::matches(&outcome.stdout, &test.expected_output) {
                Verdict::Accepted
            } else {
                Verdict::WrongAnswer
            }
        } else {
            match Verdict::from_exec_status(outcome.status) {
                // ExecStatus::Ok cannot occur here.
                Verdict::Accepted => Verdict::RuntimeError,
                v => v,
            }
        };

        if test_verdict.is_accepted() {
            passed += 1;
            score += test.points;
        } else if failed_position.is_none() {
            // The first failing test decides the submission's verdict, which is
            // the convention users expect from a judge.
            final_verdict = test_verdict;
            failed_position = Some(test.position);
        }

        results.push(TestResultRecord {
            test_case_id: test.id,
            position: test.position,
            is_sample: test.is_sample,
            verdict: test_verdict,
            exec_status: outcome.status,
            execution_time_ms: Some(outcome.time_ms as i32),
            memory_bytes: outcome.memory_bytes,
            points_awarded: if test_verdict.is_accepted() {
                test.points
            } else {
                0
            },
            exit_code: outcome.exit_code,
            signal: outcome.signal,
        });

        // Stop at the first failure: there is nothing more to learn, and it
        // keeps a deliberately slow program from occupying a worker.
        if !test_verdict.is_accepted() {
            break;
        }
    }

    let report = JudgeReport {
        verdict: final_verdict,
        passed_tests: passed,
        total_tests: tests.len() as i32,
        score,
        max_score,
    };
    finish(
        pool,
        id,
        report,
        &compiled.warnings,
        failed_position,
        &results,
        max_time_ms,
        max_memory_bytes,
    )
    .await?;

    let elapsed = started.elapsed();
    metrics::record_verdict(report.verdict.as_str(), elapsed);
    tracing::info!(
        submission_id = %id,
        verdict = report.verdict.as_str(),
        passed = report.passed_tests,
        total = report.total_tests,
        duration_ms = elapsed.as_millis() as u64,
        attempt = submission.attempts,
        correlation_id = submission.correlation_id.as_deref().unwrap_or("-"),
        "submission judged"
    );
    let _ = config; // kept for future per-problem policy
    Ok(report)
}

/// A per-test row, ready to persist. Deliberately carries no input or
/// expected output.
pub struct TestResultRecord {
    pub test_case_id: Uuid,
    pub position: i32,
    pub is_sample: bool,
    pub verdict: Verdict,
    pub exec_status: ExecStatus,
    pub execution_time_ms: Option<i32>,
    pub memory_bytes: Option<i64>,
    pub points_awarded: i32,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

/// Commits the verdict and the per-test rows together, under the transition
/// guard. Returns `Ok(false)` when another worker had already finished it.
#[allow(clippy::too_many_arguments)]
async fn finish(
    pool: &PgPool,
    submission_id: Uuid,
    report: JudgeReport,
    compile_output: &str,
    failed_position: Option<i32>,
    results: &[TestResultRecord],
    max_time_ms: Option<i32>,
    max_memory_bytes: Option<i64>,
) -> Result<bool, crate::runner::RunnerError> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| crate::runner::RunnerError::new(format!("cannot begin transaction: {e}")))?;

    let updated = sqlx::query(
        "UPDATE submissions \
            SET status = 'FINISHED', verdict = $2, compile_output = $3, \
                failed_case_position = $4, passed_tests = $5, total_tests = $6, \
                score = $7, max_score = $8, max_time_ms = $9, max_memory_bytes = $10, \
                finished_at = now(), internal_error = NULL \
          WHERE id = $1 AND status <> 'FINISHED'",
    )
    .bind(submission_id)
    .bind(report.verdict.as_str())
    .bind(compile_output)
    .bind(failed_position)
    .bind(report.passed_tests)
    .bind(report.total_tests)
    .bind(report.score)
    .bind(report.max_score)
    .bind(max_time_ms)
    .bind(max_memory_bytes)
    .execute(&mut *tx)
    .await
    .map_err(|e| crate::runner::RunnerError::new(format!("cannot write verdict: {e}")))?
    .rows_affected();

    if updated == 0 {
        // Someone else finished it first. Leave their result alone — this is
        // exactly the duplicate-delivery case.
        let _ = tx.rollback().await;
        tracing::info!(
            %submission_id,
            "submission already finished by another worker; result discarded"
        );
        return Ok(false);
    }

    write_results(&mut tx, submission_id, results)
        .await
        .map_err(|e| crate::runner::RunnerError::new(format!("cannot write test results: {e}")))?;

    tx.commit()
        .await
        .map_err(|e| crate::runner::RunnerError::new(format!("cannot commit verdict: {e}")))?;
    Ok(true)
}

async fn write_results(
    tx: &mut Transaction<'_, Postgres>,
    submission_id: Uuid,
    results: &[TestResultRecord],
) -> sqlx::Result<()> {
    for r in results {
        sqlx::query(
            "INSERT INTO submission_results \
                (submission_id, test_case_id, position, is_sample, verdict, exec_status, \
                 execution_time_ms, memory_bytes, points_awarded, exit_code, signal) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) \
             ON CONFLICT (submission_id, test_case_id) DO UPDATE SET \
                 position = EXCLUDED.position, \
                 is_sample = EXCLUDED.is_sample, \
                 verdict = EXCLUDED.verdict, \
                 exec_status = EXCLUDED.exec_status, \
                 execution_time_ms = EXCLUDED.execution_time_ms, \
                 memory_bytes = EXCLUDED.memory_bytes, \
                 points_awarded = EXCLUDED.points_awarded, \
                 exit_code = EXCLUDED.exit_code, \
                 signal = EXCLUDED.signal",
        )
        .bind(submission_id)
        .bind(r.test_case_id)
        .bind(r.position)
        .bind(r.is_sample)
        .bind(r.verdict.as_str())
        .bind(r.exec_status.as_str())
        .bind(r.execution_time_ms)
        .bind(r.memory_bytes)
        .bind(r.points_awarded)
        .bind(r.exit_code)
        .bind(r.signal)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// Terminal INTERNAL_ERROR. Used when retries are exhausted or the stored row
/// cannot be judged at all, so a submission is never left silently queued.
pub async fn finish_with_internal_error(
    pool: &PgPool,
    submission_id: Uuid,
    detail: &str,
) -> JudgeReport {
    tracing::error!(%submission_id, detail, "submission failed internally");
    let _ = sqlx::query(
        "UPDATE submissions \
            SET status = 'FINISHED', verdict = 'INTERNAL_ERROR', internal_error = $2, \
                finished_at = now() \
          WHERE id = $1 AND status <> 'FINISHED'",
    )
    .bind(submission_id)
    .bind(detail)
    .execute(pool)
    .await;
    metrics::record_verdict(Verdict::InternalError.as_str(), std::time::Duration::ZERO);
    JudgeReport {
        verdict: Verdict::InternalError,
        passed_tests: 0,
        total_tests: 0,
        score: 0,
        max_score: 0,
    }
}

/// Puts a submission back in the queue after a transient failure, so the next
/// attempt (or another worker) can take it.
pub async fn release(pool: &PgPool, submission_id: Uuid) {
    let _ = sqlx::query(
        "UPDATE submissions SET status = 'QUEUED', claimed_by = NULL, claimed_at = NULL \
          WHERE id = $1 AND status = 'RUNNING'",
    )
    .bind(submission_id)
    .execute(pool)
    .await;
}

/// Number of submissions waiting or in flight — the queue backlog gauge.
pub async fn backlog(pool: &PgPool) -> sqlx::Result<(i64, i64)> {
    let row: (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*) FILTER (WHERE status = 'QUEUED'), \
                COUNT(*) FILTER (WHERE status = 'RUNNING') FROM submissions",
    )
    .fetch_one(pool)
    .await?;
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_rejections_are_distinguishable() {
        // The worker treats these three differently: acknowledge, acknowledge,
        // dead-letter. Keeping them distinct is the point.
        assert_ne!(ClaimRejection::NotFound, ClaimRejection::AlreadyFinished);
        assert_ne!(
            ClaimRejection::AlreadyFinished,
            ClaimRejection::AttemptsExhausted
        );
    }

    #[test]
    fn a_report_with_every_test_passed_is_accepted() {
        let r = JudgeReport {
            verdict: Verdict::Accepted,
            passed_tests: 5,
            total_tests: 5,
            score: 5,
            max_score: 5,
        };
        assert!(r.verdict.is_accepted());
        assert_eq!(r.passed_tests, r.total_tests);
    }
}

//! Run execution: the Phase 2 pipeline.
//!
//! A run is claimed from the `runs` table with `FOR UPDATE SKIP LOCKED`,
//! compiled once, executed against each case, and written back. This runs in
//! the **worker** process; the API only ever inserts the queued row.
//!
//! Hidden test data cannot reach this code path: the cases are built from
//! `test_cases WHERE is_sample = TRUE` or from the user's own input, and that
//! query lives in [`load_cases`] alone.

use crate::judge::compare;
use crate::observability::metrics;
use crate::runner::{language, CompileFailure, ExecLimits, ExecStatus, Runner};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

/// Terminal outcome of a run. Mirrors the `runs.outcome` CHECK constraint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    /// Every case executed; look at the individual cases for pass/fail.
    Ok,
    CompilationError,
    RuntimeError,
    TimeLimitExceeded,
    MemoryLimitExceeded,
    OutputLimitExceeded,
    InternalError,
}

impl RunOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "OK",
            Self::CompilationError => "COMPILATION_ERROR",
            Self::RuntimeError => "RUNTIME_ERROR",
            Self::TimeLimitExceeded => "TIME_LIMIT_EXCEEDED",
            Self::MemoryLimitExceeded => "MEMORY_LIMIT_EXCEEDED",
            Self::OutputLimitExceeded => "OUTPUT_LIMIT_EXCEEDED",
            Self::InternalError => "INTERNAL_ERROR",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "OK" => Some(Self::Ok),
            "COMPILATION_ERROR" => Some(Self::CompilationError),
            "RUNTIME_ERROR" => Some(Self::RuntimeError),
            "TIME_LIMIT_EXCEEDED" => Some(Self::TimeLimitExceeded),
            "MEMORY_LIMIT_EXCEEDED" => Some(Self::MemoryLimitExceeded),
            "OUTPUT_LIMIT_EXCEEDED" => Some(Self::OutputLimitExceeded),
            "INTERNAL_ERROR" => Some(Self::InternalError),
            _ => None,
        }
    }

    /// The outcome implied by the worst execution status across all cases.
    fn from_exec_status(status: ExecStatus) -> Self {
        match status {
            ExecStatus::Ok => Self::Ok,
            ExecStatus::NonZeroExit | ExecStatus::Signalled => Self::RuntimeError,
            ExecStatus::TimeLimit => Self::TimeLimitExceeded,
            ExecStatus::MemoryLimit => Self::MemoryLimitExceeded,
            ExecStatus::OutputLimit => Self::OutputLimitExceeded,
        }
    }
}

/// A run claimed for execution.
#[derive(Debug, sqlx::FromRow)]
pub struct ClaimedRun {
    pub id: Uuid,
    pub user_id: Uuid,
    pub problem_id: Uuid,
    pub language: String,
    pub source_code: String,
    pub mode: String,
    pub stdin: String,
    pub attempts: i32,
    pub time_limit_ms: i32,
    pub memory_limit_mb: i32,
    pub correlation_id: Option<String>,
}

/// One case to execute.
#[derive(Debug)]
pub struct RunCase {
    pub position: i32,
    pub label: String,
    pub input: String,
    pub expected_output: Option<String>,
}

/// Atomically claims the oldest queued run, or an abandoned one whose worker
/// stopped reporting. `SKIP LOCKED` lets several workers poll the same table
/// without blocking each other.
pub async fn claim_next(
    pool: &PgPool,
    worker_id: &str,
    claim_timeout_secs: i64,
) -> sqlx::Result<Option<ClaimedRun>> {
    let mut tx = pool.begin().await?;
    let claimed = sqlx::query_as::<_, ClaimedRun>(
        r#"
        WITH next AS (
            SELECT r.id
            FROM runs r
            WHERE r.status = 'QUEUED'
               OR (r.status = 'RUNNING'
                   AND r.claimed_at < now() - make_interval(secs => $2::double precision))
            ORDER BY r.created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE runs r
           SET status = 'RUNNING',
               claimed_by = $1,
               claimed_at = now(),
               attempts = r.attempts + 1
          FROM next, problems p
         WHERE r.id = next.id AND p.id = r.problem_id
        RETURNING r.id, r.user_id, r.problem_id, r.language, r.source_code,
                  r.mode, r.stdin, r.attempts, r.correlation_id,
                  p.time_limit_ms, p.memory_limit_mb
        "#,
    )
    .bind(worker_id)
    .bind(claim_timeout_secs as f64)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(claimed)
}

/// Builds the cases for a run.
///
/// This is the only query in the run path that reads `test_cases`, and it is
/// hard-filtered to `is_sample = TRUE`.
pub async fn load_cases(pool: &PgPool, run: &ClaimedRun) -> sqlx::Result<Vec<RunCase>> {
    if run.mode == "CUSTOM" {
        return Ok(vec![RunCase {
            position: 1,
            label: "Custom input".into(),
            input: run.stdin.clone(),
            expected_output: None,
        }]);
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT input, expected_output FROM test_cases \
         WHERE problem_id = $1 AND is_sample = TRUE ORDER BY position, id",
    )
    .bind(run.problem_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .enumerate()
        .map(|(i, (input, expected))| RunCase {
            position: i as i32 + 1,
            label: format!("Sample {}", i + 1),
            input,
            expected_output: Some(expected),
        })
        .collect())
}

/// Compiles and executes a claimed run, then persists the result.
///
/// Returns `Err` only for infrastructure failures; everything the user's code
/// did wrong is recorded as a normal outcome.
pub async fn execute_run(
    pool: &PgPool,
    runner: &Runner,
    run: ClaimedRun,
) -> Result<RunOutcome, crate::runner::RunnerError> {
    let started = std::time::Instant::now();
    let Some(language) = language::find(&run.language) else {
        // Validated by the API; reaching here means the row is corrupt.
        finish_internal(pool, run.id, "unsupported language in stored run").await;
        return Ok(RunOutcome::InternalError);
    };
    let cases = match load_cases(pool, &run).await {
        Ok(c) => c,
        Err(e) => {
            finish_internal(pool, run.id, &format!("cannot load run cases: {e}")).await;
            return Ok(RunOutcome::InternalError);
        }
    };

    // --- compile ---------------------------------------------------------
    let compiled = match runner.compile(language, &run.source_code).await {
        Ok(Ok(c)) => c,
        Ok(Err(CompileFailure::Rejected { message })) => {
            finish(
                pool,
                run.id,
                RunOutcome::CompilationError,
                &message,
                None,
                &[],
            )
            .await;
            metrics::record_run(RunOutcome::CompilationError.as_str(), started.elapsed());
            return Ok(RunOutcome::CompilationError);
        }
        Ok(Err(CompileFailure::Timeout)) => {
            finish(
                pool,
                run.id,
                RunOutcome::CompilationError,
                "compilation timed out",
                None,
                &[],
            )
            .await;
            metrics::record_run(RunOutcome::CompilationError.as_str(), started.elapsed());
            return Ok(RunOutcome::CompilationError);
        }
        // The runner itself failed: leave the row for a retry.
        Err(e) => return Err(e),
    };

    // --- execute ---------------------------------------------------------
    let limits = ExecLimits::clamped(
        run.time_limit_ms as i64,
        run.memory_limit_mb as i64,
        runner.limits(),
    );
    let mut records = Vec::with_capacity(cases.len());
    let mut worst = ExecStatus::Ok;
    for case in &cases {
        let outcome = runner.execute(&compiled, &case.input, limits).await?;
        let passed = case
            .expected_output
            .as_deref()
            .map(|expected| outcome.status.is_ok() && compare::matches(&outcome.stdout, expected));
        if !outcome.status.is_ok() && worst.is_ok() {
            worst = outcome.status;
        }
        records.push(CaseRecord {
            position: case.position,
            label: case.label.clone(),
            input: case.input.clone(),
            expected_output: case.expected_output.clone(),
            outcome,
            passed,
        });
    }

    let run_outcome = RunOutcome::from_exec_status(worst);
    finish(
        pool,
        run.id,
        run_outcome,
        &compiled.warnings,
        Some(compiled.compile_time_ms),
        &records,
    )
    .await;
    metrics::record_run(run_outcome.as_str(), started.elapsed());
    Ok(run_outcome)
}

/// One finished case, ready to persist.
pub struct CaseRecord {
    pub position: i32,
    pub label: String,
    pub input: String,
    pub expected_output: Option<String>,
    pub outcome: crate::runner::ExecOutcome,
    pub passed: Option<bool>,
}

/// Writes the terminal state and all cases in one transaction, guarded so a
/// duplicate execution cannot overwrite a finished run.
async fn finish(
    pool: &PgPool,
    run_id: Uuid,
    outcome: RunOutcome,
    compile_output: &str,
    compile_time_ms: Option<i64>,
    cases: &[CaseRecord],
) {
    let mut tx = match pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(%run_id, error = %e, "cannot open transaction to finish run");
            return;
        }
    };
    if let Err(e) = write_finish(
        &mut tx,
        run_id,
        outcome,
        compile_output,
        compile_time_ms,
        cases,
    )
    .await
    {
        tracing::error!(%run_id, error = %e, "cannot persist run result");
        let _ = tx.rollback().await;
        return;
    }
    if let Err(e) = tx.commit().await {
        tracing::error!(%run_id, error = %e, "cannot commit run result");
    }
}

async fn write_finish(
    tx: &mut Transaction<'_, Postgres>,
    run_id: Uuid,
    outcome: RunOutcome,
    compile_output: &str,
    compile_time_ms: Option<i64>,
    cases: &[CaseRecord],
) -> sqlx::Result<()> {
    let updated = sqlx::query(
        "UPDATE runs SET status = 'FINISHED', outcome = $2, compile_output = $3, \
                         compile_time_ms = $4, finished_at = now() \
         WHERE id = $1 AND status <> 'FINISHED'",
    )
    .bind(run_id)
    .bind(outcome.as_str())
    .bind(compile_output)
    .bind(compile_time_ms.map(|v| v as i32))
    .execute(&mut **tx)
    .await?
    .rows_affected();
    if updated == 0 {
        // Already finished by another worker: do not duplicate the cases.
        tracing::debug!(%run_id, "run already finished; skipping result write");
        return Ok(());
    }
    // A retry may have written partial cases; replace them wholesale.
    sqlx::query("DELETE FROM run_cases WHERE run_id = $1")
        .bind(run_id)
        .execute(&mut **tx)
        .await?;
    for c in cases {
        sqlx::query(
            "INSERT INTO run_cases (run_id, position, label, input, expected_output, \
                 stdout, stderr, stdout_truncated, stderr_truncated, exec_status, passed, \
                 time_ms, memory_bytes, exit_code, signal) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        )
        .bind(run_id)
        .bind(c.position)
        .bind(&c.label)
        .bind(&c.input)
        .bind(&c.expected_output)
        .bind(&c.outcome.stdout)
        .bind(&c.outcome.stderr)
        .bind(c.outcome.stdout_truncated)
        .bind(c.outcome.stderr_truncated)
        .bind(c.outcome.status.as_str())
        .bind(c.passed)
        .bind(c.outcome.time_ms as i32)
        .bind(c.outcome.memory_bytes)
        .bind(c.outcome.exit_code)
        .bind(c.outcome.signal)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// Marks a run as internally failed. The detail is stored for operators and is
/// never returned by the API.
pub async fn finish_internal(pool: &PgPool, run_id: Uuid, detail: &str) {
    tracing::error!(%run_id, detail, "run failed internally");
    let _ = sqlx::query(
        "UPDATE runs SET status = 'FINISHED', outcome = 'INTERNAL_ERROR', \
                         internal_error = $2, finished_at = now() \
         WHERE id = $1 AND status <> 'FINISHED'",
    )
    .bind(run_id)
    .bind(detail)
    .execute(pool)
    .await;
    metrics::record_run("INTERNAL_ERROR", std::time::Duration::ZERO);
}

/// Returns a run to the queue so another attempt can pick it up.
pub async fn requeue(pool: &PgPool, run_id: Uuid) {
    let _ = sqlx::query(
        "UPDATE runs SET status = 'QUEUED', claimed_by = NULL, claimed_at = NULL \
         WHERE id = $1 AND status = 'RUNNING'",
    )
    .bind(run_id)
    .execute(pool)
    .await;
}

/// Deletes runs past their retention window. Returns how many went.
pub async fn purge_expired(pool: &PgPool) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM runs WHERE expires_at < now()")
        .execute(pool)
        .await?
        .rows_affected())
}

/// Default retention for a new run.
pub fn expires_at(retention_hours: i64) -> DateTime<Utc> {
    Utc::now() + chrono::Duration::hours(retention_hours.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_outcome_round_trips() {
        for o in [
            RunOutcome::Ok,
            RunOutcome::CompilationError,
            RunOutcome::RuntimeError,
            RunOutcome::TimeLimitExceeded,
            RunOutcome::MemoryLimitExceeded,
            RunOutcome::OutputLimitExceeded,
            RunOutcome::InternalError,
        ] {
            assert_eq!(RunOutcome::parse(o.as_str()), Some(o));
        }
        assert_eq!(RunOutcome::parse("WRONG_ANSWER"), None);
    }

    #[test]
    fn exec_status_maps_to_run_outcome() {
        assert_eq!(RunOutcome::from_exec_status(ExecStatus::Ok), RunOutcome::Ok);
        assert_eq!(
            RunOutcome::from_exec_status(ExecStatus::TimeLimit),
            RunOutcome::TimeLimitExceeded
        );
        assert_eq!(
            RunOutcome::from_exec_status(ExecStatus::OutputLimit),
            RunOutcome::OutputLimitExceeded
        );
        assert_eq!(
            RunOutcome::from_exec_status(ExecStatus::Signalled),
            RunOutcome::RuntimeError
        );
    }

    #[test]
    fn retention_is_in_the_future() {
        assert!(expires_at(24) > Utc::now());
        // A nonsensical retention still yields a usable window.
        assert!(expires_at(0) > Utc::now());
    }
}

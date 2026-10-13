//! `POST /runs` and `GET /runs/{id}` — the Phase 2 Run service.
//!
//! The API's whole job here is to validate the request and insert a `QUEUED`
//! row. `codearena-worker` claims it, compiles it in a sandbox and writes the
//! result back. The API process never compiles or executes anything, so a
//! malicious submission has no path into it.
//!
//! Because the work is done elsewhere, the API stays responsive while a program
//! is compiling. Clients can either poll `GET /runs/{id}` or pass
//! `?wait_ms=…` to have the request held open until the run reaches a terminal
//! state, which makes the editor's Run button feel synchronous without blocking
//! a request on compilation inside the handler.

use crate::{
    auth::AuthUser,
    error::{AppError, AppJson, AppQuery, AppResult},
    judge::runs::{expires_at, RunOutcome},
    observability::CorrelationId,
    runner::language,
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::time::Duration;
use uuid::Uuid;

/// Largest `wait_ms` a client may ask for on `GET /runs/{id}`.
const MAX_WAIT_MS: u64 = 15_000;

#[derive(Debug, Deserialize)]
pub struct CreateRunRequest {
    /// Problem slug the code is written against; supplies the limits and samples.
    pub problem_id: String,
    pub language: String,
    pub source_code: String,
    /// `"samples"` (default) or `"custom"`.
    #[serde(default)]
    pub mode: Option<String>,
    /// stdin for `mode = "custom"`.
    #[serde(default)]
    pub stdin: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateRunResponse {
    pub run_id: Uuid,
    pub status: &'static str,
}

#[derive(Debug, Serialize, FromRow)]
pub struct RunCaseDto {
    pub position: i32,
    pub label: String,
    /// Public sample input or the user's own input — never hidden test data.
    pub input: String,
    pub expected_output: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub exec_status: String,
    pub passed: Option<bool>,
    pub time_ms: Option<i32>,
    pub memory_bytes: Option<i64>,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct RunDto {
    pub run_id: Uuid,
    pub problem_slug: String,
    pub language: String,
    pub mode: String,
    pub status: String,
    /// `null` until the run finishes.
    pub outcome: Option<String>,
    /// Compiler diagnostics. Belongs to the author of the code, so it is only
    /// ever returned to them.
    pub compile_output: String,
    pub compile_time_ms: Option<i32>,
    pub cases: Vec<RunCaseDto>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    /// A one-line, user-safe explanation when something went wrong.
    pub message: Option<String>,
}

#[derive(Debug, FromRow)]
struct RunRow {
    id: Uuid,
    user_id: Uuid,
    problem_slug: String,
    language: String,
    mode: String,
    status: String,
    outcome: Option<String>,
    compile_output: String,
    compile_time_ms: Option<i32>,
    created_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}

fn mode_from_request(raw: Option<&str>) -> AppResult<&'static str> {
    match raw.map(str::trim).map(str::to_lowercase).as_deref() {
        None | Some("") | Some("samples") => Ok("SAMPLES"),
        Some("custom") => Ok("CUSTOM"),
        Some(other) => Err(AppError::BadRequest(format!(
            "mode must be \"samples\" or \"custom\" (got {other:?})"
        ))),
    }
}

/// POST /api/v1/runs — queue a run of the caller's own code.
pub async fn create(
    State(state): State<AppState>,
    auth: AuthUser,
    Extension(correlation): Extension<CorrelationId>,
    AppJson(req): AppJson<CreateRunRequest>,
) -> AppResult<(StatusCode, Json<CreateRunResponse>)> {
    // Per-user rate limit: executing code is the most expensive thing the
    // platform does, and the identity comes from the verified token.
    let decision = state
        .limiter
        .check("run", &auth.id.to_string(), state.config.rate_limits.run)
        .await;
    if !decision.allowed {
        return Err(AppError::TooManyRequests {
            message: "too many runs; please wait before running again".into(),
            retry_after_secs: decision.retry_after_secs,
        });
    }

    let language = language::find(req.language.trim()).ok_or_else(|| {
        AppError::BadRequest(format!(
            "unsupported language; supported: {}",
            language::supported_ids()
        ))
    })?;
    let mode = mode_from_request(req.mode.as_deref())?;
    let limits = &state.config.runner_limits;

    if req.source_code.trim().is_empty() {
        return Err(AppError::BadRequest("source_code must not be empty".into()));
    }
    if req.source_code.len() > limits.max_source_bytes {
        return Err(AppError::BadRequest(format!(
            "source_code must be at most {} bytes",
            limits.max_source_bytes
        )));
    }
    let stdin = req.stdin.unwrap_or_default();
    if stdin.len() > limits.max_input_bytes {
        return Err(AppError::BadRequest(format!(
            "stdin must be at most {} bytes",
            limits.max_input_bytes
        )));
    }
    if mode == "SAMPLES" && !stdin.is_empty() {
        return Err(AppError::BadRequest(
            "stdin is only accepted when mode is \"custom\"".into(),
        ));
    }

    // Only published problems: an unpublished one is not visible to users, and
    // running against it would expose that it exists.
    let problem: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM problems WHERE slug = $1 AND published = TRUE")
            .bind(req.problem_id.trim())
            .fetch_optional(&state.pool)
            .await?;
    let (problem_id,) = problem.ok_or_else(|| AppError::NotFound("problem not found".into()))?;

    if mode == "SAMPLES" {
        let (samples,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM test_cases WHERE problem_id = $1 AND is_sample = TRUE",
        )
        .bind(problem_id)
        .fetch_one(&state.pool)
        .await?;
        if samples == 0 {
            return Err(AppError::BadRequest(
                "this problem has no public samples; supply custom input instead".into(),
            ));
        }
    }

    let (run_id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO runs (user_id, problem_id, language, source_code, mode, stdin, \
                           expires_at, correlation_id) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    )
    .bind(auth.id)
    .bind(problem_id)
    .bind(language.id)
    .bind(&req.source_code)
    .bind(mode)
    .bind(&stdin)
    .bind(expires_at(state.config.run_retention_hours))
    .bind(correlation.as_str())
    .fetch_one(&state.pool)
    .await?;

    tracing::info!(
        %run_id,
        user_id = %auth.id,
        mode,
        correlation_id = correlation.as_str(),
        "run queued"
    );
    Ok((
        StatusCode::ACCEPTED,
        Json(CreateRunResponse {
            run_id,
            status: "QUEUED",
        }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct GetRunParams {
    /// Hold the request open until the run finishes, up to this many
    /// milliseconds. Bounded by [`MAX_WAIT_MS`].
    pub wait_ms: Option<u64>,
}

/// GET /api/v1/runs/{id} — status and output of the caller's own run.
pub async fn get(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(run_id): Path<Uuid>,
    AppQuery(params): AppQuery<GetRunParams>,
) -> AppResult<Json<RunDto>> {
    let deadline = params
        .wait_ms
        .map(|ms| std::time::Instant::now() + Duration::from_millis(ms.min(MAX_WAIT_MS)));

    loop {
        let row = load_run(&state, run_id).await?;
        // A run belonging to someone else is reported as missing, so the
        // endpoint cannot be used to discover other users' activity.
        if !auth.may_access(row.user_id) {
            return Err(AppError::NotFound("run not found".into()));
        }
        let finished = row.status == "FINISHED";
        if finished || deadline.is_none_or(|d| std::time::Instant::now() >= d) {
            let cases = if finished {
                load_cases(&state, run_id).await?
            } else {
                Vec::new()
            };
            return Ok(Json(to_dto(row, cases)));
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

async fn load_run(state: &AppState, run_id: Uuid) -> AppResult<RunRow> {
    sqlx::query_as::<_, RunRow>(
        "SELECT r.id, r.user_id, p.slug AS problem_slug, r.language, r.mode, r.status, \
                r.outcome, r.compile_output, r.compile_time_ms, r.created_at, r.finished_at \
           FROM runs r JOIN problems p ON p.id = r.problem_id \
          WHERE r.id = $1",
    )
    .bind(run_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("run not found".into()))
}

async fn load_cases(state: &AppState, run_id: Uuid) -> AppResult<Vec<RunCaseDto>> {
    Ok(sqlx::query_as::<_, RunCaseDto>(
        "SELECT position, label, input, expected_output, stdout, stderr, \
                stdout_truncated, stderr_truncated, exec_status, passed, \
                time_ms, memory_bytes, exit_code, signal \
           FROM run_cases WHERE run_id = $1 ORDER BY position",
    )
    .bind(run_id)
    .fetch_all(&state.pool)
    .await?)
}

fn to_dto(row: RunRow, cases: Vec<RunCaseDto>) -> RunDto {
    let outcome = row.outcome.as_deref().and_then(RunOutcome::parse);
    RunDto {
        run_id: row.id,
        problem_slug: row.problem_slug,
        language: row.language,
        mode: row.mode,
        status: row.status,
        outcome: row.outcome.clone(),
        compile_output: row.compile_output,
        compile_time_ms: row.compile_time_ms,
        cases,
        created_at: row.created_at,
        finished_at: row.finished_at,
        message: outcome.and_then(outcome_message),
    }
}

/// A user-facing sentence for a failed run. Deliberately generic for
/// `INTERNAL_ERROR`: the stored detail is for operators only.
fn outcome_message(outcome: RunOutcome) -> Option<String> {
    Some(match outcome {
        RunOutcome::Ok => return None,
        RunOutcome::CompilationError => "Your code did not compile.".into(),
        RunOutcome::RuntimeError => "Your program crashed while running.".into(),
        RunOutcome::TimeLimitExceeded => "Your program exceeded the time limit.".into(),
        RunOutcome::MemoryLimitExceeded => "Your program exceeded the memory limit.".into(),
        RunOutcome::OutputLimitExceeded => "Your program produced too much output.".into(),
        RunOutcome::InternalError => "The judge could not run your code. Please try again.".into(),
    })
}

/// GET /api/v1/languages — what the editor may offer, and the starter code.
#[derive(Debug, Serialize)]
pub struct LanguageDto {
    pub id: &'static str,
    pub display_name: &'static str,
    pub monaco_id: &'static str,
    pub starter_code: &'static str,
}

pub async fn languages() -> Json<Vec<LanguageDto>> {
    Json(
        language::ALL
            .iter()
            .map(|l| LanguageDto {
                id: l.id,
                display_name: l.display_name,
                monaco_id: l.monaco_id,
                starter_code: l.starter_code,
            })
            .collect(),
    )
}

/// Client-visible execution limits, so the editor can warn before a request is
/// rejected. Nothing secret: these are the same numbers in the error messages.
#[derive(Debug, Serialize)]
pub struct LimitsDto {
    pub max_source_bytes: usize,
    pub max_input_bytes: usize,
    pub max_output_bytes: usize,
}

pub async fn limits(State(state): State<AppState>) -> Json<LimitsDto> {
    let l = &state.config.runner_limits;
    Json(LimitsDto {
        max_source_bytes: l.max_source_bytes,
        max_input_bytes: l.max_input_bytes,
        max_output_bytes: l.max_output_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_are_normalised_and_validated() {
        assert_eq!(mode_from_request(None).unwrap(), "SAMPLES");
        assert_eq!(mode_from_request(Some("")).unwrap(), "SAMPLES");
        assert_eq!(mode_from_request(Some("Samples")).unwrap(), "SAMPLES");
        assert_eq!(mode_from_request(Some(" custom ")).unwrap(), "CUSTOM");
        assert!(mode_from_request(Some("hidden")).is_err());
        // There is deliberately no mode that reaches hidden tests.
        assert!(mode_from_request(Some("all")).is_err());
    }

    #[test]
    fn every_failure_has_a_user_safe_message() {
        assert!(outcome_message(RunOutcome::Ok).is_none());
        for o in [
            RunOutcome::CompilationError,
            RunOutcome::RuntimeError,
            RunOutcome::TimeLimitExceeded,
            RunOutcome::MemoryLimitExceeded,
            RunOutcome::OutputLimitExceeded,
            RunOutcome::InternalError,
        ] {
            let m = outcome_message(o).unwrap();
            assert!(!m.is_empty());
            // Operator detail must never be templated into a user message.
            assert!(!m.contains("internal_error"));
            assert!(!m.contains('{'));
        }
    }

    #[test]
    fn wait_is_bounded() {
        let asked = 10_000_000u64;
        assert_eq!(asked.min(MAX_WAIT_MS), MAX_WAIT_MS);
    }
}

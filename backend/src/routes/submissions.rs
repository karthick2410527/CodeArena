//! `POST /submissions`, `GET /submissions`, `GET /submissions/{id}` and
//! `GET /submissions/{id}/test-results`.
//!
//! ## What the API does, and does not do
//!
//! `POST /submissions` validates the request, writes the `QUEUED` row **and**
//! the outbox event in one transaction, and returns `202 Accepted` with a
//! stable id. It does not wait for judging and it never executes anything.
//!
//! ## Privacy rules enforced here
//!
//! * `source_code` is returned only to its owner (or an administrator).
//! * A submission belonging to someone else is reported as `404`, not `403`,
//!   so these endpoints cannot be used to enumerate other users' activity.
//! * `test-results` returns verdict, timing and memory per test — never the
//!   input or the expected output, for sample or hidden cases alike. The DTO
//!   has no field that could carry them.

use crate::{
    auth::AuthUser,
    error::{AppError, AppJson, AppQuery, AppResult},
    judge::verdict::{public_status, JudgeStatus, Verdict},
    observability::CorrelationId,
    queue::{outbox, JudgeJob},
    routes::pagination::{Page, Paginated},
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
use sqlx::{FromRow, Postgres, QueryBuilder};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct CreateSubmissionRequest {
    /// Problem slug, as in the specification's example payload.
    pub problem_id: String,
    pub language: String,
    pub source_code: String,
}

#[derive(Debug, Serialize)]
pub struct CreateSubmissionResponse {
    pub submission_id: Uuid,
    pub status: &'static str,
}

/// POST /api/v1/submissions — queue a submission for full judging.
pub async fn create(
    State(state): State<AppState>,
    auth: AuthUser,
    Extension(correlation): Extension<CorrelationId>,
    AppJson(req): AppJson<CreateSubmissionRequest>,
) -> AppResult<(StatusCode, Json<CreateSubmissionResponse>)> {
    let decision = state
        .limiter
        .check(
            "submit",
            &auth.id.to_string(),
            state.config.rate_limits.submit,
        )
        .await;
    if !decision.allowed {
        return Err(AppError::TooManyRequests {
            message: "too many submissions; please wait before submitting again".into(),
            retry_after_secs: decision.retry_after_secs,
        });
    }

    let language = language::find(req.language.trim()).ok_or_else(|| {
        AppError::BadRequest(format!(
            "unsupported language; supported: {}",
            language::supported_ids()
        ))
    })?;
    if req.source_code.trim().is_empty() {
        return Err(AppError::BadRequest("source_code must not be empty".into()));
    }
    let max = state.config.runner_limits.max_source_bytes;
    if req.source_code.len() > max {
        return Err(AppError::BadRequest(format!(
            "source_code must be at most {max} bytes"
        )));
    }

    let problem: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM problems WHERE slug = $1 AND published = TRUE")
            .bind(req.problem_id.trim())
            .fetch_optional(&state.pool)
            .await?;
    let (problem_id,) = problem.ok_or_else(|| AppError::NotFound("problem not found".into()))?;

    // A published problem with no tests cannot be judged; refuse up front
    // rather than queueing work that can only fail.
    let (tests,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM test_cases WHERE problem_id = $1")
        .bind(problem_id)
        .fetch_one(&state.pool)
        .await?;
    if tests == 0 {
        return Err(AppError::Unavailable(
            "this problem has no test cases yet and cannot be judged".into(),
        ));
    }

    // ---- the atomic part -------------------------------------------------
    // The submission row and the queue event are written together. Either both
    // exist or neither does, which is what removes the dual-write gap.
    let mut tx = state.pool.begin().await?;
    let (submission_id,): (Uuid,) = sqlx::query_as(
        "INSERT INTO submissions (user_id, problem_id, language, source_code, correlation_id) \
         VALUES ($1,$2,$3,$4,$5) RETURNING id",
    )
    .bind(auth.id)
    .bind(problem_id)
    .bind(language.id)
    .bind(&req.source_code)
    .bind(correlation.as_str())
    .fetch_one(&mut *tx)
    .await?;

    let job = JudgeJob {
        submission_id,
        problem_id,
        user_id: auth.id,
        language: language.id.to_string(),
        correlation_id: Some(correlation.0.clone()),
        enqueued_at: Utc::now(),
    };
    outbox::enqueue(&mut tx, &job).await?;
    tx.commit().await?;
    // ----------------------------------------------------------------------

    // Best-effort fast path for the Kafka driver: get the job onto the topic
    // now instead of waiting for the publisher's next tick. A failure here is
    // harmless — the outbox row is committed and will be retried.
    //
    // Under the PostgreSQL driver the outbox row *is* the queue entry, so
    // nothing is published and nothing is marked: marking it here would make
    // the job invisible to workers and the submission would never be judged.
    if state.publisher.driver() != "postgres" {
        match state.publisher.publish(&job).await {
            Ok(()) => {
                let _ = sqlx::query(
                    "UPDATE outbox_events SET published_at = now() \
                      WHERE aggregate_id = $1 AND published_at IS NULL",
                )
                .bind(submission_id)
                .execute(&state.pool)
                .await;
            }
            Err(e) => tracing::warn!(
                %submission_id,
                error = %e,
                "immediate publish failed; the outbox publisher will retry"
            ),
        }
    }

    tracing::info!(
        %submission_id,
        user_id = %auth.id,
        language = language.id,
        correlation_id = correlation.as_str(),
        "submission accepted"
    );
    Ok((
        StatusCode::ACCEPTED,
        Json(CreateSubmissionResponse {
            submission_id,
            status: JudgeStatus::Queued.as_str(),
        }),
    ))
}

// ------------------------------------------------------------------ reading

#[derive(Debug, FromRow)]
struct SubmissionRow {
    id: Uuid,
    user_id: Uuid,
    username: String,
    problem_slug: String,
    problem_title: String,
    language: String,
    source_code: String,
    status: String,
    verdict: Option<String>,
    compile_output: String,
    failed_case_position: Option<i32>,
    passed_tests: i32,
    total_tests: i32,
    score: i32,
    max_score: i32,
    max_time_ms: Option<i32>,
    max_memory_bytes: Option<i64>,
    created_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}

/// Full view of one submission. `source_code` is present only for the owner.
#[derive(Debug, Serialize)]
pub struct SubmissionDto {
    pub submission_id: Uuid,
    pub username: String,
    pub problem_slug: String,
    pub problem_title: String,
    pub language: String,
    /// Flattened lifecycle-or-verdict: QUEUED, RUNNING, ACCEPTED, …
    pub status: String,
    /// The verdict once judging has finished, otherwise `null`.
    pub verdict: Option<String>,
    pub passed_tests: i32,
    pub total_tests: i32,
    pub score: i32,
    pub max_score: i32,
    pub failed_case_position: Option<i32>,
    pub execution_time_ms: Option<i32>,
    pub memory_bytes: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compile_output: Option<String>,
    pub message: Option<String>,
}

/// Row in the history list. No source code: a list is not a place to ship
/// everybody's code.
#[derive(Debug, Serialize)]
pub struct SubmissionSummaryDto {
    pub submission_id: Uuid,
    pub problem_slug: String,
    pub problem_title: String,
    pub language: String,
    pub status: String,
    pub verdict: Option<String>,
    pub passed_tests: i32,
    pub total_tests: i32,
    pub execution_time_ms: Option<i32>,
    pub memory_bytes: Option<i64>,
    pub created_at: DateTime<Utc>,
}

fn to_dto(row: SubmissionRow, include_private: bool) -> SubmissionDto {
    let status = JudgeStatus::parse(&row.status).unwrap_or(JudgeStatus::Queued);
    let verdict = row.verdict.as_deref().and_then(Verdict::parse);
    SubmissionDto {
        submission_id: row.id,
        username: row.username,
        problem_slug: row.problem_slug,
        problem_title: row.problem_title,
        language: row.language,
        status: public_status(status, verdict),
        verdict: verdict.map(|v| v.as_str().to_string()),
        passed_tests: row.passed_tests,
        total_tests: row.total_tests,
        score: row.score,
        max_score: row.max_score,
        failed_case_position: row.failed_case_position,
        execution_time_ms: row.max_time_ms,
        memory_bytes: row.max_memory_bytes,
        created_at: row.created_at,
        finished_at: row.finished_at,
        source_code: include_private.then_some(row.source_code),
        compile_output: include_private.then_some(row.compile_output),
        message: verdict.and_then(verdict_message),
    }
}

/// A short explanation for the UI. `INTERNAL_ERROR` stays generic: the stored
/// `internal_error` detail is for operators and is never returned.
fn verdict_message(v: Verdict) -> Option<String> {
    Some(match v {
        Verdict::Accepted => return None,
        Verdict::WrongAnswer => "Your output did not match the expected output.".into(),
        Verdict::CompilationError => "Your code did not compile.".into(),
        Verdict::RuntimeError => "Your program crashed on at least one test.".into(),
        Verdict::TimeLimitExceeded => "Your program exceeded the time limit.".into(),
        Verdict::MemoryLimitExceeded => "Your program exceeded the memory limit.".into(),
        Verdict::InternalError => {
            "The judge could not finish this submission. Please submit again.".into()
        }
    })
}

const SELECT_SUBMISSION: &str = "\
    SELECT s.id, s.user_id, u.username, p.slug AS problem_slug, p.title AS problem_title, \
           s.language, s.source_code, s.status, s.verdict, s.compile_output, \
           s.failed_case_position, s.passed_tests, s.total_tests, s.score, s.max_score, \
           s.max_time_ms, s.max_memory_bytes, s.created_at, s.finished_at \
      FROM submissions s \
      JOIN users u ON u.id = s.user_id \
      JOIN problems p ON p.id = s.problem_id";

/// GET /api/v1/submissions/{id}
pub async fn get(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(submission_id): Path<Uuid>,
) -> AppResult<Json<SubmissionDto>> {
    let row = sqlx::query_as::<_, SubmissionRow>(&format!("{SELECT_SUBMISSION} WHERE s.id = $1"))
        .bind(submission_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("submission not found".into()))?;

    // Someone else's submission is indistinguishable from one that is not there.
    if !auth.may_access(row.user_id) {
        return Err(AppError::NotFound("submission not found".into()));
    }
    let include_private = auth.may_access(row.user_id);
    Ok(Json(to_dto(row, include_private)))
}

#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub page: Option<u32>,
    pub limit: Option<u32>,
    /// Problem slug.
    pub problem: Option<String>,
    pub verdict: Option<String>,
    pub language: Option<String>,
    /// Administrators only: another user's history. Ignored for everyone else.
    pub user: Option<String>,
}

/// GET /api/v1/submissions — the caller's own submission history.
pub async fn list(
    State(state): State<AppState>,
    auth: AuthUser,
    AppQuery(params): AppQuery<ListParams>,
) -> AppResult<Json<Paginated<SubmissionSummaryDto>>> {
    let page = Page::new(params.page, params.limit)?;

    // Default and, for non-admins, *only* option: your own submissions.
    let mut target_user = auth.id;
    if let Some(requested) = params
        .user
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !auth.is_admin() {
            return Err(AppError::Forbidden(
                "only administrators may list another user's submissions".into(),
            ));
        }
        let found: Option<(Uuid,)> =
            sqlx::query_as("SELECT id FROM users WHERE lower(username) = lower($1)")
                .bind(requested)
                .fetch_optional(&state.pool)
                .await?;
        target_user = found
            .ok_or_else(|| AppError::NotFound("user not found".into()))?
            .0;
    }

    let verdict = match params
        .verdict
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => None,
        Some(raw) => {
            let upper = raw.to_uppercase();
            // Both terminal verdicts and the two lifecycle states are useful
            // filters in a history view.
            if upper == JudgeStatus::Queued.as_str() || upper == JudgeStatus::Running.as_str() {
                Some(StatusFilter::Lifecycle(upper))
            } else {
                Some(StatusFilter::Verdict(
                    Verdict::parse(&upper)
                        .ok_or_else(|| {
                            AppError::BadRequest(format!(
                                "unknown verdict {raw:?}; expected one of {}",
                                Verdict::ALL
                                    .iter()
                                    .map(|v| v.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ))
                        })?
                        .as_str()
                        .to_string(),
                ))
            }
        }
    };
    let language = match params
        .language
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => None,
        Some(raw) => Some(
            language::find(raw)
                .ok_or_else(|| AppError::BadRequest("unknown language".into()))?
                .id
                .to_string(),
        ),
    };
    let problem = params
        .problem
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .map(str::to_string);

    let mut count = QueryBuilder::<Postgres>::new(
        "SELECT COUNT(*) FROM submissions s JOIN problems p ON p.id = s.problem_id",
    );
    push_filters(&mut count, target_user, &problem, &verdict, &language);
    let total: i64 = count.build_query_scalar().fetch_one(&state.pool).await?;

    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT s.id, p.slug AS problem_slug, p.title AS problem_title, s.language, \
                s.status, s.verdict, s.passed_tests, s.total_tests, s.max_time_ms, \
                s.max_memory_bytes, s.created_at \
           FROM submissions s JOIN problems p ON p.id = s.problem_id",
    );
    push_filters(&mut qb, target_user, &problem, &verdict, &language);
    // Matches the (user_id, created_at DESC) index.
    qb.push(" ORDER BY s.created_at DESC, s.id DESC LIMIT ")
        .push_bind(page.limit_i64())
        .push(" OFFSET ")
        .push_bind(page.offset());

    let rows: Vec<SummaryRow> = qb.build_query_as().fetch_all(&state.pool).await?;
    let items = rows
        .into_iter()
        .map(|r| {
            let status = JudgeStatus::parse(&r.status).unwrap_or(JudgeStatus::Queued);
            let verdict = r.verdict.as_deref().and_then(Verdict::parse);
            SubmissionSummaryDto {
                submission_id: r.id,
                problem_slug: r.problem_slug,
                problem_title: r.problem_title,
                language: r.language,
                status: public_status(status, verdict),
                verdict: verdict.map(|v| v.as_str().to_string()),
                passed_tests: r.passed_tests,
                total_tests: r.total_tests,
                execution_time_ms: r.max_time_ms,
                memory_bytes: r.max_memory_bytes,
                created_at: r.created_at,
            }
        })
        .collect();
    Ok(Json(Paginated::new(items, page, total)))
}

#[derive(Debug, FromRow)]
struct SummaryRow {
    id: Uuid,
    problem_slug: String,
    problem_title: String,
    language: String,
    status: String,
    verdict: Option<String>,
    passed_tests: i32,
    total_tests: i32,
    max_time_ms: Option<i32>,
    max_memory_bytes: Option<i64>,
    created_at: DateTime<Utc>,
}

enum StatusFilter {
    Verdict(String),
    Lifecycle(String),
}

fn push_filters<'a>(
    qb: &mut QueryBuilder<'a, Postgres>,
    user_id: Uuid,
    problem: &'a Option<String>,
    status: &'a Option<StatusFilter>,
    language: &'a Option<String>,
) {
    qb.push(" WHERE s.user_id = ").push_bind(user_id);
    if let Some(slug) = problem {
        qb.push(" AND p.slug = ").push_bind(slug.as_str());
    }
    match status {
        Some(StatusFilter::Verdict(v)) => {
            qb.push(" AND s.verdict = ").push_bind(v.as_str());
        }
        Some(StatusFilter::Lifecycle(s)) => {
            qb.push(" AND s.status = ").push_bind(s.as_str());
        }
        None => {}
    }
    if let Some(l) = language {
        qb.push(" AND s.language = ").push_bind(l.as_str());
    }
}

// ------------------------------------------------------------ test results

/// Per-test summary. There is deliberately no `input` or `expected_output`
/// field: hidden judge data cannot be returned through a type that cannot hold
/// it.
#[derive(Debug, Serialize, FromRow)]
pub struct TestResultDto {
    pub position: i32,
    /// Whether this was a published sample. Sample *content* is already public
    /// through the problem endpoint; hidden content stays hidden.
    pub is_sample: bool,
    pub verdict: String,
    pub execution_time_ms: Option<i32>,
    pub memory_bytes: Option<i64>,
    pub points_awarded: i32,
}

#[derive(Debug, Serialize)]
pub struct TestResultsDto {
    pub submission_id: Uuid,
    pub status: String,
    pub verdict: Option<String>,
    pub passed_tests: i32,
    pub total_tests: i32,
    pub results: Vec<TestResultDto>,
}

/// GET /api/v1/submissions/{id}/test-results
pub async fn test_results(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(submission_id): Path<Uuid>,
) -> AppResult<Json<TestResultsDto>> {
    let row: Option<(Uuid, String, Option<String>, i32, i32)> = sqlx::query_as(
        "SELECT user_id, status, verdict, passed_tests, total_tests \
           FROM submissions WHERE id = $1",
    )
    .bind(submission_id)
    .fetch_optional(&state.pool)
    .await?;
    let (owner, status, verdict, passed, total) =
        row.ok_or_else(|| AppError::NotFound("submission not found".into()))?;
    if !auth.may_access(owner) {
        return Err(AppError::NotFound("submission not found".into()));
    }

    let results = sqlx::query_as::<_, TestResultDto>(
        "SELECT position, is_sample, verdict, execution_time_ms, memory_bytes, points_awarded \
           FROM submission_results WHERE submission_id = $1 ORDER BY position",
    )
    .bind(submission_id)
    .fetch_all(&state.pool)
    .await?;

    let parsed_status = JudgeStatus::parse(&status).unwrap_or(JudgeStatus::Queued);
    let parsed_verdict = verdict.as_deref().and_then(Verdict::parse);
    Ok(Json(TestResultsDto {
        submission_id,
        status: public_status(parsed_status, parsed_verdict),
        verdict: parsed_verdict.map(|v| v.as_str().to_string()),
        passed_tests: passed,
        total_tests: total,
        results,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_result_dto_cannot_carry_hidden_data() {
        // If someone adds an `input` field to the DTO, this fails.
        let dto = TestResultDto {
            position: 1,
            is_sample: false,
            verdict: "WRONG_ANSWER".into(),
            execution_time_ms: Some(12),
            memory_bytes: Some(1024),
            points_awarded: 0,
        };
        let json = serde_json::to_value(&dto).unwrap();
        let keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        for forbidden in ["input", "expected_output", "expected", "stdout", "stderr"] {
            assert!(
                !keys.iter().any(|k| k.as_str() == forbidden),
                "test result DTO must not expose {forbidden}"
            );
        }
    }

    #[test]
    fn private_fields_are_omitted_for_other_users() {
        let row = SubmissionRow {
            id: Uuid::nil(),
            user_id: Uuid::nil(),
            username: "ada".into(),
            problem_slug: "a-plus-b".into(),
            problem_title: "A Plus B".into(),
            language: "cpp17".into(),
            source_code: "SECRET SOURCE".into(),
            status: "FINISHED".into(),
            verdict: Some("ACCEPTED".into()),
            compile_output: "warning: unused".into(),
            failed_case_position: None,
            passed_tests: 5,
            total_tests: 5,
            score: 5,
            max_score: 5,
            max_time_ms: Some(10),
            max_memory_bytes: Some(2048),
            created_at: Utc::now(),
            finished_at: Some(Utc::now()),
        };
        let public = serde_json::to_string(&to_dto(row, false)).unwrap();
        assert!(!public.contains("SECRET SOURCE"));
        assert!(!public.contains("source_code"));
        assert!(!public.contains("compile_output"));
        assert!(public.contains("ACCEPTED"));
    }

    #[test]
    fn verdict_messages_are_generic_for_internal_errors() {
        assert!(verdict_message(Verdict::Accepted).is_none());
        let m = verdict_message(Verdict::InternalError).unwrap();
        assert!(!m.to_lowercase().contains("panic"));
        assert!(!m.to_lowercase().contains("sql"));
        for v in Verdict::ALL.iter().filter(|v| !v.is_accepted()) {
            assert!(verdict_message(*v).is_some(), "{v} needs a message");
        }
    }
}

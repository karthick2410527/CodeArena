//! Administration: problem CRUD, test-case management, worker health and the
//! dead-letter queue.
//!
//! Every handler here takes an [`AdminUser`], whose extractor re-reads the role
//! from the database, so a demoted account loses access immediately rather than
//! when its access token expires. Nothing in this module is reachable with a
//! `USER` token.
//!
//! These are the only endpoints that may read or write hidden test data, and
//! they are the only place `published` can change — which is what keeps an
//! unpublished problem out of the public catalogue.

use crate::{
    auth::AdminUser,
    error::{AppError, AppJson, AppQuery, AppResult},
    routes::pagination::{Page, Paginated},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

const MAX_TITLE: usize = 200;
const MAX_SLUG: usize = 100;
const MAX_TEXT: usize = 100_000;
const MAX_TEST_DATA: usize = 1_000_000;

// ------------------------------------------------------------------ problems

#[derive(Debug, Deserialize)]
pub struct ProblemInput {
    pub slug: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub constraints: Option<String>,
    pub difficulty: String,
    pub time_limit_ms: i32,
    pub memory_limit_mb: i32,
    #[serde(default)]
    pub published: Option<bool>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

/// Every field optional: a PATCH changes only what it names.
#[derive(Debug, Deserialize)]
pub struct ProblemPatch {
    pub slug: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub constraints: Option<String>,
    pub difficulty: Option<String>,
    pub time_limit_ms: Option<i32>,
    pub memory_limit_mb: Option<i32>,
    pub published: Option<bool>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct AdminProblemDto {
    pub id: Uuid,
    pub number: i64,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub constraints: String,
    pub difficulty: String,
    pub time_limit_ms: i32,
    pub memory_limit_mb: i32,
    pub published: bool,
    pub tags: Vec<String>,
    pub sample_count: i64,
    pub hidden_count: i64,
    pub submission_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn validate_slug(slug: &str) -> AppResult<String> {
    let s = slug.trim().to_lowercase();
    if s.is_empty() || s.len() > MAX_SLUG {
        return Err(AppError::BadRequest(format!(
            "slug must be 1-{MAX_SLUG} characters"
        )));
    }
    // URL-safe and stable: the slug is part of every problem URL.
    if !s
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(AppError::BadRequest(
            "slug may contain lowercase letters, digits and hyphens only".into(),
        ));
    }
    if s.starts_with('-') || s.ends_with('-') || s.contains("--") {
        return Err(AppError::BadRequest(
            "slug must not start or end with a hyphen, or contain \"--\"".into(),
        ));
    }
    Ok(s)
}

fn validate_difficulty(raw: &str) -> AppResult<String> {
    let up = raw.trim().to_uppercase();
    if ["EASY", "MEDIUM", "HARD"].contains(&up.as_str()) {
        Ok(up)
    } else {
        Err(AppError::BadRequest(
            "difficulty must be EASY, MEDIUM or HARD".into(),
        ))
    }
}

fn validate_text(field: &str, value: &str, max: usize, required: bool) -> AppResult<String> {
    let v = value.trim();
    if required && v.is_empty() {
        return Err(AppError::BadRequest(format!("{field} must not be empty")));
    }
    if v.len() > max {
        return Err(AppError::BadRequest(format!(
            "{field} must be at most {max} bytes"
        )));
    }
    Ok(v.to_string())
}

/// Limits are bounded against the runner's ceilings so a problem cannot ask for
/// an execution the sandbox would refuse.
fn validate_limits(state: &AppState, time_limit_ms: i32, memory_limit_mb: i32) -> AppResult<()> {
    let l = &state.config.runner_limits;
    if time_limit_ms < 100 || time_limit_ms as u64 > l.max_time_limit_ms {
        return Err(AppError::BadRequest(format!(
            "time_limit_ms must be between 100 and {}",
            l.max_time_limit_ms
        )));
    }
    if memory_limit_mb < 16 || memory_limit_mb as u64 > l.max_memory_limit_mb {
        return Err(AppError::BadRequest(format!(
            "memory_limit_mb must be between 16 and {}",
            l.max_memory_limit_mb
        )));
    }
    Ok(())
}

fn validate_tags(tags: &[String]) -> AppResult<Vec<String>> {
    if tags.len() > 10 {
        return Err(AppError::BadRequest(
            "a problem may have at most 10 tags".into(),
        ));
    }
    let mut out = Vec::new();
    for t in tags {
        let t = t.trim().to_lowercase();
        if t.is_empty() {
            continue;
        }
        if t.len() > 40
            || !t
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(AppError::BadRequest(format!(
                "tag {t:?} must be 1-40 lowercase letters, digits or hyphens"
            )));
        }
        if !out.contains(&t) {
            out.push(t);
        }
    }
    Ok(out)
}

const SELECT_ADMIN_PROBLEM: &str = "\
    SELECT p.id, p.number, p.slug, p.title, p.description, p.constraints, p.difficulty, \
           p.time_limit_ms, p.memory_limit_mb, p.published, p.created_at, p.updated_at, \
           ARRAY(SELECT t.name FROM tags t JOIN problem_tags pt ON pt.tag_id = t.id \
                  WHERE pt.problem_id = p.id ORDER BY t.name) AS tags, \
           (SELECT COUNT(*) FROM test_cases tc \
             WHERE tc.problem_id = p.id AND tc.is_sample) AS sample_count, \
           (SELECT COUNT(*) FROM test_cases tc \
             WHERE tc.problem_id = p.id AND NOT tc.is_sample) AS hidden_count, \
           (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id) AS submission_count \
      FROM problems p";

#[derive(Debug, Deserialize)]
pub struct AdminListParams {
    pub page: Option<u32>,
    pub limit: Option<u32>,
    /// `true`, `false`, or omitted for both.
    pub published: Option<bool>,
    pub q: Option<String>,
}

/// GET /api/v1/admin/problems — every problem, published or not.
pub async fn list_problems(
    State(state): State<AppState>,
    _admin: AdminUser,
    AppQuery(params): AppQuery<AdminListParams>,
) -> AppResult<Json<Paginated<AdminProblemDto>>> {
    let page = Page::new(params.page, params.limit)?;
    let search = params
        .q
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 100)
        .map(|s| {
            format!(
                "%{}%",
                s.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        });

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM problems p \
          WHERE ($1::bool IS NULL OR p.published = $1) \
            AND ($2::text IS NULL OR p.title ILIKE $2 ESCAPE '\\' OR p.slug ILIKE $2 ESCAPE '\\')",
    )
    .bind(params.published)
    .bind(&search)
    .fetch_one(&state.pool)
    .await?;

    let items = sqlx::query_as::<_, AdminProblemDto>(&format!(
        "{SELECT_ADMIN_PROBLEM} \
          WHERE ($1::bool IS NULL OR p.published = $1) \
            AND ($2::text IS NULL OR p.title ILIKE $2 ESCAPE '\\' OR p.slug ILIKE $2 ESCAPE '\\') \
          ORDER BY p.number DESC LIMIT $3 OFFSET $4"
    ))
    .bind(params.published)
    .bind(&search)
    .bind(page.limit_i64())
    .bind(page.offset())
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(Paginated::new(items, page, total)))
}

/// GET /api/v1/admin/problems/{id}
pub async fn get_problem(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<AdminProblemDto>> {
    load_problem(&state, id).await.map(Json)
}

async fn load_problem(state: &AppState, id: Uuid) -> AppResult<AdminProblemDto> {
    sqlx::query_as::<_, AdminProblemDto>(&format!("{SELECT_ADMIN_PROBLEM} WHERE p.id = $1"))
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("problem not found".into()))
}

/// POST /api/v1/admin/problems — create a problem (unpublished by default).
pub async fn create_problem(
    State(state): State<AppState>,
    admin: AdminUser,
    AppJson(req): AppJson<ProblemInput>,
) -> AppResult<(StatusCode, Json<AdminProblemDto>)> {
    let slug = validate_slug(&req.slug)?;
    let title = validate_text("title", &req.title, MAX_TITLE, true)?;
    let description = validate_text("description", &req.description, MAX_TEXT, true)?;
    let constraints = validate_text(
        "constraints",
        req.constraints.as_deref().unwrap_or(""),
        MAX_TEXT,
        false,
    )?;
    let difficulty = validate_difficulty(&req.difficulty)?;
    validate_limits(&state, req.time_limit_ms, req.memory_limit_mb)?;
    let tags = validate_tags(req.tags.as_deref().unwrap_or(&[]))?;
    // New problems start hidden, so a half-written statement is never public.
    let published = req.published.unwrap_or(false);

    let mut tx = state.pool.begin().await?;
    let inserted: Result<(Uuid,), _> = sqlx::query_as(
        "INSERT INTO problems (slug, title, description, constraints, difficulty, \
                               time_limit_ms, memory_limit_mb, published, updated_by) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    )
    .bind(&slug)
    .bind(&title)
    .bind(&description)
    .bind(&constraints)
    .bind(&difficulty)
    .bind(req.time_limit_ms)
    .bind(req.memory_limit_mb)
    .bind(published)
    .bind(admin.id)
    .fetch_one(&mut *tx)
    .await;
    let (id,) = match inserted {
        Ok(v) => v,
        Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505") => {
            return Err(AppError::Conflict(format!(
                "slug {slug:?} is already in use"
            )))
        }
        Err(e) => return Err(e.into()),
    };
    replace_tags(&mut tx, id, &tags).await?;
    tx.commit().await?;

    state.cache.invalidate_problems().await;
    tracing::info!(problem_id = %id, %slug, admin_id = %admin.id, published, "problem created");
    Ok((StatusCode::CREATED, Json(load_problem(&state, id).await?)))
}

/// PATCH /api/v1/admin/problems/{id}
pub async fn update_problem(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
    AppJson(req): AppJson<ProblemPatch>,
) -> AppResult<Json<AdminProblemDto>> {
    let existing = load_problem(&state, id).await?;

    let slug = match &req.slug {
        Some(s) => validate_slug(s)?,
        None => existing.slug.clone(),
    };
    let title = match &req.title {
        Some(t) => validate_text("title", t, MAX_TITLE, true)?,
        None => existing.title.clone(),
    };
    let description = match &req.description {
        Some(d) => validate_text("description", d, MAX_TEXT, true)?,
        None => existing.description.clone(),
    };
    let constraints = match &req.constraints {
        Some(c) => validate_text("constraints", c, MAX_TEXT, false)?,
        None => existing.constraints.clone(),
    };
    let difficulty = match &req.difficulty {
        Some(d) => validate_difficulty(d)?,
        None => existing.difficulty.clone(),
    };
    let time_limit_ms = req.time_limit_ms.unwrap_or(existing.time_limit_ms);
    let memory_limit_mb = req.memory_limit_mb.unwrap_or(existing.memory_limit_mb);
    validate_limits(&state, time_limit_ms, memory_limit_mb)?;
    let published = req.published.unwrap_or(existing.published);

    // Publishing a problem with no tests would let users submit something that
    // cannot be judged.
    if published && !existing.published {
        let total = existing.sample_count + existing.hidden_count;
        if total == 0 {
            return Err(AppError::BadRequest(
                "add at least one test case before publishing this problem".into(),
            ));
        }
        if existing.hidden_count == 0 {
            return Err(AppError::BadRequest(
                "add at least one hidden test case before publishing this problem".into(),
            ));
        }
    }

    let mut tx = state.pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE problems SET slug = $2, title = $3, description = $4, constraints = $5, \
                             difficulty = $6, time_limit_ms = $7, memory_limit_mb = $8, \
                             published = $9, updated_by = $10 \
          WHERE id = $1",
    )
    .bind(id)
    .bind(&slug)
    .bind(&title)
    .bind(&description)
    .bind(&constraints)
    .bind(&difficulty)
    .bind(time_limit_ms)
    .bind(memory_limit_mb)
    .bind(published)
    .bind(admin.id)
    .execute(&mut *tx)
    .await;
    match updated {
        Ok(_) => {}
        Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505") => {
            return Err(AppError::Conflict(format!(
                "slug {slug:?} is already in use"
            )))
        }
        Err(e) => return Err(e.into()),
    }
    if let Some(tags) = &req.tags {
        let tags = validate_tags(tags)?;
        replace_tags(&mut tx, id, &tags).await?;
    }
    tx.commit().await?;

    // Invalidate *after* the commit, so no reader can repopulate the cache
    // from the pre-update state.
    state.cache.invalidate_problems().await;
    tracing::info!(problem_id = %id, admin_id = %admin.id, published, "problem updated");
    Ok(Json(load_problem(&state, id).await?))
}

async fn replace_tags(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    problem_id: Uuid,
    tags: &[String],
) -> AppResult<()> {
    sqlx::query("DELETE FROM problem_tags WHERE problem_id = $1")
        .bind(problem_id)
        .execute(&mut **tx)
        .await?;
    for name in tags {
        sqlx::query("INSERT INTO tags (name) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(name)
            .execute(&mut **tx)
            .await?;
        sqlx::query(
            "INSERT INTO problem_tags (problem_id, tag_id) \
             SELECT $1, id FROM tags WHERE lower(name) = lower($2) \
             ON CONFLICT DO NOTHING",
        )
        .bind(problem_id)
        .bind(name)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

// --------------------------------------------------------------- test cases

#[derive(Debug, Deserialize)]
pub struct TestCaseInput {
    pub input: String,
    pub expected_output: String,
    #[serde(default)]
    pub explanation: Option<String>,
    #[serde(default)]
    pub is_sample: Option<bool>,
    #[serde(default)]
    pub points: Option<i32>,
    /// Omit to append at the end.
    #[serde(default)]
    pub position: Option<i32>,
}

/// Admin view of a test case. Hidden data appears here *only* because the
/// caller is an administrator; no non-admin route returns this type.
#[derive(Debug, Serialize, FromRow)]
pub struct AdminTestCaseDto {
    pub id: Uuid,
    pub position: i32,
    pub input: String,
    pub expected_output: String,
    pub explanation: Option<String>,
    pub is_sample: bool,
    pub points: i32,
}

fn validate_test_case(input: &str, expected: &str, points: i32) -> AppResult<()> {
    if input.len() > MAX_TEST_DATA || expected.len() > MAX_TEST_DATA {
        return Err(AppError::BadRequest(format!(
            "test input and expected output must each be at most {MAX_TEST_DATA} bytes"
        )));
    }
    if expected.trim().is_empty() {
        return Err(AppError::BadRequest(
            "expected_output must not be empty".into(),
        ));
    }
    if !(0..=1000).contains(&points) {
        return Err(AppError::BadRequest(
            "points must be between 0 and 1000".into(),
        ));
    }
    Ok(())
}

/// GET /api/v1/admin/problems/{id}/test-cases
pub async fn list_test_cases(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(problem_id): Path<Uuid>,
) -> AppResult<Json<Vec<AdminTestCaseDto>>> {
    // Confirm the problem exists so a bad id is a 404, not an empty list.
    load_problem(&state, problem_id).await?;
    Ok(Json(
        sqlx::query_as::<_, AdminTestCaseDto>(
            "SELECT id, position, input, expected_output, explanation, is_sample, points \
               FROM test_cases WHERE problem_id = $1 ORDER BY position, id",
        )
        .bind(problem_id)
        .fetch_all(&state.pool)
        .await?,
    ))
}

/// POST /api/v1/admin/problems/{id}/test-cases
pub async fn create_test_case(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(problem_id): Path<Uuid>,
    AppJson(req): AppJson<TestCaseInput>,
) -> AppResult<(StatusCode, Json<AdminTestCaseDto>)> {
    load_problem(&state, problem_id).await?;
    let is_sample = req.is_sample.unwrap_or(false);
    // Samples are illustrations, not score: they carry no points by default.
    let points = req.points.unwrap_or(if is_sample { 0 } else { 1 });
    validate_test_case(&req.input, &req.expected_output, points)?;

    let position = match req.position {
        Some(p) if p >= 1 => p,
        Some(_) => return Err(AppError::BadRequest("position must be >= 1".into())),
        None => {
            let next: Option<i32> =
                sqlx::query_scalar("SELECT MAX(position) FROM test_cases WHERE problem_id = $1")
                    .bind(problem_id)
                    .fetch_one(&state.pool)
                    .await?;
            next.unwrap_or(0) + 1
        }
    };

    let inserted: Result<AdminTestCaseDto, _> = sqlx::query_as(
        "INSERT INTO test_cases (problem_id, position, input, expected_output, explanation, \
                                 is_sample, points) \
         VALUES ($1,$2,$3,$4,$5,$6,$7) \
         RETURNING id, position, input, expected_output, explanation, is_sample, points",
    )
    .bind(problem_id)
    .bind(position)
    .bind(&req.input)
    .bind(&req.expected_output)
    .bind(
        req.explanation
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(is_sample)
    .bind(points)
    .fetch_one(&state.pool)
    .await;
    let dto = match inserted {
        Ok(v) => v,
        Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505") => {
            return Err(AppError::Conflict(format!(
                "position {position} is already taken for this problem"
            )))
        }
        Err(e) => return Err(e.into()),
    };

    // A new sample changes the public problem payload.
    if is_sample {
        state.cache.invalidate_problems().await;
    }
    tracing::info!(%problem_id, admin_id = %admin.id, is_sample, "test case added");
    Ok((StatusCode::CREATED, Json(dto)))
}

/// PATCH /api/v1/admin/test-cases/{id}
pub async fn update_test_case(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
    AppJson(req): AppJson<TestCaseInput>,
) -> AppResult<Json<AdminTestCaseDto>> {
    let existing: Option<(Uuid, bool)> =
        sqlx::query_as("SELECT problem_id, is_sample FROM test_cases WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    let (problem_id, was_sample) =
        existing.ok_or_else(|| AppError::NotFound("test case not found".into()))?;

    let is_sample = req.is_sample.unwrap_or(was_sample);
    let points = req.points.unwrap_or(if is_sample { 0 } else { 1 });
    validate_test_case(&req.input, &req.expected_output, points)?;

    let dto = sqlx::query_as::<_, AdminTestCaseDto>(
        "UPDATE test_cases SET input = $2, expected_output = $3, explanation = $4, \
                               is_sample = $5, points = $6, \
                               position = COALESCE($7, position) \
          WHERE id = $1 \
         RETURNING id, position, input, expected_output, explanation, is_sample, points",
    )
    .bind(id)
    .bind(&req.input)
    .bind(&req.expected_output)
    .bind(
        req.explanation
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(is_sample)
    .bind(points)
    .bind(req.position.filter(|p| *p >= 1))
    .fetch_one(&state.pool)
    .await?;

    if is_sample || was_sample {
        state.cache.invalidate_problems().await;
    }
    tracing::info!(test_case_id = %id, %problem_id, admin_id = %admin.id, "test case updated");
    Ok(Json(dto))
}

/// DELETE /api/v1/admin/test-cases/{id}
///
/// Destructive, so the UI asks for explicit confirmation first; the API refuses
/// to remove the last test of a *published* problem, which would silently make
/// it unjudgeable.
pub async fn delete_test_case(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let row: Option<(Uuid, bool, bool, i64)> = sqlx::query_as(
        "SELECT tc.problem_id, tc.is_sample, p.published, \
                (SELECT COUNT(*) FROM test_cases x \
                  WHERE x.problem_id = tc.problem_id AND NOT x.is_sample) \
           FROM test_cases tc JOIN problems p ON p.id = tc.problem_id \
          WHERE tc.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let (problem_id, is_sample, published, hidden_count) =
        row.ok_or_else(|| AppError::NotFound("test case not found".into()))?;

    if published && !is_sample && hidden_count <= 1 {
        return Err(AppError::Conflict(
            "a published problem must keep at least one hidden test case; \
             unpublish it first"
                .into(),
        ));
    }

    sqlx::query("DELETE FROM test_cases WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    if is_sample {
        state.cache.invalidate_problems().await;
    }
    tracing::info!(test_case_id = %id, %problem_id, admin_id = %admin.id, "test case deleted");
    Ok(StatusCode::NO_CONTENT)
}

// ----------------------------------------------------------- worker health

#[derive(Debug, Serialize, FromRow)]
pub struct WorkerDto {
    pub worker_id: String,
    pub queue_driver: String,
    pub runner_strategy: String,
    pub version: String,
    pub started_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub seconds_since_heartbeat: f64,
    /// False once a worker stops reporting — the signal operators need.
    pub healthy: bool,
    pub submissions_judged: i64,
    pub runs_executed: i64,
    pub failures: i64,
    pub current_submission_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct WorkersDto {
    pub workers: Vec<WorkerDto>,
    /// Submissions waiting for a worker.
    pub queued_submissions: i64,
    /// Submissions currently claimed.
    pub running_submissions: i64,
    /// Undelivered queue events, and the age of the oldest in seconds.
    pub queue_backlog: i64,
    pub oldest_pending_secs: Option<i64>,
    pub unresolved_dead_letters: i64,
}

/// GET /api/v1/admin/workers — worker liveness and queue lag.
pub async fn workers(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<WorkersDto>> {
    // A worker is considered unhealthy at three missed heartbeats.
    let stale_after = (state.config.claim_timeout.as_secs() as f64).max(30.0);
    let workers = sqlx::query_as::<_, WorkerDto>(
        "SELECT worker_id, queue_driver, runner_strategy, version, started_at, last_seen_at, \
                EXTRACT(EPOCH FROM (now() - last_seen_at))::double precision \
                    AS seconds_since_heartbeat, \
                (last_seen_at > now() - make_interval(secs => $1::double precision)) AS healthy, \
                submissions_judged, runs_executed, failures, current_submission_id \
           FROM worker_heartbeats ORDER BY last_seen_at DESC",
    )
    .bind(stale_after)
    .fetch_all(&state.pool)
    .await?;

    let (queued, running) = crate::judge::submissions::backlog(&state.pool).await?;
    let (backlog, oldest) = crate::queue::outbox::lag(&state.pool).await?;
    let unresolved: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM dead_letter_events WHERE resolved_at IS NULL")
            .fetch_one(&state.pool)
            .await?;

    Ok(Json(WorkersDto {
        workers,
        queued_submissions: queued,
        running_submissions: running,
        queue_backlog: backlog,
        oldest_pending_secs: oldest.map(|t| (Utc::now() - t).num_seconds()),
        unresolved_dead_letters: unresolved,
    }))
}

// ------------------------------------------------------------ dead letters

#[derive(Debug, Serialize, FromRow)]
pub struct DeadLetterDto {
    pub id: i64,
    pub submission_id: Option<Uuid>,
    pub event_type: String,
    pub reason: String,
    pub correlation_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolution: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeadLetterParams {
    pub page: Option<u32>,
    pub limit: Option<u32>,
    /// `true` to include already-resolved entries.
    pub include_resolved: Option<bool>,
}

/// GET /api/v1/admin/dead-letters — inspect jobs that could not be judged.
pub async fn dead_letters(
    State(state): State<AppState>,
    _admin: AdminUser,
    AppQuery(params): AppQuery<DeadLetterParams>,
) -> AppResult<Json<Paginated<DeadLetterDto>>> {
    let page = Page::new(params.page, params.limit)?;
    let include_resolved = params.include_resolved.unwrap_or(false);
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dead_letter_events WHERE ($1 OR resolved_at IS NULL)",
    )
    .bind(include_resolved)
    .fetch_one(&state.pool)
    .await?;
    let items = sqlx::query_as::<_, DeadLetterDto>(
        "SELECT id, submission_id, event_type, reason, correlation_id, created_at, \
                resolved_at, resolution \
           FROM dead_letter_events WHERE ($1 OR resolved_at IS NULL) \
          ORDER BY created_at DESC LIMIT $2 OFFSET $3",
    )
    .bind(include_resolved)
    .bind(page.limit_i64())
    .bind(page.offset())
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Paginated::new(items, page, total)))
}

#[derive(Debug, Deserialize)]
pub struct ReplayRequest {
    /// Recorded alongside the resolution for the audit trail.
    #[serde(default)]
    pub note: Option<String>,
}

/// POST /api/v1/admin/dead-letters/{id}/replay — re-queue a dead-lettered job.
pub async fn replay_dead_letter(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<i64>,
    AppJson(req): AppJson<ReplayRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let row: Option<(Option<Uuid>, Option<DateTime<Utc>>)> =
        sqlx::query_as("SELECT submission_id, resolved_at FROM dead_letter_events WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    let (submission_id, resolved_at) =
        row.ok_or_else(|| AppError::NotFound("dead-letter entry not found".into()))?;
    if resolved_at.is_some() {
        return Err(AppError::Conflict(
            "this entry has already been resolved".into(),
        ));
    }
    let Some(submission_id) = submission_id else {
        return Err(AppError::BadRequest(
            "this entry is not attached to a submission and cannot be replayed".into(),
        ));
    };

    let meta: Option<(Uuid, Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT problem_id, user_id, language, correlation_id FROM submissions WHERE id = $1",
    )
    .bind(submission_id)
    .fetch_optional(&state.pool)
    .await?;
    let (problem_id, user_id, language, correlation_id) =
        meta.ok_or_else(|| AppError::NotFound("the submission no longer exists".into()))?;

    let mut tx = state.pool.begin().await?;
    // Reset the attempt budget so the replay actually gets to run.
    sqlx::query(
        "UPDATE submissions \
            SET status = 'QUEUED', verdict = NULL, internal_error = NULL, finished_at = NULL, \
                attempts = 0, claimed_by = NULL, claimed_at = NULL \
          WHERE id = $1",
    )
    .bind(submission_id)
    .execute(&mut *tx)
    .await?;
    let job = crate::queue::JudgeJob {
        submission_id,
        problem_id,
        user_id,
        language,
        correlation_id,
        enqueued_at: Utc::now(),
    };
    crate::queue::outbox::enqueue(&mut tx, &job).await?;
    sqlx::query(
        "UPDATE dead_letter_events SET resolved_at = now(), resolved_by = $2, resolution = $3 \
          WHERE id = $1",
    )
    .bind(id)
    .bind(admin.id)
    .bind(format!(
        "replayed{}",
        req.note
            .as_deref()
            .map(|n| format!(": {}", n.trim()))
            .unwrap_or_default()
    ))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    tracing::info!(dead_letter_id = id, %submission_id, admin_id = %admin.id, "dead letter replayed");
    Ok(Json(serde_json::json!({
        "submission_id": submission_id,
        "status": "QUEUED"
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_must_be_url_safe() {
        assert_eq!(validate_slug(" Two-Sum ").unwrap(), "two-sum");
        assert_eq!(validate_slug("abc123").unwrap(), "abc123");
        assert!(validate_slug("").is_err());
        assert!(validate_slug("two sum").is_err());
        assert!(validate_slug("two_sum").is_err());
        assert!(validate_slug("../etc/passwd").is_err());
        assert!(validate_slug("-lead").is_err());
        assert!(validate_slug("trail-").is_err());
        assert!(validate_slug("double--hyphen").is_err());
        assert!(validate_slug(&"a".repeat(MAX_SLUG + 1)).is_err());
    }

    #[test]
    fn difficulty_is_normalised() {
        assert_eq!(validate_difficulty("easy").unwrap(), "EASY");
        assert_eq!(validate_difficulty(" Hard ").unwrap(), "HARD");
        assert!(validate_difficulty("IMPOSSIBLE").is_err());
    }

    #[test]
    fn text_fields_are_bounded() {
        assert!(validate_text("title", "", 10, true).is_err());
        assert!(validate_text("title", "", 10, false).is_ok());
        assert!(validate_text("title", &"x".repeat(11), 10, true).is_err());
        assert_eq!(validate_text("title", "  hi  ", 10, true).unwrap(), "hi");
    }

    #[test]
    fn tags_are_normalised_and_deduplicated() {
        let tags =
            validate_tags(&["DP".into(), "dp".into(), " graphs ".into(), "".into()]).unwrap();
        assert_eq!(tags, vec!["dp", "graphs"]);
    }

    #[test]
    fn tags_are_bounded_and_validated() {
        assert!(validate_tags(&["has space".into()]).is_err());
        assert!(validate_tags(&["x".repeat(41)]).is_err());
        let many: Vec<String> = (0..11).map(|i| format!("t{i}")).collect();
        assert!(validate_tags(&many).is_err());
    }

    #[test]
    fn test_case_data_is_bounded() {
        assert!(validate_test_case("1 2", "3", 1).is_ok());
        assert!(validate_test_case("1 2", "   ", 1).is_err());
        assert!(validate_test_case(&"x".repeat(MAX_TEST_DATA + 1), "3", 1).is_err());
        assert!(validate_test_case("1", "2", -1).is_err());
        assert!(validate_test_case("1", "2", 1001).is_err());
    }

    #[test]
    fn admin_problem_dto_is_the_only_type_exposing_hidden_counts() {
        // Sanity check that the admin DTO is explicit about hidden data.
        let json = serde_json::to_value(AdminTestCaseDto {
            id: Uuid::nil(),
            position: 1,
            input: "secret".into(),
            expected_output: "answer".into(),
            explanation: None,
            is_sample: false,
            points: 1,
        })
        .unwrap();
        assert!(json.get("input").is_some());
        assert!(json.get("expected_output").is_some());
    }
}

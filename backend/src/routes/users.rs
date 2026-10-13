use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
    state::AppState,
};
use axum::{extract::State, Json};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::FromRow;
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub password_hash: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
}

/// Public view of a user. Deliberately has no password hash field.
#[derive(Debug, Serialize)]
pub struct UserDto {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
}

impl From<UserRow> for UserDto {
    fn from(u: UserRow) -> Self {
        Self {
            id: u.id,
            username: u.username,
            email: u.email,
            role: u.role,
            created_at: u.created_at,
        }
    }
}

pub async fn find_user_by_id(pool: &sqlx::PgPool, id: Uuid) -> AppResult<Option<UserRow>> {
    Ok(sqlx::query_as::<_, UserRow>(
        "SELECT id, username, email, password_hash, role, created_at FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?)
}

/// GET /api/v1/users/me (protected)
pub async fn me(State(state): State<AppState>, auth: AuthUser) -> AppResult<Json<UserDto>> {
    let user = find_user_by_id(&state.pool, auth.id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("account no longer exists".into()))?;
    Ok(Json(user.into()))
}

/// Solved-problem statistics, computed from persisted accepted submissions.
#[derive(Debug, Serialize)]
pub struct UserStats {
    pub total_submissions: i64,
    pub accepted_submissions: i64,
    /// Distinct problems with at least one accepted submission.
    pub problems_solved: i64,
    /// Published problems in the catalogue, for a "x of y" display.
    pub problems_available: i64,
    pub solved_easy: i64,
    pub solved_medium: i64,
    pub solved_hard: i64,
    pub available_easy: i64,
    pub available_medium: i64,
    pub available_hard: i64,
    /// Accepted ÷ total, as a percentage rounded to one decimal. 0 with no
    /// submissions (rather than a division by zero).
    pub acceptance_rate: f64,
    pub last_submission_at: Option<DateTime<Utc>>,
    /// Verdict histogram, e.g. `{"ACCEPTED": 12, "WRONG_ANSWER": 5}`.
    pub verdict_counts: BTreeMap<String, i64>,
}

#[derive(Debug, FromRow)]
struct StatsRow {
    total_submissions: i64,
    accepted_submissions: i64,
    problems_solved: i64,
    solved_easy: i64,
    solved_medium: i64,
    solved_hard: i64,
    last_submission_at: Option<DateTime<Utc>>,
}

/// GET /api/v1/users/me/stats (protected)
///
/// Every number comes from a database query over `submissions`; nothing is
/// cached or estimated, so the profile cannot disagree with the history page.
pub async fn stats(State(state): State<AppState>, auth: AuthUser) -> AppResult<Json<UserStats>> {
    // One pass over this user's submissions. Uses the
    // (user_id, created_at DESC) and partial accepted indexes.
    let row = sqlx::query_as::<_, StatsRow>(
        "SELECT COUNT(*) AS total_submissions, \
                COUNT(*) FILTER (WHERE s.verdict = 'ACCEPTED') AS accepted_submissions, \
                COUNT(DISTINCT s.problem_id) FILTER (WHERE s.verdict = 'ACCEPTED') \
                    AS problems_solved, \
                COUNT(DISTINCT s.problem_id) \
                    FILTER (WHERE s.verdict = 'ACCEPTED' AND p.difficulty = 'EASY') \
                    AS solved_easy, \
                COUNT(DISTINCT s.problem_id) \
                    FILTER (WHERE s.verdict = 'ACCEPTED' AND p.difficulty = 'MEDIUM') \
                    AS solved_medium, \
                COUNT(DISTINCT s.problem_id) \
                    FILTER (WHERE s.verdict = 'ACCEPTED' AND p.difficulty = 'HARD') \
                    AS solved_hard, \
                MAX(s.created_at) AS last_submission_at \
           FROM submissions s JOIN problems p ON p.id = s.problem_id \
          WHERE s.user_id = $1",
    )
    .bind(auth.id)
    .fetch_one(&state.pool)
    .await?;

    let catalogue = sqlx::query_as::<_, (i64, i64, i64, i64)>(
        "SELECT COUNT(*), \
                COUNT(*) FILTER (WHERE difficulty = 'EASY'), \
                COUNT(*) FILTER (WHERE difficulty = 'MEDIUM'), \
                COUNT(*) FILTER (WHERE difficulty = 'HARD') \
           FROM problems WHERE published",
    )
    .fetch_one(&state.pool)
    .await?;

    let verdicts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT verdict, COUNT(*) FROM submissions \
          WHERE user_id = $1 AND verdict IS NOT NULL GROUP BY verdict",
    )
    .bind(auth.id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(UserStats {
        total_submissions: row.total_submissions,
        accepted_submissions: row.accepted_submissions,
        problems_solved: row.problems_solved,
        problems_available: catalogue.0,
        solved_easy: row.solved_easy,
        solved_medium: row.solved_medium,
        solved_hard: row.solved_hard,
        available_easy: catalogue.1,
        available_medium: catalogue.2,
        available_hard: catalogue.3,
        acceptance_rate: acceptance_rate(row.accepted_submissions, row.total_submissions),
        last_submission_at: row.last_submission_at,
        verdict_counts: verdicts.into_iter().collect(),
    }))
}

/// Accepted ÷ total as a percentage, rounded to one decimal. Zero submissions
/// gives 0.0 rather than NaN.
fn acceptance_rate(accepted: i64, total: i64) -> f64 {
    if total <= 0 {
        return 0.0;
    }
    ((accepted as f64 / total as f64) * 1000.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acceptance_rate_handles_no_submissions() {
        assert_eq!(acceptance_rate(0, 0), 0.0);
        assert_eq!(acceptance_rate(5, 0), 0.0);
    }

    #[test]
    fn acceptance_rate_is_a_rounded_percentage() {
        assert_eq!(acceptance_rate(1, 2), 50.0);
        assert_eq!(acceptance_rate(1, 3), 33.3);
        assert_eq!(acceptance_rate(2, 3), 66.7);
        assert_eq!(acceptance_rate(7, 7), 100.0);
        assert_eq!(acceptance_rate(0, 9), 0.0);
    }

    #[test]
    fn user_dto_never_carries_the_password_hash() {
        let dto = UserDto {
            id: Uuid::nil(),
            username: "ada".into(),
            email: "ada@example.com".into(),
            role: "USER".into(),
            created_at: Utc::now(),
        };
        let json = serde_json::to_value(&dto).unwrap();
        assert!(json.get("password_hash").is_none());
        assert_eq!(json.as_object().unwrap().len(), 5);
    }
}

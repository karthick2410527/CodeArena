use crate::{
    cache,
    error::{AppError, AppQuery, AppResult},
    routes::pagination::MAX_LIMIT,
    state::AppState,
};
use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, QueryBuilder};
use uuid::Uuid;

const DEFAULT_LIMIT: u32 = 20;
const MAX_SEARCH_LEN: usize = 100;

#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub page: Option<u32>,
    pub limit: Option<u32>,
    pub difficulty: Option<String>,
    pub tag: Option<String>,
    /// Free-text search over the problem title.
    pub q: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct ProblemSummary {
    pub number: i64,
    pub slug: String,
    pub title: String,
    pub difficulty: String,
    pub time_limit_ms: i32,
    pub memory_limit_mb: i32,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProblemList {
    pub items: Vec<ProblemSummary>,
    pub page: u32,
    pub limit: u32,
    pub total: i64,
    pub total_pages: u32,
}

/// A public example. Hidden judge data is never loaded into this type.
#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct Sample {
    pub input: String,
    pub expected_output: String,
    pub explanation: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProblemDetail {
    pub number: i64,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub constraints: String,
    pub difficulty: String,
    pub time_limit_ms: i32,
    pub memory_limit_mb: i32,
    pub tags: Vec<String>,
    pub samples: Vec<Sample>,
}

#[derive(Debug, FromRow)]
struct ProblemRow {
    id: Uuid,
    number: i64,
    slug: String,
    title: String,
    description: String,
    constraints: String,
    difficulty: String,
    time_limit_ms: i32,
    memory_limit_mb: i32,
    tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct TagCount {
    pub name: String,
    pub count: i64,
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Appends the WHERE clause shared by the count and page queries.
fn push_filters<'a>(
    qb: &mut QueryBuilder<'a, Postgres>,
    difficulty: &'a Option<String>,
    tag: &'a Option<String>,
    search: &'a Option<String>,
) {
    qb.push(" WHERE p.published = TRUE");
    if let Some(d) = difficulty {
        qb.push(" AND p.difficulty = ").push_bind(d.as_str());
    }
    if let Some(t) = tag {
        qb.push(
            " AND EXISTS (SELECT 1 FROM problem_tags pt JOIN tags t ON t.id = pt.tag_id \
             WHERE pt.problem_id = p.id AND lower(t.name) = lower(",
        )
        .push_bind(t.as_str())
        .push("))");
    }
    if let Some(s) = search {
        qb.push(" AND p.title ILIKE ")
            .push_bind(format!("%{}%", escape_like(s)))
            .push(" ESCAPE '\\'");
    }
}

/// GET /api/v1/problems?page=&limit=&difficulty=&tag=&q=
pub async fn list(
    State(state): State<AppState>,
    AppQuery(params): AppQuery<ListParams>,
) -> AppResult<Json<ProblemList>> {
    let page = params.page.unwrap_or(1);
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT);
    if page < 1 {
        return Err(AppError::BadRequest("page must be >= 1".into()));
    }
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(AppError::BadRequest(format!(
            "limit must be between 1 and {MAX_LIMIT}"
        )));
    }
    let difficulty = match non_empty(params.difficulty) {
        None => None,
        Some(d) => {
            let up = d.to_uppercase();
            if !["EASY", "MEDIUM", "HARD"].contains(&up.as_str()) {
                return Err(AppError::BadRequest(
                    "difficulty must be EASY, MEDIUM or HARD".into(),
                ));
            }
            Some(up)
        }
    };
    let tag = non_empty(params.tag);
    let search = non_empty(params.q);
    if search
        .as_ref()
        .map(|s| s.chars().count() > MAX_SEARCH_LEN)
        .unwrap_or(false)
    {
        return Err(AppError::BadRequest("search text is too long".into()));
    }

    // Cached read. The key includes a generation counter that any admin write
    // bumps, so a published/unpublished change is reflected immediately rather
    // than after the TTL (see cache::Cache::invalidate_problems).
    let cache_key = cache::problem_list_key(
        page,
        limit,
        difficulty.as_deref(),
        tag.as_deref(),
        search.as_deref(),
    );
    if let Some(cached) = state.cache.get::<ProblemList>(&cache_key).await {
        return Ok(Json(cached));
    }

    let mut count_qb = QueryBuilder::<Postgres>::new("SELECT COUNT(*) FROM problems p");
    push_filters(&mut count_qb, &difficulty, &tag, &search);
    let total: i64 = count_qb.build_query_scalar().fetch_one(&state.pool).await?;

    let offset = (page as i64 - 1) * limit as i64;
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT p.number, p.slug, p.title, p.difficulty, p.time_limit_ms, p.memory_limit_mb, \
         ARRAY(SELECT t.name FROM tags t JOIN problem_tags pt ON pt.tag_id = t.id \
               WHERE pt.problem_id = p.id ORDER BY t.name) AS tags \
         FROM problems p",
    );
    push_filters(&mut qb, &difficulty, &tag, &search);
    qb.push(" ORDER BY p.number ASC LIMIT ")
        .push_bind(limit as i64)
        .push(" OFFSET ")
        .push_bind(offset);
    let items: Vec<ProblemSummary> = qb.build_query_as().fetch_all(&state.pool).await?;

    let total_pages = ((total + limit as i64 - 1) / limit as i64) as u32;
    let body = ProblemList {
        items,
        page,
        limit,
        total,
        total_pages,
    };
    state.cache.put(&cache_key, &body).await;
    Ok(Json(body))
}

async fn load_samples(state: &AppState, problem_id: Uuid) -> AppResult<Vec<Sample>> {
    // `is_sample = TRUE` is the only thing that ever makes test data public.
    Ok(sqlx::query_as::<_, Sample>(
        "SELECT input, expected_output, explanation FROM test_cases \
         WHERE problem_id = $1 AND is_sample = TRUE ORDER BY position, id",
    )
    .bind(problem_id)
    .fetch_all(&state.pool)
    .await?)
}

async fn find_published(state: &AppState, slug: &str) -> AppResult<ProblemRow> {
    sqlx::query_as::<_, ProblemRow>(
        "SELECT p.id, p.number, p.slug, p.title, p.description, p.constraints, p.difficulty, \
                p.time_limit_ms, p.memory_limit_mb, \
                ARRAY(SELECT t.name FROM tags t JOIN problem_tags pt ON pt.tag_id = t.id \
                      WHERE pt.problem_id = p.id ORDER BY t.name) AS tags \
         FROM problems p WHERE p.slug = $1 AND p.published = TRUE",
    )
    .bind(slug)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("problem not found".into()))
}

/// GET /api/v1/problems/{slug}
pub async fn detail(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> AppResult<Json<ProblemDetail>> {
    let cache_key = cache::problem_detail_key(&slug);
    if let Some(cached) = state.cache.get::<ProblemDetail>(&cache_key).await {
        return Ok(Json(cached));
    }
    let p = find_published(&state, &slug).await?;
    let samples = load_samples(&state, p.id).await?;
    let body = ProblemDetail {
        number: p.number,
        slug: p.slug,
        title: p.title,
        description: p.description,
        constraints: p.constraints,
        difficulty: p.difficulty,
        time_limit_ms: p.time_limit_ms,
        memory_limit_mb: p.memory_limit_mb,
        tags: p.tags,
        samples,
    };
    state.cache.put(&cache_key, &body).await;
    Ok(Json(body))
}

/// GET /api/v1/problems/{slug}/samples — public sample cases only.
pub async fn samples(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> AppResult<Json<Vec<Sample>>> {
    let p = find_published(&state, &slug).await?;
    Ok(Json(load_samples(&state, p.id).await?))
}

/// GET /api/v1/tags — tags with the number of published problems using each.
pub async fn tags(State(state): State<AppState>) -> AppResult<Json<Vec<TagCount>>> {
    if let Some(cached) = state.cache.get::<Vec<TagCount>>(cache::TAGS_KEY).await {
        return Ok(Json(cached));
    }
    let rows = sqlx::query_as::<_, TagCount>(
        "SELECT t.name, COUNT(p.id) AS count FROM tags t \
         JOIN problem_tags pt ON pt.tag_id = t.id \
         JOIN problems p ON p.id = pt.problem_id AND p.published = TRUE \
         GROUP BY t.name ORDER BY t.name",
    )
    .fetch_all(&state.pool)
    .await?;
    state.cache.put(cache::TAGS_KEY, &rows).await;
    Ok(Json(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_escaping() {
        assert_eq!(escape_like("50%_off\\"), "50\\%\\_off\\\\");
    }
}

use axum::{
    async_trait,
    extract::{rejection::JsonRejection, FromRequest, FromRequestParts, Query, Request},
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::de::DeserializeOwned;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    /// Authenticated, but not allowed. Used for ownership and admin checks.
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    /// Rate limited. `retry_after_secs` becomes the `Retry-After` header.
    #[error("{message}")]
    TooManyRequests {
        message: String,
        retry_after_secs: u64,
    },
    /// A dependency the request needs is unavailable; the caller may retry.
    #[error("{0}")]
    Unavailable(String),
    #[error("internal server error")]
    Internal(String),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Internal(format!("database error: {e}"))
    }
}

impl From<crate::queue::QueueError> for AppError {
    fn from(e: crate::queue::QueueError) -> Self {
        match e {
            crate::queue::QueueError::Database(db) => db.into(),
            // The submission is already committed when a publish fails, and the
            // outbox will retry it, so this is not surfaced as a client error
            // unless it happened before the commit.
            other => AppError::Internal(format!("queue error: {other}")),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut retry_after: Option<u64> = None;
        let (status, code) = match &self {
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "BAD_REQUEST"),
            AppError::Unauthorized(_) => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED"),
            AppError::Forbidden(_) => (StatusCode::FORBIDDEN, "FORBIDDEN"),
            AppError::NotFound(_) => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            AppError::Conflict(_) => (StatusCode::CONFLICT, "CONFLICT"),
            AppError::TooManyRequests {
                retry_after_secs, ..
            } => {
                retry_after = Some(*retry_after_secs);
                (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED")
            }
            AppError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "UNAVAILABLE"),
            AppError::Internal(detail) => {
                // Never leak internals to the client; log them instead.
                tracing::error!(%detail, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL")
            }
        };
        let message = self.to_string();
        let mut res = (
            status,
            Json(json!({ "error": { "code": code, "message": message } })),
        )
            .into_response();
        if status == StatusCode::UNAUTHORIZED {
            res.headers_mut()
                .insert("www-authenticate", "Bearer".parse().unwrap());
        }
        if let Some(secs) = retry_after {
            if let Ok(v) = secs.to_string().parse() {
                res.headers_mut().insert("retry-after", v);
            }
        }
        res
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// JSON body extractor that reports errors in the API's standard error format.
pub struct AppJson<T>(pub T);

#[async_trait]
impl<S, T> FromRequest<S> for AppJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(v)) => Ok(AppJson(v)),
            Err(rej @ JsonRejection::MissingJsonContentType(_)) => {
                Err(AppError::BadRequest(rej.body_text()))
            }
            Err(rej) => Err(AppError::BadRequest(format!(
                "invalid JSON body: {}",
                rej.body_text()
            ))),
        }
    }
}

/// Query-string extractor that reports errors in the API's standard error format.
pub struct AppQuery<T>(pub T);

#[async_trait]
impl<S, T> FromRequestParts<S> for AppQuery<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(v)) => Ok(AppQuery(v)),
            Err(rej) => Err(AppError::BadRequest(format!(
                "invalid query string: {}",
                rej.body_text()
            ))),
        }
    }
}

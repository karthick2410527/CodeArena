use crate::{auth::jwt::verify_access_token, error::AppError, state::AppState};
use axum::{async_trait, extract::FromRequestParts, http::request::Parts};
use uuid::Uuid;

/// Authenticated caller, extracted from `Authorization: Bearer <access token>`.
/// Adding this as a handler argument makes the route protected.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: Uuid,
    pub role: String,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| AppError::Unauthorized("missing Authorization header".into()))?;
        let token = header
            .strip_prefix("Bearer ")
            .ok_or_else(|| AppError::Unauthorized("expected a Bearer token".into()))?;
        let claims = verify_access_token(&state.config.jwt_secret, token.trim())
            .map_err(|_| AppError::Unauthorized("invalid or expired token".into()))?;
        Ok(AuthUser {
            id: claims.sub,
            role: claims.role,
        })
    }
}

/// The role name stored in `users.role` and in the JWT for administrators.
pub const ROLE_ADMIN: &str = "ADMIN";

impl AuthUser {
    pub fn is_admin(&self) -> bool {
        self.role == ROLE_ADMIN
    }

    /// Ownership check used by every private resource: the owner may read it,
    /// and so may an administrator. Anyone else gets 404 rather than 403, so
    /// the endpoint does not confirm that someone else's submission exists.
    pub fn may_access(&self, owner_id: Uuid) -> bool {
        self.id == owner_id || self.is_admin()
    }
}

/// Authenticated caller that must be an administrator.
///
/// The role comes from the signed token and is re-checked against the database
/// on every admin request, so revoking a role takes effect immediately instead
/// of waiting for the access token to expire.
#[derive(Debug, Clone)]
pub struct AdminUser {
    pub id: Uuid,
}

#[async_trait]
impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = AuthUser::from_request_parts(parts, state).await?;
        // Trusting the token's claim alone would let a demoted admin keep
        // their powers until it expired.
        let role: Option<(String,)> = sqlx::query_as("SELECT role FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| AppError::Internal(format!("database error: {e}")))?;
        match role {
            Some((r,)) if r == ROLE_ADMIN => Ok(AdminUser { id: user.id }),
            Some(_) => Err(AppError::Forbidden(
                "this action requires an administrator account".into(),
            )),
            None => Err(AppError::Unauthorized("account no longer exists".into())),
        }
    }
}

use crate::{
    auth::{
        jwt::issue_access_token,
        password::{dummy_hash, hash_password, verify_password},
    },
    error::{AppError, AppJson, AppResult},
    routes::users::{find_user_by_id, UserDto, UserRow},
    state::AppState,
};
use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use chrono::{Duration, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::SocketAddr;

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: &'static str,
    pub expires_in: i64,
    pub user: UserDto,
}

fn validate_username(u: &str) -> AppResult<()> {
    let ok_len = (3..=32).contains(&u.chars().count());
    let ok_chars = u
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok_len && ok_chars {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "username must be 3-32 characters: letters, digits, '_' or '-'".into(),
        ))
    }
}

fn validate_email(e: &str) -> AppResult<()> {
    let valid = e.len() <= 254
        && !e.contains(char::is_whitespace)
        && e.split_once('@')
            .map(|(local, domain)| {
                !local.is_empty()
                    && !domain.contains('@')
                    && domain.contains('.')
                    && !domain.starts_with('.')
                    && !domain.ends_with('.')
            })
            .unwrap_or(false);
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest("email address is not valid".into()))
    }
}

fn validate_password(p: &str) -> AppResult<()> {
    let n = p.chars().count();
    if (8..=128).contains(&n) {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "password must be between 8 and 128 characters".into(),
        ))
    }
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn new_refresh_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

async fn hash_in_blocking(password: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|e| AppError::Internal(format!("join error: {e}")))?
        .map_err(|e| AppError::Internal(format!("hash error: {e}")))
}

async fn verify_in_blocking(password: String, hash: String) -> AppResult<bool> {
    tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .map_err(|e| AppError::Internal(format!("join error: {e}")))
}

async fn issue_tokens(state: &AppState, user: UserRow) -> AppResult<AuthResponse> {
    let cfg = &state.config;
    let access = issue_access_token(
        &cfg.jwt_secret,
        user.id,
        &user.role,
        cfg.access_token_ttl_secs,
    )
    .map_err(|e| AppError::Internal(format!("jwt error: {e}")))?;
    let refresh = new_refresh_token();
    sqlx::query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)")
        .bind(user.id)
        .bind(hash_token(&refresh))
        .bind(Utc::now() + Duration::days(cfg.refresh_token_ttl_days))
        .execute(&state.pool)
        .await?;
    Ok(AuthResponse {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: cfg.access_token_ttl_secs,
        user: user.into(),
    })
}

/// Identity used to rate-limit an unauthenticated request.
///
/// There is no user id yet, so this is the client address. `X-Forwarded-For` is
/// only consulted when `TRUSTED_PROXY_HOPS` says a proxy really does sit in
/// front — otherwise a caller could simply invent a new identity per request
/// and bypass the limit entirely.
fn caller_identity(
    state: &AppState,
    connect: Option<ConnectInfo<SocketAddr>>,
    headers: &HeaderMap,
) -> String {
    crate::ratelimit::client_ip(
        connect.map(|c| c.0.ip()),
        headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()),
        state.config.trusted_proxy_hops,
    )
}

/// POST /api/v1/auth/register
pub async fn register(
    State(state): State<AppState>,
    connect: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    AppJson(req): AppJson<RegisterRequest>,
) -> AppResult<(StatusCode, Json<AuthResponse>)> {
    let identity = caller_identity(&state, connect, &headers);
    let decision = state
        .limiter
        .check("register", &identity, state.config.rate_limits.register)
        .await;
    if !decision.allowed {
        return Err(AppError::TooManyRequests {
            message: "too many accounts created from this address; please try again later".into(),
            retry_after_secs: decision.retry_after_secs,
        });
    }

    let username = req.username.trim().to_string();
    let email = req.email.trim().to_lowercase();
    validate_username(&username)?;
    validate_email(&email)?;
    validate_password(&req.password)?;

    let password_hash = hash_in_blocking(req.password).await?;
    let inserted = sqlx::query_as::<_, UserRow>(
        "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) \
         RETURNING id, username, email, password_hash, role, created_at",
    )
    .bind(&username)
    .bind(&email)
    .bind(&password_hash)
    .fetch_one(&state.pool)
    .await;

    let user = match inserted {
        Ok(u) => u,
        Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505") => {
            return Err(AppError::Conflict(
                "username or email is already in use".into(),
            ));
        }
        Err(e) => return Err(e.into()),
    };
    let resp = issue_tokens(&state, user).await?;
    Ok((StatusCode::CREATED, Json(resp)))
}

/// POST /api/v1/auth/login
pub async fn login(
    State(state): State<AppState>,
    connect: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    AppJson(req): AppJson<LoginRequest>,
) -> AppResult<Json<AuthResponse>> {
    // Rate limited before any password work: this is the endpoint a credential
    // stuffer hammers, and Argon2 verification is deliberately expensive.
    let identity = caller_identity(&state, connect, &headers);
    let decision = state
        .limiter
        .check("login", &identity, state.config.rate_limits.login)
        .await;
    if !decision.allowed {
        tracing::warn!(identity = %identity, "login rate limit exceeded");
        return Err(AppError::TooManyRequests {
            message: "too many login attempts; please wait and try again".into(),
            retry_after_secs: decision.retry_after_secs,
        });
    }

    let email = req.email.trim().to_lowercase();
    let user = sqlx::query_as::<_, UserRow>(
        "SELECT id, username, email, password_hash, role, created_at FROM users WHERE lower(email) = $1",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;

    // Always run a hash verification so timing doesn't reveal whether the account exists.
    let hash = user
        .as_ref()
        .map(|u| u.password_hash.clone())
        .unwrap_or_else(|| dummy_hash().to_string());
    let ok = verify_in_blocking(req.password, hash).await?;

    match (user, ok) {
        (Some(u), true) => Ok(Json(issue_tokens(&state, u).await?)),
        _ => Err(AppError::Unauthorized("invalid email or password".into())),
    }
}

/// POST /api/v1/auth/refresh — rotates the refresh token (old one becomes unusable).
pub async fn refresh(
    State(state): State<AppState>,
    AppJson(req): AppJson<RefreshRequest>,
) -> AppResult<Json<AuthResponse>> {
    // Atomic claim: only one caller can revoke (and therefore use) a given token.
    let user_id: Option<(uuid::Uuid,)> = sqlx::query_as(
        "UPDATE refresh_tokens SET revoked_at = now() \
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() \
         RETURNING user_id",
    )
    .bind(hash_token(&req.refresh_token))
    .fetch_optional(&state.pool)
    .await?;

    let (user_id,) =
        user_id.ok_or_else(|| AppError::Unauthorized("invalid or expired refresh token".into()))?;
    let user = find_user_by_id(&state.pool, user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("account no longer exists".into()))?;
    Ok(Json(issue_tokens(&state, user).await?))
}

/// POST /api/v1/auth/logout — revokes the given refresh token. Idempotent.
pub async fn logout(
    State(state): State<AppState>,
    AppJson(req): AppJson<RefreshRequest>,
) -> AppResult<StatusCode> {
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(hash_token(&req.refresh_token))
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_rules() {
        assert!(validate_username("ada_l-1").is_ok());
        assert!(validate_username("ab").is_err());
        assert!(validate_username("has space").is_err());
        assert!(validate_username(&"x".repeat(33)).is_err());
    }

    #[test]
    fn email_rules() {
        assert!(validate_email("a@b.co").is_ok());
        assert!(validate_email("nope").is_err());
        assert!(validate_email("a@b").is_err());
        assert!(validate_email("a b@c.com").is_err());
        assert!(validate_email("@c.com").is_err());
    }

    #[test]
    fn password_rules() {
        assert!(validate_password("12345678").is_ok());
        assert!(validate_password("short").is_err());
        assert!(validate_password(&"x".repeat(129)).is_err());
    }
}

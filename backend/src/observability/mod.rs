//! Tracing, correlation IDs and metrics.
//!
//! One request, one run and one submission can all be followed through the API
//! logs, the worker logs and the database using a single `correlation_id`:
//!
//! * the API accepts `X-Correlation-Id` or generates one per request;
//! * it is echoed back on the response and attached to the tracing span;
//! * `runs.correlation_id` / `submissions.correlation_id` persist it, and the
//!   queue message carries it to the worker, which logs under the same id.

pub mod metrics;

use axum::{
    extract::{MatchedPath, Request},
    http::{HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};
use std::time::Instant;
use uuid::Uuid;

pub const CORRELATION_HEADER: &str = "x-correlation-id";

/// The correlation id for the current request, inserted by [`middleware`].
#[derive(Debug, Clone)]
pub struct CorrelationId(pub String);

impl CorrelationId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Generates a fresh correlation id (used by the worker for self-started work).
pub fn new_correlation_id() -> String {
    Uuid::new_v4().simple().to_string()
}

/// Accepts only a sane client-supplied id: short, printable ASCII. Anything
/// else is replaced, so a header can never inject into a log line.
fn sanitize(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 64 {
        return None;
    }
    if raw
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Some(raw.to_string())
    } else {
        None
    }
}

/// Assigns a correlation id, records request metrics, and echoes the id back.
pub async fn middleware(mut req: Request, next: Next) -> Response {
    let correlation = req
        .headers()
        .get(CORRELATION_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(sanitize)
        .unwrap_or_else(new_correlation_id);

    // The matched route pattern, not the concrete path: metrics must not get a
    // new series per problem slug or submission id.
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "unmatched".to_string());
    let method = req.method().as_str().to_string();

    req.extensions_mut()
        .insert(CorrelationId(correlation.clone()));

    let span = tracing::info_span!(
        "http",
        correlation_id = %correlation,
        method = %method,
        route = %route,
    );
    let started = Instant::now();
    let mut response = {
        use tracing::Instrument;
        next.run(req).instrument(span.clone()).await
    };
    let elapsed = started.elapsed();
    let status = response.status().as_u16();

    metrics::record_http(&method, &route, status, elapsed);
    tracing::info!(
        parent: &span,
        status,
        duration_ms = elapsed.as_millis() as u64,
        "request completed"
    );

    if let Ok(value) = HeaderValue::from_str(&correlation) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(CORRELATION_HEADER), value);
    }
    response
}

/// Installs the global tracing subscriber. Call once per process.
pub fn init_tracing(json: bool, default_filter: &str) {
    use tracing_subscriber::EnvFilter;
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_filter));
    if json {
        tracing_subscriber::fmt()
            .json()
            .with_current_span(true)
            .with_env_filter(filter)
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_are_unique_and_safe() {
        let a = new_correlation_id();
        let b = new_correlation_id();
        assert_ne!(a, b);
        assert_eq!(sanitize(&a).as_deref(), Some(a.as_str()));
    }

    #[test]
    fn client_ids_are_accepted_when_plain() {
        assert_eq!(sanitize("req-123_ABC").as_deref(), Some("req-123_ABC"));
        assert_eq!(sanitize("  trimmed  ").as_deref(), Some("trimmed"));
    }

    #[test]
    fn client_ids_that_could_forge_log_lines_are_rejected() {
        assert_eq!(sanitize("a\nlevel=ERROR"), None);
        assert_eq!(sanitize("a b"), None);
        assert_eq!(sanitize("<script>"), None);
        assert_eq!(sanitize(""), None);
        assert_eq!(sanitize("  "), None);
        assert_eq!(sanitize(&"x".repeat(65)), None);
        assert_eq!(sanitize(&"x".repeat(64)).map(|s| s.len()), Some(64));
    }
}

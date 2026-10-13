use crate::cache::Cache;
use crate::config::Config;
use crate::queue::Publisher;
use crate::ratelimit::RateLimiter;
use sqlx::PgPool;
use std::sync::Arc;

/// Everything a request handler needs.
///
/// Note what is *not* here: a [`crate::runner::Runner`]. The API process has no
/// way to compile or execute anything — that capability exists only in the
/// worker. Removing the temptation is the cheapest way to keep the rule.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    /// Problem-read cache. Inert when Redis is not configured.
    pub cache: Cache,
    /// Rate limiter. Allows everything when disabled.
    pub limiter: RateLimiter,
    /// Writes outbox rows / publishes jobs.
    pub publisher: Publisher,
}

impl AppState {
    /// State for tests: real database, no Redis, no broker, no runner.
    pub fn for_tests(pool: PgPool, config: Config) -> Self {
        Self {
            pool,
            config: Arc::new(config),
            cache: Cache::disabled(),
            limiter: RateLimiter::disabled(),
            publisher: Publisher::Postgres,
        }
    }
}

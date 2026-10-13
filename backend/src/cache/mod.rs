//! Redis caching for public problem reads.
//!
//! PostgreSQL stays the source of truth. The cache only ever holds data that
//! public endpoints already return, so a stale or poisoned entry cannot expose
//! anything a client could not fetch anyway — in particular, hidden test data
//! is never cached because it is never in a cacheable DTO.
//!
//! ## Invalidation
//!
//! Every key is namespaced with a version counter (`ca:problems:ver`). An admin
//! write bumps the counter, which makes every previously cached problem list
//! and detail unreachable in one atomic `INCR` — no key scanning, no partial
//! invalidation, and no stale read after a publish/unpublish.
//!
//! Redis is optional. With `REDIS_URL` unset, [`Cache::disabled`] is used and
//! every lookup is a miss; the service behaves identically, just without the
//! cache. A Redis failure at runtime is logged and treated as a miss, never as
//! a request error.

use crate::observability::metrics;
use redis::aio::ConnectionManager;
use serde::{de::DeserializeOwned, Serialize};
use std::time::Duration;

const VERSION_KEY: &str = "ca:problems:ver";

#[derive(Clone)]
pub struct Cache {
    conn: Option<ConnectionManager>,
    ttl: Duration,
}

impl Cache {
    /// Connects to Redis. A failure here is not fatal: the service starts with
    /// caching disabled and says so in the log.
    pub async fn connect(url: &str, ttl: Duration) -> Self {
        if url.trim().is_empty() {
            tracing::info!("REDIS_URL is not set: problem caching disabled");
            return Self::disabled();
        }
        match redis::Client::open(url) {
            Ok(client) => match ConnectionManager::new(client).await {
                Ok(conn) => {
                    tracing::info!(ttl_secs = ttl.as_secs(), "problem cache enabled");
                    Self {
                        conn: Some(conn),
                        ttl,
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "cannot reach Redis: continuing without a cache");
                    Self::disabled()
                }
            },
            Err(e) => {
                tracing::warn!(error = %e, "invalid REDIS_URL: continuing without a cache");
                Self::disabled()
            }
        }
    }

    pub fn disabled() -> Self {
        Self {
            conn: None,
            ttl: Duration::from_secs(0),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.conn.is_some()
    }

    /// Current cache generation. Part of every key.
    async fn version(&self) -> u64 {
        let Some(mut conn) = self.conn.clone() else {
            return 0;
        };
        match redis::cmd("GET")
            .arg(VERSION_KEY)
            .query_async::<_, Option<u64>>(&mut conn)
            .await
        {
            Ok(Some(v)) => v,
            Ok(None) => 0,
            Err(e) => {
                tracing::warn!(error = %e, "cache version read failed");
                0
            }
        }
    }

    /// Invalidates every cached problem read. Called after any admin write.
    pub async fn invalidate_problems(&self) {
        let Some(mut conn) = self.conn.clone() else {
            return;
        };
        match redis::cmd("INCR")
            .arg(VERSION_KEY)
            .query_async::<_, u64>(&mut conn)
            .await
        {
            Ok(v) => {
                metrics::record_cache("invalidate");
                tracing::info!(generation = v, "problem cache invalidated");
            }
            // Failing to bump the counter would serve stale data, so it is
            // logged loudly; the TTL still bounds the staleness.
            Err(e) => tracing::error!(error = %e, "cache invalidation failed"),
        }
    }

    /// Reads a cached value. Any error or malformed entry is a miss.
    pub async fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let mut conn = self.conn.clone()?;
        let full = format!("ca:v{}:{key}", self.version().await);
        match redis::cmd("GET")
            .arg(&full)
            .query_async::<_, Option<String>>(&mut conn)
            .await
        {
            Ok(Some(raw)) => match serde_json::from_str::<T>(&raw) {
                Ok(v) => {
                    metrics::record_cache("hit");
                    Some(v)
                }
                Err(e) => {
                    // An entry written by an older, incompatible version.
                    tracing::debug!(error = %e, key = %full, "discarding unreadable cache entry");
                    metrics::record_cache("miss");
                    None
                }
            },
            Ok(None) => {
                metrics::record_cache("miss");
                None
            }
            Err(e) => {
                tracing::warn!(error = %e, "cache read failed; serving from PostgreSQL");
                metrics::record_cache("error");
                None
            }
        }
    }

    /// Stores a value with the configured TTL. Best effort.
    pub async fn put<T: Serialize>(&self, key: &str, value: &T) {
        let Some(mut conn) = self.conn.clone() else {
            return;
        };
        let Ok(raw) = serde_json::to_string(value) else {
            return;
        };
        let full = format!("ca:v{}:{key}", self.version().await);
        let ttl = self.ttl.as_secs().max(1);
        if let Err(e) = redis::cmd("SET")
            .arg(&full)
            .arg(raw)
            .arg("EX")
            .arg(ttl)
            .query_async::<_, ()>(&mut conn)
            .await
        {
            tracing::warn!(error = %e, "cache write failed");
        }
    }

    /// `PING`, for the readiness endpoint.
    pub async fn ping(&self) -> bool {
        let Some(mut conn) = self.conn.clone() else {
            return false;
        };
        redis::cmd("PING")
            .query_async::<_, String>(&mut conn)
            .await
            .map(|r| r == "PONG")
            .unwrap_or(false)
    }
}

/// Stable cache key for a problem list query. Built from the already-validated
/// filter values, so it can never contain unbounded client input.
pub fn problem_list_key(
    page: u32,
    limit: u32,
    difficulty: Option<&str>,
    tag: Option<&str>,
    search: Option<&str>,
) -> String {
    use sha2::{Digest, Sha256};
    // The search term is hashed rather than embedded: it is free text, and a
    // key must stay short and printable.
    let search_digest = search
        .map(|s| hex::encode(&Sha256::digest(s.as_bytes())[..8]))
        .unwrap_or_else(|| "-".into());
    format!(
        "problems:p{page}:l{limit}:d{}:t{}:q{}",
        difficulty.unwrap_or("-"),
        tag.unwrap_or("-"),
        search_digest
    )
}

pub fn problem_detail_key(slug: &str) -> String {
    format!("problem:{slug}")
}

pub const TAGS_KEY: &str = "tags";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_disabled_cache_is_inert() {
        let c = Cache::disabled();
        assert!(!c.is_enabled());
    }

    #[tokio::test]
    async fn a_disabled_cache_always_misses() {
        let c = Cache::disabled();
        assert_eq!(c.get::<String>("problem:x").await, None);
        c.put("problem:x", &"value".to_string()).await;
        assert_eq!(c.get::<String>("problem:x").await, None);
        assert!(!c.ping().await);
    }

    #[test]
    fn list_keys_separate_distinct_queries() {
        let a = problem_list_key(1, 20, None, None, None);
        let b = problem_list_key(2, 20, None, None, None);
        let c = problem_list_key(1, 20, Some("EASY"), None, None);
        let d = problem_list_key(1, 20, None, Some("dp"), None);
        let e = problem_list_key(1, 20, None, None, Some("sum"));
        let keys = [&a, &b, &c, &d, &e];
        for i in 0..keys.len() {
            for j in (i + 1)..keys.len() {
                assert_ne!(keys[i], keys[j], "cache keys must not collide");
            }
        }
    }

    #[test]
    fn identical_queries_share_a_key() {
        assert_eq!(
            problem_list_key(1, 20, Some("HARD"), Some("dp"), Some("tree")),
            problem_list_key(1, 20, Some("HARD"), Some("dp"), Some("tree"))
        );
    }

    #[test]
    fn free_text_search_never_lands_in_the_key_verbatim() {
        let key = problem_list_key(1, 20, None, None, Some("a\r\nFLUSHALL"));
        assert!(!key.contains("FLUSHALL"));
        assert!(!key.contains('\n'));
        assert!(key.len() < 80);
    }
}

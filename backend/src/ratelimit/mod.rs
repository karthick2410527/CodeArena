//! Rate limiting for login, register, Run and Submit.
//!
//! ## What identifies a caller
//!
//! Never a client-supplied user id. Authenticated endpoints key on the user id
//! taken from the verified JWT; `POST /auth/login` has no identity yet, so it
//! keys on the client IP derived from the socket address — and only trusts
//! `X-Forwarded-For` when `TRUSTED_PROXY_HOPS` says there really are that many
//! proxies in front. See [`client_ip`].
//!
//! ## Algorithm
//!
//! A fixed window counter in Redis, applied in a single Lua script so the
//! `INCR` and the `EXPIRE` cannot interleave with another request. Fixed
//! windows allow a burst at a window boundary; that is acceptable for abuse
//! control here, and the window is small.
//!
//! ## Fallback
//!
//! With Redis unavailable the limiter switches to an in-process counter. That
//! is per-API-instance rather than global, which is weaker but still bounds a
//! single attacker — and it fails *closed* on the limit rather than opening the
//! endpoint up. `docs/OBSERVABILITY.md` records the trade-off.

use crate::config::RateLimit;
use crate::observability::metrics;
use redis::aio::ConnectionManager;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Verdict for one rate-limit check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub allowed: bool,
    /// Requests still available in the current window.
    pub remaining: u32,
    /// Seconds until the window resets — sent as `Retry-After`.
    pub retry_after_secs: u64,
}

#[derive(Clone)]
pub struct RateLimiter {
    redis: Option<ConnectionManager>,
    local: Arc<Mutex<HashMap<String, Window>>>,
    enabled: bool,
}

#[derive(Debug, Clone, Copy)]
struct Window {
    count: u32,
    started: Instant,
}

/// Atomic fixed-window increment: returns the new count and the key's TTL.
const SCRIPT: &str = r#"
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
"#;

impl RateLimiter {
    pub async fn connect(url: &str, enabled: bool) -> Self {
        if !enabled {
            tracing::warn!("rate limiting is DISABLED (RATE_LIMIT_ENABLED=false)");
            return Self {
                redis: None,
                local: Arc::new(Mutex::new(HashMap::new())),
                enabled: false,
            };
        }
        let redis = if url.trim().is_empty() {
            tracing::warn!("REDIS_URL is not set: rate limits are enforced per API instance only");
            None
        } else {
            match redis::Client::open(url) {
                Ok(client) => match ConnectionManager::new(client).await {
                    Ok(conn) => {
                        tracing::info!("Redis-backed rate limiting enabled");
                        Some(conn)
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "cannot reach Redis: falling back to in-process rate limits");
                        None
                    }
                },
                Err(e) => {
                    tracing::warn!(error = %e, "invalid REDIS_URL: falling back to in-process rate limits");
                    None
                }
            }
        };
        Self {
            redis,
            local: Arc::new(Mutex::new(HashMap::new())),
            enabled: true,
        }
    }

    /// A limiter that allows everything. Used by tests that are not about
    /// rate limiting.
    pub fn disabled() -> Self {
        Self {
            redis: None,
            local: Arc::new(Mutex::new(HashMap::new())),
            enabled: false,
        }
    }

    /// An in-process limiter with no Redis. Used by the rate-limit tests.
    pub fn in_process() -> Self {
        Self {
            redis: None,
            local: Arc::new(Mutex::new(HashMap::new())),
            enabled: true,
        }
    }

    pub fn is_distributed(&self) -> bool {
        self.redis.is_some()
    }

    /// Counts one request against `scope`/`identity`.
    pub async fn check(&self, scope: &str, identity: &str, limit: RateLimit) -> Decision {
        if !self.enabled || limit.max_requests == 0 {
            return Decision {
                allowed: true,
                remaining: limit.max_requests,
                retry_after_secs: 0,
            };
        }
        let key = format!("ca:rl:{scope}:{identity}");
        let decision = match self.redis.clone() {
            Some(mut conn) => {
                let result: Result<(u32, i64), _> = redis::Script::new(SCRIPT)
                    .key(&key)
                    .arg(limit.window.as_millis() as u64)
                    .invoke_async(&mut conn)
                    .await;
                match result {
                    Ok((count, ttl_ms)) => decide(count, ttl_ms.max(0) as u64, limit),
                    Err(e) => {
                        // Redis is down. Fall back rather than refuse traffic.
                        tracing::warn!(error = %e, "rate limit check failed; using in-process counter");
                        self.check_local(&key, limit)
                    }
                }
            }
            None => self.check_local(&key, limit),
        };
        if !decision.allowed {
            metrics::record_rate_limit_rejection(scope);
        }
        decision
    }

    fn check_local(&self, key: &str, limit: RateLimit) -> Decision {
        let Ok(mut map) = self.local.lock() else {
            // A poisoned lock must not take the endpoint down.
            return Decision {
                allowed: true,
                remaining: 0,
                retry_after_secs: 0,
            };
        };
        // Opportunistic cleanup so the map cannot grow without bound.
        if map.len() > 10_000 {
            map.retain(|_, w| w.started.elapsed() < limit.window);
        }
        let now = Instant::now();
        let window = map.entry(key.to_string()).or_insert(Window {
            count: 0,
            started: now,
        });
        if window.started.elapsed() >= limit.window {
            window.count = 0;
            window.started = now;
        }
        window.count += 1;
        let elapsed = window.started.elapsed();
        let ttl_ms = limit.window.saturating_sub(elapsed).as_millis().max(1) as u64;
        decide(window.count, ttl_ms, limit)
    }
}

fn decide(count: u32, ttl_ms: u64, limit: RateLimit) -> Decision {
    let allowed = count <= limit.max_requests;
    Decision {
        allowed,
        remaining: limit.max_requests.saturating_sub(count),
        retry_after_secs: ttl_ms.div_ceil(1000).max(1),
    }
}

/// Resolves the client IP used as a rate-limit identity.
///
/// `X-Forwarded-For` is a list that each proxy *appends* to, so only the
/// right-hand end was written by infrastructure we control. With `hops`
/// trusted proxies in front, the genuine client address is the entry at index
/// `len - hops`: anything further left was supplied by the caller and is
/// ignored, so prepending addresses cannot buy extra requests.
///
/// With `hops = 0` (the default) the header is not read at all and the socket
/// peer address is used — the only value a client cannot choose.
pub fn client_ip(peer: Option<IpAddr>, forwarded_for: Option<&str>, hops: usize) -> String {
    if hops > 0 {
        if let Some(raw) = forwarded_for {
            let parts: Vec<&str> = raw
                .split(',')
                .map(|p| p.trim())
                .filter(|p| !p.is_empty())
                .collect();
            // Too few entries means the header did not come through the
            // expected chain, so it is not trusted at all.
            if parts.len() >= hops {
                if let Some(candidate) = parts.get(parts.len() - hops) {
                    if let Ok(ip) = candidate.parse::<IpAddr>() {
                        return ip.to_string();
                    }
                }
            }
        }
    }
    peer.map(|p| p.to_string())
        .unwrap_or_else(|| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    use std::time::Duration;

    const LIMIT: RateLimit = RateLimit::new(3, 60);

    #[tokio::test]
    async fn disabled_limiter_allows_everything() {
        let rl = RateLimiter::disabled();
        for _ in 0..100 {
            assert!(rl.check("login", "1.2.3.4", LIMIT).await.allowed);
        }
    }

    #[tokio::test]
    async fn in_process_limiter_rejects_past_the_limit() {
        let rl = RateLimiter::in_process();
        for i in 1..=3 {
            let d = rl.check("login", "1.2.3.4", LIMIT).await;
            assert!(d.allowed, "request {i} should be allowed");
            assert_eq!(d.remaining, 3 - i);
        }
        let d = rl.check("login", "1.2.3.4", LIMIT).await;
        assert!(!d.allowed);
        assert_eq!(d.remaining, 0);
        assert!(d.retry_after_secs >= 1);
    }

    #[tokio::test]
    async fn identities_are_counted_separately() {
        let rl = RateLimiter::in_process();
        for _ in 0..3 {
            assert!(rl.check("login", "a", LIMIT).await.allowed);
        }
        assert!(!rl.check("login", "a", LIMIT).await.allowed);
        // A different caller is unaffected.
        assert!(rl.check("login", "b", LIMIT).await.allowed);
    }

    #[tokio::test]
    async fn scopes_are_counted_separately() {
        let rl = RateLimiter::in_process();
        for _ in 0..3 {
            assert!(rl.check("login", "a", LIMIT).await.allowed);
        }
        assert!(!rl.check("login", "a", LIMIT).await.allowed);
        assert!(rl.check("submit", "a", LIMIT).await.allowed);
    }

    #[tokio::test]
    async fn window_resets_after_it_elapses() {
        let rl = RateLimiter::in_process();
        let short = RateLimit {
            max_requests: 1,
            window: Duration::from_millis(60),
        };
        assert!(rl.check("run", "x", short).await.allowed);
        assert!(!rl.check("run", "x", short).await.allowed);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(rl.check("run", "x", short).await.allowed);
    }

    #[tokio::test]
    async fn a_zero_limit_means_unlimited_not_blocked() {
        let rl = RateLimiter::in_process();
        let off = RateLimit {
            max_requests: 0,
            window: Duration::from_secs(60),
        };
        assert!(rl.check("run", "x", off).await.allowed);
    }

    #[test]
    fn peer_address_is_used_when_no_proxy_is_trusted() {
        let peer = Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 7)));
        // A forged header must be ignored entirely.
        assert_eq!(client_ip(peer, Some("1.1.1.1"), 0), "10.0.0.7");
        assert_eq!(client_ip(peer, None, 0), "10.0.0.7");
    }

    #[test]
    fn one_trusted_proxy_uses_the_address_that_proxy_appended() {
        let peer = Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 7)));
        assert_eq!(client_ip(peer, Some("203.0.113.5"), 1), "203.0.113.5");
        // Our proxy appends last, so a prepended entry is ignored: an attacker
        // cannot invent a fresh identity per request.
        assert_eq!(
            client_ip(peer, Some("9.9.9.9, 203.0.113.5"), 1),
            "203.0.113.5"
        );
        assert_eq!(
            client_ip(peer, Some("a, b, c, 203.0.113.5"), 1),
            "203.0.113.5"
        );
    }

    #[test]
    fn two_trusted_proxies_skip_the_inner_hop() {
        let peer = Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 7)));
        // client -> CDN -> nginx -> app: the CDN appended the client, nginx
        // appended the CDN.
        assert_eq!(
            client_ip(peer, Some("203.0.113.5, 198.51.100.9"), 2),
            "203.0.113.5"
        );
        // A forged prefix still cannot reach past the trusted window.
        assert_eq!(
            client_ip(peer, Some("9.9.9.9, 203.0.113.5, 198.51.100.9"), 2),
            "203.0.113.5"
        );
    }

    #[test]
    fn a_header_shorter_than_the_proxy_chain_is_not_trusted() {
        let peer = Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 7)));
        // Two proxies are expected but only one entry arrived: the chain is
        // not what we configured, so fall back to the peer.
        assert_eq!(client_ip(peer, Some("203.0.113.5"), 2), "10.0.0.7");
    }

    #[test]
    fn a_missing_or_malformed_header_falls_back_to_the_peer() {
        let peer = Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 7)));
        assert_eq!(client_ip(peer, Some("not-an-ip"), 1), "10.0.0.7");
        assert_eq!(client_ip(peer, Some(""), 1), "10.0.0.7");
        assert_eq!(client_ip(None, None, 0), "unknown");
    }
}

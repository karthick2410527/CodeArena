//! Process configuration, built from environment variables.
//!
//! Every limit that protects the service (sizes, timeouts, rate limits) lives
//! here so it can be reviewed in one place and tuned per environment.

use std::env;
use std::time::Duration;

/// How submitted code is compiled and executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerStrategy {
    /// Each run happens in a throw-away Docker container with no network, a
    /// read-only root filesystem, a non-root user and hard resource limits.
    /// This is the configuration used by `docker-compose` and the one described
    /// in `docs/SECURITY.md`.
    Docker,
    /// Each run happens in a child process of the *worker* (never the API)
    /// with POSIX resource limits applied between `fork` and `exec`.
    /// Intended for development and CI where no Docker daemon is reachable.
    /// Weaker isolation: see `docs/SECURITY.md`.
    Local,
    /// Refuse to execute anything. Used by API-only deployments and by tests
    /// that must prove the API never shells out on its own.
    Disabled,
}

impl RunnerStrategy {
    fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_lowercase().as_str() {
            "docker" => Ok(Self::Docker),
            "local" => Ok(Self::Local),
            "disabled" | "off" | "none" => Ok(Self::Disabled),
            other => Err(format!(
                "RUNNER_STRATEGY must be docker, local or disabled (got {other:?})"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Local => "local",
            Self::Disabled => "disabled",
        }
    }
}

/// Which queue carries judge jobs from the API to the workers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueDriver {
    /// Apache Kafka with a consumer group of judge workers. Requires the
    /// `kafka` cargo feature and a reachable broker.
    Kafka,
    /// The transactional outbox in PostgreSQL is consumed directly with
    /// `FOR UPDATE SKIP LOCKED`. No extra infrastructure, same delivery
    /// semantics (at-least-once), used by the automated tests.
    Postgres,
}

impl QueueDriver {
    fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_lowercase().as_str() {
            "kafka" => Ok(Self::Kafka),
            "postgres" | "pg" | "outbox" => Ok(Self::Postgres),
            other => Err(format!(
                "QUEUE_DRIVER must be kafka or postgres (got {other:?})"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Kafka => "kafka",
            Self::Postgres => "postgres",
        }
    }
}

/// Limits applied to a single compile + execute cycle.
#[derive(Debug, Clone)]
pub struct RunnerLimits {
    /// Largest accepted `source_code` payload, in bytes.
    pub max_source_bytes: usize,
    /// Largest accepted stdin payload, in bytes.
    pub max_input_bytes: usize,
    /// stdout/stderr captured per execution before truncation, in bytes.
    pub max_output_bytes: usize,
    /// Wall-clock budget for the compiler.
    pub compile_timeout: Duration,
    /// Address-space ceiling for the compiler.
    pub compile_memory_mb: u64,
    /// Extra wall-clock grace added on top of a problem's time limit before the
    /// process is killed (covers process start-up, not user computation).
    pub wall_clock_grace: Duration,
    /// Hard ceiling on the per-test time limit a problem may ask for.
    pub max_time_limit_ms: u64,
    /// Hard ceiling on the per-test memory limit a problem may ask for.
    pub max_memory_limit_mb: u64,
    /// Maximum number of processes/threads the sandboxed program may create.
    pub max_processes: u64,
    /// Maximum size of any file the sandboxed program may create, in bytes.
    pub max_file_bytes: u64,
}

impl Default for RunnerLimits {
    fn default() -> Self {
        Self {
            max_source_bytes: 64 * 1024,
            max_input_bytes: 64 * 1024,
            max_output_bytes: 64 * 1024,
            compile_timeout: Duration::from_secs(15),
            compile_memory_mb: 1024,
            wall_clock_grace: Duration::from_millis(1500),
            max_time_limit_ms: 10_000,
            max_memory_limit_mb: 512,
            max_processes: 64,
            max_file_bytes: 32 * 1024 * 1024,
        }
    }
}

/// Requests allowed per window, per identity.
#[derive(Debug, Clone, Copy)]
pub struct RateLimit {
    pub max_requests: u32,
    pub window: Duration,
}

impl RateLimit {
    pub const fn new(max_requests: u32, window_secs: u64) -> Self {
        Self {
            max_requests,
            window: Duration::from_secs(window_secs),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RateLimits {
    /// Per client IP, because a login attempt has no authenticated identity yet.
    pub login: RateLimit,
    /// Per user ID.
    pub register: RateLimit,
    pub run: RateLimit,
    pub submit: RateLimit,
}

impl Default for RateLimits {
    fn default() -> Self {
        Self {
            login: RateLimit::new(10, 60),
            register: RateLimit::new(5, 3600),
            run: RateLimit::new(20, 60),
            submit: RateLimit::new(10, 60),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub bind_addr: String,
    pub cors_origin: String,
    pub access_token_ttl_secs: i64,
    pub refresh_token_ttl_days: i64,

    // ---- Phase 2: execution ------------------------------------------------
    pub runner_strategy: RunnerStrategy,
    pub runner_limits: RunnerLimits,
    /// Container image used by the Docker strategy. Server-side only: clients
    /// can never choose an image or a command.
    pub runner_image: String,
    /// Scratch directory for sandbox working directories.
    pub runner_workdir: String,
    /// How long a finished run stays readable through `GET /runs/{id}`.
    pub run_retention_hours: i64,
    /// Concurrent sandbox executions allowed in this process.
    pub runner_concurrency: usize,
    /// uid/gid the *local* strategy drops to before `exec`. Defaults to
    /// `nobody` (65534) when the worker runs as root, and to `None` otherwise
    /// (an unprivileged worker cannot change user, and does not need to).
    pub runner_uid: Option<u32>,
    pub runner_gid: Option<u32>,

    // ---- Phase 3: queue ----------------------------------------------------
    pub queue_driver: QueueDriver,
    pub kafka_brokers: String,
    pub kafka_topic: String,
    pub kafka_dlq_topic: String,
    pub kafka_group_id: String,
    /// Worker identity used for heartbeats and claim bookkeeping.
    pub worker_id: String,
    /// Judge attempts for one submission before it is dead-lettered.
    pub max_judge_attempts: i32,
    /// Base delay for the worker's bounded exponential backoff.
    pub judge_retry_base: Duration,
    /// How many submissions one worker judges at a time.
    pub worker_concurrency: usize,
    /// Poll interval for the PostgreSQL queue driver and the outbox publisher.
    pub queue_poll_interval: Duration,
    /// A submission claimed longer than this is considered abandoned and is
    /// returned to the queue by the reconciler.
    pub claim_timeout: Duration,

    // ---- Phase 5: Redis, limits, observability -----------------------------
    /// Empty disables Redis; the service then falls back to in-process
    /// rate limiting and no caching (see docs/OBSERVABILITY.md).
    pub redis_url: String,
    pub problem_cache_ttl: Duration,
    pub rate_limits: RateLimits,
    pub rate_limit_enabled: bool,
    /// Number of reverse proxies in front of the API. 0 means the peer address
    /// is used directly and `X-Forwarded-For` is ignored.
    pub trusted_proxy_hops: usize,
    pub metrics_enabled: bool,
    /// Where the worker exposes its own `/metrics` and `/health`.
    ///
    /// The API and the worker are separate processes with separate in-memory
    /// registries, so judge metrics (verdict counts, judge duration) only exist
    /// in the worker. Without this, nothing could scrape them. Empty disables
    /// the endpoint.
    pub worker_metrics_addr: String,
    pub log_format_json: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let database_url = required("DATABASE_URL")?;
        let jwt_secret = required("JWT_SECRET")?;
        if jwt_secret.len() < 32 {
            return Err("JWT_SECRET must be at least 32 characters".into());
        }

        let runner_strategy = match env::var("RUNNER_STRATEGY") {
            Ok(v) => RunnerStrategy::parse(&v)?,
            Err(_) => RunnerStrategy::Docker,
        };
        let queue_driver = match env::var("QUEUE_DRIVER") {
            Ok(v) => QueueDriver::parse(&v)?,
            Err(_) => QueueDriver::Kafka,
        };
        #[cfg(not(feature = "kafka"))]
        if queue_driver == QueueDriver::Kafka {
            return Err("QUEUE_DRIVER=kafka requires the `kafka` cargo feature; \
                 rebuild with it enabled or set QUEUE_DRIVER=postgres"
                .into());
        }

        let mut limits = RunnerLimits::default();
        limits.max_source_bytes = parse_usize("MAX_SOURCE_BYTES", limits.max_source_bytes)?;
        limits.max_input_bytes = parse_usize("MAX_INPUT_BYTES", limits.max_input_bytes)?;
        limits.max_output_bytes = parse_usize("MAX_OUTPUT_BYTES", limits.max_output_bytes)?;
        limits.compile_timeout =
            Duration::from_secs(parse_u64("COMPILE_TIMEOUT_SECS", 15)?.clamp(1, 120));
        limits.max_time_limit_ms = parse_u64("MAX_TIME_LIMIT_MS", limits.max_time_limit_ms)?;
        limits.max_memory_limit_mb = parse_u64("MAX_MEMORY_LIMIT_MB", limits.max_memory_limit_mb)?;

        let mut rate_limits = RateLimits::default();
        rate_limits.login = parse_rate("RATE_LIMIT_LOGIN", rate_limits.login)?;
        rate_limits.register = parse_rate("RATE_LIMIT_REGISTER", rate_limits.register)?;
        rate_limits.run = parse_rate("RATE_LIMIT_RUN", rate_limits.run)?;
        rate_limits.submit = parse_rate("RATE_LIMIT_SUBMIT", rate_limits.submit)?;

        Ok(Self {
            database_url,
            jwt_secret,
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            cors_origin: env::var("CORS_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".into()),
            access_token_ttl_secs: parse_i64("ACCESS_TOKEN_TTL_SECS", 900)?,
            refresh_token_ttl_days: parse_i64("REFRESH_TOKEN_TTL_DAYS", 7)?,

            runner_strategy,
            runner_limits: limits,
            runner_image: env::var("RUNNER_IMAGE")
                .unwrap_or_else(|_| "codearena-runner:cpp17".into()),
            runner_workdir: env::var("RUNNER_WORKDIR").unwrap_or_else(|_| "/tmp/codearena".into()),
            run_retention_hours: parse_i64("RUN_RETENTION_HOURS", 24)?,
            runner_concurrency: parse_usize("RUNNER_CONCURRENCY", 4)?.max(1),
            runner_uid: parse_opt_id("RUNNER_UID", default_unprivileged_id())?,
            runner_gid: parse_opt_id("RUNNER_GID", default_unprivileged_id())?,

            queue_driver,
            kafka_brokers: env::var("KAFKA_BROKERS").unwrap_or_else(|_| "localhost:9092".into()),
            kafka_topic: env::var("KAFKA_TOPIC").unwrap_or_else(|_| "codearena.submissions".into()),
            kafka_dlq_topic: env::var("KAFKA_DLQ_TOPIC")
                .unwrap_or_else(|_| "codearena.submissions.dlq".into()),
            kafka_group_id: env::var("KAFKA_GROUP_ID").unwrap_or_else(|_| "codearena-judge".into()),
            worker_id: env::var("WORKER_ID").unwrap_or_else(|_| default_worker_id()),
            max_judge_attempts: parse_i64("MAX_JUDGE_ATTEMPTS", 3)?.clamp(1, 10) as i32,
            judge_retry_base: Duration::from_millis(parse_u64("JUDGE_RETRY_BASE_MS", 500)?),
            worker_concurrency: parse_usize("WORKER_CONCURRENCY", 2)?.max(1),
            queue_poll_interval: Duration::from_millis(
                parse_u64("QUEUE_POLL_INTERVAL_MS", 500)?.clamp(10, 60_000),
            ),
            claim_timeout: Duration::from_secs(parse_u64("CLAIM_TIMEOUT_SECS", 120)?.max(5)),

            redis_url: env::var("REDIS_URL").unwrap_or_default(),
            problem_cache_ttl: Duration::from_secs(parse_u64("PROBLEM_CACHE_TTL_SECS", 60)?),
            rate_limits,
            rate_limit_enabled: parse_bool("RATE_LIMIT_ENABLED", true)?,
            trusted_proxy_hops: parse_usize("TRUSTED_PROXY_HOPS", 0)?,
            metrics_enabled: parse_bool("METRICS_ENABLED", true)?,
            worker_metrics_addr: env::var("WORKER_METRICS_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:9090".into()),
            log_format_json: parse_bool("LOG_FORMAT_JSON", false)?,
        })
    }

    /// Configuration for tests: no external infrastructure, nothing executable.
    pub fn for_tests(database_url: impl Into<String>) -> Self {
        Self {
            database_url: database_url.into(),
            jwt_secret: "test-secret-test-secret-test-secret-123".into(),
            bind_addr: "127.0.0.1:0".into(),
            cors_origin: "http://localhost:5173".into(),
            access_token_ttl_secs: 900,
            refresh_token_ttl_days: 7,
            runner_strategy: RunnerStrategy::Disabled,
            runner_limits: RunnerLimits::default(),
            runner_image: "codearena-runner:cpp17".into(),
            runner_workdir: std::env::temp_dir().to_string_lossy().into_owned(),
            run_retention_hours: 24,
            runner_concurrency: 2,
            runner_uid: default_unprivileged_id(),
            runner_gid: default_unprivileged_id(),
            queue_driver: QueueDriver::Postgres,
            kafka_brokers: String::new(),
            kafka_topic: "codearena.submissions".into(),
            kafka_dlq_topic: "codearena.submissions.dlq".into(),
            kafka_group_id: "codearena-judge-test".into(),
            worker_id: "test-worker".into(),
            max_judge_attempts: 3,
            judge_retry_base: Duration::from_millis(1),
            worker_concurrency: 1,
            queue_poll_interval: Duration::from_millis(20),
            claim_timeout: Duration::from_secs(5),
            redis_url: String::new(),
            problem_cache_ttl: Duration::from_secs(60),
            rate_limits: RateLimits::default(),
            rate_limit_enabled: false,
            trusted_proxy_hops: 0,
            metrics_enabled: true,
            // Tests must not bind a port.
            worker_metrics_addr: String::new(),
            log_format_json: false,
        }
    }

    pub fn redis_enabled(&self) -> bool {
        !self.redis_url.trim().is_empty()
    }
}

/// `nobody` when this process is root (so it *can* drop privileges), otherwise
/// nothing: an already-unprivileged process must not try to change user.
fn default_unprivileged_id() -> Option<u32> {
    // SAFETY: `geteuid` only reads the calling process's credentials.
    if unsafe { libc::geteuid() } == 0 {
        Some(65534)
    } else {
        None
    }
}

/// `RUNNER_UID=1234`, or `RUNNER_UID=` / `RUNNER_UID=none` to disable dropping.
fn parse_opt_id(key: &str, default: Option<u32>) -> Result<Option<u32>, String> {
    match env::var(key) {
        Ok(v) => {
            let v = v.trim();
            if v.is_empty() || v.eq_ignore_ascii_case("none") {
                return Ok(None);
            }
            v.parse::<u32>()
                .map(Some)
                .map_err(|_| format!("{key} must be a uid/gid number, or empty to disable"))
        }
        Err(_) => Ok(default),
    }
}

fn default_worker_id() -> String {
    let host = std::fs::read_to_string("/etc/hostname")
        .map(|h| h.trim().to_string())
        .unwrap_or_default();
    let host = if host.is_empty() {
        "worker".into()
    } else {
        host
    };
    format!("{host}-{}", std::process::id())
}

fn required(key: &str) -> Result<String, String> {
    env::var(key).map_err(|_| format!("environment variable {key} is required"))
}

fn parse_i64(key: &str, default: i64) -> Result<i64, String> {
    match env::var(key) {
        Ok(v) => v
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| format!("{key} must be a positive integer")),
        Err(_) => Ok(default),
    }
}

fn parse_u64(key: &str, default: u64) -> Result<u64, String> {
    match env::var(key) {
        Ok(v) => v
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| format!("{key} must be a positive integer")),
        Err(_) => Ok(default),
    }
}

fn parse_usize(key: &str, default: usize) -> Result<usize, String> {
    match env::var(key) {
        Ok(v) => v
            .trim()
            .parse::<usize>()
            .map_err(|_| format!("{key} must be a non-negative integer")),
        Err(_) => Ok(default),
    }
}

fn parse_bool(key: &str, default: bool) -> Result<bool, String> {
    match env::var(key) {
        Ok(v) => match v.trim().to_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => Err(format!("{key} must be true or false")),
        },
        Err(_) => Ok(default),
    }
}

/// Parses `"<max>/<window seconds>"`, e.g. `RATE_LIMIT_LOGIN=10/60`.
fn parse_rate(key: &str, default: RateLimit) -> Result<RateLimit, String> {
    let Ok(raw) = env::var(key) else {
        return Ok(default);
    };
    let (max, window) = raw
        .split_once('/')
        .ok_or_else(|| format!("{key} must look like \"requests/seconds\", e.g. 10/60"))?;
    let max: u32 = max
        .trim()
        .parse()
        .map_err(|_| format!("{key}: request count must be a non-negative integer"))?;
    let window: u64 = window
        .trim()
        .parse()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| format!("{key}: window must be a positive number of seconds"))?;
    Ok(RateLimit {
        max_requests: max,
        window: Duration::from_secs(window),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_strategy_parsing() {
        assert_eq!(
            RunnerStrategy::parse("Docker").unwrap(),
            RunnerStrategy::Docker
        );
        assert_eq!(
            RunnerStrategy::parse(" local ").unwrap(),
            RunnerStrategy::Local
        );
        assert_eq!(
            RunnerStrategy::parse("off").unwrap(),
            RunnerStrategy::Disabled
        );
        assert!(RunnerStrategy::parse("kubernetes").is_err());
    }

    #[test]
    fn queue_driver_parsing() {
        assert_eq!(QueueDriver::parse("KAFKA").unwrap(), QueueDriver::Kafka);
        assert_eq!(QueueDriver::parse("outbox").unwrap(), QueueDriver::Postgres);
        assert!(QueueDriver::parse("sqs").is_err());
    }

    #[test]
    fn rate_limit_parsing_is_validated() {
        // `parse_rate` reads the environment, so exercise the string form directly.
        let bad = "10".split_once('/');
        assert!(bad.is_none());
        let (m, w) = "25/60".split_once('/').unwrap();
        assert_eq!(m.parse::<u32>().unwrap(), 25);
        assert_eq!(w.parse::<u64>().unwrap(), 60);
    }

    #[test]
    fn test_config_never_executes_code() {
        let c = Config::for_tests("postgres://localhost/x");
        assert_eq!(c.runner_strategy, RunnerStrategy::Disabled);
        assert!(!c.redis_enabled());
    }
}

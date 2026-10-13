//! The restricted runner: compiles and executes untrusted source code.
//!
//! ## Trust model
//!
//! Submitted code is hostile until proven otherwise. The rules this module
//! enforces, regardless of strategy:
//!
//! * It never runs inside the API process. The API only writes rows; the
//!   worker process (`codearena-worker`) is the only thing that calls
//!   [`Runner::execute`].
//! * The command line is fixed by [`language`], never by the request.
//! * Every execution gets a fresh working directory that is deleted afterwards.
//! * Wall-clock, CPU, address-space, process-count and output-size limits are
//!   always applied; a run that exceeds one gets a terminal status rather than
//!   being allowed to continue.
//! * Networking is disabled (Docker: `--network none`; local: a new network
//!   namespace when the kernel permits it).
//!
//! `docs/SECURITY.md` records what each strategy does and does **not**
//! guarantee. The local strategy is explicitly not a hostile multi-tenant
//! boundary.

pub mod docker;
pub mod language;
pub mod local;

use crate::config::{Config, RunnerLimits, RunnerStrategy};
use language::Language;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

/// Why a compilation did not produce an executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompileFailure {
    /// The compiler rejected the program. `message` is compiler output and is
    /// safe to show the author of the code.
    Rejected { message: String },
    /// Compilation exceeded its wall-clock budget.
    Timeout,
}

/// A successfully compiled program, ready to execute many times.
#[derive(Debug)]
pub struct Compiled {
    /// Sandbox directory holding the artifact. Removed when dropped.
    workspace: Workspace,
    language: &'static Language,
    /// Non-fatal compiler output (warnings).
    pub warnings: String,
    pub compile_time_ms: i64,
}

impl Compiled {
    pub fn dir(&self) -> &Path {
        self.workspace.path()
    }
    pub fn language(&self) -> &'static Language {
        self.language
    }
}

/// What a single execution did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExecStatus {
    /// Exited with status 0.
    Ok,
    /// Exited with a non-zero status.
    NonZeroExit,
    /// Terminated by a signal (segfault, abort, …).
    Signalled,
    /// Exceeded the wall-clock or CPU budget.
    TimeLimit,
    /// Exceeded the address-space budget, or aborted allocating memory.
    MemoryLimit,
    /// Wrote more than the allowed amount of output.
    OutputLimit,
}

impl ExecStatus {
    pub fn is_ok(self) -> bool {
        matches!(self, Self::Ok)
    }

    /// Stored form. Must stay in step with the `exec_status` CHECK constraints
    /// in `migrations/0003_runs.sql` and `migrations/0004_submissions.sql`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "OK",
            Self::NonZeroExit => "NON_ZERO_EXIT",
            Self::Signalled => "SIGNALLED",
            Self::TimeLimit => "TIME_LIMIT",
            Self::MemoryLimit => "MEMORY_LIMIT",
            Self::OutputLimit => "OUTPUT_LIMIT",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "OK" => Some(Self::Ok),
            "NON_ZERO_EXIT" => Some(Self::NonZeroExit),
            "SIGNALLED" => Some(Self::Signalled),
            "TIME_LIMIT" => Some(Self::TimeLimit),
            "MEMORY_LIMIT" => Some(Self::MemoryLimit),
            "OUTPUT_LIMIT" => Some(Self::OutputLimit),
            _ => None,
        }
    }

    pub const ALL: &'static [ExecStatus] = &[
        ExecStatus::Ok,
        ExecStatus::NonZeroExit,
        ExecStatus::Signalled,
        ExecStatus::TimeLimit,
        ExecStatus::MemoryLimit,
        ExecStatus::OutputLimit,
    ];
}

/// Result of one execution of a compiled program.
#[derive(Debug, Clone)]
pub struct ExecOutcome {
    pub status: ExecStatus,
    pub stdout: String,
    pub stderr: String,
    /// True when output was cut off at the configured cap.
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    /// Wall-clock duration of the execution.
    pub time_ms: i64,
    /// Peak resident set size in bytes, when the strategy can measure it.
    pub memory_bytes: Option<i64>,
    /// Process exit code, when it exited normally.
    pub exit_code: Option<i32>,
    /// Signal number, when it was killed.
    pub signal: Option<i32>,
}

impl ExecOutcome {
    /// A short, user-safe description of a non-`Ok` outcome.
    pub fn failure_detail(&self) -> Option<String> {
        match self.status {
            ExecStatus::Ok => None,
            ExecStatus::NonZeroExit => Some(format!(
                "the program exited with status {}",
                self.exit_code.unwrap_or(-1)
            )),
            ExecStatus::Signalled => Some(format!(
                "the program was terminated by signal {}{}",
                self.signal.unwrap_or(0),
                match self.signal {
                    Some(libc::SIGSEGV) => " (invalid memory access)",
                    Some(libc::SIGFPE) => " (arithmetic error)",
                    Some(libc::SIGABRT) => " (aborted)",
                    _ => "",
                }
            )),
            ExecStatus::TimeLimit => Some("the program exceeded the time limit".into()),
            ExecStatus::MemoryLimit => Some("the program exceeded the memory limit".into()),
            ExecStatus::OutputLimit => Some("the program produced too much output".into()),
        }
    }
}

/// Per-execution budget. Always derived from server-side values.
#[derive(Debug, Clone, Copy)]
pub struct ExecLimits {
    pub time_limit_ms: u64,
    pub memory_limit_mb: u64,
}

impl ExecLimits {
    /// Clamps problem-provided limits to the ceilings in [`RunnerLimits`], so a
    /// mis-configured problem cannot ask for an unbounded execution.
    pub fn clamped(time_limit_ms: i64, memory_limit_mb: i64, limits: &RunnerLimits) -> Self {
        Self {
            time_limit_ms: (time_limit_ms.max(1) as u64).min(limits.max_time_limit_ms),
            memory_limit_mb: (memory_limit_mb.max(1) as u64).min(limits.max_memory_limit_mb),
        }
    }
}

/// The runner could not do its job. Distinct from "the user's code failed":
/// these are infrastructure problems and are retried, not shown as verdicts.
#[derive(Debug, thiserror::Error)]
#[error("runner failure: {0}")]
pub struct RunnerError(pub String);

impl RunnerError {
    pub fn new(msg: impl std::fmt::Display) -> Self {
        Self(msg.to_string())
    }
}

pub type RunnerResult<T> = Result<T, RunnerError>;

/// A sandbox working directory that deletes itself.
#[derive(Debug)]
pub struct Workspace {
    dir: Option<tempfile::TempDir>,
    path: PathBuf,
}

impl Workspace {
    /// Creates `<root>/run-XXXXXX`, world-accessible so a dropped-privilege
    /// child can still read its own executable.
    pub fn create(root: &str) -> RunnerResult<Self> {
        std::fs::create_dir_all(root)
            .map_err(|e| RunnerError::new(format!("cannot create {root}: {e}")))?;
        // 0o777 on the root: several unprivileged users may own sandboxes here.
        let _ = set_mode(Path::new(root), 0o777);
        let dir = tempfile::Builder::new()
            .prefix("run-")
            .tempdir_in(root)
            .map_err(|e| RunnerError::new(format!("cannot create sandbox dir: {e}")))?;
        let path = dir.path().to_path_buf();
        set_mode(&path, 0o777)?;
        Ok(Self {
            dir: Some(dir),
            path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Writes a file into the sandbox with the given permissions.
    pub fn write(&self, name: &str, contents: &str, mode: u32) -> RunnerResult<PathBuf> {
        let p = self.path.join(name);
        std::fs::write(&p, contents)
            .map_err(|e| RunnerError::new(format!("cannot write {name}: {e}")))?;
        set_mode(&p, mode)?;
        Ok(p)
    }

    /// Keeps the directory on disk (used when debugging a judge failure).
    pub fn leak(mut self) -> PathBuf {
        if let Some(d) = self.dir.take() {
            let _ = d.into_path();
        }
        self.path.clone()
    }
}

fn set_mode(path: &Path, mode: u32) -> RunnerResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| RunnerError::new(format!("cannot chmod {}: {e}", path.display())))
}

/// Reads at most `cap` bytes of a sandbox output file, lossily as UTF-8.
/// Returns `(text, truncated)`.
pub fn read_capped(path: &Path, cap: usize) -> (String, bool) {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return (String::new(), false);
    };
    let mut buf = vec![0u8; cap + 1];
    let mut filled = 0usize;
    while filled < buf.len() {
        match f.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => break,
        }
    }
    let truncated = filled > cap;
    buf.truncate(filled.min(cap));
    (String::from_utf8_lossy(&buf).into_owned(), truncated)
}

/// Compiles and executes code under one of the configured strategies.
#[derive(Clone)]
pub struct Runner {
    strategy: RunnerStrategy,
    limits: RunnerLimits,
    image: String,
    workdir: String,
    /// Bounds how many sandboxes exist at once in this process.
    permits: Arc<Semaphore>,
}

impl Runner {
    pub fn from_config(config: &Config) -> Self {
        Self {
            strategy: config.runner_strategy,
            limits: config.runner_limits.clone(),
            image: config.runner_image.clone(),
            workdir: config.runner_workdir.clone(),
            permits: Arc::new(Semaphore::new(config.runner_concurrency)),
        }
    }

    pub fn strategy(&self) -> RunnerStrategy {
        self.strategy
    }

    pub fn limits(&self) -> &RunnerLimits {
        &self.limits
    }

    pub fn is_enabled(&self) -> bool {
        self.strategy != RunnerStrategy::Disabled
    }

    /// Compiles `source`. `Ok(Err(..))` means the user's program is at fault;
    /// `Err(..)` means the runner itself failed.
    pub async fn compile(
        &self,
        language: &'static Language,
        source: &str,
    ) -> RunnerResult<Result<Compiled, CompileFailure>> {
        if source.len() > self.limits.max_source_bytes {
            // Defence in depth: the API rejects this first.
            return Err(RunnerError::new("source code exceeds the configured limit"));
        }
        let _permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| RunnerError::new(format!("runner shutting down: {e}")))?;

        let workspace = Workspace::create(&self.workdir)?;
        workspace.write(language.source_file, source, 0o644)?;

        let started = std::time::Instant::now();
        let outcome = match self.strategy {
            RunnerStrategy::Local => local::compile(&workspace, language, &self.limits).await?,
            RunnerStrategy::Docker => {
                docker::compile(&workspace, language, &self.limits, &self.image).await?
            }
            RunnerStrategy::Disabled => {
                return Err(RunnerError::new(
                    "code execution is disabled in this deployment (RUNNER_STRATEGY=disabled)",
                ))
            }
        };
        let compile_time_ms = started.elapsed().as_millis() as i64;

        match outcome {
            CompileResult::Success { warnings } => Ok(Ok(Compiled {
                workspace,
                language,
                warnings,
                compile_time_ms,
            })),
            CompileResult::Rejected { message } => Ok(Err(CompileFailure::Rejected { message })),
            CompileResult::Timeout => Ok(Err(CompileFailure::Timeout)),
        }
    }

    /// Executes a compiled program once against `stdin`.
    pub async fn execute(
        &self,
        compiled: &Compiled,
        stdin: &str,
        limits: ExecLimits,
    ) -> RunnerResult<ExecOutcome> {
        if stdin.len() > self.limits.max_input_bytes {
            return Err(RunnerError::new("input exceeds the configured limit"));
        }
        let _permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| RunnerError::new(format!("runner shutting down: {e}")))?;

        match self.strategy {
            RunnerStrategy::Local => local::execute(compiled, stdin, limits, &self.limits).await,
            RunnerStrategy::Docker => {
                docker::execute(compiled, stdin, limits, &self.limits, &self.image).await
            }
            RunnerStrategy::Disabled => Err(RunnerError::new(
                "code execution is disabled in this deployment (RUNNER_STRATEGY=disabled)",
            )),
        }
    }

    /// Wall-clock ceiling for one execution, including start-up grace.
    pub fn wall_clock_budget(&self, limits: ExecLimits) -> Duration {
        Duration::from_millis(limits.time_limit_ms) + self.limits.wall_clock_grace
    }
}

/// Strategy-level compile result, before it is wrapped for callers.
pub(crate) enum CompileResult {
    Success { warnings: String },
    Rejected { message: String },
    Timeout,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_limits_are_clamped_to_ceilings() {
        let limits = RunnerLimits::default();
        let l = ExecLimits::clamped(999_999, 100_000, &limits);
        assert_eq!(l.time_limit_ms, limits.max_time_limit_ms);
        assert_eq!(l.memory_limit_mb, limits.max_memory_limit_mb);

        let l = ExecLimits::clamped(1000, 256, &limits);
        assert_eq!(l.time_limit_ms, 1000);
        assert_eq!(l.memory_limit_mb, 256);
    }

    #[test]
    fn exec_limits_reject_zero_and_negative() {
        let limits = RunnerLimits::default();
        let l = ExecLimits::clamped(0, -5, &limits);
        assert_eq!(l.time_limit_ms, 1);
        assert_eq!(l.memory_limit_mb, 1);
    }

    #[test]
    fn workspace_is_removed_on_drop() {
        let ws = Workspace::create(
            &std::env::temp_dir()
                .join("codearena-test")
                .to_string_lossy(),
        )
        .unwrap();
        let path = ws.path().to_path_buf();
        ws.write("main.cpp", "int main(){}", 0o644).unwrap();
        assert!(path.join("main.cpp").exists());
        drop(ws);
        assert!(!path.exists(), "sandbox directory must not outlive the run");
    }

    #[test]
    fn read_capped_truncates() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("out");
        std::fs::write(&p, "a".repeat(100)).unwrap();
        let (text, truncated) = read_capped(&p, 10);
        assert_eq!(text.len(), 10);
        assert!(truncated);
        let (text, truncated) = read_capped(&p, 1000);
        assert_eq!(text.len(), 100);
        assert!(!truncated);
    }

    #[test]
    fn exec_status_round_trips_through_its_stored_form() {
        for s in ExecStatus::ALL {
            assert_eq!(ExecStatus::parse(s.as_str()), Some(*s));
        }
        assert_eq!(ExecStatus::parse("EXPLODED"), None);
    }

    #[test]
    fn read_capped_handles_missing_file() {
        let (text, truncated) = read_capped(Path::new("/nonexistent/x"), 10);
        assert!(text.is_empty());
        assert!(!truncated);
    }

    #[test]
    fn failure_details_are_user_safe() {
        let base = ExecOutcome {
            status: ExecStatus::Ok,
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            time_ms: 1,
            memory_bytes: None,
            exit_code: Some(0),
            signal: None,
        };
        assert!(base.failure_detail().is_none());
        let tle = ExecOutcome {
            status: ExecStatus::TimeLimit,
            ..base.clone()
        };
        assert!(tle.failure_detail().unwrap().contains("time limit"));
        let seg = ExecOutcome {
            status: ExecStatus::Signalled,
            signal: Some(libc::SIGSEGV),
            exit_code: None,
            ..base
        };
        assert!(seg
            .failure_detail()
            .unwrap()
            .contains("invalid memory access"));
    }

    #[tokio::test]
    async fn disabled_strategy_never_executes() {
        let mut cfg = Config::for_tests("postgres://x/y");
        cfg.runner_strategy = RunnerStrategy::Disabled;
        let runner = Runner::from_config(&cfg);
        assert!(!runner.is_enabled());
        let err = runner.compile(&language::CPP17, "int main(){}").await;
        assert!(err.is_err());
    }
}

//! Local execution strategy: a child process of the worker, confined with
//! POSIX resource limits applied between `fork` and `exec`.
//!
//! This exists so the judge pipeline can be developed and tested where no
//! Docker daemon is reachable (CI, this repository's own test suite). It gives
//! real, enforced bounds — CPU, wall clock, address space, process count, file
//! size, no new privileges, a dropped uid and (when the kernel allows it) a
//! private network namespace — but it shares the host kernel, filesystem view
//! and PID namespace with the worker.
//!
//! **It is not a hostile multi-tenant boundary.** Use
//! `RUNNER_STRATEGY=docker` for anything resembling production and read
//! `docs/SECURITY.md` for the full comparison.

use super::{
    language::Language, read_capped, CompileResult, Compiled, ExecLimits, ExecOutcome, ExecStatus,
    RunnerError, RunnerResult, Workspace,
};
use crate::config::RunnerLimits;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Everything a confined child needs, resolved before the fork.
struct Confinement {
    /// Address-space ceiling in bytes (`RLIMIT_AS`).
    address_space_bytes: u64,
    /// CPU-seconds ceiling (`RLIMIT_CPU`).
    cpu_seconds: u64,
    /// Max processes/threads (`RLIMIT_NPROC`).
    processes: u64,
    /// Max size of any created file (`RLIMIT_FSIZE`).
    file_bytes: u64,
    /// uid/gid to become, when this process is privileged enough to do so.
    drop_to: Option<(u32, u32)>,
}

/// Raw syscall wrappers used inside `pre_exec`.
///
/// Everything in here must be async-signal-safe: between `fork` and `exec`
/// only raw syscalls are allowed — no allocation, no locks, no Rust I/O.
mod confine {
    use super::Confinement;
    use std::io;

    fn setrlimit(resource: libc::__rlimit_resource_t, value: u64) -> io::Result<()> {
        let lim = libc::rlimit {
            rlim_cur: value as libc::rlim_t,
            rlim_max: value as libc::rlim_t,
        };
        // SAFETY: `lim` is a valid, fully initialised rlimit for `resource`.
        if unsafe { libc::setrlimit(resource, &lim) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn apply(c: &Confinement) -> io::Result<()> {
        // Own session + process group, so the watchdog can kill the whole tree
        // with one `kill(-pgid)` even if the program forks.
        // SAFETY: no arguments; failure is tolerable (we fall back to the pid).
        unsafe { libc::setsid() };

        // Best effort: a private network and IPC namespace. Needs CAP_SYS_ADMIN,
        // so it silently does nothing for an unprivileged worker. Must happen
        // before the uid is dropped.
        // SAFETY: `unshare` only affects the calling (child) process.
        unsafe { libc::unshare(libc::CLONE_NEWNET | libc::CLONE_NEWIPC) };

        setrlimit(libc::RLIMIT_AS, c.address_space_bytes)?;
        setrlimit(libc::RLIMIT_CPU, c.cpu_seconds)?;
        setrlimit(libc::RLIMIT_FSIZE, c.file_bytes)?;
        setrlimit(libc::RLIMIT_NOFILE, 64)?;
        setrlimit(libc::RLIMIT_CORE, 0)?;
        // RLIMIT_NPROC is per-uid, not per-process: with a shared unprivileged
        // uid it bounds all concurrent sandboxes together, which is why
        // RUNNER_CONCURRENCY is also bounded. A failure here is not fatal.
        let _ = setrlimit(libc::RLIMIT_NPROC, c.processes);

        // Never gain privileges through a setuid binary.
        // SAFETY: prctl with PR_SET_NO_NEW_PRIVS takes no pointers.
        unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
        // No core dumps, and no ptrace by same-uid processes.
        // SAFETY: as above.
        unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };

        if let Some((uid, gid)) = c.drop_to {
            // Order matters: groups, then gid, then uid. Once the uid is
            // dropped the others can no longer be changed.
            // SAFETY: passing an empty supplementary group list.
            if unsafe { libc::setgroups(0, std::ptr::null()) } != 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: plain credential syscalls.
            if unsafe { libc::setgid(gid) } != 0 {
                return Err(io::Error::last_os_error());
            }
            if unsafe { libc::setuid(uid) } != 0 {
                return Err(io::Error::last_os_error());
            }
            // Refuse to continue if the uid did not actually change.
            // SAFETY: reads this process's own credentials.
            if unsafe { libc::getuid() } == 0 {
                return Err(io::Error::other("failed to drop root privileges"));
            }
        }
        Ok(())
    }
}

/// How a confined child finished.
struct Waited {
    exit_code: Option<i32>,
    signal: Option<i32>,
    /// Killed by our wall-clock watchdog.
    wall_timeout: bool,
    peak_rss_bytes: Option<i64>,
    cpu_time: Duration,
    wall_time: Duration,
}

/// Spawns `argv` in `dir` under `confinement`, waits up to `wall_budget`, and
/// reports how it finished. Blocking: call from `spawn_blocking`.
fn spawn_and_wait(
    argv: &[&str],
    dir: &Path,
    stdin_path: Option<&Path>,
    stdout_path: &Path,
    stderr_path: &Path,
    confinement: Confinement,
    wall_budget: Duration,
) -> RunnerResult<Waited> {
    let stdin = match stdin_path {
        Some(p) => Stdio::from(
            std::fs::File::open(p)
                .map_err(|e| RunnerError::new(format!("cannot open sandbox stdin: {e}")))?,
        ),
        None => Stdio::null(),
    };
    let create = |p: &Path| -> RunnerResult<Stdio> {
        Ok(Stdio::from(std::fs::File::create(p).map_err(|e| {
            RunnerError::new(format!("cannot create {}: {e}", p.display()))
        })?))
    };

    let mut cmd = Command::new(argv[0]);
    cmd.args(&argv[1..])
        .current_dir(dir)
        .stdin(stdin)
        .stdout(create(stdout_path)?)
        .stderr(create(stderr_path)?)
        // A minimal, fixed environment: nothing from the API process leaks in,
        // and nothing in it can redirect the compiler or the program.
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", dir)
        .env("TMPDIR", dir)
        .env("LANG", "C");

    // SAFETY: the closure only calls async-signal-safe syscalls (see `confine`).
    unsafe {
        cmd.pre_exec(move || confine::apply(&confinement));
    }

    let started = Instant::now();
    let child = cmd
        .spawn()
        .map_err(|e| RunnerError::new(format!("cannot start {}: {e}", argv[0])))?;
    let pid = child.id() as libc::pid_t;
    // We reap the child ourselves with `wait4` to read its resource usage, so
    // `Child::wait` is never called. Dropping a `Child` on Unix neither waits
    // nor kills, and stdio was redirected to files, so nothing is leaked.
    std::mem::drop(child);

    let mut status: libc::c_int = 0;
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    let mut wall_timeout = false;

    loop {
        // SAFETY: `status`/`usage` are valid out-parameters we own.
        let r = unsafe { libc::wait4(pid, &mut status, libc::WNOHANG, &mut usage) };
        if r == pid {
            break;
        }
        if r < 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(RunnerError::new(format!("wait4 failed: {err}")));
        }
        if started.elapsed() >= wall_budget {
            wall_timeout = true;
            kill_tree(pid);
            // Blocking wait: the process group has been SIGKILLed, so this
            // returns promptly.
            // SAFETY: as above.
            let r = unsafe { libc::wait4(pid, &mut status, 0, &mut usage) };
            if r < 0 {
                return Err(RunnerError::new(format!(
                    "wait4 after kill failed: {}",
                    std::io::Error::last_os_error()
                )));
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let wall_time = started.elapsed();

    let (exit_code, signal) = if libc::WIFEXITED(status) {
        (Some(libc::WEXITSTATUS(status)), None)
    } else if libc::WIFSIGNALED(status) {
        (None, Some(libc::WTERMSIG(status)))
    } else {
        (None, None)
    };

    // ru_maxrss is in kilobytes on Linux.
    let peak_rss_bytes = if usage.ru_maxrss > 0 {
        Some(usage.ru_maxrss as i64 * 1024)
    } else {
        None
    };
    let cpu_time = timeval_to_duration(usage.ru_utime) + timeval_to_duration(usage.ru_stime);

    Ok(Waited {
        exit_code,
        signal,
        wall_timeout,
        peak_rss_bytes,
        cpu_time,
        wall_time,
    })
}

fn timeval_to_duration(tv: libc::timeval) -> Duration {
    Duration::new(tv.tv_sec.max(0) as u64, (tv.tv_usec.max(0) as u32) * 1000)
}

/// SIGKILLs the process group, then the process itself as a fallback.
fn kill_tree(pid: libc::pid_t) {
    // SAFETY: `kill` with a pid/pgid we created; failures are ignored on purpose.
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
        libc::kill(pid, libc::SIGKILL);
    }
}

// ---------------------------------------------------------------- compilation

pub(crate) async fn compile(
    workspace: &Workspace,
    language: &'static Language,
    limits: &RunnerLimits,
) -> RunnerResult<CompileResult> {
    let dir = workspace.path().to_path_buf();
    let argv: Vec<String> = language
        .compile_argv
        .iter()
        .map(|s| s.to_string())
        .collect();
    let budget = limits.compile_timeout;
    let confinement = Confinement {
        address_space_bytes: limits.compile_memory_mb * 1024 * 1024,
        cpu_seconds: budget.as_secs().max(1) + 1,
        processes: limits.max_processes,
        file_bytes: limits.max_file_bytes,
        // The compiler is our binary but parses hostile input, so it runs
        // unprivileged too.
        drop_to: drop_target(),
    };
    let out_cap = limits.max_output_bytes;
    let artifact = language.artifact_file.to_string();

    tokio::task::spawn_blocking(move || {
        let stdout_path = dir.join("compile.stdout");
        let stderr_path = dir.join("compile.stderr");
        let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let waited = spawn_and_wait(
            &refs,
            &dir,
            None,
            &stdout_path,
            &stderr_path,
            confinement,
            budget,
        )?;

        let (stdout, _) = read_capped(&stdout_path, out_cap);
        let (stderr, _) = read_capped(&stderr_path, out_cap);
        let _ = std::fs::remove_file(&stdout_path);
        let _ = std::fs::remove_file(&stderr_path);

        if waited.wall_timeout {
            return Ok(CompileResult::Timeout);
        }
        let succeeded = waited.exit_code == Some(0) && dir.join(&artifact).exists();
        if succeeded {
            Ok(CompileResult::Success {
                warnings: merge_output(&stdout, &stderr),
            })
        } else {
            let message = merge_output(&stdout, &stderr);
            Ok(CompileResult::Rejected {
                message: if message.trim().is_empty() {
                    format!(
                        "compilation failed (exit status {})",
                        waited
                            .exit_code
                            .map(|c| c.to_string())
                            .unwrap_or_else(|| "signalled".into())
                    )
                } else {
                    message
                },
            })
        }
    })
    .await
    .map_err(|e| RunnerError::new(format!("compile task failed: {e}")))?
}

fn merge_output(stdout: &str, stderr: &str) -> String {
    let mut s = String::new();
    if !stderr.trim().is_empty() {
        s.push_str(stderr.trim_end());
    }
    if !stdout.trim().is_empty() {
        if !s.is_empty() {
            s.push('\n');
        }
        s.push_str(stdout.trim_end());
    }
    s
}

fn drop_target() -> Option<(u32, u32)> {
    // Resolved from the environment the worker was started with; see
    // `Config::runner_uid`. Cached so `pre_exec` never reads the environment.
    use std::sync::OnceLock;
    static TARGET: OnceLock<Option<(u32, u32)>> = OnceLock::new();
    *TARGET.get_or_init(|| {
        // SAFETY: reads this process's own effective uid.
        let privileged = unsafe { libc::geteuid() } == 0;
        if !privileged {
            return None;
        }
        let parse = |k: &str| -> Option<u32> {
            match std::env::var(k) {
                Ok(v) if v.trim().is_empty() || v.trim().eq_ignore_ascii_case("none") => None,
                Ok(v) => v.trim().parse().ok(),
                Err(_) => Some(65534),
            }
        };
        match (parse("RUNNER_UID"), parse("RUNNER_GID")) {
            (Some(uid), Some(gid)) => Some((uid, gid)),
            (Some(uid), None) => Some((uid, uid)),
            _ => None,
        }
    })
}

// ----------------------------------------------------------------- execution

pub(crate) async fn execute(
    compiled: &Compiled,
    stdin: &str,
    exec: ExecLimits,
    limits: &RunnerLimits,
) -> RunnerResult<ExecOutcome> {
    let dir = compiled.dir().to_path_buf();
    let argv: Vec<String> = compiled
        .language()
        .run_argv
        .iter()
        .map(|s| s.to_string())
        .collect();
    let stdin = stdin.to_string();
    let budget = Duration::from_millis(exec.time_limit_ms) + limits.wall_clock_grace;
    let memory_bytes = exec.memory_limit_mb * 1024 * 1024;
    let confinement = Confinement {
        address_space_bytes: memory_bytes,
        // One extra CPU second so a program that is merely slow is reported as
        // a time limit rather than being killed mid-write.
        cpu_seconds: (exec.time_limit_ms / 1000) + 2,
        processes: limits.max_processes,
        file_bytes: limits.max_file_bytes,
        drop_to: drop_target(),
    };
    let out_cap = limits.max_output_bytes;
    let time_limit_ms = exec.time_limit_ms;

    tokio::task::spawn_blocking(move || {
        // A unique prefix per execution: one compiled program is executed once
        // per test case, possibly concurrently.
        let token = format!("{:x}", rand::random::<u64>());
        let stdin_path = dir.join(format!("{token}.stdin"));
        let stdout_path = dir.join(format!("{token}.stdout"));
        let stderr_path = dir.join(format!("{token}.stderr"));
        std::fs::write(&stdin_path, stdin.as_bytes())
            .map_err(|e| RunnerError::new(format!("cannot stage stdin: {e}")))?;

        let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let waited = spawn_and_wait(
            &refs,
            &dir,
            Some(&stdin_path),
            &stdout_path,
            &stderr_path,
            confinement,
            budget,
        );

        let (stdout, stdout_truncated) = read_capped(&stdout_path, out_cap);
        let (stderr, stderr_truncated) = read_capped(&stderr_path, out_cap);
        for p in [&stdin_path, &stdout_path, &stderr_path] {
            let _ = std::fs::remove_file(p);
        }
        let waited = waited?;

        let status = classify(&waited, time_limit_ms, memory_bytes, &stderr);
        Ok(ExecOutcome {
            status,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            time_ms: waited.wall_time.as_millis() as i64,
            memory_bytes: waited.peak_rss_bytes,
            exit_code: waited.exit_code,
            signal: waited.signal,
        })
    })
    .await
    .map_err(|e| RunnerError::new(format!("execute task failed: {e}")))?
}

/// Turns a raw wait status into a judge-relevant outcome.
///
/// The ordering matters: a program that runs out of time while also allocating
/// a lot of memory is reported as a time limit, because that is the limit that
/// actually stopped it.
fn classify(
    waited: &Waited,
    time_limit_ms: u64,
    memory_limit_bytes: u64,
    stderr: &str,
) -> ExecStatus {
    let time_limit = Duration::from_millis(time_limit_ms);
    if waited.wall_timeout || waited.signal == Some(libc::SIGXCPU) || waited.cpu_time >= time_limit
    {
        return ExecStatus::TimeLimit;
    }
    if waited.signal == Some(libc::SIGXFSZ) {
        return ExecStatus::OutputLimit;
    }
    if exceeded_memory(waited, memory_limit_bytes, stderr) {
        return ExecStatus::MemoryLimit;
    }
    match (waited.exit_code, waited.signal) {
        (Some(0), _) => ExecStatus::Ok,
        (Some(_), _) => ExecStatus::NonZeroExit,
        (None, Some(_)) => ExecStatus::Signalled,
        _ => ExecStatus::NonZeroExit,
    }
}

/// `RLIMIT_AS` bounds *address space*, so a program can be refused memory long
/// before its resident set reaches the limit. Two signals are therefore used:
/// a resident set close to the ceiling, or an allocation failure reported by
/// the C++ runtime on the way to `abort()`.
fn exceeded_memory(waited: &Waited, memory_limit_bytes: u64, stderr: &str) -> bool {
    if let Some(rss) = waited.peak_rss_bytes {
        if rss as u64 >= memory_limit_bytes / 100 * 90 {
            return true;
        }
    }
    if waited.signal == Some(libc::SIGABRT) {
        let lower = stderr.to_ascii_lowercase();
        return ["bad_alloc", "out of memory", "cannot allocate memory"]
            .iter()
            .any(|needle| lower.contains(needle));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn waited(exit: Option<i32>, signal: Option<i32>) -> Waited {
        Waited {
            exit_code: exit,
            signal,
            wall_timeout: false,
            peak_rss_bytes: Some(1024 * 1024),
            cpu_time: Duration::from_millis(5),
            wall_time: Duration::from_millis(7),
        }
    }

    const MEM: u64 = 256 * 1024 * 1024;

    #[test]
    fn clean_exit_is_ok() {
        assert_eq!(
            classify(&waited(Some(0), None), 1000, MEM, ""),
            ExecStatus::Ok
        );
    }

    #[test]
    fn nonzero_exit_is_runtime_failure() {
        assert_eq!(
            classify(&waited(Some(3), None), 1000, MEM, ""),
            ExecStatus::NonZeroExit
        );
    }

    #[test]
    fn signal_is_runtime_failure() {
        assert_eq!(
            classify(&waited(None, Some(libc::SIGSEGV)), 1000, MEM, ""),
            ExecStatus::Signalled
        );
    }

    #[test]
    fn wall_timeout_wins_over_everything() {
        let mut w = waited(None, Some(libc::SIGKILL));
        w.wall_timeout = true;
        w.peak_rss_bytes = Some(MEM as i64);
        assert_eq!(classify(&w, 1000, MEM, "bad_alloc"), ExecStatus::TimeLimit);
    }

    #[test]
    fn cpu_limit_is_a_time_limit() {
        let mut w = waited(None, Some(libc::SIGXCPU));
        w.cpu_time = Duration::from_millis(2000);
        assert_eq!(classify(&w, 1000, MEM, ""), ExecStatus::TimeLimit);
    }

    #[test]
    fn spent_cpu_beyond_the_limit_is_a_time_limit() {
        let mut w = waited(Some(0), None);
        w.cpu_time = Duration::from_millis(1500);
        assert_eq!(classify(&w, 1000, MEM, ""), ExecStatus::TimeLimit);
    }

    #[test]
    fn high_rss_is_a_memory_limit() {
        let mut w = waited(None, Some(libc::SIGKILL));
        w.peak_rss_bytes = Some((MEM / 100 * 95) as i64);
        assert_eq!(classify(&w, 1000, MEM, ""), ExecStatus::MemoryLimit);
    }

    #[test]
    fn bad_alloc_abort_is_a_memory_limit() {
        let w = waited(None, Some(libc::SIGABRT));
        assert_eq!(
            classify(
                &w,
                1000,
                MEM,
                "terminate called after throwing std::bad_alloc"
            ),
            ExecStatus::MemoryLimit
        );
    }

    #[test]
    fn plain_abort_is_not_a_memory_limit() {
        let w = waited(None, Some(libc::SIGABRT));
        assert_eq!(
            classify(&w, 1000, MEM, "Assertion failed"),
            ExecStatus::Signalled
        );
    }

    #[test]
    fn oversized_file_is_an_output_limit() {
        let w = waited(None, Some(libc::SIGXFSZ));
        assert_eq!(classify(&w, 1000, MEM, ""), ExecStatus::OutputLimit);
    }

    #[test]
    fn merge_output_prefers_stderr_first() {
        assert_eq!(merge_output("out", "err"), "err\nout");
        assert_eq!(merge_output("", "err"), "err");
        assert_eq!(merge_output("out", "  "), "out");
        assert_eq!(merge_output(" ", " "), "");
    }
}

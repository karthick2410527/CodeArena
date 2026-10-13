//! Docker execution strategy: every compile and every execution happens in a
//! throw-away container.
//!
//! Flags applied to every container (see `docs/SECURITY.md` for the reasoning):
//!
//! | Flag | Effect |
//! |---|---|
//! | `--network none` | no network interface at all |
//! | `--read-only` | immutable root filesystem |
//! | `--tmpfs /tmp` | small, `noexec`, `nosuid` scratch space |
//! | `--user 65534:65534` | never root inside the container |
//! | `--cap-drop ALL` | no Linux capabilities |
//! | `--security-opt no-new-privileges` | setuid binaries cannot elevate |
//! | `--pids-limit` | bounded process/thread count |
//! | `--memory` / `--memory-swap` | bounded RAM, swap disabled |
//! | `--cpus` / `--ulimit cpu` | bounded CPU |
//! | `--ulimit fsize` | bounded file writes |
//!
//! The Docker socket is deliberately **not** mounted into anything. The worker
//! talks to the daemon; the sandbox never does.

use super::{
    language::Language, read_capped, CompileResult, Compiled, ExecLimits, ExecOutcome, ExecStatus,
    RunnerError, RunnerResult, Workspace,
};
use crate::config::RunnerLimits;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;

/// Mount point of the sandbox directory inside the container.
const SANDBOX_MOUNT: &str = "/sandbox";
/// Unprivileged uid:gid used inside the container.
const CONTAINER_USER: &str = "65534:65534";

/// Flags shared by compile and execute containers.
fn base_args(
    container_name: &str,
    host_dir: &Path,
    pids_limit: u64,
    fsize_bytes: u64,
) -> Vec<String> {
    vec![
        "run".into(),
        "--name".into(),
        container_name.into(),
        // No --rm: the container is inspected for its OOM flag first, then removed.
        "--network".into(),
        "none".into(),
        "--read-only".into(),
        "--tmpfs".into(),
        "/tmp:rw,noexec,nosuid,size=16m".into(),
        "--user".into(),
        CONTAINER_USER.into(),
        "--cap-drop".into(),
        "ALL".into(),
        "--security-opt".into(),
        "no-new-privileges".into(),
        "--pids-limit".into(),
        pids_limit.to_string(),
        "--ulimit".into(),
        format!("fsize={fsize_bytes}:{fsize_bytes}"),
        "--ulimit".into(),
        "core=0:0".into(),
        "--ulimit".into(),
        "nofile=64:64".into(),
        "-v".into(),
        format!("{}:{SANDBOX_MOUNT}:rw", host_dir.display()),
        "-w".into(),
        SANDBOX_MOUNT.into(),
        "--env".into(),
        "HOME=/tmp".into(),
        "--env".into(),
        "TMPDIR=/tmp".into(),
        "--env".into(),
        "LANG=C".into(),
    ]
}

fn container_name(kind: &str) -> String {
    format!("codearena-{kind}-{:x}", rand::random::<u64>())
}

/// Runs `docker run …`, enforcing `budget` as a wall-clock ceiling.
/// Returns `(exit_code, timed_out, oom_killed, wall_time)`.
async fn run_container(
    args: Vec<String>,
    name: &str,
    stdin_path: Option<&Path>,
    stdout_path: &Path,
    stderr_path: &Path,
    budget: Duration,
) -> RunnerResult<(Option<i32>, bool, bool, Duration)> {
    let stdin = match stdin_path {
        Some(p) => Stdio::from(
            std::fs::File::open(p)
                .map_err(|e| RunnerError::new(format!("cannot open sandbox stdin: {e}")))?,
        ),
        None => Stdio::null(),
    };
    let open = |p: &Path| -> RunnerResult<Stdio> {
        Ok(Stdio::from(std::fs::File::create(p).map_err(|e| {
            RunnerError::new(format!("cannot create {}: {e}", p.display()))
        })?))
    };

    let started = Instant::now();
    let mut child = Command::new("docker")
        .args(&args)
        .stdin(stdin)
        .stdout(open(stdout_path)?)
        .stderr(open(stderr_path)?)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| RunnerError::new(format!("cannot start docker: {e}")))?;

    let mut timed_out = false;
    let status = match tokio::time::timeout(budget, child.wait()).await {
        Ok(result) => result.map_err(|e| RunnerError::new(format!("docker wait failed: {e}")))?,
        Err(_) => {
            timed_out = true;
            // Stop the container, not just the CLI, or the program keeps running.
            let _ = Command::new("docker")
                .args(["kill", name])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
            child
                .wait()
                .await
                .map_err(|e| RunnerError::new(format!("docker wait failed after kill: {e}")))?
        }
    };
    let wall_time = started.elapsed();

    // Ask the daemon whether the kernel OOM-killed the process: this is the only
    // reliable way to tell a memory limit from an ordinary crash.
    let oom_killed = inspect_bool(name, "{{.State.OOMKilled}}").await;
    let _ = Command::new("docker")
        .args(["rm", "-f", name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;

    Ok((status.code(), timed_out, oom_killed, wall_time))
}

async fn inspect_bool(name: &str, format: &str) -> bool {
    let out = Command::new("docker")
        .args(["inspect", "--format", format, name])
        .output()
        .await;
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim() == "true",
        Err(_) => false,
    }
}

// ---------------------------------------------------------------- compilation

pub(crate) async fn compile(
    workspace: &Workspace,
    language: &'static Language,
    limits: &RunnerLimits,
    image: &str,
) -> RunnerResult<CompileResult> {
    let dir = workspace.path();
    let name = container_name("build");
    let mut args = base_args(&name, dir, limits.max_processes, limits.max_file_bytes);
    let compile_secs = limits.compile_timeout.as_secs().max(1);
    args.extend([
        "--memory".into(),
        format!("{}m", limits.compile_memory_mb),
        "--memory-swap".into(),
        format!("{}m", limits.compile_memory_mb),
        "--ulimit".into(),
        format!("cpu={}:{}", compile_secs + 1, compile_secs + 1),
        image.to_string(),
    ]);
    // Fixed, server-side compiler invocation.
    args.extend(language.compile_argv.iter().map(|s| s.to_string()));

    let stdout_path = dir.join("compile.stdout");
    let stderr_path = dir.join("compile.stderr");
    let (code, timed_out, _oom, _wall) = run_container(
        args,
        &name,
        None,
        &stdout_path,
        &stderr_path,
        limits.compile_timeout + Duration::from_secs(5),
    )
    .await?;

    let (stdout, _) = read_capped(&stdout_path, limits.max_output_bytes);
    let (stderr, _) = read_capped(&stderr_path, limits.max_output_bytes);
    let _ = std::fs::remove_file(&stdout_path);
    let _ = std::fs::remove_file(&stderr_path);

    if timed_out {
        return Ok(CompileResult::Timeout);
    }
    if code == Some(0) && dir.join(language.artifact_file).exists() {
        return Ok(CompileResult::Success {
            warnings: merge(&stdout, &stderr),
        });
    }
    let message = merge(&stdout, &stderr);
    // A docker-level failure (image missing, daemon unreachable) must not be
    // reported to the user as a compilation error.
    if message.contains("Unable to find image")
        || message.contains("Cannot connect to the Docker daemon")
        || message.contains("permission denied while trying to connect")
    {
        return Err(RunnerError::new(format!(
            "docker could not start the runner image: {}",
            message.lines().next().unwrap_or("unknown error")
        )));
    }
    Ok(CompileResult::Rejected {
        message: if message.trim().is_empty() {
            format!(
                "compilation failed (exit status {})",
                code.map(|c| c.to_string())
                    .unwrap_or_else(|| "killed".into())
            )
        } else {
            message
        },
    })
}

fn merge(stdout: &str, stderr: &str) -> String {
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

// ----------------------------------------------------------------- execution

pub(crate) async fn execute(
    compiled: &Compiled,
    stdin: &str,
    exec: ExecLimits,
    limits: &RunnerLimits,
    image: &str,
) -> RunnerResult<ExecOutcome> {
    let dir = compiled.dir();
    let token = format!("{:x}", rand::random::<u64>());
    let stdin_path = dir.join(format!("{token}.stdin"));
    let stdout_path = dir.join(format!("{token}.stdout"));
    let stderr_path = dir.join(format!("{token}.stderr"));
    tokio::fs::write(&stdin_path, stdin.as_bytes())
        .await
        .map_err(|e| RunnerError::new(format!("cannot stage stdin: {e}")))?;

    let name = container_name("run");
    let mut args = base_args(&name, dir, limits.max_processes, limits.max_file_bytes);
    let cpu_secs = (exec.time_limit_ms / 1000) + 2;
    args.extend([
        "--interactive".into(),
        "--memory".into(),
        format!("{}m", exec.memory_limit_mb),
        // Equal values disable swap, so the memory limit is a real RAM limit.
        "--memory-swap".into(),
        format!("{}m", exec.memory_limit_mb),
        "--cpus".into(),
        "1.0".into(),
        "--ulimit".into(),
        format!("cpu={cpu_secs}:{cpu_secs}"),
        image.to_string(),
    ]);
    args.extend(compiled.language().run_argv.iter().map(|s| s.to_string()));

    // Container start-up costs more than a bare fork, so the grace period is
    // added on top of the problem's own limit.
    let budget = Duration::from_millis(exec.time_limit_ms)
        + limits.wall_clock_grace
        + Duration::from_secs(2);
    let result = run_container(
        args,
        &name,
        Some(&stdin_path),
        &stdout_path,
        &stderr_path,
        budget,
    )
    .await;

    let (stdout, stdout_truncated) = read_capped(&stdout_path, limits.max_output_bytes);
    let (stderr, stderr_truncated) = read_capped(&stderr_path, limits.max_output_bytes);
    for p in [&stdin_path, &stdout_path, &stderr_path] {
        let _ = std::fs::remove_file(p);
    }
    let (code, timed_out, oom_killed, wall_time) = result?;

    let status = classify(
        code,
        timed_out,
        oom_killed,
        wall_time,
        exec.time_limit_ms,
        &stderr,
    );
    let (exit_code, signal) = decode_exit(code);
    Ok(ExecOutcome {
        status,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        time_ms: wall_time.as_millis() as i64,
        // Docker removes the container before per-process accounting can be
        // read back, so peak memory is not measured in this strategy.
        memory_bytes: None,
        exit_code,
        signal,
    })
}

/// `docker run` reports a signalled process as `128 + signal`.
fn decode_exit(code: Option<i32>) -> (Option<i32>, Option<i32>) {
    match code {
        Some(c) if c > 128 && c < 192 => (None, Some(c - 128)),
        Some(c) => (Some(c), None),
        None => (None, None),
    }
}

pub(crate) fn classify(
    code: Option<i32>,
    timed_out: bool,
    oom_killed: bool,
    wall_time: Duration,
    time_limit_ms: u64,
    stderr: &str,
) -> ExecStatus {
    if timed_out {
        return ExecStatus::TimeLimit;
    }
    let (_, signal) = decode_exit(code);
    if signal == Some(libc::SIGXCPU) {
        return ExecStatus::TimeLimit;
    }
    if oom_killed {
        return ExecStatus::MemoryLimit;
    }
    if signal == Some(libc::SIGXFSZ) {
        return ExecStatus::OutputLimit;
    }
    if signal == Some(libc::SIGABRT) {
        let lower = stderr.to_ascii_lowercase();
        if ["bad_alloc", "out of memory", "cannot allocate memory"]
            .iter()
            .any(|n| lower.contains(n))
        {
            return ExecStatus::MemoryLimit;
        }
    }
    match code {
        Some(0) => {
            // A container killed exactly at the limit can still report 0.
            if wall_time >= Duration::from_millis(time_limit_ms) {
                ExecStatus::TimeLimit
            } else {
                ExecStatus::Ok
            }
        }
        Some(_) if signal.is_some() => ExecStatus::Signalled,
        Some(_) => ExecStatus::NonZeroExit,
        None => ExecStatus::Signalled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_flags_are_restrictive() {
        let args = base_args("n", Path::new("/tmp/x"), 64, 1024);
        let joined = args.join(" ");
        assert!(joined.contains("--network none"));
        assert!(joined.contains("--read-only"));
        assert!(joined.contains("--cap-drop ALL"));
        assert!(joined.contains("no-new-privileges"));
        assert!(joined.contains("--pids-limit 64"));
        assert!(joined.contains(CONTAINER_USER));
        // The Docker socket must never be handed to a sandbox.
        assert!(!joined.contains("docker.sock"));
        assert!(!joined.contains("--privileged"));
    }

    #[test]
    fn exit_codes_decode_signals() {
        assert_eq!(decode_exit(Some(0)), (Some(0), None));
        assert_eq!(decode_exit(Some(1)), (Some(1), None));
        assert_eq!(decode_exit(Some(139)), (None, Some(libc::SIGSEGV)));
        assert_eq!(decode_exit(Some(137)), (None, Some(libc::SIGKILL)));
        assert_eq!(decode_exit(None), (None, None));
    }

    #[test]
    fn oom_flag_is_a_memory_limit() {
        let s = classify(Some(137), false, true, Duration::from_millis(10), 1000, "");
        assert_eq!(s, ExecStatus::MemoryLimit);
    }

    #[test]
    fn timeout_is_a_time_limit() {
        let s = classify(
            Some(137),
            true,
            false,
            Duration::from_millis(2000),
            1000,
            "",
        );
        assert_eq!(s, ExecStatus::TimeLimit);
    }

    #[test]
    fn segfault_is_a_runtime_failure() {
        let s = classify(Some(139), false, false, Duration::from_millis(5), 1000, "");
        assert_eq!(s, ExecStatus::Signalled);
    }

    #[test]
    fn nonzero_exit_is_a_runtime_failure() {
        let s = classify(Some(2), false, false, Duration::from_millis(5), 1000, "");
        assert_eq!(s, ExecStatus::NonZeroExit);
    }

    #[test]
    fn clean_exit_is_ok() {
        let s = classify(Some(0), false, false, Duration::from_millis(5), 1000, "");
        assert_eq!(s, ExecStatus::Ok);
    }
}

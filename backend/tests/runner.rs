//! Runner integration tests: real `g++`, real sandboxed processes.
//!
//! These use `RUNNER_STRATEGY=local`, so they need a C++17 compiler on PATH and
//! are skipped (with a printed note) when there is none. They are the tests
//! that prove the limits are actually enforced rather than merely configured.

use codearena_api::config::{Config, RunnerStrategy};
use codearena_api::judge::compare;
use codearena_api::runner::{language, CompileFailure, ExecLimits, ExecStatus, Runner};

/// A runner using the local strategy, or `None` when no compiler is available.
fn local_runner() -> Option<Runner> {
    if std::process::Command::new("g++")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| !s.success())
        .unwrap_or(true)
    {
        eprintln!("SKIPPED: g++ is not available on PATH");
        return None;
    }
    let mut config = Config::for_tests("postgres://unused");
    config.runner_strategy = RunnerStrategy::Local;
    config.runner_workdir = std::env::temp_dir()
        .join("codearena-runner-tests")
        .to_string_lossy()
        .into_owned();
    // Keep the suite quick; the defaults are for production.
    config.runner_limits.compile_timeout = std::time::Duration::from_secs(30);
    Some(Runner::from_config(&config))
}

const LIMITS: ExecLimits = ExecLimits {
    time_limit_ms: 1000,
    memory_limit_mb: 256,
};

macro_rules! runner_or_skip {
    () => {
        match local_runner() {
            Some(r) => r,
            None => return,
        }
    };
}

#[tokio::test]
async fn a_correct_program_compiles_and_produces_output() {
    let runner = runner_or_skip!();
    let src = r#"
        #include <bits/stdc++.h>
        int main() { long long a, b; std::cin >> a >> b; std::cout << a + b << "\n"; }
    "#;
    let compiled = runner
        .compile(&language::CPP17, src)
        .await
        .expect("runner available")
        .expect("program should compile");

    let out = runner
        .execute(&compiled, "3 5", LIMITS)
        .await
        .expect("execution should not fail internally");
    assert_eq!(out.status, ExecStatus::Ok, "stderr: {}", out.stderr);
    assert!(
        compare::matches(&out.stdout, "8"),
        "stdout was {:?}",
        out.stdout
    );
    assert!(out.time_ms >= 0);
}

#[tokio::test]
async fn one_compilation_serves_many_executions() {
    let runner = runner_or_skip!();
    let src = r#"
        #include <bits/stdc++.h>
        int main() { int n; std::cin >> n; std::cout << n * n << "\n"; }
    "#;
    let compiled = runner
        .compile(&language::CPP17, src)
        .await
        .unwrap()
        .expect("compiles");
    for (input, expected) in [("2", "4"), ("5", "25"), ("12", "144")] {
        let out = runner.execute(&compiled, input, LIMITS).await.unwrap();
        assert_eq!(out.status, ExecStatus::Ok);
        assert!(compare::matches(&out.stdout, expected));
    }
}

#[tokio::test]
async fn a_syntax_error_is_a_compilation_error_not_a_crash() {
    let runner = runner_or_skip!();
    let result = runner
        .compile(&language::CPP17, "int main() { this is not c++ }")
        .await
        .expect("the runner itself works");
    match result {
        Err(CompileFailure::Rejected { message }) => {
            assert!(
                !message.trim().is_empty(),
                "the author needs the diagnostics"
            );
            assert!(
                message.contains("error") || message.contains("expected"),
                "unexpected compiler message: {message}"
            );
        }
        other => panic!("expected a rejected compilation, got {other:?}"),
    }
}

#[tokio::test]
async fn a_nonzero_exit_is_a_runtime_failure() {
    let runner = runner_or_skip!();
    let compiled = runner
        .compile(&language::CPP17, "int main() { return 3; }")
        .await
        .unwrap()
        .expect("compiles");
    let out = runner.execute(&compiled, "", LIMITS).await.unwrap();
    assert_eq!(out.status, ExecStatus::NonZeroExit);
    assert_eq!(out.exit_code, Some(3));
}

#[tokio::test]
async fn a_segfault_is_reported_as_a_signal() {
    let runner = runner_or_skip!();
    let src = "int main() { int* p = nullptr; *p = 1; return 0; }";
    let compiled = runner
        .compile(&language::CPP17, src)
        .await
        .unwrap()
        .expect("compiles");
    let out = runner.execute(&compiled, "", LIMITS).await.unwrap();
    assert_eq!(out.status, ExecStatus::Signalled);
    assert_eq!(out.signal, Some(libc::SIGSEGV));
}

#[tokio::test]
async fn an_infinite_loop_hits_the_time_limit_and_is_killed() {
    let runner = runner_or_skip!();
    let compiled = runner
        .compile(&language::CPP17, "int main() { while (true) {} }")
        .await
        .unwrap()
        .expect("compiles");

    let started = std::time::Instant::now();
    let out = runner
        .execute(
            &compiled,
            "",
            ExecLimits {
                time_limit_ms: 300,
                memory_limit_mb: 128,
            },
        )
        .await
        .unwrap();
    let elapsed = started.elapsed();

    assert_eq!(out.status, ExecStatus::TimeLimit);
    // The process must actually be gone, and promptly: limit + grace + slack.
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "took {elapsed:?}; the watchdog did not terminate the process"
    );
}

#[tokio::test]
async fn a_memory_hog_hits_the_memory_limit() {
    let runner = runner_or_skip!();
    // Touch every page so the resident set really grows.
    let src = r#"
        #include <bits/stdc++.h>
        int main() {
            std::vector<std::vector<char>> blocks;
            for (int i = 0; i < 4096; ++i) {
                blocks.emplace_back(4 * 1024 * 1024, 1);
                for (size_t j = 0; j < blocks.back().size(); j += 4096)
                    blocks.back()[j] = (char)i;
            }
            std::cout << blocks.size() << "\n";
        }
    "#;
    let compiled = runner
        .compile(&language::CPP17, src)
        .await
        .unwrap()
        .expect("compiles");
    let out = runner
        .execute(
            &compiled,
            "",
            ExecLimits {
                time_limit_ms: 5000,
                memory_limit_mb: 64,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        out.status,
        ExecStatus::MemoryLimit,
        "status {:?}, stderr {:?}",
        out.status,
        out.stderr
    );
}

#[tokio::test]
async fn output_is_captured_and_truncated_rather_than_filling_the_disk() {
    let runner = runner_or_skip!();
    let src = r#"
        #include <bits/stdc++.h>
        int main() {
            std::string line(1024, 'x');
            for (int i = 0; i < 5000; ++i) std::cout << line << "\n";
        }
    "#;
    let compiled = runner
        .compile(&language::CPP17, src)
        .await
        .unwrap()
        .expect("compiles");
    let out = runner
        .execute(
            &compiled,
            "",
            ExecLimits {
                time_limit_ms: 5000,
                memory_limit_mb: 128,
            },
        )
        .await
        .unwrap();
    assert!(out.stdout_truncated, "5 MB of output must be truncated");
    assert!(out.stdout.len() <= runner.limits().max_output_bytes);
}

#[tokio::test]
async fn stderr_is_captured_separately_from_stdout() {
    let runner = runner_or_skip!();
    let src = r#"
        #include <bits/stdc++.h>
        int main() { std::cout << "to-stdout\n"; std::cerr << "to-stderr\n"; }
    "#;
    let compiled = runner
        .compile(&language::CPP17, src)
        .await
        .unwrap()
        .expect("compiles");
    let out = runner.execute(&compiled, "", LIMITS).await.unwrap();
    assert!(out.stdout.contains("to-stdout"));
    assert!(!out.stdout.contains("to-stderr"));
    assert!(out.stderr.contains("to-stderr"));
}

#[tokio::test]
async fn the_sandbox_has_no_network_access_or_fails_closed() {
    let runner = runner_or_skip!();
    // A raw socket connect to a public address. In a new network namespace this
    // fails immediately; without one it may time out — either way the program
    // must not succeed in reaching anything.
    let src = r#"
        #include <bits/stdc++.h>
        #include <sys/socket.h>
        #include <netinet/in.h>
        #include <arpa/inet.h>
        #include <unistd.h>
        int main() {
            int fd = socket(AF_INET, SOCK_STREAM, 0);
            if (fd < 0) { std::cout << "no-socket\n"; return 0; }
            sockaddr_in a{};
            a.sin_family = AF_INET;
            a.sin_port = htons(53);
            inet_pton(AF_INET, "1.1.1.1", &a.sin_addr);
            int r = connect(fd, (sockaddr*)&a, sizeof a);
            std::cout << (r == 0 ? "connected" : "blocked") << "\n";
            close(fd);
        }
    "#;
    let compiled = runner
        .compile(&language::CPP17, src)
        .await
        .unwrap()
        .expect("compiles");
    let out = runner
        .execute(
            &compiled,
            "",
            ExecLimits {
                time_limit_ms: 2000,
                memory_limit_mb: 128,
            },
        )
        .await
        .unwrap();
    assert!(
        !out.stdout.contains("connected"),
        "the sandbox reached the network: {:?}",
        out.stdout
    );
}

#[tokio::test]
async fn the_sandbox_runs_unprivileged_when_the_worker_is_root() {
    let runner = runner_or_skip!();
    let src = r#"
        #include <bits/stdc++.h>
        #include <unistd.h>
        int main() { std::cout << getuid() << "\n"; }
    "#;
    let compiled = runner
        .compile(&language::CPP17, src)
        .await
        .unwrap()
        .expect("compiles");
    let out = runner.execute(&compiled, "", LIMITS).await.unwrap();
    let uid: u32 = out.stdout.trim().parse().expect("uid on stdout");
    // SAFETY: reads this process's own effective uid.
    let worker_is_root = unsafe { libc::geteuid() } == 0;
    if worker_is_root {
        assert_ne!(uid, 0, "a root worker must drop privileges before exec");
    } else {
        println!("worker is already unprivileged (uid {uid}); nothing to drop");
    }
}

#[tokio::test]
async fn the_sandbox_directory_is_removed_after_the_run() {
    let runner = runner_or_skip!();
    let compiled = runner
        .compile(&language::CPP17, "int main() {}")
        .await
        .unwrap()
        .expect("compiles");
    let dir = compiled.dir().to_path_buf();
    assert!(dir.exists());
    drop(compiled);
    assert!(!dir.exists(), "the sandbox must not outlive the run");
}

#[tokio::test]
async fn oversized_source_is_refused_before_compilation() {
    let runner = runner_or_skip!();
    let huge = "// ".to_string() + &"x".repeat(runner.limits().max_source_bytes + 1);
    assert!(
        runner.compile(&language::CPP17, &huge).await.is_err(),
        "source over the limit must be refused by the runner too"
    );
}

#[tokio::test]
async fn oversized_input_is_refused_before_execution() {
    let runner = runner_or_skip!();
    let compiled = runner
        .compile(&language::CPP17, "int main() {}")
        .await
        .unwrap()
        .expect("compiles");
    let huge = "x".repeat(runner.limits().max_input_bytes + 1);
    assert!(runner.execute(&compiled, &huge, LIMITS).await.is_err());
}

#[tokio::test]
async fn a_disabled_runner_refuses_to_compile_anything() {
    let config = Config::for_tests("postgres://unused");
    assert_eq!(config.runner_strategy, RunnerStrategy::Disabled);
    let runner = Runner::from_config(&config);
    assert!(runner
        .compile(&language::CPP17, "int main(){}")
        .await
        .is_err());
}

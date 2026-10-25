# Security

> **Note.** This describes the sandbox of the earlier Rust implementation (in git history). The Java judge workers, with a Docker sandbox per execution, are still being built; until they land, nothing executes submitted code. The account and sign-in rules for the Java API are in `backend/README.md`.

This document is deliberately blunt about what is and is not protected.
CodeArena executes code written by strangers; the useful question is not
"is it sandboxed?" but "sandboxed against what?".

---

## The one rule that is never relaxed

**Submitted code never runs in the API process.** The API has no
`runner::Runner` in its state at all, so there is no code path — not even a
buggy one — by which a request could compile or execute something. Execution
belongs to `codearena-worker`, a separate process, usually in a separate
container. In the compose stack the API runs with `RUNNER_STRATEGY=disabled`,
which makes any attempt a hard error.

---

## What runs where

| Process | Privileges | Executes untrusted code |
| --- | --- | --- |
| `codearena-api` | uid 10001, no compiler in the image | No, and cannot |
| `codearena-worker` | root → drops to 65534 per sandbox | Yes |
| sandbox child / container | uid 65534, no capabilities, no network | It *is* the untrusted code |

---

## Strategy comparison

### `RUNNER_STRATEGY=docker` — recommended

One throw-away container per compile and per execution:

| Flag | Effect |
| --- | --- |
| `--network none` | No network interface exists in the container |
| `--read-only` | Immutable root filesystem |
| `--tmpfs /tmp:noexec,nosuid,size=16m` | Small scratch space that cannot hold an executable |
| `--user 65534:65534` | Never root inside the container |
| `--cap-drop ALL` | No Linux capabilities whatsoever |
| `--security-opt no-new-privileges` | A setuid binary cannot elevate |
| `--pids-limit` | Bounded processes and threads (fork-bomb containment) |
| `--memory` = `--memory-swap` | Bounded RAM with swap disabled, so the limit is real |
| `--cpus 1.0`, `--ulimit cpu` | Bounded CPU, both share and total seconds |
| `--ulimit fsize`, `--ulimit core=0`, `--ulimit nofile=64` | Bounded writes, no core dumps, bounded descriptors |

The Docker socket is **never** mounted into a sandbox container. The command
line comes from the server-side language registry
(`backend/src/runner/language.rs`); a request carries a language *id* and
nothing else, so no part of the argv or the image can be influenced from
outside.

Runs are isolated **from each other** as well as from the host: each gets its
own container, its own filesystem view and its own PID namespace.

The cost: the worker needs to talk to the Docker daemon. In compose that means
mounting `/var/run/docker.sock` into the worker, and **a compromise of the
worker container is then a compromise of the host.** That is why this variant
is behind an opt-in profile:

```bash
docker compose --profile docker-runner up -d
```

### `RUNNER_STRATEGY=local` — the compose default, and what CI uses

A child process of the worker, confined between `fork` and `exec`
(`backend/src/runner/local.rs`). Everything below is actually enforced and
covered by tests in `backend/tests/runner.rs`:

| Control | Mechanism |
| --- | --- |
| Wall-clock limit | A watchdog `SIGKILL`s the process **group** |
| CPU limit | `RLIMIT_CPU` = time limit + 2s |
| Address space | `RLIMIT_AS` = the problem's memory limit |
| Processes/threads | `RLIMIT_NPROC` |
| File size | `RLIMIT_FSIZE` |
| Core dumps | `RLIMIT_CORE = 0` |
| File descriptors | `RLIMIT_NOFILE = 64` |
| Privileges | `setgroups(0)`, `setgid`, `setuid` to 65534, verified afterwards |
| Privilege escalation | `prctl(PR_SET_NO_NEW_PRIVS)` |
| Debugging/inspection | `prctl(PR_SET_DUMPABLE, 0)` |
| Process group | `setsid()`, so a forking program cannot outlive the kill |
| Network | `unshare(CLONE_NEWNET \| CLONE_NEWIPC)` — **best effort** |
| Environment | `env_clear()`, then a fixed minimal `PATH`/`HOME`/`TMPDIR` |

What it does **not** give you:

* **A shared kernel, filesystem view and PID namespace with the worker.** A
  kernel privilege-escalation bug is a full escape.
* **The network namespace is best effort.** `unshare(CLONE_NEWNET)` needs
  `CAP_SYS_ADMIN`; an unprivileged worker silently keeps the host network. The
  compose worker runs with `cap_drop: ALL`, so in that configuration the
  *container's* network is the boundary, not the namespace.
* **`RLIMIT_NPROC` is per-uid, not per-process.** All concurrent sandboxes share
  uid 65534, so they share that budget. `RUNNER_CONCURRENCY` is bounded for
  this reason, and one run can affect another's ability to fork.
* **Runs are not isolated from each other.** Same uid, same `/sandbox` tmpfs
  (each in its own 0700-parent directory, but same filesystem).
* **No seccomp filter.** Any syscall the kernel offers is reachable.

The compose `worker` service therefore wraps `local` in a container with
`cap_drop: ALL`, `no-new-privileges`, a read-only root filesystem, a tmpfs
sandbox, `pids_limit: 512` and `mem_limit: 2g`. The container is the outer
boundary; the rlimits are the inner one. No Docker socket is mounted anywhere.

---

## What is explicitly not implemented

Saying this plainly is more useful than a reassuring list:

* **No seccomp-bpf profile.** A syscall allowlist is the single biggest
  remaining hardening step.
* **No gVisor, Firecracker or KVM isolation.** Those are what a public judge
  handling genuinely hostile code should use.
* **No per-user cgroup accounting** beyond the container's own limits, so one
  tenant's runs can affect another's throughput.
* **No egress filtering** in the `local` strategy when the namespace cannot be
  created.
* **No protection against side channels** (timing, cache) between concurrent
  runs.
* **Compilation is not resource-isolated from execution** beyond its own
  rlimits; a compiler bomb is bounded by `COMPILE_TIMEOUT_SECS` and
  `RLIMIT_AS`, not by a separate cgroup.

**Do not expose this to the public internet as-is.** It is a correct,
testable single-machine judge, which is what the project set out to build.

---

## Hidden test data

Hidden inputs and expected outputs exist in exactly one table, `test_cases`,
and leave it through exactly three queries:

| Query | Where | Filter |
| --- | --- | --- |
| Public samples | `routes/problems.rs::load_samples` | `is_sample = TRUE` |
| Run cases | `judge/runs.rs::load_cases` | `is_sample = TRUE` |
| Judging | `judge/submissions.rs::load_tests` | none — this is the judge |
| Admin management | `routes/admin.rs` | none — `AdminUser` required |

Structural defences, not just careful coding:

* `submission_results` stores a `test_case_id` **reference** and never copies
  the input or expected output, so a leak cannot happen through that table.
* `TestResultDto` has no field that could carry test data, and a unit test
  asserts its serialised keys.
* `Sample` (the public DTO) has exactly three fields, all of which are already
  public by definition.
* Integration tests plant recognisable markers in hidden cases and assert they
  appear in no public response body, for every seeded problem.

---

## Authentication and authorisation

* **Passwords**: Argon2id, per-password salt, hash only. Verified on a blocking
  thread so the async runtime is not stalled.
* **Access token**: 15-minute HS256 JWT, `Authorization: Bearer`, held in memory
  by the SPA.
* **Refresh token**: random 256-bit opaque value; only its SHA-256 is stored.
  Rotated on every use — the old one is revoked in the same atomic `UPDATE`, so
  a replayed token fails.
* **Login**: generic errors and a dummy hash verification for unknown emails, so
  neither the message nor the timing reveals whether an account exists.
* **Admin role**: re-read from the database on *every* admin request. A demoted
  account loses access immediately instead of when its token expires.
* **Ownership**: a submission or run belonging to someone else returns `404`,
  not `403`, so the endpoints cannot be used to enumerate other users' activity.
* **Source code** is returned only to its author (or an admin), and never in a
  list response.

Known trade-off: the refresh token lives in `localStorage`, which an injected
script could read. React escapes output and Markdown is rendered without raw
HTML, but for stronger guarantees move it to an `HttpOnly; SameSite` cookie.

---

## Input bounds

Every one of these is enforced server-side and configurable:

| Input | Bound |
| --- | --- |
| `source_code` | `MAX_SOURCE_BYTES` (64 KiB) |
| `stdin` | `MAX_INPUT_BYTES` (64 KiB) |
| Captured output | `MAX_OUTPUT_BYTES` (64 KiB), then truncated and flagged |
| Problem time limit | clamped to `MAX_TIME_LIMIT_MS` |
| Problem memory limit | clamped to `MAX_MEMORY_LIMIT_MB` |
| List `limit` | 1–50, rejected rather than silently clamped |
| List `page` | 1–100 000, so `OFFSET` cannot overflow |
| Search text | 100 characters, `%` and `_` escaped for `LIKE` |
| Admin problem text | 100 000 bytes; slug is `[a-z0-9-]`, no `--` |
| Admin test data | 1 MB per input and per expected output |
| Tags | ≤ 10 per problem, `[a-z0-9-]{1,40}` |

All SQL goes through SQLx bind parameters or `QueryBuilder::push_bind`; no query
is built by string interpolation of user input.

---

## Rate limits

Keyed on the **authenticated user id** for `POST /runs` and
`POST /submissions`, and on the **client address** for `POST /auth/login` and
`POST /auth/register` — never on anything the client can choose.
`X-Forwarded-For` is read only when `TRUSTED_PROXY_HOPS > 0`, and then only the
entry a trusted proxy actually appended, so prepending addresses cannot buy
extra requests. A test asserts exactly that.

The login limit applies to the endpoint rather than to failures, so it cannot be
used to probe which credentials are correct.

With Redis unavailable, limits fall back to an in-process counter: weaker
(per-instance rather than global) but still bounding a single attacker, and it
fails on the limit rather than opening the endpoint.

---

## Secrets and logging

* `JWT_SECRET` must be ≥ 32 characters; the process refuses to start otherwise.
* Internal error details — database messages, runner failures — are logged and
  replaced with a generic message in the response. `AppError::Internal` carries
  the detail, and `IntoResponse` drops it.
* `submissions.internal_error` and `runs.internal_error` hold operator detail
  and are returned by **no** endpoint; the user gets "the judge could not finish
  this submission".
* Correlation ids from clients are validated to short printable ASCII before
  they reach a log line, so a header cannot forge log structure.
* No password, hash or full token is ever logged.

---

## Container privileges, reviewed

| Container | User | Capabilities | Filesystem | Socket |
| --- | --- | --- | --- | --- |
| `api` | 10001 | default | normal | none |
| `worker` | 0 → 65534 per run | **ALL dropped** | read-only + tmpfs | none |
| `worker-docker` | 0 | default | normal | **docker.sock** |
| sandbox container | 65534 | ALL dropped | read-only + tmpfs | none |
| `postgres`, `redis`, `kafka` | image default | default | volume | none |

The default stack mounts no Docker socket at all. If you enable
`--profile docker-runner`, accept that the worker is then host-root-equivalent.

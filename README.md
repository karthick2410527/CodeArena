# CodeArena

A LeetCode-style practice platform with a real asynchronous online judge.
Browse problems, write C++17 in a browser editor, run your code against the
public samples or your own input, submit it against hidden tests, and watch the
verdict arrive.

```
codearena/
├── docker-compose.yml   PostgreSQL · Redis · Kafka · API · worker · web
├── Makefile             make help
├── backend/             Rust · Axum · SQLx · the sandbox and the judge
│   ├── migrations/      0001 … 0006, applied automatically on API start
│   ├── src/             see "How it is put together" below
│   └── docker/          api / worker / runner images
├── frontend/            React · Vite · TypeScript · Tailwind · Monaco
├── scripts/loadtest.sh  a modest, repeatable load test
└── docs/                API, architecture, security, observability, load test
```

| Doc | What is in it |
| --- | --- |
| [docs/API.md](docs/API.md) | Every endpoint, with status codes and error shapes |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How a submission travels, and the reliability contract |
| [docs/SECURITY.md](docs/SECURITY.md) | What the sandbox does and does **not** guarantee |
| [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) | Metrics, logs, health, rate limits, Redis |
| [docs/LOADTEST.md](docs/LOADTEST.md) | Measured results and what they mean |
| [docs/PHASES.md](docs/PHASES.md) | What each of the five phases delivered |

---

## Run it

### Everything in Docker

```bash
cd codearena
export JWT_SECRET=$(openssl rand -hex 32)
make up          # or: docker compose up -d --build --wait
```

Then open **http://localhost:5173**, sign up, pick a problem and submit.

`make up` starts PostgreSQL, Redis, a single-node Kafka (KRaft, no ZooKeeper),
the API, one judge worker and the web client. Migrations and the seeded problem
catalogue are applied on API start.

```bash
make logs        # follow the API and worker
make ps          # service status
make down        # stop (keeps data);  make reset  destroys it
```

### On the host, with services in Docker

Needs Rust ≥ 1.82, Node ≥ 18, and (for the compiler the worker shells out to)
`g++` with C++17 support.

```bash
make infra                                 # PostgreSQL + Redis + Kafka

cd backend && cp .env.example .env         # set JWT_SECRET
cargo run --bin codearena-api              # :8080 — applies migrations

# in another terminal — the only process that executes submitted code
cd backend && cargo run --bin codearena-worker

# and another
cd frontend && npm install && npm run dev  # :5173
```

Without Kafka, set `QUEUE_DRIVER=postgres` and skip the broker entirely; see
[Queue drivers](#queue-drivers).

### Building without Kafka

The `kafka` feature compiles librdkafka from source, which needs `cmake`,
`libssl-dev`, `libsasl2-dev`, `libcurl4-openssl-dev` and `zlib1g-dev`. If you
would rather not install those:

```bash
cd backend && cargo build --no-default-features    # PostgreSQL queue only
```

---

## Tests

```bash
make db                       # PostgreSQL; each test gets its own database
make test                     # backend + frontend
make check                    # fmt, clippy, typecheck, tests, production build
```

| Suite | Count | What it covers |
| --- | --- | --- |
| `backend --lib` | 117 | Verdict transitions, output comparison, sandbox classification, rate limiting, pagination, metrics |
| `backend --test runner` | 15 | **Real `g++`**: time limit kills the process, memory limit, segfault, privilege drop, no network, output truncation |
| `backend --test judge` | 30 | API → outbox → worker → sandbox → verdict, duplicate delivery, bounded retries, crash recovery, no hidden-test leakage |
| `backend --test api` | 15 | Auth, problems, hidden-data exposure |
| `backend --test admin` | 18 | Authorisation, admin CRUD, rate limits, metrics, dead letters |
| `frontend` | 65 | Editor, Run/Submit polling, history, statistics, admin forms, confirmations |

The runner and judge suites skip themselves with a printed note when no C++
compiler is on `PATH`.

---

## How it is put together

```
browser ──► API (Axum)                     ──► PostgreSQL   source of truth
                │  writes submission + outbox row in ONE transaction
                ▼
            Kafka topic  (or the outbox table itself)
                │
                ▼
            worker ──► restricted sandbox ──► PostgreSQL   verdict + per-test rows
                                                  ▲
browser ──► API  polls GET /submissions/{id} ─────┘
```

Three binaries:

| Binary | Job |
| --- | --- |
| `codearena-api` | Validates, authorises, rate limits, persists. Holds **no** runner, so it cannot execute submitted code even by accident. |
| `codearena-worker` | Consumes jobs, compiles and executes in a sandbox, writes verdicts. The only process that runs untrusted code. |
| `codearena-dlq` | Operator tool: inspect and replay dead-lettered jobs. |

Backend modules: `routes` (HTTP), `judge` (verdicts, comparison, the two
pipelines), `runner` (sandboxing, language registry), `queue` (outbox, Kafka and
PostgreSQL drivers), `cache` and `ratelimit` (Redis), `observability` (tracing,
correlation IDs, metrics), `worker` (the loops).

### The dual-write problem

A PostgreSQL commit and a Kafka publish are not atomic. CodeArena does not
pretend otherwise: `POST /submissions` writes the submission row **and** an
`outbox_events` row in one transaction, and delivery is a separate retryable
step. Nothing is lost because a broker was briefly unreachable.

Delivery is therefore *at-least-once*, so the judge is idempotent: claiming a
submission is a guarded `UPDATE … WHERE status <> 'FINISHED'`, a finished
submission is never re-judged, and per-test rows upsert.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the full contract.

### Queue drivers

| `QUEUE_DRIVER` | What it does | When |
| --- | --- | --- |
| `kafka` (default) | Real consumer group, manual offset commits after the verdict is persisted, dead-letter topic. The outbox publisher moves committed rows to the topic. | The compose stack; anything multi-machine |
| `postgres` | The outbox table *is* the queue, claimed with a visibility timeout. Same at-least-once semantics, no extra infrastructure. | Development, CI, single-machine installs |

Both are exercised by the same worker code; only the transport differs.

### Sandbox strategies

| `RUNNER_STRATEGY` | Isolation | When |
| --- | --- | --- |
| `docker` | A throw-away container per execution: no network, read-only root, `--cap-drop ALL`, non-root, bounded pids/memory/CPU. | Recommended default |
| `local` | A child process of the worker with POSIX rlimits applied between `fork` and `exec`, a dropped uid and a private network namespace where the kernel allows it. | Development and CI |
| `disabled` | Refuses to execute anything. | The API process, and tests |

**Neither is a complete boundary against hostile multi-tenant code.** Read
[docs/SECURITY.md](docs/SECURITY.md) before exposing this to strangers.

---

## Configuration

`backend/.env` (see `backend/.env.example`). Only the first two are required.

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | – | `postgres://codearena:codearena@localhost:5432/codearena` |
| `JWT_SECRET` | – | ≥ 32 chars. `openssl rand -hex 32` |
| `BIND_ADDR` | `0.0.0.0:8080` | |
| `CORS_ORIGIN` | `http://localhost:5173` | Only needed for cross-origin browsers |
| `ACCESS_TOKEN_TTL_SECS` | `900` | |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | |
| **Execution** | | |
| `RUNNER_STRATEGY` | `docker` | `docker`, `local` or `disabled` |
| `RUNNER_IMAGE` | `codearena-runner:cpp17` | Server-side only; clients can never choose |
| `RUNNER_WORKDIR` | `/tmp/codearena` | Where sandboxes are created |
| `RUNNER_UID` / `RUNNER_GID` | `65534` when root | Empty disables dropping |
| `RUNNER_CONCURRENCY` | `4` | Concurrent sandboxes in one process |
| `MAX_SOURCE_BYTES` | `65536` | |
| `MAX_INPUT_BYTES` | `65536` | |
| `MAX_OUTPUT_BYTES` | `65536` | Captured per execution, then truncated |
| `COMPILE_TIMEOUT_SECS` | `15` | |
| `MAX_TIME_LIMIT_MS` | `10000` | Ceiling a problem may ask for |
| `MAX_MEMORY_LIMIT_MB` | `512` | Ceiling a problem may ask for |
| `RUN_RETENTION_HOURS` | `24` | Runs are ephemeral working state |
| **Queue** | | |
| `QUEUE_DRIVER` | `kafka` | `kafka` or `postgres` |
| `KAFKA_BROKERS` | `localhost:9092` | |
| `KAFKA_TOPIC` | `codearena.submissions` | |
| `KAFKA_DLQ_TOPIC` | `codearena.submissions.dlq` | |
| `KAFKA_GROUP_ID` | `codearena-judge` | |
| `WORKER_ID` | hostname + pid | Heartbeat identity |
| `WORKER_CONCURRENCY` | `2` | Submissions judged at once |
| `MAX_JUDGE_ATTEMPTS` | `3` | Then dead-lettered with `INTERNAL_ERROR` |
| `JUDGE_RETRY_BASE_MS` | `500` | Exponential backoff, capped at 60s |
| `CLAIM_TIMEOUT_SECS` | `120` | A claim older than this is recovered |
| `QUEUE_POLL_INTERVAL_MS` | `500` | |
| **Redis, limits, logs** | | |
| `REDIS_URL` | *(empty)* | Empty disables caching; limits fall back in-process |
| `PROBLEM_CACHE_TTL_SECS` | `60` | |
| `RATE_LIMIT_ENABLED` | `true` | |
| `RATE_LIMIT_LOGIN` | `10/60` | `requests/seconds`, per client address |
| `RATE_LIMIT_REGISTER` | `5/3600` | Per client address |
| `RATE_LIMIT_RUN` | `20/60` | Per user |
| `RATE_LIMIT_SUBMIT` | `10/60` | Per user |
| `TRUSTED_PROXY_HOPS` | `0` | Proxies in front; `0` ignores `X-Forwarded-For` |
| `METRICS_ENABLED` | `true` | |
| `LOG_FORMAT_JSON` | `false` | |

Frontend (`frontend/.env`, optional): `VITE_API_PROXY_TARGET` for the dev
proxy, `VITE_API_BASE_URL` for a production build served from another origin.

---

## Operating it

```bash
curl localhost:8080/api/v1/health     # liveness
curl localhost:8080/api/v1/ready      # dependencies, drivers, limiter mode
curl localhost:8080/api/v1/metrics    # Prometheus text
```

Worker liveness, queue lag and dead-lettered jobs are at **Judge** in the admin
navigation (`/admin/ops`), or over the API at `GET /api/v1/admin/workers` and
`GET /api/v1/admin/dead-letters`. From a shell:

```bash
cd backend
cargo run --bin codearena-dlq -- list
cargo run --bin codearena-dlq -- show 7
cargo run --bin codearena-dlq -- replay 7
```

To make an administrator, promote the account in the database and log in again
so the new role is in the token:

```sql
UPDATE users SET role = 'ADMIN' WHERE username = 'you';
```

Every request carries an `X-Correlation-Id`, echoed on the response and stored
on the submission, so one id follows a submission through the API log, the queue
and the worker log. See [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

---

## Known limitations

* **C++17 only.** The language registry (`backend/src/runner/language.rs`) is
  the single place to add another, and nothing about a language is client-supplied.
* **Output comparison is exact after whitespace normalisation.** No
  tolerance-based checking, so floating-point problems need a custom checker
  that is not implemented.
* **Judging stops at the first failing test.** Verdict and failing position are
  reported; later tests are not executed.
* **Memory is not measured under `RUNNER_STRATEGY=docker`** — the container is
  removed before per-process accounting can be read back, so a memory limit is
  detected via the kernel's OOM flag but `memory_bytes` is `null`. The `local`
  strategy reports peak RSS from `wait4`.
* **The sandbox is not hardened against a determined attacker.** No seccomp
  profile, no gVisor/Firecracker, no per-user cgroup accounting.
  [docs/SECURITY.md](docs/SECURITY.md) is explicit about this.
* **Polling, not push.** No SSE or WebSockets; the specification allows this and
  polling is correct first.
* **Single-node Kafka in compose**, replication factor 1. Fine locally, not a
  durable production topology.

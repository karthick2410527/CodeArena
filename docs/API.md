# API

Base path `/api/v1`. JSON in, JSON out.

Errors always have the same shape, so a client can handle them in one place:

```json
{ "error": { "code": "BAD_REQUEST", "message": "limit must be between 1 and 50" } }
```

| Code | Status | Meaning |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | Validation failed; `message` says what |
| `UNAUTHORIZED` | 401 | Missing, malformed or expired token |
| `FORBIDDEN` | 403 | Authenticated, but not allowed |
| `NOT_FOUND` | 404 | Does not exist, **or** is not yours |
| `CONFLICT` | 409 | Would violate uniqueness or an invariant |
| `RATE_LIMITED` | 429 | Too many requests; carries `Retry-After` |
| `UNAVAILABLE` | 503 | A dependency is unavailable; retry |
| `INTERNAL` | 500 | Logged with detail; the response stays generic |

Authentication is `Authorization: Bearer <access token>`.

Every response carries `X-Correlation-Id`. Send your own (≤ 64 chars,
`[A-Za-z0-9_-]`) to tie your logs to the server's.

---

## Authentication

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/auth/register` | – | `{username, email, password}` → `201` + tokens. `409` if taken. Rate limited per address |
| POST | `/auth/login` | – | `{email, password}` → tokens. `401` generic. Rate limited per address |
| POST | `/auth/refresh` | – | `{refresh_token}` → new pair; the old token is revoked |
| POST | `/auth/logout` | – | `{refresh_token}` → `204`. Idempotent |
| GET | `/users/me` | Bearer | Current user |
| GET | `/users/me/stats` | Bearer | Solved counts, acceptance rate, verdict histogram |

Username: 3–32 of `[A-Za-z0-9_-]`. Password: 8–128 characters.

```json
// 200 /auth/login
{
  "access_token": "eyJ…",
  "refresh_token": "9f2c…",
  "token_type": "Bearer",
  "expires_in": 900,
  "user": { "id": "…", "username": "ada", "email": "ada@example.com",
            "role": "USER", "created_at": "2026-01-02T03:04:05Z" }
}
```

```json
// 200 /users/me/stats
{
  "total_submissions": 4, "accepted_submissions": 2,
  "problems_solved": 2, "problems_available": 10,
  "solved_easy": 2, "solved_medium": 0, "solved_hard": 0,
  "available_easy": 4, "available_medium": 4, "available_hard": 2,
  "acceptance_rate": 50.0,
  "last_submission_at": "2026-01-02T03:04:05Z",
  "verdict_counts": { "ACCEPTED": 2, "WRONG_ANSWER": 2 }
}
```

---

## Problems

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/problems` | – | Paginated and filterable |
| GET | `/problems/{slug}` | – | Statement, limits and **public samples only** |
| GET | `/problems/{slug}/samples` | – | Public samples only |
| GET | `/tags` | – | Tags with published-problem counts |

`GET /problems?page=1&limit=20&difficulty=MEDIUM&tag=graphs&q=sum`

| Parameter | Rules |
| --- | --- |
| `page` | ≥ 1, ≤ 100 000. Default 1 |
| `limit` | 1–50. Default 20. Out of range is **rejected**, not clamped |
| `difficulty` | `EASY`, `MEDIUM` or `HARD`, case-insensitive |
| `tag` | Exact tag name, case-insensitive |
| `q` | Title substring, ≤ 100 chars; `%` and `_` are literal |

Unpublished problems return `404` and never appear in the list.

```json
// 200 /problems
{
  "items": [{ "number": 1, "slug": "a-plus-b", "title": "A Plus B",
               "difficulty": "EASY", "time_limit_ms": 1000,
               "memory_limit_mb": 256, "tags": ["implementation", "math"] }],
  "page": 1, "limit": 20, "total": 10, "total_pages": 1
}
```

`GET /problems/{slug}` adds `description`, `constraints` and `samples`
(`{input, expected_output, explanation}`). Hidden test data is never included —
the response type has no field that could carry it.

---

## Editor metadata

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/languages` | – | Accepted languages, Monaco id and starter code |
| GET | `/limits` | – | `max_source_bytes`, `max_input_bytes`, `max_output_bytes` |

```json
// 200 /languages
[{ "id": "cpp17", "display_name": "C++17 (GCC)", "monaco_id": "cpp",
   "starter_code": "#include <bits/stdc++.h>\n…" }]
```

Compiler commands are never exposed. A client sends a language *id*; everything
else is server-side.

---

## Runs — your own code against samples or your own input

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/runs` | Bearer | `202` + `run_id`. Rate limited per user |
| GET | `/runs/{id}` | Bearer | Status and output. Yours only |

```json
// POST /runs
{ "problem_id": "a-plus-b", "language": "cpp17",
  "source_code": "#include <bits/stdc++.h>\nint main(){…}",
  "mode": "samples",            // "samples" (default) or "custom"
  "stdin": ""                   // only with mode "custom"
}
// 202
{ "run_id": "9b1c…", "status": "QUEUED" }
```

Validation: unknown language → `400`; empty or oversized `source_code` → `400`;
unknown or unpublished problem → `404`; `stdin` with `mode: "samples"` → `400`;
a problem with no public samples and `mode: "samples"` → `400`.

### `GET /runs/{id}?wait_ms=8000`

`wait_ms` (≤ 15 000) holds the response open until the run reaches a terminal
state. One request usually returns the finished result, which is what makes the
editor's Run button feel immediate. The API is waiting on a database row, not on
a compiler, so it stays responsive throughout.

```json
// 200
{
  "run_id": "9b1c…", "problem_slug": "a-plus-b", "language": "cpp17",
  "mode": "SAMPLES", "status": "FINISHED", "outcome": "OK",
  "compile_output": "", "compile_time_ms": 118,
  "cases": [{
    "position": 1, "label": "Sample 1",
    "input": "3 5", "expected_output": "8",
    "stdout": "8\n", "stderr": "",
    "stdout_truncated": false, "stderr_truncated": false,
    "exec_status": "OK", "passed": true,
    "time_ms": 4, "memory_bytes": 1048576, "exit_code": 0, "signal": null
  }],
  "created_at": "…", "finished_at": "…", "message": null
}
```

`outcome`: `OK`, `COMPILATION_ERROR`, `RUNTIME_ERROR`, `TIME_LIMIT_EXCEEDED`,
`MEMORY_LIMIT_EXCEEDED`, `OUTPUT_LIMIT_EXCEEDED`, `INTERNAL_ERROR`.
`exec_status`: `OK`, `NON_ZERO_EXIT`, `SIGNALLED`, `TIME_LIMIT`,
`MEMORY_LIMIT`, `OUTPUT_LIMIT`.

With `mode: "custom"`, `expected_output` and `passed` are `null`: there is
nothing to compare against, so no claim is made. **A run never touches hidden
tests.**

Runs expire after `RUN_RETENTION_HOURS` (24 by default) and are then `404`.

---

## Submissions — judged against hidden tests

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/submissions` | Bearer | `202` + `submission_id`. Rate limited per user |
| GET | `/submissions` | Bearer | Your history, paginated and filterable |
| GET | `/submissions/{id}` | Bearer | Status, verdict, metrics, your code |
| GET | `/submissions/{id}/test-results` | Bearer | Per-test summary |

```json
// POST /submissions
{ "problem_id": "two-sum", "language": "cpp17",
  "source_code": "#include <iostream>\nint main() { return 0; }" }

// 202 Accepted
{ "submission_id": "7c38dd87-…", "status": "QUEUED" }
```

This returns **before** judging starts. Poll `GET /submissions/{id}` until
`status` is terminal. A problem with no test cases returns `503`, because it
cannot be judged.

### `status`

One flattened field: the lifecycle state until judging ends, then the verdict.

| Value | Terminal | Meaning |
| --- | --- | --- |
| `QUEUED` | no | Persisted, waiting for a worker |
| `RUNNING` | no | A worker has claimed it |
| `ACCEPTED` | yes | All tests passed |
| `WRONG_ANSWER` | yes | Output did not match |
| `COMPILATION_ERROR` | yes | Did not compile; no test was executed |
| `RUNTIME_ERROR` | yes | Crashed or exited non-zero |
| `TIME_LIMIT_EXCEEDED` | yes | Exceeded the time limit |
| `MEMORY_LIMIT_EXCEEDED` | yes | Exceeded the memory limit |
| `INTERNAL_ERROR` | yes | The judge failed after its retry budget |

`verdict` is the same terminal value, or `null` while still judging. A
terminal `status` always has a verdict — a database `CHECK` enforces it.

```json
// 200 /submissions/{id}
{
  "submission_id": "7c38dd87-…", "username": "ada",
  "problem_slug": "a-plus-b", "problem_title": "A Plus B",
  "language": "cpp17",
  "status": "WRONG_ANSWER", "verdict": "WRONG_ANSWER",
  "passed_tests": 1, "total_tests": 6,
  "score": 0, "max_score": 4,
  "failed_case_position": 2,
  "execution_time_ms": 7, "memory_bytes": 2097152,
  "created_at": "…", "finished_at": "…",
  "source_code": "…",        // owner (or admin) only
  "compile_output": "",      // owner (or admin) only
  "message": "Your output did not match the expected output."
}
```

`source_code` and `compile_output` are **omitted entirely** for anyone else, and
never present in a list response. Someone else's submission is `404`, not `403`,
so these endpoints cannot be used to discover other users' activity.

### `GET /submissions?page=1&limit=20&problem=a-plus-b&verdict=ACCEPTED&language=cpp17`

`verdict` accepts any terminal verdict plus `QUEUED` and `RUNNING`. Unknown
values are `400`. `user=<username>` is accepted **for administrators only**;
anyone else gets `403`.

### `GET /submissions/{id}/test-results`

```json
{
  "submission_id": "7c38dd87-…",
  "status": "WRONG_ANSWER", "verdict": "WRONG_ANSWER",
  "passed_tests": 1, "total_tests": 6,
  "results": [
    { "position": 1, "is_sample": true,  "verdict": "ACCEPTED",
      "execution_time_ms": 3, "memory_bytes": 1024, "points_awarded": 0 },
    { "position": 2, "is_sample": false, "verdict": "WRONG_ANSWER",
      "execution_time_ms": 4, "memory_bytes": 1024, "points_awarded": 0 }
  ]
}
```

Verdict, timing and memory per test — never the input, the expected output or
your program's output for a hidden case. The response type has no field for
them, and a unit test asserts its exact set of keys.

Judging stops at the first failing test, so `results` can be shorter than
`total_tests`.

---

## Admin

Every endpoint requires `role = "ADMIN"`, re-read from the database on each
request — a demoted account loses access immediately rather than when its
token expires. Non-admins get `403`, anonymous callers `401`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/problems` | All problems, published or not. `?published=true\|false&q=&page=&limit=` |
| GET | `/admin/problems/{id}` | One problem with test counts |
| POST | `/admin/problems` | Create. `201`. Unpublished unless `published: true` |
| PATCH | `/admin/problems/{id}` | Partial update; omitted fields are untouched |
| GET | `/admin/problems/{id}/test-cases` | **Includes hidden data.** Admin only |
| POST | `/admin/problems/{id}/test-cases` | Create. `201` |
| PATCH | `/admin/test-cases/{id}` | Update |
| DELETE | `/admin/test-cases/{id}` | `204` |
| GET | `/admin/workers` | Worker liveness, queue lag, dead-letter count |
| GET | `/admin/dead-letters` | Failed jobs. `?include_resolved=true` |
| POST | `/admin/dead-letters/{id}/replay` | Re-queue with a fresh attempt budget |

```json
// POST /admin/problems
{ "slug": "two-sum", "title": "Two Sum",
  "description": "…markdown…", "constraints": "…markdown…",
  "difficulty": "easy",                 // normalised to EASY
  "time_limit_ms": 1000, "memory_limit_mb": 256,
  "published": false, "tags": ["arrays", "Hash-Map"] }
```

Validation: slug is `[a-z0-9-]`, no leading/trailing hyphen and no `--`;
`time_limit_ms` 100–`MAX_TIME_LIMIT_MS`; `memory_limit_mb`
16–`MAX_MEMORY_LIMIT_MB`; ≤ 10 tags of `[a-z0-9-]{1,40}`; duplicate slug `409`.

Two invariants are enforced rather than left to the operator:

* **Publishing needs at least one hidden test case** — otherwise users could
  submit to something that cannot be judged (`400`).
* **A published problem must keep one hidden test case**, so deleting the last
  one is `409` until the problem is unpublished.

Any admin write invalidates the public problem cache immediately (see
[ARCHITECTURE.md](ARCHITECTURE.md)), so an edit or an unpublish is visible on
the next public read rather than after the TTL.

```json
// POST /admin/problems/{id}/test-cases
{ "input": "3 5", "expected_output": "8",
  "explanation": "3 + 5 = 8.",   // samples only
  "is_sample": true,             // default false
  "points": 0,                   // default 0 for samples, 1 otherwise
  "position": 1 }                // default: append
```

`expected_output` must not be empty; input and expected output are ≤ 1 MB each;
`points` 0–1000; a duplicate `position` is `409`.

```json
// 200 /admin/workers
{
  "workers": [{ "worker_id": "worker-a", "queue_driver": "kafka",
                "runner_strategy": "local", "version": "0.5.0",
                "started_at": "…", "last_seen_at": "…",
                "seconds_since_heartbeat": 0.2, "healthy": true,
                "submissions_judged": 27, "runs_executed": 4, "failures": 0,
                "current_submission_id": null }],
  "queued_submissions": 0, "running_submissions": 0,
  "queue_backlog": 0, "oldest_pending_secs": null,
  "unresolved_dead_letters": 0
}
```

A worker that stops reporting stays listed with `healthy: false`, which is the
signal an operator needs — an absent row would look like nothing is wrong.

---

## Health and metrics

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | – | Liveness only. No dependency checks |
| GET | `/ready` | – | Dependencies and active drivers. `503` when not ready |
| GET | `/metrics` | – | Prometheus text. `404` if `METRICS_ENABLED=false` |

```json
// 200 /ready
{ "status": "ready", "database": true, "redis": true,
  "queue_driver": "kafka", "runner_strategy": "disabled",
  "rate_limiting": "redis" }
```

`/health` deliberately checks nothing, so a Redis hiccup does not make a load
balancer remove a working instance. `/ready` returns `503` only when PostgreSQL
is unreachable; Redis being down is degradation, not unreadiness, and is
reported as `"redis": false`.

The worker serves its **own** `/metrics` and `/health` on `WORKER_METRICS_ADDR`
(`:9090` by default). Verdict counts and judge-duration histograms live there,
because the worker is the process that judges — scrape both.

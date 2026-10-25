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
            "display_name": null, "avatar_url": null, "has_password": true,
            "role": "USER", "created_at": "2026-01-02T03:04:05Z" }
}
```

`email` is `null` for an account created through GitHub when GitHub shared no
verified address; `has_password` is `false` for accounts that only sign in
through a provider.

### Sign in with Google or GitHub

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/auth/providers` | – | `[{id, name, authorize_url}]` for the providers that are configured |
| GET | `/oauth2/authorization/{provider}` | – | **Not under `/api/v1`.** Browser navigation: redirects to the provider |
| POST | `/auth/oauth/exchange` | cookie | `{code}` → tokens. The code comes from `/auth/callback?code=…`, works once, within 60 s, and only with the `vr_login` cookie set on the same browser. `401` otherwise |
| POST | `/auth/oauth/link-intent` | Bearer | `{provider}` → `{authorize_url}`; navigate there to connect that provider to the signed-in account |
| GET | `/users/me/identities` | Bearer | `[{provider, login, email, created_at, last_used_at}]` |
| DELETE | `/users/me/identities/{provider}` | Bearer | `204`. `409 LAST_SIGN_IN_METHOD` if it is the only way left to sign in |

After the provider, the browser lands on the web client's `/auth/callback` with
one of: `code=…` (sign-in), `linked={provider}` (connect), or `error=…`:

| `error` | Meaning |
| --- | --- |
| `email_in_use` | A password account already uses that email. Sign in with the password and connect the provider from the profile |
| `identity_in_use` | That provider account already signs in as another user |
| `provider_conflict` | This account already has a different account at that provider connected |
| `link_expired` | The connect request expired or was started in another browser |
| `access_denied` | Sign-in was cancelled at the provider |
| `provider_error` | The provider failed; try again |

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

## Replays — record a run, then step through it

The editor's **Debug** button. A worker records the program once under a
debugger (every source line single-stepped, the full state saved as keyframes
plus deltas); stepping then only reads the recording, so moving backwards is as
cheap as forwards and the program never runs again. C++17 only for now.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/replays` | Bearer | `202` + `replay_id`. Rate limited per user (`RATE_LIMIT_REPLAY`, 10/60) |
| GET | `/replays/{id}?wait_ms=8000` | Bearer | Status, outline and output. Yours only |
| GET | `/replays/{id}/steps?from=0&count=50` | Bearer | Frames and variables per step, `count` ≤ 200 |

```json
// POST /replays
{ "language": "cpp17", "source_code": "…", "stdin": "3\n",
  "problem_id": "a-plus-b" }          // optional, for the link back
// 202
{ "replay_id": "5d0e…", "status": "QUEUED" }
```

`status` is `QUEUED` → `RECORDING` → `FINISHED`; `wait_ms` (≤ 10 000) holds the
request open as for runs. Once finished:

```json
// 200 GET /replays/{id}
{
  "replay_id": "5d0e…", "status": "FINISHED", "problem_slug": "a-plus-b",
  "language": "cpp17", "source_code": "…", "stdin": "3\n",
  "step_count": 26,
  "termination": { "kind": "EXITED", "exit_code": 0, "detail": "exited with status 0" },
  "compile_output": "", "stdout": "14\n",
  "timeline": [[11, 1], [12, 1], [13, 1], [14, 1], [5, 2], …],
  "created_at": "…", "finished_at": "…", "message": null
}
```

`timeline` is `[line, depth]` for every step, so a client can step over (next
step at the same depth or shallower), step out (next shallower step) and run to
a breakpoint (next step on a marked line) without fetching what is in between.

`termination.kind`: `EXITED`, `CRASHED` (the last step is the faulting line,
stack intact), `STEP_LIMIT` / `TIME_LIMIT` (cut short; the steps are a valid
prefix), `COMPILE_ERROR` (no steps; see `compile_output`), `RECORDER_ERROR`
(no steps; `message` says so, internals are not exposed).

```json
// 200 GET /replays/{id}/steps?from=4&count=1
{ "from": 4, "total": 26, "steps": [{
    "step": 4, "line": 5, "depth": 2, "stdout_length": 0,
    "frames": [
      { "index": 0, "function": "main", "line": 14, "variables": [
          { "name": "i", "value": "1", "type": "int", "changed": false },
          { "name": "v", "value": "size=0", "type": "std::vector<int>", "changed": false } ] },
      { "index": 1, "function": "sq(int)", "line": 5, "variables": [
          { "name": "x", "value": "1", "type": "int", "changed": true } ] }
    ] }] }
```

Frames run from `main` (index 0) to the executing one. Variables are in natural
order with children after their parent (`v`, `v[0]`, `v[1]`, `v[10]`, `p.x`);
`type` is set for top-level variables; `changed` marks what this step set or
brought into scope. `stdout_length` is how much of the replay's `stdout` had
been printed when the step was reached.

Asking for steps before the recording is finished is `409 REPLAY_NOT_READY`.
Recordings expire after `REPLAY_RETENTION` (7 days) and are then `404`.

---

## Studio — write your own problems

The admin problem API (`/admin/problems…`, `/admin/test-cases…`) is also served
at `/studio/…` for every signed-in user. There you see and edit only problems you
own, or that are in a contest you co-author; anything else is `404`. New problems
are owned by their creator and start unpublished. `DELETE /studio/problems/{id}`
works while a problem has no submissions and is in no contest. Problem rows now
carry `owner` and `contests` (slugs).

Community problems reach the practice problemset only through a contest: once a
published contest that uses a problem ends, the problem is open for practice.
Setting `"published": true` is for admins; anyone else gets `403`.

## Contests — host one, or compete

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/contests?phase=upcoming\|running\|past&q=` | – | Published contests; `q` searches titles |
| GET | `/contests/mine` | Bearer | Contests you author, drafts included |
| GET | `/contests/joined` | Bearer | Contests you registered for, newest first: `[{contest, rank, ranked, solved, score}]` (`rank` is null before the start or a first submission) |
| POST | `/contests` | Bearer | `{title, starts_at, duration_minutes, format?, description?, slug?}`; a draft you own. 20/hour |
| GET | `/contests/{slug}` | – | Summary, description, problems (hidden before the start except to authors) |
| PATCH | `/contests/{slug}` | Author | Before the start anything; after it only title and description |
| POST | `/contests/{slug}/publish` | Author | `{published}`; needs a future start and problems that all have tests |
| DELETE | `/contests/{slug}` | Owner | Not once a published contest has started |
| POST / DELETE | `/contests/{slug}/authors[/{username}]` | Owner | Add or remove co-authors (an author may remove themselves) |
| PUT | `/contests/{slug}/problems` | Author | `[{problem_id, points?}]` in order → A, B, C…; only problems you may edit |
| POST / DELETE | `/contests/{slug}/registration` | Bearer | Register until the end (late registration); withdraw before the start |
| GET | `/contests/{slug}/problems/{label}` | – | Statement and samples once started |
| POST | `/contests/{slug}/submissions` | Bearer | `{label, language, source_code}` → `in_contest` |
| GET | `/contests/{slug}/submissions` | Bearer | Yours to its problems |
| GET | `/contests/{slug}/standings` | – | Computed from the database on every request |
| GET | `/contests/{slug}/live` | – | Server-Sent Events: `standings` on every queued or judged contest submission |
| GET | `/contests/{slug}/editorial` | – | `{intro, problems: [{label, slug, title, editorial}], is_public}`; authors any time, everyone after the end (else `409 EDITORIAL_NOT_YET`) |
| PUT | `/contests/{slug}/editorial` | Author | `{intro?, problems?: {"A": "markdown", …}}`, any time |

`format`: `CODEFORCES` (points decay 2 per minute per 500 and 50 per wrong try,
never below 30%), `ICPC` (solved, then penalty minutes + 20 per wrong try),
`ATCODER` (points, then last solve + 5 minutes per wrong try), `IOI` (best partial
score per problem). Compile errors and judge failures are never penalties; ties
share a rank. A submission counts for the standings only while the contest runs
and you are registered; authors' and later submissions are practice. A contest's
problems are hidden from practice until it ends, then join it.

## Billing — Host plans (Razorpay)

Practising and competing are free. Publishing a contest needs an active Host
plan (`POST /contests/{slug}/publish` answers `402 HOST_PLAN_REQUIRED`
otherwise); drafts are free to set up, and admins host without a plan. A plan is
bought as a one-off Razorpay order that adds its days to the current end. When
the server has no Razorpay keys, billing is off and anyone may host.

| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/billing/plans` | — | `{enabled, key_id, plans: [{id, name, amount_paise, currency, period_days}]}` |
| GET | `/billing/me` | Bearer | `{enabled, can_host, hosting_until, plan, payments: [...]}` |
| POST | `/billing/orders` | Bearer | `{plan}` → `201 {order_id, amount_paise, currency, key_id, plan, plan_name, name, email}`. The server sets the price. `409 BILLING_DISABLED` without keys |
| POST | `/billing/verify` | Bearer | Checkout's `{razorpay_order_id, razorpay_payment_id, razorpay_signature}`; the HMAC-SHA256 of `order_id\|payment_id` with the key secret must match. Returns `/billing/me` |
| POST | `/billing/webhook` | Razorpay signature | `payment.captured`, `order.paid`, `payment.failed`. `X-Razorpay-Signature` is the HMAC-SHA256 of the raw body with the webhook secret; each `X-Razorpay-Event-Id` is handled once |

A payment confirmed by both `/verify` and the webhook extends the plan once.

## Profiles

`GET /profiles?q=grace&limit=10` (public): people whose username or display name
contains `q`, exact and prefix matches first, with their solved and contest counts.

`GET /profiles/{username}` (public): solved counts by difficulty, acceptance rate,
streaks, a year of daily activity, the ten latest solves, contest history with
rank, and what the user authored. Never an email address, and never a problem
still hidden in a contest.

A practice problem (`GET /problems/{slug}`) carries `editorial`
(`{contest_slug, contest_title, label, text}`) when a finished contest that used
it has a write-up; a running contest's arena never does.

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
| GET | `/metrics` | – | Not served by the Java API yet; arrives with the judge workers |

```json
// 200 /ready
{ "status": "ready", "database": true, "redis": true }
```

`/health` deliberately checks nothing, so a Redis hiccup does not make a load
balancer remove a working instance. `/ready` returns `503` only when PostgreSQL
is unreachable; Redis being down is degradation (the rate limiter fails open),
not unreadiness, and is reported as `"redis": false`. Spring Boot's own
`/actuator/health` is also served, outside `/api/v1`.

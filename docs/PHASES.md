# The five phases

What each phase delivered, and where to look for it. Every acceptance criterion
from the phase documents is listed with the test or file that satisfies it.

---

## Phase 1 — Foundation, auth, database, problems

*Delivered before this build; carried forward unchanged except where later
phases extended it.*

Users, refresh tokens, problems, tags, test cases with the public/hidden split,
Argon2id passwords, rotating refresh tokens, a seeded catalogue of 10 problems
and a responsive React UI.

Migrations `0001_init.sql`, `0002_seed_problems.sql`.
Tests: `backend/tests/api.rs` (15), `frontend/src/test/{auth,problems}.test.tsx`.

Later phases added to it: `/users/me/stats`, Redis caching on the problem
endpoints, rate limits on login and register, and an admin role check that
re-reads the database.

---

## Phase 2 — Editor and the synchronous Run service

| Acceptance criterion | Where |
| --- | --- |
| User opens a problem, writes C++17, clicks Run, sees stdout or a clear error | `frontend/src/components/Workspace.tsx`; `frontend/src/test/workspace.test.tsx` |
| Run does not judge hidden test cases or leak them | `judge/runs.rs::load_cases` (hard `is_sample = TRUE`); `judge.rs::a_run_executes_public_samples_and_never_hidden_tests` |
| Runner timeout terminates the process and returns a terminal state | `runner/local.rs` watchdog; `runner.rs::an_infinite_loop_hits_the_time_limit_and_is_killed` |
| API remains responsive while compiling/running | The API only inserts a row; measured in [LOADTEST.md](LOADTEST.md) (p95 50 ms under judge load) |
| Security restrictions and limitations documented | [SECURITY.md](SECURITY.md) |

**Built:** Monaco with C++17 and local bundling (no CDN), starter code, reset,
drafts that survive a reload; sample/custom input panels; `POST /runs` +
`GET /runs/{id}` with a bounded `wait_ms` long-poll; the `runner` module with
the Docker and local strategies; the server-side language registry;
`migrations/0003_runs.sql`.

Errors are classified into compilation error, runtime error,
timeout/resource limit and internal runner failure — `ExecStatus` →
`RunOutcome`, with the classifier unit-tested for each case.

**Tests:** 15 in `backend/tests/runner.rs` against real `g++` (success,
compile failure, non-zero exit, segfault, timeout, memory limit, output
truncation, oversized input, oversized source, privilege drop, network,
sandbox cleanup); run-service coverage in `backend/tests/judge.rs`; 15 UI tests.

---

## Phase 3 — Asynchronous judge, Kafka and verdicts

| Acceptance criterion | Where |
| --- | --- |
| `POST /submissions` responds before judging and returns a stable id | `judge.rs::submit_responds_before_judging_and_returns_a_stable_id` (asserts < 2 s) |
| Worker transitions and final verdict persist across API restarts | PostgreSQL is the only store; `judge.rs::a_correct_solution_travels_all_the_way_to_an_accepted_verdict` |
| Repeated delivery of the same event does not create conflicting results | `judge.rs::a_duplicate_delivery_does_not_change_the_verdict`, `a_finished_submission_cannot_be_claimed_again` |
| Hidden tests cannot be fetched from public problem or submission APIs | `judge.rs::a_wrong_answer_names_the_failing_test_without_revealing_it`; `api.rs::no_public_endpoint_leaks_hidden_cases` |
| Worker crash results in a recoverable state or a surfaced internal error | `judge.rs::an_abandoned_submission_is_recovered_rather_than_left_silent`, `a_submission_out_of_attempts_is_dead_lettered_with_a_terminal_verdict` |

**Built:** `migrations/0004_submissions.sql` (submissions, submission_results,
outbox_events); `POST /submissions` returning `202`; the queue abstraction with
a real Kafka consumer group (manual offset commits, idempotent producer,
dead-letter topic) and a PostgreSQL visibility-timeout driver; the
`codearena-worker` binary; one compilation per submission; the output
comparison policy; all nine states; `GET /submissions`,
`GET /submissions/{id}`, `GET /submissions/{id}/test-results`; the frontend
submit-and-poll flow.

**The dual-write gap is addressed, not asserted away.** The submission row and
the queue event are written in one transaction; delivery is a separate
retryable step. The contract is in [ARCHITECTURE.md](ARCHITECTURE.md); nothing
in the code or the docs claims the two writes are atomic.

**Tests:** 30 in `backend/tests/judge.rs` — accepted, wrong answer, compile
error, runtime error, time limit, memory limit, whitespace tolerance, duplicate
delivery, bounded attempts, stale-claim recovery, dead-lettering, ownership and
privacy.

---

## Phase 4 — Complete product UX, history and administration

| Acceptance criterion | Where |
| --- | --- |
| Users cannot read another user's source code or private details | `judge.rs::history_is_scoped_to_its_owner`, `source_code_is_private_to_its_author` |
| Non-admins cannot mutate problems or hidden tests | `admin.rs::every_admin_endpoint_refuses_a_normal_user` (11 endpoints × 2 cases) |
| Admin-created problems appear publicly only when published | `admin.rs::an_admin_created_problem_is_public_only_once_published` |
| History and lists are paginated with loading/empty/error states | `routes/pagination.rs`; `submissions.test.tsx`; `admin.rs::admin_lists_are_paginated` |
| Key screens work at desktop and mobile widths | Responsive classes throughout; the problem page is two panes at `xl`, stacked below |

**Built:** submission history with filters in the URL; a submission detail page
with per-test results and the owner's own code read-only; profile statistics
from database queries; `migrations/0005_admin.sql`; admin problem CRUD and
test-case management; admin UI with validation mirroring the server's rules and
a confirmation dialog for deletions; `AdminRoute` in the client and `AdminUser`
on the server.

Two invariants are enforced rather than documented: publishing requires a
hidden test case, and a published problem cannot lose its last one.

Polling was kept; no SSE or WebSockets, which the phase document permits.

**Tests:** 18 in `backend/tests/admin.rs`; 19 UI tests in
`frontend/src/test/admin.test.tsx`; 15 in `submissions.test.tsx`.

---

## Phase 5 — Redis, reliability, observability, final integration

| Acceptance criterion | Where |
| --- | --- |
| Rate limits reject predictably and do not depend on client-provided user IDs | `ratelimit/mod.rs`; `admin.rs::login_is_rate_limited_per_client_address`, `a_forged_forwarded_header_cannot_reset_the_login_limit`, `submitting_is_rate_limited_per_user` |
| Updating a problem invalidates the cache | Generation counter in `cache/mod.rs`; `admin.rs::editing_a_problem_invalidates_the_cached_public_view`; verified live (see below) |
| PostgreSQL remains authoritative for submission results | Nothing writes a verdict to Redis; `AppState` has no path to do so |
| Duplicate messages and worker restarts do not corrupt verdicts | Phase 3 tests, plus `queue::backoff` and `reconcile_stale` |
| Failures are observable; retries bounded; dead letters inspectable | `migrations/0006_reliability.sql`; `admin.rs::dead_letters_can_be_inspected_and_replayed`, `worker_health_reports_queue_lag_and_stale_workers` |
| All runnable checks pass; unrun checks listed explicitly | Below |

**Built:** Redis-backed rate limiting (atomic Lua fixed window) with an
in-process fallback; a problem cache invalidated atomically by a generation
counter; bounded exponential backoff everywhere; `dead_letter_events` with a
replay path in the API, the UI and a CLI; worker heartbeats and queue-lag
visibility; correlation IDs through API → queue → worker → database; a
hand-rolled Prometheus registry on both processes; `/health`, `/ready`,
`/metrics`; the `/admin/ops` console; `scripts/loadtest.sh`.

### Verified live against the running stack

Beyond the automated suite, the following were exercised against a real API,
worker, PostgreSQL and Redis:

* 44 submissions judged end to end; verdicts `ACCEPTED`, `WRONG_ANSWER`,
  `COMPILATION_ERROR` (with real g++ diagnostics) and `RUNTIME_ERROR`.
* Cache: 597 public reads → 594 Redis hits, 3 PostgreSQL misses. An admin
  rename was visible on the very next public read; an unpublish turned the
  public endpoint to `404` immediately.
* Rate limits: `3/60` on login rejected with `429` and `Retry-After: 10`; a
  forged `X-Forwarded-For` did not reset it; `2/60` on submit rejected the third
  submission while a different user was unaffected; rejections appeared in
  `codearena_rate_limit_rejections_total`.
* `GET /admin/workers` reported the live worker with `healthy: true`,
  `submissions_judged: 27`, zero backlog and zero dead letters.
* Both metrics endpoints scraped, including the judge-duration histogram.
* **Two worker processes running concurrently** against the same PostgreSQL
  queue judged 51 submissions in total with zero integrity violations: no
  duplicate `submission_results` rows, no `FINISHED` row without a verdict or
  timestamp, nothing stuck, no attempt count over budget, no dead letters.

### Verified in a real browser

Chromium driving the Vite dev server against the live API — the path the
component tests cannot cover, because they stub Monaco out:

* Monaco mounted as the **real editor** (12 rendered lines, 36 highlighted C++
  tokens), not the textarea fallback. Typing, select-all and reset all worked.
* **Run**: typed a solution, clicked Run, saw `8` for Sample 1 marked *passed*.
* **Submit**: polled to `Accepted — 6 / 6 tests passed`, with none of the
  problem's hidden inputs or expected outputs anywhere in the DOM.
* Submission detail showed 6 per-test rows with exactly the columns
  `TEST, KIND, VERDICT, TIME, MEMORY, POINTS` — no input or expected-output
  column exists.
* History, profile statistics (`problems solved = 1`), and the admin
  navigation **absent** for a normal user with `/admin/problems` refused.
* Admin flow end to end: invalid slug caught client-side before any request;
  problem created as a draft; publishing **refused** until a hidden test case
  existed; public page then showed the sample and none of the hidden data;
  deleting the last hidden test asked for confirmation, could be cancelled, and
  was refused by the server; unpublishing turned the public page to
  "Problem not found" immediately.
* The judge operations console showed both live workers as healthy.
* No horizontal overflow at 390 px on the problem page or the ops console, and
  no unexpected console errors (the only two were the deliberate 400 and 409).

That script is verification, not a shipped test: the repository's own suites are
the 260 listed below.

Measured numbers and their caveats are in [LOADTEST.md](LOADTEST.md).

### Checks that could not run in this environment

Stated plainly rather than glossed over:

| Check | Why not | Exact command |
| --- | --- | --- |
| Kafka driver against a live broker | No Kafka broker could be installed (no package egress). The driver compiles, is wired into compose and shares the worker code; the `postgres` driver was used for the automated and live runs | `docker compose up -d --wait kafka && QUEUE_DRIVER=kafka make test-api` |
| `RUNNER_STRATEGY=docker` against a live daemon | No Docker daemon in this environment. Flag construction and exit-code/OOM classification are unit-tested | `RUNNER_STRATEGY=docker cargo test --test runner` |
| `docker compose build` / `up` | Same | `make up` |
| Multi-worker scaling **with Kafka** | Two workers were verified on the `postgres` driver (see above); consumer-group partition distribution was not | `docker compose up -d --scale worker=3 && make loadtest` |
| Sustained load | The longest run was 21 s. Nothing can be said about memory growth, pool behaviour over hours or Kafka log growth | `scripts/loadtest.sh --submissions 2000` over a longer window |

---

## Test totals

| Suite | Count |
| --- | --- |
| `backend --lib` (unit) | 117 |
| `backend --test runner` (real g++) | 15 |
| `backend --test judge` (end to end) | 30 |
| `backend --test api` | 15 |
| `backend --test admin` | 18 |
| `frontend` | 65 |
| **Total** | **260** |

```bash
make db && make test        # everything
make check                  # fmt, clippy, typecheck, tests, production build
```

# Architecture

## The path a submission takes

```
 1  browser          POST /api/v1/submissions          source + problem slug
                            │
 2  API               validate · authorise · rate limit
                            │
 3  API               ┌─── ONE PostgreSQL transaction ──────────────┐
                      │  INSERT submissions (status = QUEUED)       │
                      │  INSERT outbox_events (submission.created)  │
                      └─────────────────────────────────────────────┘
                            │
 4  API               202 Accepted { submission_id, status: "QUEUED" }
                            │
 5  publisher         outbox row ──► Kafka topic        (kafka driver)
    or: the outbox row IS the queue entry               (postgres driver)
                            │
 6  worker            claim: UPDATE … WHERE status <> 'FINISHED'
                            │                            AND attempts < max
 7  worker            compile once in a sandbox
                            │
 8  worker            execute each test case, compare output
                            │
 9  worker            ┌─── ONE PostgreSQL transaction ──────────────┐
                      │  UPDATE submissions SET verdict, FINISHED   │
                      │  UPSERT submission_results (one per test)   │
                      └─────────────────────────────────────────────┘
                            │
10  worker            acknowledge the message (commit the offset)
                            │
11  browser           GET /api/v1/submissions/{id} ──► terminal verdict
```

Steps 3 and 9 are each a single transaction. That is the whole reliability
story: the facts that matter are committed atomically, and everything between
them is retryable.

---

## The dual-write problem

A PostgreSQL commit and a Kafka publish cannot be made atomic. Doing them in
sequence has two failure modes:

* commit, then crash before publishing → a submission that no worker will ever
  see, stuck at `QUEUED` forever;
* publish, then crash before committing → a job referring to a submission that
  does not exist.

### What CodeArena does

A **transactional outbox**. Step 3 writes the submission row and the queue
event in the same transaction, so either both exist or neither does. Delivery
becomes a separate, retryable step that cannot lose work:

| Driver | Step 5 | Step 10 |
| --- | --- | --- |
| `kafka` | `outbox::publish_pending` claims pending rows with `FOR UPDATE SKIP LOCKED`, publishes, stamps `published_at`. Failures get bounded exponential backoff. | Kafka offset committed manually, after the verdict is persisted |
| `postgres` | nothing — the row *is* the queue entry | `UPDATE outbox_events SET published_at = now()` |

Both are **at-least-once**. Neither claims exactly-once, because neither can.

### Consequences, and how they are handled

| Consequence | Handling |
| --- | --- |
| A job may be delivered twice | `claim` is a guarded `UPDATE … WHERE status <> 'FINISHED'`; a finished submission is refused with `AlreadyFinished`, the message is acknowledged, nothing is rewritten |
| Two workers may race on the same job | Exactly one `UPDATE` matches; the loser gets a rejection |
| Per-test rows may be written twice | `ON CONFLICT (submission_id, test_case_id) DO UPDATE` |
| A worker may die after acknowledging | `outbox::reconcile_stale` re-enqueues submissions unfinished longer than `CLAIM_TIMEOUT_SECS` |
| A worker may die before acknowledging | Kafka reassigns the partition; the PostgreSQL driver's visibility timeout expires |
| A job may be undeliverable forever | `attempts` is bounded by `MAX_JUDGE_ATTEMPTS`; then `dead_letter_events` plus a terminal `INTERNAL_ERROR`, so the user is never left polling |

An integration test exists for each row of that table
(`backend/tests/judge.rs`).

---

## State machine

`submissions.status` is the lifecycle; `submissions.verdict` is the outcome.
The API flattens them into one field for clients, which is the vocabulary the
project specification uses.

```
                    ┌──────────────────────────┐
                    ▼                          │ reconciler: claim expired
   ┌────────┐   claim    ┌─────────┐           │
   │ QUEUED │ ─────────► │ RUNNING │ ──────────┘
   └────────┘            └─────────┘
        │                     │
        │  finish             │  finish
        ▼                     ▼
   ┌──────────────────────────────────┐
   │            FINISHED              │   verdict ∈ { ACCEPTED, WRONG_ANSWER,
   │   terminal — never changes again  │               COMPILATION_ERROR,
   └──────────────────────────────────┘               RUNTIME_ERROR,
                                                      TIME_LIMIT_EXCEEDED,
                                                      MEMORY_LIMIT_EXCEEDED,
                                                      INTERNAL_ERROR }
```

The legal transitions live in one function,
`judge::verdict::JudgeStatus::can_transition_to`, and are mirrored by the SQL
guards. `FINISHED → anything` is false, which is what makes duplicate delivery
harmless.

Clients see: `QUEUED` → `RUNNING` → the verdict. A `FINISHED` row always has a
verdict — a `CHECK` constraint enforces it — so a client that sees a terminal
state always has an answer.

---

## Judging one submission

```
load tests (samples first, then hidden, by position)
   │
compile once  ──► rejected? ──► COMPILATION_ERROR, no tests executed
   │
   ▼
for each test:
   execute in the sandbox with the problem's time and memory limits
   │
   ├─ exec failed  ──► RUNTIME_ERROR / TIME_LIMIT_EXCEEDED / MEMORY_LIMIT_EXCEEDED
   ├─ output differs ──► WRONG_ANSWER
   └─ matches        ──► next test
   │
   └─ stop at the first failure
   ▼
all passed ──► ACCEPTED
```

Compiling once per submission rather than once per test is the single biggest
cost saving: compilation dominates, execution does not. Stopping at the first
failure means a deliberately slow wrong answer cannot occupy a worker for the
sum of every test's time limit.

Samples are judged too, so a program that fails the published example is told
so rather than being failed by a hidden case.

### Output comparison

Whitespace-normalised, then exact (`judge::compare`):

1. `\r\n` and `\r` → `\n`
2. trailing whitespace stripped from each line
3. trailing blank lines stripped from the whole output
4. byte-for-byte equality

Step 4 is deliberate. After normalisation, `1 2` ≠ `12` and `0.5` ≠ `0.50`.
Nothing is rounded or reordered, so the policy cannot accept a wrong answer by
being generous. Floating-point problems would need a custom checker, which is
not implemented.

---

## The Run service

A "run" is a user executing their own code against the public samples or their
own input. It shares the sandbox with the judge but not the queue:

```
POST /runs  ──► INSERT runs (status = QUEUED)  ──► 202 { run_id }
                     │
worker claims it with FOR UPDATE SKIP LOCKED (never Kafka — out of scope for
                     │                        the phase that introduced runs)
compile + execute each case
                     │
                UPDATE runs SET outcome, FINISHED  +  INSERT run_cases
                     │
GET /runs/{id}?wait_ms=8000  ──► held open until terminal, then the output
```

`wait_ms` is why the editor's Run button feels synchronous: one request usually
returns the finished result. The API never blocks on compilation itself — it is
waiting on a database row, not on a compiler — so it stays responsive, which the
load test measures.

Runs are ephemeral: `expires_at` is set on insert and the worker's maintenance
loop purges them. They are working state, not product data.

---

## Processes

| Process | Loops | Notes |
| --- | --- | --- |
| `codearena-api` | HTTP; outbox publisher (kafka driver only) | Holds no `Runner` |
| `codearena-worker` | `WORKER_CONCURRENCY` submission consumers; one run claimer; maintenance; outbox publisher | The only process that executes untrusted code |
| `codearena-dlq` | – | One-shot operator CLI |

The worker's maintenance loop does four things on a timer: refresh its
heartbeat, re-enqueue stale submissions, purge expired runs, and update the
backlog gauges. On shutdown it deletes its heartbeat row, so a stopped worker
looks absent rather than permanently healthy.

### Scaling

```bash
docker compose up -d --scale worker=3
```

Kafka distributes the topic's partitions across the consumer group; the
PostgreSQL driver's `SKIP LOCKED` claim achieves the same without a broker.
Nothing in the worker assumes it is alone — every state change is guarded, which
is what makes adding instances safe rather than merely possible.

---

## Data model

```
users ──┬── refresh_tokens
        ├── runs ──── run_cases
        └── submissions ──── submission_results ──► test_cases (reference only)

problems ──┬── problem_tags ──► tags
           ├── test_cases          is_sample distinguishes public from hidden
           ├── runs
           └── submissions

outbox_events          the queue, and the atomicity mechanism
dead_letter_events     terminal failures, inspectable and replayable
worker_heartbeats      one row per worker process
```

Indexes that exist for a specific query, not on principle:

| Index | Serves |
| --- | --- |
| `submissions (user_id, created_at DESC)` | submission history |
| `submissions (problem_id, created_at DESC)` | per-problem history |
| `submissions (user_id, problem_id) WHERE verdict = 'ACCEPTED'` | solved-problem statistics |
| `submissions (created_at) WHERE status = 'QUEUED'` | the queue claim |
| `submissions (claimed_at) WHERE status = 'RUNNING'` | the reconciler |
| `submission_results (submission_id, position)` | the test-results table |
| `outbox_events (next_attempt_at, id) WHERE published_at IS NULL` | publisher and PostgreSQL driver |
| `test_cases (problem_id, is_sample, position)` | sample loading and judging |
| `problems (slug)` unique | every problem URL |

`submission_results` references `test_case_id` and deliberately stores no test
data, so hidden inputs cannot leak through it even by accident.

---

## Where Redis sits

PostgreSQL is the source of truth. Redis holds two things, both disposable:

* **Problem read cache**, TTL `PROBLEM_CACHE_TTL_SECS`. Keys are namespaced with
  a generation counter; an admin write `INCR`s it, which invalidates every
  cached list and detail atomically — no key scanning, and no stale read after a
  publish or unpublish.
* **Rate-limit counters**, a fixed window applied in one Lua script so the
  `INCR` and the `EXPIRE` cannot interleave.

Submission status and verdicts are **never** cached or stored in Redis. Delete
the Redis volume and the service keeps working: reads go to PostgreSQL, limits
fall back to an in-process counter.

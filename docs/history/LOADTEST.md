# Load test

> **Note.** The numbers below were measured against the earlier Rust implementation. `backend/scripts/loadtest.sh` (`make loadtest`) still runs against the Java API (same endpoints); re-run it to get current figures.

A small, repeatable check that answers two questions:

1. Does the API stay responsive while the judge is busy?
2. How long does a submission actually take, end to end?

It is **not** a capacity benchmark. Two vCPUs judging C++ compilations is not a
throughput story, and no claim is made about production scale.

```bash
backend/scripts/loadtest.sh                               # defaults
backend/scripts/loadtest.sh --submissions 50 --concurrency 8   # heavier
backend/scripts/loadtest.sh --api https://voidrun.example.com # elsewhere
```

Needs only `bash`, `curl` and `python3`. It registers its own throw-away
account per run, so repeated runs do not collide.

### Before you run it

The submit rate limit will otherwise be what you measure. Give the API
headroom for the duration of the test:

```bash
RATE_LIMIT_SUBMIT=10000/60 RATE_LIMIT_LOGIN=10000/60 RATE_LIMIT_REGISTER=10000/60 make api
```

The script says so explicitly if no submission is accepted.

---

## Measured results

Everything below was actually run, not estimated. Two runs are shown because
the second raised concurrency; the judge throughput did not move, which is the
interesting part.

### Environment

| | |
| --- | --- |
| Host | 2 vCPU, 8 GB RAM, Linux 6.18.44 (container) |
| OS | Ubuntu 24.04.5 LTS |
| Build | `cargo build --release`, rustc 1.97.0 |
| PostgreSQL | 16.15, local, on the same host |
| Redis | 7.0.15, local, on the same host |
| Queue driver | `postgres` (no Kafka broker available in this environment) |
| Runner strategy | `local` (no Docker daemon available in this environment) |
| Compiler | g++ 13.3.0, `-std=c++17 -O2 -static` |
| Worker | 1 process, `WORKER_CONCURRENCY=2`, `RUNNER_CONCURRENCY=2` |
| Problem | `a-plus-b`, 6 test cases, 1000 ms / 256 MB |
| Submission | A correct solution, so every verdict is `ACCEPTED` |

Everything — API, worker, PostgreSQL, Redis and the load generator itself —
shared those two vCPUs. The numbers are therefore pessimistic for the API and
realistic for the judge.

### Run 1 — 20 submissions, concurrency 4

```
POST /submissions
  accepted (202)        20/20
  latency ms  p50 58   p95 92   max 99
  wall time             1.31 s   (15.3 accepted/s)

judging
  verdicts persisted    20       (20 ACCEPTED)
  wall time             18.05 s  (1.11 verdicts/s)

GET /problems under judge load
  requests              278
  latency ms  p50 24   p95 55   max 93
```

### Run 2 — 24 submissions, concurrency 6

```
POST /submissions
  accepted (202)        24/24
  latency ms  p50 27   p95 64   max 87
  wall time             0.77 s   (31.2 accepted/s)

judging
  verdicts persisted    24       (24 ACCEPTED)
  wall time             20.78 s  (1.15 verdicts/s)

GET /problems under judge load
  requests              319
  latency ms  p50 23   p95 50   max 81
```

### Judge duration, from the worker's own histogram

Scraped from `http://localhost:9090/metrics` after run 2:

```
codearena_judge_duration_seconds_bucket{le="1.0"}   0
codearena_judge_duration_seconds_bucket{le="2.5"}  24
codearena_judge_duration_seconds_bucket{le="5.0"}  24
codearena_judge_duration_seconds_sum           39.06
codearena_judge_duration_seconds_count            24
```

Mean 1.63 s per submission; every one landed between 1.0 s and 2.5 s.

### Cache, from the API's metrics

```
codearena_cache_events_total{event="hit"}   594
codearena_cache_events_total{event="miss"}    3
```

597 public problem reads, 3 of which touched PostgreSQL.

---

## What the numbers mean

**The API does not block on the judge.** This is the result the test exists
for. While 24 submissions were compiling and executing, `GET /problems` kept a
p95 of 50 ms and `POST /submissions` a p95 of 64 ms. Accepting a submission is
two inserts in one transaction, so it is bounded by the database, not by a
compiler — which is exactly what the asynchronous design is for.

**Submissions are accepted far faster than they are judged**, by roughly 27×
(31 accepted/s versus 1.15 judged/s). That is the queue doing its job: a burst
is absorbed and drained rather than refused. It also means the backlog is the
metric to watch in production, not request latency — see
`codearena_queue_backlog` and `codearena_queue_oldest_pending_seconds`.

**Compilation dominates.** 1.63 s per submission for a six-test problem whose
program does one addition. Compiling once per submission rather than once per
test is therefore the single most valuable optimisation in the pipeline, and it
is what the judge does.

**Raising submit concurrency from 4 to 6 did not raise judge throughput**
(1.11 → 1.15 verdicts/s). With `WORKER_CONCURRENCY=2` on two vCPUs the worker
is CPU-bound in `g++`, so the queue simply grew. More throughput needs more
workers (`docker compose up -d --scale worker=3`) on more cores, not more
client concurrency.

---

## What this test does not tell you

* **Nothing about Kafka.** No broker could be installed in this environment, so
  the `postgres` driver was measured. The Kafka driver shares the worker code
  and differs only in transport; its performance is unmeasured here.
* **Nothing about the Docker runner strategy.** No Docker daemon was available.
  Expect `RUNNER_STRATEGY=docker` to be *slower* per execution — container
  start-up is added to every test case, which is why `wall_clock_grace` gets an
  extra two seconds in that strategy.
* **Nothing about many concurrent users.** One account submitted everything.
  Per-user rate limits were deliberately raised, so contention between users is
  untested.
* **Nothing about large inputs.** `a-plus-b` reads two integers. A problem with
  64 KB of input and heavy output would shift the balance away from compilation.
* **Nothing about sustained load.** The longest run was 21 seconds. No
  conclusion can be drawn about memory growth, connection-pool behaviour over
  hours, or Kafka log growth.
* **Nothing about scaling throughput.** The measured runs used one worker.
  Two workers were later run concurrently against the same PostgreSQL queue
  during browser verification — 51 submissions judged with zero integrity
  violations — which establishes that adding workers is *safe*, but their
  combined throughput was not measured, and Kafka consumer-group distribution
  was not exercised at all.

---

## Re-measuring honestly

1. Record the environment table, not just the numbers. The same script on 8
   dedicated cores with Kafka and the Docker runner will produce different
   figures, and they will not be comparable.
2. Keep the problem fixed. Test count and time limits change judge duration
   directly.
3. Run it at least twice and quote both. The first run pays for cold caches and
   an empty connection pool.
4. Scrape both `/metrics` endpoints — the API's on `:8080` and the worker's on
   `:9090`. Verdict counts and judge duration exist only in the worker, because
   that is the process that judges.
5. Watch `codearena_queue_backlog` during the run. If it keeps climbing after
   submissions stop, you are measuring saturation, not latency.

# Observability and reliability

How to tell what the system is doing, and what happens when part of it breaks.

---

## Two scrape targets, not one

The API and the worker are separate processes with separate in-memory
registries. Judge metrics exist only where judging happens.

| Target | Default | Has |
| --- | --- | --- |
| API | `:8080/api/v1/metrics` | HTTP counters and latency, cache events, rate-limit rejections, queue-backlog gauges, queue publish results |
| Worker | `:9090/metrics` | **Verdict counts, judge duration, run outcomes**, retries, dead letters, worker gauges |

Scraping only the API loses every judge metric. `WORKER_METRICS_ADDR=` disables
the worker endpoint if you do not want it bound.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: codearena-api
    metrics_path: /api/v1/metrics
    static_configs: [{ targets: ["api:8080"] }]
  - job_name: codearena-worker
    static_configs: [{ targets: ["worker:9090"] }]
```

---

## Metrics

### Counters

| Metric | Labels | Where |
| --- | --- | --- |
| `codearena_http_requests_total` | `method`, `route`, `status` | API |
| `codearena_verdicts_total` | `verdict` | worker |
| `codearena_runs_total` | `outcome` | worker |
| `codearena_judge_retries_total` | `reason` (`judge`, `run`, `publish`, `reconcile`) | both |
| `codearena_dead_letters_total` | `reason` | both |
| `codearena_rate_limit_rejections_total` | `scope` (`login`, `register`, `run`, `submit`) | API |
| `codearena_cache_events_total` | `event` (`hit`, `miss`, `error`, `invalidate`) | API |
| `codearena_queue_publish_total` | `driver`, `result` | both |

`route` is the matched **pattern** (`/api/v1/problems/:slug`), never the
concrete path, so requesting a thousand slugs cannot blow up metric
cardinality. A test asserts this.

### Histograms

`codearena_http_request_duration_seconds`, `codearena_judge_duration_seconds`,
`codearena_run_duration_seconds` — 12 buckets from 5 ms to 30 s, straddling
HTTP latency and judge duration.

### Gauges

| Metric | Meaning |
| --- | --- |
| `codearena_submissions_queued` | Waiting for a worker |
| `codearena_submissions_running` | Claimed and being judged |
| `codearena_queue_backlog` | Undelivered queue events |
| `codearena_queue_oldest_pending_seconds` | Age of the oldest undelivered event |
| `codearena_workers_alive` | Heartbeats seen in the last 60 s |
| `codearena_worker_up{worker_id}` | Per-worker liveness |

The API refreshes the first four on scrape; the worker refreshes them on its
maintenance tick.

### What to alert on

| Condition | Why it matters |
| --- | --- |
| `codearena_workers_alive == 0` | Nothing is judging; submissions pile up silently |
| `codearena_queue_oldest_pending_seconds > 300` | The queue is not draining |
| `increase(codearena_dead_letters_total[15m]) > 0` | Jobs are failing terminally and need a human |
| `rate(codearena_verdicts_total{verdict="INTERNAL_ERROR"}[15m])` rising | The judge, not the code, is failing |
| `codearena_cache_events_total{event="error"}` rising | Redis is unhealthy (degraded, not broken) |
| `histogram_quantile(0.95, codearena_judge_duration_seconds)` rising | Workers are saturated |

---

## Correlation IDs

One id follows a submission from the browser to the verdict.

```
browser ──► API          X-Correlation-Id: abc123 (sent, or generated)
                         │ echoed on the response
                         │ attached to the tracing span
                         ▼
            submissions.correlation_id = abc123    (persisted)
            outbox_events.correlation_id = abc123
                         │
                         ▼ carried in the queue message and its Kafka header
            worker       span: judge{submission_id, correlation_id=abc123}
```

A client-supplied id is accepted only if it is ≤ 64 printable ASCII characters
(`[A-Za-z0-9_-]`); anything else is replaced, so a header cannot forge a log
line. `GET /submissions/{id}` does not return the id, but the response header
on the original `POST` does.

To find everything about one submission:

```bash
docker compose logs api worker | grep abc123
```

```sql
SELECT id, status, verdict, attempts, claimed_by, internal_error
  FROM submissions WHERE correlation_id = 'abc123';
```

### Logs

`tracing`, controlled by `RUST_LOG`. `LOG_FORMAT_JSON=true` emits structured
JSON with the span fields attached, which is what the compose stack uses.

```
INFO judge{submission_id=7c38dd87 correlation_id=46a5328 delivery=1}:
     submission judged verdict="ACCEPTED" passed=6 total=6 duration_ms=1554 attempt=1
```

What is never logged: passwords, password hashes, full tokens, hidden test data.
Internal error detail is logged and then replaced with a generic message in the
response.

---

## Failure behaviour

### Redis is down

| Function | Behaviour |
| --- | --- |
| Problem cache | Every read is a miss, served from PostgreSQL. Logged as `cache_events{event="error"}` |
| Rate limits | Fall back to an in-process counter |
| Anything else | Unaffected — nothing authoritative is in Redis |

`GET /ready` reports `"redis": false` but still returns `200`: the service
works, degraded. The in-process fallback is per-instance rather than global, so
with *n* API instances an attacker gets *n* × the limit; it still bounds them,
and it fails on the limit rather than opening the endpoint. Delete the Redis
volume whenever you like.

### Kafka is down

Submissions are still accepted: `POST /submissions` commits the submission and
the outbox row, and the publish is a separate step. Outbox rows accumulate with
`publish_attempts` climbing and `codearena_queue_backlog` rising. When the
broker returns, the publisher drains them.

After `MAX_JUDGE_ATTEMPTS` failed publishes a row is dead-lettered and its
submission gets a terminal `INTERNAL_ERROR`, so a user is never left polling a
job that will never run.

### The worker dies

| When | Recovery |
| --- | --- |
| Before claiming | The message is redelivered (Kafka rebalance, or the visibility timeout expires) |
| While judging | The submission stays `RUNNING`; after `CLAIM_TIMEOUT_SECS` the reconciler requeues it |
| After the verdict, before acknowledging | Redelivered, but `claim` refuses a `FINISHED` submission and the duplicate is dropped |
| Permanently | `GET /admin/workers` shows it as `healthy: false` with its last heartbeat |

A clean shutdown (`SIGTERM`, `Ctrl-C`) stops the loops, waits up to 30 s for
in-flight judging, and deletes the heartbeat row so the worker looks absent
rather than permanently healthy.

### PostgreSQL is down

Everything stops, correctly. `GET /ready` returns `503`, `/health` still
returns `200` (the process is alive). The worker retries with backoff. Nothing
is lost, because nothing is acknowledged that was not committed.

---

## Retries are bounded

| Failure | Backoff | Budget | Then |
| --- | --- | --- | --- |
| Judge infrastructure | `JUDGE_RETRY_BASE_MS × 2^(n-1)`, capped at 60 s | `MAX_JUDGE_ATTEMPTS` (3) | Dead letter + `INTERNAL_ERROR` |
| Outbox publish | same | `MAX_JUDGE_ATTEMPTS` | Dead letter + `INTERNAL_ERROR` |
| Run execution | same | `MAX_JUDGE_ATTEMPTS` | `runs.outcome = INTERNAL_ERROR` |
| Stale claim | – | `MAX_JUDGE_ATTEMPTS` | Dead letter + `INTERNAL_ERROR` |

`submissions.attempts` is in the database, so the budget is enforced across
worker restarts and redeliveries rather than per process. Nothing retries
forever, and nothing fails silently.

---

## Dead letters

A job that cannot succeed lands in `dead_letter_events` with its reason and
payload, and its submission gets a terminal verdict. Nothing is deleted — this
is the answer to "where did my submission go".

In the UI: **Judge** in the admin navigation (`/admin/ops`). Over the API:
`GET /api/v1/admin/dead-letters`. From a shell, when the API itself is the
unhealthy thing:

```bash
cargo run --bin codearena-dlq -- list              # pending entries
cargo run --bin codearena-dlq -- show 7            # reason + payload
cargo run --bin codearena-dlq -- replay 7          # re-queue with a fresh budget
cargo run --bin codearena-dlq -- resolve 7 "bad problem data, fixed"
```

A replay resets `attempts` to 0, sets the submission back to `QUEUED` and writes
a fresh outbox row. Replaying an already-resolved entry is refused rather than
queueing it twice.

With the Kafka driver, dead-lettered jobs are also produced to
`KAFKA_DLQ_TOPIC`. The database record is always written first, so the audit
trail survives a broker outage.

---

## Rate limits

| Endpoint | Default | Keyed on |
| --- | --- | --- |
| `POST /auth/login` | `10/60` | Client address |
| `POST /auth/register` | `5/3600` | Client address |
| `POST /runs` | `20/60` | Authenticated user id |
| `POST /submissions` | `10/60` | Authenticated user id |

Set as `requests/seconds`, e.g. `RATE_LIMIT_SUBMIT=25/60`. `0/60` means
unlimited; `RATE_LIMIT_ENABLED=false` disables all of them.

A rejection is `429` with `Retry-After` in seconds and a readable message.
Fixed windows allow a burst at a boundary, which is acceptable for abuse
control at these window sizes.

Behind a proxy, set `TRUSTED_PROXY_HOPS` to the number of proxies in front.
With `0` (the default) `X-Forwarded-For` is ignored entirely and the socket peer
address is used. With `n`, only the entry a trusted proxy actually appended is
read, so prepending addresses cannot buy extra requests — getting this wrong is
the usual way an IP-based limit becomes decorative.

**Raise the submit limit before load testing**, or you will measure the
limiter. See [LOADTEST.md](LOADTEST.md).

---

## Useful queries

```sql
-- Submissions that are not progressing
SELECT id, status, attempts, claimed_by, age(now(), created_at) AS age
  FROM submissions WHERE status <> 'FINISHED' ORDER BY created_at LIMIT 20;

-- Queue depth and the age of the oldest undelivered event
SELECT count(*) AS pending, min(created_at) AS oldest
  FROM outbox_events WHERE published_at IS NULL;

-- Publishes that keep failing
SELECT id, aggregate_id, publish_attempts, last_error
  FROM outbox_events WHERE published_at IS NULL AND publish_attempts > 0;

-- Verdict mix over the last day
SELECT verdict, count(*) FROM submissions
 WHERE finished_at > now() - interval '1 day' GROUP BY verdict ORDER BY 2 DESC;

-- Judge failures, with the operator detail the API withholds
SELECT id, internal_error, attempts, finished_at FROM submissions
 WHERE verdict = 'INTERNAL_ERROR' ORDER BY finished_at DESC LIMIT 20;

-- Worker liveness
SELECT worker_id, last_seen_at, submissions_judged, failures FROM worker_heartbeats
 ORDER BY last_seen_at DESC;
```

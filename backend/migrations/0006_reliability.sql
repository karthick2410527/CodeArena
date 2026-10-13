-- Phase 5: reliability and observability.
--
-- Two tables, both there so a failure is *visible* rather than silent:
-- a terminal failure path that can be inspected and replayed, and worker
-- liveness that does not depend on scraping logs.

-- A job that could not be judged within its attempt budget, or whose publish
-- kept failing. Nothing is deleted: this is the audit trail for "where did my
-- submission go".
CREATE TABLE dead_letter_events (
    id             BIGSERIAL PRIMARY KEY,
    submission_id  UUID        REFERENCES submissions (id) ON DELETE SET NULL,
    event_type     TEXT        NOT NULL,
    payload        JSONB       NOT NULL,
    reason         TEXT        NOT NULL,
    correlation_id TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set when an operator has replayed or dismissed it.
    resolved_at    TIMESTAMPTZ,
    resolved_by    UUID        REFERENCES users (id) ON DELETE SET NULL,
    resolution     TEXT
);
CREATE INDEX dead_letter_unresolved_idx ON dead_letter_events (created_at DESC)
    WHERE resolved_at IS NULL;
CREATE INDEX dead_letter_submission_idx ON dead_letter_events (submission_id);

-- One row per worker process, refreshed on a timer. A worker that stops
-- updating its row is visibly stale in GET /admin/workers rather than merely
-- absent from the logs.
CREATE TABLE worker_heartbeats (
    worker_id      TEXT        PRIMARY KEY,
    queue_driver   TEXT        NOT NULL,
    runner_strategy TEXT       NOT NULL,
    version        TEXT        NOT NULL DEFAULT '',
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Cumulative counters since the process started.
    submissions_judged BIGINT  NOT NULL DEFAULT 0,
    runs_executed  BIGINT      NOT NULL DEFAULT 0,
    failures       BIGINT      NOT NULL DEFAULT 0,
    -- What it is doing right now, for operators.
    current_submission_id UUID
);
CREATE INDEX worker_heartbeats_last_seen_idx ON worker_heartbeats (last_seen_at DESC);

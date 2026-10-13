-- Phase 3: asynchronous judge — submissions, per-test results and the
-- transactional outbox that closes the PostgreSQL/Kafka dual-write gap.

CREATE TABLE submissions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    problem_id     UUID        NOT NULL REFERENCES problems (id) ON DELETE CASCADE,
    language       TEXT        NOT NULL,
    source_code    TEXT        NOT NULL,

    -- Lifecycle. Mirrors judge::verdict::JudgeStatus.
    status         TEXT        NOT NULL DEFAULT 'QUEUED'
                               CHECK (status IN ('QUEUED', 'RUNNING', 'FINISHED')),
    -- NULL until FINISHED. Mirrors judge::verdict::Verdict.
    verdict        TEXT        CHECK (verdict IN (
                                   'ACCEPTED',
                                   'WRONG_ANSWER',
                                   'COMPILATION_ERROR',
                                   'RUNTIME_ERROR',
                                   'TIME_LIMIT_EXCEEDED',
                                   'MEMORY_LIMIT_EXCEEDED',
                                   'INTERNAL_ERROR')),

    -- Compiler diagnostics. Shown to the submission's owner only.
    compile_output  TEXT       NOT NULL DEFAULT '',
    -- Worst/first failing case summary, for the UI.
    failed_case_position INTEGER,
    passed_tests    INTEGER    NOT NULL DEFAULT 0,
    total_tests     INTEGER    NOT NULL DEFAULT 0,
    score           INTEGER    NOT NULL DEFAULT 0,
    max_score       INTEGER    NOT NULL DEFAULT 0,
    -- Aggregates across executed tests.
    max_time_ms     INTEGER,
    max_memory_bytes BIGINT,

    -- Judge bookkeeping. `attempts` is what makes retries bounded.
    attempts        INTEGER    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    claimed_by      TEXT,
    claimed_at      TIMESTAMPTZ,
    -- Operator-only detail for an INTERNAL_ERROR; never returned by the API.
    internal_error  TEXT,
    correlation_id  TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,

    -- A finished submission always carries a verdict, so a client that sees
    -- FINISHED can never be left without an answer.
    CONSTRAINT submissions_finished_has_verdict
        CHECK (status <> 'FINISHED' OR verdict IS NOT NULL),
    CONSTRAINT submissions_finished_has_timestamp
        CHECK (status <> 'FINISHED' OR finished_at IS NOT NULL)
);

-- "My submissions", newest first (specification requirement).
CREATE INDEX submissions_user_created_idx ON submissions (user_id, created_at DESC);
-- "Submissions for this problem", newest first.
CREATE INDEX submissions_problem_created_idx ON submissions (problem_id, created_at DESC);
-- Solved-problem statistics: one row per (user, problem) that was accepted.
CREATE INDEX submissions_accepted_idx ON submissions (user_id, problem_id)
    WHERE verdict = 'ACCEPTED';
-- The PostgreSQL queue driver's claim query, and the abandoned-claim reconciler.
CREATE INDEX submissions_queue_idx ON submissions (created_at) WHERE status = 'QUEUED';
CREATE INDEX submissions_claimed_idx ON submissions (claimed_at) WHERE status = 'RUNNING';

-- One executed hidden/sample test. `test_case_id` is a reference only: the
-- input and expected output are NEVER copied in here, so even a bug in a DTO
-- cannot leak judge data through this table.
CREATE TABLE submission_results (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id  UUID    NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
    test_case_id   UUID    NOT NULL REFERENCES test_cases (id) ON DELETE CASCADE,
    position       INTEGER NOT NULL,
    is_sample      BOOLEAN NOT NULL DEFAULT FALSE,
    verdict        TEXT    NOT NULL CHECK (verdict IN (
                               'ACCEPTED',
                               'WRONG_ANSWER',
                               'RUNTIME_ERROR',
                               'TIME_LIMIT_EXCEEDED',
                               'MEMORY_LIMIT_EXCEEDED',
                               'INTERNAL_ERROR')),
    exec_status    TEXT    NOT NULL CHECK (exec_status IN (
                               'OK', 'NON_ZERO_EXIT', 'SIGNALLED',
                               'TIME_LIMIT', 'MEMORY_LIMIT', 'OUTPUT_LIMIT')),
    execution_time_ms INTEGER,
    memory_bytes   BIGINT,
    points_awarded INTEGER NOT NULL DEFAULT 0,
    exit_code      INTEGER,
    signal         INTEGER,
    -- One row per test per submission: makes result writing idempotent.
    UNIQUE (submission_id, test_case_id)
);
CREATE INDEX submission_results_submission_idx
    ON submission_results (submission_id, position);

-- ---------------------------------------------------------------------------
-- Transactional outbox.
--
-- A PostgreSQL commit and a Kafka publish are not atomic. Instead of pretending
-- they are, POST /submissions writes the submission row and an outbox row in
-- ONE transaction. A publisher then moves unpublished rows to Kafka and stamps
-- published_at; the PostgreSQL queue driver consumes this table directly.
--
-- Either way the guarantee is at-least-once delivery, never "lost because the
-- broker was down at the wrong moment".
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
    id             BIGSERIAL PRIMARY KEY,
    aggregate_id   UUID        NOT NULL,
    event_type     TEXT        NOT NULL,
    payload        JSONB       NOT NULL,
    correlation_id TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL = still to be delivered.
    published_at   TIMESTAMPTZ,
    -- Bounded publish retries; see dead_letter_events for the terminal path.
    publish_attempts INTEGER   NOT NULL DEFAULT 0,
    last_error     TEXT,
    -- Earliest time a failed publish may be retried (exponential backoff).
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The publisher's / PostgreSQL driver's claim query.
CREATE INDEX outbox_pending_idx ON outbox_events (next_attempt_at, id)
    WHERE published_at IS NULL;
CREATE INDEX outbox_aggregate_idx ON outbox_events (aggregate_id);

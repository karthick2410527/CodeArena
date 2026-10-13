-- Phase 2: the Run service.
--
-- A "run" is a user executing their own code against PUBLIC sample cases or
-- their own custom input. It never touches hidden test data: `run_cases.input`
-- and `expected_output` are only ever filled from `test_cases` rows with
-- `is_sample = TRUE`, or from input the user typed themselves.
--
-- Rows are written by the API (QUEUED) and executed by `codearena-worker`,
-- which claims them with FOR UPDATE SKIP LOCKED. The API process never
-- compiles or executes anything.

CREATE TABLE runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- A run is always against a published problem: its limits and samples
    -- come from there.
    problem_id    UUID        NOT NULL REFERENCES problems (id) ON DELETE CASCADE,
    language      TEXT        NOT NULL,
    source_code   TEXT        NOT NULL,
    -- SAMPLES: run every public sample. CUSTOM: run the supplied stdin once.
    mode          TEXT        NOT NULL CHECK (mode IN ('SAMPLES', 'CUSTOM')),
    stdin         TEXT        NOT NULL DEFAULT '',
    status        TEXT        NOT NULL DEFAULT 'QUEUED'
                              CHECK (status IN ('QUEUED', 'RUNNING', 'FINISHED')),
    -- NULL until FINISHED.
    outcome       TEXT        CHECK (outcome IN (
                                  'OK',
                                  'COMPILATION_ERROR',
                                  'RUNTIME_ERROR',
                                  'TIME_LIMIT_EXCEEDED',
                                  'MEMORY_LIMIT_EXCEEDED',
                                  'OUTPUT_LIMIT_EXCEEDED',
                                  'INTERNAL_ERROR')),
    -- Compiler diagnostics (errors or warnings). Safe to show the author.
    compile_output TEXT       NOT NULL DEFAULT '',
    compile_time_ms INTEGER,
    -- Set when the runner itself failed, for operators. Never returned to users.
    internal_error TEXT,
    attempts      INTEGER     NOT NULL DEFAULT 0,
    claimed_by    TEXT,
    claimed_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    -- Runs are ephemeral working state, not durable product data.
    expires_at    TIMESTAMPTZ NOT NULL,
    correlation_id TEXT,
    CONSTRAINT runs_finished_has_outcome
        CHECK (status <> 'FINISHED' OR outcome IS NOT NULL)
);

-- The worker's claim query: oldest queued run first.
CREATE INDEX runs_queue_idx ON runs (created_at) WHERE status = 'QUEUED';
-- Reconciling abandoned claims.
CREATE INDEX runs_claimed_idx ON runs (claimed_at) WHERE status = 'RUNNING';
-- "My recent runs", and retention cleanup.
CREATE INDEX runs_user_created_idx ON runs (user_id, created_at DESC);
CREATE INDEX runs_expires_idx ON runs (expires_at);

-- One executed case of a run.
CREATE TABLE run_cases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID    NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    -- "Sample 1", "Custom input" — shown in the UI.
    label           TEXT    NOT NULL,
    -- Public sample input, or the user's own input. NEVER hidden test data.
    input           TEXT    NOT NULL,
    -- Public sample expectation, or NULL for custom input.
    expected_output TEXT,
    stdout          TEXT    NOT NULL DEFAULT '',
    stderr          TEXT    NOT NULL DEFAULT '',
    stdout_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    stderr_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    -- Mirrors runner::ExecStatus.
    exec_status     TEXT    NOT NULL CHECK (exec_status IN (
                                'OK', 'NON_ZERO_EXIT', 'SIGNALLED',
                                'TIME_LIMIT', 'MEMORY_LIMIT', 'OUTPUT_LIMIT')),
    -- NULL when there is nothing to compare against (custom input).
    passed          BOOLEAN,
    time_ms         INTEGER,
    memory_bytes    BIGINT,
    exit_code       INTEGER,
    signal          INTEGER,
    UNIQUE (run_id, position)
);
CREATE INDEX run_cases_run_idx ON run_cases (run_id, position);

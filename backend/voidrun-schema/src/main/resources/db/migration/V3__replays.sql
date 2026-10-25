-- Execution recordings for step-through replay ("Debug" in the editor).
--
-- A replay is requested by the API (row + outbox event in one transaction),
-- recorded by a worker consuming voidrun.replays, and read back step by step
-- by the API. It never affects a verdict.

CREATE TABLE replays (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Context only: a replay can be of any program, and outlives a deleted problem.
    problem_id     UUID        REFERENCES problems (id) ON DELETE SET NULL,
    language       TEXT        NOT NULL,
    source_code    TEXT        NOT NULL,
    stdin          TEXT        NOT NULL DEFAULT '',
    status         TEXT        NOT NULL DEFAULT 'QUEUED'
                               CHECK (status IN ('QUEUED', 'RECORDING', 'FINISHED')),
    termination    TEXT        CHECK (termination IN (
                                   'EXITED', 'CRASHED', 'STEP_LIMIT', 'TIME_LIMIT',
                                   'COMPILE_ERROR', 'RECORDER_ERROR')),
    exit_code      INTEGER,
    detail         TEXT        NOT NULL DEFAULT '',
    step_count     INTEGER     NOT NULL DEFAULT 0,
    -- RecordingCodec: keyframes, deltas, stdout and compiler output. NULL only
    -- when the recorder gave up, in which case detail says why.
    recording      BYTEA,
    attempts       INTEGER     NOT NULL DEFAULT 0,
    claimed_by     TEXT,
    claimed_at     TIMESTAMPTZ,
    correlation_id TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ NOT NULL,
    CONSTRAINT replays_finished_has_termination CHECK ((status = 'FINISHED') = (termination IS NOT NULL)),
    CONSTRAINT replays_finished_has_time CHECK ((status = 'FINISHED') = (finished_at IS NOT NULL))
);
CREATE INDEX replays_user_idx ON replays (user_id, created_at DESC);
CREATE INDEX replays_expiry_idx ON replays (expires_at);

-- Dead letters can now be replays as well as submissions.
ALTER TABLE dead_letter_events
    ADD COLUMN replay_id UUID REFERENCES replays (id) ON DELETE SET NULL;
CREATE INDEX dead_letter_replay_idx ON dead_letter_events (replay_id);

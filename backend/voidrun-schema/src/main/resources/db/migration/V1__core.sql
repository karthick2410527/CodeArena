-- VoidRun core schema. Ported from the Rust backend's migrations 0001, 0003,
-- 0004, 0005 and 0006, with sign-in by Google and GitHub added: a user may
-- have no password and no email, and owns zero or more external identities.

-- ---------------------------------------------------------------- accounts

CREATE TABLE users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username       TEXT        NOT NULL,
    -- NULL when the account came from a provider that shared no verified email.
    email          TEXT,
    -- TRUE only when a provider vouched for it. Password sign-up does not
    -- verify email, so such an address is never trusted for account linking.
    email_verified BOOLEAN     NOT NULL DEFAULT FALSE,
    -- NULL for accounts that only sign in through a provider.
    password_hash  TEXT,
    display_name   TEXT,
    avatar_url     TEXT,
    role           TEXT        NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_idx    ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- SHA-256 of the token; the token itself is never stored.
    token_hash TEXT        NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- An account at Google or GitHub that signs in as a VoidRun user.
CREATE TABLE user_identities (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider       TEXT        NOT NULL CHECK (provider IN ('google', 'github')),
    -- The provider's stable account id (OIDC "sub", GitHub numeric id),
    -- never the email or login, which can change hands.
    subject        TEXT        NOT NULL,
    email          TEXT,
    email_verified BOOLEAN     NOT NULL DEFAULT FALSE,
    login          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, subject),
    -- One account per provider per user keeps unlinking unambiguous.
    UNIQUE (user_id, provider)
);

-- One-time codes handed to the browser after a provider sign-in. The SPA
-- trades one for tokens over POST, so tokens never appear in a URL, browser
-- history or a Referer header. nonce_hash binds the code to the browser that
-- signed in (an HttpOnly cookie), so a code sent to someone else in a link
-- cannot sign them into the sender's account.
CREATE TABLE oauth_login_codes (
    code_hash  TEXT PRIMARY KEY,
    nonce_hash TEXT        NOT NULL,
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oauth_login_codes_expires_idx ON oauth_login_codes (expires_at);

-- A signed-in user's request to attach a provider account. The browser
-- carries the token through the provider redirect, which cannot carry a
-- bearer header. As with login codes, nonce_hash ties it to the browser that
-- asked, so nobody can be tricked into linking their provider account to
-- someone else's VoidRun account.
CREATE TABLE oauth_link_intents (
    token_hash TEXT PRIMARY KEY,
    nonce_hash TEXT        NOT NULL,
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider   TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ
);

-- ---------------------------------------------------------------- problems

CREATE TABLE problems (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number          BIGINT GENERATED ALWAYS AS IDENTITY,
    slug            TEXT        NOT NULL,
    title           TEXT        NOT NULL,
    description     TEXT        NOT NULL,            -- Markdown statement
    constraints     TEXT        NOT NULL DEFAULT '', -- Markdown
    difficulty      TEXT        NOT NULL CHECK (difficulty IN ('EASY', 'MEDIUM', 'HARD')),
    time_limit_ms   INTEGER     NOT NULL CHECK (time_limit_ms > 0),
    memory_limit_mb INTEGER     NOT NULL CHECK (memory_limit_mb > 0),
    published       BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_by      UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX problems_slug_idx ON problems (slug);
CREATE UNIQUE INDEX problems_number_idx ON problems (number);
CREATE INDEX problems_difficulty_idx ON problems (difficulty) WHERE published;

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER problems_set_updated_at
    BEFORE UPDATE ON problems
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tags (
    id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL
);
CREATE UNIQUE INDEX tags_name_lower_idx ON tags (lower(name));

CREATE TABLE problem_tags (
    problem_id UUID NOT NULL REFERENCES problems (id) ON DELETE CASCADE,
    tag_id     UUID NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (problem_id, tag_id)
);
CREATE INDEX problem_tags_tag_idx ON problem_tags (tag_id);

CREATE TABLE test_cases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    problem_id      UUID    NOT NULL REFERENCES problems (id) ON DELETE CASCADE,
    position        INTEGER NOT NULL DEFAULT 0,
    input           TEXT    NOT NULL,
    expected_output TEXT    NOT NULL,
    explanation     TEXT,
    is_sample       BOOLEAN NOT NULL DEFAULT FALSE,
    points          INTEGER NOT NULL DEFAULT 1 CHECK (points >= 0)
);
CREATE UNIQUE INDEX test_cases_problem_position_idx ON test_cases (problem_id, position);
CREATE INDEX test_cases_problem_sample_idx ON test_cases (problem_id, is_sample);

-- ---------------------------------------------------------------- runs

-- Working state for the editor's Run button; purged after expires_at.
CREATE TABLE runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    problem_id      UUID        NOT NULL REFERENCES problems (id) ON DELETE CASCADE,
    language        TEXT        NOT NULL,
    source_code     TEXT        NOT NULL,
    mode            TEXT        NOT NULL CHECK (mode IN ('SAMPLES', 'CUSTOM')),
    stdin           TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'QUEUED'
                                CHECK (status IN ('QUEUED', 'RUNNING', 'FINISHED')),
    outcome         TEXT        CHECK (outcome IN (
                                    'OK', 'COMPILATION_ERROR', 'RUNTIME_ERROR',
                                    'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED',
                                    'OUTPUT_LIMIT_EXCEEDED', 'INTERNAL_ERROR')),
    compile_output  TEXT        NOT NULL DEFAULT '',
    compile_time_ms INTEGER,
    internal_error  TEXT,
    attempts        INTEGER     NOT NULL DEFAULT 0,
    claimed_by      TEXT,
    claimed_at      TIMESTAMPTZ,
    correlation_id  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,
    CONSTRAINT runs_finished_has_outcome CHECK (status <> 'FINISHED' OR outcome IS NOT NULL)
);
CREATE INDEX runs_user_created_idx ON runs (user_id, created_at DESC);
CREATE INDEX runs_expires_idx ON runs (expires_at);

CREATE TABLE run_cases (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id           UUID    NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    position         INTEGER NOT NULL,
    label            TEXT    NOT NULL,
    input            TEXT    NOT NULL,
    expected_output  TEXT,
    stdout           TEXT    NOT NULL DEFAULT '',
    stderr           TEXT    NOT NULL DEFAULT '',
    stdout_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    stderr_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    exec_status      TEXT    NOT NULL CHECK (exec_status IN (
                                 'OK', 'NON_ZERO_EXIT', 'SIGNALLED',
                                 'TIME_LIMIT', 'MEMORY_LIMIT', 'OUTPUT_LIMIT')),
    passed           BOOLEAN,
    time_ms          INTEGER,
    memory_bytes     BIGINT,
    exit_code        INTEGER,
    signal           INTEGER,
    UNIQUE (run_id, position)
);

-- ---------------------------------------------------------------- submissions

CREATE TABLE submissions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    problem_id           UUID        NOT NULL REFERENCES problems (id) ON DELETE CASCADE,
    language             TEXT        NOT NULL,
    source_code          TEXT        NOT NULL,
    status               TEXT        NOT NULL DEFAULT 'QUEUED'
                                     CHECK (status IN ('QUEUED', 'RUNNING', 'FINISHED')),
    verdict              TEXT        CHECK (verdict IN (
                                         'ACCEPTED', 'WRONG_ANSWER', 'COMPILATION_ERROR',
                                         'RUNTIME_ERROR', 'TIME_LIMIT_EXCEEDED',
                                         'MEMORY_LIMIT_EXCEEDED', 'INTERNAL_ERROR')),
    compile_output       TEXT        NOT NULL DEFAULT '',
    failed_case_position INTEGER,
    passed_tests         INTEGER     NOT NULL DEFAULT 0,
    total_tests          INTEGER     NOT NULL DEFAULT 0,
    score                INTEGER     NOT NULL DEFAULT 0,
    max_score            INTEGER     NOT NULL DEFAULT 0,
    max_time_ms          INTEGER,
    max_memory_bytes     BIGINT,
    -- Judge bookkeeping. `attempts` is what keeps retries bounded.
    attempts             INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    claimed_by           TEXT,
    claimed_at           TIMESTAMPTZ,
    -- Operator-only detail for an INTERNAL_ERROR; never returned by the API.
    internal_error       TEXT,
    correlation_id       TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at          TIMESTAMPTZ,
    -- A finished submission always carries a verdict, so a client that sees
    -- FINISHED can never be left without an answer.
    CONSTRAINT submissions_finished_has_verdict CHECK (status <> 'FINISHED' OR verdict IS NOT NULL),
    CONSTRAINT submissions_finished_has_timestamp CHECK (status <> 'FINISHED' OR finished_at IS NOT NULL)
);
CREATE INDEX submissions_user_created_idx ON submissions (user_id, created_at DESC);
CREATE INDEX submissions_problem_created_idx ON submissions (problem_id, created_at DESC);
CREATE INDEX submissions_accepted_idx ON submissions (user_id, problem_id) WHERE verdict = 'ACCEPTED';
CREATE INDEX submissions_user_verdict_idx ON submissions (user_id, verdict);
CREATE INDEX submissions_claimed_idx ON submissions (claimed_at) WHERE status = 'RUNNING';

CREATE TABLE submission_results (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id     UUID    NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
    test_case_id      UUID    NOT NULL REFERENCES test_cases (id) ON DELETE CASCADE,
    position          INTEGER NOT NULL,
    is_sample         BOOLEAN NOT NULL DEFAULT FALSE,
    verdict           TEXT    NOT NULL CHECK (verdict IN (
                                  'ACCEPTED', 'WRONG_ANSWER', 'RUNTIME_ERROR',
                                  'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'INTERNAL_ERROR')),
    exec_status       TEXT    NOT NULL CHECK (exec_status IN (
                                  'OK', 'NON_ZERO_EXIT', 'SIGNALLED',
                                  'TIME_LIMIT', 'MEMORY_LIMIT', 'OUTPUT_LIMIT')),
    execution_time_ms INTEGER,
    memory_bytes      BIGINT,
    points_awarded    INTEGER NOT NULL DEFAULT 0,
    exit_code         INTEGER,
    signal            INTEGER,
    -- One row per test per submission: makes result writing idempotent.
    UNIQUE (submission_id, test_case_id)
);
CREATE INDEX submission_results_submission_idx ON submission_results (submission_id, position);

-- ---------------------------------------------------------------- reliability

-- Transactional outbox: written in the same transaction as the row it
-- announces, then relayed to Kafka. Neither half can exist without the other.
CREATE TABLE outbox_events (
    id               BIGSERIAL PRIMARY KEY,
    topic            TEXT        NOT NULL,
    -- Kafka record key: fixes the partition, and with it the ordering.
    message_key      TEXT        NOT NULL,
    event_type       TEXT        NOT NULL,
    aggregate_id     UUID        NOT NULL,
    payload          JSONB       NOT NULL,
    correlation_id   TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL = still to be delivered.
    published_at     TIMESTAMPTZ,
    publish_attempts INTEGER     NOT NULL DEFAULT 0,
    last_error       TEXT,
    -- Earliest time a failed publish may be retried (exponential backoff).
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox_events (next_attempt_at, id) WHERE published_at IS NULL;

CREATE TABLE dead_letter_events (
    id             BIGSERIAL PRIMARY KEY,
    submission_id  UUID        REFERENCES submissions (id) ON DELETE SET NULL,
    event_type     TEXT        NOT NULL,
    payload        JSONB       NOT NULL,
    reason         TEXT        NOT NULL,
    correlation_id TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at    TIMESTAMPTZ,
    resolved_by    UUID        REFERENCES users (id) ON DELETE SET NULL,
    resolution     TEXT
);
CREATE INDEX dead_letter_unresolved_idx ON dead_letter_events (created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX dead_letter_submission_idx ON dead_letter_events (submission_id);

CREATE TABLE worker_heartbeats (
    worker_id             TEXT        PRIMARY KEY,
    queue_driver          TEXT        NOT NULL,
    runner_strategy       TEXT        NOT NULL,
    version               TEXT        NOT NULL DEFAULT '',
    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    submissions_judged    BIGINT      NOT NULL DEFAULT 0,
    runs_executed         BIGINT      NOT NULL DEFAULT 0,
    failures              BIGINT      NOT NULL DEFAULT 0,
    current_submission_id UUID
);

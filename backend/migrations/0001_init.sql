-- CodeArena Phase 1 schema: users, refresh tokens, problems, tags, test cases.

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT        NOT NULL,
    email         TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    role          TEXT        NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_idx    ON users (lower(email));

-- Opaque refresh tokens; only the SHA-256 hash is stored.
CREATE TABLE refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash TEXT        NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE problems (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number          BIGINT GENERATED ALWAYS AS IDENTITY,
    slug            TEXT        NOT NULL,
    title           TEXT        NOT NULL,
    description     TEXT        NOT NULL,  -- Markdown statement
    constraints     TEXT        NOT NULL DEFAULT '',  -- Markdown
    difficulty      TEXT        NOT NULL CHECK (difficulty IN ('EASY', 'MEDIUM', 'HARD')),
    time_limit_ms   INTEGER     NOT NULL CHECK (time_limit_ms > 0),
    memory_limit_mb INTEGER     NOT NULL CHECK (memory_limit_mb > 0),
    published       BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX problems_slug_idx ON problems (slug);
CREATE UNIQUE INDEX problems_number_idx ON problems (number);
CREATE INDEX problems_difficulty_idx ON problems (difficulty) WHERE published;

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

-- is_sample = TRUE  -> public example, may be returned by public endpoints.
-- is_sample = FALSE -> hidden judge data, must NEVER be returned publicly.
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
CREATE INDEX test_cases_problem_idx ON test_cases (problem_id, is_sample, position);

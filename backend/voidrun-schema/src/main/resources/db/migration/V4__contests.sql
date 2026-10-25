-- Community problems and contests.
--
-- Any signed-in user can write problems and host a contest with co-authors;
-- others register and compete live. A problem in a contest stays out of the
-- practice set until the contest has ended, then appears there on its own.

-- NULL for the platform's own problems (managed by admins).
ALTER TABLE problems ADD COLUMN owner_id UUID REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX problems_owner_idx ON problems (owner_id);

CREATE TABLE contests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT        NOT NULL,
    title       TEXT        NOT NULL,
    description TEXT        NOT NULL DEFAULT '',   -- Markdown: rules, announcements
    -- How standings are scored; see the ScoringRule implementations.
    format      TEXT        NOT NULL DEFAULT 'CODEFORCES'
                            CHECK (format IN ('CODEFORCES', 'ICPC', 'ATCODER', 'IOI')),
    starts_at   TIMESTAMPTZ NOT NULL,
    -- Stored rather than derived: timestamptz + interval is not immutable, so
    -- it cannot be a generated column, and every visibility check uses it.
    ends_at     TIMESTAMPTZ NOT NULL,
    -- A draft is visible to its authors only.
    published   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_by  UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT contests_ends_after_start CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX contests_slug_idx ON contests (slug);
CREATE INDEX contests_schedule_idx ON contests (starts_at, ends_at) WHERE published;

-- Who can edit a contest and its problems. Exactly one OWNER, who manages the
-- author list; AUTHORs edit everything else.
CREATE TABLE contest_authors (
    contest_id UUID        NOT NULL REFERENCES contests (id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('OWNER', 'AUTHOR')),
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (contest_id, user_id)
);
CREATE UNIQUE INDEX contest_one_owner_idx ON contest_authors (contest_id) WHERE role = 'OWNER';
CREATE INDEX contest_authors_user_idx ON contest_authors (user_id);

CREATE TABLE contest_problems (
    contest_id UUID    NOT NULL REFERENCES contests (id) ON DELETE CASCADE,
    problem_id UUID    NOT NULL REFERENCES problems (id) ON DELETE CASCADE,
    label      TEXT    NOT NULL,                  -- A, B, C, …
    position   INTEGER NOT NULL,
    -- Maximum points (Codeforces, AtCoder, IOI); ICPC ignores it.
    points     INTEGER NOT NULL DEFAULT 500 CHECK (points > 0),
    PRIMARY KEY (contest_id, problem_id),
    UNIQUE (contest_id, label)
);
CREATE INDEX contest_problems_problem_idx ON contest_problems (problem_id);

CREATE TABLE contest_registrations (
    contest_id    UUID        NOT NULL REFERENCES contests (id) ON DELETE CASCADE,
    user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (contest_id, user_id)
);
CREATE INDEX contest_registrations_user_idx ON contest_registrations (user_id);

-- Set only for submissions made while the contest was running; afterwards a
-- submission to the same problem is ordinary practice ("upsolving") and never
-- touches the standings.
ALTER TABLE submissions
    ADD COLUMN contest_id UUID REFERENCES contests (id) ON DELETE SET NULL,
    ADD COLUMN contest_elapsed_seconds INTEGER CHECK (contest_elapsed_seconds >= 0);
CREATE INDEX submissions_contest_idx ON submissions (contest_id, created_at) WHERE contest_id IS NOT NULL;

-- One-time codes sent by email: to sign in without a password, or to set a
-- new one. Only a hash is stored; a code works once, for ten minutes, and is
-- burned after five wrong guesses.
CREATE TABLE email_codes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose    TEXT        NOT NULL CHECK (purpose IN ('LOGIN', 'RESET')),
    code_hash  TEXT        NOT NULL,
    attempts   INT         NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_codes_open ON email_codes (user_id, purpose, created_at DESC) WHERE used_at IS NULL;

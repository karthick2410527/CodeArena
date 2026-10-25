-- Host plans, paid through Razorpay. Hosting (publishing a contest) needs an
-- active plan; a plan is bought as a one-off order that extends it by a number
-- of days. Prices live in configuration and are copied onto each payment, so a
-- price change never rewrites what someone already paid.

CREATE TABLE payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    plan                TEXT NOT NULL,
    amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
    currency            TEXT NOT NULL DEFAULT 'INR',
    period_days         INTEGER NOT NULL CHECK (period_days > 0),
    razorpay_order_id   TEXT NOT NULL UNIQUE,
    razorpay_payment_id TEXT UNIQUE,
    status              TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PAID', 'FAILED')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at             TIMESTAMPTZ,
    -- Paid exactly when it has a payment id and a time.
    CHECK ((status = 'PAID') = (paid_at IS NOT NULL AND razorpay_payment_id IS NOT NULL))
);

CREATE INDEX payments_user_idx ON payments (user_id, created_at DESC);

-- One row per user who has ever paid; hosting is allowed while valid_until is ahead.
CREATE TABLE host_plans (
    user_id     UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    plan        TEXT NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Razorpay may deliver a webhook more than once; each event is handled once.
CREATE TABLE billing_webhook_events (
    event_id    TEXT PRIMARY KEY,
    event_type  TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

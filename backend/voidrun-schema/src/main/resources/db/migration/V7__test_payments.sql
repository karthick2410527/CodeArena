-- Payments made with the built-in test checkout (no Razorpay, no money moved)
-- are kept apart, so they are never mistaken for revenue.
ALTER TABLE payments ADD COLUMN test BOOLEAN NOT NULL DEFAULT false;

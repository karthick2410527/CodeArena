-- Contest editorials: an introduction for the round and a write-up per
-- problem, written by the contest's authors at any time and shown to everyone
-- once the contest has ended (and on each problem's practice page).
ALTER TABLE contests ADD COLUMN editorial TEXT NOT NULL DEFAULT '';
ALTER TABLE contest_problems ADD COLUMN editorial TEXT NOT NULL DEFAULT '';

-- People search matches anywhere in the username or display name.
CREATE INDEX users_username_prefix_idx ON users (lower(username) text_pattern_ops);

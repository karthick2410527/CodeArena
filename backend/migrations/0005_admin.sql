-- Phase 4: administration support.
--
-- Problem CRUD is done through admin-only endpoints. The schema additions here
-- keep edits auditable and test-case ordering well defined.

-- `updated_at` must be truthful without every UPDATE remembering to set it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER problems_set_updated_at
    BEFORE UPDATE ON problems
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who last changed a problem, for the admin UI.
ALTER TABLE problems ADD COLUMN updated_by UUID REFERENCES users (id) ON DELETE SET NULL;

-- Two test cases of the same problem must not share a position: the position is
-- shown to users ("failed on test 3") and used for deterministic ordering.
CREATE UNIQUE INDEX test_cases_problem_position_idx
    ON test_cases (problem_id, position);

-- Listing a problem's cases in the admin UI.
CREATE INDEX test_cases_problem_sample_idx ON test_cases (problem_id, is_sample);

-- Statistics ("problems solved") read this constantly.
CREATE INDEX submissions_user_verdict_idx ON submissions (user_id, verdict);

-- Where a problem came from, when it was imported from another judge
-- (e.g. https://codeforces.com/problemset/problem/4/A). Shown on the problem
-- page as credit to the original authors.
ALTER TABLE problems ADD COLUMN source_url TEXT
    CHECK (source_url IS NULL OR (source_url ~ '^https://' AND length(source_url) <= 300));

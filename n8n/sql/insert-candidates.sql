-- Ingest one candidate article. A URL already present, in any state, is left
-- untouched: re-fetching a feed never resets its scoring or sent state. A story
-- whose title was already sent (legacy raw url, or another source) is skipped too,
-- so it is never scored again. Explicit casts: untyped parameters in a SELECT list
-- would resolve to text.
-- params: url, title, description, source, source_type, prio, published_at
INSERT INTO rss_articles (url, title, description, source, source_type, prio, published_at)
SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::smallint, $7::timestamptz
WHERE NOT EXISTS (
    SELECT 1 FROM rss_articles s
    WHERE s.sent_at IS NOT NULL AND lower(s.title) = lower($2::text)
)
ON CONFLICT (url) DO NOTHING;

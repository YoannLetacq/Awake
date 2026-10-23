-- Claim up to param 1 unscored candidates for Gemini scoring, oldest first.
-- The claim bumps score_attempts in the same statement, so a run that dies after
-- claiming still spends an attempt. A row is abandoned after 3 attempts, and
-- candidates older than 48 hours are ignored. FOR UPDATE SKIP LOCKED keeps two
-- overlapping runs from claiming the same rows.
UPDATE rss_articles
SET score_attempts = score_attempts + 1
WHERE id IN (
    SELECT id
    FROM rss_articles
    WHERE gemini_confidence IS NULL
      AND sent_at IS NULL
      AND score_attempts < 3
      AND created_at > now() - interval '48 hours'
    ORDER BY created_at, id
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
RETURNING id, title, description, source;

-- Claim up to param 1 unscored candidates for Gemini scoring, freshest first
-- (undated last), so a backlog never lets the newest items age out of the window.
-- The claim bumps score_attempts in the same statement, so a run that dies after
-- claiming still spends an attempt. A row is abandoned after 3 attempts, and
-- candidates older than 48 hours are ignored.
-- Overlapping runs: FOR UPDATE SKIP LOCKED only lasts this autocommit statement, so
-- the claim also takes a 15-minute lease (scoring_started_at). A run that starts
-- before the previous one saved its scores skips the leased rows; a lease left by a
-- run that died expires after 15 minutes and the row can be claimed again.
UPDATE rss_articles
SET score_attempts = score_attempts + 1,
    scoring_started_at = now()
WHERE id IN (
    SELECT id
    FROM rss_articles
    WHERE gemini_confidence IS NULL
      AND sent_at IS NULL
      AND score_attempts < 3
      AND created_at > now() - interval '48 hours'
      AND (scoring_started_at IS NULL
           OR scoring_started_at < now() - interval '15 minutes')
    ORDER BY published_at DESC NULLS LAST, id
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
RETURNING id, title, description, source;

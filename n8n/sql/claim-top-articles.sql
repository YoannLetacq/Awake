-- Claim the best unsent stories for posting, in one atomic statement.
-- param 1 = minimum gemini_score, param 2 = maximum stories per source_type per claim,
-- param 3 = channels that have a webhook (text[]; unknown source_types count as 'Other').
-- Rows of a channel without webhook are never claimed, so they are not lost as 'sent'.
--
-- Eligible rows: unsent, gemini_confidence >= 85, gemini_score >= param 1, published in
-- the last 48 hours, and whose lower(title) matches no row already sent (from any
-- source, legacy rows included). That last rule is the cross-source dedup.
--
-- One story per title: among eligible rows sharing a lower(title), only the best one
-- (gemini_score + prio, then newest) enters the ranking. The losers are neither marked
-- sent nor returned. Once the winner is sent, the already-sent-title rule above
-- excludes them for good. If the cap holds the winner back, its losers stay held back
-- too, so a story is still posted at most once.
--
-- Per source_type, at most param 2 rows are claimed. Output is best first, with the same
-- order as the ranking (gemini_score + prio DESC, published_at DESC).
--
-- Concurrency (READ COMMITTED): the UPDATE re-checks sent_at IS NULL, so a row that a
-- concurrent claim has already taken is skipped instead of being returned twice.
WITH eligible AS (
    SELECT a.id, a.source_type, a.gemini_score, a.prio, a.published_at,
           lower(a.title) AS ltitle
    FROM rss_articles a
    WHERE a.sent_at IS NULL
      AND a.gemini_confidence >= 85
      AND a.gemini_score >= $1
      AND a.published_at > now() - interval '48 hours'
      AND (CASE WHEN a.source_type IN ('Tech News', 'Company Blogs', 'Reddit Communities')
                THEN a.source_type ELSE 'Other' END) = ANY($3::text[])
      AND NOT EXISTS (
          SELECT 1 FROM rss_articles s
          WHERE s.sent_at IS NOT NULL AND lower(s.title) = lower(a.title)
      )
),
one_per_title AS (
    SELECT id, source_type, gemini_score, prio, published_at,
           row_number() OVER (
               PARTITION BY ltitle
               ORDER BY gemini_score + prio DESC, published_at DESC, id
           ) AS title_rank
    FROM eligible
),
ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY source_type
               ORDER BY gemini_score + prio DESC, published_at DESC, id
           ) AS channel_rank
    FROM one_per_title
    WHERE title_rank = 1
),
claimed AS (
    UPDATE rss_articles
    SET sent_at = now()
    WHERE sent_at IS NULL
      AND id IN (SELECT id FROM ranked WHERE channel_rank <= $2)
    RETURNING id, url, title, source, source_type, category, published_at,
              gemini_score, prio, ai_tag, ai_summary, ai_takeaway
)
SELECT id, url, title, source, source_type, category, published_at,
       gemini_score, ai_tag, ai_summary, ai_takeaway
FROM claimed
ORDER BY gemini_score + prio DESC, published_at DESC, id;

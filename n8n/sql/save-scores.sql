-- Store the Gemini result for one candidate. The scoring and posting state
-- (score_attempts, sent_at) belongs to the claim statements and is not touched here.
-- param 1 id, param 2 gemini_confidence, param 3 gemini_score, param 4 category, param 5 ai_tag,
-- param 6 ai_summary, param 7 ai_takeaway
UPDATE rss_articles
SET gemini_confidence = $2,
    gemini_score = $3,
    category = $4,
    ai_tag = $5,
    ai_summary = $6,
    ai_takeaway = $7
WHERE id = $1;

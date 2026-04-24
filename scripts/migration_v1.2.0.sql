-- ==========================================
-- MIGRATION v1.2.0 - Add source_type column
-- ==========================================

-- Add source_type column to rss_articles
ALTER TABLE rss_articles
ADD COLUMN IF NOT EXISTS source_type VARCHAR(50);

-- Add index for source_type queries
CREATE INDEX IF NOT EXISTS idx_source_type ON rss_articles(source_type);

-- Composite index for filtering by source_type and date
CREATE INDEX IF NOT EXISTS idx_source_type_published ON rss_articles(source_type, published_at DESC);

-- Update existing records with source_type based on source domain
UPDATE rss_articles
SET source_type = CASE
    WHEN source LIKE '%techcrunch%' OR source LIKE '%hnrss%' THEN 'Tech News'
    WHEN source LIKE '%openai%' OR source LIKE '%huggingface%' OR source LIKE '%googleblog%' OR source LIKE '%blog.google%' THEN 'Company Blogs'
    WHEN source LIKE '%reddit%' THEN 'Reddit Communities'
    ELSE 'Other'
END
WHERE source_type IS NULL;

-- Verify migration
SELECT source_type, COUNT(*) as count
FROM rss_articles
GROUP BY source_type
ORDER BY count DESC;

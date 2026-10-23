-- ==========================================
-- SCHÉMA BASE DE DONNÉES - VEILLE IA
-- ==========================================

-- Table principale des articles RSS
CREATE TABLE IF NOT EXISTS rss_articles (
    id SERIAL PRIMARY KEY,
    url VARCHAR(2048) UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    content TEXT,
    source VARCHAR(255) NOT NULL,
    source_type VARCHAR(100),
    category VARCHAR(100),
    published_at TIMESTAMP WITH TIME ZONE,
    sent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration: add source_type column if upgrading from an older schema
ALTER TABLE rss_articles ADD COLUMN IF NOT EXISTS source_type VARCHAR(100);

-- Index pour optimiser les requêtes
CREATE INDEX IF NOT EXISTS idx_url ON rss_articles(url);
CREATE INDEX IF NOT EXISTS idx_sent_at ON rss_articles(sent_at);
CREATE INDEX IF NOT EXISTS idx_published_at ON rss_articles(published_at);
CREATE INDEX IF NOT EXISTS idx_source ON rss_articles(source);
CREATE INDEX IF NOT EXISTS idx_category ON rss_articles(category);
CREATE INDEX IF NOT EXISTS idx_created_at ON rss_articles(created_at);

-- Index composite pour recherches fréquentes
CREATE INDEX IF NOT EXISTS idx_source_sent_at ON rss_articles(source, sent_at);
CREATE INDEX IF NOT EXISTS idx_category_published ON rss_articles(category, published_at DESC);

-- Partial index for the recent-sent_at hot path (article_stats view)
CREATE INDEX IF NOT EXISTS idx_sent_at_recent
    ON rss_articles(sent_at) WHERE sent_at IS NOT NULL;

-- Fonction pour mettre à jour updated_at automatiquement
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger pour updated_at
DROP TRIGGER IF EXISTS update_rss_articles_updated_at ON rss_articles;
CREATE TRIGGER update_rss_articles_updated_at
    BEFORE UPDATE ON rss_articles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Table de logs pour tracking (optionnel)
CREATE TABLE IF NOT EXISTS execution_logs (
    id SERIAL PRIMARY KEY,
    workflow_name VARCHAR(255) NOT NULL,
    execution_status VARCHAR(50) NOT NULL,
    articles_found INTEGER DEFAULT 0,
    articles_sent INTEGER DEFAULT 0,
    errors TEXT,
    executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_execution_logs_date ON execution_logs(executed_at DESC);

-- Vue pour statistiques rapides
CREATE OR REPLACE VIEW article_stats AS
SELECT
    COUNT(*) as total_articles,
    COUNT(*) FILTER (WHERE sent_at IS NOT NULL) as sent_articles,
    COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '24 hours') as last_24h,
    COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '7 days') as last_7days,
    COUNT(DISTINCT source) as total_sources,
    COUNT(DISTINCT category) as total_categories,
    MAX(sent_at) as last_sent,
    MIN(created_at) as oldest_article
FROM rss_articles;

-- Fonction pour purger les anciens articles (> 90 jours)
CREATE OR REPLACE FUNCTION purge_old_articles()
RETURNS TABLE(deleted_count BIGINT) AS $$
DECLARE
    rows_deleted BIGINT;
BEGIN
    DELETE FROM rss_articles
    WHERE COALESCE(sent_at, created_at) < NOW() - INTERVAL '90 days';

    GET DIAGNOSTICS rows_deleted = ROW_COUNT;
    RETURN QUERY SELECT rows_deleted;
END;
$$ LANGUAGE plpgsql;

-- Fonction pour statistiques par source
CREATE OR REPLACE FUNCTION get_source_stats()
RETURNS TABLE(
    source_name VARCHAR(255),
    total_count BIGINT,
    sent_count BIGINT,
    last_article TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        source as source_name,
        COUNT(*) as total_count,
        COUNT(*) FILTER (WHERE sent_at IS NOT NULL) as sent_count,
        MAX(published_at) as last_article
    FROM rss_articles
    GROUP BY source
    ORDER BY total_count DESC;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- FONCTIONS DE DÉDUPLICATION POUR N8N
-- ==========================================

-- Fonction 4: Stats de déduplication (monitoring)
CREATE OR REPLACE FUNCTION get_deduplication_stats()
RETURNS TABLE(
    total_articles INTEGER,
    last_24h INTEGER,
    last_7days INTEGER,
    avg_per_day NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::INTEGER as total,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::INTEGER as last_24h,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::INTEGER as last_7days,
        ROUND(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::NUMERIC / 7, 2) as avg_per_day
    FROM rss_articles;
END;
$$ LANGUAGE plpgsql;

-- Insérer un log d'initialisation
INSERT INTO execution_logs (workflow_name, execution_status, articles_found, articles_sent)
VALUES ('database_init', 'success', 0, 0);

-- MIGRATION: scoring pipeline columns (idempotent).
-- Runs once: while score_attempts exists, nothing below touches any row.
-- Legacy rows were already posted, so they are marked sent and exhausted
-- (score_attempts = 3): they are never scored nor posted again.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'rss_articles'
          AND column_name = 'score_attempts'
    ) THEN
        ALTER TABLE rss_articles
            ADD COLUMN prio SMALLINT NOT NULL DEFAULT 0,
            ADD COLUMN gemini_confidence SMALLINT,
            ADD COLUMN gemini_score SMALLINT,
            ADD COLUMN ai_tag VARCHAR(8),
            ADD COLUMN ai_summary TEXT,
            ADD COLUMN ai_takeaway TEXT,
            ADD COLUMN score_attempts SMALLINT NOT NULL DEFAULT 0;

        UPDATE rss_articles
        SET sent_at = COALESCE(sent_at, created_at),
            score_attempts = 3;
    END IF;
END $$;

-- MIGRATION: scoring lease (idempotent). Outside the guard above, so a database
-- migrated before the lease existed gets it too. claim-unscored.sql sets it and skips
-- rows leased less than 15 minutes ago.
ALTER TABLE rss_articles ADD COLUMN IF NOT EXISTS scoring_started_at TIMESTAMP WITH TIME ZONE;

-- Dedup helpers replaced by insert-candidates.sql (ON CONFLICT). Dropped so that
-- live databases lose them too. Argument types must match the old signatures.
DROP FUNCTION IF EXISTS filter_new_urls(TEXT[]);
DROP FUNCTION IF EXISTS check_url_duplicates(TEXT[]);
DROP FUNCTION IF EXISTS process_rss_batch(JSONB);
DROP FUNCTION IF EXISTS check_url_duplicates_json(JSONB);

-- Message de confirmation
DO $$
BEGIN
    RAISE NOTICE '✅ Base de données initialisée avec succès !';
    RAISE NOTICE '📊 Tables créées : rss_articles, execution_logs';
    RAISE NOTICE '📈 Vues créées : article_stats';
    RAISE NOTICE '🔧 Fonctions créées : purge_old_articles(), get_source_stats()';
END $$;

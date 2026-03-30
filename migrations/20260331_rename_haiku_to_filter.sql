-- T019: haiku命名リネーム（モデル非依存の命名へ）
-- 本番D1に適用: wrangler d1 execute fx-sim-v1-db --remote --file=migrations/20260331_rename_haiku_to_filter.sql

-- 1. カラム名変更
ALTER TABLE news_raw RENAME COLUMN haiku_accepted TO filter_accepted;

-- 2. インデックス再作成（旧インデックスはカラム名変更で自動追従するが念のため）
DROP INDEX IF EXISTS idx_news_raw_source_accepted;
CREATE INDEX IF NOT EXISTS idx_news_raw_source_accepted ON news_raw(source, filter_accepted);

-- 3. キャッシュキーの旧プレフィックスをクリーンアップ（news_haiku_* → 自然消滅するが即時削除）
DELETE FROM market_cache WHERE key LIKE 'news_haiku_%';

-- news_trigger_log に個別スコア（relevance, sentiment）を追加
-- バッジ表示で判定基準スコアを表示するため
ALTER TABLE news_trigger_log ADD COLUMN relevance REAL;
ALTER TABLE news_trigger_log ADD COLUMN sentiment REAL;

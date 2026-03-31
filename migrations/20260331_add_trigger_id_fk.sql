-- news_trigger_log.id を FK として decisions, news_temp_params に追加
-- IPA SA §1.3: 1:N関連 → N側にFK追加（トレーサビリティ確保）
ALTER TABLE decisions ADD COLUMN trigger_id INTEGER REFERENCES news_trigger_log(id);
ALTER TABLE news_temp_params ADD COLUMN trigger_id INTEGER REFERENCES news_trigger_log(id);

-- trigger_id でのルックアップ用インデックス
CREATE INDEX IF NOT EXISTS idx_decisions_trigger_id ON decisions(trigger_id);
CREATE INDEX IF NOT EXISTS idx_news_temp_params_trigger_id ON news_temp_params(trigger_id);

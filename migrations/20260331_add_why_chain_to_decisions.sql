-- decisions テーブルに why_chain カラム追加（5Whys因果チェーンのJSON保存用）
ALTER TABLE decisions ADD COLUMN why_chain TEXT;

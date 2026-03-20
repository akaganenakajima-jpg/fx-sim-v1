-- Migration v2: 実弾投入対応
-- positions テーブルに source と oanda_trade_id を追加
-- instrument_scores テーブルを新規作成

-- positions 拡張
ALTER TABLE positions ADD COLUMN source TEXT DEFAULT 'paper';
-- 'paper' | 'oanda'

ALTER TABLE positions ADD COLUMN oanda_trade_id TEXT;
-- OANDAのトレードID（実弾時のみ）

-- 銘柄評価スコアテーブル
CREATE TABLE IF NOT EXISTS instrument_scores (
  pair           TEXT PRIMARY KEY,
  total_trades   INTEGER DEFAULT 0,
  win_rate       REAL DEFAULT 0,
  avg_rr         REAL DEFAULT 0,
  sharpe         REAL DEFAULT 0,
  correlation    REAL DEFAULT 0,
  score          REAL DEFAULT 0,
  updated_at     TEXT
);

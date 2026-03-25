CREATE TABLE IF NOT EXISTS positions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pair         TEXT    NOT NULL DEFAULT 'USD/JPY',
  direction    TEXT    NOT NULL,           -- 'BUY' | 'SELL'
  entry_rate   REAL    NOT NULL,
  tp_rate      REAL,
  sl_rate      REAL,
  lot          REAL    NOT NULL DEFAULT 1.0,
  status       TEXT    NOT NULL DEFAULT 'OPEN',  -- 'OPEN' | 'CLOSED'
  pnl          REAL,                       -- 損益（pip換算）
  entry_at     TEXT    NOT NULL,
  closed_at    TEXT,
  close_rate   REAL,
  close_reason TEXT,                       -- 'TP' | 'SL' | 'MANUAL'
  source       TEXT    DEFAULT 'paper',   -- 'paper' | 'oanda'
  oanda_trade_id TEXT                     -- OANDAトレードID（実弾時のみ）
);

CREATE TABLE IF NOT EXISTS decisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pair          TEXT    NOT NULL DEFAULT 'USD/JPY',
  rate          REAL    NOT NULL,
  decision      TEXT    NOT NULL,          -- 'BUY' | 'SELL' | 'HOLD'
  tp_rate       REAL,
  sl_rate       REAL,
  reasoning     TEXT,
  news_summary  TEXT,
  reddit_signal TEXT,                      -- 検出キーワード
  vix           REAL,
  us10y         REAL,
  nikkei        REAL,
  sp500         REAL,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS system_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL DEFAULT 'INFO',   -- 'INFO' | 'WARN' | 'ERROR'
  category   TEXT NOT NULL,                  -- 'CRON' | 'API_ERROR' | 'POSITION' | 'GEMINI' | 'RATE'
  message    TEXT NOT NULL,
  detail     TEXT,                           -- JSON文字列
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_cache (
  key        TEXT PRIMARY KEY,             -- 'us10y' など
  value      TEXT NOT NULL,               -- JSON文字列
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS news_fetch_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT    NOT NULL,        -- 'NHK', 'WSJ_Markets' 等
  ok              INTEGER NOT NULL,        -- 1=成功, 0=失敗
  latency_ms      INTEGER NOT NULL,        -- レスポンス時間(ms)
  item_count      INTEGER NOT NULL,        -- 取得記事数
  avg_freshness   INTEGER,                 -- 平均鮮度(分), null=算出不可
  created_at      TEXT    NOT NULL
);

-- ニュース生データ ステージングテーブル（ETL Extract層）
-- Haiku フィルタ前の全記事を保存し、採用/不採用フラグで追跡可能にする
CREATE TABLE IF NOT EXISTS news_raw (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  hash           TEXT    NOT NULL UNIQUE,     -- SHA-256(source + title) 重複排除
  source         TEXT    NOT NULL,            -- ソース名（'CNBC', 'Polygon' 等）
  title          TEXT    NOT NULL,
  description    TEXT,
  pub_date       TEXT,                        -- 記事の公開日時
  url            TEXT,
  fetched_at     TEXT    NOT NULL,            -- 取得日時（UTC）
  -- Haiku フィルタ結果
  haiku_accepted   INTEGER DEFAULT 0,           -- 0=未処理, 1=採用, -1=不採用
  title_ja         TEXT,                        -- 採用時: 日本語タイトル
  desc_ja          TEXT,                        -- 採用時: 日本語概要
  reject_reason    TEXT,                        -- 不採用時: 理由（「スポーツ」「重複」等）
  -- 多軸スコアリング（7軸評価）
  scores           TEXT,                        -- JSON: {timeliness,uniqueness,relevance,credibility,sentiment,breadth,novelty,composite}
  composite_score  REAL                         -- 加重合計スコア（0〜10）。閾値6.0以上で採用
);

CREATE INDEX IF NOT EXISTS idx_news_raw_fetched ON news_raw(fetched_at);
CREATE INDEX IF NOT EXISTS idx_news_raw_source_accepted ON news_raw(source, haiku_accepted);

-- パフォーマンス用インデックス（T002: IPA評価 🔴高優先）
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_pair_status ON positions(pair, status);
CREATE INDEX IF NOT EXISTS idx_decisions_pair_created ON decisions(pair, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_id_desc ON system_logs(id DESC);

-- アクティビティフィード: 指標変化ログ（RSI/ER変化をトリガーで記録）
CREATE TABLE IF NOT EXISTS indicator_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pair        TEXT    NOT NULL,          -- "S&P500", "USD/JPY" 等
  metric      TEXT    NOT NULL,          -- "RSI", "ER", "Stoch"
  prev_value  REAL    NOT NULL,          -- 変化前の値（例: 40.0）
  curr_value  REAL    NOT NULL,          -- 変化後の値（例: 38.0）
  direction   TEXT    NOT NULL,          -- "UP" | "DOWN"
  note        TEXT,                      -- "RSI 40→38"（人間読み取り用）
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_indicator_logs_created ON indicator_logs(created_at DESC);

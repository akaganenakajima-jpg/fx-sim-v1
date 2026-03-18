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
  close_reason TEXT                        -- 'TP' | 'SL' | 'MANUAL'
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

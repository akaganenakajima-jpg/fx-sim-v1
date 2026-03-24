-- migration v212: instrument_params テーブル追加（ロジックトレーディング用銘柄別パラメーター）
-- 設計根拠:
--   fx-strategy.md §2.2: RR2.0 × 勝率40% → EV=+0.20（正の期待値ライン）
--   kelly-rl.md §3: OGD逐次更新 — AIが定期レビューでパラメーターを調整
--   atr_tp / atr_sl 比 = tp_mult / sl_mult ≥ 2.0 を常に維持すること

-- ─── instrument_params: 銘柄別定量ロジックパラメーター ─────────────────────

CREATE TABLE IF NOT EXISTS instrument_params (
  pair                  TEXT    PRIMARY KEY,

  -- エントリー条件
  rsi_period            INTEGER NOT NULL DEFAULT 14,
  rsi_oversold          REAL    NOT NULL DEFAULT 35,   -- BUY: RSI < この値
  rsi_overbought        REAL    NOT NULL DEFAULT 65,   -- SELL: RSI > この値
  adx_period            INTEGER NOT NULL DEFAULT 14,
  adx_min               REAL    NOT NULL DEFAULT 25,   -- トレンド強度の最低値
  atr_period            INTEGER NOT NULL DEFAULT 14,

  -- TP/SL設定（ATR倍率）
  atr_tp_multiplier     REAL    NOT NULL DEFAULT 3.0,  -- TP = ATR × この値
  atr_sl_multiplier     REAL    NOT NULL DEFAULT 1.5,  -- SL = ATR × この値
  -- 不変条件: atr_tp_multiplier / atr_sl_multiplier >= 2.0

  -- フィルター
  vix_max               REAL    NOT NULL DEFAULT 35,   -- VIX > この値はスキップ
  require_trend_align   INTEGER NOT NULL DEFAULT 0,    -- 1=上位足MA一致必須
  regime_allow          TEXT    NOT NULL DEFAULT 'trending,ranging', -- カンマ区切り

  -- AI管理メタ情報
  review_trade_count    INTEGER NOT NULL DEFAULT 30,   -- 何トレードごとにレビューするか
  trades_since_review   INTEGER NOT NULL DEFAULT 0,    -- 前回レビューからのトレード数
  param_version         INTEGER NOT NULL DEFAULT 1,    -- パラメーター更新回数
  reviewed_by           TEXT    NOT NULL DEFAULT 'INITIAL', -- 'INITIAL'|'AI_vXX'|'MANUAL'
  last_reviewed_at      TEXT,

  -- ロールバック用
  prev_params_json      TEXT,   -- 前バージョンのパラメーターJSON

  updated_at            TEXT    NOT NULL
);

-- ─── param_review_log: AIパラメーターレビュー履歴 ──────────────────────────

CREATE TABLE IF NOT EXISTS param_review_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pair          TEXT    NOT NULL,
  param_version INTEGER NOT NULL,
  old_params    TEXT    NOT NULL,  -- 変更前パラメーターJSON
  new_params    TEXT    NOT NULL,  -- 変更後パラメーターJSON
  reason        TEXT    NOT NULL,  -- AIによる変更理由
  trades_eval   INTEGER NOT NULL,  -- 評価対象トレード件数
  win_rate      REAL,
  actual_rr     REAL,
  profit_factor REAL,
  reviewed_by   TEXT    NOT NULL,  -- 'AI_vXX' | 'MANUAL'
  created_at    TEXT    NOT NULL
);

-- ─── 初期データ: 全銘柄のデフォルトパラメーター ────────────────────────────
-- atr_tp=3.0 / atr_sl=1.5 → RR=2.0 ちょうど（目標の最低ライン）
-- 各銘柄の特性に合わせて adx_min と vix_max を調整

INSERT OR IGNORE INTO instrument_params
  (pair, rsi_period, rsi_oversold, rsi_overbought, adx_period, adx_min, atr_period,
   atr_tp_multiplier, atr_sl_multiplier, vix_max, require_trend_align, regime_allow,
   review_trade_count, trades_since_review, param_version, reviewed_by, updated_at)
VALUES
  -- FXメジャー（USD/JPY: Tier A、トレンドフォロー重視）
  ('USD/JPY',   14, 35, 65, 14, 25, 14, 3.0, 1.5, 35, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- FXメジャー（EUR/USD: Tier A）
  ('EUR/USD',   14, 35, 65, 14, 22, 14, 3.0, 1.5, 35, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- FXメジャー（GBP/USD: Tier B、高ボラのためADX緩め）
  ('GBP/USD',   14, 36, 64, 14, 22, 14, 3.0, 1.5, 35, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- FXメジャー（AUD/USD: Tier B）
  ('AUD/USD',   14, 35, 65, 14, 22, 14, 3.0, 1.5, 35, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- 株価指数（Nikkei225: Tier B、高ボラのためVIX制限緩め）
  ('Nikkei225', 14, 38, 62, 14, 20, 14, 3.0, 1.5, 40, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- 株価指数（S&P500: Tier B）
  ('S&P500',    14, 38, 62, 14, 20, 14, 3.0, 1.5, 35, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- 株価指数（DAX: Tier C、欧州時間依存）
  ('DAX',       14, 38, 62, 14, 22, 14, 3.0, 1.5, 35, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- 株価指数（NASDAQ: Tier C）
  ('NASDAQ',    14, 38, 62, 14, 20, 14, 3.0, 1.5, 35, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- 株価指数（UK100: Tier B）
  ('UK100',     14, 38, 62, 14, 22, 14, 3.0, 1.5, 35, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- 株価指数（HK33: Tier C、高ボラ）
  ('HK33',      14, 40, 60, 14, 20, 14, 3.0, 1.5, 40, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- 貴金属（Gold: Tier A、地政学リスク連動）
  ('Gold',      14, 35, 65, 14, 20, 14, 3.0, 1.5, 40, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- 貴金属（Silver: Tier C）
  ('Silver',    14, 35, 65, 14, 22, 14, 3.0, 1.5, 40, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- 貴金属（Copper: Tier C）
  ('Copper',    14, 35, 65, 14, 22, 14, 3.0, 1.5, 35, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- エネルギー（CrudeOil: Tier C）
  ('CrudeOil',  14, 38, 62, 14, 22, 14, 3.0, 1.5, 40, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- エネルギー（NatGas: Tier C、高ボラ）
  ('NatGas',    14, 40, 60, 14, 20, 14, 3.0, 1.5, 45, 0, 'trending,ranging', 30, 0, 1, 'INITIAL', datetime('now')),

  -- 暗号資産（SOL/USD: Tier D、高ボラのためADX最低限）
  ('SOL/USD',   14, 40, 60, 14, 18, 14, 3.5, 1.5, 50, 0, 'trending',         30, 0, 1, 'INITIAL', datetime('now'));

-- ─── schema_version 更新 ─────────────────────────────────────────────────────
INSERT INTO schema_version (version, description, applied_at)
VALUES (212, 'instrument_params + param_review_log テーブル追加（ロジックトレーディング Ph.1）', datetime('now'));

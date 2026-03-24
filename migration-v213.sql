-- migration v213: news_temp_params テーブル追加（ニューストリガー Ph.5）
-- 設計根拠:
--   ニュースモードB: 緊急ニュース（relevance>=9 AND sentiment>=8）→ PATH_Bを強制発火
--   臨時パラメーター: トレンド影響ニュース（relevance>=7 AND sentiment>=7）→
--     AIが期限付き上書きパラメーターを設定しロジックエントリーの条件を変更する

-- ─── news_temp_params: 臨時パラメーター（ニュートリガー適用）────────────────

CREATE TABLE IF NOT EXISTS news_temp_params (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  pair                  TEXT    NOT NULL,
  event_type            TEXT    NOT NULL DEFAULT 'TREND_INFLUENCE',
                                          -- 'TREND_INFLUENCE' | 'EMERGENCY'
  -- NULLの場合は instrument_params の通常値を使用（部分上書き）
  rsi_oversold          REAL,
  rsi_overbought        REAL,
  adx_min               REAL,
  atr_tp_multiplier     REAL,
  atr_sl_multiplier     REAL,
  vix_max               REAL,

  reason                TEXT    NOT NULL, -- AIによる設定理由
  news_title            TEXT,             -- トリガーとなったニュースタイトル
  news_score            REAL,             -- composite_score

  -- 有効期限（この日時を過ぎたら自動無効 → ロジックは通常パラメーターに戻る）
  expires_at            TEXT    NOT NULL,
  applied_by            TEXT    NOT NULL DEFAULT 'SYSTEM', -- 'AI_NEWS_v1' | 'SYSTEM'
  created_at            TEXT    NOT NULL
);

-- 有効な臨時パラメーターをpair+expires_atで高速検索
CREATE INDEX IF NOT EXISTS idx_news_temp_params_pair_expires
  ON news_temp_params (pair, expires_at);

-- ─── news_trigger_log: ニューストリガー発火ログ ────────────────────────────

CREATE TABLE IF NOT EXISTS news_trigger_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type  TEXT    NOT NULL,   -- 'EMERGENCY' | 'TREND_INFLUENCE' | 'NONE'
  news_title    TEXT,
  news_score    REAL,
  affected_pairs TEXT,              -- カンマ区切り（臨時パラメーター適用銘柄）
  detail        TEXT,
  created_at    TEXT    NOT NULL
);

-- ─── schema_version 更新 ─────────────────────────────────────────────────────
INSERT INTO schema_version (version, description, applied_at)
VALUES (213, 'news_temp_params + news_trigger_log テーブル追加（ニューストリガー Ph.5）', datetime('now'));

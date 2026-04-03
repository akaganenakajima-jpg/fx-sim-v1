-- Ph.10: SMAベースMTF + BBスクイーズ・ブレイクアウト用パラメーター追加
-- migration.ts v230-233 と同内容（手動適用用）
-- wrangler d1 execute fx-sim-v1-db --file=20260403_ph10_sma_bb_breakout.sql --remote

ALTER TABLE instrument_params ADD COLUMN sma_short_period INTEGER NOT NULL DEFAULT 10;
ALTER TABLE instrument_params ADD COLUMN sma_long_period  INTEGER NOT NULL DEFAULT 40;
ALTER TABLE instrument_params ADD COLUMN volatility_ratio_min REAL NOT NULL DEFAULT 0.8;
ALTER TABLE instrument_params ADD COLUMN sma_angle_min    REAL NOT NULL DEFAULT 0.0;

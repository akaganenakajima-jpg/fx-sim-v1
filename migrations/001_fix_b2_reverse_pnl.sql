-- T017: id=606 B2_REVERSE Gold の pnl 誇大計上修正
-- 修正前: pnl≈2410.0（multiplier=100 が誤適用、浮動小数点で 2410.0000000000364）
-- 修正後: pnl=241.0（正しい multiplier=10）、log_return=0.005390
-- 安全ガード: pnl が 2410 前後の場合のみ更新（浮動小数点対応）
UPDATE positions
SET pnl = 241.0,
    log_return = 0.005390
WHERE id = 606
  AND pnl > 2409.0
  AND pnl < 2411.0;

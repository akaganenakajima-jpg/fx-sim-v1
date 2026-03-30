-- T018: WEEKEND クローズレコードの realized_rr=0 を NULL に修正
-- 原因: 修正前コードが realized_rr を計算せず 0 で保存していた
-- sl_rate IS NULL のレコードは realized_rr を計算できないため NULL が正しい
UPDATE positions
SET realized_rr = NULL
WHERE close_reason = 'WEEKEND'
  AND realized_rr = 0
  AND sl_rate IS NULL;

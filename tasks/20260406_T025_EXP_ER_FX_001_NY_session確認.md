# T025: EXP-ER-FX-001 NYセッション確認 → GO/NO-GO判定

## 背景・目的

NEUTRAL_ER が全セッションで支配的（London 63.9%）であることが確認済み。
FX主要5ペアの adx_min を 28→22 に下げる実験（EXP-ER-FX-001）を、
NY session データで確認したうえで GO/NO-GO 判定する。

## ロンドンセッション baseline（2026-04-06 08:26-08:52 UTC / 28 ticks）

| カテゴリ | /tick | NEUTRAL内% |
|---|---|---|
| NEUTRAL_ER | 23 | 63.9% |
| NEUTRAL_REGIME | 8 | 22.2% |
| NEUTRAL_RSI | 5 | 13.9% |
| NEUTRAL_MACD | 0 | 0% |

ファイル: `C:/Users/GENPOOH/Desktop/fx_baseline.json`

## GO条件

- NY session でも NEUTRAL_ER が最大カテゴリ
- NEUTRAL_ER ≥ 40%
- NEUTRAL_MACD / NEUTRAL_RSI が主因に逆転していない
- DAX実験（id=677, SELL@23168）に重大な異常がない

## 実験対象（GO時のSQL）

```sql
INSERT INTO news_temp_params (pair, event_type, adx_min, expires_at, created_at) VALUES
  ('EUR/USD', 'EXPERIMENT_ER', 22, '2026-04-13T00:00:00Z', datetime('now')),
  ('GBP/USD', 'EXPERIMENT_ER', 22, '2026-04-13T00:00:00Z', datetime('now')),
  ('EUR/JPY', 'EXPERIMENT_ER', 22, '2026-04-13T00:00:00Z', datetime('now')),
  ('GBP/JPY', 'EXPERIMENT_ER', 22, '2026-04-13T00:00:00Z', datetime('now')),
  ('AUD/JPY', 'EXPERIMENT_ER', 22, '2026-04-13T00:00:00Z', datetime('now'));
```

## 現在の状況（2026-04-06 セッション終了時点）

- Cron 117b67be は session-only でセッション切れにより消滅
- NY session (UTC 13:30-) のデータ取得が必要（JST 22:30以降）
- 現在時刻: JST 約20:00 → NY open まで約2.5時間

## 次のアクション

- [ ] NYセッション（UTC 13:30以降）に D1 から NEUTRAL 分布を集計
  ```sql
  SELECT detail FROM system_logs
  WHERE category='FLOW' AND message LIKE 'LOGIC完了%'
  AND created_at >= '2026-04-06T13:30:00Z'
  ORDER BY created_at DESC LIMIT 10
  ```
- [ ] GO条件チェック
- [ ] GO なら INSERT 実行（wrangler d1 execute）
- [ ] NO-GO なら理由を記録して観察継続

## 成功指標（7日間）

- 5ペアのうち ≥1件がエントリー
- NEUTRAL_ER比率の低下（63.9% → 50%以下）
- avgRR ≥ 0.3

## ロールバック条件

- 1日損失 ≤ -2000円
- avgRR < 0.0（10件以上）
- エントリー件数が増加していない

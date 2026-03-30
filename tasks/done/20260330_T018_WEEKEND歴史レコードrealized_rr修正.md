# T018 WEEKEND クローズ歴史的レコードの realized_rr=0 調査

**作成日**: 2026-03-30
**優先度**: 🟡 低
**発見経緯**: E2E Cycle 10 Round 5（Agent B15.10）

---

## 背景・目的

今セッション（2026-03-30）で `forceCloseAllForWeekend()` に `log_return` / `realized_rr`
計算を追加したが、修正前に記録された WEEKEND クローズレコード（id=592 等）には
`realized_rr = 0` が設定されている（`log_return` は NULL）。

`realized_rr = 0` は「RR が丁度 0.0」という意味になり、統計上 "負け" として扱われる。
pnl が -2.2 などの損失であれば realized_rr は負値であるべき。

## 対象レコード

```sql
SELECT id, pair, direction, pnl, log_return, realized_rr, sl_rate
FROM positions
WHERE close_reason = 'WEEKEND'
ORDER BY id DESC LIMIT 10
```

実測値（直近5件）:
| id | pnl | log_return | realized_rr | sl_rate |
|---|---|---|---|---|
| 592 | -2.2 | NULL | 0 | ? |
| 583 | -1.x | NULL | 0 | ? |
| 582 | -x.x | NULL | 0 | ? |
| 194 | -x.x | NULL | ? | ? |
| 129 | -x.x | NULL | ? | ? |

## 調査手順

1. id=592 等の sl_rate が NULL か確認
   - sl_rate が NULL なら realized_rr の計算自体ができないため 0 が正しい動作
   - sl_rate が存在するなら計算漏れでバグ
2. 修正後コード（weekend.ts）で `sl_rate IS NULL` の場合 `undefined` を渡す設計を確認
   - `realized_rr = pos.sl_rate != null ? calcRealizedRR(...) : undefined`
   - undefined は DB では NULL として保存されるはずなので 0 が入るのは別の原因

## 修正方針

- sl_rate が NULL → realized_rr は NULL（0 ではない）が正しい
- 原因が確認されたら SQL で歴史的レコードを修正:
  ```sql
  UPDATE positions
  SET realized_rr = NULL
  WHERE close_reason = 'WEEKEND' AND realized_rr = 0 AND sl_rate IS NULL
  ```
- 今後の WEEKEND クローズは修正済みコードで正しく NULL が設定される

## 完了条件

- 歴史的 WEEKEND レコードで realized_rr=0 かつ sl_rate=NULL のレコードが修正されること
  または realized_rr=0 が仕様として正しいことが確認されること

---

**ステータス**: 未着手

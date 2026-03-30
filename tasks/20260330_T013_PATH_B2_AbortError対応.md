# T013 PATH_B2（Gemini）AbortError 断続的タイムアウト対応

**作成日**: 2026-03-30
**優先度**: 🟠 中
**発見経緯**: E2E Cycle 8〜10（バックエンドE2Eチェック）
**関連タスク**: T012（cron実行時間超過）— 根本原因が共通

---

## 背景・目的

PATH_B2（Gemini による二段階判断）が AbortError（タイムアウト）で断続的に失敗している。
B2失敗時は「B1シグナルそのまま採用」のフォールバックが機能しているため完全停止はしていないが、
AI の二段階クロスチェックが機能しない時間帯が生まれており、判断精度が低下している。

## 現象

```
system_logs（直近1時間で8件）:
  "B2失敗→B1シグナルそのまま採用": AbortError: The operation was aborted
  "Path B実行失敗": AbortError: The operation was aborted
  "B1失敗→2分クールダウン": AbortError: The operation was aborted
```

- B2 の `token_usage` 最終記録: `2026-03-30T01:22:28Z`（約2時間空白）
- b2_consecutive_fails が 4〜5 に達しサーキットブレーカー発動直前になることがある

## 推定原因

1. **T012 のcron時間超過が原因**: cron全体が 110〜140秒かかっており、
   B2 への HTTP リクエストが Workers のウォールクロック残時間不足で中断される
2. B2 の API タイムアウト設定が短すぎる（gemini-2.5-flash の応答が遅い時に切れる）

## 調査手順

1. `src/index.ts` または `src/gemini.ts` の B2 呼び出し箇所のタイムアウト設定を確認
   - `AbortController` のタイムアウト値（ms）を確認
2. B2 AbortError の発生タイミングと cron 実行経過時間の相関を確認
   - AbortError が発生した cron の grandTotalMs を照合
3. b2_consecutive_fails のサーキットブレーカー閾値を確認（現在 5）

## 修正方針

- T012（cron時間超過）を先に解決することで自然に改善する可能性が高い
- T012 が解決しない場合: B2 の AbortController タイムアウトを延長（例: 10秒→20秒）
- B2 専用の軽量 cron（30秒おき）への分離も選択肢

## 完了条件

- B2 AbortError の発生件数が直近1時間で 0〜1件に減少すること
- `token_usage` に `PATH_B2_GEMINI` が定期的に記録されること

---

**ステータス**: 未着手（T012 完了後に着手推奨）

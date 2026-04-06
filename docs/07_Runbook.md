# 07 運用・トラブルシューティング手順書（Runbook）

> **対象システム**: fx-sim-v1（Cloudflare Workers + D1）
> **更新日**: 2026-04-06
> **本文書の位置づけ**: 本番運用中に何か起きたとき、最初に読むドキュメント

---

## 目次

1. [システム概要と監視の基本](#1-システム概要と監視の基本)
2. [異常停止（DD STOP / HALT）の対応フロー](#2-異常停止dd-stop--haltの対応フロー)
3. [AI・ニュース機能のトラブルシュート](#3-aiニュース機能のトラブルシュート)
4. [データとインフラの保守](#4-データとインフラの保守)
5. [外部API障害時の挙動](#5-外部api障害時の挙動)
6. [緊急コマンド集](#6-緊急コマンド集)

---

## 1. システム概要と監視の基本

### 1.1 Cron スケジュール

| Cron 式 | 処理 | ファイル |
|---|---|---|
| `* * * * *`（毎分） | 価格取得・TP/SL判定・ロジックトレード | `core-workflow.ts` |
| `*/5 * * * *`（5分毎） | Gemini AI分析・ニューストリガー・BreakOut | `analysis-workflow.ts` |
| `0 15 * * *`（UTC 15:00 = JST 0:00） | 日次タスク（ログパージ・銘柄スコア更新） | `daily-workflow.ts` |
| `0 21 * * *`（UTC 21:00 = JST 6:00） | プレマーケット分析 | `daily-workflow.ts` |
| `0 18 * * 6`（土曜 UTC 18:00） | 週次レビュー生成 | `daily-workflow.ts` |

### 1.2 ログ確認方法

```bash
# リアルタイムログ
wrangler tail --format=pretty

# D1 直近50件のシステムログ
wrangler d1 execute fx-sim-v1-db --command="SELECT level, category, message, created_at FROM system_logs ORDER BY id DESC LIMIT 50;" --remote

# ダッシュボードのログタブ
# https://fx-sim-v1.ai-battle-sim.workers.dev/ → ログタブ
```

### 1.3 正常稼働の目安

| 指標 | 正常範囲 | 異常の判断基準 |
|---|---|---|
| cron 実行間隔 | 毎分〜5分 | 10分以上ログ更新なし |
| Gemini 呼び出し | 日50〜200回 | 0回/日 または 500回超/日 |
| ニュース採用率 | 20〜80% | 0% が 30件連続（CB発動） |
| OPEN ポジション数 | 0〜10件 | 10件超（バグの可能性） |
| DD 水準 | NORMAL | HALT/STOP |

---

## 2. 異常停止（DD STOP / HALT）の対応フロー

### 2.1 DD 段階の定義

システムは HWM（高値更新額）からのドローダウンを常時監視し、5段階で制御する。

> **⚠️ 重要**: `global_dd_enabled` が `false`（デフォルト・仮想トレード中）の場合、DDが何%になっても NORMAL として動作する。これは仕様。実弾投入後に `true` に切り替えること。

| 段階 | DD% 閾値 | ロット倍率 | 動作 |
|---|---|---|---|
| NORMAL | < 7% | 1.0（Full Kelly） | 通常稼働 |
| CAUTION | ≥ 7% | 0.5（Half Kelly） | ロット半減 |
| WARNING | ≥ 10% | 0.25（Quarter Kelly） | ロット75%削減 |
| **HALT** | **≥ 15%** | **0.1（Micro Kelly）** | **最小ロットで検証継続** |
| **STOP** | **≥ 20%** | **0（完全停止）** | **手動解除まで新規エントリー不可** |

定数ソース: `src/constants.ts` (`DD_CAUTION=7`, `DD_WARNING=10`, `DD_HALT=15`, `DD_STOP=20`)

### 2.2 HALT 発動時の確認手順

**症状**: ダッシュボードの DD 欄が「HALT」表示。ログに `DD HALT: XX.X% — ロット縮小` が記録される。

```
HALT = 完全停止ではない。lotMultiplier=0.1 で最小ロットのトレードは継続する。
```

**確認ステップ**:

1. **現在の残高と HWM を確認する**
   ```bash
   wrangler d1 execute fx-sim-v1-db --command="SELECT key, value FROM risk_state WHERE key IN ('hwm', 'dd_stopped');" --remote
   ```

2. **直近のポジション損益を確認する**
   ```bash
   wrangler d1 execute fx-sim-v1-db --command="SELECT pair, pnl, close_reason, closed_at FROM positions WHERE status='CLOSED' ORDER BY id DESC LIMIT 20;" --remote
   ```

3. **SL連続ヒットか、特定銘柄の問題か特定する**
   ```bash
   wrangler d1 execute fx-sim-v1-db --command="SELECT pair, COUNT(*) as cnt, SUM(pnl) as total_pnl FROM positions WHERE status='CLOSED' AND closed_at >= datetime('now','-1 day') GROUP BY pair ORDER BY total_pnl ASC;" --remote
   ```

4. **ダッシュボードで確認**: 学びタブ → 最大DD の値を確認

HALT は自動回復（SPRT判定による昇降）する設計のため、損失が止まれば自然回復する。

### 2.3 STOP 発動時の復旧手順（ダッシュボードからの再稼働）

**症状**: ダッシュボードに「⚠️ システム停止中」バナーが表示され、「再稼働」ボタンが出現。

**復旧手順**:

#### 方法A: ダッシュボードから（推奨）

1. ブラウザで `https://fx-sim-v1.ai-battle-sim.workers.dev/` を開く
2. ホームタブに赤いバナー「システム停止中 — DD STOP が発動しています」が表示されていることを確認
3. **「再稼働」ボタンをクリック**
4. ダッシュボードが自動リロードされ、バナーが消えることを確認

#### 方法B: D1 に直接書き込む（ダッシュボードにアクセスできない場合）

```bash
# dd_stopped を false にリセット
wrangler d1 execute fx-sim-v1-db --command="UPDATE risk_state SET value='false', updated_at=datetime('now') WHERE key='dd_stopped';" --remote

# アセットクラス別もリセット
wrangler d1 execute fx-sim-v1-db --command="UPDATE risk_state SET value='false' WHERE key LIKE 'dd_stopped:%';" --remote

# 確認
wrangler d1 execute fx-sim-v1-db --command="SELECT key, value FROM risk_state WHERE key LIKE 'dd_stopped%';" --remote
```

**再稼働後の確認事項**:
- ログに `システムを再稼働しました（DD STOP解除）` が記録されるか確認
- 次の cron（最大5分後）でトレードが再開されるか `wrangler tail` で確認
- STOP 発動の原因（どの銘柄が大きく負けたか）を分析し、`instrument_params` の調整を検討

### 2.4 RiskGuard 発動時の確認

RiskGuard は OANDA 実弾発注専用の第2関門（仮想トレードでは通過する）。

発動条件（`src/risk-guard.ts`）:

| チェック項目 | デフォルト上限 | Secret 名 |
|---|---|---|
| 日次最大損失 | ¥500 | `RISK_MAX_DAILY_LOSS` |
| 最大実弾ポジション数 | 5件 | `RISK_MAX_LIVE_POSITIONS` |
| 最大ロットサイズ | （設定値） | `RISK_MAX_LOT_SIZE` |
| 価格変動異常（レートスパイク） | （設定値） | `RISK_ANOMALY_THRESHOLD` |

```bash
# RiskGuard を一時的に厳しくする例（日次損失上限を¥300に下げる）
wrangler secret put RISK_MAX_DAILY_LOSS
# 入力: 300
```

---

## 3. AI・ニュース機能のトラブルシュート

### 3.1 Gemini タイムアウト（Cloudflare Workers 15秒制限）

**症状**: ログに `[gemini] timeout` / `AbortError` が記録される。

**実装上の挙動** (`src/gemini.ts`):

- AI API 呼び出しには **15秒タイムアウト** (`AI_TIMEOUT_MS = 15_000`) が設定されている
- タイムアウト発生 → `RateLimitError` または `null` を返す
- `analysis-workflow.ts` の **サーキットブレーカー** が3回連続失敗を検知すると **1分間 AI 停止** (`CB_OPEN_DURATION_MS = 60_000`)

```
サーキットブレーカー状態遷移:
  CLOSED（正常）→ 連続3回失敗 → OPEN（1分停止）→ 自動 HALF_OPEN →
  次回成功で CLOSED に戻る
```

**確認・対処手順**:

1. **タイムアウトが頻発しているか確認**
   ```bash
   wrangler d1 execute fx-sim-v1-db --command="SELECT message, created_at FROM system_logs WHERE message LIKE '%timeout%' OR message LIKE '%AbortError%' ORDER BY id DESC LIMIT 10;" --remote
   ```

2. **Gemini API の稼働状態を確認**
   - Google AI Studio: https://aistudio.google.com/
   - Gemini API ステータス: https://status.cloud.google.com/

3. **API キーのローテーション確認**
   ```bash
   # 現在設定されているキー数を確認
   wrangler secret list
   # GEMINI_API_KEY, GEMINI_API_KEY_2〜5 が設定されているか
   ```

4. **タイムアウトが続く場合 → キーをローテーション**
   ```bash
   wrangler secret put GEMINI_API_KEY
   # 別のキーを入力
   ```

5. **Gemini が全滅している場合 → GPT フォールバック**
   - `OPENAI_API_KEY` が設定されていれば自動フォールバック（`gemini.ts` の `getDecisionWithHedge` を参照）
   - 設定されていなければ AI 判断をスキップして HOLD

### 3.2 ニュース採用率 0% 問題

**症状**: ダッシュボードのヘルスチェックで「採用率 0%」が表示される。ニュース分析が機能していない。

**原因の優先度順チェックリスト**:

#### 【原因①】適応閾値が高すぎる（最頻）

`getAdaptiveCompositeThreshold()` が過去200件の平均スコアを基に閾値を自動調整するが、全拒否が続くと閾値が高止まりする。

**確認**:
```bash
wrangler d1 execute fx-sim-v1-db --command="SELECT filter_accepted, composite_score FROM news_raw WHERE filter_accepted IS NOT NULL ORDER BY id DESC LIMIT 30;" --remote
```

**サーキットブレーカー（自動対処）**:
直近30件で採用率0件が続いた場合、閾値を強制的に **4.5（緊急下限）** にリセットする仕組みが `src/news.ts` に実装済み。`system_logs` に以下が記録される:
```
[news] adaptive-threshold: circuit-breaker OPEN — 直近30件全拒否。緊急閾値 4.5 を使用
```

**手動介入（CBが発動しない場合）**:
```bash
# news_filter キャッシュを削除して閾値をリセット
wrangler d1 execute fx-sim-v1-db --command="DELETE FROM market_cache WHERE key LIKE 'news_filter_%';" --remote
```

#### 【原因②】Gemini がフィルタを厳しく判定している

`thinkingBudget:0`（高速モード）は「疑わしければ拒否」に傾きやすい。

**確認**: `src/news.ts` の `recentTopicsSection` プロンプトに `【基本方針】迷ったら採用` が含まれているか確認する（PR #161 以降は実装済み）。

#### 【原因③】ニュースソースが全滅している

```bash
# 直近のニュース取得状況を確認
wrangler d1 execute fx-sim-v1-db --command="SELECT source, COUNT(*) as cnt, MAX(fetched_at) as last_fetch FROM news_raw GROUP BY source ORDER BY last_fetch DESC LIMIT 10;" --remote
```

各ソース（Reuters RSS / Reddit / Bloomberg 等）が取得できているか確認する。ソース障害の場合は外部サイトにアクセスして直接確認。

#### 【原因④】`news_raw` テーブルの TTL パージ遅延

`purgeOldNewsRaw()` は7日以上前のレコードを削除する。パージが遅れると `composite_score` の分布が歪む。

```bash
# news_raw の件数確認
wrangler d1 execute fx-sim-v1-db --command="SELECT COUNT(*) as cnt, MIN(fetched_at) as oldest FROM news_raw;" --remote
```

### 3.3 ニューストリガーが発火しない

**症状**: ニュースは採用されているが、取引が発動しない。

**確認ポイント**:

1. **スコア閾値を確認**（`src/constants.ts`）
   - `NEWS_SCORE_EMERGENCY = 90`（強制発火）
   - `NEWS_SCORE_TREND = 70`（パラメーター調整）
   - 採用済みニュースの `composite_score` を確認:
   ```bash
   wrangler d1 execute fx-sim-v1-db --command="SELECT composite_score, headline, filter_accepted FROM news_raw WHERE filter_accepted=1 ORDER BY id DESC LIMIT 10;" --remote
   ```

2. **週末制限を確認**（FX/株指数は金 21:00 UTC 〜 日 22:00 UTC は取引不可）
   ```bash
   wrangler d1 execute fx-sim-v1-db --command="SELECT value FROM market_cache WHERE key='weekend_status';" --remote
   ```

3. **OPEN ポジション上限を確認**
   ```bash
   wrangler d1 execute fx-sim-v1-db --command="SELECT COUNT(*) as open_count FROM positions WHERE status='OPEN';" --remote
   ```

---

## 4. データとインフラの保守

### 4.1 D1 データベースの容量管理

#### 自動パージ（`daily-workflow.ts` が毎日 UTC 15:00 に実行）

| テーブル | パージ条件 |
|---|---|
| `system_logs` | 最新5000件を超えた古いもの + 30日以上前のレコード |
| `news_fetch_log` | 最新5000件を超えた古いもの + 30日以上前のレコード |
| `news_raw` | `purgeOldNewsRaw()` が7日以上前を削除 |
| `market_cache` | `news_filter_*` キー（2時間以上前） + 7日以上前の全キー（`screener_results` 除く） |
| `news_temp_params` | `expires_at` を過ぎたレコード |
| `b2_consecutive_fails` | CB解除済みの場合のみ削除 |

#### 手動パージ（容量逼迫時）

```bash
# 各テーブルの件数確認
wrangler d1 execute fx-sim-v1-db --command="SELECT 'system_logs' as tbl, COUNT(*) as cnt FROM system_logs UNION ALL SELECT 'news_raw', COUNT(*) FROM news_raw UNION ALL SELECT 'positions', COUNT(*) FROM positions UNION ALL SELECT 'decisions', COUNT(*) FROM decisions;" --remote

# 古い decisions を手動パージ（90日以上前）
wrangler d1 execute fx-sim-v1-db --command="DELETE FROM decisions WHERE created_at < datetime('now','-90 days');" --remote

# 古い positions（クローズ済み・180日以上前）
wrangler d1 execute fx-sim-v1-db --command="DELETE FROM positions WHERE status='CLOSED' AND closed_at < datetime('now','-180 days');" --remote
```

> **⚠️ 注意**: `positions` の削除は実績データの消失に繋がる。パージ前に必要ならエクスポートすること。

### 4.2 フロントエンドの遅延ロード構造

#### 遅延ロードの仕組み（`public/app.js`）

初期ロードは `/api/status` のみ。他のデータはタブを開いた時点で初めてフェッチする:

| タブ | フェッチ先 | キャッシュ変数 |
|---|---|---|
| ホーム（初期） | `/api/status` | `lastData` |
| 学び（Stats） | `/api/history` | `historyData` |
| ニュース / AI | `/api/news` | `newsData` |
| ログ | `/api/logs` | `logsData` |
| 戦略 | `/api/params` | `paramsData` |

#### APIエラー時のフォールバック動作

各タブの遅延ロードは `.catch(function(){})` で例外を無視する。失敗した場合:

- そのタブのデータは表示されず「データ蓄積中...」などのプレースホルダーが残る
- ホームタブのデータ（`/api/status`）は 30秒間隔でポーリングするため、API が回復すれば自動復旧

**ダッシュボードが真っ白になる場合**:
```bash
# Worker の起動エラーを確認
wrangler tail --format=pretty

# D1 への接続確認
wrangler d1 execute fx-sim-v1-db --command="SELECT 1;" --remote
```

### 4.3 マイグレーション管理

スキーマ変更は `src/migration.ts` で管理。バージョンは `schema_version` テーブルに記録される。

```bash
# 現在のスキーマバージョンを確認
wrangler d1 execute fx-sim-v1-db --command="SELECT version FROM schema_version ORDER BY version DESC LIMIT 1;" --remote

# マイグレーション未適用の場合（手動ファイル適用）
wrangler d1 execute fx-sim-v1-db --file=20260403_ph10_sma_bb_breakout.sql --remote
```

---

## 5. 外部API障害時の挙動

### 5.1 価格データ API（Twelve Data / Yahoo Finance / frankfurter）

価格が取得できない場合、`core-workflow.ts` の `buildPricesMap()` が D1 の `market_cache` から直前レートをフォールバック使用する。

```
livePrices に null が入った銘柄 → market_cache の prev_rate_{pair} を参照
→ キャッシュもない場合 → prices.set(pair, null)
→ null の銘柄はその cron サイクルでの取引対象から除外
```

**確認方法**:
```bash
# どの銘柄がフォールバックを使っているか
wrangler d1 execute fx-sim-v1-db --command="SELECT message FROM system_logs WHERE message LIKE '%fallback%' ORDER BY id DESC LIMIT 10;" --remote

# キャッシュされているレートを確認
wrangler d1 execute fx-sim-v1-db --command="SELECT key, value, updated_at FROM market_cache WHERE key LIKE 'prev_rate_%' LIMIT 10;" --remote
```

### 5.2 Reuters RSS / ニュースソース障害

ニュースフェッチは `src/news.ts` の `fetchNews()` で複数ソースを並列取得する。1ソースが失敗しても他ソースのニュースで継続。

**全ソース障害時**:
- `news.items` が空配列になる
- ニューストリガー（Path B の NEWS 経由エントリー）はスキップ
- ロジックトレード（Logic 経由）は影響なし

### 5.3 Gemini API レート制限（429 Too Many Requests）

4層防御が実装済み (`src/workflows/analysis-workflow.ts`, `src/env.ts`):

1. **キー別クールダウン**: 429 受信後、そのキーを一定時間使用不可としてマーク
2. **キーローテーション**: `GEMINI_API_KEY_2〜5` への自動切り替え
3. **サーキットブレーカー**: 連続3回失敗で1分停止
4. **GPT B1 ヘッジ**: Gemini が全キー使用不可の場合、`OPENAI_API_KEY` でフォールバック

**ログで確認**:
```bash
wrangler d1 execute fx-sim-v1-db --command="SELECT message, created_at FROM system_logs WHERE message LIKE '%429%' OR message LIKE '%RateLimit%' ORDER BY id DESC LIMIT 10;" --remote
```

### 5.4 OANDA API 障害（実弾モード時のみ）

OANDA API には **10秒タイムアウト** (`OANDA_TIMEOUT_MS = 10_000`) が設定。

障害時の動作:
- タイムアウト → `{ ok: false, data: { error: "OANDA timeout (10000ms)" } }` を返す
- 発注失敗 → ポジションを `paper`（仮想）として記録し、ログにエラーを残す
- `TRADING_ENABLED='false'` に設定すれば即座に全銘柄ペーパーモードへ切り替え

```bash
# 緊急時: 実弾発注を全停止してペーパーモードへ
wrangler secret put TRADING_ENABLED
# 入力: false
```

---

## 6. 緊急コマンド集

### 基本確認

```bash
# リアルタイムログ監視
wrangler tail --format=pretty

# システム状態サマリー
wrangler d1 execute fx-sim-v1-db --command="
SELECT
  (SELECT COUNT(*) FROM positions WHERE status='OPEN') as open_positions,
  (SELECT COALESCE(SUM(pnl),0) FROM positions WHERE status='CLOSED') as total_pnl,
  (SELECT value FROM risk_state WHERE key='dd_stopped') as dd_stopped,
  (SELECT value FROM risk_state WHERE key='hwm') as hwm,
  (SELECT value FROM risk_state WHERE key='global_dd_enabled') as dd_enabled;
" --remote
```

### STOP/HALT 解除

```bash
# DD STOP 手動解除（ダッシュボードが使えない時）
wrangler d1 execute fx-sim-v1-db --command="
  UPDATE risk_state SET value='false', updated_at=datetime('now') WHERE key='dd_stopped';
  UPDATE risk_state SET value='false' WHERE key LIKE 'dd_stopped:%';
" --remote
```

### ニュース CB リセット

```bash
# news_filter キャッシュをクリア（採用率0%の緊急対処）
wrangler d1 execute fx-sim-v1-db --command="DELETE FROM market_cache WHERE key LIKE 'news_filter_%';" --remote
```

### 全ポジション緊急クローズ

```bash
# 現在のレートで全 OPEN ポジションを強制クローズ（pnl=0 の仮処理）
# ⚠️ 実弾モードでは OANDA 側も手動でクローズすること
wrangler d1 execute fx-sim-v1-db --command="
  UPDATE positions SET status='CLOSED', close_reason='MANUAL', closed_at=datetime('now'), pnl=0
  WHERE status='OPEN';
" --remote
```

### Secrets 確認・更新

```bash
# 設定済みシークレット一覧
wrangler secret list

# Gemini API キー更新
wrangler secret put GEMINI_API_KEY

# 実弾停止（緊急）
wrangler secret put TRADING_ENABLED   # 入力: false

# RiskGuard 日次損失上限を厳しく
wrangler secret put RISK_MAX_DAILY_LOSS  # 入力: 300
```

### デプロイとロールバック

```bash
# 通常デプロイ
npx wrangler deploy

# 型チェック
npx tsc --noEmit

# テスト
npm test

# ロールバック（直前バージョンに戻す）
wrangler rollback
```

---

## 付録: risk_state テーブルの主要キー

| キー | 型 | 説明 |
|---|---|---|
| `hwm` | float 文字列 | High Water Mark（全期間最高残高） |
| `dd_stopped` | `'true'/'false'` | グローバル DD STOP フラグ |
| `dd_stopped:FX` 等 | `'true'/'false'` | アセットクラス別 STOP フラグ |
| `global_dd_enabled` | `'true'/'false'` | DD 管理の有効/無効（デフォルト: `false`） |
| `dd_paused_until` | ISO 文字列 または `''` | 旧方式の一時停止（現在は未使用・互換用） |

---

*本ドキュメントは実装（`src/` 配下のコード）を正とする。実装が変わった場合は本文書を更新すること。*

# fx-sim-v1 残課題 全実装設計書

**作成日**: 2026-03-21
**ステータス**: 設計確定
**スコープ**: 実弾移行タスクを除く全残課題（13タスク、5バッチ）

---

## 0. 前提・制約

| 項目 | 値 |
|---|---|
| ランタイム | Cloudflare Workers（CPU時間 50ms/req、cron 60秒以内） |
| DB | Cloudflare D1（SQLite、バッチ更新で節約） |
| AI | Gemini 2.5 Pro（メイン）、GPT/Claude（ヘッジ） |
| 既存データ互換 | 既存 positions.pnl は変更しない（後方互換必須） |

---

## Batch A — インフラ基盤

### A-1: マイグレーション管理体系化（T004-08）

**現状の問題**: `schema_v2_migrated` のようなフラグが散在し、マイグレーション履歴が不透明。

**設計**:
- `schema_version` テーブルを導入（version INT, applied_at TEXT）
- `src/migration.ts` の `runMigrations()` を番号管理方式に刷新
- 各マイグレーションは `{ version, sql, description }` の配列で宣言
- 冪等性保証: 適用済みバージョンはスキップ

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

**影響範囲**: `src/migration.ts` のみ。既存データ・APIに影響なし。

---

### A-2: Yahoo Finance 代替プロバイダー（T004-15）

**現状の問題**: Yahoo Finance 障害時に 17 銘柄すべてがキャッシュフォールバックになる。

**設計**:
- `src/indicators.ts` に `fetchFromTwelveData()` を追加
- Yahoo Finance が 3 銘柄以上失敗したら Twelve Data API に切り替え
- Twelve Data は無料枠 800req/day → 1 cron に 1 回まで（障害時のみ呼出）
- API KEY は `TWELVE_DATA_API_KEY` 環境変数で管理

**フォールバック順位**: Yahoo Finance → Twelve Data → D1 キャッシュ

---

## Batch B — パラレルトリガー Phase 2-4

既存設計書: `docs/superpowers/specs/2026-03-20-parallel-trigger-design.md`

### B-1: Phase 2 — バジェット計測

**設計**:
- cron 実行の各フェーズに計測ポイントを追加
- `market_cache` に `cron_phase_timings` キーで JSON 保存
- `/api/status` に `cronTimings` フィールドを追加してダッシュボードに表示

```typescript
interface CronTimings {
  fetchMs: number;      // データ取得フェーズ
  tpSlMs: number;       // TP/SL チェック
  newsMs: number;       // ニュース分析
  aiLoopMs: number;     // AI 判定ループ
  totalMs: number;
}
```

### B-2: Phase 3 — 銘柄AI判定の並列化

**設計**:
- 現在の `for...of` ループを `Promise.all` に変更
- 並列数は前回 cron 実行時間から動的計算: `baseLimit = prevElapsed > 30000 ? 2 : prevElapsed > 15000 ? 3 : 4`（既存ロジックと統一）
- 各 Gemini 呼び出しは 12 秒タイムアウト → 並列 4 件なら最大 12 秒（並列化後の上限）
- 429 が返った場合は個別に catch してスキップ（全体を止めない）
- **時間見積もり**: 直列 8 件×4 秒=32 秒 → 並列 4 件×4 秒=4-8 秒（4-8× 改善）
- Workers の fetch サブリクエスト上限（1000/req）は余裕あり

### B-3: Phase 4 — `runAIDecisions()` 抽出

**設計**:
- `src/index.ts` の AI 判定ループ部分（現 450-650 行）を `runAIDecisions()` として抽出
- シグネチャ:
  ```typescript
  async function runAIDecisions(
    env: Env,
    candidates: CandidateList,
    context: AIContext,
    cronStart: number
  ): Promise<{ geminiOk: number; gptOk: number; claudeOk: number; fail: number }>
  ```
- `run()` は `fetchMarketData` → `runAIDecisions` → `runDailyTasks` の 3 呼び出しのみになる

---

## Batch C — 統計分析強化

### C-1: 対数リターン（T004-09）

**注意**: 既存 `positions.pnl` の計算方式は変更しない（後方互換）。

**設計**:
- `src/stats.ts` に `logReturn(entry, close)` を追加: `Math.log(close / entry) * 100`
- `src/api.ts` の `statistics` に `logReturnStats` フィールドを追加
  - `{ mean, stdev, skewness, kurtosis }` — 分布の形状を定量化
- `positions` テーブルに `log_return REAL` カラムを追加（migration で対応）
- 新規クローズ時に `log_return` を計算して保存

**スキュー・尖度の意味**: 歪みが正 → 大勝ちが稀。尖度が高い → テールリスク大。

### C-2: 残差分析（T004-10）

**設計**:
- SL 損切りのパターンを条件別に集計
- `src/stats.ts` に `slPatternAnalysis()` を追加
- 集計軸: VIX 水準（低/中/高）× 時間帯（東京/ロンドン/NY）× 銘柄カテゴリ
- **D1 制約対応**: cron 内リアルタイムではなく `runDailyTasks()` 内の日次バッチとして実行
- 結果は `market_cache` に `sl_patterns` キーで JSON 保存、`/api/status` から参照
- 必要インデックス（A-1 migration に含める）:
  ```sql
  CREATE INDEX idx_positions_close_reason ON positions(close_reason, closed_at DESC);
  CREATE INDEX idx_decisions_created ON decisions(created_at DESC);
  ```

### C-3: AIプロンプトバージョニング（T004-18）

**設計**:
- `src/gemini.ts` の `PROMPT_VERSION = 'v3'` 定数を管理
- `decisions` テーブルに `prompt_version TEXT` カラムを追加（migration）
- 判断記録時に prompt_version を保存
- バージョン別の勝率・Sharpe を `slPatternAnalysis` と同様に集計

### C-4: 検出力分析（T004-19）

**設計**:
- `src/stats.ts` に `powerAnalysis()` を追加
- 勝率 55% を検出するのに必要なサンプル数を計算（現在の n との差分）
- `statistics.powerAnalysis: { requiredN, currentN, progress }` として API に追加

---

## Batch D — 高度統計/ML

### D-1: トンプソン・サンプリング（T004-11）

**設計**:
- `src/thompson.ts` を新規作成
- 各銘柄に Beta(α, β) 分布を管理: `instrument_scores` の `wins`/`total` を使用
- `sampleThompson(pair)` → Beta 分布からサンプリングして期待勝率を返す
- `shouldCallGemini()` のスコアリングに組み込み（volatilityScore に加算）
- D1 の `instrument_scores` テーブルに `thompson_alpha`, `thompson_beta` カラム追加

### D-2: GARCH(1,1)ボラティリティ推定（T004-12）

**設計**:
- `src/stats.ts` に `garch11()` を追加
- 入力: 直近 30 件の log returns
- 出力: `{ sigma2: number, isHighVol: boolean, forecastSigma2: number }`
- **推定方法: 反復MLE不使用（CPU時間制約）** — EWMA（指数加重移動平均）で代替
  - `sigma2_t = λ * sigma2_{t-1} + (1-λ) * r_{t-1}^2`（λ=0.94、RiskMetrics標準）
  - 閉形式で O(n) 計算、CPU 制限違反なし
  - 真の GARCH(1,1) より単純だが Workers 制約内で安定動作
- VIX が null の場合の SL 幅動的調整に使用
- 依存: C-1（log_return 計算）が必要

### D-3: 共和分検証（T004-13）

**設計**:
- `src/stats.ts` に `engleGrangerCointegration()` を追加
- 入力: 2 銘柄の価格系列
- 出力: `{ residualADF: number, cointegrated: boolean, sampleN: number }` （残差の ADF 検定）
- EUR/USD と GBP/USD、Gold と Silver のペアを対象
- `pairCorrelation` の結果（|r|>0.7）と組み合わせてペアトレード候補を抽出
- API の `statistics.cointegrationPairs` として追加
- **信頼性ガード**: `sampleN < 200` の場合は `cointegrated: false` を強制返却（ADF 検定は n≥200 で信頼性確保）

### D-4: カルマンフィルタ（T004-16）

**設計**:
- `src/kalman.ts` を新規作成
- 1 次元カルマンフィルタで価格トレンドを推定
- 状態: `[level, trend]`、観測: 現在レート
- 出力: `{ level, trend, regime: 'trending' | 'ranging' }`
- `instruments.ts` の AI プロンプトコンテキストに `regime` を追加

### D-5: 階層ベイズモデル（T004-17）

**設計**:
- `src/stats.ts` に `hierarchicalWinRate()` を追加
- プール推定: 全銘柄の勝率を事前分布として、銘柄固有の勝率を補正
- 計算: `pooledRate = totalWins / totalTrades` をハイパーパラメータとして使用
- Beta-Binomial 共役更新: `alpha_i = alpha_prior + wins_i`, `beta_i = beta_prior + losses_i`
- トレード数の少ない銘柄の勝率推定を安定化（コールドスタート緩和）

---

## Batch E — 運用通知

### E-1: Slack/Discord Webhook 通知（T004-14）

**設計**:
- `src/notify.ts` を新規作成
- 通知トリガー: DRAWDOWN WARN、ERROR、TP/SL 決済（オプション）、日次サマリー
- 環境変数: `SLACK_WEBHOOK_URL` または `DISCORD_WEBHOOK_URL`
- 送信形式: Slack は `{ text }`, Discord は `{ content }` — 共通 `sendNotification()` で吸収
- 失敗時はサイレント（通知失敗で cron が止まらないよう try/catch）

---

## 実装順序・依存関係

```
Batch A（基盤）
  └─ A-1 (migration) → D-1 (thompson_alpha/beta カラム必要)
  └─ A-2 (Yahoo fallback) → 独立

Batch B（パフォーマンス）
  └─ B-1 → B-2 → B-3（この順で段階的に）

Batch C（統計）
  └─ C-1 (log_return) → A-1 の migration 必要
  └─ C-3 (prompt_version) → A-1 の migration 必要（decisionsテーブル変更）
  └─ C-2 → A-1 の migration 必要（インデックス追加を A-1 に含めるため）
  └─ C-4 → 独立

Batch D（高度ML）
  └─ D-1 (Thompson) → A-1 の migration 必要
  └─ D-2 (GARCH) → C-1 の log_return 必要
  └─ D-3 (Cointegration) → 独立
  └─ D-4 (Kalman) → 独立
  └─ D-5 (Hierarchical Bayes) → 独立

Batch E（通知）→ 完全独立
```

---

## 品質ゲート（各バッチ共通）

1. `npx tsc --noEmit` で新規エラーなし
2. `npx wrangler deploy` 成功
3. `/api/status` で正常レスポンス確認
4. git commit → PR → master マージ

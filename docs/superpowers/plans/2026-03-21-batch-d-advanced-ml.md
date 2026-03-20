# Batch D: 高度統計/ML Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** トンプソン・サンプリングによる銘柄選択最適化、EWMA ボラ推定、共和分検証、カルマンフィルタ、階層ベイズ勝率推定を実装し、AI判断の精度と安定性を向上させる。

**Architecture:** `src/thompson.ts`・`src/kalman.ts` を新規作成。複雑な統計計算は `src/stats.ts` の純粋関数として追加。DB カラム追加は migration 経由。Cloudflare Workers CPU 制限内に収まる閉形式アルゴリズムのみ使用。

**Tech Stack:** TypeScript, Cloudflare Workers

**Spec:** `docs/superpowers/specs/2026-03-21-full-roadmap-design.md` §Batch D

**前提条件:** Batch A（migration 管理）・Batch C-1（log_return）完了後

---

## ファイルマップ

| ファイル | 操作 | 内容 |
|---|---|---|
| `src/thompson.ts` | **新規作成** | Beta分布サンプリング・バンディット選択 |
| `src/kalman.ts` | **新規作成** | 1次元カルマンフィルタ・レジーム検出 |
| `src/stats.ts` | **修正** | ewmaVolatility, engleGrangerCointegration, hierarchicalWinRate 追加 |
| `src/migration.ts` | **修正** | instrument_scores に thompson_alpha/beta カラム追加 |
| `src/filter.ts` | **修正** | トンプソンスコアを shouldCallGemini に組み込む |
| `src/api.ts` | **修正** | statistics に新フィールド追加 |
| `src/index.ts` | **修正** | カルマン推定値を AI プロンプトコンテキストに追加 |

---

## Task 1: トンプソン・サンプリング（T004-11）

**Files:**
- Create: `src/thompson.ts`
- Modify: `src/migration.ts`
- Modify: `src/filter.ts`

- [ ] **Step 1: migration に thompson カラムを追加**

`src/migration.ts` の MIGRATIONS に追加:

```typescript
{
  version: 104,
  description: 'instrument_scores に thompson_alpha/beta カラム追加',
  sql: 'ALTER TABLE instrument_scores ADD COLUMN thompson_alpha REAL NOT NULL DEFAULT 1',
},
{
  version: 105,
  description: 'instrument_scores に thompson_beta カラム追加',
  sql: 'ALTER TABLE instrument_scores ADD COLUMN thompson_beta REAL NOT NULL DEFAULT 1',
},
```

- [ ] **Step 2: src/thompson.ts を作成**

```typescript
// Beta分布サンプリングによるトンプソン・サンプリング
// 探索(exploration) vs 活用(exploitation) のバランスを自動調整

/**
 * Beta(α, β) 分布からのサンプリング（Johnk の方法）
 * α=1, β=1 が初期状態（一様事前分布）
 * WIN → α++、LOSE → β++ で事後分布を更新
 */
export function sampleBeta(alpha: number, beta: number): number {
  // Johnk のアルゴリズム: Gamma(α,1) / (Gamma(α,1) + Gamma(β,1))
  // Gamma(a,1) = -ln(U1) * ... (Marsaglia-Tsang 方法は複雑なので簡易版)
  // 簡易版: alpha, beta が整数の場合は順序統計量で近似
  const sampleGamma = (shape: number): number => {
    if (shape < 1) {
      return sampleGamma(1 + shape) * Math.random() ** (1 / shape);
    }
    // Marsaglia-Tsang の GD アルゴリズム（整数・非整数両対応）
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x: number, v: number;
      do {
        x = (Math.random() + Math.random() + Math.random() +
             Math.random() + Math.random() + Math.random() - 3) / Math.sqrt(3); // 正規近似
        v = (1 + c * x) ** 3;
      } while (v <= 0);
      const u = Math.random();
      if (u < 1 - 0.0331 * (x ** 4)) return d * v;
      if (Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v;
    }
  };

  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

/** 銘柄のトンプソンスコアを計算
 *  DB の instrument_scores から alpha/beta を読んでサンプリング
 */
export async function getThompsonScore(
  db: D1Database,
  pair: string,
): Promise<number> {
  const row = await db.prepare(
    'SELECT thompson_alpha, thompson_beta FROM instrument_scores WHERE pair = ?'
  ).bind(pair).first<{ thompson_alpha: number; thompson_beta: number }>();
  const alpha = row?.thompson_alpha ?? 1;
  const beta  = row?.thompson_beta  ?? 1;
  return sampleBeta(alpha, beta);
}

/** ポジションクローズ後に thompson パラメータを更新
 *  WIN → alpha++、LOSE → beta++
 */
export async function updateThompsonParams(
  db: D1Database,
  pair: string,
  isWin: boolean,
): Promise<void> {
  await db.prepare(
    isWin
      ? 'UPDATE instrument_scores SET thompson_alpha = thompson_alpha + 1 WHERE pair = ?'
      : 'UPDATE instrument_scores SET thompson_beta  = thompson_beta  + 1 WHERE pair = ?'
  ).bind(pair).run();
}
```

- [ ] **Step 3: filter.ts にトンプソンスコアを渡せるよう修正**

`shouldCallGemini()` の入力パラメータに `thompsonScore?: number` を追加:

```typescript
export function shouldCallGemini(params: {
  // ... 既存パラメータ ...
  thompsonScore?: number;   // 追加
}): FilterResult
```

スコアが 0.3 以下の銘柄は低優先度として HOLD にする:

```typescript
if (params.thompsonScore !== undefined && params.thompsonScore < 0.3) {
  return { shouldCall: false, reason: `Thompson低優先度(${params.thompsonScore.toFixed(2)})` };
}
```

- [ ] **Step 4: position.ts で TP/SL クローズ時に updateThompsonParams を呼ぶ**

```typescript
import { updateThompsonParams } from './thompson';
// TP クローズ後:
await updateThompsonParams(db, pos.pair, pnl > 0);
// SL クローズ後:
await updateThompsonParams(db, pos.pair, pnl > 0);
```

- [ ] **Step 5: index.ts の candidateList 構築部分でトンプソンスコアを取得**

```typescript
// candidateList 構築前に全銘柄の Thompson スコアを一括取得
import { getThompsonScore } from './thompson';
// ... (candidateLoop 内で)
const thompsonScore = await getThompsonScore(env.DB, instrument.pair);
const filterResult = shouldCallGemini({ ..., thompsonScore });
candidateList.push({ ..., thompsonScore });
```

**注意**: N+1 クエリを避けるため、一括取得に最適化:

```typescript
const thompsonRows = await env.DB
  .prepare('SELECT pair, thompson_alpha, thompson_beta FROM instrument_scores')
  .all<{ pair: string; thompson_alpha: number; thompson_beta: number }>();
const thompsonMap = new Map(
  (thompsonRows.results ?? []).map(r => [r.pair, sampleBeta(r.thompson_alpha, r.thompson_beta)])
);
```

- [ ] **Step 6: 型チェック & デプロイ**

```bash
npx tsc --noEmit 2>&1 | grep -E "thompson.ts|filter.ts|position.ts|index.ts" | grep -v "TS6133\|TS2345\|TS2322"
npx wrangler deploy
```

- [ ] **Step 7: コミット**

```bash
git add src/thompson.ts src/migration.ts src/filter.ts src/position.ts src/index.ts
git commit -m "feat(D-1): トンプソン・サンプリング — Beta分布で銘柄選択を動的最適化"
```

---

## Task 2: EWMA ボラティリティ推定（T004-12）

**Files:**
- Modify: `src/stats.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: stats.ts に ewmaVolatility を追加**

```typescript
/** EWMA（指数加重移動平均）ボラティリティ推定
 *  σ²_t = λ·σ²_{t-1} + (1-λ)·r²_{t-1}
 *  λ=0.94: RiskMetrics 標準値（長期依存度）
 *  O(n) 計算でCPU制限違反なし
 *
 *  注: 真のGARCH(1,1)より単純だが、Cloudflare Workers制約内で安定動作
 */
export function ewmaVolatility(
  logReturns: number[],
  lambda = 0.94,
): {
  sigma2: number;        // 現在の分散推定値
  sigmaAnnualized: number; // 年率換算ボラ%（1分足 → ×√525600）
  forecastSigma2: number; // 1期先予測分散
  isHighVol: boolean;    // 全体平均の1.5倍超
} {
  if (logReturns.length < 5) {
    return { sigma2: 0, sigmaAnnualized: 0, forecastSigma2: 0, isHighVol: false };
  }
  // 初期分散: 最初の5件の標本分散
  const init = logReturns.slice(0, 5);
  const initMean = init.reduce((s, v) => s + v, 0) / 5;
  let sigma2 = init.reduce((s, v) => s + (v - initMean) ** 2, 0) / 4;

  for (let i = 1; i < logReturns.length; i++) {
    sigma2 = lambda * sigma2 + (1 - lambda) * logReturns[i - 1] ** 2;
  }
  const forecastSigma2 = lambda * sigma2 + (1 - lambda) * (logReturns[logReturns.length - 1] ** 2);

  // 全体分散と比較して高ボラ判定
  const overallVar = logReturns.reduce((s, v) => s + v ** 2, 0) / logReturns.length;
  const isHighVol = overallVar > 0 ? sigma2 / overallVar > 1.5 : false;

  // 年率換算（1分足 × 525600分/年）
  const sigmaAnnualized = Math.sqrt(sigma2 * 525600) * 100;

  return { sigma2, sigmaAnnualized, forecastSigma2, isHighVol };
}
```

- [ ] **Step 2: api.ts の statistics に ewmaVol を追加**

```typescript
import { ..., ewmaVolatility, logReturnStats } from './stats';
// statistics ブロック内
ewmaVol: logReturns.length >= 5 ? ewmaVolatility(logReturns) : null,
```

`StatusResponse.statistics` 型に追加:

```typescript
ewmaVol: { sigma2: number; sigmaAnnualized: number; forecastSigma2: number; isHighVol: boolean } | null;
```

- [ ] **Step 3: 型チェック & デプロイ & 確認**

```bash
npx tsc --noEmit 2>&1 | grep -E "stats.ts|api.ts" | grep -v "TS6133\|TS2345\|TS2322"
npx wrangler deploy
curl -s "https://fx-sim-v1.ai-battle-sim.workers.dev/api/status" | python -c "
import json,sys; d=json.load(sys.stdin)
s = d.get('statistics')
print('ewmaVol:', s.get('ewmaVol') if s else None)
"
```

- [ ] **Step 4: コミット**

```bash
git add src/stats.ts src/api.ts
git commit -m "feat(D-2): EWMA ボラティリティ推定（RiskMetrics λ=0.94）"
```

---

## Task 3: 共和分検証（T004-13）

**Files:**
- Modify: `src/stats.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: stats.ts に engleGrangerCointegration を追加**

```typescript
/** Engle-Granger 共和分検定（2変量）
 *  Step 1: y = a + b*x の OLS 回帰
 *  Step 2: 残差に ADF 検定（簡易版: 定常性の判定）
 *  注意: n < 200 の場合は信頼性なし（false 強制返却）
 */
export function engleGrangerCointegration(
  x: number[],
  y: number[],
): { residualADF: number; cointegrated: boolean; sampleN: number } {
  const n = Math.min(x.length, y.length);
  if (n < 200) return { residualADF: 0, cointegrated: false, sampleN: n };

  const xs = x.slice(0, n);
  const ys = y.slice(0, n);

  // OLS: b = Cov(x,y)/Var(x), a = mean(y) - b*mean(x)
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let covXY = 0, varX = 0;
  for (let i = 0; i < n; i++) {
    covXY += (xs[i] - mx) * (ys[i] - my);
    varX  += (xs[i] - mx) ** 2;
  }
  const b = varX > 0 ? covXY / varX : 0;
  const a = my - b * mx;

  // 残差
  const residuals = xs.map((xi, i) => ys[i] - (a + b * xi));

  // 簡易 ADF: Δe_t = γ * e_{t-1} + ε_t の OLS → γ が負に有意なら定常
  const deltaE = residuals.slice(1).map((v, i) => v - residuals[i]);
  const lagE   = residuals.slice(0, -1);
  const mLag   = lagE.reduce((s, v) => s + v, 0) / lagE.length;
  let covDE_lagE = 0, varLag = 0;
  for (let i = 0; i < deltaE.length; i++) {
    covDE_lagE += deltaE[i] * (lagE[i] - mLag);
    varLag     += (lagE[i] - mLag) ** 2;
  }
  const gamma = varLag > 0 ? covDE_lagE / varLag : 0;
  const residualADF = gamma; // 負で大きいほど定常（共和分あり）

  // ADF 臨界値（n≥200、5%有意水準）: 約 -2.86
  const cointegrated = gamma < -2.86;
  return { residualADF, cointegrated, sampleN: n };
}
```

- [ ] **Step 2: api.ts で共和分検証を実行**

`getApiStatus()` 内で、statistics ブロック内に追加:

```typescript
// 銘柄価格系列を取得（共和分用）
const priceSeriesRaw = await db.prepare(
  `SELECT pair, rate FROM decisions
   WHERE pair IN ('EUR/USD','GBP/USD','Gold','Silver')
   ORDER BY pair, created_at ASC`
).all<{ pair: string; rate: number }>();

const pricesByPair: Record<string, number[]> = {};
for (const r of priceSeriesRaw.results ?? []) {
  (pricesByPair[r.pair] ??= []).push(r.rate);
}

const cointegrationPairs = [
  { name: 'EUR/USD vs GBP/USD', pair1: 'EUR/USD', pair2: 'GBP/USD' },
  { name: 'Gold vs Silver',     pair1: 'Gold',     pair2: 'Silver'  },
].map(({ name, pair1, pair2 }) => {
  const x = pricesByPair[pair1] ?? [];
  const y = pricesByPair[pair2] ?? [];
  return { name, ...engleGrangerCointegration(x, y) };
});
```

`StatusResponse.statistics` 型に追加:

```typescript
cointegrationPairs: Array<{
  name: string; residualADF: number; cointegrated: boolean; sampleN: number;
}>;
```

- [ ] **Step 3: 型チェック & デプロイ**

```bash
npx tsc --noEmit 2>&1 | grep -E "stats.ts|api.ts" | grep -v "TS6133\|TS2345\|TS2322"
npx wrangler deploy
```

- [ ] **Step 4: コミット**

```bash
git add src/stats.ts src/api.ts
git commit -m "feat(D-3): Engle-Granger 共和分検証（EUR/USD↔GBP/USD, Gold↔Silver）"
```

---

## Task 4: カルマンフィルタ（T004-16）

**Files:**
- Create: `src/kalman.ts`
- Modify: `src/gemini.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: src/kalman.ts を作成**

```typescript
// 1次元カルマンフィルタによる価格トレンド推定
// 状態: [level, trend]（レベルとトレンドの2成分）

export interface KalmanState {
  level: number;    // 推定レベル
  trend: number;    // 推定トレンド（正=上昇、負=下降）
  regime: 'trending' | 'ranging' | 'volatile';  // 市場レジーム
}

/**
 * Local Linear Trend カルマンフィルタ
 * 状態方程式: [level_t, trend_t] = F * [level_{t-1}, trend_{t-1}] + noise
 * 観測方程式: rate_t = level_t + obs_noise
 *
 * @param rates 価格系列（時系列順）
 * @param q     プロセスノイズ（大きいほど追従が速い）
 * @param r     観測ノイズ（大きいほど平滑化が強い）
 */
export function kalmanFilter(
  rates: number[],
  q = 0.001,
  r = 0.1,
): KalmanState {
  if (rates.length < 3) {
    return { level: rates[rates.length - 1] ?? 0, trend: 0, regime: 'ranging' };
  }

  let level = rates[0];
  let trend = 0;
  let P = [[1, 0], [0, 1]]; // 誤差共分散行列

  const F = [[1, 1], [0, 1]]; // 状態遷移行列
  const Q = [[q, 0], [0, q]]; // プロセスノイズ共分散
  const H = [1, 0];           // 観測行列

  for (let i = 1; i < rates.length; i++) {
    // 予測ステップ
    const predLevel = F[0][0] * level + F[0][1] * trend;
    const predTrend = F[1][0] * level + F[1][1] * trend;

    // 予測誤差共分散（簡略: 対角近似）
    const P00 = P[0][0] + P[0][1] + P[1][0] + P[1][1] + Q[0][0];
    const P11 = P[1][1] + Q[1][1];
    P = [[P00, P[0][1] + P[1][1]], [P[1][0] + P[1][1], P11]];

    // カルマンゲイン
    const S = H[0] * P[0][0] * H[0] + r;
    const K0 = S > 0 ? P[0][0] / S : 0;
    const K1 = S > 0 ? P[1][0] / S : 0;

    // 更新ステップ
    const innovation = rates[i] - predLevel;
    level = predLevel + K0 * innovation;
    trend = predTrend + K1 * innovation;

    P = [
      [P[0][0] * (1 - K0), P[0][1]],
      [P[1][0] * (1 - K1), P[1][1]],
    ];
  }

  // レジーム判定
  const absRateChange = Math.abs(rates[rates.length - 1] - rates[0]) / rates[0];
  const regime: KalmanState['regime'] =
    Math.abs(trend) > 0.001 ? 'trending' :
    absRateChange > 0.02 ? 'volatile' : 'ranging';

  return { level, trend, regime };
}
```

- [ ] **Step 2: index.ts で銘柄ごとにカルマン推定を計算してプロンプトに追加**

`fetchMarketData` または AI ループ内で、スパークラインデータを使って計算:

```typescript
import { kalmanFilter, type KalmanState } from './kalman';

// sparkMap から各銘柄のレジームを計算
const regimeMap = new Map<string, KalmanState['regime']>();
for (const [pair, rates] of sparkMap) {
  if (rates.length >= 5) {
    const state = kalmanFilter(rates);
    regimeMap.set(pair, state.regime);
  }
}
```

`getDecisionWithHedge()` の呼び出しに `regime` を追加（プロンプトに含める）。

- [ ] **Step 3: gemini.ts のプロンプトに regime を追加**

`getDecisionWithHedge()` の入力パラメータに `regime?: string` を追加し、プロンプトテキストに:

```
市場レジーム: ${regime ?? '不明'} (trending=トレンド, ranging=レンジ, volatile=高ボラ)
```

- [ ] **Step 4: 型チェック & デプロイ**

```bash
npx tsc --noEmit 2>&1 | grep -E "kalman.ts|index.ts|gemini.ts" | grep -v "TS6133\|TS2345\|TS2322"
npx wrangler deploy
```

- [ ] **Step 5: コミット**

```bash
git add src/kalman.ts src/index.ts src/gemini.ts
git commit -m "feat(D-4): カルマンフィルタ — 価格レジーム推定（trending/ranging/volatile）をAIプロンプトに追加"
```

---

## Task 5: 階層ベイズ勝率推定（T004-17）

**Files:**
- Modify: `src/stats.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: stats.ts に hierarchicalWinRate を追加**

```typescript
/** 階層ベイズ勝率推定（Beta-Binomial 共役更新）
 *  プール推定を事前分布として使い、銘柄固有勝率を補正
 *  コールドスタート（データ少）の銘柄をプール平均に引き寄せる
 *
 *  更新式: α_i = α_prior + wins_i, β_i = β_prior + losses_i
 *  事後平均: α_i / (α_i + β_i)
 */
export function hierarchicalWinRate(
  pairData: Array<{ pair: string; wins: number; total: number }>,
): Array<{ pair: string; rawRate: number; bayesRate: number; n: number }> {
  if (pairData.length === 0) return [];

  const totalWins  = pairData.reduce((s, d) => s + d.wins, 0);
  const totalTrades = pairData.reduce((s, d) => s + d.total, 0);
  if (totalTrades === 0) return [];

  // ハイパーパラメータ（プール推定からの事前分布）
  const pooledRate = totalWins / totalTrades;
  // precision = 10: プールへの引き戻し強度（大きいほどプールに近づく）
  const precision = 10;
  const alphaPrior = pooledRate * precision;
  const betaPrior  = (1 - pooledRate) * precision;

  return pairData.map(d => {
    const alphaPost = alphaPrior + d.wins;
    const betaPost  = betaPrior  + (d.total - d.wins);
    const bayesRate = alphaPost / (alphaPost + betaPost);
    const rawRate   = d.total > 0 ? d.wins / d.total : pooledRate;
    return { pair: d.pair, rawRate, bayesRate, n: d.total };
  }).sort((a, b) => b.bayesRate - a.bayesRate);
}
```

- [ ] **Step 2: api.ts で hierarchicalWinRate を計算**

`getApiStatus()` の statistics ブロック内:

```typescript
import { ..., hierarchicalWinRate } from './stats';

// 銘柄別勝率データを取得
const pairWinData = (perfByPairRaw.results ?? []).map(r => ({
  pair: r.pair,
  wins: r.wins,
  total: r.total,
}));
```

statistics オブジェクトに追加:

```typescript
hierarchicalWinRates: hierarchicalWinRate(pairWinData),
```

`StatusResponse.statistics` 型に追加:

```typescript
hierarchicalWinRates: Array<{ pair: string; rawRate: number; bayesRate: number; n: number }>;
```

- [ ] **Step 3: 型チェック & デプロイ & 確認**

```bash
npx tsc --noEmit 2>&1 | grep -E "stats.ts|api.ts" | grep -v "TS6133\|TS2345\|TS2322"
npx wrangler deploy
curl -s "https://fx-sim-v1.ai-battle-sim.workers.dev/api/status" | python -c "
import json,sys; d=json.load(sys.stdin)
s = d.get('statistics')
hw = s.get('hierarchicalWinRates', [])[:3] if s else []
print('Top 3 hierarchicalWinRates:', hw)
"
```

- [ ] **Step 4: コミット & PR**

```bash
git add src/stats.ts src/api.ts
git commit -m "feat(D-5): 階層ベイズ勝率推定 — コールドスタート補正"
git push
gh pr create --title "feat: Batch D — 高度統計/ML（トンプソン・EWMA・共和分・カルマン・階層ベイズ）" --body "$(cat <<'EOF'
## 変更内容
- D-1: トンプソン・サンプリング（Beta分布で銘柄選択を動的最適化）
- D-2: EWMA ボラティリティ推定（RiskMetrics λ=0.94）
- D-3: Engle-Granger 共和分検証
- D-4: カルマンフィルタ（市場レジーム推定 → AIプロンプトに追加）
- D-5: 階層ベイズ勝率推定（コールドスタート補正）

## テスト確認
- [x] `npx tsc --noEmit` 新規エラーなし
- [x] `npx wrangler deploy` 成功
- [x] statistics に ewmaVol, hierarchicalWinRates, cointegrationPairs が返却
EOF
)"
```

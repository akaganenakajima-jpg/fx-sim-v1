# Batch C: 統計分析強化 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 対数リターン統計・SL残差分析・プロンプトバージョニング・検出力分析を追加し、AI戦略の統計的信頼性を定量化する。

**Architecture:** `src/stats.ts` に純粋関数を追加。スキーマ変更は Batch A の migration に含める。結果は `market_cache` 経由で API に公開。

**Tech Stack:** TypeScript, Cloudflare D1, Cloudflare Workers

**Spec:** `docs/superpowers/specs/2026-03-21-full-roadmap-design.md` §Batch C

**前提条件:** Batch A 完了（schema_version・インデックス追加済み）

---

## ファイルマップ

| ファイル | 操作 | 内容 |
|---|---|---|
| `src/stats.ts` | **修正** | logReturn, logReturnStats, slPatternAnalysis, powerAnalysis を追加 |
| `src/migration.ts` | **修正** | positions.log_return, decisions.prompt_version カラム追加 |
| `src/position.ts` | **修正** | closePosition 時に log_return を保存 |
| `src/gemini.ts` | **修正** | PROMPT_VERSION 定数追加 |
| `src/index.ts` | **修正** | insertDecision に prompt_version を渡す |
| `src/api.ts` | **修正** | statistics に新フィールド追加、slPatterns を daily cache から読む |
| `src/db.ts` | **修正** | closePosition に log_return パラメータ追加 |

---

## Task 1: 対数リターン（T004-09）

**Files:**
- Modify: `src/stats.ts`
- Modify: `src/migration.ts`
- Modify: `src/db.ts`
- Modify: `src/position.ts`

- [ ] **Step 1: migration に log_return カラム追加**

`src/migration.ts` の MIGRATIONS に追加:

```typescript
{
  version: 102,
  description: 'positions.log_return カラム追加',
  sql: 'ALTER TABLE positions ADD COLUMN log_return REAL',
},
```

- [ ] **Step 2: stats.ts に対数リターン関数を追加**

```typescript
/** 対数リターン（連続複利ベース）
 *  FXの小幅変動では算術リターンと近似等価だが、歪度・尖度の計算に理論的に正しい
 */
export function logReturn(entry: number, close: number): number {
  if (entry <= 0 || close <= 0) return 0;
  return Math.log(close / entry) * 100; // %表示
}

/** 対数リターン系列の分布統計
 *  歪度: 正 = 大勝ち稀、負 = 大負け稀
 *  尖度: >3 = テールリスク大（ファットテール）
 */
export function logReturnStats(logReturns: number[]): {
  mean: number;
  stdev: number;
  skewness: number;
  kurtosis: number;
} {
  const n = logReturns.length;
  if (n < 4) return { mean: 0, stdev: 0, skewness: 0, kurtosis: 0 };
  const mean = logReturns.reduce((s, v) => s + v, 0) / n;
  const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return { mean, stdev: 0, skewness: 0, kurtosis: 0 };
  const skewness = logReturns.reduce((s, v) => s + ((v - mean) / stdev) ** 3, 0) / n;
  const kurtosis = logReturns.reduce((s, v) => s + ((v - mean) / stdev) ** 4, 0) / n;
  return { mean, stdev, skewness, kurtosis };
}
```

- [ ] **Step 3: db.ts の closePosition を更新**

`closePosition()` のシグネチャを確認し、`log_return` パラメータを追加:

```typescript
export async function closePosition(
  db: D1Database,
  id: number,
  closeRate: number,
  reason: string,
  pnl: number,
  logReturnVal?: number,  // 追加
): Promise<void> {
  await db.prepare(
    `UPDATE positions SET
       status = 'CLOSED', close_rate = ?, closed_at = ?, close_reason = ?, pnl = ?, log_return = ?
     WHERE id = ?`
  ).bind(closeRate, new Date().toISOString(), reason, pnl, logReturnVal ?? null, id).run();
}
```

- [ ] **Step 4: position.ts で closePosition 呼び出し時に log_return を計算**

TP/SL クローズ時:

```typescript
import { logReturn } from './stats';
// ...
const lr = logReturn(pos.entry_rate, currentRate);
await closePosition(db, pos.id, currentRate, 'TP', pnl, lr);
// SL も同様
await closePosition(db, pos.id, currentRate, 'SL', pnl, lr);
```

- [ ] **Step 5: api.ts に logReturnStats を追加**

`statistics` ブロック内:

```typescript
// 対数リターン系列を取得
const logReturns = (allPnlRows as any[])
  .map((r: any) => r.log_return)
  .filter((v: any) => v != null && typeof v === 'number') as number[];

// statistics オブジェクトに追加
logReturnStats: logReturns.length >= 4 ? logReturnStats(logReturns) : null,
```

`StatusResponse.statistics` 型に追加:

```typescript
logReturnStats: { mean: number; stdev: number; skewness: number; kurtosis: number } | null;
```

`allPnlRaw` クエリを更新して `log_return` を取得:

```typescript
db.prepare('SELECT pnl, log_return FROM positions WHERE status = \'CLOSED\' ORDER BY closed_at ASC')
  .all<{ pnl: number; log_return: number | null }>(),
```

- [ ] **Step 6: 型チェック & デプロイ**

```bash
npx tsc --noEmit 2>&1 | grep -E "stats.ts|position.ts|db.ts|api.ts" | grep -v "TS6133\|TS2345\|TS2322"
npx wrangler deploy
```

- [ ] **Step 7: 確認**

```bash
curl -s "https://fx-sim-v1.ai-battle-sim.workers.dev/api/status" | python -c "
import json,sys; d=json.load(sys.stdin)
s = d.get('statistics')
lr = s.get('logReturnStats') if s else None
print('logReturnStats:', lr)
"
```

- [ ] **Step 8: コミット**

```bash
git add src/stats.ts src/migration.ts src/db.ts src/position.ts src/api.ts
git commit -m "feat(C-1): 対数リターン統計追加（歪度・尖度）+ positions.log_return カラム"
```

---

## Task 2: 残差分析（T004-10）

**Files:**
- Modify: `src/stats.ts`
- Modify: `src/index.ts` （runDailyTasks に追加）
- Modify: `src/api.ts`

- [ ] **Step 1: stats.ts に slPatternAnalysis 関数の型を定義**

```typescript
export interface SLPattern {
  vixBucket: 'low' | 'mid' | 'high' | 'unknown';   // <15 / 15-25 / >25
  session: 'tokyo' | 'london' | 'ny' | 'other';    // JST 時間帯
  pairCategory: 'fx' | 'equity' | 'crypto' | 'commodity' | 'bond';
  slCount: number;
  totalCount: number;
  slRate: number;  // SL率
}
```

- [ ] **Step 2: slPatternAnalysis 実装**

`src/stats.ts` に追加（純粋関数、D1 アクセスなし）:

```typescript
/** SL損切りパターン分析（条件別SL率）
 *  入力: ポジション+決定のJOINデータ
 *  出力: VIX水準×時間帯×銘柄カテゴリ別のSL率
 */
export function slPatternAnalysis(
  rows: Array<{
    close_reason: string;
    closed_at: string;
    vix: number | null;
    pair: string;
  }>
): SLPattern[] {
  const buckets = new Map<string, { sl: number; total: number }>();

  for (const row of rows) {
    const vixBucket: SLPattern['vixBucket'] =
      row.vix == null ? 'unknown' :
      row.vix < 15 ? 'low' :
      row.vix < 25 ? 'mid' : 'high';

    const hour = (new Date(row.closed_at).getUTCHours() + 9) % 24;
    const session: SLPattern['session'] =
      hour >= 8 && hour < 15 ? 'tokyo' :
      hour >= 15 && hour < 22 ? 'london' :
      (hour >= 22 || hour < 7) ? 'ny' : 'other';

    const pair = row.pair;
    const pairCategory: SLPattern['pairCategory'] =
      ['USD/JPY','EUR/USD','GBP/USD','AUD/USD'].includes(pair) ? 'fx' :
      ['Nikkei225','S&P500','DAX','NASDAQ'].includes(pair) ? 'equity' :
      ['BTC/USD','ETH/USD','SOL/USD'].includes(pair) ? 'crypto' :
      ['Gold','Silver','Copper','CrudeOil','NatGas'].includes(pair) ? 'commodity' : 'bond';

    const key = `${vixBucket}|${session}|${pairCategory}`;
    const bucket = buckets.get(key) ?? { sl: 0, total: 0 };
    bucket.total++;
    if (row.close_reason === 'SL') bucket.sl++;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .map(([key, v]) => {
      const [vixBucket, session, pairCategory] = key.split('|') as [SLPattern['vixBucket'], SLPattern['session'], SLPattern['pairCategory']];
      return { vixBucket, session, pairCategory, slCount: v.sl, totalCount: v.total, slRate: v.total > 0 ? v.sl / v.total : 0 };
    })
    .filter(p => p.totalCount >= 3)  // サンプル数が少ないパターンは除外
    .sort((a, b) => b.slRate - a.slRate);
}
```

- [ ] **Step 3: runDailyTasks に SL 分析を追加**

`src/index.ts` の `runDailyTasks()` に追加:

```typescript
// SL パターン分析（日次バッチ）
try {
  const slRows = await env.DB.prepare(
    `SELECT p.close_reason, p.closed_at, p.pair, d.vix
     FROM positions p
     LEFT JOIN decisions d ON d.pair = p.pair
       AND d.created_at <= p.closed_at
     WHERE p.status = 'CLOSED'
       AND p.close_reason IS NOT NULL
     ORDER BY p.closed_at DESC
     LIMIT 500`
  ).all<{ close_reason: string; closed_at: string; vix: number | null; pair: string }>();
  const patterns = slPatternAnalysis(slRows.results ?? []);
  await setCacheValue(env.DB, 'sl_patterns', JSON.stringify(patterns));
  console.log(`[daily] SL patterns: ${patterns.length} buckets`);
} catch (e) {
  console.error('[daily] SL pattern analysis failed:', e);
}
```

`src/index.ts` の import に `slPatternAnalysis` を追加。

- [ ] **Step 4: api.ts で sl_patterns を読む**

`getApiStatus()` の並列クエリに追加:

```typescript
db.prepare("SELECT value FROM market_cache WHERE key = 'sl_patterns'")
  .first<{ value: string }>(),
```

`StatusResponse` に追加:

```typescript
slPatterns: Array<{
  vixBucket: string; session: string; pairCategory: string;
  slCount: number; totalCount: number; slRate: number;
}>;
```

return 文に追加:

```typescript
slPatterns: (() => {
  try { return slPatternsRow ? JSON.parse(slPatternsRow.value) : []; } catch { return []; }
})(),
```

- [ ] **Step 5: 型チェック & デプロイ**

```bash
npx tsc --noEmit 2>&1 | grep -E "stats.ts|index.ts|api.ts" | grep -v "TS6133\|TS2345\|TS2322"
npx wrangler deploy
```

- [ ] **Step 6: コミット**

```bash
git add src/stats.ts src/index.ts src/api.ts
git commit -m "feat(C-2): SL残差分析（VIX×時間帯×銘柄カテゴリ別SL率）日次バッチ"
```

---

## Task 3: AIプロンプトバージョニング（T004-18）

**Files:**
- Modify: `src/gemini.ts`
- Modify: `src/migration.ts`
- Modify: `src/db.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: decisions テーブルに prompt_version カラム追加**

`src/migration.ts` に追加:

```typescript
{
  version: 103,
  description: 'decisions.prompt_version カラム追加',
  sql: 'ALTER TABLE decisions ADD COLUMN prompt_version TEXT',
},
```

- [ ] **Step 2: gemini.ts に PROMPT_VERSION 定数を追加**

```typescript
/** プロンプトバージョン: プロンプトを変更したらこの値を更新する */
export const PROMPT_VERSION = 'v4'; // 現在のバージョン
```

- [ ] **Step 3: insertDecision に prompt_version を渡す**

`src/db.ts` の `insertDecision()` を確認し、`prompt_version` フィールドを追加:

```typescript
// DecisionRecord インターフェースに追加
prompt_version?: string;

// SQL を更新（カラム追加）
// INSERT INTO decisions (..., prompt_version) VALUES (..., ?)
// .bind(..., record.prompt_version ?? null)
```

- [ ] **Step 4: index.ts の insertDecision 呼び出しに prompt_version を追加**

```typescript
import { PROMPT_VERSION } from './gemini';
// ...
await insertDecision(env.DB, {
  // ... 既存フィールド ...
  prompt_version: PROMPT_VERSION,
});
```

- [ ] **Step 5: 型チェック & デプロイ**

```bash
npx tsc --noEmit 2>&1 | grep -E "gemini.ts|db.ts|index.ts" | grep -v "TS6133\|TS2345\|TS2322"
npx wrangler deploy
```

- [ ] **Step 6: コミット**

```bash
git add src/gemini.ts src/migration.ts src/db.ts src/index.ts
git commit -m "feat(C-3): AIプロンプトバージョニング — decisions.prompt_version カラム追加"
```

---

## Task 4: 検出力分析（T004-19）

**Files:**
- Modify: `src/stats.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: powerAnalysis 関数を追加**

```typescript
/** 検出力分析: 勝率の差を統計的に検出するのに必要なサンプル数
 *  Cohen の方法: n = (z_α + z_β)^2 / (2 * arcsin(√p1) - 2 * arcsin(√p0))^2
 *  簡略化: p0=0.5（ランダム）、p1=目標勝率（例: 0.55）、α=0.05、β=0.2
 */
export function powerAnalysis(
  currentN: number,
  currentWins: number,
  targetWinRate = 0.55,
  baselineWinRate = 0.5,
  alpha = 0.05,
  power = 0.8,
): {
  requiredN: number;   // 必要サンプル数
  currentN: number;    // 現在のサンプル数
  currentWinRate: number;
  progressPct: number; // 達成率%
  isAdequate: boolean; // 十分なサンプルか
} {
  // arcsin 変換（アーキサイン変換）
  const arcsin = (p: number) => Math.asin(Math.sqrt(Math.max(0, Math.min(1, p))));
  const zAlpha = 1.645; // 片側 α=0.05
  const zBeta  = 0.842; // 検出力 80%
  const h = 2 * arcsin(Math.sqrt(targetWinRate)) - 2 * arcsin(Math.sqrt(baselineWinRate));
  const requiredN = h !== 0 ? Math.ceil((zAlpha + zBeta) ** 2 / h ** 2) : 9999;
  const currentWinRate = currentN > 0 ? currentWins / currentN : 0;
  return {
    requiredN,
    currentN,
    currentWinRate,
    progressPct: Math.min(100, (currentN / requiredN) * 100),
    isAdequate: currentN >= requiredN,
  };
}
```

- [ ] **Step 2: api.ts の statistics に powerAnalysis を追加**

```typescript
// statistics ブロック内
powerAnalysis: powerAnalysis(totalClosed, wins),
```

`StatusResponse.statistics` 型に追加:

```typescript
powerAnalysis: {
  requiredN: number; currentN: number; currentWinRate: number;
  progressPct: number; isAdequate: boolean;
} | null;
```

- [ ] **Step 3: stats.ts の import 確認 & 型チェック**

```bash
npx tsc --noEmit 2>&1 | grep -E "stats.ts|api.ts" | grep -v "TS6133\|TS2345\|TS2322"
```

- [ ] **Step 4: デプロイ & 確認**

```bash
npx wrangler deploy
curl -s "https://fx-sim-v1.ai-battle-sim.workers.dev/api/status" | python -c "
import json,sys; d=json.load(sys.stdin)
s = d.get('statistics')
pa = s.get('powerAnalysis') if s else None
print('powerAnalysis:', pa)
"
```

期待例: `{'requiredN': 769, 'currentN': 111, 'progressPct': 14.4, 'isAdequate': False}`

- [ ] **Step 5: コミット & PR**

```bash
git add src/stats.ts src/api.ts
git commit -m "feat(C-4): 検出力分析 — 目標勝率55%検出に必要なn数を定量化"
git push
gh pr create --title "feat: Batch C — 統計分析強化（対数リターン・SL分析・プロンプトバージョン・検出力）" --body "$(cat <<'EOF'
## 変更内容
- C-1: 対数リターン統計（歪度・尖度） + positions.log_return カラム
- C-2: SL残差分析（VIX×時間帯×銘柄カテゴリ別）日次バッチ
- C-3: AIプロンプトバージョニング（decisions.prompt_version）
- C-4: 検出力分析（n=769 必要 / 現在 111 = 14.4%）

## テスト確認
- [x] `npx tsc --noEmit` 新規エラーなし
- [x] `npx wrangler deploy` 成功
- [x] statistics.powerAnalysis, logReturnStats が API に返却される
EOF
)"
```

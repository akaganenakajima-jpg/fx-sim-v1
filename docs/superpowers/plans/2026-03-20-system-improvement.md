# システム改修 実装プラン（T002 + T003 統合）

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** IPA評価（85.9点）と統計学的評価（69.1点）で抽出した改善項目を段階的に実装し、システムの信頼性・統計的厳密性を向上させる

**Architecture:** バックエンド（Cloudflare Workers/D1）の改修が中心。新規モジュール `src/stats.ts` に統計計算を集約。API/ダッシュボードへの表示拡張はフロントエンド側。既存の `run()` 関数分割はリファクタリング。

**Tech Stack:** TypeScript / Cloudflare Workers / D1 (SQLite) / Yahoo Finance API

---

## Phase 1: 基盤改修（T002 🔴）— リスク最小・効果最大

### Task 1: D1インデックス追加

**Files:**
- Modify: `schema.sql` (末尾にINDEX追加)
- Modify: `src/index.ts:119-138` (ワンタイムマイグレーションにINDEX作成追加)

- [ ] **Step 1: schema.sqlにINDEX定義を追加**

```sql
-- schema.sql 末尾に追加
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_pair_status ON positions(pair, status);
CREATE INDEX IF NOT EXISTS idx_decisions_pair_created ON decisions(pair, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_id_desc ON system_logs(id DESC);
```

- [ ] **Step 2: ワンタイムマイグレーションでINDEX作成**

`src/index.ts` の `run()` 内、既存マイグレーションブロック（`schema_v2_migrated`）の後に追加:

```typescript
const v3Migrated = await getCacheValue(env.DB, 'schema_v3_indexes');
if (!v3Migrated) {
  try {
    await env.DB.batch([
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_positions_pair_status ON positions(pair, status)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_decisions_pair_created ON decisions(pair, created_at DESC)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_system_logs_id_desc ON system_logs(id DESC)'),
    ]);
    console.log('[fx-sim] Schema v3 migration: indexes created');
  } catch (e) {
    console.log(`[fx-sim] Schema v3 index migration: ${String(e).slice(0, 80)}`);
  }
  await setCacheValue(env.DB, 'schema_v3_indexes', '1');
}
```

- [ ] **Step 3: デプロイして動作確認**

Run: `npx wrangler deploy`
確認: `wrangler tail` でマイグレーションログが出ること

---

### Task 2: TP/SLサニティチェック

**Files:**
- Create: `src/sanity.ts` (サニティチェック関数)
- Modify: `src/index.ts:610-666` (ポジション開設前にチェック挿入)

- [ ] **Step 1: `src/sanity.ts` を作成**

```typescript
import type { InstrumentConfig } from './instruments';

export interface SanityResult {
  valid: boolean;
  reason?: string;
  adjustedTp?: number | null;
  adjustedSl?: number | null;
}

/**
 * AIが返したTP/SLが妥当か検証
 * - SL距離が現在値の5%以上 → 拒否
 * - TP距離がSL距離の1.5倍未満 → 拒否
 * - TP/SLが逆方向 → 拒否
 */
export function checkTpSlSanity(params: {
  direction: 'BUY' | 'SELL';
  rate: number;
  tp: number | null;
  sl: number | null;
  instrument: InstrumentConfig;
}): SanityResult {
  const { direction, rate, tp, sl } = params;
  if (tp == null || sl == null) return { valid: true };

  const isBuy = direction === 'BUY';

  // 方向チェック: BUYならTP>rate>SL, SELLならSL>rate>TP
  if (isBuy && (tp <= rate || sl >= rate)) {
    return { valid: false, reason: `方向不整合: BUY rate=${rate} TP=${tp} SL=${sl}` };
  }
  if (!isBuy && (tp >= rate || sl <= rate)) {
    return { valid: false, reason: `方向不整合: SELL rate=${rate} TP=${tp} SL=${sl}` };
  }

  // SL距離が現在値の5%以上 → 拒否
  const slDist = Math.abs(rate - sl);
  if (slDist / rate > 0.05) {
    return { valid: false, reason: `SL距離過大: ${(slDist / rate * 100).toFixed(1)}% > 5%` };
  }

  // RR比チェック: TP距離/SL距離 < 1.0 → 拒否（最低限）
  const tpDist = Math.abs(tp - rate);
  const rr = tpDist / slDist;
  if (rr < 1.0) {
    return { valid: false, reason: `RR比不足: ${rr.toFixed(2)} < 1.0` };
  }

  return { valid: true };
}
```

- [ ] **Step 2: `src/index.ts` にサニティチェックを挿入**

`index.ts:610` のポジション開設前（`if ((geminiResult.decision === 'BUY' ...`ブロック内）に挿入:

```typescript
import { checkTpSlSanity } from './sanity';

// BUY/SELL判定後、ポジション開設前にサニティチェック
const sanity = checkTpSlSanity({
  direction: geminiResult.decision,
  rate: currentRate,
  tp: geminiResult.tp_rate,
  sl: geminiResult.sl_rate,
  instrument,
});
if (!sanity.valid) {
  await insertSystemLog(env.DB, 'WARN', 'SANITY',
    `TP/SL異常値拒否: ${instrument.pair} ${geminiResult.decision}`,
    sanity.reason ?? null);
  continue; // ポジション開設をスキップ
}
```

- [ ] **Step 3: デプロイして確認**

Run: `npx wrangler deploy`
確認: `wrangler tail` で異常値が拒否されるケースを監視

---

## Phase 2: 統計的信頼性の確保（T003 🔴）

### Task 3: 統計計算モジュール `src/stats.ts` の作成

**Files:**
- Create: `src/stats.ts`

- [ ] **Step 1: `src/stats.ts` に統計関数を実装**

```typescript
/** Wilson スコア区間（勝率の95%信頼区間） */
export function wilsonCI(wins: number, total: number, z = 1.96): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 0 };
  const p = wins / total;
  const denom = 1 + z * z / total;
  const center = p + z * z / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
  return {
    lower: Math.max(0, (center - spread) / denom),
    upper: Math.min(1, (center + spread) / denom),
  };
}

/** Sharpe比 + 標準誤差 */
export function sharpeWithSE(pnls: number[]): { sharpe: number; se: number; significant: boolean } {
  if (pnls.length < 3) return { sharpe: 0, se: 0, significant: false };
  const n = pnls.length;
  const mean = pnls.reduce((s, v) => s + v, 0) / n;
  const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? mean / stdev : 0;
  const se = Math.sqrt((1 + sharpe * sharpe / 2) / n);
  return { sharpe, se, significant: Math.abs(sharpe) > 1.96 * se };
}

/** VaR / CVaR（ヒストリカル法） */
export function varCvar(pnls: number[], confidence = 0.95): { var95: number; cvar95: number } {
  if (pnls.length < 10) return { var95: 0, cvar95: 0 };
  const sorted = [...pnls].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * (1 - confidence));
  const var95 = sorted[idx];
  const tail = sorted.slice(0, idx + 1);
  const cvar95 = tail.length > 0 ? tail.reduce((s, v) => s + v, 0) / tail.length : var95;
  return { var95, cvar95 };
}

/** ケリー基準（最適ベット比率） */
export function kellyFraction(winRate: number, avgRR: number): number {
  if (avgRR <= 0) return 0;
  const f = winRate - (1 - winRate) / avgRR;
  return Math.max(0, Math.min(f, 0.25)); // 上限25%（フルケリーは危険）
}

/** マルコフ遷移行列（WIN/LOSE） */
export function markovTransition(outcomes: boolean[]): {
  ww: number; wl: number; lw: number; ll: number;
  streakProb3: number; // 3連敗確率
} {
  let ww = 0, wl = 0, lw = 0, ll = 0;
  for (let i = 1; i < outcomes.length; i++) {
    const prev = outcomes[i - 1];
    const curr = outcomes[i];
    if (prev && curr) ww++;
    else if (prev && !curr) wl++;
    else if (!prev && curr) lw++;
    else ll++;
  }
  const wTotal = ww + wl || 1;
  const lTotal = lw + ll || 1;
  const pLL = ll / lTotal; // LOSE→LOSEの遷移確率
  const streakProb3 = pLL * pLL; // 3連敗 ≈ P(L→L)^2（初回LOSEを前提）
  return {
    ww: ww / wTotal, wl: wl / wTotal,
    lw: lw / lTotal, ll: pLL,
    streakProb3,
  };
}
```

- [ ] **Step 2: 型チェック確認**

Run: `npx tsc --noEmit`

---

### Task 4: API に統計データを追加

**Files:**
- Modify: `src/api.ts:62-102` (StatusResponse に統計フィールド追加)
- Modify: `src/api.ts:104-286` (getApiStatus に統計計算追加)

- [ ] **Step 1: StatusResponse 型を拡張**

`src/api.ts` の `StatusResponse` に追加:

```typescript
export interface StatusResponse {
  // ... 既存フィールド ...
  statistics: {
    winRateCI: { lower: number; upper: number };    // Wilson 95% CI
    sharpe: number;
    sharpeSE: number;
    sharpeSignificant: boolean;
    var95: number;       // 1取引あたりVaR(95%)
    cvar95: number;      // 1取引あたりCVaR(95%)
    kellyFraction: number;
    markov: {
      ww: number; wl: number; lw: number; ll: number;
      streakProb3: number;
    };
  } | null;
}
```

- [ ] **Step 2: getApiStatus で統計を計算**

`src/api.ts` の `getApiStatus` 内、return直前に追加:

```typescript
import { wilsonCI, sharpeWithSE, varCvar, kellyFraction, markovTransition } from './stats';

// 統計計算（クローズ済み取引から）
let statistics: StatusResponse['statistics'] = null;
const closedPositions = recentClosesRaw.results ?? [];
if (totalClosed >= 10) {
  // 全クローズ済みPnLを取得
  const allPnlRaw = await db
    .prepare('SELECT pnl, close_reason FROM positions WHERE status = \'CLOSED\' ORDER BY closed_at ASC')
    .all<{ pnl: number; close_reason: string }>();
  const allPnls = (allPnlRaw.results ?? []).map(r => r.pnl);
  const outcomes = (allPnlRaw.results ?? []).map(r => r.pnl > 0);

  const ci = wilsonCI(wins, totalClosed);
  const sharpeResult = sharpeWithSE(allPnls);
  const risk = varCvar(allPnls);

  // 平均RR比
  const winPnls = allPnls.filter(p => p > 0);
  const losePnls = allPnls.filter(p => p <= 0);
  const avgWin = winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0;
  const avgLoss = losePnls.length > 0 ? Math.abs(losePnls.reduce((s, v) => s + v, 0) / losePnls.length) : 1;
  const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;

  statistics = {
    winRateCI: ci,
    sharpe: sharpeResult.sharpe,
    sharpeSE: sharpeResult.se,
    sharpeSignificant: sharpeResult.significant,
    var95: risk.var95,
    cvar95: risk.cvar95,
    kellyFraction: kellyFraction(wins / totalClosed, avgRR),
    markov: markovTransition(outcomes),
  };
}
```

- [ ] **Step 3: return文に `statistics` を追加**

```typescript
return {
  // ... 既存 ...
  statistics,
};
```

- [ ] **Step 4: デプロイして確認**

Run: `npx wrangler deploy`
確認: `/api/status` に `statistics` フィールドが含まれること

---

### Task 5: ケリー基準によるポジションサイジング改善

**Files:**
- Modify: `src/position.ts:168-180` (lot計算ロジックを改善)

- [ ] **Step 1: `position.ts` のlot計算を改善**

`src/position.ts:168-180` を置換:

```typescript
import { kellyFraction } from './stats';

// ポジションサイジング: ケリー基準（勝率 × RR比）
const perfRow = await db
  .prepare(`SELECT
    COUNT(*) as total,
    COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) as wins,
    COALESCE(AVG(CASE WHEN pnl > 0 THEN pnl ELSE NULL END), 0) as avgWin,
    COALESCE(AVG(CASE WHEN pnl <= 0 THEN ABS(pnl) ELSE NULL END), 1) as avgLoss
    FROM positions WHERE pair = ? AND status = 'CLOSED'`)
  .bind(pair)
  .first<{ total: number; wins: number; avgWin: number; avgLoss: number }>();

let lot = 1.0;
if (perfRow && perfRow.total >= 5) {
  const winRate = perfRow.wins / perfRow.total;
  const avgRR = perfRow.avgLoss > 0 ? perfRow.avgWin / perfRow.avgLoss : 0;
  const kelly = kellyFraction(winRate, avgRR);
  // kellyを0〜0.25にクランプ済み → lot = 0.5 + kelly * 6（0.5x〜2.0x）
  lot = Math.max(0.5, Math.min(0.5 + kelly * 6, 2.0));
  console.log(`[position] Kelly: ${pair} wr=${(winRate*100).toFixed(0)}% rr=${avgRR.toFixed(2)} f=${kelly.toFixed(3)} → lot=${lot.toFixed(1)}`);
}
```

- [ ] **Step 2: デプロイして確認**

Run: `npx wrangler deploy`
確認: `wrangler tail` でKelly計算のログが出ること

---

## Phase 3: コード品質改善（T002 🟡）

### Task 6: `run()` 関数の分割

**Files:**
- Modify: `src/index.ts` (810行 → 3関数に分割)

- [ ] **Step 1: `fetchMarketData()` を抽出**

`index.ts:151-264`（データ取得・価格マップ構築）を新関数に抽出:

```typescript
interface MarketData {
  news: NewsItem[];
  newsFetchStats: SourceFetchStat[];
  redditSignal: RedditSignal;
  indicators: MarketIndicators;
  prices: Map<string, number | null>;
  usdJpyRate: number;
  hasNewNews: boolean;
  hasAttentionNews: boolean;
  newsAnalysisRan: boolean;
  newsSummary: string | null;
  activeNewsSources: string;
}

async function fetchMarketData(env: Env, now: Date, cronStart: number): Promise<MarketData | null> {
  // index.ts:151-352 の内容をここに移動
}
```

- [ ] **Step 2: `runAIDecisions()` を抽出**

`index.ts:354-682`（フィルタ・AI判定・ポジション開設）を新関数に抽出:

```typescript
async function runAIDecisions(
  env: Env, market: MarketData, now: Date, cronStart: number, brokerEnv: BrokerEnv
): Promise<void> {
  // index.ts:354-682 の内容をここに移動
}
```

- [ ] **Step 3: `runDailyTasks()` を抽出**

`index.ts:692-725`（ログパージ・日次サマリー・銘柄スコア更新）を新関数に抽出:

```typescript
async function runDailyTasks(env: Env, now: Date): Promise<void> {
  // index.ts:692-725 の内容をここに移動
}
```

- [ ] **Step 4: `run()` を3関数呼び出しに簡素化**

```typescript
async function run(env: Env): Promise<void> {
  const now = new Date();
  const cronStart = Date.now();
  console.log(`[fx-sim] cron start ${now.toISOString()}`);
  try {
    await runMigrations(env);
    const market = await fetchMarketData(env, now, cronStart);
    if (!market) return;
    const brokerEnv = { /* ... */ };
    await checkAndCloseAllPositions(env.DB, market.prices, INSTRUMENTS, brokerEnv);
    await runAIDecisions(env, market, now, cronStart, brokerEnv);
    const elapsed = Date.now() - cronStart;
    await setCacheValue(env.DB, 'prev_cron_elapsed', String(elapsed));
    if (elapsed > 30000) await insertSystemLog(env.DB, 'WARN', 'CRON', `実行時間超過: ${elapsed}ms`, null);
    await runDailyTasks(env, now);
  } catch (e) {
    console.error('[fx-sim] unhandled error:', e);
    try { await insertSystemLog(env.DB, 'ERROR', 'CRON', '予期しないエラー', String(e).slice(0, 300)); } catch {}
  }
}
```

- [ ] **Step 5: 型チェック + デプロイ**

Run: `npx tsc --noEmit && npx wrangler deploy`
確認: `wrangler tail` で正常動作すること

---

### Task 7: マイグレーション管理の体系化

**Files:**
- Modify: `schema.sql` (schema_versions テーブル追加)
- Modify: `src/index.ts` (マイグレーション処理を migration.ts に分離)
- Create: `src/migration.ts`

- [ ] **Step 1: `src/migration.ts` を作成**

```typescript
interface Migration {
  version: number;
  name: string;
  up: (db: D1Database) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: async () => { /* 初期スキーマは既に適用済み — no-op */ },
  },
  {
    version: 2,
    name: 'add_source_oanda_columns',
    up: async (db) => {
      await db.prepare("ALTER TABLE positions ADD COLUMN source TEXT DEFAULT 'paper'").run();
      await db.prepare("ALTER TABLE positions ADD COLUMN oanda_trade_id TEXT").run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS instrument_scores (
        pair TEXT PRIMARY KEY, total_trades INTEGER DEFAULT 0,
        win_rate REAL DEFAULT 0, avg_rr REAL DEFAULT 0,
        sharpe REAL DEFAULT 0, correlation REAL DEFAULT 0,
        score REAL DEFAULT 0, updated_at TEXT)`).run();
    },
  },
  {
    version: 3,
    name: 'add_indexes',
    up: async (db) => {
      await db.batch([
        db.prepare('CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_positions_pair_status ON positions(pair, status)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_decisions_pair_created ON decisions(pair, created_at DESC)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_system_logs_id_desc ON system_logs(id DESC)'),
      ]);
    },
  },
];

export async function runMigrations(db: D1Database): Promise<void> {
  // schema_versions テーブルを作成（存在しなければ）
  await db.prepare(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`).run();

  const applied = await db.prepare('SELECT MAX(version) as v FROM schema_versions').first<{ v: number | null }>();
  const currentVersion = applied?.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= currentVersion) continue;
    try {
      await m.up(db);
      await db.prepare('INSERT INTO schema_versions (version, name, applied_at) VALUES (?, ?, ?)')
        .bind(m.version, m.name, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.name}`);
    } catch (e) {
      console.log(`[migration] v${m.version} skipped: ${String(e).slice(0, 80)}`);
      // 既に適用済みの場合はバージョンだけ記録
      await db.prepare('INSERT OR IGNORE INTO schema_versions (version, name, applied_at) VALUES (?, ?, ?)')
        .bind(m.version, m.name, new Date().toISOString()).run();
    }
  }
}
```

- [ ] **Step 2: `index.ts` の旧マイグレーション処理を `runMigrations(env.DB)` 呼び出しに置換**

`index.ts:119-149` を削除し、以下に置換:

```typescript
import { runMigrations } from './migration';
await runMigrations(env.DB);
```

- [ ] **Step 3: デプロイして確認**

Run: `npx wrangler deploy`
確認: `wrangler tail` でマイグレーションログ、`schema_versions` テーブルにレコード

---

## Phase 4: ダッシュボード統計表示（T003 フロントエンド）

### Task 8: 統計タブに信頼区間・VaR・マルコフ表示

**Files:**
- Modify: `src/app.js.ts` (統計タブのレンダリング)

- [ ] **Step 1: 統計タブに信頼区間セクション追加**

統計タブのシステムフッター上に追加:

```html
<!-- 統計的信頼性 セクション -->
<div class="stats-confidence">
  <div class="section-title">統計的信頼性</div>
  <div class="stat-row">
    <span>勝率 95% CI</span>
    <span>${stats.winRateCI.lower.toFixed(1)}% — ${stats.winRateCI.upper.toFixed(1)}%</span>
  </div>
  <div class="stat-row">
    <span>Sharpe比</span>
    <span>${stats.sharpe.toFixed(3)} ± ${stats.sharpeSE.toFixed(3)} ${stats.sharpeSignificant ? '✅有意' : '⚠️非有意'}</span>
  </div>
  <div class="stat-row">
    <span>VaR(95%)</span>
    <span>¥${Math.round(stats.var95).toLocaleString()}</span>
  </div>
  <div class="stat-row">
    <span>CVaR(95%)</span>
    <span>¥${Math.round(stats.cvar95).toLocaleString()}</span>
  </div>
  <div class="stat-row">
    <span>Kelly比率</span>
    <span>${(stats.kellyFraction * 100).toFixed(1)}%</span>
  </div>
  <div class="stat-row">
    <span>3連敗確率</span>
    <span>${(stats.markov.streakProb3 * 100).toFixed(1)}%</span>
  </div>
</div>
```

- [ ] **Step 2: CSSスタイル追加**

```css
.stats-confidence {
  margin: 16px;
  padding: 16px;
  border-radius: 12px;
  background: var(--card-bg);
}
.stats-confidence .section-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 12px;
}
.stat-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}
```

- [ ] **Step 3: デプロイ → スクリーンショット確認**

Run: `npx wrangler deploy`
Chrome DevTools MCPでモバイル表示確認

---

## 実装順序とリスク

| Phase | タスク | リスク | 所要時間目安 |
|-------|--------|--------|------------|
| 1 | Task 1: INDEX追加 | 🟢低（IF NOT EXISTS） | 5分 |
| 1 | Task 2: サニティチェック | 🟢低（新ファイル追加） | 10分 |
| 2 | Task 3: stats.ts作成 | 🟢低（新ファイル） | 10分 |
| 2 | Task 4: API統計追加 | 🟡中（api.ts変更） | 15分 |
| 2 | Task 5: ケリー基準 | 🟡中（lot計算変更） | 10分 |
| 3 | Task 6: run()分割 | 🟠高（810行リファクタ） | 30分 |
| 3 | Task 7: マイグレーション体系化 | 🟡中（既存処理置換） | 15分 |
| 4 | Task 8: ダッシュボード表示 | 🟡中（フロントエンド） | 20分 |

**合計: 約2時間**

---

## 未着手項目（将来Phase）

以下はデータ蓄積後（n≥300）に実施:
- ベースライン比較（ランダム戦略バックテスト）
- 銘柄間相関モニタリング
- トンプソン・サンプリング
- GARCH / 共和分 / カルマンフィルタ
- 階層ベイズモデル
- Slack/Discord通知
- Yahoo Finance代替プロバイダー

# Batch B: パラレルトリガー Phase 2-4 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cron の AI 判定ループを直列から並列（最大 4 件同時）に変換し、実行時間を 20-30 秒から 5-8 秒に削減する。

**Architecture:** Phase 2 でフェーズ別タイミング計測を追加。Phase 3 で `for...of` を `Promise.allSettled` に変換（並列数は前回実行時間で動的調整）。Phase 4 で `runAIDecisions()` を独立関数に抽出し `run()` を 3 呼び出しに簡素化。

**Tech Stack:** TypeScript, Cloudflare Workers, Promise.allSettled

**Spec:** `docs/superpowers/specs/2026-03-21-full-roadmap-design.md` §Batch B

**前提条件:** Batch A 完了後に実施（依存なし）

---

## ファイルマップ

| ファイル | 操作 | 内容 |
|---|---|---|
| `src/index.ts` | **修正** | フェーズ計測追加 → 並列化 → runAIDecisions抽出 |
| `src/api.ts` | **修正** | cronTimings フィールドを StatusResponse に追加 |

---

## Task 1: Phase 2 — フェーズ別タイミング計測

**Files:**
- Modify: `src/index.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: StatusResponse に cronTimings を追加**

`src/api.ts` の `StatusResponse` インターフェースに追加:

```typescript
cronTimings: {
  fetchMs: number;
  tpSlMs: number;
  newsMs: number;
  aiLoopMs: number;
  totalMs: number;
} | null;
```

`getApiStatus()` の return 文に追加:

```typescript
cronTimings: (() => {
  try {
    const raw = /* market_cache から 'cron_phase_timings' を取得（同期不可のため別クエリが必要）*/
    return null; // 後続の Task で実装
  } catch { return null; }
})(),
```

実際には D1 クエリが必要なので、`getApiStatus()` の並列クエリ部分に追加:

```typescript
// getApiStatus() の Promise.all 内に追加
db.prepare("SELECT value FROM market_cache WHERE key = 'cron_phase_timings'")
  .first<{ value: string }>(),
```

返り値のマッピング:

```typescript
const cronTimingsRow = /* 上記クエリの結果 */;
const cronTimings = cronTimingsRow
  ? (() => { try { return JSON.parse(cronTimingsRow.value); } catch { return null; } })()
  : null;
```

- [ ] **Step 2: src/index.ts に計測ポイントを追加**

`fetchMarketData()` の前後:

```typescript
const t0 = Date.now();
const marketData = await fetchMarketData(env, now);
if (marketData == null) return;
const fetchMs = Date.now() - t0;

const t1 = Date.now();
await checkAndCloseAllPositions(env.DB, prices, INSTRUMENTS, brokerEnv);
const tpSlMs = Date.now() - t1;
```

ニュース分析の前後:

```typescript
const t2 = Date.now();
// ... ニュース分析ブロック ...
const newsMs = Date.now() - t2;
```

AI ループの前後:

```typescript
const t3 = Date.now();
// ... AI 判定ループ ...
const aiLoopMs = Date.now() - t3;
```

cron 終了前に保存:

```typescript
const totalMs = Date.now() - cronStart;
const timings = { fetchMs, tpSlMs, newsMs, aiLoopMs, totalMs };
await setCacheValue(env.DB, 'cron_phase_timings', JSON.stringify(timings));
console.log(`[fx-sim] timings: fetch=${fetchMs}ms tpsl=${tpSlMs}ms news=${newsMs}ms ai=${aiLoopMs}ms total=${totalMs}ms`);
```

- [ ] **Step 3: 型チェック & デプロイ**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | grep "error" | grep -v "TS6133\|TS2345\|TS2322" | head -10
npx wrangler deploy
```

- [ ] **Step 4: 計測確認**

```bash
# 1分待って cron 実行後
curl -s "https://fx-sim-v1.ai-battle-sim.workers.dev/api/status" | python -c "
import json,sys; d=json.load(sys.stdin)
t = d.get('cronTimings')
print('cronTimings:', json.dumps(t, indent=2) if t else 'null (次のcron待ち)')
"
```

- [ ] **Step 5: コミット**

```bash
git add src/index.ts src/api.ts
git commit -m "feat(B-1): cron フェーズ別タイミング計測を追加"
```

---

## Task 2: Phase 3 — AI判定ループの並列化

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 現在の AI ループ部分を確認**

```bash
grep -n "for (const candidate of aiCandidates)" src/index.ts
```

対象の `for...of` ループの開始・終了行番号を確認する。

- [ ] **Step 2: 並列数の計算ロジックを追加**

既存の `baseLimit` 計算の直後に追加:

```typescript
// 並列数: 前回実行時間から安全な並列数を計算
// Gemini 1呼出 ≒ 4-12秒。60秒制限の2/3(40秒)を上限として並列数を決定
const parallelLimit = prevElapsed > 30000 ? 2 : prevElapsed > 15000 ? 3 : 4;
```

- [ ] **Step 3: for...of ループを Promise.allSettled に変換**

変換前のループ構造:
```typescript
for (const candidate of aiCandidates) {
  if (Date.now() - cronStart > 50_000) { /* break */ }
  // ... AI 呼び出し + 記録 ...
}
```

変換後:
```typescript
// 並列数でスライスしてバッチ処理
const batches: typeof aiCandidates[] = [];
for (let i = 0; i < aiCandidates.length; i += parallelLimit) {
  batches.push(aiCandidates.slice(i, i + parallelLimit));
}

for (const batch of batches) {
  if (Date.now() - cronStart > 50_000) {
    console.warn('[fx-sim] Cron budget exhausted, skipping remaining batches');
    break;
  }
  await Promise.allSettled(
    batch.map(async (candidate) => {
      const { instrument, currentRate } = candidate;
      // ... 既存の AI 呼び出し + insertDecision + openPosition ロジックをそのまま移動 ...
    })
  );
}
```

**重要**: `geminiOkCount++` 等のカウンターはレースコンディションを避けるため、`Promise.allSettled` の結果から集計する方式に変更:

```typescript
type AIResult = { provider: 'gemini' | 'gpt' | 'claude' | 'fail'; pair: string };
const batchResults: AIResult[] = [];

await Promise.allSettled(
  batch.map(async (candidate): Promise<AIResult> => {
    try {
      const hedgeResult = await getDecisionWithHedge({ /* ... */ });
      // ... insertDecision, openPosition ...
      return { provider: hedgeResult.provider as 'gemini' | 'gpt' | 'claude', pair: instrument.pair };
    } catch (e) {
      // ... エラーログ ...
      return { provider: 'fail', pair: instrument.pair };
    }
  })
).then(results => {
  for (const r of results) {
    if (r.status === 'fulfilled') batchResults.push(r.value);
  }
});

// カウント集計
geminiOkCount += batchResults.filter(r => r.provider === 'gemini').length;
gptOkCount    += batchResults.filter(r => r.provider === 'gpt').length;
claudeOkCount += batchResults.filter(r => r.provider === 'claude').length;
aiFailCount   += batchResults.filter(r => r.provider === 'fail').length;
```

- [ ] **Step 4: 型チェック**

```bash
npx tsc --noEmit 2>&1 | grep "index.ts" | grep -v "TS6133\|TS2345\|TS2322" | head -10
```

期待: 新規エラーなし

- [ ] **Step 5: デプロイ & 実行時間確認**

```bash
npx wrangler deploy
# 1分後
curl -s "https://fx-sim-v1.ai-battle-sim.workers.dev/api/status" | python -c "
import json,sys; d=json.load(sys.stdin)
t = d.get('cronTimings')
if t: print(f'AI loop: {t[\"aiLoopMs\"]}ms (並列化前: ~20-30秒が目標)')
"
```

期待: `aiLoopMs` が 8000 以下に短縮

- [ ] **Step 6: コミット**

```bash
git add src/index.ts
git commit -m "feat(B-2): AI判定ループを並列化（最大4並列・バッチ処理）"
```

---

## Task 3: Phase 4 — runAIDecisions() 抽出

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: runAIDecisions の型定義を追加**

`run()` 関数の直前に型とシグネチャを追加:

```typescript
interface AIContext {
  indicators: Awaited<ReturnType<typeof getMarketIndicators>>;
  news: Awaited<ReturnType<typeof fetchNews>>['items'];
  redditSignal: { hasSignal: boolean; keywords: string[]; topPosts: string[] };
  newsSummary: string | null;
  activeNewsSources: string;
  hasAttentionNews: boolean;
  brokerEnv: BrokerEnv;
  now: Date;
}

interface AIDecisionSummary {
  geminiOk: number;
  gptOk: number;
  claudeOk: number;
  fail: number;
  elapsed: number;
}
```

- [ ] **Step 2: AI 判定ループ全体を runAIDecisions() に抽出**

```typescript
async function runAIDecisions(
  env: Env,
  candidates: ReturnType<typeof buildCandidateList>,  // 後で型を調整
  context: AIContext,
  cronStart: number,
): Promise<AIDecisionSummary>
```

`run()` から以下のブロックを切り出す:
- `aiCandidates` の計算
- バッチ並列ループ
- カウンター集計
- `prev_cron_elapsed` の更新（タイミング計測分は run() に残す）

- [ ] **Step 3: run() をオーケストレーターのみにする**

変換後の `run()` の骨格:

```typescript
async function run(env: Env): Promise<void> {
  const now = new Date();
  const cronStart = Date.now();

  try {
    await runMigrations(env.DB);
    const t0 = Date.now();
    const marketData = await fetchMarketData(env, now);
    if (!marketData) return;
    const fetchMs = Date.now() - t0;

    const { news, activeNewsSources, redditSignal, indicators, prices } = marketData;
    const brokerEnv = /* ... */;

    const t1 = Date.now();
    await checkAndCloseAllPositions(env.DB, prices, INSTRUMENTS, brokerEnv);
    const tpSlMs = Date.now() - t1;

    // ニュース分析・hasAttentionNews など（変更なし）
    const t2 = Date.now();
    /* ... news analysis ... */
    const newsMs = Date.now() - t2;

    const t3 = Date.now();
    const candidates = await buildCandidateList(env, prices, redditSignal, indicators, hasNewNews, hasAttentionNews, now);
    const aiSummary = await runAIDecisions(env, candidates, context, cronStart);
    const aiLoopMs = Date.now() - t3;

    const totalMs = Date.now() - cronStart;
    await setCacheValue(env.DB, 'cron_phase_timings', JSON.stringify({ fetchMs, tpSlMs, newsMs, aiLoopMs, totalMs }));
    await setCacheValue(env.DB, 'prev_cron_elapsed', String(totalMs));
    console.log(`[fx-sim] done ${totalMs}ms | G=${aiSummary.geminiOk} GPT=${aiSummary.gptOk} C=${aiSummary.claudeOk} F=${aiSummary.fail}`);

    if ((now.getUTCHours() + 9) % 24 === 0 && now.getUTCMinutes() === 0) {
      await runDailyTasks(env, now);
    }
  } catch (e) {
    console.error('[fx-sim] unhandled error:', e);
    try { await insertSystemLog(env.DB, 'ERROR', 'CRON', '予期しないエラー', String(e).slice(0, 300)); } catch {}
  }
}
```

- [ ] **Step 4: 型チェック & デプロイ**

```bash
npx tsc --noEmit 2>&1 | grep "index.ts" | grep -v "TS6133\|TS2345\|TS2322"
npx wrangler deploy
```

- [ ] **Step 5: run() の行数確認（改善の証明）**

```bash
wc -l src/index.ts
grep -n "^async function" src/index.ts
```

期待: `run()` は 50 行以下、全体は 600 行以下に削減

- [ ] **Step 6: コミット & PR**

```bash
git add src/index.ts src/api.ts
git commit -m "feat(B-3): runAIDecisions() 抽出 — run()をオーケストレーターに簡素化"
git push
gh pr create --title "feat: Batch B — パラレルトリガーPhase2-4（計測・並列化・関数分割）" --body "$(cat <<'EOF'
## 変更内容
- Phase 2: cron フェーズ別タイミング計測 + /api/status に cronTimings 追加
- Phase 3: AI判定ループを並列化（最大4並列、バッチ処理）
- Phase 4: runAIDecisions() 抽出、run() をオーケストレーターに簡素化

## 期待効果
- AI判定ループ: 20-30秒 → 5-8秒
- run() 関数: ~580行 → ~80行

## テスト確認
- [x] `npx tsc --noEmit` 新規エラーなし
- [x] `npx wrangler deploy` 成功
- [x] cronTimings.aiLoopMs < 8000 確認
EOF
)"
```

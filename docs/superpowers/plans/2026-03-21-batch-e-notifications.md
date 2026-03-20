# Batch E: 運用通知 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slack/Discord Webhook で DRAWDOWN WARN・ERROR・TP/SL 決済・日次サマリーを通知し、運用監視を自動化する。

**Architecture:** `src/notify.ts` を新規作成し `sendNotification()` で Slack/Discord の差異を吸収。cron 内の重要イベント（DRAWDOWN・ERROR・TP/SL）と `runDailyTasks()` の日次サマリーから呼び出す。失敗時はサイレント（cron を止めない）。

**Tech Stack:** TypeScript, Cloudflare Workers, Slack Incoming Webhooks, Discord Webhooks

**Spec:** `docs/superpowers/specs/2026-03-21-full-roadmap-design.md` §Batch E

**前提条件:** 他バッチと独立して実施可能（依存なし）

---

## ファイルマップ

| ファイル | 操作 | 内容 |
|---|---|---|
| `src/notify.ts` | **新規作成** | sendNotification, buildDailySummaryMessage, buildTpSlMessage, buildDrawdownMessage, getWebhookUrl |
| `src/index.ts` | **修正** | Env型にWebhook URL追加・notify import・ERROR catch に通知追加・日次サマリー通知 |
| `src/position.ts` | **修正** | checkAndCloseAllPositions に webhookUrl 追加・TP/SL 決済後に通知・openPosition 内 DRAWDOWN 通知 |

---

## Task 1: src/notify.ts を新規作成

**Files:**
- Create: `src/notify.ts`

- [ ] **Step 1: 型定義と sendNotification() を実装**

```typescript
// src/notify.ts

/**
 * Slack または Discord に通知を送る
 * - Slack: { text: "..." }
 * - Discord: { content: "..." }
 * URL のドメインで自動判別
 */
export async function sendNotification(
  webhookUrl: string | undefined,
  text: string,
): Promise<void> {
  if (!webhookUrl) return;

  const isDiscord = webhookUrl.includes('discord.com');
  const body = isDiscord
    ? JSON.stringify({ content: text })
    : JSON.stringify({ text });

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[notify] webhook failed: ${res.status}`);
    }
  } catch (e) {
    // 通知失敗は無視（cron を止めない）
    console.warn('[notify] webhook error:', e);
  }
}

/** Env から有効な Webhook URL を返す（Slack 優先） */
export function getWebhookUrl(env: {
  SLACK_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
}): string | undefined {
  return env.SLACK_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL || undefined;
}
```

- [ ] **Step 2: buildDrawdownMessage() を追加**

```typescript
export function buildDrawdownMessage(params: {
  consecutiveLosses: number;
  lotMultiplier: number;
  pair: string;
}): string {
  const { consecutiveLosses, lotMultiplier, pair } = params;
  if (lotMultiplier === 0) {
    return `🚨 [fx-sim] ${pair} 連敗${consecutiveLosses}回 — 発注停止中`;
  }
  const pct = Math.round(lotMultiplier * 100);
  return `⚠️ [fx-sim] ${pair} 連敗${consecutiveLosses}回 — ロット縮退 ${pct}%`;
}
```

- [ ] **Step 3: buildTpSlMessage() を追加**

```typescript
export function buildTpSlMessage(params: {
  pair: string;
  direction: 'BUY' | 'SELL';
  reason: 'TP' | 'SL';
  pnl: number;
  entryRate: number;
  closeRate: number;
}): string {
  const { pair, direction, reason, pnl, entryRate, closeRate } = params;
  const emoji = reason === 'TP' ? '✅' : '❌';
  const sign = pnl >= 0 ? '+' : '';
  return `${emoji} [fx-sim] ${pair} ${direction} ${reason} | エントリー:${entryRate} → クローズ:${closeRate} | PnL: ${sign}${pnl.toFixed(1)} pip`;
}
```

- [ ] **Step 4: buildDailySummaryMessage() を追加**

```typescript
export function buildDailySummaryMessage(params: {
  date: string;         // 'YYYY-MM-DD'
  totalTrades: number;
  wins: number;
  totalPnl: number;
  geminiOk: number;
  gptOk: number;
  claudeOk: number;
}): string {
  const { date, totalTrades, wins, totalPnl, geminiOk, gptOk, claudeOk } = params;
  const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
  const sign = totalPnl >= 0 ? '+' : '';
  return (
    `📊 [fx-sim] 日次サマリー ${date}\n` +
    `取引: ${totalTrades}件 | 勝率: ${winRate}% | PnL: ${sign}${totalPnl.toFixed(1)} pip\n` +
    `AI: Gemini ${geminiOk} / GPT ${gptOk} / Claude ${claudeOk}`
  );
}
```

- [ ] **Step 5: 型チェック**

```bash
npx tsc --noEmit 2>&1 | grep "notify.ts" | grep -v "TS6133"
```

期待: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/notify.ts
git commit -m "feat(E-1): src/notify.ts 追加 — sendNotification/メッセージビルダー"
```

---

## Task 2: Env インターフェースと import を更新

**Files:**
- Modify: `src/index.ts`

**注意:** Webhook URL は `wrangler secret put` で設定する（`wrangler.toml` の `[vars]` には書かない）。`Env` 型にオプショナルフィールドを追加するだけでよい。環境変数未設定時は `sendNotification` が無音でスキップする。

- [ ] **Step 1: Env インターフェースに追加**

`src/index.ts` の `interface Env` を検索:

```bash
grep -n "interface Env" src/index.ts
```

その `interface Env { ... }` ブロックの末尾（`}` の直前）に以下の2フィールドを追記:

```typescript
  SLACK_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
```

- [ ] **Step 2: notify.ts から import を追加**

`src/index.ts` の先頭付近の import ブロックに追記（既存 import 行の末尾に追加）:

```typescript
import { sendNotification, getWebhookUrl, buildDailySummaryMessage } from './notify';
```

- [ ] **Step 3: 型チェック**

```bash
npx tsc --noEmit 2>&1 | grep -E "index.ts|notify.ts" | grep "error" | grep -v "TS6133" | head -10
```

期待: エラーなし

- [ ] **Step 4: コミット**

```bash
git add src/index.ts
git commit -m "feat(E-2): Env に SLACK/DISCORD_WEBHOOK_URL を追加・notify import"
```

---

## Task 3: TP/SL 決済時の通知

**Files:**
- Modify: `src/position.ts`

- [ ] **Step 1: checkAndCloseAllPositions() に webhookUrl を追加**

`src/position.ts:36` の関数シグネチャ末尾に `webhookUrl` を追加:

```typescript
// 変更前（src/position.ts:36-41）:
export async function checkAndCloseAllPositions(
  db: D1Database,
  prices: Map<string, number | null>,
  instruments: InstrumentConfig[],
  brokerEnv?: BrokerEnv
): Promise<void>

// 変更後:
export async function checkAndCloseAllPositions(
  db: D1Database,
  prices: Map<string, number | null>,
  instruments: InstrumentConfig[],
  brokerEnv?: BrokerEnv,
  webhookUrl?: string,
): Promise<void>
```

- [ ] **Step 2: notify.ts から import を追加**

`src/position.ts` の先頭 import ブロックに追記:

```typescript
import { sendNotification, buildTpSlMessage } from './notify';
```

- [ ] **Step 3: TP 決済後に通知を追加**

`src/position.ts:109` にある `await closePosition(db, pos.id, currentRate, 'TP', pnl);` の行の直後（`await updateDecisionOutcome(...)` の前）に追加:

```typescript
// 追加: TP 通知（currentRate はこの時点で number に絞り込まれている）
await sendNotification(webhookUrl, buildTpSlMessage({
  pair: pos.pair,
  direction: pos.direction as 'BUY' | 'SELL',
  reason: 'TP',
  pnl,
  entryRate: pos.entry_rate,
  closeRate: currentRate,
}));
```

- [ ] **Step 4: SL 決済後に通知を追加**

`src/position.ts:129` にある `await closePosition(db, pos.id, currentRate, 'SL', pnl);` の行の直後（`await updateDecisionOutcome(...)` の前）に追加:

```typescript
// 追加: SL 通知
await sendNotification(webhookUrl, buildTpSlMessage({
  pair: pos.pair,
  direction: pos.direction as 'BUY' | 'SELL',
  reason: 'SL',
  pnl,
  entryRate: pos.entry_rate,
  closeRate: currentRate,
}));
```

- [ ] **Step 5: src/index.ts の呼び出し箇所を更新**

`run()` 内（`src/index.ts:243`）の `checkAndCloseAllPositions` 呼び出しに `getWebhookUrl(env)` を追加:

```bash
grep -n "checkAndCloseAllPositions" src/index.ts
```

```typescript
// 変更前:
await checkAndCloseAllPositions(env.DB, prices, INSTRUMENTS, brokerEnv);
// 変更後:
await checkAndCloseAllPositions(env.DB, prices, INSTRUMENTS, brokerEnv, getWebhookUrl(env));
```

- [ ] **Step 6: 型チェック**

```bash
npx tsc --noEmit 2>&1 | grep -E "position.ts|index.ts" | grep "error" | grep -v "TS6133" | head -10
```

期待: エラーなし

- [ ] **Step 7: コミット**

```bash
git add src/position.ts src/index.ts
git commit -m "feat(E-3): TP/SL決済時にWebhook通知を送信"
```

---

## Task 4: DRAWDOWN WARN / ERROR 時の通知

**Files:**
- Modify: `src/position.ts`（DRAWDOWN）
- Modify: `src/index.ts`（ERROR）

- [ ] **Step 1: openPosition() のシグネチャを拡張**

`src/position.ts:180` の関数シグネチャに `webhookUrl` を追加（既存8引数の末尾、オプショナル）:

```typescript
// 変更前（src/position.ts:180-189）:
export async function openPosition(
  db: D1Database,
  pair: string,
  direction: 'BUY' | 'SELL',
  entryRate: number,
  tpRate: number | null,
  slRate: number | null,
  source: 'paper' | 'oanda' = 'paper',
  oandaTradeId: string | null = null
): Promise<void>

// 変更後（末尾に webhookUrl を追加）:
export async function openPosition(
  db: D1Database,
  pair: string,
  direction: 'BUY' | 'SELL',
  entryRate: number,
  tpRate: number | null,
  slRate: number | null,
  source: 'paper' | 'oanda' = 'paper',
  oandaTradeId: string | null = null,
  webhookUrl?: string,
): Promise<void>
```

- [ ] **Step 2: 7連敗ブロック（ddMultiplier === 0）に通知を追加**

`src/position.ts:219-224` の `if (ddMultiplier === 0)` ブロック内、`return` の直前に追加:

```typescript
  if (ddMultiplier === 0) {
    await insertSystemLog(db, 'WARN', 'DRAWDOWN',
      `7連敗縮退: ${pair} ${direction} 当日発注停止`,
      JSON.stringify({ consecutiveLosses, lot }));
    console.warn(`[position] 7連敗縮退: ${pair} 発注停止`);
    // 追加: 7連敗通知（return の直前）
    await sendNotification(webhookUrl, buildDrawdownMessage({
      consecutiveLosses, lotMultiplier: 0, pair,
    }));
    return;
  }
```

- [ ] **Step 3: 3-6連敗ブロック（ddMultiplier < 1.0）に通知を追加**

`src/position.ts:226-233` の `if (ddMultiplier < 1.0)` ブロック末尾（`insertSystemLog` の直後）に追加:

```typescript
  if (ddMultiplier < 1.0) {
    const prevLot = lot;
    lot = Math.max(0.1, lot * ddMultiplier);
    console.log(`[position] 連敗縮退: ${consecutiveLosses}連敗 ×${ddMultiplier} lot ${prevLot.toFixed(1)} → ${lot.toFixed(1)}`);
    await insertSystemLog(db, 'INFO', 'DRAWDOWN',
      `連敗縮退 ${consecutiveLosses}連敗 → lot×${ddMultiplier}: ${pair}`,
      null);
    // 追加: 縮退通知
    await sendNotification(webhookUrl, buildDrawdownMessage({
      consecutiveLosses, lotMultiplier: ddMultiplier, pair,
    }));
  }
```

- [ ] **Step 4: notify import を position.ts に追加（Task 3 で追加済みの場合はスキップ）**

`src/position.ts` 先頭の import ブロックに `buildDrawdownMessage` を追記:

```typescript
import { sendNotification, buildTpSlMessage, buildDrawdownMessage } from './notify';
```

- [ ] **Step 5: src/index.ts の openPosition() 呼び出しを更新**

`src/index.ts:633-642` の呼び出しに `getWebhookUrl(env)` を末尾に追加:

```typescript
// 変更前（src/index.ts:633-642）:
await openPosition(
  env.DB,
  instrument.pair,
  geminiResult.decision,
  currentRate,
  geminiResult.tp_rate,
  geminiResult.sl_rate,
  source,
  oandaTradeId
);

// 変更後:
await openPosition(
  env.DB,
  instrument.pair,
  geminiResult.decision,
  currentRate,
  geminiResult.tp_rate,
  geminiResult.sl_rate,
  source,
  oandaTradeId,
  getWebhookUrl(env),
);
```

- [ ] **Step 6: cron ERROR catch に通知を追加**

`run()` の最外側 catch ブロックを探す:

```bash
grep -n "unhandled error\|insertSystemLog.*ERROR.*CRON" src/index.ts | head -5
```

`console.error('[fx-sim] unhandled error:', e);` の行の直後（`try { await insertSystemLog...` の前）に以下を挿入:

```typescript
  // 追加: cron エラー通知
  await sendNotification(
    getWebhookUrl(env),
    `🔴 [fx-sim] cron エラー: ${String(e).slice(0, 200)}`,
  );
```

結果として catch ブロックは以下の順序になる:
```typescript
} catch (e) {
  console.error('[fx-sim] unhandled error:', e);
  await sendNotification(            // ← 追加
    getWebhookUrl(env),
    `🔴 [fx-sim] cron エラー: ${String(e).slice(0, 200)}`,
  );
  try { await insertSystemLog(env.DB, 'ERROR', 'CRON', '予期しないエラー', String(e).slice(0, 300)); } catch {}
}
```

- [ ] **Step 7: 型チェック**

```bash
npx tsc --noEmit 2>&1 | grep -E "position.ts|index.ts" | grep "error" | grep -v "TS6133" | head -10
```

期待: エラーなし

- [ ] **Step 8: コミット**

```bash
git add src/position.ts src/index.ts
git commit -m "feat(E-4): DRAWDOWN WARN（7連敗/縮退）/ cron ERROR 時にWebhook通知"
```

---

## Task 5: 日次サマリー通知

**Files:**
- Modify: `src/index.ts`（runDailyTasks 内）

- [ ] **Step 1: runDailyTasks() の末尾に日次集計クエリを追加**

`runDailyTasks()` の既存処理（ログパージ・銘柄スコア更新）の後に追加。

**日付計算は UTC で統一する**（Cloudflare Workers は UTC タイムゾーン）:

```typescript
// Task 2 で import 済みの buildDailySummaryMessage, sendNotification, getWebhookUrl を使う

// 前日の日付文字列を UTC で計算
const yesterdayStart = new Date(Date.UTC(
  _now.getUTCFullYear(), _now.getUTCMonth(), _now.getUTCDate() - 1
));
const todayStart = new Date(Date.UTC(
  _now.getUTCFullYear(), _now.getUTCMonth(), _now.getUTCDate()
));
const dateStr = yesterdayStart.toISOString().slice(0, 10);

const dailyStats = await env.DB.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
    COALESCE(SUM(pnl), 0) as total_pnl
  FROM positions
  WHERE status = 'CLOSED'
    AND closed_at >= ? AND closed_at < ?
`)
.bind(yesterdayStart.toISOString(), todayStart.toISOString())
.first<{ total: number; wins: number; total_pnl: number }>();

if (dailyStats && dailyStats.total > 0) {
  // decisions.provider カラムは Batch C-3 で追加される予定
  // カラムが存在しない場合は 0 をフォールバックとして使う
  let geminiOk = 0, gptOk = 0, claudeOk = 0;
  try {
    const aiStats = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN provider = 'gemini' THEN 1 ELSE 0 END) as gemini_ok,
        SUM(CASE WHEN provider = 'gpt'    THEN 1 ELSE 0 END) as gpt_ok,
        SUM(CASE WHEN provider = 'claude' THEN 1 ELSE 0 END) as claude_ok
      FROM decisions
      WHERE decision IN ('BUY', 'SELL')
        AND created_at >= ? AND created_at < ?
    `)
    .bind(yesterdayStart.toISOString(), todayStart.toISOString())
    .first<{ gemini_ok: number; gpt_ok: number; claude_ok: number }>();
    if (aiStats) {
      geminiOk = aiStats.gemini_ok ?? 0;
      gptOk    = aiStats.gpt_ok    ?? 0;
      claudeOk = aiStats.claude_ok ?? 0;
    }
  } catch {
    // provider カラムが存在しない場合はスキップ（Batch C-3 適用前）
  }

  const msg = buildDailySummaryMessage({
    date: dateStr,
    totalTrades: dailyStats.total,
    wins: dailyStats.wins,
    totalPnl: dailyStats.total_pnl,
    geminiOk,
    gptOk,
    claudeOk,
  });
  await sendNotification(getWebhookUrl(env), msg);
}
```

- [ ] **Step 2: 型チェック**

```bash
npx tsc --noEmit 2>&1 | grep "index.ts" | grep "error" | grep -v "TS6133" | head -10
```

期待: エラーなし

- [ ] **Step 3: デプロイ**

```bash
npx wrangler deploy
```

- [ ] **Step 4: /api/status で正常レスポンス確認**

```bash
curl -s "https://fx-sim-v1.ai-battle-sim.workers.dev/api/status" | python -c "import json,sys; d=json.load(sys.stdin); print('OK' if d.get('tradingMode') else 'NG')"
```

期待: `OK`

- [ ] **Step 5: コミット & PR**

```bash
git add src/index.ts src/notify.ts src/position.ts
git commit -m "feat(E-5): 日次サマリー通知をrunDailyTasksから送信"
git push
gh pr create --title "feat: Batch E — 運用通知（Slack/Discord Webhook）" --body "$(cat <<'EOF'
## 変更内容
- src/notify.ts 新規作成（sendNotification, buildDrawdownMessage, buildTpSlMessage, buildDailySummaryMessage, getWebhookUrl）
- TP/SL 決済時に Webhook 通知（src/position.ts）
- 連敗縮退（3-6回）・7連敗停止・cron ERROR 時に Webhook 通知
- runDailyTasks() から日次サマリーを Webhook 通知（UTC 日付計算）

## 設定方法
```bash
wrangler secret put SLACK_WEBHOOK_URL   # Slack 使用時
wrangler secret put DISCORD_WEBHOOK_URL  # Discord 使用時
```

## テスト確認
- [x] `npx tsc --noEmit` 新規エラーなし
- [x] `npx wrangler deploy` 成功
- [x] `/api/status` 正常レスポンス確認

## 影響範囲
- 通知失敗はサイレント（cron の動作に影響なし）
- 環境変数未設定時は通知をスキップ（後方互換）
- decisions.provider カラム未存在時も AI 集計は 0 でフォールバック（Batch C-3 適用前対応）
EOF
)"
```

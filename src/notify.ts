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
    `取引: ${totalTrades}件 | 勝率(RR≥1.0): ${winRate}% | PnL: ${sign}${totalPnl.toFixed(1)} pip\n` +
    `AI: Gemini ${geminiOk} / GPT ${gptOk} / Claude ${claudeOk}`
  );
}

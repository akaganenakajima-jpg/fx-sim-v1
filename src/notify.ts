// src/notify.ts — Discord Embed + Slack 通知

// ─── Discord Embed カラー定数 ─────────────────────────────────────────────────
const COLOR_GREEN  = 0x30D158; // TP（利確）
const COLOR_RED    = 0xFF453A; // SL（損切り）
const COLOR_YELLOW = 0xFF9F0A; // TIME_LIMIT / TIME_STOP
const COLOR_BLUE   = 0x0A84FF; // 情報通知
const COLOR_PURPLE = 0xBF5AF2; // AIスクリーナー

// ─── Discord Embed 型 ────────────────────────────────────────────────────────
interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

interface DiscordWebhookPayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

// ─── 送信関数 ─────────────────────────────────────────────────────────────────

/**
 * Slack または Discord に通知を送る
 * - Discord: Embed 形式対応（embeds パラメーター渡し可）
 * - Slack: { text: "..." } のプレーンテキスト
 */
export async function sendNotification(
  webhookUrl: string | undefined,
  text: string,
  embeds?: DiscordEmbed[],
): Promise<void> {
  if (!webhookUrl) return;

  const isDiscord = webhookUrl.includes('discord.com');
  let body: string;

  if (isDiscord && embeds?.length) {
    const payload: DiscordWebhookPayload = { embeds };
    body = JSON.stringify(payload);
  } else if (isDiscord) {
    body = JSON.stringify({ content: text });
  } else {
    body = JSON.stringify({ text });
  }

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

// ─── TP/SL/TIME_LIMIT 決済通知（Discord Embed） ──────────────────────────────

export function buildTpSlMessage(params: {
  pair: string;
  direction: 'BUY' | 'SELL';
  reason: 'TP' | 'SL' | 'TIME_STOP' | 'TIME_LIMIT';
  pnl: number;
  entryRate: number;
  closeRate: number;
  strategy?: string;
  regime?: string;
  confidence?: number | null;
  realizedRR?: number | null;
  holdMinutes?: number | null;
}): string {
  const { pair, direction, reason, pnl, entryRate, closeRate, strategy, regime, confidence, realizedRR } = params;
  const emoji = reason === 'TP' ? '\u2705' : reason === 'SL' ? '\u274C' : '\u23F0';
  const sign = pnl >= 0 ? '+' : '';
  const confBadge = confidence != null
    ? (confidence >= 75 ? '\uD83D\uDD25' : confidence >= 50 ? '\u26A1' : '')
    : '';
  const stratStr = strategy ? ` [${strategy}${regime ? '/' + regime : ''}]` : '';
  const rrStr = realizedRR != null ? ` RR=${realizedRR.toFixed(2)}` : '';
  return `${confBadge}${emoji} [fx-sim] ${pair} ${direction}${stratStr} ${reason} | ${entryRate} \u2192 ${closeRate} | PnL: ${sign}${pnl.toFixed(1)} pip${rrStr}`;
}

/** Discord Embed形式のTP/SL通知を構築 */
export function buildTpSlEmbed(params: {
  pair: string;
  direction: 'BUY' | 'SELL';
  reason: 'TP' | 'SL' | 'TIME_STOP' | 'TIME_LIMIT';
  pnl: number;
  pnlUnit: string;
  entryRate: number;
  closeRate: number;
  strategy?: string;
  regime?: string;
  confidence?: number | null;
  realizedRR?: number | null;
  holdMinutes?: number | null;
}): DiscordEmbed {
  const { pair, direction, reason, pnl, pnlUnit, entryRate, closeRate,
          strategy, regime, realizedRR, holdMinutes } = params;

  const color = reason === 'TP' ? COLOR_GREEN
    : reason === 'SL' ? COLOR_RED
    : COLOR_YELLOW;

  const reasonLabel = reason === 'TP' ? 'Take Profit'
    : reason === 'SL' ? 'Stop Loss'
    : reason === 'TIME_LIMIT' ? 'Time Limit'
    : 'Time Stop';

  const emoji = reason === 'TP' ? '\u2705' : reason === 'SL' ? '\u274C' : '\u23F0';
  const sign = pnl >= 0 ? '+' : '';

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: 'Direction', value: direction, inline: true },
    { name: 'Reason', value: `${emoji} ${reasonLabel}`, inline: true },
    { name: 'PnL', value: `${sign}${pnl.toFixed(1)} ${pnlUnit}`, inline: true },
    { name: 'Entry', value: `${entryRate}`, inline: true },
    { name: 'Close', value: `${closeRate}`, inline: true },
  ];

  if (realizedRR != null) {
    fields.push({ name: 'RR', value: realizedRR.toFixed(2), inline: true });
  }
  if (holdMinutes != null) {
    const h = Math.floor(holdMinutes / 60);
    const m = Math.round(holdMinutes % 60);
    fields.push({ name: 'Hold', value: h > 0 ? `${h}h ${m}m` : `${m}m`, inline: true });
  }
  if (strategy) {
    fields.push({ name: 'Strategy', value: `${strategy}${regime ? '/' + regime : ''}`, inline: true });
  }

  return {
    title: `${emoji} ${pair} ${reason}`,
    color,
    fields,
    footer: { text: 'fx-sim' },
    timestamp: new Date().toISOString(),
  };
}

// ─── ドローダウン通知 ─────────────────────────────────────────────────────────

export function buildDrawdownMessage(params: {
  consecutiveLosses: number;
  lotMultiplier: number;
  pair: string;
}): string {
  const { consecutiveLosses, lotMultiplier, pair } = params;
  if (lotMultiplier === 0) {
    return `\uD83D\uDEA8 [fx-sim] ${pair} \u9023\u6557${consecutiveLosses}\u56DE \u2014 \u767A\u6CE8\u505C\u6B62\u4E2D`;
  }
  const pct = Math.round(lotMultiplier * 100);
  return `\u26A0\uFE0F [fx-sim] ${pair} \u9023\u6557${consecutiveLosses}\u56DE \u2014 \u30ED\u30C3\u30C8\u7E2E\u9000 ${pct}%`;
}

// ─── 日次サマリー ─────────────────────────────────────────────────────────────

export function buildDailySummaryMessage(params: {
  date: string;
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
    `\uD83D\uDCCA [fx-sim] \u65E5\u6B21\u30B5\u30DE\u30EA\u30FC ${date}\n` +
    `\u53D6\u5F15: ${totalTrades}\u4EF6 | \u52DD\u7387(RR\u22651.0): ${winRate}% | PnL: ${sign}${totalPnl.toFixed(1)} pip\n` +
    `AI: Gemini ${geminiOk} / GPT ${gptOk} / Claude ${claudeOk}`
  );
}

// ─── AIスクリーナーレポート通知（Discord Embed） ──────────────────────────────

export interface ScreenerReportParams {
  usPicks: Array<{ ticker: string; reason: string }>;
  jpPicks: Array<{ ticker: string; reason: string }>;
  usAdded: string[];
  jpAdded: string[];
  pruned: string[];
  usCandidates: number;
  jpCandidates: number;
}

/** AIスクリーナー週次レポートのDiscord Embedを構築 */
export function buildScreenerReportEmbeds(params: ScreenerReportParams): DiscordEmbed[] {
  const { usPicks, jpPicks, usAdded, jpAdded, pruned, usCandidates, jpCandidates } = params;
  const embeds: DiscordEmbed[] = [];

  // メインレポート
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: '\uD83C\uDDFA\uD83C\uDDF8 US Screened', value: `${usCandidates} candidates`, inline: true },
    { name: '\uD83C\uDDEF\uD83C\uDDF5 JP Screened', value: `${jpCandidates} candidates`, inline: true },
    { name: '\uD83D\uDDD1 Pruned', value: `${pruned.length} stocks`, inline: true },
  ];

  embeds.push({
    title: '\uD83D\uDD0D AI Momentum Screener \u2014 Weekly Report',
    color: COLOR_PURPLE,
    fields,
    timestamp: new Date().toISOString(),
  });

  // US銘柄選定
  if (usPicks.length > 0) {
    const usLines = usPicks.map(p => {
      const badge = usAdded.includes(p.ticker) ? '\uD83C\uDD95' : '\u2705';
      return `${badge} **${p.ticker}** \u2014 ${p.reason}`;
    }).join('\n');
    embeds.push({
      title: '\uD83C\uDDFA\uD83C\uDDF8 US Picks',
      description: usLines,
      color: COLOR_BLUE,
    });
  }

  // JP銘柄選定
  if (jpPicks.length > 0) {
    const jpLines = jpPicks.map(p => {
      const badge = jpAdded.includes(p.ticker) ? '\uD83C\uDD95' : '\u2705';
      return `${badge} **${p.ticker}** \u2014 ${p.reason}`;
    }).join('\n');
    embeds.push({
      title: '\uD83C\uDDEF\uD83C\uDDF5 JP Picks',
      description: jpLines,
      color: COLOR_BLUE,
    });
  }

  // 除外銘柄
  if (pruned.length > 0) {
    embeds.push({
      title: '\uD83D\uDDD1 Pruned',
      description: pruned.join('\n'),
      color: COLOR_RED,
    });
  }

  return embeds;
}

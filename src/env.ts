/**
 * 共有環境型定義と Gemini API キー管理ユーティリティ
 *
 * Cloudflare Workers の Env binding と、
 * core / analysis / daily の各ワークフローが共通で使用する
 * API キー選択・クールダウン管理ロジックをここに集約する。
 *
 * ⚠️ 循環 import 防止のため、このファイルは他の src/* を import しない。
 */

export interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  GEMINI_API_KEY_2?: string;
  GEMINI_API_KEY_3?: string;
  GEMINI_API_KEY_4?: string;
  GEMINI_API_KEY_5?: string;
  OPENAI_API_KEY?: string;
  OPENAI_API_KEY_2?: string;
  ANTHROPIC_API_KEY?: string;
  // OANDA実弾取引
  OANDA_API_TOKEN?: string;
  OANDA_ACCOUNT_ID?: string;
  OANDA_LIVE?: string;
  TRADING_ENABLED?: string;
  // RiskGuard
  RISK_MAX_DAILY_LOSS?: string;
  RISK_MAX_LIVE_POSITIONS?: string;
  RISK_MAX_LOT_SIZE?: string;
  RISK_ANOMALY_THRESHOLD?: string;
  // Twelve Data フォールバック
  TWELVE_DATA_API_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
  // テスタ施策: 多層リスク
  RISK_MAX_WEEKLY_LOSS?: string;
  RISK_MAX_MONTHLY_LOSS?: string;
  // テスタ施策12: 経済指標カレンダー
  FINNHUB_API_KEY?: string;
  // JSON API ニュースソース
  POLYGON_API_KEY?: string;
  MARKETAUX_API_KEY?: string;
  CRYPTOPANIC_API_KEY?: string;
  // FINNHUB_API_KEY は calendar.ts と共有（上記に既に定義）
  // AI銘柄マネージャー
  JQUANTS_REFRESH_TOKEN?: string;
  // Workers AI（エッジ推論: センチメント分析）
  AI: Ai;
}

// ── キー別クールダウン管理 ──
// Workers は cron 実行ごとにリセット（ステートレス）なので Map で十分
export const keyCooldowns = new Map<string, number>();  // apiKey → cooldownUntil timestamp
export const keyUsageCount = new Map<string, number>(); // apiKey → 使用回数（均等分散用）

export function getApiKey(env: Env): string {
  const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3, env.GEMINI_API_KEY_4, env.GEMINI_API_KEY_5].filter(Boolean) as string[];
  const now = Date.now();

  // クールダウン中でないキーを抽出
  const available = keys.filter(k => (keyCooldowns.get(k) ?? 0) <= now);
  if (available.length > 0) {
    // 使用回数最少のキーを選択（均等分散）
    available.sort((a, b) => (keyUsageCount.get(a) ?? 0) - (keyUsageCount.get(b) ?? 0));
    const key = available[0];
    keyUsageCount.set(key, (keyUsageCount.get(key) ?? 0) + 1);
    return key;
  }

  // 全キーがクールダウン中 → 最も早く解除されるキーを返す
  const earliest = keys.reduce((a, b) =>
    (keyCooldowns.get(a) ?? 0) < (keyCooldowns.get(b) ?? 0) ? a : b
  );
  keyUsageCount.set(earliest, (keyUsageCount.get(earliest) ?? 0) + 1);
  return earliest;
}

/** 全Geminiキーを優先順（クールダウン外→使用回数少ない順）で返す */
export function getAllApiKeys(env: Env): string[] {
  const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3, env.GEMINI_API_KEY_4, env.GEMINI_API_KEY_5].filter(Boolean) as string[];
  const now = Date.now();
  const available = keys.filter(k => (keyCooldowns.get(k) ?? 0) <= now);
  const cooldown = keys.filter(k => (keyCooldowns.get(k) ?? 0) > now);
  available.sort((a, b) => (keyUsageCount.get(a) ?? 0) - (keyUsageCount.get(b) ?? 0));
  cooldown.sort((a, b) => (keyCooldowns.get(a) ?? 0) - (keyCooldowns.get(b) ?? 0));
  return [...available, ...cooldown];
}

/** 429受信時にキーをクールダウン登録 */
export function markKeyCooldown(apiKey: string, retryAfterSec: number): void {
  const cooldownUntil = Date.now() + retryAfterSec * 1000;
  keyCooldowns.set(apiKey, cooldownUntil);
  console.log(`[fx-sim] Key cooldown: ${apiKey.slice(0, 8)}... until ${new Date(cooldownUntil).toISOString()} (${retryAfterSec}s)`);
}

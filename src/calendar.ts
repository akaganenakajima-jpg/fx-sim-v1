/**
 * 経済指標カレンダーモジュール（施策12）
 *
 * Finnhub Economic Calendar API を使用して
 * 直近の経済イベントを取得し、重要イベント前後の
 * トレード制御に利用する。
 */

import { getCacheValue, setCacheValue } from './db';

export interface EconomicEvent {
  date: string;
  time: string;
  currency: string;
  impact: 'high' | 'medium' | 'low';
  event: string;
}

/** キャッシュキー */
const CACHE_KEY = 'economic_calendar';

/** キャッシュTTL: 24時間 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Finnhub Economic Calendar API から経済指標イベントを取得する。
 *
 * - market_cache テーブルに TTL 24時間でキャッシュ
 * - apiKey 未設定の場合は空配列を返す
 * - API 失敗時も空配列を返す（cron を止めない）
 *
 * Finnhub 無料枠: 60 req/min
 * API: GET https://finnhub.io/api/v1/calendar/economic?token=${apiKey}
 */
export async function fetchEconomicCalendar(
  db: D1Database,
  apiKey?: string
): Promise<EconomicEvent[]> {
  // apiKey 未設定 → 空配列
  if (!apiKey) return [];

  try {
    // キャッシュ確認
    const cached = await getCacheValue(db, CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as {
        updatedAt: string;
        events: EconomicEvent[];
      };
      const elapsed = Date.now() - new Date(parsed.updatedAt).getTime();
      if (elapsed < CACHE_TTL_MS) {
        return parsed.events;
      }
    }

    // API リクエスト（今日から7日先まで）
    const from = formatDate(new Date());
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + 7);
    const to = formatDate(toDate);

    const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${apiKey}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'fx-sim-v1' },
    });

    if (!response.ok) {
      console.warn(
        `[calendar] Finnhub API error: ${response.status} ${response.statusText}`
      );
      return [];
    }

    const data = (await response.json()) as {
      economicCalendar?: Array<{
        date?: string;
        time?: string;
        country?: string;
        impact?: string;
        event?: string;
      }>;
    };

    const rawEvents = data.economicCalendar ?? [];

    const events: EconomicEvent[] = rawEvents
      .filter((e) => e.impact && e.event)
      .map((e) => ({
        date: e.date ?? '',
        time: e.time ?? '',
        currency: e.country ?? '',
        impact: normalizeImpact(e.impact ?? ''),
        event: e.event ?? '',
      }));

    // キャッシュ保存
    await setCacheValue(
      db,
      CACHE_KEY,
      JSON.stringify({ updatedAt: new Date().toISOString(), events })
    );

    return events;
  } catch (err) {
    console.warn(
      `[calendar] fetchEconomicCalendar failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/**
 * 直近の重大イベントをチェックする。
 *
 * - high impact イベントが windowMinutes（デフォルト30分）以内 → highImpactNearby = true
 * - medium impact イベントが 15分以内 → mediumImpactNearby = true
 *
 * フィルタ（filter.ts）と連携し、重要イベント前後は
 * Gemini 呼び出しを抑制 or 強制 HOLD に利用する。
 */
export function getUpcomingHighImpactEvents(
  events: EconomicEvent[],
  now: Date,
  windowMinutes: number = 30
): {
  highImpactNearby: boolean;
  mediumImpactNearby: boolean;
  events: EconomicEvent[];
} {
  const mediumWindowMinutes = 15;
  const nearbyEvents: EconomicEvent[] = [];
  let highImpactNearby = false;
  let mediumImpactNearby = false;

  for (const event of events) {
    const eventTime = parseEventTime(event.date, event.time);
    if (!eventTime) continue;

    const diffMs = eventTime.getTime() - now.getTime();
    const diffMinutes = diffMs / (60 * 1000);

    // 過去のイベントも直後の影響を考慮（-15分〜+window分）
    if (event.impact === 'high') {
      if (diffMinutes >= -15 && diffMinutes <= windowMinutes) {
        highImpactNearby = true;
        nearbyEvents.push(event);
      }
    } else if (event.impact === 'medium') {
      if (diffMinutes >= -5 && diffMinutes <= mediumWindowMinutes) {
        mediumImpactNearby = true;
        nearbyEvents.push(event);
      }
    }
  }

  return {
    highImpactNearby,
    mediumImpactNearby,
    events: nearbyEvents,
  };
}

// --- ヘルパー関数 ---

/** impact 文字列を正規化 */
function normalizeImpact(impact: string): 'high' | 'medium' | 'low' {
  const lower = impact.toLowerCase();
  if (lower === 'high' || lower === '3') return 'high';
  if (lower === 'medium' || lower === '2') return 'medium';
  return 'low';
}

/** 日付を YYYY-MM-DD 形式にフォーマット */
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** イベントの日付・時刻文字列を Date に変換 */
function parseEventTime(date: string, time: string): Date | null {
  if (!date) return null;

  try {
    // time が空の場合は日付のみ（00:00扱い）
    const timeStr = time || '00:00';
    const isoStr = `${date}T${timeStr}:00Z`;
    const parsed = new Date(isoStr);
    if (isNaN(parsed.getTime())) return null;
    return parsed;
  } catch {
    return null;
  }
}

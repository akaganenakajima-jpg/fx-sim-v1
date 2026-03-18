// Gemini呼び出し要否判定・スキップ判定
// 全て UTC で処理

import type { RedditSignal } from './reddit';

export interface FilterResult {
  shouldCall: boolean;
  reason: string;
}

interface SkipSchedule {
  /** 曜日 0=日〜6=土 (undefined = 毎日) */
  weekday?: number;
  /** 第N週のみ (undefined = 毎週) */
  nthWeek?: number;
  /** UTC 時 */
  hour: number;
  /** UTC 分 */
  min: number;
  /** スキップ継続分数 */
  duration: number;
}

// 重要指標発表時間帯（UTC）— この時間帯は強制HOLD
//
// 米指標 (NFP / CPI) は ET 8:30 発表:
//   冬 (EST = UTC-5): 13:30 UTC
//   夏 (EDT = UTC-4): 12:30 UTC
//   → 両方カバーするため 12:30 UTC から 120分（14:30 UTCまで）に設定
//
// 日銀発表は JST 11:00〜13:00 頃 = UTC 02:00〜04:00
//   → 02:00 UTC から 180分（05:00 UTCまで）でカバー
const SKIP_SCHEDULES: SkipSchedule[] = [
  // 米雇用統計 (NFP): 第1金曜 — EST/EDT 両対応で 12:30〜14:30 UTC
  { weekday: 5, nthWeek: 1, hour: 12, min: 30, duration: 120 },
  // 米CPI: 第2火曜 — EST/EDT 両対応で 12:30〜14:30 UTC
  { weekday: 2, nthWeek: 2, hour: 12, min: 30, duration: 120 },
  // 日銀会合発表: 毎日 02:00〜05:00 UTC（JST 11:00〜14:00）
  { hour: 2, min: 0, duration: 180 },
];

/** now (UTC) がスキップ時間帯に該当するか */
function isSkipSchedule(now: Date): { skip: boolean; matchedRule?: string } {
  const utcWeekday = now.getUTCDay(); // 0=Sun, 5=Fri
  const utcDate = now.getUTCDate();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const nowMinutes = utcHour * 60 + utcMin;

  for (const s of SKIP_SCHEDULES) {
    // 曜日チェック
    if (s.weekday !== undefined && utcWeekday !== s.weekday) continue;
    // 第N週チェック（1〜7日なら第1週）
    if (s.nthWeek !== undefined && Math.ceil(utcDate / 7) !== s.nthWeek)
      continue;
    // 時間帯チェック
    const startMin = s.hour * 60 + s.min;
    const endMin = startMin + s.duration;
    if (nowMinutes >= startMin && nowMinutes < endMin) {
      return {
        skip: true,
        matchedRule: `${s.hour.toString().padStart(2, '0')}:${s.min.toString().padStart(2, '0')} UTC +${s.duration}min`,
      };
    }
  }
  return { skip: false };
}

/**
 * Gemini を呼ぶべきか判定
 * 以下の全条件を満たす場合のみ true:
 *   1. スキップ時間帯でない
 *   2. レート変化 ±0.05円以上 OR 新規ニュースあり OR Redditキーワード検出
 * 目標: 1日あたり 20〜50回 程度に抑える
 */
export function shouldCallGemini(params: {
  currentRate: number;
  prevRate: number;
  rateChangeTh: number;
  hasNewNews: boolean;
  redditSignal: RedditSignal;
  now: Date;
}): FilterResult {
  const { currentRate, prevRate, rateChangeTh, hasNewNews, redditSignal, now } = params;

  // 1. スキップ時間帯チェック
  const { skip, matchedRule } = isSkipSchedule(now);
  if (skip) {
    return {
      shouldCall: false,
      reason: `重要指標スキップ時間帯 (${matchedRule})`,
    };
  }

  // 2. 変化トリガーチェック
  const rateChange = Math.abs(currentRate - prevRate);
  if (rateChange >= rateChangeTh) {
    return {
      shouldCall: true,
      reason: `レート変化 ${rateChange.toFixed(3)}円`,
    };
  }

  if (hasNewNews) {
    return { shouldCall: true, reason: '新規ニュースあり' };
  }

  if (redditSignal.hasSignal) {
    return {
      shouldCall: true,
      reason: `Redditシグナル: ${redditSignal.keywords.join(', ')}`,
    };
  }

  return {
    shouldCall: false,
    reason: `変化なし (変化=${rateChange.toFixed(3)}, ニュースなし, Redditシグナルなし)`,
  };
}

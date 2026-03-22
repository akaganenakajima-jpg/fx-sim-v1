// Gemini呼び出し要否判定・スキップ判定
// 全て UTC で処理
// v2: hasNewNews/redditSignal は Path B が担当するため削除

export interface FilterResult {
  shouldCall: boolean;
  reason: string;
}

interface SkipSchedule {
  /** 曜日 0=日〜6=土 (undefined = 毎日) */
  weekday?: number;
  /** 第N週のみ (undefined = 毎週) */
  nthWeek?: number;
  /** 特定月のみ (undefined = 毎月) */
  months?: number[];
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
// 日銀会合: 年8回（1,3,4,6,7,9,10,12月）
//   発表は JST 11:00〜13:00 頃 = UTC 02:00〜04:00
//   → 該当月のみ 02:00 UTC から 180分（05:00 UTCまで）
const SKIP_SCHEDULES: SkipSchedule[] = [
  // 米雇用統計 (NFP): 第1金曜 — EST/EDT 両対応で 12:30〜14:30 UTC
  { weekday: 5, nthWeek: 1, hour: 12, min: 30, duration: 120 },
  // 米CPI: 第2火曜 — EST/EDT 両対応で 12:30〜14:30 UTC
  { weekday: 2, nthWeek: 2, hour: 12, min: 30, duration: 120 },
  // 日銀会合発表: 該当月のみ 02:00〜05:00 UTC（JST 11:00〜14:00）
  // 会合は通常月の中旬〜下旬、2日間。発表日は第3〜4週の木金が多い
  { weekday: 4, nthWeek: 3, months: [1, 3, 4, 6, 7, 9, 10, 12], hour: 2, min: 0, duration: 180 },
  { weekday: 5, nthWeek: 3, months: [1, 3, 4, 6, 7, 9, 10, 12], hour: 2, min: 0, duration: 180 },
  { weekday: 4, nthWeek: 4, months: [1, 3, 4, 6, 7, 9, 10, 12], hour: 2, min: 0, duration: 180 },
  { weekday: 5, nthWeek: 4, months: [1, 3, 4, 6, 7, 9, 10, 12], hour: 2, min: 0, duration: 180 },
  // 早朝禁止帯 (JST 3:00〜7:00 = UTC 18:00〜22:00): 流動性低、スプレッド拡大、機関不在
  { hour: 18, min: 0, duration: 240 },
];

// 定期強制呼び出し間隔（分）
// この間隔以上 AI を呼んでいなければ、フィルタを無視して強制呼び出し
const FORCE_CALL_INTERVAL_MIN = 30;

/** now (UTC) がスキップ時間帯に該当するか */
function isSkipSchedule(now: Date): { skip: boolean; matchedRule?: string } {
  const utcWeekday = now.getUTCDay(); // 0=Sun, 5=Fri
  const utcDate = now.getUTCDate();
  const utcMonth = now.getUTCMonth() + 1; // 1-12
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const nowMinutes = utcHour * 60 + utcMin;

  for (const s of SKIP_SCHEDULES) {
    // 曜日チェック
    if (s.weekday !== undefined && utcWeekday !== s.weekday) continue;
    // 第N週チェック（1〜7日なら第1週）
    if (s.nthWeek !== undefined && Math.ceil(utcDate / 7) !== s.nthWeek)
      continue;
    // 月チェック
    if (s.months !== undefined && !s.months.includes(utcMonth)) continue;
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
 * Gemini を呼ぶべきか判定（Path A / Path C 専用）
 * ニュース・Redditシグナルは Path B が担当するため含まない
 * 以下の条件で true を返す:
 *   1. スキップ時間帯でない かつ
 *   2. レート変化が閾値以上（Path A） OR 前回呼び出しから30分以上経過（Path C）
 */
export function shouldCallGemini(params: {
  currentRate: number;
  prevRate: number;
  rateChangeTh: number;
  now: Date;
  lastCallTime?: string | null;
  thompsonScore?: number;   // トンプソン・サンプリングスコア（0〜1）
}): FilterResult {
  const { currentRate, prevRate, rateChangeTh, now, lastCallTime, thompsonScore } = params;

  // トンプソンスコアが低い銘柄は低優先度として HOLD
  if (thompsonScore !== undefined && thompsonScore < 0.3) {
    return { shouldCall: false, reason: `Thompson低優先度(${thompsonScore.toFixed(2)})` };
  }

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
      reason: `レート変化 ${rateChange.toFixed(3)}`,
    };
  }

  // 3. 定期強制呼び出し（Path C）: 前回から30分以上経過していたら強制
  if (lastCallTime) {
    const lastCall = new Date(lastCallTime);
    const elapsed = (now.getTime() - lastCall.getTime()) / 60_000;
    if (elapsed >= FORCE_CALL_INTERVAL_MIN) {
      return {
        shouldCall: true,
        reason: `定期強制 (${Math.floor(elapsed)}分経過)`,
      };
    }
  }

  return {
    shouldCall: false,
    reason: `変化なし (変化=${rateChange.toFixed(3)})`,
  };
}

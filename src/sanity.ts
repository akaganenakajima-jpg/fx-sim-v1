// TP/SLサニティチェック（T004-04: tpSlMin/tpSlMax対応に強化）
// AIが極端な値を返した場合の防御

import type { InstrumentConfig } from './instruments';

export interface SanityResult {
  valid: boolean;
  reason?: string;
}

/**
 * AIが返したTP/SLが妥当か検証
 * - TP/SLが逆方向 → 拒否
 * - TP/SL距離が instrument.tpSlMin 未満 または tpSlMax 超過 → 拒否
 * - RR比 < 1.5 → 拒否（旧1.0から引き上げ）
 */
export function checkTpSlSanity(params: {
  direction: 'BUY' | 'SELL';
  rate: number;
  tp: number | null;
  sl: number | null;
  instrument: InstrumentConfig;
}): SanityResult {
  const { direction, rate, tp, sl, instrument } = params;
  if (tp == null || sl == null) return { valid: true };

  const isBuy = direction === 'BUY';

  // ① 方向チェック: BUYならTP>rate>SL, SELLならSL>rate>TP
  if (isBuy && (tp <= rate || sl >= rate)) {
    return { valid: false, reason: `方向不整合: BUY rate=${rate} TP=${tp} SL=${sl}` };
  }
  if (!isBuy && (tp >= rate || sl <= rate)) {
    return { valid: false, reason: `方向不整合: SELL rate=${rate} TP=${tp} SL=${sl}` };
  }

  const { tpSlMin, tpSlMax } = instrument;
  const tpDist = Math.abs(tp - rate);
  const slDist = Math.abs(sl - rate);

  // ② TP距離の境界チェック（銘柄固有の絶対値境界）
  if (tpDist < tpSlMin || tpDist > tpSlMax) {
    return { valid: false, reason: `TP距離(${tpDist.toFixed(4)}) 範囲外 [${tpSlMin}, ${tpSlMax}]` };
  }

  // ③ SL距離の境界チェック
  if (slDist < tpSlMin || slDist > tpSlMax) {
    return { valid: false, reason: `SL距離(${slDist.toFixed(4)}) 範囲外 [${tpSlMin}, ${tpSlMax}]` };
  }

  // ④ RR比チェック: TP距離/SL距離 >= 1.5 を要求
  const rr = slDist > 0 ? tpDist / slDist : 0;
  if (rr < 1.5) {
    return { valid: false, reason: `RR比不足: ${rr.toFixed(2)} < 1.5` };
  }

  return { valid: true };
}

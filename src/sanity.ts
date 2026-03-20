// TP/SLサニティチェック（T002: IPA評価 セキュリティ改善）
// AIが極端な値を返した場合の防御

import type { InstrumentConfig } from './instruments';

export interface SanityResult {
  valid: boolean;
  reason?: string;
}

/**
 * AIが返したTP/SLが妥当か検証
 * - TP/SLが逆方向 → 拒否
 * - SL距離が現在値の5%以上 → 拒否
 * - RR比 < 1.0 → 拒否
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

  // RR比チェック: TP距離/SL距離 < 1.0 → 拒否
  const tpDist = Math.abs(tp - rate);
  const rr = slDist > 0 ? tpDist / slDist : 0;
  if (rr < 1.0) {
    return { valid: false, reason: `RR比不足: ${rr.toFixed(2)} < 1.0` };
  }

  return { valid: true };
}

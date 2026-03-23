// TP/SLサニティチェック + 自動補正（T004-04強化版）
// AIが差分値・比率値・SLミラーで返す場合を自動検出して絶対値に変換

import type { InstrumentConfig } from './instruments';

export type RRCategory = 'NORMAL' | 'REDUCED' | 'REJECTED';

export interface SanityResult {
  valid: boolean;
  reason?: string;
  correctedTp?: number;
  correctedSl?: number;
  rrRatio?: number;
  rrCategory?: RRCategory;
}

/**
 * AIが返したTP/SLの形式を検出し、絶対値に正規化する。
 *
 * 検出パターン:
 * 1. 絶対値（正常）: TP/SLがrateに近い → そのまま
 * 2. 差分値: TP/SLがrateに比べ極端に小さい or 負の値 → rate ± |value|
 * 3. 比率値: TP/SLが0〜2の範囲（ratio） → rate * value
 * 4. TP/SL入替: 逆方向のTP/SLが返された場合
 * 5. SLミラー: TP方向は正しいがSLが同じ側にある（最頻出パターン）
 */
function normalizeTpSl(params: {
  direction: 'BUY' | 'SELL';
  rate: number;
  tp: number | null;
  sl: number | null;
  instrument: InstrumentConfig;
}): { tp: number | null; sl: number | null; corrected: boolean; correctionType?: string } {
  const { direction, rate, tp, sl, instrument } = params;
  if (tp == null || sl == null) return { tp, sl, corrected: false };

  const isBuy = direction === 'BUY';

  // まず絶対値として妥当かチェック（方向+距離）
  if (isPlausibleAbsolute(isBuy, rate, tp, sl, instrument)) {
    return { tp, sl, corrected: false };
  }

  // パターン2: 差分値検出 — |TP|や|SL|がrateの10%未満で、かつinstrumentの範囲内
  const absTp = Math.abs(tp);
  const absSl = Math.abs(sl);
  if (absTp < rate * 0.1 && absSl < rate * 0.1) {
    const newTp = isBuy ? rate + absTp : rate - absTp;
    const newSl = isBuy ? rate - absSl : rate + absSl;
    if (isPlausibleAbsolute(isBuy, rate, newTp, newSl, instrument)) {
      return { tp: newTp, sl: newSl, corrected: true, correctionType: '差分値→絶対値' };
    }
  }

  // パターン3: 比率値検出 — TP/SLが0〜2の範囲（rate比でratio表現）
  if (tp > 0 && tp < 3 && sl > 0 && sl < 3 && rate > 10) {
    const newTp = rate * tp;
    const newSl = rate * sl;
    if (isPlausibleAbsolute(isBuy, rate, newTp, newSl, instrument)) {
      return { tp: newTp, sl: newSl, corrected: true, correctionType: '比率値→絶対値' };
    }
  }

  // パターン4: 符号反転（SELL時にBUY用のTP/SLが返された、またはその逆）
  if (isPlausibleAbsolute(!isBuy, rate, tp, sl, instrument)) {
    const newTp = sl;
    const newSl = tp;
    if (isPlausibleAbsolute(isBuy, rate, newTp, newSl, instrument)) {
      return { tp: newTp, sl: newSl, corrected: true, correctionType: 'TP/SL入替（逆方向検出）' };
    }
  }

  // パターン5: 片側ミラー — TP方向は正しいがSLが同じ側にある（最頻出）
  // 例: SELL rate=4569.5, TP=4530.5(正しく下), SL=4559.5(誤って下) → SL=4579.5(上にミラー)
  {
    const tpCorrectSide = isBuy ? tp > rate : tp < rate;
    const slWrongSide = isBuy ? sl > rate : sl < rate;
    if (tpCorrectSide && slWrongSide) {
      const slDist = Math.abs(sl - rate);
      const newSl = isBuy ? rate - slDist : rate + slDist;
      if (isPlausibleAbsolute(isBuy, rate, tp, newSl, instrument)) {
        return { tp, sl: newSl, corrected: true, correctionType: 'SLミラー補正' };
      }
    }
    // 逆ケース: SL方向は正しいがTPが同じ側
    const slCorrectSide = isBuy ? sl < rate : sl > rate;
    const tpWrongSide = isBuy ? tp < rate : tp > rate;
    if (slCorrectSide && tpWrongSide) {
      const tpDist = Math.abs(tp - rate);
      const newTp = isBuy ? rate + tpDist : rate - tpDist;
      if (isPlausibleAbsolute(isBuy, rate, newTp, sl, instrument)) {
        return { tp: newTp, sl, corrected: true, correctionType: 'TPミラー補正' };
      }
    }
  }

  // 補正不能 → 元の値を返す（後段のバリデーションで拒否される）
  return { tp, sl, corrected: false };
}

/**
 * 絶対値として方向・距離が妥当か簡易判定
 *
 * TP制限: tpSlMaxではなくrrMax（RR比上限）で判定。
 * SLが大きければTPも広がる自然なトレンド対応。
 * tpSlMax は SL専用キャップとして残す。
 */
function isPlausibleAbsolute(
  isBuy: boolean, rate: number, tp: number, sl: number, instrument: InstrumentConfig
): boolean {
  if (isBuy && (tp <= rate || sl >= rate)) return false;
  if (!isBuy && (tp >= rate || sl <= rate)) return false;
  const tpDist = Math.abs(tp - rate);
  const slDist = Math.abs(sl - rate);
  const { tpSlMin, tpSlMax, rrMax } = instrument;
  const tolerance = tpSlMin * 0.01; // 浮動小数点丸め誤差許容
  // SL: tpSlMin〜tpSlMax の範囲（絶対キャップ）
  if (slDist < tpSlMin - tolerance || slDist > tpSlMax) return false;
  // TP: tpSlMin以上 かつ RR比 ≤ rrMax（AIの大きな予測を妨げない）
  if (tpDist < tpSlMin - tolerance) return false;
  if (slDist > 0 && tpDist / slDist > rrMax) return false;
  return true;
}

/**
 * AIが返したTP/SLが妥当か検証（自動補正付き）
 * - 自動補正を試みた後でバリデーション
 * - 補正成功時は correctedTp/correctedSl を返す
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

  // Step 1: 自動補正を試みる
  const norm = normalizeTpSl({ direction, rate, tp, sl, instrument });
  const finalTp = norm.tp!;
  const finalSl = norm.sl!;
  const isBuy = direction === 'BUY';

  // Step 2: 補正後の値でバリデーション
  if (isBuy && (finalTp <= rate || finalSl >= rate)) {
    return { valid: false, reason: `方向不整合: BUY rate=${rate} TP=${finalTp} SL=${finalSl}` };
  }
  if (!isBuy && (finalTp >= rate || finalSl <= rate)) {
    return { valid: false, reason: `方向不整合: SELL rate=${rate} TP=${finalTp} SL=${finalSl}` };
  }

  const { tpSlMin, tpSlMax, rrMax } = instrument;
  const tpDist = Math.abs(finalTp - rate);
  const slDist = Math.abs(finalSl - rate);
  // 浮動小数点丸め誤差を吸収（tpSlMinの1%を許容）
  const minTolerance = tpSlMin * 0.01;

  // SL: tpSlMin〜tpSlMax（絶対キャップ）
  if (slDist < tpSlMin - minTolerance || slDist > tpSlMax) {
    return { valid: false, reason: `SL距離(${slDist.toFixed(4)}) 範囲外 [${tpSlMin}, ${tpSlMax}]` };
  }
  // TP: tpSlMin以上 かつ RR比 ≤ rrMax（絶対上限ではなくSL比で判定）
  if (tpDist < tpSlMin - minTolerance) {
    return { valid: false, reason: `TP距離(${tpDist.toFixed(4)}) 最小値 ${tpSlMin} 未満` };
  }

  const rr = slDist > 0 ? tpDist / slDist : 0;
  if (rr > rrMax) {
    return { valid: false, reason: `TP距離過大: RR=${rr.toFixed(1)} > max ${rrMax}（TP=${tpDist.toFixed(2)}, SL=${slDist.toFixed(2)}）` };
  }

  // テスタ施策3: RR比段階制御
  // ≧1.5 → NORMAL（通常ロット）
  // 1.0〜1.5 → REDUCED（ロット50%削減、呼び出し元で処理）
  // <1.0 → REJECTED（エントリー拒否）
  let rrCategory: RRCategory;
  if (rr >= 1.5) {
    rrCategory = 'NORMAL';
  } else if (rr >= 1.0) {
    rrCategory = 'REDUCED';
  } else {
    return { valid: false, reason: `RR比不足: ${rr.toFixed(2)} < 1.0`, rrRatio: rr, rrCategory: 'REJECTED' };
  }

  if (norm.corrected) {
    return { valid: true, correctedTp: finalTp, correctedSl: finalSl, rrRatio: rr, rrCategory };
  }

  return { valid: true, rrRatio: rr, rrCategory };
}

// ── 施策8: ATRベース動的TP/SL ──

type RegimeForAtr = 'strong_trend' | 'weak_trend' | 'ranging' | 'volatile' | 'uncertain';

const ATR_MULTIPLIERS: Record<RegimeForAtr, { sl: number; tp: number }> = {
  strong_trend: { sl: 2.0, tp: 3.0 },   // RR=1.5
  weak_trend:   { sl: 1.5, tp: 2.5 },   // RR=1.67
  ranging:      { sl: 1.0, tp: 1.5 },   // RR=1.5
  volatile:     { sl: 2.5, tp: 4.0 },   // RR=1.6
  uncertain:    { sl: 1.5, tp: 2.5 },   // RR=1.67
};

/** ATRベースのTP/SL推奨値を算出（Geminiプロンプトの参考値として使用） */
export function calcAtrBasedTpSl(params: {
  direction: 'BUY' | 'SELL';
  rate: number;
  atr: number;
  regime: string;
  instrument: InstrumentConfig;
}): { tp: number; sl: number; tpDist: number; slDist: number } {
  const { direction, rate, atr, regime, instrument } = params;
  const mult = ATR_MULTIPLIERS[regime as RegimeForAtr] ?? ATR_MULTIPLIERS.uncertain;

  let slDist = atr * mult.sl;
  let tpDist = atr * mult.tp;

  // SL: tpSlMin〜tpSlMaxでクランプ（絶対キャップ）
  slDist = Math.max(instrument.tpSlMin, Math.min(slDist, instrument.tpSlMax));
  // TP: tpSlMin以上 かつ SL比でrrMaxを超えないようクランプ
  const tpDistMax = slDist * instrument.rrMax;
  tpDist = Math.max(instrument.tpSlMin, Math.min(tpDist, tpDistMax));

  const isBuy = direction === 'BUY';
  const tp = isBuy ? rate + tpDist : rate - tpDist;
  const sl = isBuy ? rate - slDist : rate + slDist;

  return { tp, sl, tpDist, slDist };
}

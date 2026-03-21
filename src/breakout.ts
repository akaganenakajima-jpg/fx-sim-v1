// ── 施策17: ブレイクアウト検知 × ダマシフィルター ──

import type { CandleData, TechnicalIndicators } from './candles';

export interface BreakoutResult {
  detected: boolean;
  type: 'upward' | 'downward' | null;
  genuine: boolean;
  rangeHigh: number;
  rangeLow: number;
  confidence: number; // 0-100
  reason: string;
}

const DEFAULT_LOOKBACK = 20;

/**
 * 直近 H1 足のレンジを算出し、ブレイクアウトを検知する。
 * ATR 増減・RSI 逆行でダマシをフィルタリングする。
 */
export function detectBreakout(
  candles: CandleData[],
  indicators: TechnicalIndicators,
  currentPrice: number,
  lookbackPeriod: number = DEFAULT_LOOKBACK,
): BreakoutResult {
  const noBreakout: BreakoutResult = {
    detected: false,
    type: null,
    genuine: false,
    rangeHigh: 0,
    rangeLow: 0,
    confidence: 0,
    reason: '',
  };

  // ── 1. レンジ定義 ──
  if (candles.length < 2) {
    return { ...noBreakout, reason: 'ローソク足データ不足（2本未満）' };
  }

  // 直近 lookbackPeriod 本（最新足は含めず、直前までをレンジ算出に使う）
  const rangeCandles = candles.slice(-lookbackPeriod - 1, -1);
  if (rangeCandles.length === 0) {
    return { ...noBreakout, reason: 'レンジ算出用データ不足' };
  }

  const rangeHigh = Math.max(...rangeCandles.map((c) => c.high));
  const rangeLow = Math.min(...rangeCandles.map((c) => c.low));

  // ── 2. ブレイクアウト判定 ──
  let breakoutType: 'upward' | 'downward' | null = null;

  if (currentPrice > rangeHigh) {
    breakoutType = 'upward';
  } else if (currentPrice < rangeLow) {
    breakoutType = 'downward';
  }

  if (breakoutType === null) {
    return {
      ...noBreakout,
      rangeHigh,
      rangeLow,
      reason: `レンジ内（${rangeLow.toFixed(3)}〜${rangeHigh.toFixed(3)}）`,
    };
  }

  // ── 3. ダマシフィルター ──
  // ATR の前回相当値を推定（直前足と2本前の足から簡易推定）
  // candles は時系列順（古い→新しい）を想定
  const prevAtr = estimatePrevAtr(rangeCandles);
  const atrIncreasing = indicators.atr14 > prevAtr * 1.1;
  const atrDecreasing = indicators.atr14 < prevAtr;

  // RSI 逆行チェック
  const rsiContrarian =
    (breakoutType === 'upward' && indicators.rsi14 < 40) ||
    (breakoutType === 'downward' && indicators.rsi14 > 60);

  // ── 4. genuine 判定 ──
  const genuine = atrIncreasing && !rsiContrarian;

  // ── 5. confidence 算出 ──
  let confidence: number;
  const reasons: string[] = [];

  if (genuine) {
    // ATR 大幅増（1.3倍以上）→ 高信頼
    const atrRatio = prevAtr > 0 ? indicators.atr14 / prevAtr : 1;
    if (atrRatio >= 1.3) {
      confidence = Math.min(80 + Math.round((atrRatio - 1.3) * 50), 100);
      reasons.push(`ATR大幅増(${atrRatio.toFixed(2)}倍)`);
    } else {
      confidence = 60 + Math.round((atrRatio - 1.1) * 100);
      reasons.push(`ATR増加(${atrRatio.toFixed(2)}倍)`);
    }
    reasons.push(`RSI=${indicators.rsi14.toFixed(1)}(整合)`);
  } else {
    // ダマシの疑い
    if (atrDecreasing) {
      confidence = 20;
      reasons.push('ATR減少→ダマシ疑い');
    } else if (rsiContrarian) {
      confidence = 30;
      reasons.push(`RSI逆行(${indicators.rsi14.toFixed(1)})→ダマシ疑い`);
    } else {
      confidence = 40;
      reasons.push('ATR横ばい→信頼度低');
    }
    if (atrDecreasing && rsiContrarian) {
      confidence = 20;
      reasons.push('ATR減少+RSI逆行→ダマシ濃厚');
    }
  }

  const direction = breakoutType === 'upward' ? '上方' : '下方';
  const genuineLabel = genuine ? '本物' : 'ダマシ疑い';

  return {
    detected: true,
    type: breakoutType,
    genuine,
    rangeHigh,
    rangeLow,
    confidence,
    reason: `${direction}ブレイクアウト(${genuineLabel}): ${reasons.join(', ')}`,
  };
}

/**
 * レンジ内ローソク足から前回 ATR（14期間）を簡易推定する。
 * True Range の平均を返す。
 */
function estimatePrevAtr(candles: CandleData[]): number {
  if (candles.length < 2) return 0;

  const period = Math.min(14, candles.length - 1);
  const recentCandles = candles.slice(-period - 1);

  let trSum = 0;
  for (let i = 1; i < recentCandles.length; i++) {
    const curr = recentCandles[i];
    const prevClose = recentCandles[i - 1].close;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prevClose),
      Math.abs(curr.low - prevClose),
    );
    trSum += tr;
  }

  return trSum / period;
}

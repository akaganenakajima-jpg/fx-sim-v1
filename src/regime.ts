// ============================================================
// regime.ts — 施策6: AI環境認識高度化 — コンセンサスレジーム
// ============================================================

import type { RegimeTag } from './strategy-tag';
import type { TechnicalIndicators } from './candles';

// ----------------------------------------------------------
// RegimeResult
// ----------------------------------------------------------
export interface RegimeResult {
  regime: RegimeTag;
  confidence: number; // 0-100
  details: {
    adxSignal: 'trending' | 'ranging';
    atrTrend: 'expanding' | 'contracting';
    rsiZone: 'overbought' | 'oversold' | 'neutral';
    emaCross: 'golden' | 'dead' | 'neutral';
  };
}

// ----------------------------------------------------------
// 内部ヘルパー
// ----------------------------------------------------------

function classifyAdx(adx: number): 'trending' | 'ranging' {
  return adx >= 25 ? 'trending' : 'ranging';
}

function classifyAtr(atr: number, prevAtr?: number): 'expanding' | 'contracting' {
  if (prevAtr === undefined) return 'contracting';
  return atr > prevAtr ? 'expanding' : 'contracting';
}

function classifyRsi(rsi: number): 'overbought' | 'oversold' | 'neutral' {
  if (rsi >= 70) return 'overbought';
  if (rsi <= 30) return 'oversold';
  return 'neutral';
}

function classifyEmaCross(ema20: number, ema50: number): 'golden' | 'dead' | 'neutral' {
  const diff = ((ema20 - ema50) / ema50) * 100;
  if (diff > 0.05) return 'golden';
  if (diff < -0.05) return 'dead';
  return 'neutral';
}

// ----------------------------------------------------------
// determineRegime — コンセンサスロジック
// ----------------------------------------------------------

export function determineRegime(
  indicators: TechnicalIndicators,
  prevAtr?: number,
): RegimeResult {
  const adxSignal = classifyAdx(indicators.adx14);
  const atrTrend = classifyAtr(indicators.atr14, prevAtr);
  const rsiZone = classifyRsi(indicators.rsi14);
  const emaCross = classifyEmaCross(indicators.ema20, indicators.ema50);

  const details = { adxSignal, atrTrend, rsiZone, emaCross };

  // --- strong_trend ---
  // ADX>30 + ATR expanding + EMA golden/dead
  if (
    indicators.adx14 > 30 &&
    atrTrend === 'expanding' &&
    (emaCross === 'golden' || emaCross === 'dead')
  ) {
    const base = 80;
    const bonus = Math.min((indicators.adx14 - 30) * 0.5, 15);
    return {
      regime: 'strong_trend',
      confidence: Math.round(Math.min(base + bonus, 100)),
      details,
    };
  }

  // --- weak_trend ---
  // ADX>25 + at least one other trending signal
  if (indicators.adx14 > 25) {
    const otherSignals = [
      atrTrend === 'expanding',
      emaCross === 'golden' || emaCross === 'dead',
      rsiZone !== 'neutral',
    ].filter(Boolean).length;

    if (otherSignals >= 1) {
      const confidence = 50 + otherSignals * 10;
      return {
        regime: 'weak_trend',
        confidence: Math.round(Math.min(confidence, 70)),
        details,
      };
    }
  }

  // --- ranging ---
  // ADX<20 + ATR contracting
  if (indicators.adx14 < 20 && atrTrend === 'contracting') {
    const base = 70;
    const bonus = Math.min((20 - indicators.adx14) * 1, 20);
    return {
      regime: 'ranging',
      confidence: Math.round(Math.min(base + bonus, 90)),
      details,
    };
  }

  // --- volatile ---
  // ATR expanding + RSI extreme
  if (
    atrTrend === 'expanding' &&
    (rsiZone === 'overbought' || rsiZone === 'oversold')
  ) {
    return {
      regime: 'volatile',
      confidence: 65,
      details,
    };
  }

  // --- uncertain (fallback) ---
  return {
    regime: 'uncertain',
    confidence: 40,
    details,
  };
}

// ----------------------------------------------------------
// getRegimeProhibitions — レジーム別のGeminiプロンプト禁止行動
// ----------------------------------------------------------

export function getRegimeProhibitions(
  regime: RegimeTag,
  consecutiveLosses?: number,
): string {
  const lines: string[] = [];

  switch (regime) {
    case 'strong_trend':
      lines.push('【禁止】逆張り。トレンド方向のみ。');
      break;
    case 'weak_trend':
      lines.push('【注意】逆張りは高確信度(80+)の場合のみ許可。基本はトレンド方向。');
      break;
    case 'ranging':
      lines.push('【禁止】トレンドフォロー。RSI 70/30でのみ逆張り。');
      break;
    case 'volatile':
      lines.push('【禁止】通常ロット。TP/SLは1.5倍に広げよ。');
      break;
    case 'uncertain':
      lines.push('【注意】環境不明瞭。確信度70以上のみエントリー許可。');
      break;
  }

  // 直近3連敗中の追加制約
  if (consecutiveLosses !== undefined && consecutiveLosses >= 3) {
    lines.push(`【連敗制約】直近${consecutiveLosses}連敗中。確信度80以上のみエントリー。`);
  }

  return lines.join('\n');
}

// ----------------------------------------------------------
// formatRegimeForPrompt — レジーム情報をGeminiプロンプト用テキストに整形
// ----------------------------------------------------------

export function formatRegimeForPrompt(
  result: RegimeResult,
  indicators: TechnicalIndicators,
): string {
  const { regime, confidence, details } = result;

  const trendStrength = indicators.adx14 > 25 ? '強' : '弱';
  const crossLabel =
    details.emaCross === 'golden'
      ? 'ゴールデンクロス'
      : details.emaCross === 'dead'
        ? 'デッドクロス'
        : 'ニュートラル';

  return [
    '【テクニカル環境認識】',
    `レジーム: ${regime} (確信度: ${confidence}%)`,
    `RSI(14): ${indicators.rsi14.toFixed(2)} — ${details.rsiZone}`,
    `ADX(14): ${indicators.adx14.toFixed(2)} — トレンド強度${trendStrength}`,
    `ATR(14): ${indicators.atr14.toFixed(4)}`,
    `EMA(20): ${indicators.ema20.toFixed(3)} / EMA(50): ${indicators.ema50.toFixed(3)} — ${crossLabel}`,
    `BB(20,2): ${indicators.bbLower.toFixed(3)} - ${indicators.bbMiddle.toFixed(3)} - ${indicators.bbUpper.toFixed(3)}`,
  ].join('\n');
}

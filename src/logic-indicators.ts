// ロジックトレーディング用テクニカル指標計算モジュール（Ph.2）
//
// 設計根拠（知識ベースより）:
//   ts.md §1: 時系列の定常性・ACF — ATR/RSIはラグ構造を持つ時系列推定量
//   fx-strategy.md §2: 期待値 = 勝率×RR - 敗率 → RSI/ER でエッジのある局面のみ取引
//   kelly-rl.md §3: OGD — パラメーター（rsi_oversold等）を取引結果で逐次更新
//
// H/Lデータ非保有のため以下の近似を使用:
//   ATR ≈ average(|close[t] - close[t-1]|) over N periods（クローズtoクローズATR）
//   ADX ≈ Efficiency Ratio（Perry Kaufman AMA理論）
//     ER = |close[N] - close[0]| / Σ|close[t] - close[t-1]|
//     ER=1.0: 完全トレンド / ER=0.0: 完全レンジ（ADX>25相当はER>0.40）

export interface TechnicalSignal {
  pair: string;
  rsi: number | null;
  atr: number | null;          // クローズtoクローズATR近似
  er: number | null;           // Efficiency Ratio（0〜1）
  regime: 'trending' | 'ranging' | 'volatile' | 'unknown';
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  reason: string;
  tp_rate: number | null;      // ATRベースTP（エントリーレートから計算）
  sl_rate: number | null;      // ATRベースSL
}

export interface InstrumentParamsRow {
  pair: string;
  rsi_period: number;
  rsi_oversold: number;
  rsi_overbought: number;
  adx_period: number;
  adx_min: number;
  atr_period: number;
  atr_tp_multiplier: number;
  atr_sl_multiplier: number;
  vix_max: number;
  require_trend_align: number;
  regime_allow: string;
}

// ─── RSI計算 ─────────────────────────────────────────────────────────────────
// Wilder平滑化（RMA: Relative Moving Average）を使用
// 入力: 終値配列（時系列順、最古→最新）、period
// 出力: RSI値（0〜100）または null（データ不足）

export function calcRSI(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;

  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  // 最初のavgGain/avgLossは単純平均
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Wilder平滑化（RMA）でperiod以降を更新
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ─── ATR計算（クローズtoクローズ近似）─────────────────────────────────────────
// True Range = max(high-low, |high-prev|, |low-prev|) の本来定義の代替
// H/Lデータ非保有のため: TR ≈ |close[t] - close[t-1]| で近似
// Wilder平滑化（RMA）で平均化

export function calcATR(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;

  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.abs(closes[i] - closes[i - 1]));
  }

  // 初期ATR: 単純平均
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Wilder平滑化
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return atr;
}

// ─── Efficiency Ratio計算（ADX代替）────────────────────────────────────────
// ER = |終値変化（N期間の純移動）| / Σ|各期間の変化量|
// ER > 0.40 → トレンド相場（ADX>25相当）
// ER < 0.25 → レンジ相場
// 参考: Perry Kaufman "Trading Systems and Methods" (2013) §12

export function calcER(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;

  const slice = closes.slice(closes.length - period - 1);
  const netMove = Math.abs(slice[slice.length - 1] - slice[0]);
  const totalMove = slice.slice(1).reduce((sum, c, i) => sum + Math.abs(c - slice[i]), 0);

  if (totalMove === 0) return 0;
  return netMove / totalMove;
}

// ─── レジーム判定 ────────────────────────────────────────────────────────────

export function detectRegime(
  er: number | null,
  atr: number | null,
  historicalAtrMean: number | null,
  vix: number | null,
): 'trending' | 'ranging' | 'volatile' | 'unknown' {
  if (er === null) return 'unknown';

  // VIXまたはATRが異常に高い場合は volatile
  if (vix !== null && vix > 30) return 'volatile';
  if (atr !== null && historicalAtrMean !== null && atr > historicalAtrMean * 2.5) return 'volatile';

  if (er >= 0.40) return 'trending';
  if (er < 0.25) return 'ranging';
  return 'ranging'; // 中間はレンジとして扱う（エッジが薄い）
}

// ─── メイン: 定量シグナル生成 ────────────────────────────────────────────────

export function calcTechnicalSignal(
  pair: string,
  closes: number[],          // 時系列順（最古→最新）
  currentRate: number,
  params: InstrumentParamsRow,
  vix: number | null,
): TechnicalSignal {
  const { rsi_period, rsi_oversold, rsi_overbought,
          adx_period, atr_period, adx_min,
          atr_tp_multiplier, atr_sl_multiplier,
          regime_allow } = params;

  const rsi = calcRSI(closes, rsi_period);
  const atr = calcATR(closes, atr_period);
  const er  = calcER(closes, adx_period);

  // historicalAtrMean: closes全体からATR平均（ボラ比較用）
  const historicalAtrMean = closes.length >= atr_period * 2
    ? calcATR(closes.slice(0, Math.floor(closes.length / 2)), atr_period)
    : null;

  const regime = detectRegime(er, atr, historicalAtrMean, vix);
  const allowedRegimes = regime_allow.split(',').map(r => r.trim());

  // ─── シグナル判定 ───────────────────────────────────────────────────────

  // データ不足
  if (rsi === null || atr === null || er === null) {
    return { pair, rsi, atr, er, regime, signal: 'NEUTRAL',
             reason: `データ不足(closes=${closes.length}件)`, tp_rate: null, sl_rate: null };
  }

  // レジームが許可外
  if (!allowedRegimes.includes(regime)) {
    return { pair, rsi, atr, er, regime, signal: 'NEUTRAL',
             reason: `レジーム${regime}は許可外(${regime_allow})`, tp_rate: null, sl_rate: null };
  }

  // ER（トレンド強度）が adx_min 相当未満
  // adx_min=25 → ER閾値=0.40 に相当（線形マッピング: adx_min/60）
  const erThreshold = adx_min / 60;
  if (er < erThreshold) {
    return { pair, rsi, atr, er, regime, signal: 'NEUTRAL',
             reason: `ER=${er.toFixed(3)} < 閾値${erThreshold.toFixed(3)}（ADX${adx_min}相当）`,
             tp_rate: null, sl_rate: null };
  }

  // BUYシグナル: RSI が oversold 以下（売られすぎ）
  if (rsi < rsi_oversold) {
    const tp = parseFloat((currentRate + atr * atr_tp_multiplier).toFixed(5));
    const sl = parseFloat((currentRate - atr * atr_sl_multiplier).toFixed(5));
    return { pair, rsi, atr, er, regime, signal: 'BUY',
             reason: `RSI=${rsi.toFixed(1)}<${rsi_oversold}(売られすぎ) ER=${er.toFixed(3)} ATR=${atr.toFixed(4)}`,
             tp_rate: tp, sl_rate: sl };
  }

  // SELLシグナル: RSI が overbought 以上（買われすぎ）
  if (rsi > rsi_overbought) {
    const tp = parseFloat((currentRate - atr * atr_tp_multiplier).toFixed(5));
    const sl = parseFloat((currentRate + atr * atr_sl_multiplier).toFixed(5));
    return { pair, rsi, atr, er, regime, signal: 'SELL',
             reason: `RSI=${rsi.toFixed(1)}>${rsi_overbought}(買われすぎ) ER=${er.toFixed(3)} ATR=${atr.toFixed(4)}`,
             tp_rate: tp, sl_rate: sl };
  }

  // 中立
  return { pair, rsi, atr, er, regime, signal: 'NEUTRAL',
           reason: `RSI=${rsi.toFixed(1)} 中立ゾーン(${rsi_oversold}〜${rsi_overbought})`,
           tp_rate: null, sl_rate: null };
}

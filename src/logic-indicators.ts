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
  // Ph.7: スコアリング詳細
  scores?: {
    rsi: number;
    er: number;
    mtf: number;
    sr: number;
    pa: number;
    bb: number;    // Ph.9: BBスクイーズ/拡大スコア
    div: number;   // Ph.9: RSIダイバージェンススコア
    total: number;
    breakdown: string;  // 人間可読なスコア内訳
  };
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
  // Ph.6: 拡張ロジックパラメーター（Path A廃止に伴い、AIが管理するメタパラメーター）
  vix_tp_scale:         number;  // VIX > vix_max×0.7 時のTP幅倍率（1.0=通常, 0.7=縮小）
  vix_sl_scale:         number;  // VIX > vix_max×0.7 時のSL幅倍率
  strategy_primary:     string;  // 優先戦略: 'mean_reversion' | 'trend_follow'
  min_signal_strength:  number;  // エントリー最低シグナル強度（RSI偏差+ER、0〜1）
  macro_sl_scale:       number;  // VIX > vix_max×0.5 時のSL幅追加倍率（マクロ警戒）
  // Ph.7: 重みつきエントリースコアリング
  w_rsi:           number;  // RSI偏差の重み
  w_er:            number;  // ER（トレンド強度）の重み
  w_mtf:           number;  // マルチタイムフレーム整合性の重み
  w_sr:            number;  // サポレジ近接度の重み
  w_pa:            number;  // プライスアクション（直近高安パターン）の重み
  entry_score_min: number;  // エントリー最低スコア
  min_rr_ratio:    number;  // スケール適用後の最小RR比
  // Ph.8: 金融理論ベース10パラメーター
  max_hold_minutes:        number;  // 最大保有時間（分）。超過で自動決済
  cooldown_after_sl:       number;  // SL後の再エントリー待機（分）
  consecutive_loss_shrink: number;  // N連敗でロット50%縮小
  daily_max_entries:       number;  // 1日の最大エントリー回数（銘柄別）
  trailing_activation_atr: number;  // トレイリング開始（ATR倍）
  trailing_distance_atr:   number;  // トレイリング追従幅（ATR倍）
  tp1_ratio:               number;  // TP1分割決済比率
  session_start_utc:       number;  // 取引開始時刻（UTC時）
  session_end_utc:         number;  // 取引終了時刻（UTC時）
  review_min_trades:       number;  // Param Review最低サンプル数
  // Ph.9: エントリー精度パラメーター
  bb_period:              number;  // ボリンジャーバンド期間
  bb_squeeze_threshold:   number;  // スクイーズ判定閾値（バンド幅/平均バンド幅 < この値）
  w_bb:                   number;  // BBスクイーズ/拡大スコアリング重み
  w_div:                  number;  // RSIダイバージェンススコアリング重み
  divergence_lookback:    number;  // ダイバージェンス比較期間
  min_confirm_signals:    number;  // 最低N個のスコア要因が閾値超必要
  er_upper_limit:         number;  // mean_reversion時のER上限
  // Ph.10: SMAベースMTF + BBブレイクアウトパラメーター
  sma_short_period:       number;  // 短期SMA期間（MTF整合判定用）
  sma_long_period:        number;  // 長期SMA期間（MTF整合判定用）
  volatility_ratio_min:   number;  // BBブレイクアウト発火最低ボラティリティ比（ATR/historicalAtrMean）
  sma_angle_min:          number;  // 短期SMAの傾き最小値（0=方向だけ確認）
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

// ─── SMA計算 ─────────────────────────────────────────────────────────────────
// 単純移動平均（Simple Moving Average）: 直近period本の算術平均

export function calcSMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ─── ボリンジャーバンド計算 ──────────────────────────────────────────────────
// 直近period本の平均±2σを算出。スクイーズ判定用の width/avgWidth に加え
// ブレイクアウトトリガー用の upperBand / lowerBand も返す。
//
// ※ calcBBWidth の上位互換。calcBBWidth は削除し本関数に統一する。

export function calcBollingerBands(closes: number[], period: number): {
  width: number;     // 正規化バンド幅（%BBW = 4σ/mean）
  avgWidth: number;  // 過去半区間の平均バンド幅（スクイーズ比較用）
  upperBand: number; // 上バンド（mean + 2σ）
  lowerBand: number; // 下バンド（mean - 2σ）
  midBand: number;   // 中心線（SMA）
} | null {
  if (closes.length < period * 2) return null;

  // 直近periodの標準偏差 → バンド幅と上下バンド
  const recent = closes.slice(-period);
  const mean = recent.reduce((a, b) => a + b, 0) / period;
  const variance = recent.reduce((a, c) => a + (c - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const width = mean > 0 ? (4 * std) / mean : 0; // 正規化バンド幅（4σ/mean = %BBW）
  const upperBand = mean + 2 * std;
  const lowerBand = mean - 2 * std;

  // 過去の平均バンド幅（比較用: 前半区間で算出）
  const halfLen = Math.floor(closes.length / 2);
  const older = closes.slice(Math.max(0, halfLen - period), halfLen);
  if (older.length < period) return { width, avgWidth: width, upperBand, lowerBand, midBand: mean };
  const olderMean = older.reduce((a, b) => a + b, 0) / period;
  const olderVariance = older.reduce((a, c) => a + (c - olderMean) ** 2, 0) / period;
  const olderStd = Math.sqrt(olderVariance);
  const avgWidth = olderMean > 0 ? (4 * olderStd) / olderMean : width;

  return { width, avgWidth: avgWidth || width, upperBand, lowerBand, midBand: mean };
}

// ─── RSIダイバージェンス検出（2点近似）────────────────────────────────────
// 高コストなRSIローリング計算を回避し、現在のRSI vs lookback本前のRSIを比較
// ブルダイバージェンス: 価格↓ & RSI↑（BUY方向に有利）
// ベアダイバージェンス: 価格↑ & RSI↓（SELL方向に有利）

export function detectDivergence2Point(
  closes: number[],
  rsiNow: number,
  rsiPast: number,
  direction: 'BUY' | 'SELL',
  lookback: number,
): boolean {
  if (closes.length <= lookback) return false;
  const priceNow = closes[closes.length - 1];
  const pricePast = closes[closes.length - 1 - lookback] ?? closes[0];
  if (direction === 'BUY') {
    return priceNow < pricePast && rsiNow > rsiPast; // 価格↓ RSI↑
  } else {
    return priceNow > pricePast && rsiNow < rsiPast; // 価格↑ RSI↓
  }
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

  // ── Ph.7: 重みつきエントリースコアリング計算 ──────────────────────────
  // BUY/SELL シグナル生成前にスコアを計算し、TechnicalSignal に付与する
  // スコアリング自体はフィルタリングを行わない（logic-trading.ts 側で閾値チェック）
  const calcScores = (direction: 'BUY' | 'SELL') => {
    // 1. RSI スコア（0〜1）
    const rsiScore = direction === 'BUY'
      ? Math.max(0, Math.min(1, (params.rsi_oversold - rsi!) / Math.max(1, params.rsi_oversold)))
      : Math.max(0, Math.min(1, (rsi! - params.rsi_overbought) / Math.max(1, 100 - params.rsi_overbought)));

    // 2. ER スコア（0〜1）
    const erScore = params.strategy_primary === 'trend_follow'
      ? Math.min(1, er!)
      : Math.min(1, Math.max(0, 1 - er!));  // mean_reversion: ERが低いほど高スコア

    // 3. MTFスコア（0〜1）: SMAクロスと傾きによるトレンド整合性判定
    // 短期SMA > 長期SMA かつ短期SMAが上向き → BUY整合
    // 短期SMA < 長期SMA かつ短期SMAが下向き → SELL整合
    const smaShort = calcSMA(closes, params.sma_short_period);
    const smaLong  = calcSMA(closes, params.sma_long_period);
    const smaShortPrev = calcSMA(closes.slice(0, -1), params.sma_short_period);
    let mtfScore = 0.0;
    if (smaShort !== null && smaLong !== null && smaShortPrev !== null) {
      const smaAngle = smaShort - smaShortPrev; // 短期SMAの直近1本分の傾き
      if (direction === 'BUY') {
        mtfScore = (smaShort > smaLong && smaAngle > params.sma_angle_min) ? 1.0 : 0.0;
      } else {
        mtfScore = (smaShort < smaLong && smaAngle < -params.sma_angle_min) ? 1.0 : 0.0;
      }
    }

    // 4. サポレジ近接度スコア（0〜1）
    const recentHigh = Math.max(...closes.slice(-20));
    const recentLow = Math.min(...closes.slice(-20));
    const range = recentHigh - recentLow;
    const srScore = range > 0
      ? (direction === 'BUY'
          ? (recentHigh - currentRate) / range
          : (currentRate - recentLow) / range)
      : 0.5;

    // 5. プライスアクション スコア（0〜1）: 直近3本の反転パターン
    const last3 = closes.slice(-3);
    const paScore = last3.length >= 3
      ? (direction === 'BUY'
          ? (last3[2] > last3[1] && last3[1] < last3[0]) ? 1.0 : 0.0
          : (last3[2] < last3[1] && last3[1] > last3[0]) ? 1.0 : 0.0)
      : 0.5;

    // 6. BBスクイーズスコア（0〜1）
    const bbData = calcBollingerBands(closes, params.bb_period);
    let bbScore = 0.5;
    if (bbData) {
      const ratio = bbData.avgWidth > 0 ? bbData.width / bbData.avgWidth : 1;
      if (params.strategy_primary === 'mean_reversion') {
        bbScore = Math.max(0, Math.min(1, 1 - ratio));
      } else {
        bbScore = Math.max(0, Math.min(1, ratio));
      }
    }

    // 7. ダイバージェンススコア（0 or 1）
    const rsiPastVal = closes.length > params.divergence_lookback
      ? calcRSI(closes.slice(0, -params.divergence_lookback), rsi_period)
      : null;
    const divScore = (rsi !== null && rsiPastVal !== null)
      ? (detectDivergence2Point(closes, rsi, rsiPastVal, direction, params.divergence_lookback) ? 1.0 : 0.0)
      : 0;

    // 重みつき総合スコア
    const total =
      params.w_rsi * rsiScore +
      params.w_er  * erScore +
      params.w_mtf * mtfScore +
      params.w_sr  * Math.max(0, Math.min(1, srScore)) +
      params.w_pa  * paScore +
      params.w_bb  * bbScore +
      params.w_div * divScore;

    const breakdown = `rsi=${rsiScore.toFixed(2)}*${params.w_rsi} er=${erScore.toFixed(2)}*${params.w_er} mtf=${mtfScore.toFixed(1)}*${params.w_mtf} sr=${Math.max(0, Math.min(1, srScore)).toFixed(2)}*${params.w_sr} pa=${paScore.toFixed(1)}*${params.w_pa} bb=${bbScore.toFixed(2)}*${params.w_bb} div=${divScore.toFixed(0)}*${params.w_div}`;

    return { rsi: rsiScore, er: erScore, mtf: mtfScore, sr: Math.max(0, Math.min(1, srScore)), pa: paScore, bb: bbScore, div: divScore, total, breakdown };
  };

  // ── Ph.10: BBスクイーズ・ブレイクアウト判定（順張り）────────────────────
  // 発火条件:
  //   1. ATRがhistoricalAtrMean比でvolatility_ratio_min以上（静止相場を除外）
  //   2. BBバンド幅がbb_squeeze_threshold未満（スクイーズ状態）
  //   3. 現在レートがupper/lowerBandを突破している（ブレイクアウト確認）
  // TP/SLは順張り方向（逆張りRSIと逆: BUYはTP上・SL下）
  const bbBreak = calcBollingerBands(closes, params.bb_period);
  if (bbBreak !== null && historicalAtrMean !== null && historicalAtrMean > 0) {
    const volatilityRatio = atr / historicalAtrMean;
    const widthRatio = bbBreak.avgWidth > 0 ? bbBreak.width / bbBreak.avgWidth : 1;
    if (volatilityRatio >= params.volatility_ratio_min && widthRatio < params.bb_squeeze_threshold) {
      if (currentRate > bbBreak.upperBand) {
        // BUYブレイクアウト: +2σ上抜け（順張り: TP上・SL下）
        const tp = parseFloat((currentRate + atr * atr_tp_multiplier).toFixed(5));
        const sl = parseFloat((currentRate - atr * atr_sl_multiplier).toFixed(5));
        const scores = calcScores('BUY');
        return { pair, rsi, atr, er, regime, signal: 'BUY',
                 reason: `BBスクイーズ・ブレイクアウト(+2σ上抜け) VR=${volatilityRatio.toFixed(2)} 幅比=${widthRatio.toFixed(2)} upper=${bbBreak.upperBand.toFixed(4)}`,
                 tp_rate: tp, sl_rate: sl, scores };
      }
      if (currentRate < bbBreak.lowerBand) {
        // SELLブレイクアウト: -2σ下抜け（順張り: TP下・SL上）
        const tp = parseFloat((currentRate - atr * atr_tp_multiplier).toFixed(5));
        const sl = parseFloat((currentRate + atr * atr_sl_multiplier).toFixed(5));
        const scores = calcScores('SELL');
        return { pair, rsi, atr, er, regime, signal: 'SELL',
                 reason: `BBスクイーズ・ブレイクアウト(-2σ下抜け) VR=${volatilityRatio.toFixed(2)} 幅比=${widthRatio.toFixed(2)} lower=${bbBreak.lowerBand.toFixed(4)}`,
                 tp_rate: tp, sl_rate: sl, scores };
      }
    }
  }

  // BUYシグナル: RSI が oversold 以下（売られすぎ）
  if (rsi < rsi_oversold) {
    const tp = parseFloat((currentRate + atr * atr_tp_multiplier).toFixed(5));
    const sl = parseFloat((currentRate - atr * atr_sl_multiplier).toFixed(5));
    const scores = calcScores('BUY');
    return { pair, rsi, atr, er, regime, signal: 'BUY',
             reason: `RSI=${rsi.toFixed(1)}<${rsi_oversold}(売られすぎ) ER=${er.toFixed(3)} ATR=${atr.toFixed(4)}`,
             tp_rate: tp, sl_rate: sl, scores };
  }

  // SELLシグナル: RSI が overbought 以上（買われすぎ）
  if (rsi > rsi_overbought) {
    const tp = parseFloat((currentRate - atr * atr_tp_multiplier).toFixed(5));
    const sl = parseFloat((currentRate + atr * atr_sl_multiplier).toFixed(5));
    const scores = calcScores('SELL');
    return { pair, rsi, atr, er, regime, signal: 'SELL',
             reason: `RSI=${rsi.toFixed(1)}>${rsi_overbought}(買われすぎ) ER=${er.toFixed(3)} ATR=${atr.toFixed(4)}`,
             tp_rate: tp, sl_rate: sl, scores };
  }

  // 中立
  return { pair, rsi, atr, er, regime, signal: 'NEUTRAL',
           reason: `RSI=${rsi.toFixed(1)} 中立ゾーン(${rsi_oversold}〜${rsi_overbought})`,
           tp_rate: null, sl_rate: null };
}

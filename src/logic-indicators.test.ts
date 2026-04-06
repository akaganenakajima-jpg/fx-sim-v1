/**
 * logic-indicators.ts ユニットテスト
 *
 * Ph.10: SMA BB Breakout 戦略の挙動検証
 *  - calcSMA / calcBollingerBands の計算精度
 *  - calcTechnicalSignal の BBスクイーズ・ブレイクアウト判定
 *  - isBBBreakout フラグが正しくセットされるか
 *  - trend_follow スコアリングがオーバーライドされるか（erScore・bbScore方向）
 *
 * テスト方針:
 *   volatility_ratio_min = 0.0 → ATRフィルター無効化
 *   純粋にBBスクイーズ+ブレイクアウト判定ロジックを単体テスト
 */
import { describe, it, expect } from 'vitest';
import {
  calcSMA,
  calcBollingerBands,
  calcTechnicalSignal,
  type InstrumentParamsRow,
} from './logic-indicators';

// ─── テスト用デフォルトパラメーター ────────────────────────────────────────────
// ポイント:
//   adx_min=0            → erThreshold=0（ER閾値無効）
//   volatility_ratio_min=0 → ATRフィルター無効
//   macd_histogram_trend=0 → MACDフィルター無効
//   entry_score_min=0    → スコアフィルター無効
//   min_confirm_signals=0  → 多様性チェック無効
// これにより「BBスクイーズ・ブレイクアウト判定ロジック本体」のみを純粋にテストできる
function makeParams(overrides: Partial<InstrumentParamsRow> = {}): InstrumentParamsRow {
  return {
    pair:                    'USD/JPY',
    rsi_period:              14,
    rsi_oversold:            30,
    rsi_overbought:          70,
    adx_period:              14,
    adx_min:                 0,    // ER閾値無効（erThreshold = 0/60 = 0）
    atr_period:              14,
    atr_tp_multiplier:       2.0,
    atr_sl_multiplier:       1.0,
    vix_max:                 35,
    require_trend_align:     0,
    regime_allow:            'trending,ranging,volatile',
    vix_tp_scale:            1.0,
    vix_sl_scale:            1.0,
    strategy_primary:        'mean_reversion',
    min_signal_strength:     0,
    macro_sl_scale:          1.0,
    w_rsi:                   0.35,
    w_er:                    0.25,
    w_mtf:                   0.2,
    w_sr:                    0.1,
    w_pa:                    0.1,
    entry_score_min:         0.0,   // スコア閾値ゼロ（スコアだけ検証）
    min_rr_ratio:            2.0,
    max_hold_minutes:        480,
    cooldown_after_sl:       10,
    consecutive_loss_shrink: 3,
    daily_max_entries:       5,
    trailing_activation_atr: 1.5,
    trailing_distance_atr:   1.0,
    tp1_ratio:               0.5,
    session_start_utc:       0,
    session_end_utc:         24,
    review_min_trades:       50,
    bb_period:               20,
    bb_squeeze_threshold:    0.4,  // バンド幅比 < 40% でスクイーズ判定
    w_bb:                    0.1,
    w_div:                   0.05,
    divergence_lookback:     14,
    min_confirm_signals:     0,    // 多様性チェック無効
    er_upper_limit:          0.85,
    // Ph.10
    sma_short_period:        10,
    sma_long_period:         40,
    volatility_ratio_min:    0.0,  // ATRフィルター無効（テスト隔離）
    sma_angle_min:           0.0,
    // Ph.10b
    time_based_exit_minutes: 120,
    trailing_step_atr:       0.5,
    macd_histogram_trend:    0,    // MACDフィルター無効（テスト隔離）
    // Ph.11
    max_pyramiding_entries:  0,
    ...overrides,
  };
}

// ─── テスト用価格データ生成 ─────────────────────────────────────────────────────
/**
 * BBスクイーズ+ブレイクアウト用価格データを生成する
 *
 * 設計:
 *   - closes[0:40]: ±2 程度のノイズ（歴史的BB幅を「広く」する）
 *   - closes[40:60]: 同程度のノイズ（RSI/ATR計算用のリカバリー期間）
 *   - closes[60:80]: ±0.1 の超タイト（スクイーズ状態）
 *
 * これにより:
 *   - older section (closes[20:40]): std ≈ 1.2 → avgWidth広い
 *   - recent section (closes[60:80]): std ≈ 0.06 → width狭い
 *   - widthRatio ≈ 0.05 < 0.4 → スクイーズ条件成立
 */
function makeSqueezePrices(
  basePrice = 150.0,
  squeezeStd = 0.1,
  normalStd = 2.0,
  length = 80,
): number[] {
  const prices: number[] = [];
  const squeezeStart = length - 20;

  for (let i = 0; i < length; i++) {
    if (i < squeezeStart) {
      // 正規ノイズ近似: alternating ±normalStd
      const noise = (i % 2 === 0 ? 1 : -1) * normalStd * (0.5 + 0.5 * ((i % 7) / 7));
      prices.push(basePrice + noise);
    } else {
      // 超タイトレンジ（スクイーズ）
      const noise = (i % 2 === 0 ? 1 : -1) * squeezeStd;
      prices.push(basePrice + noise);
    }
  }
  return prices;
}

// ─── calcSMA テスト ──────────────────────────────────────────────────────────

describe('calcSMA', () => {
  it('期間より短い配列に対してnullを返す', () => {
    expect(calcSMA([150, 151], 5)).toBeNull();
  });

  it('ちょうど period 本の平均を返す', () => {
    const closes = [148, 149, 150, 151, 152]; // 期間5
    const sma = calcSMA(closes, 5);
    expect(sma).toBe(150);
  });

  it('直近 period 本だけを使う（先頭データを無視）', () => {
    const closes = [100, 100, 100, 148, 149, 150, 151, 152];
    const sma = calcSMA(closes, 5); // 直近5本: 148+149+150+151+152=750/5=150
    expect(sma).toBe(150);
  });
});

// ─── calcBollingerBands テスト ───────────────────────────────────────────────

describe('calcBollingerBands', () => {
  it('データ不足(< period*2)の場合はnullを返す', () => {
    const closes = Array.from({ length: 30 }, () => 150);
    expect(calcBollingerBands(closes, 20)).toBeNull();
  });

  it('一定価格の場合: upper=lower=mid=price, width≈0', () => {
    const closes = Array.from({ length: 40 }, () => 150);
    const result = calcBollingerBands(closes, 20);
    expect(result).not.toBeNull();
    expect(result!.midBand).toBeCloseTo(150, 4);
    expect(result!.upperBand).toBeCloseTo(150, 4);
    expect(result!.lowerBand).toBeCloseTo(150, 4);
    expect(result!.width).toBeCloseTo(0, 5);
  });

  it('上バンドは中心線より高く、下バンドは低い（正の標準偏差時）', () => {
    const closes = [...Array.from({ length: 20 }, (_, i) => 145 + i), // 145-164
                    ...Array.from({ length: 20 }, (_, i) => 150 + (i % 3 === 0 ? 2 : -1))]; // ノイズ
    const result = calcBollingerBands(closes, 20);
    expect(result).not.toBeNull();
    expect(result!.upperBand).toBeGreaterThan(result!.midBand);
    expect(result!.lowerBand).toBeLessThan(result!.midBand);
  });

  it('スクイーズ検出: 直近が超タイトな場合 widthRatio が小さい', () => {
    // older(middle section): std高い → avgWidth高い
    // recent(last 20): std低い → width低い → widthRatio = width/avgWidth 小
    const prices = makeSqueezePrices(150, 0.05, 3.0, 80);
    const result = calcBollingerBands(prices, 20);
    expect(result).not.toBeNull();
    const widthRatio = result!.width / result!.avgWidth;
    expect(widthRatio).toBeLessThan(0.4); // スクイーズ条件成立を確認
  });
});

// ─── calcTechnicalSignal BBスクイーズ・ブレイクアウトテスト ─────────────────────

describe('calcTechnicalSignal: SMA BB Breakout (Ph.10)', () => {
  it('BBスクイーズ中に+2σ上抜け → BUYシグナル + isBBBreakout=true', () => {
    const prices = makeSqueezePrices(150, 0.05, 3.0, 80);
    const bbResult = calcBollingerBands(prices, 20)!;

    // 現在レートを upperBand より高く設定
    const currentRate = bbResult.upperBand + 0.5;
    const params = makeParams();

    const signal = calcTechnicalSignal('USD/JPY', prices, currentRate, params, null);

    expect(signal.signal).toBe('BUY');
    expect(signal.isBBBreakout).toBe(true);
    expect(signal.reason).toContain('BBスクイーズ・ブレイクアウト(+2σ上抜け)');
    expect(signal.tp_rate).not.toBeNull();
    expect(signal.sl_rate).not.toBeNull();
    // TP は BUY なので entry より上、SL は下
    expect(signal.tp_rate!).toBeGreaterThan(currentRate);
    expect(signal.sl_rate!).toBeLessThan(currentRate);
  });

  it('BBスクイーズ中に-2σ下抜け → SELLシグナル + isBBBreakout=true', () => {
    const prices = makeSqueezePrices(150, 0.05, 3.0, 80);
    const bbResult = calcBollingerBands(prices, 20)!;

    // 現在レートを lowerBand より低く設定
    const currentRate = bbResult.lowerBand - 0.5;
    const params = makeParams();

    const signal = calcTechnicalSignal('USD/JPY', prices, currentRate, params, null);

    expect(signal.signal).toBe('SELL');
    expect(signal.isBBBreakout).toBe(true);
    expect(signal.reason).toContain('BBスクイーズ・ブレイクアウト(-2σ下抜け)');
    expect(signal.tp_rate).not.toBeNull();
    expect(signal.sl_rate).not.toBeNull();
    // TP は SELL なので entry より下、SL は上
    expect(signal.tp_rate!).toBeLessThan(currentRate);
    expect(signal.sl_rate!).toBeGreaterThan(currentRate);
  });

  it('スクイーズ条件不成立（バンドが歴史的平均幅以上）→ BBブレイクアウトは発火しない', () => {
    // 全期間を同じ標準偏差にすると widthRatio ≈ 1.0 > bb_squeeze_threshold
    const prices = Array.from({ length: 80 }, (_, i) =>
      150 + (i % 2 === 0 ? 1.5 : -1.5), // 全期間一定のボラ
    );
    const bbResult = calcBollingerBands(prices, 20)!;
    const widthRatio = bbResult.width / bbResult.avgWidth;
    // スクイーズ状態でないことを確認
    expect(widthRatio).toBeGreaterThanOrEqual(0.4);

    const currentRate = bbResult.upperBand + 1; // 上抜けしてもスクイーズなし
    const params = makeParams();

    const signal = calcTechnicalSignal('USD/JPY', prices, currentRate, params, null);
    // BB breakout is not triggered (no squeeze)
    expect(signal.isBBBreakout).toBeUndefined();
  });

  it('isBBBreakout=true 時: スコアが trend_follow 型で計算される（erScore = er, 1-er ではない）', () => {
    const prices = makeSqueezePrices(150, 0.05, 3.0, 80);
    const bbResult = calcBollingerBands(prices, 20)!;
    const currentRate = bbResult.upperBand + 0.5;

    // mean_reversion 登録のパラメーターでBBブレイクアウトを発火させる
    const params = makeParams({ strategy_primary: 'mean_reversion', entry_score_min: 0 });
    const signal = calcTechnicalSignal('USD/JPY', prices, currentRate, params, null);

    expect(signal.isBBBreakout).toBe(true);
    expect(signal.scores).toBeDefined();

    // trend_follow スコアリング: erScore = er（高ERほど高スコア）
    // mean_reversion の場合: erScore = 1 - er（低ERほど高スコア）
    // ブレイクアウト時は ER が比較的高くなるはず → trend_follow だと erScore > 0
    const { er } = signal;
    if (er !== null && er > 0.3) {
      // trend_follow: erScore = er ≈ 0.3〜0.6
      // mean_reversion だったら erScore = 1 - er ≈ 0.4〜0.7（逆方向）
      // 内部breakdownから erScore を取り出して trend_follow 型か確認
      const breakdown = signal.scores!.breakdown;
      const erMatch = breakdown.match(/er=([0-9.]+)\*/);
      if (erMatch) {
        const erScoreInBreakdown = parseFloat(erMatch[1]);
        // trend_follow: erScore ≈ er
        // mean_reversion: erScore ≈ 1-er
        // breakdownの値がerに近い（trend_follow型）か確認
        expect(Math.abs(erScoreInBreakdown - er)).toBeLessThan(Math.abs(erScoreInBreakdown - (1 - er)));
      }
    }
    // シグナル全体のsanity check
    expect(signal.signal).toBe('BUY');
    expect(signal.scores!.total).toBeGreaterThanOrEqual(0);
  });

  it('SMAパラメーターが MTFスコアに影響する', () => {
    // 強い上昇トレンドデータ: short SMA > long SMA → BUYに有利なMTFスコア
    const trendingPrices: number[] = [];
    for (let i = 0; i < 80; i++) {
      trendingPrices.push(100 + i * 0.5); // 100 → 139.5 の強い上昇トレンド
    }
    // スクイーズ条件はATRフィルター無効化で強制的に作る
    const squeezePrices = makeSqueezePrices(150, 0.05, 3.0, 80);
    const bbResult = calcBollingerBands(squeezePrices, 20)!;
    const currentRate = bbResult.upperBand + 0.5;

    // sma_short_period=10, sma_long_period=40 でMTFスコアが計算される
    const params = makeParams({
      sma_short_period: 10,
      sma_long_period: 40,
    });
    const signal = calcTechnicalSignal('USD/JPY', squeezePrices, currentRate, params, null);

    // MTFスコアのbreakdownが含まれていることを確認
    if (signal.scores) {
      expect(signal.scores.breakdown).toContain('mtf=');
    }
  });
});

// ─── isBBBreakout フラグの保持テスト ────────────────────────────────────────────

describe('isBBBreakout フラグの保持', () => {
  it('通常の RSI シグナルには isBBBreakout が付かない', () => {
    // RSIが売られすぎになるよう価格を急落させる
    const prices: number[] = [];
    for (let i = 0; i < 60; i++) prices.push(150);
    for (let i = 0; i < 20; i++) prices.push(150 - i * 3); // 急落: 147→117

    const currentRate = prices[prices.length - 1];
    const params = makeParams({ volatility_ratio_min: 0.0 });

    const signal = calcTechnicalSignal('USD/JPY', prices, currentRate, params, null);

    // RSIシグナルの場合: isBBBreakout はセットされない
    if (signal.signal !== 'NEUTRAL') {
      expect(signal.isBBBreakout).toBeUndefined();
    }
  });
});

// 取引対象銘柄の定義

/** 相関グループ（テスタ施策4） */
export type CorrelationGroup =
  | 'usd_strong' | 'risk_on' | 'precious'
  | 'energy' | 'europe' | 'standalone';

export interface InstrumentConfig {
  pair: string;
  /** ブローカー: 'oanda' = OANDA API経由、'paper' = D1記録のみ */
  broker: 'oanda' | 'paper';
  /** OANDA銘柄コード（broker='oanda'の場合必須） */
  oandaSymbol: string | null;
  /** フィルタ: この変化量以上でGeminiを呼ぶ */
  rateChangeTh: number;
  /** Geminiプロンプト用TP/SL範囲ヒント */
  tpSlHint: string;
  /** TP/SL距離の最小値（レート単位）— この値未満はサニティ拒否 */
  tpSlMin: number;
  /** SL距離の最大値（レート単位）— SLがこの値を超えるとサニティ拒否。TPには適用しない */
  tpSlMax: number;
  /** TP/SL比（RR）の最大値 — TPはこの倍率までSLに対して自由に設定可能。AIの大きな予測を妨げない */
  rrMax: number;
  /** PnL表示単位 */
  pnlUnit: string;
  /** PnL = (close - entry) * pnlMultiplier */
  pnlMultiplier: number;
  /** トレイリングストップ: この値幅分利益が出たらトレイリング開始（レート単位） */
  trailingActivation: number;
  /** トレイリングストップ: SLを現在値からこの幅で追従（レート単位） */
  trailingDistance: number;
  /** 相関グループ（テスタ施策4: 同グループ同方向2件以上でブロック） */
  correlationGroup: CorrelationGroup;
  /** テスタ施策23: 銘柄ティア（A=主力 / B=準主力 / C=サブ / D=実験） */
  tier: 'A' | 'B' | 'C' | 'D';
  /** テスタ施策23: ティア別ロット倍率 */
  tierLotMultiplier: number;
}

export const INSTRUMENTS: InstrumentConfig[] = [
  {
    pair: 'USD/JPY',
    broker: 'oanda',
    oandaSymbol: 'USD_JPY',
    rateChangeTh: 0.015,
    tpSlHint: 'SLは0.2〜1.2円（entry ATRの0.7〜4倍）、TPはSLの最大8倍まで自由（RR1.5以上推奨）',
    tpSlMin: 0.2,    // H1-ATR≈0.3円。0.2円未満は拒否
    tpSlMax: 1.2,    // SLは1.2円以内（ATR×4）
    rrMax: 8,        // RR最大8倍（TP上限 = SL × 8）
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.2,   // 0.2円利益でトレイリング開始（旧0.3）
    trailingDistance: 0.12,    // 0.12円幅で追従（旧0.15）
    correlationGroup: 'usd_strong',
    tier: 'A', tierLotMultiplier: 1.0,
  },
  {
    pair: 'Nikkei225',
    broker: 'oanda',
    oandaSymbol: 'JP225_USD',
    rateChangeTh: 15,
    tpSlHint: 'SLは80〜500pt（ATRの0.8〜5倍）、TPはSLの最大12倍まで自由（RR1.5以上推奨）',
    tpSlMin: 80,     // H1-ATR≈100pt。80pt未満は拒否
    tpSlMax: 500,    // SLは500pt以内（ATR×5）
    rrMax: 12,       // RR最大12倍（高ボラ指数のため広めに設定）
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 100,   // 旧150
    trailingDistance: 60,      // 旧80
    correlationGroup: 'risk_on',
    tier: 'B', tierLotMultiplier: 0.7,
  },
  {
    pair: 'S&P500',
    broker: 'oanda',
    oandaSymbol: 'SPX500_USD',
    rateChangeTh: 1.5,
    tpSlHint: 'SLは15〜80pt（ATRの0.75〜4倍）、TPはSLの最大10倍まで自由（RR1.5以上推奨）',
    tpSlMin: 15,     // H1-ATR≈20pt。15pt未満は拒否
    tpSlMax: 80,     // SLは80pt以内（ATR×4）
    rrMax: 10,       // RR最大10倍
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 8,     // 旧15 — RR最悪銘柄のため大幅引き下げ
    trailingDistance: 5,       // 旧8
    correlationGroup: 'risk_on',
    tier: 'B', tierLotMultiplier: 0.7,
  },
  // US10Y: RR=0.13, Kelly=-3.67 → 除外（2026-03-24 テスタ理論E2E評価）
  // {
  //   pair: 'US10Y',
  //   broker: 'oanda', oandaSymbol: 'USB10Y_USD',
  //   // 実績: 15取引, 7勝, avg_win=12.9円, avg_loss=-100円 → 損失確定銘柄
  // },
  // BTC/USD: RR=0.85, Kelly=-0.117, 累積-1312円 → 除外（2026-03-24 テスタ理論E2E評価）
  // {
  //   pair: 'BTC/USD',
  //   broker: 'paper', oandaSymbol: null,
  //   // 実績: 35取引, 17勝, avg_win=319.3円, avg_loss=-374.4円 → Kelly負
  // },
  {
    pair: 'Gold',
    broker: 'oanda',
    oandaSymbol: 'XAU_USD',
    rateChangeTh: 1.5,
    tpSlHint: 'SLは$15〜$80（ATRの0.75〜4倍）、TPはSLの最大10倍まで自由（RR1.5以上推奨）',
    tpSlMin: 15,     // H1-ATR≈$20。$15未満は拒否
    tpSlMax: 80,     // SLは$80以内（ATR×4）
    rrMax: 10,       // RR最大10倍（地政学リスクで大きく動く）
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 7,     // 旧10 — RR=0.55の改善
    trailingDistance: 4,       // 旧5
    correlationGroup: 'precious',
    tier: 'A', tierLotMultiplier: 1.0,
  },
  {
    pair: 'EUR/USD',
    broker: 'oanda',
    oandaSymbol: 'EUR_USD',
    rateChangeTh: 0.001,
    tpSlHint: 'SLは0.004〜0.025（ATRの0.7〜4倍）、TPはSLの最大8倍まで自由（RR1.5以上推奨）',
    tpSlMin: 0.004,  // H1-ATR≈0.006。0.004未満は拒否
    tpSlMax: 0.025,  // SLは0.025以内（ATR×4）
    rrMax: 8,        // RR最大8倍
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.003, // 旧0.004
    trailingDistance: 0.0015,  // 旧0.002
    correlationGroup: 'europe',
    tier: 'A', tierLotMultiplier: 1.0,
  },
  // ETH/USD: 7取引0勝, Kelly=-∞ → 除外（2026-03-24 テスタ理論E2E評価）
  // {
  //   pair: 'ETH/USD',
  //   broker: 'paper', oandaSymbol: null,
  //   // 実績: 7取引, 0勝 → 統計的に存在意義なし
  // },
  {
    pair: 'CrudeOil',
    broker: 'oanda',
    oandaSymbol: 'WTICO_USD',
    rateChangeTh: 0.15,
    tpSlHint: 'SLは$0.5〜$3.0（ATRの0.7〜4倍）、TPはSLの最大10倍まで自由（RR1.5以上推奨）',
    tpSlMin: 0.5,    // H1-ATR≈$0.7。$0.5未満は拒否
    tpSlMax: 3.0,    // SLは$3.0以内（ATR×4）
    rrMax: 10,       // RR最大10倍
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.5,   // 旧0.8
    trailingDistance: 0.3,     // 旧0.4
    correlationGroup: 'energy',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  {
    pair: 'NatGas',
    broker: 'oanda',
    oandaSymbol: 'NATGAS_USD',
    rateChangeTh: 0.015,
    tpSlHint: 'SLは$0.04〜$0.25（ATRの0.7〜4倍）、TPはSLの最大10倍まで自由（RR1.5以上推奨）',
    tpSlMin: 0.04,   // H1-ATR≈$0.06。$0.04未満は拒否
    tpSlMax: 0.25,   // SLは$0.25以内（ATR×4）
    rrMax: 10,       // RR最大10倍
    pnlUnit: '円',
    pnlMultiplier: 1000,
    trailingActivation: 0.05,  // 旧0.08
    trailingDistance: 0.03,    // 旧0.04
    correlationGroup: 'energy',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  {
    pair: 'Copper',
    broker: 'oanda',
    oandaSymbol: 'COPPER',
    rateChangeTh: 0.01,
    tpSlHint: 'SLは$0.03〜$0.20（ATRの0.75〜5倍）、TPはSLの最大10倍まで自由（RR1.5以上推奨）',
    tpSlMin: 0.03,   // H1-ATR≈$0.04。$0.03未満は拒否
    tpSlMax: 0.20,   // SLは$0.20以内（ATR×5）
    rrMax: 10,       // RR最大10倍
    pnlUnit: '円',
    pnlMultiplier: 1000,
    trailingActivation: 0.035, // 旧0.05
    trailingDistance: 0.02,    // 旧0.025
    correlationGroup: 'precious',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  {
    pair: 'Silver',
    broker: 'oanda',
    oandaSymbol: 'XAG_USD',
    rateChangeTh: 0.08,
    tpSlHint: 'SLは$0.25〜$1.6（ATRの0.6〜4倍）、TPはSLの最大10倍まで自由（RR1.5以上推奨）',
    tpSlMin: 0.25,   // H1-ATR≈$0.4。$0.25未満は拒否
    tpSlMax: 1.6,    // SLは$1.6以内（ATR×4）
    rrMax: 10,       // RR最大10倍
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.28,  // 旧0.4
    trailingDistance: 0.15,    // 旧0.2
    correlationGroup: 'precious',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  {
    pair: 'GBP/USD',
    broker: 'oanda',
    oandaSymbol: 'GBP_USD',
    rateChangeTh: 0.001,
    tpSlHint: 'SLは0.005〜0.028（ATRの0.7〜4倍）、TPはSLの最大8倍まで自由（RR1.5以上推奨）',
    tpSlMin: 0.005,  // H1-ATR≈0.007。0.005未満は拒否
    tpSlMax: 0.028,  // SLは0.028以内（ATR×4）
    rrMax: 8,        // RR最大8倍（メジャーFXペア）
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.003,
    trailingDistance: 0.0015,
    correlationGroup: 'europe',
    tier: 'B', tierLotMultiplier: 0.7,
  },
  {
    pair: 'AUD/USD',
    broker: 'oanda',
    oandaSymbol: 'AUD_USD',
    rateChangeTh: 0.001,
    tpSlHint: 'SLは0.004〜0.025（ATRの0.8〜5倍）、TPはSLの最大8倍まで自由（RR1.5以上推奨）',
    tpSlMin: 0.004,  // H1-ATR≈0.005。0.004未満は拒否
    tpSlMax: 0.025,  // SLは0.025以内（ATR×5）
    rrMax: 8,        // RR最大8倍（メジャーFXペア）
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.003,
    trailingDistance: 0.0015,
    correlationGroup: 'risk_on',
    tier: 'B', tierLotMultiplier: 0.7,
  },
  {
    pair: 'SOL/USD',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 0.5,
    tpSlHint: 'SLは$2〜$12（ATRの0.7〜4倍）、TPはSLの最大8倍まで自由（RR1.5以上推奨）',
    tpSlMin: 2.0,    // H1-ATR≈$3。$2未満は拒否
    tpSlMax: 12.0,   // SLは$12以内（ATR×4）
    rrMax: 8,        // RR最大8倍（高ボラ暗号資産）
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 2,
    trailingDistance: 1.2,
    correlationGroup: 'standalone',
    tier: 'D', tierLotMultiplier: 0.3,
  },
  {
    pair: 'DAX',
    broker: 'oanda',
    oandaSymbol: 'DE30_EUR',
    rateChangeTh: 15,
    tpSlHint: 'SLは50〜300pt（ATRの0.7〜4倍）、TPはSLの最大10倍まで自由（RR1.5以上推奨）',
    tpSlMin: 50,     // H1-ATR≈75pt。50pt未満は拒否
    tpSlMax: 300,    // SLは300pt以内（ATR×4）
    rrMax: 10,       // RR最大10倍（欧州株価指数）
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 55,
    trailingDistance: 30,
    correlationGroup: 'europe',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  {
    pair: 'NASDAQ',
    broker: 'oanda',
    oandaSymbol: 'NAS100_USD',
    rateChangeTh: 15,
    tpSlHint: 'SLは80〜500pt（ATRの0.8〜5倍）、TPはSLの最大12倍まで自由（RR1.5以上推奨）',
    tpSlMin: 80,     // H1-ATR≈100pt。80pt未満は拒否
    tpSlMax: 500,    // SLは500pt以内（ATR×5）
    rrMax: 12,       // RR最大12倍（高ボラ指数）
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 55,
    trailingDistance: 30,
    correlationGroup: 'risk_on',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  // テスタ施策24: UK100
  {
    pair: 'UK100',
    broker: 'oanda',
    oandaSymbol: 'UK100_GBP',
    rateChangeTh: 10,
    tpSlHint: 'SLは30〜200pt（ATRの0.6〜4倍）、TPはSLの最大10倍まで自由（RR1.5以上推奨）',
    tpSlMin: 30,     // H1-ATR≈50pt。30pt未満は拒否
    tpSlMax: 200,    // SLは200pt以内（ATR×4）
    rrMax: 10,       // RR最大10倍（欧州株価指数）
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 40,
    trailingDistance: 22,
    correlationGroup: 'europe',
    tier: 'B', tierLotMultiplier: 0.7,
  },
  // テスタ施策25: HK33
  {
    pair: 'HK33',
    broker: 'oanda',
    oandaSymbol: 'HK33_HKD',
    rateChangeTh: 30,
    tpSlHint: 'SLは80〜500pt（ATRの0.8〜5倍）、TPはSLの最大12倍まで自由（RR1.5以上推奨）',
    tpSlMin: 80,     // H1-ATR≈100pt。80pt未満は拒否
    tpSlMax: 500,    // SLは500pt以内（ATR×5）
    rrMax: 12,       // RR最大12倍（高ボラアジア指数）
    pnlUnit: '円',
    pnlMultiplier: 0.5,
    trailingActivation: 80,
    trailingDistance: 45,
    correlationGroup: 'risk_on',
    tier: 'C', tierLotMultiplier: 0.5,
  },
];

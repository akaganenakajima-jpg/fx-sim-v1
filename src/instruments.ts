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
    tpSlHint: 'SLは0.2〜1.2円（entry ATRの0.7〜4倍）、TPはSLの最大8倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 0.2,    // H1-ATR≈0.3円。0.2円未満は拒否
    tpSlMax: 1.2,    // SLは1.2円以内（ATR×4）
    rrMax: 8,        // RR最大8倍（TP上限 = SL × 8）
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.45,  // ATR(0.3)×1.5=0.45円。RR≥1.0保証のため引き上げ
    trailingDistance: 0.22,    // ATR×0.75=0.22円。breakeven保証（activation-distance>0）
    correlationGroup: 'usd_strong',
    tier: 'A', tierLotMultiplier: 1.0,
  },
  {
    pair: 'Nikkei225',
    broker: 'oanda',
    oandaSymbol: 'JP225_USD',
    rateChangeTh: 15,
    tpSlHint: 'SLは80〜500pt（ATRの0.8〜5倍）、TPはSLの最大12倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 80,     // H1-ATR≈100pt。80pt未満は拒否
    tpSlMax: 500,    // SLは500pt以内（ATR×5）
    rrMax: 12,       // RR最大12倍（高ボラ指数のため広めに設定）
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 150,   // ATR(100)×1.5=150pt。実績avg_rr=0.61（最優秀）→ Tier A昇格
    trailingDistance: 75,      // ATR×0.75=75pt。breakeven保証
    correlationGroup: 'risk_on',
    tier: 'A', tierLotMultiplier: 1.0,  // 実績: avg_rr=0.61・total_pnl=+4,864円 → Tier A昇格
  },
  {
    pair: 'S&P500',
    broker: 'oanda',
    oandaSymbol: 'SPX500_USD',
    rateChangeTh: 1.5,
    tpSlHint: 'SLは15〜80pt（ATRの0.75〜4倍）、TPはSLの最大10倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 15,     // H1-ATR≈20pt。15pt未満は拒否
    tpSlMax: 80,     // SLは80pt以内（ATR×4）
    rrMax: 10,       // RR最大10倍
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 30,    // ATR(20)×1.5=30pt。旧8はtpSlMin=15より低くバグ→修正
    trailingDistance: 15,      // ATR×0.75=15pt。breakeven保証
    correlationGroup: 'risk_on',
    tier: 'A', tierLotMultiplier: 1.0,  // 実績: total_pnl=+1,395円(38取引) → Tier A昇格
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
    tpSlHint: 'SLは$15〜$80（ATRの0.75〜4倍）、TPはSLの最大10倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 15,     // H1-ATR≈$20。$15未満は拒否
    tpSlMax: 80,     // SLは$80以内（ATR×4）
    rrMax: 10,       // RR最大10倍（地政学リスクで大きく動く）
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 30,    // ATR(20)×1.5=$30。旧7はtpSlMin=15の半分以下で致命的バグ→修正
    trailingDistance: 15,      // ATR×0.75=$15。breakeven保証
    correlationGroup: 'precious',
    tier: 'B', tierLotMultiplier: 0.7,  // 実績: avg_rr=-1.21・total_pnl=-2,912円(172取引) → Tier Bに降格
  },
  {
    pair: 'EUR/USD',
    broker: 'oanda',
    oandaSymbol: 'EUR_USD',
    rateChangeTh: 0.001,
    tpSlHint: 'SLは0.004〜0.025（ATRの0.7〜4倍）、TPはSLの最大8倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 0.004,  // H1-ATR≈0.006。0.004未満は拒否
    tpSlMax: 0.025,  // SLは0.025以内（ATR×4）
    rrMax: 8,        // RR最大8倍
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.009, // ATR(0.006)×1.5=0.009。旧0.003はtpSlMin=0.004より低くバグ→修正
    trailingDistance: 0.0045,  // ATR×0.75=0.0045。breakeven保証
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
    tpSlHint: 'SLは$0.5〜$3.0（ATRの0.7〜4倍）、TPはSLの最大10倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 0.5,    // H1-ATR≈$0.7。$0.5未満は拒否
    tpSlMax: 3.0,    // SLは$3.0以内（ATR×4）
    rrMax: 10,       // RR最大10倍
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 1.0,   // ATR(0.7)×1.5≈1.0。RR≥1.0保証のため引き上げ
    trailingDistance: 0.5,     // ATR×0.75≈0.5。breakeven保証
    correlationGroup: 'energy',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  {
    pair: 'NatGas',
    broker: 'oanda',
    oandaSymbol: 'NATGAS_USD',
    rateChangeTh: 0.015,
    tpSlHint: 'SLは$0.04〜$0.25（ATRの0.7〜4倍）、TPはSLの最大10倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 0.04,   // H1-ATR≈$0.06。$0.04未満は拒否
    tpSlMax: 0.25,   // SLは$0.25以内（ATR×4）
    rrMax: 10,       // RR最大10倍
    pnlUnit: '円',
    pnlMultiplier: 1000,
    trailingActivation: 0.09,  // ATR(0.06)×1.5=0.09。RR≥1.0保証のため引き上げ
    trailingDistance: 0.045,   // ATR×0.75=0.045。breakeven保証
    correlationGroup: 'energy',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  {
    pair: 'Copper',
    broker: 'oanda',
    oandaSymbol: 'COPPER',
    rateChangeTh: 0.01,
    tpSlHint: 'SLは$0.03〜$0.20（ATRの0.75〜5倍）、TPはSLの最大10倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 0.03,   // H1-ATR≈$0.04。$0.03未満は拒否
    tpSlMax: 0.20,   // SLは$0.20以内（ATR×5）
    rrMax: 10,       // RR最大10倍
    pnlUnit: '円',
    pnlMultiplier: 1000,
    trailingActivation: 0.06,  // ATR(0.04)×1.5=0.06。RR≥1.0保証のため引き上げ
    trailingDistance: 0.03,    // ATR×0.75=0.03。breakeven保証
    correlationGroup: 'precious',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  {
    pair: 'Silver',
    broker: 'oanda',
    oandaSymbol: 'XAG_USD',
    rateChangeTh: 0.08,
    tpSlHint: 'SLは$0.25〜$1.6（ATRの0.6〜4倍）、TPはSLの最大10倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 0.25,   // H1-ATR≈$0.4。$0.25未満は拒否
    tpSlMax: 1.6,    // SLは$1.6以内（ATR×4）
    rrMax: 10,       // RR最大10倍
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.60,  // ATR(0.4)×1.5=0.60。RR≥1.0保証のため引き上げ
    trailingDistance: 0.30,    // ATR×0.75=0.30。breakeven保証
    correlationGroup: 'precious',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  {
    pair: 'GBP/USD',
    broker: 'oanda',
    oandaSymbol: 'GBP_USD',
    rateChangeTh: 0.001,
    tpSlHint: 'SLは0.005〜0.028（ATRの0.7〜4倍）、TPはSLの最大8倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 0.005,  // H1-ATR≈0.007。0.005未満は拒否
    tpSlMax: 0.028,  // SLは0.028以内（ATR×4）
    rrMax: 8,        // RR最大8倍（メジャーFXペア）
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.010, // ATR(0.007)×1.5≈0.010。旧0.003はtpSlMin=0.005より低くバグ→修正
    trailingDistance: 0.005,   // ATR×0.75≈0.005。breakeven保証
    correlationGroup: 'europe',
    tier: 'C', tierLotMultiplier: 0.5,  // 実績: total_pnl=-64円(10取引) → Tier Cに降格
  },
  {
    pair: 'AUD/USD',
    broker: 'oanda',
    oandaSymbol: 'AUD_USD',
    rateChangeTh: 0.001,
    tpSlHint: 'SLは0.004〜0.025（ATRの0.8〜5倍）、TPはSLの最大8倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 0.004,  // H1-ATR≈0.005。0.004未満は拒否
    tpSlMax: 0.025,  // SLは0.025以内（ATR×5）
    rrMax: 8,        // RR最大8倍（メジャーFXペア）
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.0075, // ATR(0.005)×1.5=0.0075。旧0.003はtpSlMin=0.004より低くバグ→修正
    trailingDistance: 0.0038,   // ATR×0.75=0.0038。breakeven保証
    correlationGroup: 'risk_on',
    tier: 'C', tierLotMultiplier: 0.5,  // 実績: total_pnl=-39円(8取引) → Tier Cに降格
  },
  {
    pair: 'SOL/USD',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 0.5,
    tpSlHint: 'SLは$2〜$12（ATRの0.7〜4倍）、TPはSLの最大8倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 2.0,    // H1-ATR≈$3。$2未満は拒否
    tpSlMax: 12.0,   // SLは$12以内（ATR×4）
    rrMax: 8,        // RR最大8倍（高ボラ暗号資産）
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 4.5,   // ATR(3)×1.5=4.5。RR≥1.0保証のため引き上げ
    trailingDistance: 2.2,     // ATR×0.75=2.2。breakeven保証
    correlationGroup: 'standalone',
    tier: 'D', tierLotMultiplier: 0.3,
  },
  {
    pair: 'DAX',
    broker: 'oanda',
    oandaSymbol: 'DE30_EUR',
    rateChangeTh: 15,
    tpSlHint: 'SLは50〜300pt（ATRの0.7〜4倍）、TPはSLの最大10倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 50,     // H1-ATR≈75pt。50pt未満は拒否
    tpSlMax: 300,    // SLは300pt以内（ATR×4）
    rrMax: 10,       // RR最大10倍（欧州株価指数）
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 110,   // ATR(75)×1.5≈110pt。RR≥1.0保証のため引き上げ
    trailingDistance: 55,      // ATR×0.75≈55pt。breakeven保証
    correlationGroup: 'europe',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  {
    pair: 'NASDAQ',
    broker: 'oanda',
    oandaSymbol: 'NAS100_USD',
    rateChangeTh: 15,
    tpSlHint: 'SLは80〜500pt（ATRの0.8〜5倍）、TPはSLの最大12倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 80,     // H1-ATR≈100pt。80pt未満は拒否
    tpSlMax: 500,    // SLは500pt以内（ATR×5）
    rrMax: 12,       // RR最大12倍（高ボラ指数）
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 150,   // ATR(100)×1.5=150pt。旧55はtpSlMin=80より低くバグ→修正
    trailingDistance: 75,      // ATR×0.75=75pt。breakeven保証
    correlationGroup: 'risk_on',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  // テスタ施策24: UK100
  {
    pair: 'UK100',
    broker: 'oanda',
    oandaSymbol: 'UK100_GBP',
    rateChangeTh: 10,
    tpSlHint: 'SLは30〜200pt（ATRの0.6〜4倍）、TPはSLの最大10倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 30,     // H1-ATR≈50pt。30pt未満は拒否
    tpSlMax: 200,    // SLは200pt以内（ATR×4）
    rrMax: 10,       // RR最大10倍（欧州株価指数）
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 75,    // ATR(50)×1.5=75pt。RR≥1.0保証のため引き上げ
    trailingDistance: 37,      // ATR×0.75≈37pt。breakeven保証
    correlationGroup: 'europe',
    tier: 'B', tierLotMultiplier: 0.7,
  },
  // テスタ施策25: HK33
  {
    pair: 'HK33',
    broker: 'oanda',
    oandaSymbol: 'HK33_HKD',
    rateChangeTh: 30,
    tpSlHint: 'SLは80〜500pt（ATRの0.8〜5倍）、TPはSLの最大12倍まで自由（RR3.0以上を積極的に狙う）',
    tpSlMin: 80,     // H1-ATR≈100pt。80pt未満は拒否
    tpSlMax: 500,    // SLは500pt以内（ATR×5）
    rrMax: 12,       // RR最大12倍（高ボラアジア指数）
    pnlUnit: '円',
    pnlMultiplier: 0.5,
    trailingActivation: 150,   // ATR(100)×1.5=150pt。RR≥1.0保証のため引き上げ
    trailingDistance: 75,      // ATR×0.75=75pt。breakeven保証
    correlationGroup: 'risk_on',
    tier: 'C', tierLotMultiplier: 0.5,
  },
];

// 取引対象銘柄の定義

/** 相関グループ（テスタ施策4） */
export type CorrelationGroup =
  | 'usd_strong' | 'risk_on' | 'precious'
  | 'energy' | 'europe' | 'standalone'
  | 'jpy_cross'
  | 'jp_semi' | 'jp_shipping' | 'jp_conglomerate' | 'jp_value'
  | 'us_semi' | 'us_mega_tech' | 'us_high_beta';

/** アセットクラス */
export type AssetClass = 'forex' | 'cfd' | 'stock';

export interface InstrumentConfig {
  pair: string;
  /** ブローカー: 'oanda' = OANDA API経由、'paper' = D1記録のみ、'alpaca' = Alpaca API */
  broker: 'oanda' | 'paper' | 'alpaca';
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
  /** アセットクラス（株式の場合に使用） */
  assetClass?: AssetClass;
  /** Yahoo Finance / Alpaca シンボル（株式用。例: '6920.T', 'NVDA'） */
  stockSymbol?: string;
  /** 最小取引単位（日本株=100、米国株=1） */
  minUnit?: number;
  /** 取引可能時間帯 JST（日本株用。例: { open: 9, close: 15 }） */
  tradingHoursJST?: { open: number; close: number };
  /** 取引可能時間帯 ET（米国株用。例: { open: 9.5, close: 16 }） */
  tradingHoursET?: { open: number; close: number };
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
    tier: 'D', tierLotMultiplier: 0.1,  // 実績: avg_rr=0.104・tp率4.4%(8/182) → Tier D降格（方向性壊滅）
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
    tier: 'D', tierLotMultiplier: 0.1,  // 実績: avg_rr=0.069・tp率11%(5/45) → Tier D降格
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
    tier: 'D', tierLotMultiplier: 0.1,  // 実績: avg_rr=0.106・tp率0%(0/12) → Tier D降格
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
    tier: 'D', tierLotMultiplier: 0.1,  // 実績: avg_rr=0.202・tp率6%(6/99) → Tier D降格
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
    tier: 'D', tierLotMultiplier: 0.1,  // 実績: avg_rr=0.074・tp率9%(1/11) → Tier D降格
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
    tier: 'D', tierLotMultiplier: 0.1,  // 実績: avg_rr=-0.313・total_pnl=-39円 → Tier D降格（マイナスRR）
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
    tier: 'D', tierLotMultiplier: 0.1,  // 実績: avg_rr=-0.362・tp率30%(3/10) → Tier D降格（マイナスRR）
  },

  // ─── 円クロス（Phase 1: OANDA即実装） ─────────────
  {
    pair: 'EUR/JPY',
    broker: 'oanda',
    oandaSymbol: 'EUR_JPY',
    rateChangeTh: 0.02,
    tpSlHint: 'SLは0.25〜1.5円（ATRの0.7〜4倍）、TPはSLの最大8倍まで自由（RR2.0以上推奨）',
    tpSlMin: 0.25,
    tpSlMax: 1.5,
    rrMax: 8,
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.25,
    trailingDistance: 0.15,
    correlationGroup: 'jpy_cross',
    tier: 'B', tierLotMultiplier: 0.7,
  },
  {
    pair: 'GBP/JPY',
    broker: 'oanda',
    oandaSymbol: 'GBP_JPY',
    rateChangeTh: 0.03,
    tpSlHint: 'SLは0.3〜2.0円（ATRの0.7〜4倍）、TPはSLの最大10倍まで自由（RR2.0以上推奨）',
    tpSlMin: 0.3,
    tpSlMax: 2.0,
    rrMax: 10,
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.3,
    trailingDistance: 0.18,
    correlationGroup: 'jpy_cross',
    tier: 'B', tierLotMultiplier: 0.7,
  },
  {
    pair: 'AUD/JPY',
    broker: 'oanda',
    oandaSymbol: 'AUD_JPY',
    rateChangeTh: 0.015,
    tpSlHint: 'SLは0.2〜1.2円（ATRの0.7〜4倍）、TPはSLの最大8倍まで自由（RR2.0以上推奨）',
    tpSlMin: 0.2,
    tpSlMax: 1.2,
    rrMax: 8,
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.2,
    trailingDistance: 0.12,
    correlationGroup: 'jpy_cross',
    tier: 'C', tierLotMultiplier: 0.5,
  },

  // ─── 日本個別株（Phase 2a: paper-only） ───────────

  // A群: テスタ実績銘柄
  {
    pair: '川崎汽船',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 30,
    tpSlHint: 'SLは50〜200円（ATRの0.5〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 50,
    tpSlMax: 200,
    rrMax: 5,
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 60,
    trailingDistance: 35,
    correlationGroup: 'jp_shipping',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: '9107.T',
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  },
  {
    pair: '日本郵船',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 50,
    tpSlHint: 'SLは80〜300円（ATRの0.5〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 80,
    tpSlMax: 300,
    rrMax: 5,
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 100,
    trailingDistance: 60,
    correlationGroup: 'jp_shipping',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: '9101.T',
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  },
  {
    pair: 'ソフトバンクG',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 80,
    tpSlHint: 'SLは100〜500円（ATRの0.5〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 100,
    tpSlMax: 500,
    rrMax: 5,
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 150,
    trailingDistance: 90,
    correlationGroup: 'jp_conglomerate',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: '9984.T',
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  },

  // B群: テスタ手法適合銘柄（高ATR×高売買代金）
  {
    pair: 'レーザーテック',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 100,
    tpSlHint: 'SLは200〜800円（ATRの0.4〜1.5倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 200,
    tpSlMax: 800,
    rrMax: 5,
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 250,
    trailingDistance: 150,
    correlationGroup: 'jp_semi',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: '6920.T',
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  },
  {
    pair: '東京エレクトロン',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 120,
    tpSlHint: 'SLは250〜1000円（ATRの0.4〜1.5倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 250,
    tpSlMax: 1000,
    rrMax: 5,
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 300,
    trailingDistance: 180,
    correlationGroup: 'jp_semi',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: '8035.T',
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  },
  {
    pair: 'ディスコ',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 200,
    tpSlHint: 'SLは500〜2000円（ATRの0.4〜1.5倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 500,
    tpSlMax: 2000,
    rrMax: 5,
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 600,
    trailingDistance: 360,
    correlationGroup: 'jp_semi',
    tier: 'D', tierLotMultiplier: 0.3,
    assetClass: 'stock',
    stockSymbol: '6146.T',
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  },
  {
    pair: 'アドバンテスト',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 80,
    tpSlHint: 'SLは100〜500円（ATRの0.5〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 100,
    tpSlMax: 500,
    rrMax: 5,
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 150,
    trailingDistance: 90,
    correlationGroup: 'jp_semi',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: '6857.T',
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  },
  {
    pair: 'ファーストリテイリング',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 200,
    tpSlHint: 'SLは400〜1500円（ATRの0.4〜1.5倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 400,
    tpSlMax: 1500,
    rrMax: 5,
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 500,
    trailingDistance: 300,
    correlationGroup: 'jp_conglomerate',
    tier: 'D', tierLotMultiplier: 0.3,
    assetClass: 'stock',
    stockSymbol: '9983.T',
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  },

  // C群: テスタ配当銘柄のうちデイトレも可能な銘柄
  {
    pair: '日本製鉄',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 30,
    tpSlHint: 'SLは50〜200円（ATRの0.5〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 50,
    tpSlMax: 200,
    rrMax: 5,
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 60,
    trailingDistance: 35,
    correlationGroup: 'jp_value',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: '5401.T',
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  },
  {
    pair: '三菱UFJ',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 15,
    tpSlHint: 'SLは20〜80円（ATRの0.5〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 20,
    tpSlMax: 80,
    rrMax: 5,
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 25,
    trailingDistance: 15,
    correlationGroup: 'jp_value',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: '8306.T',
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  },

  // ─── 米国個別株（Phase 2a: paper-only） ───────────

  // D群: テスタ手法最適合（高ATR×売買代金世界トップ）
  {
    pair: 'NVDA',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 1.0,
    tpSlHint: 'SLは$2〜$15（ATRの0.4〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 2.0,
    tpSlMax: 15.0,
    rrMax: 5,
    pnlUnit: '$',
    pnlMultiplier: 1,
    trailingActivation: 3.0,
    trailingDistance: 1.8,
    correlationGroup: 'us_semi',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: 'NVDA',
    minUnit: 1,
    tradingHoursET: { open: 9.5, close: 16 },
  },
  {
    pair: 'TSLA',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 1.5,
    tpSlHint: 'SLは$3〜$20（ATRの0.4〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 3.0,
    tpSlMax: 20.0,
    rrMax: 5,
    pnlUnit: '$',
    pnlMultiplier: 1,
    trailingActivation: 4.0,
    trailingDistance: 2.5,
    correlationGroup: 'us_high_beta',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: 'TSLA',
    minUnit: 1,
    tradingHoursET: { open: 9.5, close: 16 },
  },
  {
    pair: 'AAPL',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 0.5,
    tpSlHint: 'SLは$1〜$8（ATRの0.3〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 1.0,
    tpSlMax: 8.0,
    rrMax: 5,
    pnlUnit: '$',
    pnlMultiplier: 1,
    trailingActivation: 1.5,
    trailingDistance: 0.9,
    correlationGroup: 'us_mega_tech',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: 'AAPL',
    minUnit: 1,
    tradingHoursET: { open: 9.5, close: 16 },
  },
  {
    pair: 'AMZN',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 1.0,
    tpSlHint: 'SLは$2〜$15（ATRの0.4〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 2.0,
    tpSlMax: 15.0,
    rrMax: 5,
    pnlUnit: '$',
    pnlMultiplier: 1,
    trailingActivation: 3.0,
    trailingDistance: 1.8,
    correlationGroup: 'us_mega_tech',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: 'AMZN',
    minUnit: 1,
    tradingHoursET: { open: 9.5, close: 16 },
  },
  {
    pair: 'AMD',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 1.0,
    tpSlHint: 'SLは$2〜$12（ATRの0.4〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 2.0,
    tpSlMax: 12.0,
    rrMax: 5,
    pnlUnit: '$',
    pnlMultiplier: 1,
    trailingActivation: 2.5,
    trailingDistance: 1.5,
    correlationGroup: 'us_semi',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: 'AMD',
    minUnit: 1,
    tradingHoursET: { open: 9.5, close: 16 },
  },

  // E群: セクター分散 + 高出来高
  {
    pair: 'META',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 2.0,
    tpSlHint: 'SLは$5〜$30（ATRの0.3〜1.5倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 5.0,
    tpSlMax: 30.0,
    rrMax: 5,
    pnlUnit: '$',
    pnlMultiplier: 1,
    trailingActivation: 7.0,
    trailingDistance: 4.0,
    correlationGroup: 'us_high_beta',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: 'META',
    minUnit: 1,
    tradingHoursET: { open: 9.5, close: 16 },
  },
  {
    pair: 'MSFT',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 1.0,
    tpSlHint: 'SLは$2〜$15（ATRの0.4〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 2.0,
    tpSlMax: 15.0,
    rrMax: 5,
    pnlUnit: '$',
    pnlMultiplier: 1,
    trailingActivation: 3.0,
    trailingDistance: 1.8,
    correlationGroup: 'us_mega_tech',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: 'MSFT',
    minUnit: 1,
    tradingHoursET: { open: 9.5, close: 16 },
  },
  {
    pair: 'GOOGL',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 0.8,
    tpSlHint: 'SLは$1.5〜$10（ATRの0.4〜2倍）、TPはSLの最大5倍まで（RR2.0以上推奨）',
    tpSlMin: 1.5,
    tpSlMax: 10.0,
    rrMax: 5,
    pnlUnit: '$',
    pnlMultiplier: 1,
    trailingActivation: 2.0,
    trailingDistance: 1.2,
    correlationGroup: 'us_mega_tech',
    tier: 'C', tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol: 'GOOGL',
    minUnit: 1,
    tradingHoursET: { open: 9.5, close: 16 },
  },
];

// ─── 自動ブートストラップ用デフォルトパラメータ ───────────────────
// instruments.ts に銘柄を追加するだけで instrument_params が自動初期化される
// assetClass に応じた保守的なデフォルト値を返す

export function getDefaultParams(inst: InstrumentConfig): Record<string, number | string> {
  const isStock = inst.assetClass === 'stock';
  return {
    pair:                     inst.pair,
    rsi_period:               14,
    rsi_oversold:             isStock ? 30 : 35,
    rsi_overbought:           isStock ? 70 : 65,
    adx_period:               14,
    adx_min:                  isStock ? 28 : 25,
    atr_period:               14,
    atr_tp_multiplier:        3.0,
    atr_sl_multiplier:        1.5,
    vix_max:                  isStock ? 40 : 35,
    require_trend_align:      0,
    regime_allow:             'trending,ranging',
    review_trade_count:       30,
    trades_since_review:      0,
    param_version:            1,
    reviewed_by:              'AUTO_BOOTSTRAP',
    updated_at:               new Date().toISOString(),
    vix_tp_scale:             1,
    vix_sl_scale:             1,
    strategy_primary:         'mean_reversion',
    min_signal_strength:      0,
    macro_sl_scale:           1,
    w_rsi:                    0.35,
    w_er:                     0.25,
    w_mtf:                    0.2,
    w_sr:                     0.1,
    w_pa:                     0.1,
    entry_score_min:          isStock ? 0.3 : 0.25,
    min_rr_ratio:             2.0,
    max_hold_minutes:         isStock ? 360 : 480,
    cooldown_after_sl:        10,
    consecutive_loss_shrink:  3,
    daily_max_entries:        isStock ? 3 : 5,
    trailing_activation_atr:  1.5,
    trailing_distance_atr:    1.0,
    tp1_ratio:                0.5,
    session_start_utc:        0,
    session_end_utc:           24,
    review_min_trades:        50,
    bb_period:                20,
    bb_squeeze_threshold:     0.4,
    w_bb:                     0.1,
    w_div:                    0.05,
    divergence_lookback:      14,
    min_confirm_signals:      2,
    er_upper_limit:           0.85,
  };
}

/** Yahoo Finance シンボルを返す（FXはXX=X形式、株式は.T/ティッカーそのまま） */
export function getYahooSymbol(inst: InstrumentConfig): string | null {
  if (inst.stockSymbol) return inst.stockSymbol;
  // FX/CFD: pair名 → Yahoo Financeシンボルへの変換マップ
  const map: Record<string, string> = {
    'USD/JPY': 'USDJPY=X', 'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X',
    'AUD/USD': 'AUDUSD=X', 'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
    'AUD/JPY': 'AUDJPY=X', 'Gold': 'GC=F', 'Silver': 'SI=F',
    'CrudeOil': 'CL=F', 'NatGas': 'NG=F', 'Copper': 'HG=F',
    'Nikkei225': '^N225', 'S&P500': '^GSPC', 'DAX': '^GDAXI',
    'NASDAQ': '^IXIC', 'UK100': '^FTSE', 'HK33': '^HSI',
    'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD', 'SOL/USD': 'SOL-USD',
  };
  return map[inst.pair] ?? null;
}

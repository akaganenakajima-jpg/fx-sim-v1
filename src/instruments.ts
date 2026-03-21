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
  /** TP/SL距離の最大値（レート単位）— この値超過はサニティ拒否 */
  tpSlMax: number;
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
    tpSlHint: '現在レートから±0.2〜1.2円（SLは0.2円以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 0.2,    // H1-ATR≈0.3円。0.2円未満は拒否
    tpSlMax: 1.2,    // 1.2円超過は拒否
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
    tpSlHint: '現在値から±80〜500ポイント（SLは80pt以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 80,     // H1-ATR≈100pt。80pt未満は拒否
    tpSlMax: 500,    // 500pt超過は拒否
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
    tpSlHint: '現在値から±15〜80ポイント（SLは15pt以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 15,     // H1-ATR≈20pt。15pt未満は拒否
    tpSlMax: 80,     // 80pt超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 8,     // 旧15 — RR最悪銘柄のため大幅引き下げ
    trailingDistance: 5,       // 旧8
    correlationGroup: 'risk_on',
    tier: 'B', tierLotMultiplier: 0.7,
  },
  {
    pair: 'US10Y',
    broker: 'oanda',
    oandaSymbol: 'USB10Y_USD',
    rateChangeTh: 0.015,
    tpSlHint: '現在利回りから±0.05〜0.4%（SLは0.05%以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 0.05,   // H1-ATR≈0.08%。据置（妥当）
    tpSlMax: 0.4,    // 0.4%超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 5000,
    trailingActivation: 0.05,  // 旧0.08
    trailingDistance: 0.03,    // 旧0.04
    correlationGroup: 'usd_strong',
    tier: 'C', tierLotMultiplier: 0.5,
  },
  {
    pair: 'BTC/USD',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 25,
    tpSlHint: '現在価格から±$400〜$2,000（SLは$400以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 400,    // H1-ATR≈$600。$400未満は拒否
    tpSlMax: 2000,   // $2,000超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 280,   // 旧400
    trailingDistance: 150,     // 旧200
    correlationGroup: 'risk_on',
    tier: 'D', tierLotMultiplier: 0.3,
  },
  {
    pair: 'Gold',
    broker: 'oanda',
    oandaSymbol: 'XAU_USD',
    rateChangeTh: 1.5,
    tpSlHint: '現在価格から±$15〜$80（SLは$15以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 15,     // H1-ATR≈$20。$15未満は拒否
    tpSlMax: 80,     // $80超過は拒否
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
    tpSlHint: '現在レートから±0.004〜0.02（SLは0.004以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 0.004,  // H1-ATR≈0.006。0.004未満は拒否
    tpSlMax: 0.02,   // 0.02超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.003, // 旧0.004
    trailingDistance: 0.0015,  // 旧0.002
    correlationGroup: 'europe',
    tier: 'A', tierLotMultiplier: 1.0,
  },
  {
    pair: 'ETH/USD',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 8,
    tpSlHint: '現在価格から±$20〜$120（SLは$20以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 20,     // H1-ATR≈$30。$20未満は拒否
    tpSlMax: 120,    // $120超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 20,    // 旧30
    trailingDistance: 12,      // 旧15
    correlationGroup: 'standalone',
    tier: 'D', tierLotMultiplier: 0.3,
  },
  {
    pair: 'CrudeOil',
    broker: 'oanda',
    oandaSymbol: 'WTICO_USD',
    rateChangeTh: 0.15,
    tpSlHint: '現在価格から±$0.5〜$3.0（SLは$0.5以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 0.5,    // H1-ATR≈$0.7。$0.5未満は拒否
    tpSlMax: 3.0,    // $3.0超過は拒否
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
    tpSlHint: '現在価格から±$0.04〜$0.3（SLは$0.04以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 0.04,   // H1-ATR≈$0.06。$0.04未満は拒否
    tpSlMax: 0.3,    // $0.3超過は拒否
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
    tpSlHint: '現在価格から±$0.03〜$0.15（SLは$0.03以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 0.03,   // H1-ATR≈$0.04。$0.03未満は拒否
    tpSlMax: 0.15,   // $0.15超過は拒否
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
    tpSlHint: '現在価格から±$0.25〜$1.5（SLは$0.25以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 0.25,   // H1-ATR≈$0.4。$0.25未満は拒否
    tpSlMax: 1.5,    // $1.5超過は拒否
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
    tpSlHint: '現在レートから±0.005〜0.02（SLは0.005以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 0.005,  // H1-ATR≈0.007。0.005未満は拒否
    tpSlMax: 0.02,   // 0.02超過は拒否
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
    tpSlHint: '現在レートから±0.004〜0.02（SLは0.004以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 0.004,  // H1-ATR≈0.005。0.004未満は拒否
    tpSlMax: 0.02,   // 0.02超過は拒否
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
    tpSlHint: '現在価格から±$2〜$12（SLは$2以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 2.0,    // H1-ATR≈$3。$2未満は拒否
    tpSlMax: 12.0,   // $12超過は拒否
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
    tpSlHint: '現在値から±50〜300ポイント（SLは50pt以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 50,     // H1-ATR≈75pt。50pt未満は拒否
    tpSlMax: 300,    // 300pt超過は拒否
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
    tpSlHint: '現在値から±80〜500ポイント（SLは80pt以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 80,     // H1-ATR≈100pt。80pt未満は拒否
    tpSlMax: 500,    // 500pt超過は拒否
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
    tpSlHint: '現在値から±30〜200ポイント（SLは30pt以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 30,     // H1-ATR≈50pt。30pt未満は拒否
    tpSlMax: 200,    // 200pt超過は拒否
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
    tpSlHint: '現在値から±80〜500ポイント（SLは80pt以上確保。TPはSLの1.5倍以上）',
    tpSlMin: 80,     // H1-ATR≈100pt。80pt未満は拒否
    tpSlMax: 500,    // 500pt超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 0.5,
    trailingActivation: 80,
    trailingDistance: 45,
    correlationGroup: 'risk_on',
    tier: 'C', tierLotMultiplier: 0.5,
  },
];

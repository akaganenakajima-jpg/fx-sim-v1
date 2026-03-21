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
}

export const INSTRUMENTS: InstrumentConfig[] = [
  {
    pair: 'USD/JPY',
    broker: 'oanda',
    oandaSymbol: 'USD_JPY',
    rateChangeTh: 0.015,
    tpSlHint: '現在レートから±0.3〜1.0円（TPはSLの1.5倍以上離すこと）',
    tpSlMin: 0.15,   // 0.15円未満は拒否
    tpSlMax: 1.5,    // 1.5円超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.2,   // 0.2円利益でトレイリング開始（旧0.3）
    trailingDistance: 0.12,    // 0.12円幅で追従（旧0.15）
    correlationGroup: 'usd_strong',
  },
  {
    pair: 'Nikkei225',
    broker: 'oanda',
    oandaSymbol: 'JP225_USD',
    rateChangeTh: 15,
    tpSlHint: '現在値から±100〜500ポイント（TPはSLの1.5倍以上離すこと）',
    tpSlMin: 50,     // 50pt未満は拒否
    tpSlMax: 700,    // 700pt超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 100,   // 旧150
    trailingDistance: 60,      // 旧80
    correlationGroup: 'risk_on',
  },
  {
    pair: 'S&P500',
    broker: 'oanda',
    oandaSymbol: 'SPX500_USD',
    rateChangeTh: 1.5,
    tpSlHint: '現在値から±10〜30ポイント（SLは狭め、TPはSLの2倍以上）',
    tpSlMin: 5,      // 5pt未満は拒否
    tpSlMax: 50,     // 50pt超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 8,     // 旧15 — RR最悪銘柄のため大幅引き下げ
    trailingDistance: 5,       // 旧8
    correlationGroup: 'risk_on',
  },
  {
    pair: 'US10Y',
    broker: 'oanda',
    oandaSymbol: 'USB10Y_USD',
    rateChangeTh: 0.015,
    tpSlHint: '現在利回りから±0.1〜0.3%（TPはSLの1.5倍以上）',
    tpSlMin: 0.05,   // 0.05%未満は拒否
    tpSlMax: 0.5,    // 0.5%超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 5000,
    trailingActivation: 0.05,  // 旧0.08
    trailingDistance: 0.03,    // 旧0.04
    correlationGroup: 'usd_strong',
  },
  {
    pair: 'BTC/USD',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 25,
    tpSlHint: '現在価格から±$300〜$1,500（TPはSLの1.5倍以上）',
    tpSlMin: 150,    // $150未満は拒否
    tpSlMax: 2500,   // $2,500超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 280,   // 旧400
    trailingDistance: 150,     // 旧200
    correlationGroup: 'risk_on',
  },
  {
    pair: 'Gold',
    broker: 'oanda',
    oandaSymbol: 'XAU_USD',
    rateChangeTh: 1.5,
    tpSlHint: '現在価格から±$10〜$30（SLは狭め$10以内、TPはSLの2倍以上）',
    tpSlMin: 5,      // $5未満は拒否
    tpSlMax: 50,     // $50超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 7,     // 旧10 — RR=0.55の改善
    trailingDistance: 4,       // 旧5
    correlationGroup: 'precious',
  },
  {
    pair: 'EUR/USD',
    broker: 'oanda',
    oandaSymbol: 'EUR_USD',
    rateChangeTh: 0.001,
    tpSlHint: '現在レートから±0.005〜0.015（TPはSLの1.5倍以上）',
    tpSlMin: 0.002,  // 0.002未満は拒否
    tpSlMax: 0.025,  // 0.025超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.003, // 旧0.004
    trailingDistance: 0.0015,  // 旧0.002
    correlationGroup: 'europe',
  },
  {
    pair: 'ETH/USD',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 8,
    tpSlHint: '現在価格から±$30〜$100（TPはSLの1.5倍以上）',
    tpSlMin: 15,     // $15未満は拒否
    tpSlMax: 150,    // $150超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 20,    // 旧30
    trailingDistance: 12,      // 旧15
    correlationGroup: 'standalone',
  },
  {
    pair: 'CrudeOil',
    broker: 'oanda',
    oandaSymbol: 'WTICO_USD',
    rateChangeTh: 0.15,
    tpSlHint: '現在価格から±$0.5〜$2.0（TPはSLの1.5倍以上）',
    tpSlMin: 0.25,   // $0.25未満は拒否
    tpSlMax: 4.0,    // $4.0超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.5,   // 旧0.8
    trailingDistance: 0.3,     // 旧0.4
    correlationGroup: 'energy',
  },
  {
    pair: 'NatGas',
    broker: 'oanda',
    oandaSymbol: 'NATGAS_USD',
    rateChangeTh: 0.015,
    tpSlHint: '現在価格から±$0.05〜$0.2（TPはSLの1.5倍以上）',
    tpSlMin: 0.025,  // $0.025未満は拒否
    tpSlMax: 0.4,    // $0.4超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 1000,
    trailingActivation: 0.05,  // 旧0.08
    trailingDistance: 0.03,    // 旧0.04
    correlationGroup: 'energy',
  },
  {
    pair: 'Copper',
    broker: 'oanda',
    oandaSymbol: 'COPPER',
    rateChangeTh: 0.01,
    tpSlHint: '現在価格から±$0.03〜$0.1（TPはSLの1.5倍以上）',
    tpSlMin: 0.015,  // $0.015未満は拒否
    tpSlMax: 0.2,    // $0.2超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 1000,
    trailingActivation: 0.035, // 旧0.05
    trailingDistance: 0.02,    // 旧0.025
    correlationGroup: 'precious',
  },
  {
    pair: 'Silver',
    broker: 'oanda',
    oandaSymbol: 'XAG_USD',
    rateChangeTh: 0.08,
    tpSlHint: '現在価格から±$0.3〜$1.0（TPはSLの1.5倍以上）',
    tpSlMin: 0.15,   // $0.15未満は拒否
    tpSlMax: 2.0,    // $2.0超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.28,  // 旧0.4
    trailingDistance: 0.15,    // 旧0.2
    correlationGroup: 'precious',
  },
  {
    pair: 'GBP/USD',
    broker: 'oanda',
    oandaSymbol: 'GBP_USD',
    rateChangeTh: 0.001,
    tpSlHint: '現在レートから±0.005〜0.015（TPはSLの1.5倍以上）',
    tpSlMin: 0.002,  // 0.002未満は拒否
    tpSlMax: 0.025,  // 0.025超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.003, // 旧0.004
    trailingDistance: 0.0015,  // 旧0.002
    correlationGroup: 'europe',
  },
  {
    pair: 'AUD/USD',
    broker: 'oanda',
    oandaSymbol: 'AUD_USD',
    rateChangeTh: 0.001,
    tpSlHint: '現在レートから±0.005〜0.015（TPはSLの1.5倍以上）',
    tpSlMin: 0.002,  // 0.002未満は拒否
    tpSlMax: 0.025,  // 0.025超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.003, // 旧0.004
    trailingDistance: 0.0015,  // 旧0.002
    correlationGroup: 'risk_on',
  },
  {
    pair: 'SOL/USD',
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 0.5,
    tpSlHint: '現在価格から±$2〜$8（TPはSLの1.5倍以上）',
    tpSlMin: 1.0,    // $1未満は拒否
    tpSlMax: 15.0,   // $15超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 2,     // 旧3
    trailingDistance: 1.2,     // 旧1.5
    correlationGroup: 'standalone',
  },
  {
    pair: 'DAX',
    broker: 'oanda',
    oandaSymbol: 'DE30_EUR',
    rateChangeTh: 15,
    tpSlHint: '現在値から±50〜200ポイント（TPはSLの1.5倍以上）',
    tpSlMin: 25,     // 25pt未満は拒否
    tpSlMax: 350,    // 350pt超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 55,    // 旧80
    trailingDistance: 30,      // 旧40
    correlationGroup: 'europe',
  },
  {
    pair: 'NASDAQ',
    broker: 'oanda',
    oandaSymbol: 'NAS100_USD',
    rateChangeTh: 15,
    tpSlHint: '現在値から±50〜200ポイント（TPはSLの1.5倍以上）',
    tpSlMin: 25,     // 25pt未満は拒否
    tpSlMax: 350,    // 350pt超過は拒否
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 55,    // 旧80
    trailingDistance: 30,      // 旧40
    correlationGroup: 'risk_on',
  },
];

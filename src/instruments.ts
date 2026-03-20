// 取引対象銘柄の定義

export interface InstrumentConfig {
  pair: string;
  /** フィルタ: この変化量以上でGeminiを呼ぶ */
  rateChangeTh: number;
  /** Geminiプロンプト用TP/SL範囲ヒント */
  tpSlHint: string;
  /** PnL表示単位 */
  pnlUnit: string;
  /** PnL = (close - entry) * pnlMultiplier */
  pnlMultiplier: number;
  /** トレイリングストップ: この値幅分利益が出たらトレイリング開始（レート単位） */
  trailingActivation: number;
  /** トレイリングストップ: SLを現在値からこの幅で追従（レート単位） */
  trailingDistance: number;
}

export const INSTRUMENTS: InstrumentConfig[] = [
  {
    pair: 'USD/JPY',
    rateChangeTh: 0.015,
    tpSlHint: '現在レートから±0.3〜1.0円（TPはSLの1.5倍以上離すこと）',
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.2,   // 0.2円利益でトレイリング開始（旧0.3）
    trailingDistance: 0.12,    // 0.12円幅で追従（旧0.15）
  },
  {
    pair: 'Nikkei225',
    rateChangeTh: 15,
    tpSlHint: '現在値から±100〜500ポイント（TPはSLの1.5倍以上離すこと）',
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 100,   // 旧150
    trailingDistance: 60,      // 旧80
  },
  {
    pair: 'S&P500',
    rateChangeTh: 1.5,
    tpSlHint: '現在値から±10〜30ポイント（SLは狭め、TPはSLの2倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 8,     // 旧15 — RR最悪銘柄のため大幅引き下げ
    trailingDistance: 5,       // 旧8
  },
  {
    pair: 'US10Y',
    rateChangeTh: 0.015,
    tpSlHint: '現在利回りから±0.1〜0.3%（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 5000,
    trailingActivation: 0.05,  // 旧0.08
    trailingDistance: 0.03,    // 旧0.04
  },
  {
    pair: 'BTC/USD',
    rateChangeTh: 25,
    tpSlHint: '現在価格から±$300〜$1,500（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 280,   // 旧400
    trailingDistance: 150,     // 旧200
  },
  {
    pair: 'Gold',
    rateChangeTh: 1.5,
    tpSlHint: '現在価格から±$10〜$30（SLは狭め$10以内、TPはSLの2倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 7,     // 旧10 — RR=0.55の改善
    trailingDistance: 4,       // 旧5
  },
  {
    pair: 'EUR/USD',
    rateChangeTh: 0.001,
    tpSlHint: '現在レートから±0.005〜0.015（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.003, // 旧0.004
    trailingDistance: 0.0015,  // 旧0.002
  },
  {
    pair: 'ETH/USD',
    rateChangeTh: 8,
    tpSlHint: '現在価格から±$30〜$100（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 20,    // 旧30
    trailingDistance: 12,      // 旧15
  },
  {
    pair: 'CrudeOil',
    rateChangeTh: 0.15,
    tpSlHint: '現在価格から±$0.5〜$2.0（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.5,   // 旧0.8
    trailingDistance: 0.3,     // 旧0.4
  },
  {
    pair: 'NatGas',
    rateChangeTh: 0.015,
    tpSlHint: '現在価格から±$0.05〜$0.2（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 1000,
    trailingActivation: 0.05,  // 旧0.08
    trailingDistance: 0.03,    // 旧0.04
  },
  {
    pair: 'Copper',
    rateChangeTh: 0.01,
    tpSlHint: '現在価格から±$0.03〜$0.1（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 1000,
    trailingActivation: 0.035, // 旧0.05
    trailingDistance: 0.02,    // 旧0.025
  },
  {
    pair: 'Silver',
    rateChangeTh: 0.08,
    tpSlHint: '現在価格から±$0.3〜$1.0（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.28,  // 旧0.4
    trailingDistance: 0.15,    // 旧0.2
  },
  {
    pair: 'GBP/USD',
    rateChangeTh: 0.001,
    tpSlHint: '現在レートから±0.005〜0.015（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.003, // 旧0.004
    trailingDistance: 0.0015,  // 旧0.002
  },
  {
    pair: 'AUD/USD',
    rateChangeTh: 0.001,
    tpSlHint: '現在レートから±0.005〜0.015（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.003, // 旧0.004
    trailingDistance: 0.0015,  // 旧0.002
  },
  {
    pair: 'SOL/USD',
    rateChangeTh: 0.5,
    tpSlHint: '現在価格から±$2〜$8（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 2,     // 旧3
    trailingDistance: 1.2,     // 旧1.5
  },
  {
    pair: 'DAX',
    rateChangeTh: 15,
    tpSlHint: '現在値から±50〜200ポイント（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 55,    // 旧80
    trailingDistance: 30,      // 旧40
  },
  {
    pair: 'NASDAQ',
    rateChangeTh: 15,
    tpSlHint: '現在値から±50〜200ポイント（TPはSLの1.5倍以上）',
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 55,    // 旧80
    trailingDistance: 30,      // 旧40
  },
];

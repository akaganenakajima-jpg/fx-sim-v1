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
    rateChangeTh: 0.05,
    tpSlHint: '現在レートから±0.3〜1.0円',
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 0.3,   // 0.3円利益でトレイリング開始
    trailingDistance: 0.15,     // 0.15円幅で追従
  },
  {
    pair: 'Nikkei225',
    rateChangeTh: 50,
    tpSlHint: '現在値から±100〜500ポイント',
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 150,
    trailingDistance: 80,
  },
  {
    pair: 'S&P500',
    rateChangeTh: 5,
    tpSlHint: '現在値から±10〜50ポイント',
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 15,
    trailingDistance: 8,
  },
  {
    pair: 'US10Y',
    rateChangeTh: 0.05,
    tpSlHint: '現在利回りから±0.1〜0.3%',
    pnlUnit: '円',
    pnlMultiplier: 5000,
    trailingActivation: 0.08,
    trailingDistance: 0.04,
  },
  {
    pair: 'BTC/USD',
    rateChangeTh: 100,
    tpSlHint: '現在価格から±$300〜$1,500',
    pnlUnit: '円',
    pnlMultiplier: 1,
    trailingActivation: 400,
    trailingDistance: 200,
  },
  {
    pair: 'Gold',
    rateChangeTh: 5,
    tpSlHint: '現在価格から±$10〜$40',
    pnlUnit: '円',
    pnlMultiplier: 10,
    trailingActivation: 15,
    trailingDistance: 8,
  },
  {
    pair: 'EUR/USD',
    rateChangeTh: 0.003,
    tpSlHint: '現在レートから±0.005〜0.015',
    pnlUnit: '円',
    pnlMultiplier: 10000,
    trailingActivation: 0.004,
    trailingDistance: 0.002,
  },
];

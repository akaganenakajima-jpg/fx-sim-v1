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
}

export const INSTRUMENTS: InstrumentConfig[] = [
  {
    pair: 'USD/JPY',
    rateChangeTh: 0.05,
    tpSlHint: '現在レートから±0.3〜1.0円',
    pnlUnit: 'pip',
    pnlMultiplier: 100,
  },
  {
    pair: 'Nikkei225',
    rateChangeTh: 50,
    tpSlHint: '現在値から±100〜500ポイント',
    pnlUnit: 'pt',
    pnlMultiplier: 0.1,
  },
  {
    pair: 'S&P500',
    rateChangeTh: 5,
    tpSlHint: '現在値から±10〜50ポイント',
    pnlUnit: 'pt',
    pnlMultiplier: 0.1,
  },
  {
    pair: 'US10Y',
    rateChangeTh: 0.05,
    tpSlHint: '現在利回りから±0.1〜0.3%',
    pnlUnit: 'bp',
    pnlMultiplier: 100,
  },
];

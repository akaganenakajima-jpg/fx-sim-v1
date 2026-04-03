// src/screener.ts
// AIモメンタム・スクリーナー: Yahoo Finance APIで米国株・日本株をATR/出来高でスクリーニング
//
// 設計根拠:
//   テスタ「出来高が急増して、ボラが大きい銘柄を選ぶ」
//   ATR(日中値幅) × 60% + 出来高加速度 × 40% でトレーダー向き度をスコアリング

// ─── 事前定義スクリーニングリスト ─────────────────────────────────────────────
// S&P500 上位100（時価総額・流動性で厳選）
export const SP500_SCREEN_LIST = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','BRK-B','AVGO','JPM',
  'LLY','UNH','V','XOM','MA','COST','HD','PG','JNJ','NFLX',
  'ABBV','CRM','BAC','ORCL','CVX','MRK','WMT','AMD','KO','PEP',
  'TMO','ACN','LIN','CSCO','MCD','ABT','ADBE','PM','WFC','GE',
  'IBM','NOW','TXN','QCOM','INTU','ISRG','MS','CAT','AXP','GS',
  'BKNG','AMGN','NEE','BLK','PGR','T','LOW','SPGI','UBER','RTX',
  'SYK','AMAT','VRTX','HON','ELV','TJX','BSX','PLD','MDT','SCHW',
  'DE','LRCX','GILD','ADP','ADI','FI','MU','KLAC','PANW','SO',
  'REGN','CB','SNPS','CME','CI','ICE','CDNS','EQIX','ETN','DUK',
  'MMC','SHW','PH','APH','CL','MSI','NOC','TT','WELL','MCK',
];

// 日経225 上位100（時価総額・売買代金で厳選、Yahoo Finance用に .T 付き）
export const NIKKEI_SCREEN_LIST = [
  '7203.T','6758.T','8306.T','6861.T','9984.T','8035.T','6501.T','7267.T','9432.T','6902.T',
  '6098.T','7974.T','4063.T','6273.T','4502.T','4568.T','8058.T','3382.T','7751.T','6594.T',
  '4661.T','8001.T','8316.T','4519.T','6702.T','8411.T','6367.T','6954.T','8031.T','9433.T',
  '2914.T','6503.T','7741.T','4543.T','6301.T','8766.T','4901.T','5108.T','7011.T','4307.T',
  '8002.T','6326.T','2802.T','8801.T','6762.T','9434.T','7752.T','4578.T','6981.T','3407.T',
  '8591.T','1925.T','2502.T','4503.T','6971.T','5802.T','7201.T','6857.T','3659.T','7269.T',
  '8015.T','9020.T','4452.T','7735.T','6988.T','8830.T','3086.T','2501.T','6920.T','4911.T',
  '5401.T','9022.T','1928.T','4755.T','9613.T','8725.T','6645.T','6753.T','8309.T','7733.T',
  '6479.T','5713.T','2413.T','3289.T','8604.T','4689.T','6752.T','3099.T','1605.T','7832.T',
  '7731.T','6146.T','3436.T','4704.T','6506.T','7912.T','8750.T','9843.T','2801.T','4523.T',
];

// ─── スクリーニング結果型 ────────────────────────────────────────────────────
export interface ScreenResult {
  ticker: string;
  market: 'us' | 'jp';
  price: number;
  atrScore: number;      // ボラティリティスコア 0-100
  volumeScore: number;   // 出来高加速スコア 0-100
  totalScore: number;    // 総合スコア 0-100
  volume1d: number;
  volumeAvg: number;
  dayRange: number;
}

// ─── Yahoo Finance バッチ取得 ─────────────────────────────────────────────────
interface YahooQuoteResult {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketVolume?: number;
  averageDailyVolume10Day?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
}

const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const BATCH_SIZE = 10;
const FETCH_TIMEOUT_MS = 8_000;

/** Yahoo Finance v7 quote API でバッチ取得（最大10銘柄ずつ） */
async function fetchYahooQuotes(tickers: string[]): Promise<YahooQuoteResult[]> {
  const results: YahooQuoteResult[] = [];

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const symbols = batch.join(',');
    try {
      const res = await fetch(
        `${YAHOO_QUOTE_URL}?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketVolume,averageDailyVolume10Day,regularMarketDayHigh,regularMarketDayLow,fiftyTwoWeekHigh,fiftyTwoWeekLow`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }
      );
      if (!res.ok) {
        console.warn(`[screener] Yahoo quote batch failed (${res.status}): ${symbols.slice(0, 40)}`);
        continue;
      }
      const data = await res.json() as {
        quoteResponse?: { result?: YahooQuoteResult[] };
      };
      if (data.quoteResponse?.result) {
        results.push(...data.quoteResponse.result);
      }
    } catch (e) {
      console.warn(`[screener] Yahoo quote error: ${String(e).slice(0, 80)}`);
    }
  }

  return results;
}

// ─── スコアリング ─────────────────────────────────────────────────────────────

/** ATRスコア: 日中値幅 / 価格 を正規化（0-100） */
function calcAtrScore(dayRange: number, price: number, medianRatio: number): number {
  if (price <= 0 || medianRatio <= 0) return 0;
  const ratio = dayRange / price;
  // median比で正規化: medianと同じなら50点、2倍なら100点
  return Math.min(100, Math.max(0, (ratio / medianRatio) * 50));
}

/** 出来高加速スコア: 直近出来高 / 10日平均 を正規化（0-100） */
function calcVolumeScore(vol1d: number, volAvg: number): number {
  if (volAvg <= 0) return 0;
  // 10日平均と同じなら0点、2倍なら100点
  const acceleration = (vol1d / volAvg - 1) * 100;
  return Math.min(100, Math.max(0, acceleration));
}

// ─── メインスクリーニング関数 ─────────────────────────────────────────────────

/**
 * 指定ティッカーリストからYahoo Financeデータを取得し、
 * ATR/出来高でスコアリング → 上位30件を返す
 *
 * @param tickers スクリーニング対象ティッカー配列
 * @param market 'us' | 'jp'
 * @returns 上位30件のScreenResult（totalScore降順）
 */
export async function screenCandidates(
  tickers: string[],
  market: 'us' | 'jp',
): Promise<ScreenResult[]> {
  console.log(`[screener] Start: ${market} ${tickers.length} tickers`);

  const quotes = await fetchYahooQuotes(tickers);
  if (quotes.length === 0) {
    console.warn(`[screener] No quotes returned for ${market}`);
    return [];
  }

  // 日中値幅比の中央値を算出（ATRスコアの正規化基準）
  const ratios = quotes
    .filter(q => q.regularMarketPrice && q.regularMarketDayHigh && q.regularMarketDayLow && q.regularMarketPrice > 0)
    .map(q => (q.regularMarketDayHigh! - q.regularMarketDayLow!) / q.regularMarketPrice!);

  ratios.sort((a, b) => a - b);
  const medianRatio = ratios.length > 0
    ? ratios[Math.floor(ratios.length / 2)]
    : 0.02; // フォールバック: 2%

  // 各銘柄をスコアリング
  const scored: ScreenResult[] = [];

  for (const q of quotes) {
    const price = q.regularMarketPrice ?? 0;
    const vol1d = q.regularMarketVolume ?? 0;
    const volAvg = q.averageDailyVolume10Day ?? 0;
    const high = q.regularMarketDayHigh ?? 0;
    const low = q.regularMarketDayLow ?? 0;
    const dayRange = high - low;

    if (price <= 0 || vol1d <= 0) continue;

    const atrScore = calcAtrScore(dayRange, price, medianRatio);
    const volumeScore = calcVolumeScore(vol1d, volAvg);
    const totalScore = atrScore * 0.6 + volumeScore * 0.4;

    scored.push({
      ticker: q.symbol ?? '',
      market,
      price,
      atrScore: Math.round(atrScore * 10) / 10,
      volumeScore: Math.round(volumeScore * 10) / 10,
      totalScore: Math.round(totalScore * 10) / 10,
      volume1d: vol1d,
      volumeAvg: volAvg,
      dayRange,
    });
  }

  // totalScore降順でソート → 上位30件
  scored.sort((a, b) => b.totalScore - a.totalScore);
  const top = scored.slice(0, 30);

  console.log(`[screener] ${market}: ${quotes.length} quotes → ${scored.length} scored → top ${top.length}`);
  return top;
}

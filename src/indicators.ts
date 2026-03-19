// Yahoo Finance から VIX・日経(^N225)・S&P500(^GSPC)・米10年債(^TNX) を取得
// ^TNX = CBOE 10-Year Treasury Note Yield Index（単位: %）
// FRED API 依存を廃止し全指標をYahoo Financeに統一

export interface MarketIndicators {
  vix: number | null;
  us10y: number | null;
  nikkei: number | null;
  sp500: number | null;
  usdjpy: number | null;
  btcusd: number | null;
  gold: number | null;
  eurusd: number | null;
}

interface YahooChartResult {
  chart: {
    result: Array<{
      meta: { regularMarketPrice: number };
    }> | null;
    error: unknown;
  };
}

async function fetchYahoo(symbol: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'fx-sim-v1/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json<YahooChartResult>();
    const price = data.chart.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === 'number' ? price : null;
  } catch (e) {
    console.error(`[indicators] Yahoo fetch error (${symbol}):`, e);
    return null;
  }
}

export async function getMarketIndicators(): Promise<MarketIndicators> {
  const [vix, nikkei, sp500, us10y, usdjpy, btcusd, gold, eurusd] = await Promise.all([
    fetchYahoo('^VIX'),
    fetchYahoo('^N225'),
    fetchYahoo('^GSPC'),
    fetchYahoo('^TNX'),
    fetchYahoo('USDJPY=X'),
    fetchYahoo('BTC-USD'),
    fetchYahoo('GC=F'),       // Gold先物
    fetchYahoo('EURUSD=X'),
  ]);

  return { vix, us10y, nikkei, sp500, usdjpy, btcusd, gold, eurusd };
}

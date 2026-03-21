// Yahoo Finance から VIX・日経(^N225)・S&P500(^GSPC)・米10年債(^TNX) を取得
// ^TNX = CBOE 10-Year Treasury Note Yield Index（単位: %）
// FRED API 依存を廃止し全指標をYahoo Financeに統一
// Yahoo Finance 障害時は Twelve Data API へ自動フォールバック

export interface MarketIndicators {
  vix: number | null;
  us10y: number | null;
  nikkei: number | null;
  sp500: number | null;
  usdjpy: number | null;
  btcusd: number | null;
  gold: number | null;
  eurusd: number | null;
  ethusd: number | null;
  crudeoil: number | null;
  natgas: number | null;
  copper: number | null;
  silver: number | null;
  gbpusd: number | null;
  audusd: number | null;
  solusd: number | null;
  dax: number | null;
  nasdaq: number | null;
  uk100: number | null;
  hk33: number | null;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000); // 3秒タイムアウト（18並列）
    const res = await fetch(url, {
      headers: { 'User-Agent': 'fx-sim-v1/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json<YahooChartResult>();
    const price = data.chart.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === 'number' ? price : null;
  } catch (e) {
    const msg = String(e);
    if (msg.includes('abort')) {
      console.warn(`[indicators] Yahoo timeout (${symbol}): 5s`);
    } else {
      console.error(`[indicators] Yahoo fetch error (${symbol}):`, msg.slice(0, 100));
    }
    return null;
  }
}

/** Twelve Data API から主要銘柄を取得（Yahoo Finance 障害時フォールバック）
 *  無料枠: 800 req/day → 障害検知時のみ呼び出す
 */
async function fetchFromTwelveData(apiKey: string): Promise<Partial<MarketIndicators>> {
  // Twelve Data は複数銘柄をカンマ区切りで1リクエストに集約
  const symbols = 'USD/JPY,XAU/USD,BTC/USD,EUR/USD,GBP/USD,AUD/USD';
  const url = `https://api.twelvedata.com/price?symbol=${symbols}&apikey=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return {};
    const data = await res.json() as Record<string, { price?: string; code?: number }>;
    return {
      usdjpy:  data['USD/JPY']?.price  ? parseFloat(data['USD/JPY'].price!)  : null,
      gold:    data['XAU/USD']?.price  ? parseFloat(data['XAU/USD'].price!)  : null,
      btcusd:  data['BTC/USD']?.price  ? parseFloat(data['BTC/USD'].price!)  : null,
      eurusd:  data['EUR/USD']?.price  ? parseFloat(data['EUR/USD'].price!)  : null,
      gbpusd:  data['GBP/USD']?.price  ? parseFloat(data['GBP/USD'].price!)  : null,
      audusd:  data['AUD/USD']?.price  ? parseFloat(data['AUD/USD'].price!)  : null,
    };
  } catch {
    return {};
  }
}

export async function getMarketIndicators(twelveDataApiKey?: string): Promise<MarketIndicators> {
  const [vix, nikkei, sp500, us10y, usdjpy, btcusd, gold, eurusd, ethusd, crudeoil, natgas, copper, silver, gbpusd, audusd, solusd, dax, nasdaq, uk100, hk33] = await Promise.all([
    fetchYahoo('^VIX'),
    fetchYahoo('^N225'),
    fetchYahoo('^GSPC'),
    fetchYahoo('^TNX'),
    fetchYahoo('USDJPY=X'),
    fetchYahoo('BTC-USD'),
    fetchYahoo('GC=F'),
    fetchYahoo('EURUSD=X'),
    fetchYahoo('ETH-USD'),
    fetchYahoo('CL=F'),       // 原油先物
    fetchYahoo('NG=F'),       // 天然ガス先物
    fetchYahoo('HG=F'),       // 銅先物
    fetchYahoo('SI=F'),       // Silver先物
    fetchYahoo('GBPUSD=X'),
    fetchYahoo('AUDUSD=X'),
    fetchYahoo('SOL-USD'),
    fetchYahoo('^GDAXI'),     // DAX
    fetchYahoo('^IXIC'),      // NASDAQ
    fetchYahoo('^FTSE'),      // UK100 (FTSE 100)
    fetchYahoo('^HSI'),       // HK33 (ハンセン指数)
  ]);

  const result: MarketIndicators = { vix, us10y, nikkei, sp500, usdjpy, btcusd, gold, eurusd, ethusd, crudeoil, natgas, copper, silver, gbpusd, audusd, solusd, dax, nasdaq, uk100, hk33 };

  // Yahoo Finance 結果の null 数をカウント
  const nullCount = [result.usdjpy, result.gold, result.btcusd, result.eurusd, result.nikkei, result.sp500]
    .filter(v => v == null).length;

  if (nullCount >= 3 && twelveDataApiKey) {
    console.warn(`[indicators] Yahoo障害(${nullCount}件null) → Twelve Data フォールバック`);
    const tdResult = await fetchFromTwelveData(twelveDataApiKey);
    // null の値だけ Twelve Data で補完
    const resultAny = result as unknown as Record<string, number | null>;
    for (const [k, v] of Object.entries(tdResult)) {
      if (v != null && resultAny[k] == null) {
        resultAny[k] = v;
      }
    }
  }

  return result;
}

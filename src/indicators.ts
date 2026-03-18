// Yahoo Finance から VIX・日経(^N225)・S&P500(^GSPC) を取得
// FRED API から米10年債利回りを取得（日次・market_cacheでキャッシュ）

import { getCacheValue, setCacheValue } from './db';

export interface MarketIndicators {
  vix: number | null;
  us10y: number | null; // 米10年債利回り（%）
  nikkei: number | null;
  sp500: number | null;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間

interface YahooChartResult {
  chart: {
    result: Array<{
      meta: { regularMarketPrice: number };
    }> | null;
    error: unknown;
  };
}

interface FredObservation {
  value: string;
}
interface FredResponse {
  observations: FredObservation[];
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

async function fetchUs10y(
  db: D1Database,
  fredApiKey: string
): Promise<number | null> {
  // キャッシュ確認
  const cached = await getCacheValue(db, 'us10y');
  if (cached) {
    const { value, updatedAt } = JSON.parse(cached) as {
      value: number;
      updatedAt: string;
    };
    if (Date.now() - new Date(updatedAt).getTime() < CACHE_TTL_MS) {
      return value;
    }
  }

  // FRED API から取得
  try {
    const url =
      `https://api.stlouisfed.org/fred/series/observations` +
      `?series_id=DGS10&api_key=${fredApiKey}&file_type=json&sort_order=desc&limit=1`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[indicators] FRED API error: ${res.status}`);
      return null;
    }
    const data = await res.json<FredResponse>();
    const obs = data.observations[0];
    if (!obs || obs.value === '.') return null;

    const value = parseFloat(obs.value);
    await setCacheValue(
      db,
      'us10y',
      JSON.stringify({ value, updatedAt: new Date().toISOString() })
    );
    return value;
  } catch (e) {
    console.error('[indicators] FRED fetch error:', e);
    return null;
  }
}

export async function getMarketIndicators(
  db: D1Database,
  fredApiKey: string
): Promise<MarketIndicators> {
  const [vix, nikkei, sp500, us10y] = await Promise.all([
    fetchYahoo('^VIX'),
    fetchYahoo('^N225'),
    fetchYahoo('^GSPC'),
    fetchUs10y(db, fredApiKey),
  ]);

  return { vix, us10y, nikkei, sp500 };
}

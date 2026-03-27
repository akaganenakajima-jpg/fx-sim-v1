// Yahoo Finance から VIX・日経(^N225)・S&P500(^GSPC)・米10年債(^TNX) を取得
// ^TNX = CBOE 10-Year Treasury Note Yield Index（単位: %）
// FRED API 依存を廃止し全指標をYahoo Financeに統一
// Yahoo Finance 障害時は Twelve Data API へ自動フォールバック
// v2: 追加指標（Fear&Greed / CFTC COT / Stooq 10Y バックアップ）

// ─────────────────────────────────────────────────────────────────────────────
// 追加指標 ON/OFF スイッチ（false で完全スキップ）
// ─────────────────────────────────────────────────────────────────────────────
export const EXTRA_INDICATOR_CONFIG = {
  fearGreed:   true,   // Crypto Fear & Greed Index（APIキー不要・完全無料）
  cftcJpyCot:  true,   // CFTC大口投機筋JPY先物ポジション（週次・APIキー不要）
  stooqUs10y:  true,   // Stooq 米10年債バックアップ（Yahoo Finance 障害時）
};

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
  /** Crypto Fear & Greed Index（0=Extreme Fear〜100=Extreme Greed） */
  fearGreed: number | null;
  /** Fear & Greed ラベル（"Extreme Fear" / "Fear" / "Neutral" / "Greed" / "Extreme Greed"） */
  fearGreedLabel: string | null;
  /** CFTC大口投機筋JPY先物ネットロング枚数（正=円買い超、負=円売り超）週次 */
  cftcJpyNetLong: number | null;
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
    const timeout = setTimeout(() => controller.abort(), 5_000); // 5秒タイムアウト（20並列・競合対策）
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
      console.warn(`[indicators] Yahoo timeout (${symbol}): 5000ms`);
    } else {
      console.error(`[indicators] Yahoo fetch error (${symbol}):`, msg.slice(0, 100));
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 追加指標フェッチ関数
// ─────────────────────────────────────────────────────────────────────────────

/** Stooq から米10年債利回りを取得（Yahoo Finance 障害時の us10y バックアップ）*/
async function fetchStooqUs10y(): Promise<number | null> {
  try {
    const url = 'https://stooq.com/q/l/?s=10usb.b&f=sd2t2ohlcv&h&e=json';
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json() as { symbols?: Array<{ Close?: string }> };
    const close = data.symbols?.[0]?.Close;
    return close ? parseFloat(close) : null;
  } catch { return null; }
}

/** Crypto Fear & Greed Index（代替Me APIキー不要・完全無料）*/
async function fetchFearGreed(): Promise<{ value: number | null; label: string | null }> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1&format=json', {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { value: null, label: null };
    const data = await res.json() as {
      data?: Array<{ value: string; value_classification: string }>;
    };
    const item = data.data?.[0];
    if (!item) return { value: null, label: null };
    return { value: parseInt(item.value, 10), label: item.value_classification };
  } catch { return { value: null, label: null }; }
}

/** CFTC大口投機筋JPY先物ポジション（週次・APIキー不要）
 *  正値 = 円買い超（円高圧力・USD/JPY 下落方向）
 *  負値 = 円売り超（円安圧力・USD/JPY 上昇方向）
 */
async function fetchCftcJpyNetLong(): Promise<number | null> {
  try {
    const url =
      "https://publicreporting.cftc.gov/resource/jun7-fc8e.json" +
      "?$where=market_and_exchange_names='JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE'" +
      "&$limit=1&$order=report_date_as_mm_dd_yyyy%20DESC";
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json() as Array<{
      noncomm_positions_long_all?: string;
      noncomm_positions_short_all?: string;
    }>;
    const row = data?.[0];
    if (!row) return null;
    const longs  = parseInt(row.noncomm_positions_long_all  ?? '0', 10);
    const shorts = parseInt(row.noncomm_positions_short_all ?? '0', 10);
    return longs - shorts;
  } catch { return null; }
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
  // Yahoo Finance（主要指標）と追加指標を並列取得
  const [
    vix, nikkei, sp500, us10y, usdjpy, btcusd, gold, eurusd, ethusd,
    crudeoil, natgas, copper, silver, gbpusd, audusd, solusd, dax, nasdaq, uk100, hk33,
    fearGreedData,
    cftcJpyNetLong,
  ] = await Promise.all([
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
    // 追加指標（EXTRA_INDICATOR_CONFIG で ON/OFF）
    EXTRA_INDICATOR_CONFIG.fearGreed  ? fetchFearGreed()        : Promise.resolve({ value: null, label: null }),
    EXTRA_INDICATOR_CONFIG.cftcJpyCot ? fetchCftcJpyNetLong()   : Promise.resolve(null),
  ]);

  const result: MarketIndicators = {
    vix, us10y, nikkei, sp500, usdjpy, btcusd, gold, eurusd, ethusd,
    crudeoil, natgas, copper, silver, gbpusd, audusd, solusd, dax, nasdaq, uk100, hk33,
    fearGreed: fearGreedData.value,
    fearGreedLabel: fearGreedData.label,
    cftcJpyNetLong,
  };

  // Yahoo Finance 結果の null 数をカウント
  const nullCount = [result.usdjpy, result.gold, result.btcusd, result.eurusd, result.nikkei, result.sp500]
    .filter(v => v == null).length;

  if (nullCount >= 3) {
    // まず Stooq で us10y を補完（APIキー不要）
    if (EXTRA_INDICATOR_CONFIG.stooqUs10y && result.us10y == null) {
      const stooqYield = await fetchStooqUs10y();
      if (stooqYield != null) {
        result.us10y = stooqYield;
        console.warn(`[indicators] us10y: Yahoo null → Stooq ${stooqYield.toFixed(2)}% で補完`);
      }
    }
    // 次に Twelve Data で残りを補完
    if (twelveDataApiKey) {
      console.warn(`[indicators] Yahoo障害(${nullCount}件null) → Twelve Data フォールバック`);
      const tdResult = await fetchFromTwelveData(twelveDataApiKey);
      const resultAny = result as unknown as Record<string, number | null>;
      for (const [k, v] of Object.entries(tdResult)) {
        if (typeof v === 'number' && v != null && resultAny[k] == null) {
          resultAny[k] = v;
        }
      }
    }
  }

  return result;
}

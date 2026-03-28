// Yahoo Finance から VIX・日経(^N225)・S&P500(^GSPC)・米10年債(^TNX) を取得
// ^TNX = CBOE 10-Year Treasury Note Yield Index（単位: %）
// FRED API 依存を廃止し全指標をYahoo Financeに統一
// Yahoo Finance 障害時は Twelve Data API へ自動フォールバック
// v3: 3層キャッシュ + セマフォ並列度制限（実行時間超過対策）

// ──────────────────────────────────────────────────────��──────────────────────
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
  // 円クロス
  eurjpy: number | null;
  gbpjpy: number | null;
  audjpy: number | null;
  // 日本個別株
  kawasaki_kisen: number | null;   // 川崎汽船 9107.T
  nippon_yusen: number | null;     // 日本郵船 9101.T
  softbank_g: number | null;       // ソフトバンクG 9984.T
  lasertec: number | null;         // レーザーテック 6920.T
  tokyo_electron: number | null;   // 東京エレクトロン 8035.T
  disco: number | null;            // ディスコ 6146.T
  advantest: number | null;        // アドバンテスト 6857.T
  fast_retailing: number | null;   // ファーストリテイリング 9983.T
  nippon_steel: number | null;     // 日本製鉄 5401.T
  mufg: number | null;             // 三菱UFJ 8306.T
  mitsui_osk: number | null;       // 商船三井 9104.T
  tokio_marine: number | null;     // 東京海上HD 8766.T
  mitsubishi_corp: number | null;  // 三菱商事 8058.T
  toyota: number | null;           // トヨタ 7203.T
  sakura_internet: number | null;  // さくらインターネット 3778.T
  mhi: number | null;              // 三菱重工 7011.T
  ihi: number | null;              // IHI 7013.T
  anycolor: number | null;         // ANYCOLOR 5032.T
  cover_corp: number | null;       // カバー 5253.T
  // 米国個別株
  nvda: number | null;
  tsla: number | null;
  aapl: number | null;
  amzn: number | null;
  amd: number | null;
  meta: number | null;
  msft: number | null;
  googl: number | null;
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
// セマフォ付きバッチ実行（並列度制限）
// ─────────────────────────────────────────────────────────────────────────────

async function fetchBatch<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 market_cache ベースのキャッシュ読み書き
// ─────────────────────────────────────────────────────────────────────────────

interface CachedPrice { price: number; ts: number; }

async function getCachedPrices(db: D1Database, keys: string[]): Promise<Map<string, CachedPrice>> {
  const map = new Map<string, CachedPrice>();
  if (keys.length === 0) return map;
  // D1はバッチSELECTが効率的でないため、WHERE IN で一括取得
  const placeholders = keys.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT key, value, updated_at FROM market_cache WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string; updated_at: string }>();
  for (const row of rows.results) {
    try {
      const parsed = JSON.parse(row.value) as { price: number };
      map.set(row.key, { price: parsed.price, ts: new Date(row.updated_at).getTime() });
    } catch { /* ignore corrupt cache */ }
  }
  return map;
}

async function setCachedPrices(db: D1Database, entries: Array<{ key: string; price: number }>): Promise<void> {
  if (entries.length === 0) return;
  const now = new Date().toISOString();
  const stmts = entries.map(e =>
    db.prepare(
      `INSERT INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(e.key, JSON.stringify({ price: e.price }), now)
  );
  // D1 batch API: 最大50ステートメント
  await db.batch(stmts);
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

// ─────────────────────────────────────────────────────────────────────────────
// 3層グループ定義
// ─────────────────────────────────────────────────────────────────────────────

// Group A: FX/CFD/指数（毎分必要、キャッシュなし）
const GROUP_A: Array<{ key: keyof MarketIndicators; symbol: string }> = [
  { key: 'vix', symbol: '^VIX' },
  { key: 'nikkei', symbol: '^N225' },
  { key: 'sp500', symbol: '^GSPC' },
  { key: 'us10y', symbol: '^TNX' },
  { key: 'usdjpy', symbol: 'USDJPY=X' },
  { key: 'btcusd', symbol: 'BTC-USD' },
  { key: 'gold', symbol: 'GC=F' },
  { key: 'eurusd', symbol: 'EURUSD=X' },
  { key: 'ethusd', symbol: 'ETH-USD' },
  { key: 'crudeoil', symbol: 'CL=F' },
  { key: 'natgas', symbol: 'NG=F' },
  { key: 'copper', symbol: 'HG=F' },
  { key: 'silver', symbol: 'SI=F' },
  { key: 'gbpusd', symbol: 'GBPUSD=X' },
  { key: 'audusd', symbol: 'AUDUSD=X' },
  { key: 'solusd', symbol: 'SOL-USD' },
  { key: 'dax', symbol: '^GDAXI' },
  { key: 'nasdaq', symbol: '^IXIC' },
  { key: 'uk100', symbol: '^FTSE' },
  { key: 'hk33', symbol: '^HSI' },
  { key: 'eurjpy', symbol: 'EURJPY=X' },
  { key: 'gbpjpy', symbol: 'GBPJPY=X' },
  { key: 'audjpy', symbol: 'AUDJPY=X' },
];

// Group B: 個別株（5分TTLキャッシュ）
const GROUP_B: Array<{ key: keyof MarketIndicators; symbol: string }> = [
  // 日本個別株
  { key: 'kawasaki_kisen', symbol: '9107.T' },
  { key: 'nippon_yusen', symbol: '9101.T' },
  { key: 'softbank_g', symbol: '9984.T' },
  { key: 'lasertec', symbol: '6920.T' },
  { key: 'tokyo_electron', symbol: '8035.T' },
  { key: 'disco', symbol: '6146.T' },
  { key: 'advantest', symbol: '6857.T' },
  { key: 'fast_retailing', symbol: '9983.T' },
  { key: 'nippon_steel', symbol: '5401.T' },
  { key: 'mufg', symbol: '8306.T' },
  { key: 'mitsui_osk', symbol: '9104.T' },
  { key: 'tokio_marine', symbol: '8766.T' },
  { key: 'mitsubishi_corp', symbol: '8058.T' },
  { key: 'toyota', symbol: '7203.T' },
  { key: 'sakura_internet', symbol: '3778.T' },
  { key: 'mhi', symbol: '7011.T' },
  { key: 'ihi', symbol: '7013.T' },
  { key: 'anycolor', symbol: '5032.T' },
  { key: 'cover_corp', symbol: '5253.T' },
  // 米国個別株
  { key: 'nvda', symbol: 'NVDA' },
  { key: 'tsla', symbol: 'TSLA' },
  { key: 'aapl', symbol: 'AAPL' },
  { key: 'amzn', symbol: 'AMZN' },
  { key: 'amd', symbol: 'AMD' },
  { key: 'meta', symbol: 'META' },
  { key: 'msft', symbol: 'MSFT' },
  { key: 'googl', symbol: 'GOOGL' },
];

const GROUP_B_TTL_MS = 5 * 60 * 1000;  // 5分
const GROUP_C_TTL_MS = 60 * 60 * 1000; // 1時間
const CONCURRENCY = 10; // Yahoo Finance 最大並列数

export async function getMarketIndicators(
  twelveDataApiKey?: string,
  db?: D1Database,
): Promise<MarketIndicators> {
  const now = Date.now();

  // ── Group A: FX/CFD/指数（毎分フェッチ、セマフォ制限） ──
  const groupATasks = GROUP_A.map(item => () => fetchYahoo(item.symbol));
  const groupAResults = await fetchBatch(groupATasks, CONCURRENCY);

  // ── Group B: 個別株（5分TTLキャッシュ、セマフォ制限） ──
  let groupBResults: Array<number | null>;
  const cacheKeys = GROUP_B.map(item => `price_${item.key}`);

  if (db) {
    const cached = await getCachedPrices(db, cacheKeys);
    const toFetch: Array<{ idx: number; item: typeof GROUP_B[number]; cacheKey: string }> = [];
    groupBResults = new Array(GROUP_B.length);

    for (let i = 0; i < GROUP_B.length; i++) {
      const ck = cacheKeys[i];
      const hit = cached.get(ck);
      if (hit && (now - hit.ts) < GROUP_B_TTL_MS) {
        groupBResults[i] = hit.price;
      } else {
        toFetch.push({ idx: i, item: GROUP_B[i], cacheKey: ck });
      }
    }

    if (toFetch.length > 0) {
      const fetchTasks = toFetch.map(f => () => fetchYahoo(f.item.symbol));
      const fetched = await fetchBatch(fetchTasks, CONCURRENCY);
      const toCache: Array<{ key: string; price: number }> = [];
      for (let j = 0; j < toFetch.length; j++) {
        groupBResults[toFetch[j].idx] = fetched[j];
        if (fetched[j] != null) {
          toCache.push({ key: toFetch[j].cacheKey, price: fetched[j]! });
        }
      }
      if (toCache.length > 0) {
        // 非同期でキャッシュ書き込み（レスポンス遅延回避）
        setCachedPrices(db, toCache).catch(e =>
          console.warn('[indicators] cache write error:', String(e).slice(0, 100))
        );
      }
    }

    const cacheHitCount = GROUP_B.length - toFetch.length;
    if (cacheHitCount > 0) {
      console.log(`[indicators] Group B: ${cacheHitCount}/${GROUP_B.length} cache hit, ${toFetch.length} fetched`);
    }
  } else {
    // db未提供時はフォールバック（全件フェッチ）
    const fetchTasks = GROUP_B.map(item => () => fetchYahoo(item.symbol));
    groupBResults = await fetchBatch(fetchTasks, CONCURRENCY);
  }

  // ── Group C: 追加指標（1時間TTLキャッシュ） ──
  let fearGreedData: { value: number | null; label: string | null } = { value: null, label: null };
  let cftcJpyNetLong: number | null = null;

  if (db) {
    // Fear & Greed
    if (EXTRA_INDICATOR_CONFIG.fearGreed) {
      const fgCached = await getCachedPrices(db, ['extra_fear_greed']);
      const fgHit = fgCached.get('extra_fear_greed');
      if (fgHit && (now - fgHit.ts) < GROUP_C_TTL_MS) {
        // キャッシュには {price: value} + labelはmarket_cacheの別キーに保存
        fearGreedData.value = fgHit.price;
        const labelRow = await db
          .prepare('SELECT value FROM market_cache WHERE key = ?')
          .bind('extra_fear_greed_label')
          .first<{ value: string }>();
        fearGreedData.label = labelRow?.value ?? null;
      } else {
        fearGreedData = await fetchFearGreed();
        if (fearGreedData.value != null) {
          setCachedPrices(db, [{ key: 'extra_fear_greed', price: fearGreedData.value }]).catch(() => {});
          if (fearGreedData.label) {
            db.prepare(
              `INSERT INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
            ).bind('extra_fear_greed_label', fearGreedData.label, new Date().toISOString()).run().catch(() => {});
          }
        }
      }
    }

    // CFTC
    if (EXTRA_INDICATOR_CONFIG.cftcJpyCot) {
      const cftcCached = await getCachedPrices(db, ['extra_cftc_jpy']);
      const cftcHit = cftcCached.get('extra_cftc_jpy');
      if (cftcHit && (now - cftcHit.ts) < GROUP_C_TTL_MS) {
        cftcJpyNetLong = cftcHit.price;
      } else {
        cftcJpyNetLong = await fetchCftcJpyNetLong();
        if (cftcJpyNetLong != null) {
          setCachedPrices(db, [{ key: 'extra_cftc_jpy', price: cftcJpyNetLong }]).catch(() => {});
        }
      }
    }
  } else {
    // db未提供時のフォールバック
    if (EXTRA_INDICATOR_CONFIG.fearGreed) fearGreedData = await fetchFearGreed();
    if (EXTRA_INDICATOR_CONFIG.cftcJpyCot) cftcJpyNetLong = await fetchCftcJpyNetLong();
  }

  // ── 結果組み立て ──
  const result: MarketIndicators = {
    // Group A
    vix: groupAResults[0], nikkei: groupAResults[1], sp500: groupAResults[2], us10y: groupAResults[3],
    usdjpy: groupAResults[4], btcusd: groupAResults[5], gold: groupAResults[6], eurusd: groupAResults[7],
    ethusd: groupAResults[8], crudeoil: groupAResults[9], natgas: groupAResults[10], copper: groupAResults[11],
    silver: groupAResults[12], gbpusd: groupAResults[13], audusd: groupAResults[14], solusd: groupAResults[15],
    dax: groupAResults[16], nasdaq: groupAResults[17], uk100: groupAResults[18], hk33: groupAResults[19],
    eurjpy: groupAResults[20], gbpjpy: groupAResults[21], audjpy: groupAResults[22],
    // Group B
    kawasaki_kisen: groupBResults[0], nippon_yusen: groupBResults[1], softbank_g: groupBResults[2],
    lasertec: groupBResults[3], tokyo_electron: groupBResults[4], disco: groupBResults[5],
    advantest: groupBResults[6], fast_retailing: groupBResults[7], nippon_steel: groupBResults[8],
    mufg: groupBResults[9], mitsui_osk: groupBResults[10], tokio_marine: groupBResults[11],
    mitsubishi_corp: groupBResults[12], toyota: groupBResults[13],
    sakura_internet: groupBResults[14], mhi: groupBResults[15], ihi: groupBResults[16],
    anycolor: groupBResults[17], cover_corp: groupBResults[18],
    nvda: groupBResults[19], tsla: groupBResults[20], aapl: groupBResults[21],
    amzn: groupBResults[22], amd: groupBResults[23], meta: groupBResults[24],
    msft: groupBResults[25], googl: groupBResults[26],
    // Group C
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

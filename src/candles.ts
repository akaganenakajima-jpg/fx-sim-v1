// ── OANDA キャンドル取得 + テクニカル指標算出 ──
// テスタ施策5: OANDAローソク足からRSI/ADX/ATR/EMA/BBを算出

// ── 型定義 ──

export interface CandleData {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalIndicators {
  rsi14: number;
  adx14: number;
  atr14: number;
  ema20: number;
  ema50: number;
  bbUpper: number;
  bbLower: number;
  bbMiddle: number;
}

// ── OANDA REST API v20 ──

interface OandaCandleResponse {
  candles: Array<{
    time: string;
    mid: { o: string; h: string; l: string; c: string };
    volume: number;
    complete: boolean;
  }>;
}

export async function fetchOandaCandles(
  token: string,
  _accountId: string,
  isLive: boolean,
  oandaSymbol: string,
  granularity: 'H1' | 'H4' | 'D',
  count: number
): Promise<CandleData[]> {
  const host = isLive
    ? 'api-fxtrade.oanda.com'
    : 'api-fxpractice.oanda.com';
  const url = `https://${host}/v3/instruments/${oandaSymbol}/candles?granularity=${granularity}&count=${count}&price=M`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[candles] OANDA API error: ${res.status} ${res.statusText} (${oandaSymbol} ${granularity})`);
      return [];
    }

    const data = await res.json() as OandaCandleResponse;
    if (!data.candles) return [];

    return data.candles
      .filter((c) => c.complete)
      .map((c) => ({
        time: c.time,
        open: parseFloat(c.mid.o),
        high: parseFloat(c.mid.h),
        low: parseFloat(c.mid.l),
        close: parseFloat(c.mid.c),
        volume: c.volume,
      }));
  } catch (e) {
    console.warn(`[candles] OANDA fetch failed (${oandaSymbol} ${granularity}):`, String(e).slice(0, 120));
    return [];
  }
}

// ── テクニカル指標（純粋関数） ──

/**
 * RSI (Wilder's smoothing method)
 * 初期平均 → (prev * (period-1) + current) / period
 */
export function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50; // データ不足時はニュートラル

  // 変化量を算出
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // 初期平均（最初のperiod個）
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder平滑
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * ADX (Average Directional Index)
 * +DI, -DI → DX → ADX (Wilder平滑)
 */
export function calcADX(candles: CandleData[], period = 14): number {
  if (candles.length < period * 2) return 25; // データ不足時はニュートラル

  // True Range, +DM, -DM を算出
  const trList: number[] = [];
  const plusDMList: number[] = [];
  const minusDMList: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;

    // True Range
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trList.push(tr);

    // Directional Movement
    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    plusDMList.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMList.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder平滑で初期値を計算
  let smoothTR = 0;
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;
  for (let i = 0; i < period; i++) {
    smoothTR += trList[i];
    smoothPlusDM += plusDMList[i];
    smoothMinusDM += minusDMList[i];
  }

  // DXの配列を作る
  const dxList: number[] = [];

  const calcDX = (sTR: number, sPDM: number, sMDM: number): number => {
    if (sTR === 0) return 0;
    const plusDI = 100 * sPDM / sTR;
    const minusDI = 100 * sMDM / sTR;
    const diSum = plusDI + minusDI;
    return diSum === 0 ? 0 : 100 * Math.abs(plusDI - minusDI) / diSum;
  };

  dxList.push(calcDX(smoothTR, smoothPlusDM, smoothMinusDM));

  // Wilder平滑で残りを計算
  for (let i = period; i < trList.length; i++) {
    smoothTR = smoothTR - smoothTR / period + trList[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMList[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMList[i];
    dxList.push(calcDX(smoothTR, smoothPlusDM, smoothMinusDM));
  }

  if (dxList.length < period) return 25;

  // ADX = DXのWilder平滑
  let adx = 0;
  for (let i = 0; i < period; i++) {
    adx += dxList[i];
  }
  adx /= period;

  for (let i = period; i < dxList.length; i++) {
    adx = (adx * (period - 1) + dxList[i]) / period;
  }

  return adx;
}

/**
 * ATR (Average True Range)
 * True Range → Wilder平滑
 */
export function calcATR(candles: CandleData[], period = 14): number {
  if (candles.length < period + 1) return 0;

  const trList: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trList.push(tr);
  }

  // 初期ATR = 最初のperiod個の平均
  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trList[i];
  }
  atr /= period;

  // Wilder平滑
  for (let i = period; i < trList.length; i++) {
    atr = (atr * (period - 1) + trList[i]) / period;
  }

  return atr;
}

/**
 * EMA (指数加重移動平均)
 * 最新値を返す
 */
export function calcEMA(values: number[], period: number): number {
  if (values.length === 0) return 0;
  if (values.length < period) {
    // データ不足時はSMAで代用
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  // 最初のperiod個のSMAを初期値とする
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += values[i];
  }
  ema /= period;

  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * Bollinger Bands
 * middle = SMA(period), upper/lower = middle ± mult * σ
 */
export function calcBB(
  closes: number[],
  period = 20,
  mult = 2
): { upper: number; lower: number; middle: number } {
  if (closes.length < period) {
    const avg = closes.length > 0
      ? closes.reduce((a, b) => a + b, 0) / closes.length
      : 0;
    return { upper: avg, lower: avg, middle: avg };
  }

  // 直近period個でSMAとσを計算
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;

  let variance = 0;
  for (const v of slice) {
    variance += (v - middle) ** 2;
  }
  variance /= period;
  const stddev = Math.sqrt(variance);

  return {
    upper: middle + mult * stddev,
    lower: middle - mult * stddev,
    middle,
  };
}

// ── テクニカル指標一括算出 ──

export function calcAllIndicators(candles: CandleData[]): TechnicalIndicators {
  const closes = candles.map((c) => c.close);

  const rsi14 = calcRSI(closes, 14);
  const adx14 = calcADX(candles, 14);
  const atr14 = calcATR(candles, 14);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const bb = calcBB(closes, 20, 2);

  return {
    rsi14,
    adx14,
    atr14,
    ema20,
    ema50,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbMiddle: bb.middle,
  };
}

// ── キャッシュ付きメイン関数 ──

/** キャッシュTTL (ミリ秒) */
const CACHE_TTL: Record<string, number> = {
  H1: 60 * 60 * 1000,       // 60分
  H4: 4 * 60 * 60 * 1000,   // 4時間
  D: 24 * 60 * 60 * 1000,   // 24時間
};

const EMPTY_INDICATORS: TechnicalIndicators = {
  rsi14: 50,
  adx14: 25,
  atr14: 0,
  ema20: 0,
  ema50: 0,
  bbUpper: 0,
  bbLower: 0,
  bbMiddle: 0,
};

interface CachedIndicator {
  indicators: TechnicalIndicators;
  updatedAt: string;
}

async function getIndicatorsWithCache(
  db: D1Database,
  oandaToken: string,
  accountId: string,
  isLive: boolean,
  oandaSymbol: string,
  granularity: 'H1' | 'H4' | 'D'
): Promise<TechnicalIndicators> {
  const cacheKey = `candle_${oandaSymbol}_${granularity}`;
  const ttl = CACHE_TTL[granularity];

  // キャッシュ読み出し
  try {
    const row = await db
      .prepare('SELECT value, updated_at FROM market_cache WHERE key = ?')
      .bind(cacheKey)
      .first<{ value: string; updated_at: string }>();

    if (row) {
      const age = Date.now() - new Date(row.updated_at).getTime();
      if (age < ttl) {
        const cached = JSON.parse(row.value) as CachedIndicator;
        return cached.indicators;
      }
    }
  } catch {
    // キャッシュ読み出し失敗は無視して取得に進む
  }

  // OANDA APIからキャンドル取得
  const candles = await fetchOandaCandles(
    oandaToken,
    accountId,
    isLive,
    oandaSymbol,
    granularity,
    50
  );

  if (candles.length === 0) {
    return { ...EMPTY_INDICATORS };
  }

  // テクニカル指標算出
  const indicators = calcAllIndicators(candles);

  // キャッシュ保存
  try {
    const cacheValue: CachedIndicator = {
      indicators,
      updatedAt: new Date().toISOString(),
    };
    await db
      .prepare(
        `INSERT INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .bind(cacheKey, JSON.stringify(cacheValue), new Date().toISOString())
      .run();
  } catch (e) {
    console.warn(`[candles] Cache write failed (${cacheKey}):`, String(e).slice(0, 100));
  }

  return indicators;
}

export async function getTechnicalIndicators(
  db: D1Database,
  oandaToken: string,
  accountId: string,
  isLive: boolean,
  oandaSymbol: string
): Promise<{ h1: TechnicalIndicators; h4: TechnicalIndicators; daily: TechnicalIndicators }> {
  const [h1, h4, daily] = await Promise.all([
    getIndicatorsWithCache(db, oandaToken, accountId, isLive, oandaSymbol, 'H1'),
    getIndicatorsWithCache(db, oandaToken, accountId, isLive, oandaSymbol, 'H4'),
    getIndicatorsWithCache(db, oandaToken, accountId, isLive, oandaSymbol, 'D'),
  ]);

  return { h1, h4, daily };
}

// ── バッチ更新（日次タスク用） ──

export async function updateAllCandles(
  db: D1Database,
  oandaToken: string,
  accountId: string,
  isLive: boolean,
  instruments: Array<{ oandaSymbol: string | null }>
): Promise<void> {
  // oandaSymbol == null の銘柄をスキップ
  const targets = instruments.filter(
    (i): i is { oandaSymbol: string } => i.oandaSymbol != null
  );

  if (targets.length === 0) return;

  const granularities: Array<'H1' | 'H4' | 'D'> = ['D', 'H4', 'H1'];

  // 全タスクを生成
  const tasks: Array<() => Promise<void>> = [];
  for (const inst of targets) {
    for (const g of granularities) {
      tasks.push(async () => {
        await getIndicatorsWithCache(
          db,
          oandaToken,
          accountId,
          isLive,
          inst.oandaSymbol,
          g
        );
      });
    }
  }

  // 最大5並列で実行
  const concurrency = 5;
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    await Promise.allSettled(batch.map((fn) => fn()));
  }
}

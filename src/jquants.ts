// src/jquants.ts
// J-Quants V2 API クライアント
// 認証: リフレッシュトークン → IDトークン（24時間有効）
// market_cache テーブルに 'jquants_id_token' でキャッシュ

import type { D1Database } from '@cloudflare/workers-types';

const JQUANTS_BASE = 'https://api.jquants.com/v1';
const TOKEN_CACHE_KEY = 'jquants_id_token';
const TOKEN_TTL_HOURS = 23; // 24h有効だが余裕を持って23hでリフレッシュ

export interface FundamentalsData {
  symbol: string;         // '7203.T'
  fiscalYear: string;     // '2026'
  fiscalQuarter: string;  // 'Q1'/'Q2'/'Q3'/'FY'
  eps: number | null;
  bps: number | null;
  revenue: number | null;       // 百万円
  opProfit: number | null;      // 百万円
  netProfit: number | null;     // 百万円
  forecastRev: number | null;
  forecastOp: number | null;
  forecastNet: number | null;
  dividend: number | null;
  equityRatio: number | null;   // %
  nextEarnings: string | null;  // ISO8601 date
  sector: string | null;
  marketCap: number | null;     // 百万円
}

export interface ScreeningCandidate {
  symbol: string;
  marketCap: number | null;   // 百万円
  sector: string | null;
  netProfit: number | null;
}

/** IDトークンを取得（market_cacheから取得 or リフレッシュ） */
async function getIdToken(db: D1Database, refreshToken: string): Promise<string> {
  // キャッシュ確認
  const cached = await db
    .prepare("SELECT value, updated_at FROM market_cache WHERE key = ?")
    .bind(TOKEN_CACHE_KEY)
    .first<{ value: string; updated_at: string }>();

  if (cached) {
    const updatedAt = new Date(cached.updated_at);
    const hoursOld = (Date.now() - updatedAt.getTime()) / (1000 * 3600);
    if (hoursOld < TOKEN_TTL_HOURS) {
      return cached.value;
    }
  }

  // リフレッシュトークンでIDトークンを取得
  const res = await fetch(`${JQUANTS_BASE}/token/auth_refresh?refreshtoken=${refreshToken}`, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`J-Quants auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { idToken: string };
  const idToken = data.idToken;

  // キャッシュ保存
  await db
    .prepare("INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(TOKEN_CACHE_KEY, idToken, new Date().toISOString())
    .run();

  return idToken;
}

/** 指定銘柄リストの最新財務データを取得 */
export async function fetchFundamentals(
  db: D1Database,
  refreshToken: string,
  symbols: string[]   // ['7203.T', '8035.T', ...]
): Promise<FundamentalsData[]> {
  if (symbols.length === 0) return [];

  let idToken: string;
  try {
    idToken = await getIdToken(db, refreshToken);
  } catch (e) {
    console.error('[jquants] getIdToken failed:', e);
    return [];
  }

  const results: FundamentalsData[] = [];

  // 銘柄ごとに取得
  for (const symbol of symbols) {
    try {
      // J-Quants V2の銘柄コード: 4桁 (例: '7203' from '7203.T')
      const code = symbol.replace('.T', '');
      const url = `${JQUANTS_BASE}/fins/statements?code=${code}`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${idToken}` },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        console.warn(`[jquants] fetchFundamentals failed for ${symbol}: ${res.status}`);
        continue;
      }

      const data = await res.json() as {
        statements?: Array<{
          Code: string;
          FiscalYear: string;
          TypeOfDocument: string;
          EarningsPerShare: string;
          BookValuePerShare: string;
          NetSales: string;
          OperatingProfit: string;
          NetIncome: string;
          ForecastNetSales: string;
          ForecastOperatingProfit: string;
          ForecastNetIncome: string;
          AnnualDividendPerShare: string;
          EquityToAssetRatio: string;
          NextYearForecastEarningsPerShare: string;
          TypeOfCurrentPeriod: string;
        }>;
      };

      const stmts = data.statements ?? [];
      if (stmts.length === 0) continue;

      // 最新レコード（リストの先頭）
      const latest = stmts[0];
      const quarter = mapTypeOfDocument(latest.TypeOfDocument);

      results.push({
        symbol,
        fiscalYear: latest.FiscalYear ?? '',
        fiscalQuarter: quarter,
        eps: parseFloat(latest.EarningsPerShare) || null,
        bps: parseFloat(latest.BookValuePerShare) || null,
        revenue: parseFloat(latest.NetSales) || null,
        opProfit: parseFloat(latest.OperatingProfit) || null,
        netProfit: parseFloat(latest.NetIncome) || null,
        forecastRev: parseFloat(latest.ForecastNetSales) || null,
        forecastOp: parseFloat(latest.ForecastOperatingProfit) || null,
        forecastNet: parseFloat(latest.ForecastNetIncome) || null,
        dividend: parseFloat(latest.AnnualDividendPerShare) || null,
        equityRatio: parseFloat(latest.EquityToAssetRatio) || null,
        nextEarnings: null, // /fins/announcement で別途取得
        sector: null,
        marketCap: null, // Yahoo Financeから補完
      });

    } catch (e) {
      console.warn(`[jquants] error for ${symbol}:`, e);
    }
  }

  return results;
}

/** 週次スクリーニング: 全上場銘柄の財務サマリを取得（ページネーション対応） */
export async function fetchAllListedStocks(
  db: D1Database,
  refreshToken: string,
  pageToken?: string
): Promise<{ candidates: ScreeningCandidate[]; nextPageToken: string | null }> {
  let idToken: string;
  try {
    idToken = await getIdToken(db, refreshToken);
  } catch (e) {
    console.error('[jquants] getIdToken failed:', e);
    return { candidates: [], nextPageToken: null };
  }

  const url = pageToken
    ? `${JQUANTS_BASE}/listed/info?pagetoken=${pageToken}`
    : `${JQUANTS_BASE}/listed/info`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    console.error(`[jquants] fetchAllListedStocks failed: ${res.status}`);
    return { candidates: [], nextPageToken: null };
  }

  const data = await res.json() as {
    info?: Array<{
      Code: string;
      CompanyName: string;
      Sector17CodeName: string;
      MarketCapitalization?: string;
    }>;
    pagination_key?: string;
  };

  const candidates: ScreeningCandidate[] = (data.info ?? []).map(item => ({
    symbol: `${item.Code}.T`,
    marketCap: parseFloat(item.MarketCapitalization ?? '') || null,
    sector: item.Sector17CodeName ?? null,
    netProfit: null, // 別途fins/statementsで取得
  }));

  return {
    candidates,
    nextPageToken: data.pagination_key ?? null,
  };
}

/** 決算発表予定日を取得 */
export async function fetchEarningsAnnouncements(
  db: D1Database,
  refreshToken: string,
  symbol: string
): Promise<string | null> {
  let idToken: string;
  try {
    idToken = await getIdToken(db, refreshToken);
  } catch (e) {
    return null;
  }

  const code = symbol.replace('.T', '');
  const res = await fetch(`${JQUANTS_BASE}/fins/announcement?code=${code}`, {
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return null;

  const data = await res.json() as {
    announcement?: Array<{ PeriodEndDate: string; DisclosedDate: string }>;
  };

  const announcements = data.announcement ?? [];
  if (announcements.length === 0) return null;

  // 最も直近の予定日
  const future = announcements
    .filter(a => new Date(a.DisclosedDate) >= new Date())
    .sort((a, b) => a.DisclosedDate.localeCompare(b.DisclosedDate));

  return future[0]?.DisclosedDate ?? null;
}

/** TypeOfDocumentを四半期コードに変換 */
function mapTypeOfDocument(type: string): string {
  if (type.includes('FY') || type.includes('Annual')) return 'FY';
  if (type.includes('Q3') || type.includes('3Q')) return 'Q3';
  if (type.includes('Q2') || type.includes('2Q') || type.includes('Semi')) return 'Q2';
  if (type.includes('Q1') || type.includes('1Q')) return 'Q1';
  return 'FY';
}

/** D1のfundamentalsテーブルに保存（UPSERT） */
export async function saveFundamentals(
  db: D1Database,
  data: FundamentalsData[]
): Promise<void> {
  for (const f of data) {
    await db.prepare(`
      INSERT OR REPLACE INTO fundamentals
        (symbol, fiscal_year, fiscal_quarter, eps, bps, revenue, op_profit, net_profit,
         forecast_rev, forecast_op, forecast_net, dividend, equity_ratio,
         next_earnings, sector, market_cap, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      f.symbol, f.fiscalYear, f.fiscalQuarter,
      f.eps, f.bps, f.revenue, f.opProfit, f.netProfit,
      f.forecastRev, f.forecastOp, f.forecastNet,
      f.dividend, f.equityRatio, f.nextEarnings,
      f.sector, f.marketCap, new Date().toISOString()
    ).run();
  }
}

/** 直近2期分のnet_profitを返す（2期連続赤字判定用） */
export async function getRecentNetProfits(
  db: D1Database,
  symbol: string
): Promise<number[]> {
  const rows = await db.prepare(`
    SELECT net_profit FROM fundamentals
    WHERE symbol = ?
    ORDER BY fiscal_year DESC, fiscal_quarter DESC
    LIMIT 2
  `).bind(symbol).all<{ net_profit: number | null }>();

  return (rows.results ?? [])
    .map(r => r.net_profit)
    .filter((v): v is number => v !== null);
}

/** 3期以上前のデータを削除（クリーンアップ） */
export async function cleanupOldFundamentals(db: D1Database): Promise<void> {
  // 各銘柄で最新2件以外を削除
  await db.prepare(`
    DELETE FROM fundamentals
    WHERE rowid NOT IN (
      SELECT rowid FROM fundamentals f2
      WHERE f2.symbol = fundamentals.symbol
      ORDER BY fiscal_year DESC, fiscal_quarter DESC
      LIMIT 2
    )
  `).run().catch(e => console.warn('[jquants] cleanupOldFundamentals:', e));
}

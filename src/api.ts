// GET /api/status — D1から全ダッシュボードデータをJSON返却

import type { Position } from './db';
import { fetchNews } from './news';

export interface LatestDecision {
  id: number;
  pair: string;
  decision: string;
  rate: number;
  reasoning: string | null;
  vix: number | null;
  us10y: number | null;
  nikkei: number | null;
  sp500: number | null;
  created_at: string;
}

export interface RecentDecision {
  id: number;
  pair: string;
  decision: string;
  rate: number;
  reasoning: string | null;
  news_summary: string | null;
  reddit_signal: string | null;
  vix: number | null;
  us10y: number | null;
  created_at: string;
}

export interface SystemLog {
  id: number;
  level: string;
  category: string;
  message: string;
  detail: string | null;
  created_at: string;
}

export interface LogStats {
  totalRuns: number;
  geminiCalls: number;
  holdCount: number;
  errorCount: number;
  lastRun: string | null;
}

export interface SparkPoint {
  rate: number;
  created_at: string;
}

export interface PairPerf {
  total: number;
  wins: number;
  totalPnl: number;
}

export interface StatusResponse {
  rate: number | null;
  openPositions: Position[];
  performance: {
    totalPnl: number;
    todayPnl: number;
    winRate: number;
    totalClosed: number;
    wins: number;
  };
  latestDecision: LatestDecision | null;
  recentDecisions: RecentDecision[];
  systemStatus: {
    lastRun: string | null;
    totalRuns: number;
  };
  sparklines: Record<string, SparkPoint[]>;
  performanceByPair: Record<string, PairPerf>;
  recentCloses: Position[];
  systemLogs: SystemLog[];
  logStats: LogStats;
  latestNews: Array<{ title: string; pubDate: string; description: string }>;
  newsAnalysis: Array<{ index: number; attention: boolean; impact: string | null; title_ja: string | null }>;
}

export async function getApiStatus(db: D1Database): Promise<StatusResponse> {
  const [rateRow, openPositions, perf, latest, recent, sysRow, sparkRaw, perfByPairRaw, recentClosesRaw, newsRaw, sysLogsRaw, logStatsRaw] =
    await Promise.all([
      db
        .prepare("SELECT value FROM market_cache WHERE key = 'prev_rate_USD/JPY'")
        .first<{ value: string }>(),

      db
        .prepare("SELECT * FROM positions WHERE status = 'OPEN'")
        .all<Position>(),

      db
        .prepare(
          `SELECT
             COALESCE(SUM(pnl), 0)                                                         AS totalPnl,
             COALESCE(SUM(CASE WHEN date(closed_at) = date('now') THEN pnl ELSE 0 END), 0) AS todayPnl,
             COUNT(*)                                                                        AS totalClosed,
             COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0)                         AS wins
           FROM positions WHERE status = 'CLOSED'`
        )
        .first<{ totalPnl: number; todayPnl: number; totalClosed: number; wins: number }>(),

      // 最新判断（マーケット概況用にnikkei/sp500含む）
      db
        .prepare(
          `SELECT id, pair, decision, rate, reasoning, vix, us10y, nikkei, sp500, created_at
           FROM decisions ORDER BY id DESC LIMIT 1`
        )
        .first<LatestDecision>(),

      // 判定履歴（BUY/SELLのみ直近20件）
      db
        .prepare(
          `SELECT id, pair, decision, rate, reasoning, news_summary, reddit_signal, vix, us10y, created_at
           FROM decisions WHERE decision != 'HOLD' ORDER BY id DESC LIMIT 20`
        )
        .all<RecentDecision>(),

      db
        .prepare(`SELECT COUNT(*) AS cnt, MAX(created_at) AS lastRun FROM decisions`)
        .first<{ cnt: number; lastRun: string }>(),

      // スパークライン: 銘柄ごとの直近レート推移（全判断を使用）
      db
        .prepare(
          `SELECT pair, rate, created_at FROM decisions
           WHERE pair IN ('USD/JPY','Nikkei225','S&P500','US10Y','BTC/USD','Gold','EUR/USD','ETH/USD','CrudeOil','NatGas','Copper','Silver','GBP/USD','AUD/USD','SOL/USD','DAX','NASDAQ')
           ORDER BY id DESC LIMIT 80`
        )
        .all<{ pair: string; rate: number; created_at: string }>(),

      // 銘柄別パフォーマンス
      db
        .prepare(
          `SELECT pair,
             COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
             COALESCE(SUM(pnl), 0) AS totalPnl
           FROM positions WHERE status = 'CLOSED'
           GROUP BY pair`
        )
        .all<{ pair: string; total: number; wins: number; totalPnl: number }>(),

      // 直近クローズ（TP祝福検出 + 銘柄別履歴用）
      db
        .prepare(`SELECT * FROM positions WHERE status = 'CLOSED' ORDER BY closed_at DESC LIMIT 30`)
        .all<Position>(),

      // 直近ニュースサマリー（news_summaryがある最新5件）
      db
        .prepare(`SELECT news_summary FROM decisions WHERE news_summary IS NOT NULL ORDER BY id DESC LIMIT 5`)
        .all<{ news_summary: string }>(),

      // システムログ（直近30件）
      db
        .prepare(`SELECT id, level, category, message, detail, created_at FROM system_logs ORDER BY id DESC LIMIT 30`)
        .all<SystemLog>(),

      // ログ統計
      db
        .prepare(`SELECT
           COUNT(*) AS totalRuns,
           SUM(CASE WHEN decision != 'HOLD' THEN 1 ELSE 0 END) AS geminiCalls,
           SUM(CASE WHEN decision = 'HOLD' THEN 1 ELSE 0 END) AS holdCount,
           MAX(created_at) AS lastRun
           FROM decisions`)
        .first<{ totalRuns: number; geminiCalls: number; holdCount: number; lastRun: string }>(),
    ]);

  const rate = rateRow ? parseFloat(rateRow.value) : null;
  const totalClosed = perf?.totalClosed ?? 0;
  const wins = perf?.wins ?? 0;

  // スパークラインを銘柄別にグループ化（降順→時系列に反転）
  const sparklines: Record<string, SparkPoint[]> = {};
  for (const row of (sparkRaw.results ?? [])) {
    if (!sparklines[row.pair]) sparklines[row.pair] = [];
    sparklines[row.pair].push({ rate: row.rate, created_at: row.created_at });
  }
  // 各銘柄を時系列順（古い順）に並び替え
  for (const pair of Object.keys(sparklines)) {
    sparklines[pair] = sparklines[pair].reverse();
  }

  // 銘柄別パフォーマンスをRecord化
  const performanceByPair: Record<string, PairPerf> = {};
  for (const row of (perfByPairRaw.results ?? [])) {
    performanceByPair[row.pair] = { total: row.total, wins: row.wins, totalPnl: row.totalPnl };
  }

  const sysLogs = sysLogsRaw.results ?? [];

  // ニュースをリアルタイム取得（DB依存を廃止）
  let latestNews: Array<{ title: string; pubDate: string; description: string }> = [];
  try {
    latestNews = await fetchNews();
  } catch {
    // フォールバック: DBのnews_summaryから取得
    type NewsEntry = { title: string; pubDate: string; description: string };
    for (const row of (newsRaw.results ?? [])) {
      try {
        let parsed = JSON.parse(row.news_summary);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        if (Array.isArray(parsed)) { latestNews = parsed; break; }
      } catch {}
    }
  }

  return {
    rate,
    openPositions: openPositions.results ?? [],
    performance: {
      totalPnl: perf?.totalPnl ?? 0,
      todayPnl: perf?.todayPnl ?? 0,
      winRate: totalClosed > 0 ? (wins / totalClosed) * 100 : 0,
      totalClosed,
      wins,
    },
    latestDecision: latest ?? null,
    recentDecisions: recent.results ?? [],
    systemStatus: {
      lastRun: sysRow?.lastRun ?? null,
      totalRuns: sysRow?.cnt ?? 0,
    },
    sparklines,
    performanceByPair,
    recentCloses: recentClosesRaw.results ?? [],
    latestNews,
    newsAnalysis: await getNewsAnalysis(db),
    systemLogs: sysLogs,
    logStats: {
      totalRuns: logStatsRaw?.totalRuns ?? 0,
      geminiCalls: logStatsRaw?.geminiCalls ?? 0,
      holdCount: logStatsRaw?.holdCount ?? 0,
      errorCount: sysLogs.filter(l => l.level === 'ERROR').length,
      lastRun: logStatsRaw?.lastRun ?? null,
    },
  };
}

async function getNewsAnalysis(db: D1Database): Promise<Array<{ index: number; attention: boolean; impact: string | null }>> {
  try {
    const row = await db.prepare("SELECT value FROM market_cache WHERE key = 'news_analysis'").first<{ value: string }>();
    if (row) return JSON.parse(row.value);
  } catch {}
  return [];
}

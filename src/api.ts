// GET /api/status — D1から全ダッシュボードデータをJSON返却

import type { Position } from './db';
import { fetchNews } from './news';
import { getRiskStatus, type RiskEnv } from './risk-guard';
import { wilsonCI, sharpeWithSE, varCvar, kellyFraction, markovTransition, maxDrawdown, rollingReturns, pnlVolatility, profitFactor, bootstrapROI, aiAccuracy, randomBaselineComparison, pairCorrelation, logReturnStats, powerAnalysis } from './stats';

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
  warnCount: number;
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
  latestNews: Array<{ title: string; pubDate: string; description: string; source?: string }>;
  newsAnalysis: Array<{ index: number; attention: boolean; impact: string | null; title_ja: string | null; title?: string | null }>;
  tradingMode: 'paper' | 'demo' | 'live';
  riskStatus: {
    killSwitchActive: boolean;
    todayLoss: number;
    maxDailyLoss: number;
    livePositions: number;
    maxPositions: number;
  } | null;
  instrumentScores: Array<{
    pair: string;
    total_trades: number;
    win_rate: number;
    avg_rr: number;
    sharpe: number;
    score: number;
    updated_at: string | null;
  }>;
  statistics: {
    winRateCI: { lower: number; upper: number };
    roiCI: { roi: number; ciLower: number; ciUpper: number; n: number };
    aiAccuracy: { accuracy: number; brierScore: number; n: number; wins: number } | null;
    sharpe: number;
    sharpeSE: number;
    sharpeSignificant: boolean;
    var95: number;
    cvar95: number;
    kellyFraction: number;
    markov: { ww: number; wl: number; lw: number; ll: number; streakProb3: number };
    drawdown: { maxDD: number; maxDDPct: number; currentDD: number; currentDDPct: number; recoveryRatio: number };
    rolling: Record<number, { roi: number; sharpe: number; winRate: number; count: number }>;
    volatility: { overallStd: number; recentStd: number; volRatio: number; isHighVol: boolean };
    profitFactor: number;
    randomBaseline: { mwu: { u: number; z: number; pValue: number; significant: boolean }; randomMean: number; aiMean: number; beatRate: number } | null;
    pairCorrelations: Array<{ pair1: string; pair2: string; r: number; n: number }>;
    logReturnStats: { mean: number; stdev: number; skewness: number; kurtosis: number } | null;
    powerAnalysis: { requiredN: number; currentN: number; currentWinRate: number; progressPct: number; isAdequate: boolean } | null;
  } | null;
  slPatterns: Array<{
    vixBucket: string; session: string; pairCategory: string;
    slCount: number; totalCount: number; slRate: number;
  }>;
}

export async function getApiStatus(db: D1Database, tradingEnv?: { TRADING_ENABLED?: string; OANDA_LIVE?: string; RISK_MAX_DAILY_LOSS?: string; RISK_MAX_LIVE_POSITIONS?: string; RISK_MAX_LOT_SIZE?: string; RISK_ANOMALY_THRESHOLD?: string }): Promise<StatusResponse> {
  const [rateRow, openPositions, perf, latest, recent, sysRow, sparkRaw, perfByPairRaw, recentClosesRaw, newsRaw, sysLogsRaw, logStatsRaw, instrScoresRaw, slPatternsRow] =
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

      // 銘柄スコア
      db
        .prepare(`SELECT pair, total_trades, win_rate, avg_rr, sharpe, score, updated_at FROM instrument_scores ORDER BY score DESC`)
        .all<{ pair: string; total_trades: number; win_rate: number; avg_rr: number; sharpe: number; score: number; updated_at: string | null }>(),

      // SLパターン（日次バッチ結果）
      db.prepare("SELECT value FROM market_cache WHERE key = 'sl_patterns'")
        .first<{ value: string }>(),
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

  // ニュースをリアルタイム取得
  let latestNews: Array<{ title: string; pubDate: string; description: string; source?: string }> = [];
  try {
    const newsResult = await fetchNews();
    latestNews = newsResult.items;
  } catch {
    for (const row of (newsRaw.results ?? [])) {
      try {
        let parsed = JSON.parse(row.news_summary);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        if (Array.isArray(parsed)) { latestNews = parsed; break; }
      } catch {}
    }
  }

  // トレーディングモード判定
  const tradingMode: 'paper' | 'demo' | 'live' =
    tradingEnv?.TRADING_ENABLED === 'true'
      ? (tradingEnv?.OANDA_LIVE === 'true' ? 'live' : 'demo')
      : 'paper';

  // RiskGuard状態（実弾モード時のみ取得）
  let riskStatus: StatusResponse['riskStatus'] = null;
  if (tradingMode !== 'paper') {
    try {
      riskStatus = await getRiskStatus(db, tradingEnv as RiskEnv);
    } catch {}
  }

  // 統計計算（T003: 統計学的信頼性）
  let statistics: StatusResponse['statistics'] = null;
  if (totalClosed >= 10) {
    try {
      const [allPnlRaw, aiOutcomesRaw] = await Promise.all([
        db.prepare('SELECT pnl, log_return FROM positions WHERE status = \'CLOSED\' ORDER BY closed_at ASC')
          .all<{ pnl: number; log_return: number | null }>(),
        db.prepare('SELECT outcome FROM decisions WHERE decision IN (\'BUY\',\'SELL\') AND outcome IS NOT NULL ORDER BY id ASC')
          .all<{ outcome: string }>(),
      ]);

      const allPnlRows = allPnlRaw.results ?? [];
      const allPnls = allPnlRows.map(r => r.pnl);
      const logReturns = allPnlRows
        .map(r => r.log_return)
        .filter((v): v is number => v != null);
      const outcomes = allPnls.map(p => p > 0);

      const ci = wilsonCI(wins, totalClosed);
      const sharpeResult = sharpeWithSE(allPnls);
      const risk = varCvar(allPnls);

      const winPnls = allPnls.filter(p => p > 0);
      const losePnls = allPnls.filter(p => p <= 0);
      const avgWin = winPnls.length > 0 ? winPnls.reduce((s, v) => s + v, 0) / winPnls.length : 0;
      const avgLoss = losePnls.length > 0 ? Math.abs(losePnls.reduce((s, v) => s + v, 0) / losePnls.length) : 1;
      const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;

      const aiOutcomes = (aiOutcomesRaw.results ?? []).map(r => r.outcome as 'WIN' | 'LOSE');
      const aiResult = aiOutcomes.length >= 5 ? aiAccuracy(aiOutcomes) : null;

      // 銘柄別PnL（相関行列用）
      const pnlByPairRawForCorr = await db.prepare(
        'SELECT pair, pnl FROM positions WHERE status = \'CLOSED\' ORDER BY pair, closed_at ASC'
      ).all<{ pair: string; pnl: number }>();
      const pnlByPair: Record<string, number[]> = {};
      for (const r of pnlByPairRawForCorr.results ?? []) {
        (pnlByPair[r.pair] ??= []).push(r.pnl);
      }

      statistics = {
        winRateCI: ci,
        roiCI: bootstrapROI(allPnls),
        aiAccuracy: aiResult,
        sharpe: sharpeResult.sharpe,
        sharpeSE: sharpeResult.se,
        sharpeSignificant: sharpeResult.significant,
        var95: risk.var95,
        cvar95: risk.cvar95,
        kellyFraction: kellyFraction(wins / totalClosed, avgRR),
        markov: markovTransition(outcomes),
        drawdown: maxDrawdown(allPnls),
        rolling: rollingReturns(allPnls, [7, 14, 30]),
        volatility: pnlVolatility(allPnls),
        profitFactor: profitFactor(allPnls),
        randomBaseline: allPnls.length >= 10 ? randomBaselineComparison(allPnls) : null,
        pairCorrelations: pairCorrelation(pnlByPair),
        logReturnStats: logReturns.length >= 4 ? logReturnStats(logReturns) : null,
        powerAnalysis: powerAnalysis(totalClosed, wins),
      };
    } catch {}
  }

  // 分析データ取得 → ニュースリストとマージ（分析のtitleがlatestNewsに存在しなければ先頭に挿入）
  const { items: newsAnalysis, updatedAt: analysisUpdatedAt } = await getNewsAnalysis(db);
  const existingTitles = new Set(latestNews.map(n => n.title));
  for (const a of newsAnalysis) {
    if (a.title && !existingTitles.has(a.title) && a.attention) {
      // 注目ニュースのみマージ（impact情報があるため詳細表示に価値がある）
      const pubDate = a.pubDate || (a as any).pubDate || analysisUpdatedAt || '';
      const desc = (a as any).description || a.impact || '';
      const source = (a as any).source || undefined;
      latestNews.unshift({ title: a.title, pubDate, description: desc, source });
      existingTitles.add(a.title);
    }
  }
  // 30件に制限（分析マッチ済みニュースが先頭にあるため切り捨ては末尾から）
  if (latestNews.length > 30) latestNews.length = 30;

  return {
    rate,
    tradingMode,
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
    riskStatus,
    instrumentScores: instrScoresRaw.results ?? [],
    latestNews,
    newsAnalysis,
    systemLogs: sysLogs,
    logStats: {
      totalRuns: logStatsRaw?.totalRuns ?? 0,
      geminiCalls: logStatsRaw?.geminiCalls ?? 0,
      holdCount: logStatsRaw?.holdCount ?? 0,
      errorCount: sysLogs.filter(l => l.level === 'ERROR').length,
      warnCount: sysLogs.filter(l => l.level === 'WARN').length,
      lastRun: logStatsRaw?.lastRun ?? null,
    },
    statistics,
    slPatterns: (() => {
      try { return slPatternsRow ? JSON.parse(slPatternsRow.value) : []; } catch { return []; }
    })(),
  };
}

async function getNewsAnalysis(db: D1Database): Promise<{
  items: Array<{ index: number; attention: boolean; impact: string | null; title_ja: string | null; title?: string | null; pubDate?: string | null }>;
  updatedAt: string | null;
}> {
  try {
    const row = await db.prepare("SELECT value, updated_at FROM market_cache WHERE key = 'news_analysis'").first<{ value: string; updated_at: string }>();
    if (row) return { items: JSON.parse(row.value), updatedAt: row.updated_at };
  } catch {}
  return { items: [], updatedAt: null };
}

// GET /api/status — D1から全ダッシュボードデータをJSON返却

import type { Position } from './db';
// fetchNewsはcron側の責務。API側はlatest_newsキャッシュのみ参照
import { getRiskStatus, type RiskEnv } from './risk-guard';
import { wilsonCI, sharpeWithSE, varCvar, kellyFraction, markovTransition, maxDrawdown, rollingReturns, pnlVolatility, profitFactor, bootstrapROI, aiAccuracy, randomBaselineComparison, pairCorrelation, logReturnStats, powerAnalysis, ewmaVolatility, engleGrangerCointegration, hierarchicalWinRate } from './stats';

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
  tp_rate: number | null;
  sl_rate: number | null;
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
    todayWins: number;
    todayLosses: number;
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
  acceptedNews: Array<{ id: number; source: string; title_ja: string; desc_ja: string; url: string | null; fetched_at: string }>;
  newsAnalysis: Array<{ index: number; attention: boolean; impact: string | null; title_ja: string | null; title?: string | null }>;
  tradingMode: 'paper' | 'demo' | 'live';
  riskStatus: {
    killSwitchActive: boolean;
    todayLoss: number;
    maxDailyLoss: number;
    weeklyLoss: number;
    maxWeeklyLoss: number;
    weeklyExceeded: boolean;
    monthlyLoss: number;
    maxMonthlyLoss: number;
    monthlyExceeded: boolean;
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
    ewmaVol: { sigma2: number; sigmaAnnualized: number; forecastSigma2: number; isHighVol: boolean } | null;
    cointegrationPairs: Array<{ name: string; residualADF: number; cointegrated: boolean; sampleN: number }>;
    hierarchicalWinRates: Array<{ pair: string; rawRate: number; bayesRate: number; n: number }>;
  } | null;
  slPatterns: Array<{
    vixBucket: string; session: string; pairCategory: string;
    slCount: number; totalCount: number; slRate: number;
  }>;
  cronTimings: {
    fetchMs: number;
    tpSlMs: number;
    newsMs: number;
    aiLoopMs: number;
    totalMs: number;
  } | null;
  /** IPA品質修正: LIMITに依存しない今日の判断件数（UTC基準） */
  todayDecisionCount: number;
  todayBuyCount: number;
  todaySellCount: number;
  /** Ph.6: 因果サマリー — ナラティブ+キードライバー+ヒートマップ */
  causalSummary: {
    narrative: string;
    drivers: {
      profitTop: { pair: string; pnl: number; reason: string } | null;
      lossTop: { pair: string; pnl: number; reason: string } | null;
      factors: Array<{
        type: 'vix' | 'macro' | 'param_review' | 'news' | 'trailing' | 'delisted';
        label: string;
        severity: 'high' | 'medium' | 'low';
      }>;
    };
    heatmap: Array<{
      pair: string;
      pnlToday: number;
      factors: Record<string, number>;
    }>;
  } | null;
  /** テスタ施策21: 戦略マップデータ */
  strategyMap: {
    strategyStats: Array<{
      strategy: string | null;
      regime: string | null;
      count: number;
      wins: number;
      winRate: number;
      avgPnl: number;
      reliability: 'trusted' | 'tentative' | 'reference';
    }>;
    instrumentTiers: Array<{ pair: string; tier: string; multiplier: number }>;
  } | null;
}

export async function getApiStatus(db: D1Database, tradingEnv?: { TRADING_ENABLED?: string; OANDA_LIVE?: string; RISK_MAX_DAILY_LOSS?: string; RISK_MAX_LIVE_POSITIONS?: string; RISK_MAX_LOT_SIZE?: string; RISK_ANOMALY_THRESHOLD?: string }): Promise<StatusResponse> {
  const [rateRow, openPositions, perf, latest, recent, sysRow, sparkRaw, perfByPairRaw, recentClosesRaw, acceptedNewsRaw, sysLogsRaw, logStatsRaw, instrScoresRaw, slPatternsRow, cronTimingsRow, todayDecisionCountRow] =
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
             COALESCE(SUM(pnl), 0)                                                                          AS totalPnl,
             COALESCE(SUM(CASE WHEN date(closed_at) = date('now') THEN pnl ELSE 0 END), 0)                 AS todayPnl,
             COUNT(*)                                                                                        AS totalClosed,
             COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0)                                        AS wins,
             COALESCE(SUM(CASE WHEN date(closed_at) = date('now') AND pnl > 0 THEN 1 ELSE 0 END), 0)      AS todayWins,
             COALESCE(SUM(CASE WHEN date(closed_at) = date('now') AND pnl <= 0 THEN 1 ELSE 0 END), 0)     AS todayLosses
           FROM positions WHERE status = 'CLOSED'`
        )
        .first<{ totalPnl: number; todayPnl: number; totalClosed: number; wins: number; todayWins: number; todayLosses: number }>(),

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
          `SELECT id, pair, decision, rate, reasoning, news_summary, reddit_signal, vix, us10y, tp_rate, sl_rate, created_at
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

      // news_raw から採用記事（最大30件、7日TTL+purgeで自動管理）
      db
        .prepare(`SELECT id, source, title_ja, desc_ja, url, fetched_at FROM news_raw WHERE haiku_accepted = 1 ORDER BY id DESC LIMIT 30`)
        .all<{ id: number; source: string; title_ja: string; desc_ja: string; url: string | null; fetched_at: string }>(),

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
      // cronフェーズタイミング
      db
        .prepare("SELECT value FROM market_cache WHERE key = 'cron_phase_timings'")
        .first<{ value: string }>(),

      // ── IPA品質修正: 今日の判断数を専用COUNTクエリで取得（LIMIT 20 と独立） ──
      // recentDecisions は LIMIT 20 のため今日の全件数を正確に反映できない
      // UTC基準（DB date('now') と合わせる）
      db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN decision = 'BUY'  THEN 1 ELSE 0 END), 0) AS buyCount,
             COALESCE(SUM(CASE WHEN decision = 'SELL' THEN 1 ELSE 0 END), 0) AS sellCount
           FROM decisions WHERE decision != 'HOLD' AND date(created_at) = date('now')`
        )
        .first<{ total: number; buyCount: number; sellCount: number }>(),
    ]);

  const rate = rateRow ? parseFloat(rateRow.value) : null;
  const totalClosed = perf?.totalClosed ?? 0;
  const wins = perf?.wins ?? 0;

  const cronTimings = cronTimingsRow
    ? (() => { try { return JSON.parse(cronTimingsRow.value); } catch { return null; } })()
    : null;

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

  // ニュース: cron側のfilterAndTranslateWithHaikuで処理済みのlatest_newsキャッシュを使用
  // RSS直接取得はcron側の責務。API側はキャッシュのみ参照（日本語翻訳済み）
  let latestNews: Array<{ title: string; pubDate: string; description: string; source?: string }> = [];
  const knownTitles = new Set<string>();
  try {
    const cachedRaw = await db.prepare("SELECT value FROM market_cache WHERE key = 'latest_news'").first<{ value: string }>();
    if (cachedRaw?.value) {
      const cached: Array<{ title: string; title_ja?: string | null; desc_ja?: string | null; pubDate: string; description: string; source?: string }> = JSON.parse(cachedRaw.value);
      for (const item of cached) {
        const title = item.title_ja || item.title;
        const desc = item.desc_ja || item.description;
        if (title) {
          latestNews.push({ ...item, title, description: desc });
          knownTitles.add(title);
          if (item.title !== title) knownTitles.add(item.title); // 英語原題も記録（重複防止用）
        }
      }
    }
  } catch {}

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

      // EWMA ボラティリティ（positions.log_return から計算）
      const ewmaLogReturnsRaw = await db.prepare(
        'SELECT log_return FROM positions WHERE status = \'CLOSED\' AND log_return IS NOT NULL ORDER BY closed_at ASC'
      ).all<{ log_return: number }>();
      const ewmaLogReturns = (ewmaLogReturnsRaw.results ?? []).map(r => r.log_return);
      const ewmaVol = ewmaLogReturns.length >= 5 ? ewmaVolatility(ewmaLogReturns) : null;

      // 共和分検証（銘柄価格系列）
      const priceSeriesRaw = await db.prepare(
        `SELECT pair, rate FROM decisions
         WHERE pair IN ('EUR/USD','GBP/USD','Gold','Silver')
         ORDER BY pair, created_at ASC`
      ).all<{ pair: string; rate: number }>();
      const pricesByPair: Record<string, number[]> = {};
      for (const r of priceSeriesRaw.results ?? []) {
        (pricesByPair[r.pair] ??= []).push(r.rate);
      }
      const cointegrationPairs = [
        { name: 'EUR/USD vs GBP/USD', pair1: 'EUR/USD', pair2: 'GBP/USD' },
        { name: 'Gold vs Silver',     pair1: 'Gold',     pair2: 'Silver'  },
      ].map(({ name, pair1, pair2 }) => {
        const x = pricesByPair[pair1] ?? [];
        const y = pricesByPair[pair2] ?? [];
        return { name, ...engleGrangerCointegration(x, y) };
      });

      // 階層ベイズ勝率推定
      const pairWinData = (perfByPairRaw.results ?? []).map(r => ({
        pair: r.pair,
        wins: r.wins,
        total: r.total,
      }));

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
        ewmaVol,
        cointegrationPairs,
        hierarchicalWinRates: hierarchicalWinRate(pairWinData),
      };
    } catch {}
  }

  // 分析データ取得 → ニュースリストとマージ（分析のtitleがlatestNewsに存在しなければ先頭に挿入）
  // knownTitlesには英語原題+日本語タイトル両方が入っているため、翻訳済み記事の重複挿入を防止
  const { items: newsAnalysis, updatedAt: analysisUpdatedAt } = await getNewsAnalysis(db);
  for (const a of newsAnalysis) {
    const title = a.title_ja || a.title;
    if (title && !knownTitles.has(a.title || '') && !knownTitles.has(title) && a.attention) {
      const pubDate = a.pubDate || (a as any).pubDate || analysisUpdatedAt || '';
      const desc = (a as any).description || a.impact || '';
      const source = (a as any).source || undefined;
      latestNews.unshift({ title, pubDate, description: desc, source });
      knownTitles.add(title);
      if (a.title) knownTitles.add(a.title);
    }
  }
  // 新しい順にソートしてから30件に制限
  latestNews.sort((a, b) => (new Date(b.pubDate).getTime() || 0) - (new Date(a.pubDate).getTime() || 0));
  if (latestNews.length > 30) latestNews.length = 30;

  // title_ja はcron側で翻訳済み（latest_newsキャッシュ内に含まれる）

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
      todayWins: perf?.todayWins ?? 0,
      todayLosses: perf?.todayLosses ?? 0,
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
    acceptedNews: (acceptedNewsRaw.results ?? []).map(r => ({
      id: r.id,
      source: r.source,
      title_ja: r.title_ja,
      desc_ja: r.desc_ja,
      url: r.url ?? null,
      fetched_at: r.fetched_at,
    })),
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
    cronTimings,
    todayDecisionCount: todayDecisionCountRow?.total ?? 0,
    todayBuyCount:      todayDecisionCountRow?.buyCount ?? 0,
    todaySellCount:     todayDecisionCountRow?.sellCount ?? 0,
    causalSummary: await buildCausalSummary(db),
    strategyMap: await getStrategyMapData(db),
  };
}

// ─── Ph.6: 因果サマリー構築 ────────────────────────
type CausalSummary = NonNullable<StatusResponse['causalSummary']>;

async function buildCausalSummary(db: D1Database): Promise<CausalSummary | null> {
  try {
    // 1. 当日の確定ポジション
    const closedToday = await db.prepare(
      `SELECT pair, pnl, close_reason FROM positions
       WHERE status='CLOSED' AND closed_at > datetime('now', 'start of day')
       ORDER BY pnl DESC`
    ).all<{ pair: string; pnl: number; close_reason: string | null }>();
    const closedRows = closedToday.results ?? [];

    // 2. 最新VIX（decisionsテーブルの最新行から取得）
    const latestIndicators = await db.prepare(
      `SELECT vix, nikkei, sp500 FROM decisions ORDER BY id DESC LIMIT 1`
    ).first<{ vix: number | null; nikkei: number | null; sp500: number | null }>();

    // 3. 直近のニューストリガー
    let newsTriggers: Array<{ trigger_type: string; news_title: string; news_score: number; created_at: string }> = [];
    try {
      const ntRaw = await db.prepare(
        `SELECT trigger_type, news_title, news_score, created_at FROM news_trigger_log
         WHERE created_at > datetime('now', '-12 hours')
         ORDER BY created_at DESC LIMIT 5`
      ).all<{ trigger_type: string; news_title: string; news_score: number; created_at: string }>();
      newsTriggers = ntRaw.results ?? [];
    } catch { /* テーブル未存在 */ }

    // 4. 直近のParam Review
    let paramReviews: Array<{ pair: string; old_params: string; new_params: string; reason: string; created_at: string }> = [];
    try {
      const prRaw = await db.prepare(
        `SELECT pair, old_params, new_params, reason, created_at FROM param_review_log
         WHERE created_at > datetime('now', '-12 hours')
         ORDER BY created_at DESC LIMIT 3`
      ).all<{ pair: string; old_params: string; new_params: string; reason: string; created_at: string }>();
      paramReviews = prRaw.results ?? [];
    } catch { /* テーブル未存在 */ }

    // --- profitTop / lossTop ---
    const profitTop = closedRows.length > 0 && closedRows[0].pnl > 0
      ? { pair: closedRows[0].pair, pnl: closedRows[0].pnl, reason: closedRows[0].close_reason ?? 'MANUAL' }
      : null;
    const lossTop = closedRows.length > 0 && closedRows[closedRows.length - 1].pnl < 0
      ? { pair: closedRows[closedRows.length - 1].pair, pnl: closedRows[closedRows.length - 1].pnl, reason: closedRows[closedRows.length - 1].close_reason ?? 'MANUAL' }
      : null;

    // --- factors ---
    const factors: CausalSummary['drivers']['factors'] = [];
    const vix = latestIndicators?.vix ?? null;

    if (vix != null && vix > 25) {
      factors.push({ type: 'vix', label: `VIX=${vix.toFixed(0)}で高水準`, severity: vix > 35 ? 'high' : 'medium' });
    }

    // マクロ下落検出（簡易: sp500/nikkei が直近 decisions で下落傾向）
    // ここではVIX以外のマクロを簡易判定
    if (latestIndicators?.sp500 != null && latestIndicators?.nikkei != null) {
      // sp500/nikkeiの値自体からは変化率が取れないため、VIX > 20 かつ存在する場合のみマクロ警告
      if (vix != null && vix > 20 && vix <= 25) {
        factors.push({ type: 'macro', label: '市場やや不安定', severity: 'low' });
      }
    }

    if (paramReviews.length > 0) {
      factors.push({
        type: 'param_review',
        label: `パラメータレビュー${paramReviews.length}件(${paramReviews.map(r => r.pair).join(',')})`,
        severity: paramReviews.length >= 3 ? 'high' : 'medium',
      });
    }

    const emergencyNews = newsTriggers.filter(n => n.trigger_type === 'EMERGENCY');
    const trendNews = newsTriggers.filter(n => n.trigger_type === 'TREND_INFLUENCE');
    if (emergencyNews.length > 0) {
      factors.push({ type: 'news', label: `緊急ニュース${emergencyNews.length}件`, severity: 'high' });
    } else if (trendNews.length > 0) {
      factors.push({ type: 'news', label: `トレンドニュース${trendNews.length}件`, severity: 'medium' });
    }

    // --- narrative ---
    const narrative = buildNarrative(profitTop, lossTop, vix, paramReviews);

    // --- heatmap ---
    const pairMap = new Map<string, { pnl: number; paramChanged: boolean; newsImpact: number }>();
    for (const row of closedRows) {
      const entry = pairMap.get(row.pair) ?? { pnl: 0, paramChanged: false, newsImpact: 0 };
      entry.pnl += row.pnl;
      pairMap.set(row.pair, entry);
    }
    // param_review の銘柄にフラグ
    for (const pr of paramReviews) {
      const entry = pairMap.get(pr.pair);
      if (entry) entry.paramChanged = true;
    }
    // ニュースの影響度を銘柄に紐付け（affected_pairs が null の場合はスキップ）
    // news_trigger_log.news_score を最大スコアとして使用
    for (const nt of newsTriggers) {
      const maxScore = nt.news_score ?? 0;
      // 全銘柄に均等適用（affected_pairsはINSERT時にNULLの場合もある）
      for (const [, entry] of pairMap) {
        entry.newsImpact = Math.max(entry.newsImpact, maxScore);
      }
    }

    const vixEffect = vix != null ? Math.min(1, Math.max(0, (vix - 15) / 25)) : 0;

    const heatmap: CausalSummary['heatmap'] = [];
    for (const [pair, data] of pairMap) {
      heatmap.push({
        pair,
        pnlToday: Math.round(data.pnl * 100) / 100,
        factors: {
          pnl_closed: Math.round(data.pnl * 100) / 100,
          vix_effect: Math.round(vixEffect * 100) / 100,
          param_changed: data.paramChanged ? 1 : 0,
          news_impact: Math.min(100, Math.round(data.newsImpact)),
        },
      });
    }

    return {
      narrative,
      drivers: { profitTop, lossTop, factors },
      heatmap,
    };
  } catch {
    return null;
  }
}

function buildNarrative(
  profitTop: { pair: string; pnl: number; reason: string } | null,
  lossTop: { pair: string; pnl: number; reason: string } | null,
  vix: number | null,
  paramReviews: Array<{ pair: string }>,
): string {
  const parts: string[] = [];

  if (profitTop && profitTop.pnl > 0) {
    parts.push(`${profitTop.pair}が+${Math.round(profitTop.pnl)}円(${profitTop.reason})`);
  }

  if (lossTop && lossTop.pnl < 0 && (!profitTop || lossTop.pair !== profitTop.pair)) {
    parts.push(`${lossTop.pair}が${Math.round(lossTop.pnl)}円`);
  }

  if (vix != null && vix > 25) {
    parts.push(`VIX=${vix.toFixed(0)}で警戒中`);
  }

  if (paramReviews.length > 0) {
    parts.push(`PR${paramReviews.length}件実行`);
  }

  if (parts.length === 0) {
    return '本日はまだ取引がありません。';
  }

  let result = parts.join('。');
  if (result.length > 100) result = result.substring(0, 97) + '...';
  return result;
}

async function getStrategyMapData(db: D1Database): Promise<StatusResponse['strategyMap']> {
  try {
    const rows = await db.prepare(
      `SELECT strategy, regime, COUNT(*) as count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        AVG(pnl) as avgPnl
       FROM trade_logs WHERE strategy IS NOT NULL
       GROUP BY strategy, regime ORDER BY count DESC LIMIT 30`
    ).all<{ strategy: string | null; regime: string | null; count: number; wins: number; avgPnl: number }>();

    const strategyStats = (rows.results ?? []).map(r => ({
      strategy: r.strategy,
      regime: r.regime,
      count: r.count,
      wins: r.wins,
      winRate: r.count > 0 ? r.wins / r.count : 0,
      avgPnl: r.avgPnl ?? 0,
      reliability: (r.count >= 200 ? 'trusted' : r.count >= 50 ? 'tentative' : 'reference') as 'trusted' | 'tentative' | 'reference',
    }));

    // 銘柄ティア一覧
    const { INSTRUMENTS } = await import('./instruments');
    const instrumentTiers = INSTRUMENTS.map(i => ({
      pair: i.pair, tier: i.tier, multiplier: i.tierLotMultiplier,
    }));

    return { strategyStats, instrumentTiers };
  } catch {
    return null;
  }
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

// ─── /api/params — パラメーター一覧 + レビュー履歴 ────────────────────────

export interface InstrumentParamRow {
  pair:               string;
  rsi_period:         number;
  rsi_oversold:       number;
  rsi_overbought:     number;
  adx_period:         number;
  adx_min:            number;
  atr_period:         number;
  atr_tp_multiplier:  number;
  atr_sl_multiplier:  number;
  vix_max:            number;
  require_trend_align: number;
  regime_allow:       string;
  // Ph.6: 拡張ロジックパラメーター（Path A廃止に伴い、AIが管理するメタパラメーター）
  vix_tp_scale:        number;  // VIX > vix_max×0.7 時のTP幅倍率
  vix_sl_scale:        number;  // VIX > vix_max×0.7 時のSL幅倍率
  strategy_primary:    string;  // 優先戦略: 'mean_reversion' | 'trend_follow'
  min_signal_strength: number;  // エントリー最低シグナル強度（0〜1）
  macro_sl_scale:      number;  // VIX > vix_max×0.5 時のSL幅追加倍率
  review_trade_count: number;
  trades_since_review: number;
  param_version:      number;
  reviewed_by:        string;
  last_reviewed_at:   string | null;
  prev_params_json:   string | null;
  updated_at:         string;
}

export interface ParamReviewLogRow {
  id:            number;
  pair:          string;
  param_version: number;
  old_params:    string;
  new_params:    string;
  reason:        string;
  trades_eval:   number;
  win_rate:      number;
  actual_rr:     number;
  profit_factor: number;
  reviewed_by:   string;
  created_at:    string;
}

export interface EmergencyInfo {
  news_title: string;
  news_score: number;
  created_at: string;
}

export interface ParamsResponse {
  params:          InstrumentParamRow[];
  history:         ParamReviewLogRow[];
  latestEmergency: EmergencyInfo | null;
}

/**
 * GET /api/params
 * 全銘柄の現在パラメーター + 直近50件のレビュー履歴 + 最新EMERGENYを返す
 */
export async function getApiParams(db: D1Database): Promise<ParamsResponse> {
  // news_trigger_logはv213以降に存在。未存在環境のためtry/catch
  let emergencyRaw: EmergencyInfo | null = null;
  try {
    emergencyRaw = await db.prepare(
      `SELECT news_title, news_score, created_at
       FROM news_trigger_log
       WHERE trigger_type = 'EMERGENCY'
       ORDER BY id DESC LIMIT 1`
    ).first<EmergencyInfo>();
  } catch { /* テーブル未存在時はnullのまま */ }

  const [paramsRaw, historyRaw] = await Promise.all([
    db.prepare(
      `SELECT * FROM instrument_params ORDER BY pair ASC`
    ).all<InstrumentParamRow>(),
    db.prepare(
      `SELECT * FROM param_review_log ORDER BY id DESC LIMIT 50`
    ).all<ParamReviewLogRow>(),
  ]);
  return {
    params:          paramsRaw.results  ?? [],
    history:         historyRaw.results ?? [],
    latestEmergency: emergencyRaw ?? null,
  };
}

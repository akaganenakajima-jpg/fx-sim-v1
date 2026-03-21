// エントリーポイント
// scheduled: 1分ごとにレート取得→指標取得→TP/SL確認→フィルタ→Gemini判定→記録
// fetch:     GET / → ダッシュボード、GET /api/status → JSON、GET /style.css・/app.js → 静的ファイル

import { getUSDJPY } from './rate';
import { fetchNews, type SourceFetchStat } from './news';
import { fetchRedditSignal } from './reddit';
import { getMarketIndicators } from './indicators';
import { getDecisionWithHedge, fetchOgDescription, newsStage1WithHedge, newsStage2, RateLimitError, type NewsAnalysisItem, type NewsStage1Result } from './gemini';
import { checkAndCloseAllPositions, openPosition } from './position';
import { shouldCallGemini } from './filter';
import {
  insertDecision,
  insertSystemLog,
  getCacheValue,
  setCacheValue,
  closePosition,
} from './db';
import { slPatternAnalysis } from './stats';
import { getDashboardHtml } from './dashboard';
import { getApiStatus } from './api';
import { CSS } from './style.css';
import { JS } from './app.js';
import { INSTRUMENTS, type InstrumentConfig } from './instruments';
import { getBroker, withFallback, type BrokerEnv } from './broker';
import { checkRisk, type RiskEnv } from './risk-guard';
import { checkTpSlSanity } from './sanity';
import {
  getDrawdownLevel, updateHWM, getCurrentBalance,
  applyDrawdownControl, checkCorrelationGuard,
} from './risk-manager';
import { runMigrations } from './migration';
import { sendNotification, getWebhookUrl, buildDailySummaryMessage } from './notify';
import { sampleBeta } from './thompson';
import { kalmanFilter, type KalmanState } from './kalman';
// テスタ施策 Phase 2-7
import { getTechnicalIndicators, updateAllCandles } from './candles';
import { determineRegime, formatRegimeForPrompt, getRegimeProhibitions } from './regime';
import { getCurrentSession, getSessionLotMultiplier, getSessionInstrumentMultiplier, isNakaneWindow } from './session';
import { fetchEconomicCalendar, getUpcomingHighImpactEvents } from './calendar';
import { generateWeeklyReview, generateMonthlyReview } from './trade-journal';
// detectBreakout は candle データがキャッシュに保存されるPhase 7以降で統合予定
// import { detectBreakout } from './breakout';
import { isValidStrategy } from './strategy-tag';

interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  GEMINI_API_KEY_2?: string;
  GEMINI_API_KEY_3?: string;
  GEMINI_API_KEY_4?: string;
  GEMINI_API_KEY_5?: string;
  OPENAI_API_KEY?: string;
  OPENAI_API_KEY_2?: string;
  ANTHROPIC_API_KEY?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  // OANDA実弾取引
  OANDA_API_TOKEN?: string;
  OANDA_ACCOUNT_ID?: string;
  OANDA_LIVE?: string;
  TRADING_ENABLED?: string;
  // RiskGuard
  RISK_MAX_DAILY_LOSS?: string;
  RISK_MAX_LIVE_POSITIONS?: string;
  RISK_MAX_LOT_SIZE?: string;
  RISK_ANOMALY_THRESHOLD?: string;
  // Twelve Data フォールバック
  TWELVE_DATA_API_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
  // テスタ施策: 多層リスク
  RISK_MAX_WEEKLY_LOSS?: string;
  RISK_MAX_MONTHLY_LOSS?: string;
  // テスタ施策12: 経済指標カレンダー
  FINNHUB_API_KEY?: string;
}

// ── キー別クールダウン管理 ──
// Workers は cron 実行ごとにリセット（ステートレス）なので Map で十分
const keyCooldowns = new Map<string, number>();  // apiKey → cooldownUntil timestamp
const keyUsageCount = new Map<string, number>(); // apiKey → 使用回数（均等分散用）

let _keyIndex = 0;
function getApiKey(env: Env): string {
  const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3, env.GEMINI_API_KEY_4, env.GEMINI_API_KEY_5].filter(Boolean) as string[];
  const now = Date.now();

  // クールダウン中でないキーを抽出
  const available = keys.filter(k => (keyCooldowns.get(k) ?? 0) <= now);
  if (available.length > 0) {
    // 使用回数最少のキーを選択（均等分散）
    available.sort((a, b) => (keyUsageCount.get(a) ?? 0) - (keyUsageCount.get(b) ?? 0));
    const key = available[0];
    keyUsageCount.set(key, (keyUsageCount.get(key) ?? 0) + 1);
    return key;
  }

  // 全キーがクールダウン中 → 最も早く解除されるキーを返す
  const earliest = keys.reduce((a, b) =>
    (keyCooldowns.get(a) ?? 0) < (keyCooldowns.get(b) ?? 0) ? a : b
  );
  keyUsageCount.set(earliest, (keyUsageCount.get(earliest) ?? 0) + 1);
  return earliest;
}

/** 429受信時にキーをクールダウン登録 */
function markKeyCooldown(apiKey: string, retryAfterSec: number): void {
  const cooldownUntil = Date.now() + retryAfterSec * 1000;
  keyCooldowns.set(apiKey, cooldownUntil);
  console.log(`[fx-sim] Key cooldown: ${apiKey.slice(0, 8)}... until ${new Date(cooldownUntil).toISOString()} (${retryAfterSec}s)`);
}

/** クールダウン中でないキーの数 */
function availableKeyCount(env: Env): number {
  const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3, env.GEMINI_API_KEY_4, env.GEMINI_API_KEY_5].filter(Boolean) as string[];
  const now = Date.now();
  return keys.filter(k => (keyCooldowns.get(k) ?? 0) <= now).length;
}

// ── サーキットブレーカー（3段階: CLOSED → OPEN → HALF_OPEN）──
// 連続失敗時にAI呼び出しを一時停止し、無意味なリトライによる障害悪化を防止
interface CircuitBreakerState {
  state: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
  failCount: number;
  openUntil: number;
}

const circuitBreaker: CircuitBreakerState = {
  state: 'CLOSED',
  failCount: 0,
  openUntil: 0,
};

const CB_FAIL_THRESHOLD = 3;        // 連続3回失敗で OPEN
const CB_OPEN_DURATION_MS = 60_000; // OPEN → 1分後に HALF_OPEN

/** AI呼び出し可能かチェック */
function cbCanRequest(): boolean {
  const now = Date.now();
  if (circuitBreaker.state === 'CLOSED') return true;
  if (circuitBreaker.state === 'OPEN') {
    if (now >= circuitBreaker.openUntil) {
      circuitBreaker.state = 'HALF_OPEN';
      console.log('[fx-sim] Circuit breaker: OPEN → HALF_OPEN（試行再開）');
      return true;
    }
    return false;
  }
  return false; // HALF_OPEN: 既に1回試行許可済み
}

/** AI呼び出し成功時 → CLOSED にリセット */
function cbRecordSuccess(): void {
  if (circuitBreaker.state !== 'CLOSED') {
    console.log(`[fx-sim] Circuit breaker: ${circuitBreaker.state} → CLOSED（復旧）`);
  }
  circuitBreaker.state = 'CLOSED';
  circuitBreaker.failCount = 0;
}

/** AI呼び出し失敗時 → 閾値超過で OPEN */
function cbRecordFailure(): void {
  circuitBreaker.failCount++;
  if (circuitBreaker.failCount >= CB_FAIL_THRESHOLD) {
    circuitBreaker.state = 'OPEN';
    circuitBreaker.openUntil = Date.now() + CB_OPEN_DURATION_MS;
    console.log(`[fx-sim] Circuit breaker: → OPEN（${CB_OPEN_DURATION_MS / 1000}s間 AI停止, 連続${circuitBreaker.failCount}回失敗）`);
  }
}

const PREV_NEWS_HASH_KEY = 'prev_news_hash';

/**
 * ニュースハッシュ: 上位5件のみ・正規化・ソートで順序変動に鈍感化
 * 旧: 全タイトル join → 1件変更で即発火（高感度すぎ）
 * 新: 上位5件 sort → 重要ニュースの入れ替えのみ検知
 */
function newsHash(items: Array<{ title: string }>): string {
  return items
    .slice(0, 5)
    .map(n => n.title.toLowerCase().trim())
    .sort()
    .join('|');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/':
        return new Response(getDashboardHtml(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store' },
        });
      case '/style.css':
        return new Response(CSS, {
          headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' },
        });
      case '/app.js':
        return new Response(JS, {
          headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
        });
      case '/api/status':
        try {
          const status = await getApiStatus(env.DB, {
            TRADING_ENABLED: env.TRADING_ENABLED, OANDA_LIVE: env.OANDA_LIVE,
            RISK_MAX_DAILY_LOSS: env.RISK_MAX_DAILY_LOSS, RISK_MAX_LIVE_POSITIONS: env.RISK_MAX_LIVE_POSITIONS,
            RISK_MAX_LOT_SIZE: env.RISK_MAX_LOT_SIZE, RISK_ANOMALY_THRESHOLD: env.RISK_ANOMALY_THRESHOLD,
          });
          // unpaired surrogateを除去して不正JSONを防止
          const json = JSON.stringify(status).replace(/[\uD800-\uDFFF]/g, '');
          return new Response(json, {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      default:
        return new Response('Not Found', { status: 404 });
    }
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(run(env));
  },
};

interface MarketData {
  news: ReturnType<typeof fetchNews> extends Promise<infer T> ? T extends { items: infer I } ? I : never : never;
  newsFetchStats: SourceFetchStat[];
  activeNewsSources: string;
  redditSignal: { hasSignal: boolean; keywords: string[]; topPosts: string[] };
  indicators: Awaited<ReturnType<typeof getMarketIndicators>>;
  prices: Map<string, number | null>;
}

/** 市場データ一括取得（RSS/Reddit/Yahoo Finance/Frankfurter + キャッシュフォールバック） */
async function fetchMarketData(env: Env, now: Date): Promise<MarketData | null> {
  const [newsResult, redditResult, indicatorsResult, frankfurterResult] = await Promise.allSettled([
    fetchNews(),
    fetchRedditSignal(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET),
    getMarketIndicators(env.TWELVE_DATA_API_KEY),
    getUSDJPY(),
  ]);

  if (newsResult.status === 'rejected') {
    await insertSystemLog(env.DB, 'WARN', 'NEWS', 'ニュース取得失敗', String(newsResult.reason).slice(0, 200));
  }
  if (redditResult.status === 'rejected') {
    await insertSystemLog(env.DB, 'WARN', 'REDDIT', 'Reddit取得失敗', String(redditResult.reason).slice(0, 200));
  }
  if (indicatorsResult.status === 'rejected') {
    await insertSystemLog(env.DB, 'WARN', 'INDICATORS', '指標取得失敗', String(indicatorsResult.reason).slice(0, 200));
  }

  const newsData = newsResult.status === 'fulfilled' ? newsResult.value : { items: [], stats: [] as SourceFetchStat[] };
  const newsFetchStats = newsData.stats;

  // ニュースソース統計をD1に記録
  if (newsFetchStats.length > 0) {
    try {
      const stmt = env.DB.prepare(
        `INSERT INTO news_fetch_log (source, ok, latency_ms, item_count, avg_freshness, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      await env.DB.batch(newsFetchStats.map(s =>
        stmt.bind(s.source, s.ok ? 1 : 0, s.latencyMs, s.itemCount, s.avgFreshnessMin, now.toISOString())
      ));
    } catch (e) {
      console.warn(`[fx-sim] news_fetch_log insert error: ${String(e).slice(0, 100)}`);
    }
  }

  const news = newsData.items;
  const activeNewsSources = [...new Set(news.map(n => n.source))].join(',');
  const redditSignal = redditResult.status === 'fulfilled' ? redditResult.value : { hasSignal: false, keywords: [], topPosts: [] };
  const indicators = indicatorsResult.status === 'fulfilled' ? indicatorsResult.value : { vix: null, us10y: null, nikkei: null, sp500: null, usdjpy: null, btcusd: null, gold: null, eurusd: null, ethusd: null, crudeoil: null, natgas: null, copper: null, silver: null, gbpusd: null, audusd: null, solusd: null, dax: null, nasdaq: null, uk100: null, hk33: null };
  const frankfurterRate = frankfurterResult.status === 'fulfilled' ? frankfurterResult.value : null;

  const usdJpyRate = indicators.usdjpy ?? frankfurterRate;
  if (usdJpyRate == null) {
    console.error('[fx-sim] USD/JPY rate unavailable from all sources');
    await insertSystemLog(env.DB, 'ERROR', 'RATE', 'USD/JPYレート取得失敗（全ソース）');
    return null;
  }

  const livePrices: Array<[string, number | null]> = [
    ['USD/JPY',   usdJpyRate],
    ['Nikkei225', indicators.nikkei],
    ['S&P500',    indicators.sp500],
    ['US10Y',     indicators.us10y],
    ['BTC/USD',   indicators.btcusd],
    ['Gold',      indicators.gold],
    ['EUR/USD',   indicators.eurusd],
    ['ETH/USD',   indicators.ethusd],
    ['CrudeOil',  indicators.crudeoil],
    ['NatGas',    indicators.natgas],
    ['Copper',    indicators.copper],
    ['Silver',    indicators.silver],
    ['GBP/USD',   indicators.gbpusd],
    ['AUD/USD',   indicators.audusd],
    ['SOL/USD',   indicators.solusd],
    ['DAX',       indicators.dax],
    ['NASDAQ',    indicators.nasdaq],
    ['UK100',     indicators.uk100],
    ['HK33',      indicators.hk33],
  ];

  const fallbackPairs: string[] = [];
  const prices = new Map<string, number | null>();
  for (const [pair, liveRate] of livePrices) {
    if (liveRate != null) {
      prices.set(pair, liveRate);
    } else {
      const cached = await getCacheValue(env.DB, `prev_rate_${pair}`);
      if (cached) {
        prices.set(pair, parseFloat(cached));
        fallbackPairs.push(pair);
      } else {
        prices.set(pair, null);
      }
    }
  }
  if (fallbackPairs.length > 0) {
    console.warn(`[fx-sim] Yahoo失敗→キャッシュ使用: ${fallbackPairs.join(', ')}`);
    if (fallbackPairs.length >= 3) {
      await insertSystemLog(env.DB, 'WARN', 'RATE', `Yahoo障害: ${fallbackPairs.length}銘柄キャッシュフォールバック`, fallbackPairs.join(', '));
    }
  }

  return { news, newsFetchStats, activeNewsSources, redditSignal, indicators, prices };
}

interface AIDecisionSummary {
  geminiOk: number;
  gptOk: number;
  claudeOk: number;
  fail: number;
}

interface AIRunContext {
  indicators: Awaited<ReturnType<typeof getMarketIndicators>>;
  news: MarketData['news'];
  redditSignal: { hasSignal: boolean; keywords: string[]; topPosts: string[] };
  newsSummary: string | null;
  activeNewsSources: string;
  brokerEnv: BrokerEnv;
  now: Date;
  prices: Map<string, number | null>;
  prevElapsed: number;
  /** Path B が処理した銘柄（Path A/C でスキップする） */
  excludedPairs?: Set<string>;
  /** テスタ施策12: 経済イベントガード */
  economicEventGuard?: { highImpactNearby: boolean; mediumImpactNearby: boolean };
}

// ── v2: 3Path並列 型定義 ──

interface SharedNewsStore {
  items: MarketData['news'];
  hash: string;
  hasChanged: boolean;
}

interface PathDecision {
  pair: string;
  decision: 'BUY' | 'SELL' | 'HOLD';
  tp_rate: number | null;
  sl_rate: number | null;
  reasoning: string;
  rate: number;
  source: 'PATH_A' | 'PATH_B' | 'PATH_C';
  news_analysis?: NewsAnalysisItem[];
}

interface PathBResult {
  decisions: PathDecision[];  // BUY/SELLのみ
  reversals: string[];        // REVERSE対象のpair一覧
  newsAnalysis: NewsAnalysisItem[];
}

async function runAIDecisions(
  env: Env,
  context: AIRunContext,
  cronStart: number,
): Promise<AIDecisionSummary> {
  const {
    indicators, news, redditSignal, newsSummary, activeNewsSources,
    brokerEnv, now, prices, prevElapsed, excludedPairs, economicEventGuard,
  } = context;

  // 429クールダウン: キー別管理 + サーキットブレーカーで制御
  const availKeys = availableKeyCount(env);
  const isInCooldown = availKeys === 0 || !cbCanRequest();
  if (availKeys === 0) console.log(`[fx-sim] All Gemini keys in cooldown (${keyCooldowns.size} keys blocked)`);
  if (!cbCanRequest()) console.log(`[fx-sim] Circuit breaker ${circuitBreaker.state}: AI呼び出し停止中`);

  // 動的上限: 前回実行時間に応じて調整
  const baseLimit = prevElapsed > 30000 ? 3 : prevElapsed > 15000 ? 5 : 8;
  const MAX_GEMINI_PER_RUN = isInCooldown ? 0 : baseLimit;
  // 並列数: 前回実行時間から安全な並列数を計算
  const parallelLimit = prevElapsed > 30000 ? 2 : prevElapsed > 15000 ? 3 : 4;

  // 4a. 全銘柄のレート変化・フィルタ結果を事前収集
  const candidateList: Array<{
    instrument: InstrumentConfig;
    currentRate: number;
    prevRate: number;
    filterResult: { shouldCall: boolean; reason: string };
    volatilityScore: number;
    sessionBonus: number;
    totalScore: number;
  }> = [];

  // 市場時間帯マッピング（JST）
  const jstH = (now.getUTCHours() + 9) % 24;
  const isTokyoSession = jstH >= 8 && jstH < 15;
  const isLondonSession = jstH >= 16 || jstH < 1;
  const isNYSession = jstH >= 22 || jstH < 7;

  const SESSION_MAP: Record<string, string[]> = {
    tokyo:  ['USD/JPY', 'Nikkei225', 'AUD/USD', 'HK33'],
    london: ['EUR/USD', 'GBP/USD', 'DAX', 'Gold', 'Silver', 'Copper', 'UK100'],
    ny:     ['S&P500', 'NASDAQ', 'US10Y', 'CrudeOil', 'NatGas', 'BTC/USD', 'ETH/USD', 'SOL/USD'],
  };

  // トンプソン・サンプリングスコアを一括取得（N+1クエリを回避）
  const thompsonRows = await env.DB
    .prepare('SELECT pair, thompson_alpha, thompson_beta FROM instrument_scores')
    .all<{ pair: string; thompson_alpha: number; thompson_beta: number }>();
  const thompsonMap = new Map(
    (thompsonRows.results ?? []).map(r => [r.pair, sampleBeta(r.thompson_alpha ?? 1, r.thompson_beta ?? 1)])
  );

  // 全銘柄のprevRate・lastCallTimeを一括取得（D1クエリ削減）
  const cacheKeys = INSTRUMENTS.flatMap(i => [`prev_rate_${i.pair}`, `last_ai_call_${i.pair}`]);
  const cacheRows = await env.DB
    .prepare(`SELECT key, value FROM market_cache WHERE key IN (${cacheKeys.map(() => '?').join(',')})`)
    .bind(...cacheKeys)
    .all<{ key: string; value: string }>();
  const cacheMap = new Map<string, string>();
  for (const row of (cacheRows.results ?? [])) cacheMap.set(row.key, row.value);

  // prevRate一括更新用
  const rateUpdates: Array<{ key: string; value: string }> = [];

  for (const instrument of INSTRUMENTS) {
    const currentRate = prices.get(instrument.pair);
    if (currentRate == null) {
      console.warn(`[fx-sim] ${instrument.pair}: price unavailable (no cache)`);
      continue;
    }

    const cacheKey = `prev_rate_${instrument.pair}`;
    const prevRateRaw = cacheMap.get(cacheKey) ?? null;
    const prevRate = prevRateRaw ? parseFloat(prevRateRaw) : currentRate;
    rateUpdates.push({ key: cacheKey, value: String(currentRate) });

    const lastCallKey = `last_ai_call_${instrument.pair}`;
    const lastCallTime = cacheMap.get(lastCallKey) ?? null;

    // Path B が処理した銘柄はスキップ
    if (excludedPairs?.has(instrument.pair)) continue;

    const thompsonScore = thompsonMap.get(instrument.pair);
    const filterResult = shouldCallGemini({
      currentRate, prevRate,
      rateChangeTh: instrument.rateChangeTh,
      now, lastCallTime,
      thompsonScore,
    });

    const changePct = prevRate !== 0 ? Math.abs(currentRate - prevRate) / prevRate : 0;
    const volatilityScore = changePct / (instrument.rateChangeTh / (prevRate || 1));

    let sessionBonus = 0;
    if (isTokyoSession && SESSION_MAP.tokyo.includes(instrument.pair)) sessionBonus = 0.5;
    if (isLondonSession && SESSION_MAP.london.includes(instrument.pair)) sessionBonus = 0.5;
    if (isNYSession && SESSION_MAP.ny.includes(instrument.pair)) sessionBonus = 0.5;

    candidateList.push({
      instrument, currentRate, prevRate, filterResult,
      volatilityScore, sessionBonus,
      totalScore: volatilityScore + sessionBonus + (thompsonScore ?? 0.5),
    });
  }

  // prevRate一括更新（バッチ）
  if (rateUpdates.length > 0) {
    const stmt = env.DB.prepare(
      `INSERT INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    await env.DB.batch(rateUpdates.map(u => stmt.bind(u.key, u.value, now.toISOString())));
  }

  // 4b. フィルタ通過銘柄をスコア降順でソート
  const passed = candidateList.filter(c => c.filterResult.shouldCall);
  const skipped = candidateList.filter(c => !c.filterResult.shouldCall);
  passed.sort((a, b) => b.totalScore - a.totalScore);

  // スキップ銘柄 + 上限超過分をバッチINSERT（D1クエリ削減）
  const holdBatch = [
    ...skipped.map(c => ({ pair: c.instrument.pair, rate: c.currentRate, reasoning: `スキップ: ${c.filterResult.reason}` })),
    ...passed.slice(MAX_GEMINI_PER_RUN).map(c => ({ pair: c.instrument.pair, rate: c.currentRate, reasoning: `低優先度(スコア${c.totalScore.toFixed(1)}): 次のcronで判定予定` })),
  ];
  if (holdBatch.length > 0) {
    const stmt = env.DB.prepare(
      `INSERT INTO decisions (pair, rate, decision, tp_rate, sl_rate, reasoning, news_summary, reddit_signal, vix, us10y, nikkei, sp500, created_at)
       VALUES (?, ?, 'HOLD', NULL, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?)`
    );
    await env.DB.batch(holdBatch.map(h =>
      stmt.bind(h.pair, h.rate, h.reasoning, indicators.vix, indicators.us10y, indicators.nikkei, indicators.sp500, now.toISOString())
    ));
  }

  if (passed.length > 0) {
    console.log(`[fx-sim] フィルタ通過 ${passed.length}件 (上限${MAX_GEMINI_PER_RUN}) → ${passed.slice(0, MAX_GEMINI_PER_RUN).map(c => `${c.instrument.pair}(${c.totalScore.toFixed(1)})`).join(', ')}`);
  }

  let geminiOkCount = 0, gptOkCount = 0, claudeOkCount = 0, aiFailCount = 0;

  // 4c-pre. AIループ用データを一括取得（銘柄ごとの直列クエリ → 3回のバッチクエリに削減）
  const aiCandidates = passed.slice(0, MAX_GEMINI_PER_RUN);
  const allOpenRaw = await env.DB
    .prepare(`SELECT pair, direction FROM positions WHERE status = 'OPEN'`)
    .all<{ pair: string; direction: string }>();
  const allPositionDirections = (allOpenRaw.results ?? []).map(p => `${p.pair}:${p.direction}`);
  const openPositionSet = new Set((allOpenRaw.results ?? []).map(p => p.pair));

  // 候補銘柄の過去履歴を一括取得（N+1 → 1クエリ）
  const candidatePairs = aiCandidates.map(c => c.instrument.pair);
  const recentTradesMap = new Map<string, Array<{ pair: string; direction: string; pnl: number; close_reason: string }>>();
  if (candidatePairs.length > 0) {
    const placeholders = candidatePairs.map(() => '?').join(',');
    const allRecentRaw = await env.DB
      .prepare(`SELECT pair, direction, pnl, close_reason FROM positions WHERE pair IN (${placeholders}) AND status = 'CLOSED' ORDER BY closed_at DESC`)
      .bind(...candidatePairs)
      .all<{ pair: string; direction: string; pnl: number; close_reason: string }>();
    for (const row of allRecentRaw.results ?? []) {
      const arr = recentTradesMap.get(row.pair) ?? [];
      if (arr.length < 5) arr.push(row);
      recentTradesMap.set(row.pair, arr);
    }
  }

  // スパークラインデータも一括取得
  const sparkMap = new Map<string, number[]>();
  if (candidatePairs.length > 0) {
    const placeholders = candidatePairs.map(() => '?').join(',');
    const allSparkRaw = await env.DB
      .prepare(`SELECT pair, rate FROM decisions WHERE pair IN (${placeholders}) ORDER BY id DESC`)
      .bind(...candidatePairs)
      .all<{ pair: string; rate: number }>();
    const countMap = new Map<string, number>();
    for (const row of allSparkRaw.results ?? []) {
      const cnt = countMap.get(row.pair) ?? 0;
      if (cnt < 20) {
        const arr = sparkMap.get(row.pair) ?? [];
        arr.push(row.rate);
        sparkMap.set(row.pair, arr);
        countMap.set(row.pair, cnt + 1);
      }
    }
    for (const [pair, rates] of sparkMap) {
      sparkMap.set(pair, rates.reverse());
    }
  }

  // カルマンフィルタで各銘柄のレジームを計算（スパークラインデータを利用）
  const regimeMap = new Map<string, KalmanState['regime']>();
  for (const [pair, rates] of sparkMap) {
    if (rates.length >= 5) {
      const state = kalmanFilter(rates);
      regimeMap.set(pair, state.regime);
    }
  }

  // 4c. スコア上位からAI判定（並列バッチ処理: 最大parallelLimit件同時実行）
  type AIResult = { provider: 'gemini' | 'gpt' | 'claude' | 'fail'; pair: string };

  const batches: typeof aiCandidates[] = [];
  for (let i = 0; i < aiCandidates.length; i += parallelLimit) {
    batches.push(aiCandidates.slice(i, i + parallelLimit));
  }

  for (const batch of batches) {
    if (Date.now() - cronStart > 50_000) {
      console.warn(`[fx-sim] Cron budget exhausted (${Date.now() - cronStart}ms), skipping remaining batches`);
      break;
    }

    const batchResults: AIResult[] = [];

    await Promise.allSettled(
      batch.map(async (candidate): Promise<AIResult> => {
        const { instrument, currentRate } = candidate;

        const hasOpenPosition = openPositionSet.has(instrument.pair);
        const recentTrades = recentTradesMap.get(instrument.pair) ?? [];
        const sparkRates = sparkMap.get(instrument.pair) ?? [];

        // テスタ施策: テクニカル環境認識 + セッション制御
        let technicalText: string | undefined;
        let regimeProhibitions: string | undefined;
        let regimeName: string | undefined = regimeMap.get(instrument.pair);
        if (instrument.oandaSymbol && env.OANDA_API_TOKEN && env.OANDA_ACCOUNT_ID) {
          try {
            const tech = await getTechnicalIndicators(
              env.DB, env.OANDA_API_TOKEN, env.OANDA_ACCOUNT_ID,
              env.OANDA_LIVE === 'true', instrument.oandaSymbol);
            const regimeResult = determineRegime(tech.h1);
            regimeName = regimeResult.regime;
            technicalText = formatRegimeForPrompt(regimeResult, tech.h1);
            regimeProhibitions = getRegimeProhibitions(regimeResult.regime);
          } catch { /* テクニカル取得失敗は無視 */ }
        }

        let geminiResult;
        try {
          const hedgeResult = await getDecisionWithHedge({
            instrument,
            rate: currentRate,
            indicators,
            news,
            redditSignal,
            hasOpenPosition,
            recentTrades,
            allPositionDirections,
            sparkRates,
            regime: regimeName,
            technicalText,
            regimeProhibitions,
            geminiApiKey: getApiKey(env),
            openaiApiKey: env.OPENAI_API_KEY,
            openaiApiKey2: env.OPENAI_API_KEY_2,
            anthropicApiKey: env.ANTHROPIC_API_KEY,
            keyIndex: _keyIndex,
          });
          geminiResult = hedgeResult.decision;
          if (hedgeResult.provider !== 'gemini') {
            await insertSystemLog(env.DB, 'INFO', hedgeResult.provider.toUpperCase(), `${hedgeResult.provider}ヘッジ成功 (${instrument.pair}) → ${geminiResult.decision}`);
          }

          // ── IPA品質修正: サニティチェックを insertDecision 前に実行し補正値をDBに保存 ──
          // BUY/SELL の TP/SL を事前にサニティ補正する（異常値がDBに記録されることを防止）
          const triggerPrefix = candidate.filterResult.reason.startsWith('レート変化') ? '[RATE] ' : '[CRON] ';
          let finalTp = geminiResult.tp_rate;
          let finalSl = geminiResult.sl_rate;
          let sanityValid = true;
          let rrLotMultiplier = 1.0;
          if ((geminiResult.decision === 'BUY' || geminiResult.decision === 'SELL') &&
              finalTp != null && finalSl != null) {
            const preSanity = checkTpSlSanity({
              direction: geminiResult.decision,
              rate: currentRate,
              tp: finalTp,
              sl: finalSl,
              instrument,
            });
            if (!preSanity.valid) {
              sanityValid = false;
              finalTp = null;
              finalSl = null;
              console.warn(`[fx-sim] Sanity pre-check rejected: ${instrument.pair} ${preSanity.reason}`);
              await insertSystemLog(env.DB, 'WARN', 'SANITY',
                `TP/SL異常値拒否: ${instrument.pair} ${geminiResult.decision}`,
                preSanity.reason ?? undefined);
            } else {
              // 補正値があれば適用（差分値・比率値・ミラーを自動修正）
              if (preSanity.correctedTp != null) finalTp = preSanity.correctedTp;
              if (preSanity.correctedSl != null) finalSl = preSanity.correctedSl;
              // テスタ施策3: RR REDUCED → ロット50%削減フラグ
              if (preSanity.rrCategory === 'REDUCED') {
                rrLotMultiplier = 0.5;
                console.log(`[fx-sim] RR REDUCED (${preSanity.rrRatio?.toFixed(2)}): ${instrument.pair} lot×0.5`);
              }
            }
          }

          // 補正済み TP/SL で decisions テーブルに記録（生の異常値は保存しない）
          // テスタ施策7: strategy/confidenceをバリデーション付きで記録
          const validStrategy = geminiResult.strategy && isValidStrategy(geminiResult.strategy)
            ? geminiResult.strategy : null;
          const validConfidence = typeof geminiResult.confidence === 'number'
            ? Math.max(0, Math.min(100, geminiResult.confidence)) : null;

          await insertDecision(env.DB, {
            pair: instrument.pair,
            rate: currentRate,
            decision: geminiResult.decision,
            tp_rate: finalTp,
            sl_rate: finalSl,
            reasoning: triggerPrefix + geminiResult.reasoning,
            news_summary: newsSummary || null,
            reddit_signal: redditSignal.keywords.join(', ') || null,
            vix: indicators.vix,
            us10y: indicators.us10y,
            nikkei: indicators.nikkei,
            sp500: indicators.sp500,
            created_at: now.toISOString(),
            news_sources: activeNewsSources || null,
            strategy: validStrategy,
            confidence: validConfidence,
          });

          await setCacheValue(env.DB, `last_ai_call_${instrument.pair}`, now.toISOString());

          if (
            (geminiResult.decision === 'BUY' || geminiResult.decision === 'SELL') &&
            !hasOpenPosition
          ) {
            if (!sanityValid) {
              // サニティ拒否済み — ポジションは開かない（ログは上で出力済み）
            } else {
              const broker = getBroker(instrument, brokerEnv);
              const isLive = broker.name === 'oanda';
              let source: 'paper' | 'oanda' = 'paper';
              let oandaTradeId: string | null = null;

              // テスタ施策11: セッション制御
              const currentSession = getCurrentSession(now);
              const sessionMult = getSessionLotMultiplier(currentSession);
              const matrixMult = getSessionInstrumentMultiplier(currentSession, instrument.pair);
              if (sessionMult === 0 || matrixMult === 0) {
                console.log(`[fx-sim] Session blocked: ${instrument.pair} session=${currentSession}`);
              }

              // テスタ施策18: 確信度ベースロット
              let confidenceMult = 1.0;
              if (validConfidence != null) {
                if (validConfidence >= 80) confidenceMult = 1.5;
                else if (validConfidence >= 60) confidenceMult = 1.0;
                else if (validConfidence >= 40) confidenceMult = 0.5;
                else { confidenceMult = 0; } // <40 → HOLD強制
              }

              // テスタ施策19: 仲値バイアス
              if (isNakaneWindow(now) && instrument.pair === 'USD/JPY' &&
                  geminiResult.decision === 'BUY' && validConfidence != null) {
                confidenceMult = Math.min(confidenceMult * 1.1, 1.5);
              }

              // テスタ施策12: S級イベント接近→強制HOLD / A級→ロット50%
              let calendarMult = 1.0;
              if (economicEventGuard?.highImpactNearby) calendarMult = 0;
              else if (economicEventGuard?.mediumImpactNearby) calendarMult = 0.5;

              if (sessionMult === 0 || matrixMult === 0 || confidenceMult === 0 || calendarMult === 0) {
                // セッション禁止 or 確信度不足 or S級イベント接近 → ポジション開かない
              } else {
              // テスタ施策2: HWMドローダウン制御
              const ddResult = await getDrawdownLevel(env.DB);
              const balance = await getCurrentBalance(env.DB);
              await updateHWM(env.DB, balance);
              if (ddResult.level === 'HALT' || ddResult.level === 'STOP') {
                await applyDrawdownControl(env.DB, ddResult);
                console.warn(`[fx-sim] DD ${ddResult.level}: ${instrument.pair} blocked (DD ${ddResult.ddPct.toFixed(1)}%)`);
                await insertSystemLog(env.DB, 'WARN', 'RISK',
                  `DD制御: ${instrument.pair} ${ddResult.level}`,
                  `DD=${ddResult.ddPct.toFixed(1)}% HWM=${ddResult.hwm} Balance=${ddResult.balance}`);
              } else {
                // テスタ施策4: 相関リスクガード
                const corrGuard = await checkCorrelationGuard(
                  env.DB, instrument.pair, geminiResult.decision as 'BUY' | 'SELL', INSTRUMENTS);
                if (!corrGuard.allowed) {
                  console.warn(`[fx-sim] ${corrGuard.reason}`);
                  await insertSystemLog(env.DB, 'WARN', 'RISK',
                    `相関ガード: ${instrument.pair}`, corrGuard.reason);
                } else if (isLive) {
                  // 全施策のロット倍率を統合
                  const ddLotMult = ddResult.lotMultiplier;
                  const tierMult = instrument.tierLotMultiplier;
                  const requestedLot = 1 * rrLotMultiplier * ddLotMult * sessionMult * matrixMult * confidenceMult * calendarMult * tierMult;

                  const riskResult = await checkRisk({
                    db: env.DB,
                    env: env as RiskEnv,
                    pair: instrument.pair,
                    currentRate,
                    prevRate: candidate.prevRate,
                    requestedLot,
                  });

                  if (!riskResult.allowed) {
                    console.warn(`[fx-sim] RiskGuard blocked: ${instrument.pair} → ${riskResult.reason}`);
                    await insertSystemLog(env.DB, 'WARN', 'RISK',
                      `実弾ブロック: ${instrument.pair} ${geminiResult.decision}`,
                      riskResult.reason);
                  } else {
                    const brokerResult = await withFallback(broker, () => broker.openPosition({
                      pair: instrument.pair,
                      oandaSymbol: instrument.oandaSymbol,
                      direction: geminiResult!.decision as 'BUY' | 'SELL',
                      entryRate: currentRate,
                      tpRate: finalTp,
                      slRate: finalSl,
                      lot: riskResult.adjustedLot ?? requestedLot,
                    }), env.DB, `open ${instrument.pair} ${geminiResult.decision}`);

                    if (brokerResult.success && !brokerResult.error?.startsWith('Fallback')) {
                      source = 'oanda';
                      oandaTradeId = brokerResult.oandaTradeId ?? null;
                      console.log(`[fx-sim] 🔴 LIVE: ${instrument.pair} ${geminiResult.decision} tradeId=${oandaTradeId}`);
                    }
                  }
                }
              }

              await openPosition(
                env.DB,
                instrument.pair,
                geminiResult.decision,
                currentRate,
                finalTp,
                finalSl,
                source,
                oandaTradeId,
                getWebhookUrl(env),
                { strategy: validStrategy, regime: regimeName, session: currentSession, confidence: validConfidence },
              );
              await insertSystemLog(
                env.DB, 'INFO', 'POSITION',
                `ポジション開設: ${instrument.pair} ${geminiResult.decision} @ ${currentRate} [${source}]`,
                JSON.stringify({ tp: finalTp, sl: finalSl, source, oandaTradeId, reasoning: geminiResult.reasoning?.slice(0, 100) })
              );
            } // end session/confidence gate
            }
          } else if (geminiResult.decision !== 'HOLD') {
            await insertSystemLog(env.DB, 'INFO', 'GEMINI', `${instrument.pair} ${geminiResult.decision} シグナル（既存ポジあり）`);
          }

          console.log(
            `[fx-sim] ✅ ${instrument.pair} ${geminiResult.decision} @ ${currentRate}` +
              ` TP=${geminiResult.tp_rate ?? '-'} SL=${geminiResult.sl_rate ?? '-'}` +
              ` | ${geminiResult.reasoning}`
          );

          cbRecordSuccess(); // サーキットブレーカー: 成功記録
          return { provider: hedgeResult.provider as 'gemini' | 'gpt' | 'claude', pair: instrument.pair };
        } catch (e) {
          // 429キー別クールダウン + サーキットブレーカー
          if (e instanceof RateLimitError) {
            markKeyCooldown(e.apiKey, e.retryAfterSec);
            await insertSystemLog(env.DB, 'WARN', 'RATE_LIMIT',
              `429 キークールダウン: ${e.apiKey.slice(0, 8)}... (${e.retryAfterSec}s)`,
              `pair=${instrument.pair}, available=${availableKeyCount(env)}`);
          }
          cbRecordFailure(); // サーキットブレーカー: 失敗記録
          const errMsg = String(e);
          console.warn(`[fx-sim] All AI failed (${instrument.pair}): ${errMsg.split('\n')[0].slice(0, 120)}`);
          await insertSystemLog(env.DB, 'ERROR', 'AI', `全プロバイダー失敗 (${instrument.pair})`, errMsg.split('\n')[0].slice(0, 200));
          await insertDecision(env.DB, {
            pair: instrument.pair,
            rate: currentRate,
            decision: 'HOLD',
            tp_rate: null,
            sl_rate: null,
            reasoning: `AI判定失敗: ${errMsg.split('\n')[0].slice(0, 80)}`,
            news_summary: null,
            reddit_signal: redditSignal.keywords.join(', ') || null,
            vix: indicators.vix,
            us10y: indicators.us10y,
            nikkei: indicators.nikkei,
            sp500: indicators.sp500,
            created_at: now.toISOString(),
            news_sources: activeNewsSources || null,
          });
          return { provider: 'fail', pair: instrument.pair };
        }
      })
    ).then(results => {
      for (const r of results) {
        if (r.status === 'fulfilled') batchResults.push(r.value);
      }
    });

    geminiOkCount += batchResults.filter(r => r.provider === 'gemini').length;
    gptOkCount    += batchResults.filter(r => r.provider === 'gpt').length;
    claudeOkCount += batchResults.filter(r => r.provider === 'claude').length;
    aiFailCount   += batchResults.filter(r => r.provider === 'fail').length;
  }

  return { geminiOk: geminiOkCount, gptOk: gptOkCount, claudeOk: claudeOkCount, fail: aiFailCount };
}

// ── Path B: ニュースドリブン 2段階AI判定 ──

/**
 * Path B: ニュースハッシュ変化時に起動
 * B1（タイトル即断）→ og:description取得 → B2（補正）の2段階で売買シグナルを生成
 */
async function runPathB(
  env: Env,
  sharedNewsStore: SharedNewsStore,
  indicators: Awaited<ReturnType<typeof getMarketIndicators>>,
  redditSignal: { hasSignal: boolean; keywords: string[]; topPosts: string[] },
  openPairs: Set<string>,
  apiKey: string,
  hedgeKeys?: { openaiApiKey?: string; anthropicApiKey?: string },
): Promise<PathBResult> {
  const news = sharedNewsStore.items;
  if (news.length === 0) return { decisions: [], reversals: [], newsAnalysis: [] };

  // 失敗クールダウンチェック（2分）
  const failedAtRaw = await getCacheValue(env.DB, 'news_analysis_failed_at');
  const failedAt = failedAtRaw ? parseInt(failedAtRaw) : 0;
  if ((Date.now() - failedAt) < 2 * 60 * 1000) {
    console.log('[fx-sim] Path B: クールダウン中のためスキップ');
    return { decisions: [], reversals: [], newsAnalysis: [] };
  }

  const instrumentList = INSTRUMENTS.map(i => ({
    pair: i.pair,
    hasOpenPosition: openPairs.has(i.pair),
  }));

  // B1: タイトル即断（タイムアウト10秒）— キャッシュ付き
  const B1_CACHE_KEY = 'path_b_b1_cache';
  const B1_CACHE_TTL_MS = 5 * 60 * 1000; // 5分TTL
  // stage1 は b1CacheHit=true 分岐 or API成功分岐で必ず代入される。
  // API失敗時は throw するため、ここ以降で未代入のまま使われることはない。
  let stage1!: NewsStage1Result;
  let b1Ms = 0, b2Ms = 0;
  let b1CacheHit = false;

  // B1キャッシュチェック: 同一ハッシュ＋TTL内なら再利用（Gemini呼び出し節約）
  const cachedB1Raw = await getCacheValue(env.DB, B1_CACHE_KEY);
  if (cachedB1Raw) {
    try {
      const cached = JSON.parse(cachedB1Raw) as { hash: string; at: number; result: NewsStage1Result };
      if (cached.hash === sharedNewsStore.hash && (Date.now() - cached.at) < B1_CACHE_TTL_MS) {
        stage1 = cached.result;
        b1CacheHit = true;
        console.log('[fx-sim] Path B B1: キャッシュヒット（Gemini呼び出しスキップ）');
      }
    } catch { /* キャッシュ破損は無視 */ }
  }

  if (!b1CacheHit) {
    try {
      const tB1 = Date.now();
      const b1Result = await newsStage1WithHedge({
        news, redditSignal, indicators, instruments: instrumentList, apiKey,
        openaiApiKey: hedgeKeys?.openaiApiKey,
        anthropicApiKey: hedgeKeys?.anthropicApiKey,
      });
      stage1 = b1Result;
      if (b1Result.provider !== 'gemini') {
        console.log(`[fx-sim] Path B B1: ${b1Result.provider}ヘッジ成功`);
      }
      b1Ms = Date.now() - tB1;
      cbRecordSuccess(); // B1成功 → サーキットブレーカー復旧
      console.log(`[fx-sim] Path B B1: ${stage1.news_analysis.filter((a: NewsAnalysisItem) => a.attention).length}件注目, ${stage1.trade_signals.length}件シグナル (${b1Ms}ms)`);

      // B1結果をキャッシュ保存
      void setCacheValue(env.DB, B1_CACHE_KEY, JSON.stringify({
        hash: sharedNewsStore.hash,
        at: Date.now(),
        result: stage1,
      })).catch(() => {});
    } catch (e) {
      if (e instanceof RateLimitError) {
        markKeyCooldown(e.apiKey, e.retryAfterSec);
      }
      cbRecordFailure();
      await setCacheValue(env.DB, 'news_analysis_failed_at', String(Date.now()));
      await insertSystemLog(env.DB, 'WARN', 'PATH_B', 'B1失敗→2分クールダウン', String(e).split('\n')[0].slice(0, 120));
      throw e;
    }
  }

  // B1成功後: og:description 並列取得（attention上位5件, 英語4ソースはスキップ）
  const attentionItems = stage1.news_analysis.filter((a: NewsAnalysisItem) => a.attention).slice(0, 5);
  const ogResults = await Promise.allSettled(
    attentionItems.map(async (a: NewsAnalysisItem) => {
      const item = news[a.index];
      if (!item) return { index: a.index, og: null };
      const og = await fetchOgDescription((item as any).link ?? '', (item as any).source ?? '');
      return { index: a.index, og };
    })
  );
  // og_description を news_analysis に付与
  for (const r of ogResults) {
    if (r.status === 'fulfilled' && r.value.og) {
      const target = stage1.news_analysis.find((a: NewsAnalysisItem) => a.index === r.value.index);
      if (target) target.og_description = r.value.og;
    }
  }

  // 過剰検出ガード: 10件超は先頭5件のみ採用
  let signals = stage1.trade_signals;
  if (signals.length > 10) {
    signals = signals.slice(0, 5);
    console.log(`[fx-sim] Path B: 過剰検出ガード (${stage1.trade_signals.length}件→5件)`);
  }

  if (signals.length === 0) {
    // B3: market_cache保存（非同期、売買をブロックしない）
    void (async () => {
      try {
        await setCacheValue(env.DB, 'news_analysis_failed_at', '0');
      } catch {}
    })();
    return { decisions: [], reversals: [], newsAnalysis: stage1.news_analysis };
  }

  // B2: og:desc付きで補正（タイムアウト8秒）
  let b2Corrections: { pair: string; action: 'CONFIRM' | 'REVISE' | 'REVERSE'; new_tp_rate?: number; new_sl_rate?: number; reasoning: string }[] = [];
  try {
    const tB2 = Date.now();
    const stage2 = await newsStage2({ stage1Result: stage1, news, apiKey });
    b2Ms = Date.now() - tB2;
    b2Corrections = stage2.corrections;
    console.log(`[fx-sim] Path B B2: ${b2Corrections.filter(c => c.action === 'CONFIRM').length}件CONFIRM, ${b2Corrections.filter(c => c.action === 'REVISE').length}件REVISE, ${b2Corrections.filter(c => c.action === 'REVERSE').length}件REVERSE (${b2Ms}ms)`);
  } catch (e) {
    // B2タイムアウト/失敗 → B1シグナルをそのまま採用
    console.warn(`[fx-sim] Path B B2 failed/timeout → B1採用: ${String(e).split('\n')[0].slice(0, 80)}`);
    await insertSystemLog(env.DB, 'WARN', 'PATH_B', 'B2失敗→B1シグナルそのまま採用', String(e).split('\n')[0].slice(0, 120));
  }

  // B2補正適用
  const decisions: PathDecision[] = [];
  const reversals: string[] = [];

  for (const signal of signals) {
    const correction = b2Corrections.find(c => c.pair === signal.pair);
    const action = correction?.action ?? 'CONFIRM';

    if (action === 'REVERSE') {
      reversals.push(signal.pair);
      continue; // toCloseに追加、同サイクル再オープン禁止
    }

    let tp = signal.tp_rate;
    let sl = signal.sl_rate;
    if (action === 'REVISE') {
      if (correction?.new_tp_rate != null) tp = correction.new_tp_rate;
      if (correction?.new_sl_rate != null) sl = correction.new_sl_rate;
    }

    decisions.push({
      pair: signal.pair,
      decision: signal.decision,
      tp_rate: tp,
      sl_rate: sl,
      reasoning: `${signal.reasoning}${action === 'REVISE' ? ` [B2:REVISE]` : ''}`,
      rate: 0, // 呼び出し元でprices.get(pair)で補完
      source: 'PATH_B',
      news_analysis: stage1.news_analysis,
    });
  }

  // B3: market_cache保存（非同期、売買をブロックしない）
  void (async () => {
    try {
      await setCacheValue(env.DB, 'news_analysis_failed_at', '0');
      await insertSystemLog(env.DB, 'INFO', 'PATH_B', `Path B完了: ${decisions.length}件決定, ${reversals.length}件REVERSE`, JSON.stringify({ b1Ms, b2Ms, signals: decisions.map(d => `${d.pair}:${d.decision}`) }));
    } catch {}
  })();

  return { decisions, reversals, newsAnalysis: stage1.news_analysis };
}

async function run(env: Env): Promise<void> {
  const now = new Date();
  const cronStart = Date.now();
  console.log(`[fx-sim] cron start ${now.toISOString()}`);

  try {
    // スキーママイグレーション（バージョン管理方式）
    await runMigrations(env.DB);

    // 1. 全価格・共通データを一括取得
    const t0 = Date.now();
    const marketData = await fetchMarketData(env, now);
    if (marketData == null) return;
    const fetchMs = Date.now() - t0;

    const { news, newsFetchStats: _newsFetchStats, activeNewsSources, redditSignal, indicators, prices } = marketData;
    await insertSystemLog(env.DB, 'INFO', 'FLOW', 'FETCH完了', JSON.stringify({
      ms: fetchMs, news: news.length,
      prices: [...prices.values()].filter(v => v != null).length,
      sources: activeNewsSources || 'none',
    }));

    // ブローカー環境（TP/SL・ポジション開設で使用）
    const brokerEnv: BrokerEnv = {
      OANDA_API_TOKEN: env.OANDA_API_TOKEN,
      OANDA_ACCOUNT_ID: env.OANDA_ACCOUNT_ID,
      OANDA_LIVE: env.OANDA_LIVE,
      TRADING_ENABLED: env.TRADING_ENABLED,
    };

    // テスタ施策12: 経済指標カレンダーチェック
    let economicEventGuard = { highImpactNearby: false, mediumImpactNearby: false, events: [] as import('./calendar').EconomicEvent[] };
    try {
      const calendarEvents = await fetchEconomicCalendar(env.DB, env.FINNHUB_API_KEY);
      if (calendarEvents.length > 0) {
        economicEventGuard = getUpcomingHighImpactEvents(calendarEvents, now);
        if (economicEventGuard.highImpactNearby) {
          console.log(`[fx-sim] 📅 S級イベント接近 — 新規エントリー強制HOLD`);
          await insertSystemLog(env.DB, 'INFO', 'CALENDAR',
            'S級イベント接近: 新規エントリー停止',
            JSON.stringify(economicEventGuard.events.slice(0, 3).map(e => e.event)));
        }
      }
    } catch { /* カレンダー失敗は無視 */ }

    // 2. 全銘柄のTP/SLを一括チェック（OANDA実弾ポジションはブローカー経由でクローズ）
    const t1 = Date.now();
    await checkAndCloseAllPositions(env.DB, prices, INSTRUMENTS, brokerEnv, getWebhookUrl(env));
    const tpSlMs = Date.now() - t1;
    await insertSystemLog(env.DB, 'INFO', 'FLOW', 'TPSL完了', JSON.stringify({ ms: tpSlMs }));

    // 3. 共有ニュースストア構築 + Path B 実行（計測開始）
    const t2 = Date.now();
    const prevNewsHashRaw = await getCacheValue(env.DB, PREV_NEWS_HASH_KEY);
    const currentNewsHash = newsHash(news);
    const hasChanged = currentNewsHash !== (prevNewsHashRaw ?? '');
    await setCacheValue(env.DB, PREV_NEWS_HASH_KEY, currentNewsHash);

    const sharedNewsStore: SharedNewsStore = { items: news, hash: currentNewsHash, hasChanged };


    /* DEPRECATED_v2: newsAnalysisRan / hasAttentionNews ロジック → runPathB() に置換
    let newsAnalysisRan = false;
    ...
    let hasAttentionNews = false;
    ...
    */

    // news_summary: JSON形式で保存（titleのみ、切り詰めなし）
    const newsSummary = news.length > 0
      ? JSON.stringify(news.slice(0, 5).map((n) => ({
          title: n.title,
        })))
      : null;

    // Path B 実行（ニュースハッシュ変化時のみ）
    const allOpenRawForPathB = await env.DB
      .prepare(`SELECT pair FROM positions WHERE status = 'OPEN'`)
      .all<{ pair: string }>();
    const openPairsForPathB = new Set((allOpenRawForPathB.results ?? []).map(p => p.pair));

    let pathBResult: PathBResult = { decisions: [], reversals: [], newsAnalysis: [] };

    // Path B 最小間隔チェック（5分）— 需要削減で429を構造的に防止
    const PATH_B_MIN_INTERVAL_MS = 5 * 60 * 1000;
    const lastPathBRaw = await getCacheValue(env.DB, 'last_path_b_at');
    const lastPathBAt = lastPathBRaw ? parseInt(lastPathBRaw) : 0;
    const pathBIntervalOk = (Date.now() - lastPathBAt) >= PATH_B_MIN_INTERVAL_MS;

    if (sharedNewsStore.hasChanged && pathBIntervalOk) {
      try {
        pathBResult = await runPathB(env, sharedNewsStore, indicators, redditSignal, openPairsForPathB, getApiKey(env), {
          openaiApiKey: env.OPENAI_API_KEY,
          anthropicApiKey: env.ANTHROPIC_API_KEY,
        });
        await setCacheValue(env.DB, 'last_path_b_at', String(Date.now()));
        console.log(`[fx-sim] Path B: ${pathBResult.decisions.length}件シグナル, ${pathBResult.reversals.length}件REVERSE`);
      } catch (e) {
        if (e instanceof RateLimitError) {
          markKeyCooldown(e.apiKey, e.retryAfterSec);
        }
        cbRecordFailure();
        console.warn(`[fx-sim] Path B failed: ${String(e).split('\n')[0].slice(0, 80)}`);
        await insertSystemLog(env.DB, 'WARN', 'PATH_B', 'Path B実行失敗', String(e).split('\n')[0].slice(0, 120));
      }
    } else if (sharedNewsStore.hasChanged && !pathBIntervalOk) {
      const elapsedSec = Math.round((Date.now() - lastPathBAt) / 1000);
      console.log(`[fx-sim] Path B: 最小間隔未達（${elapsedSec}s < 300s）→スキップ`);
    }
    await insertSystemLog(env.DB, 'INFO', 'FLOW', 'PATH_B完了', JSON.stringify({
      ms: Date.now() - t2,
      hasChanged: sharedNewsStore.hasChanged,
      signals: pathBResult.decisions.length,
      reversals: pathBResult.reversals.length,
    }));

    // Path B が処理した銘柄（BUY/SELL + REVERSE）を Path A/C から除外
    const pathBHandledPairs = new Set([
      ...pathBResult.decisions.map(d => d.pair),
      ...pathBResult.reversals,
    ]);

    // Path B REVERSE: 既存ポジションをクローズ
    if (pathBResult.reversals.length > 0) {
      const revPrices = new Map<string, number>();
      for (const pair of pathBResult.reversals) {
        const rate = prices.get(pair);
        if (rate != null) revPrices.set(pair, rate);
      }
      for (const [pair, rate] of revPrices) {
        try {
          // pair のオープンポジションをクローズ
          const openPos = await env.DB.prepare(
            `SELECT id, direction, entry_rate FROM positions WHERE pair = ? AND status = 'OPEN' LIMIT 1`
          ).bind(pair).first<{ id: number; direction: string; entry_rate: number }>();
          if (openPos) {
            const pnl = openPos.direction === 'BUY'
              ? (rate - openPos.entry_rate) * 100
              : (openPos.entry_rate - rate) * 100;
              await closePosition(env.DB, openPos.id, rate, 'B2_REVERSE', pnl);
            await insertSystemLog(env.DB, 'INFO', 'PATH_B', `B2_REVERSE クローズ: ${pair} @ ${rate}`);
          }
        } catch (e) {
          console.warn(`[fx-sim] Path B REVERSE close failed (${pair}): ${String(e).slice(0, 80)}`);
        }
      }
    }

    // Path B BUY/SELL: ポジション開設
    if (pathBResult.decisions.length > 0) {
      for (const dec of pathBResult.decisions) {
        if (dec.decision === 'HOLD') continue;
        const currentRate = prices.get(dec.pair);
        if (currentRate == null) continue;
        const hasOpenPos = openPairsForPathB.has(dec.pair);
        if (hasOpenPos) continue; // REVERSE後の再オープン禁止（同サイクル内）
        try {
          const instrument = INSTRUMENTS.find(i => i.pair === dec.pair);
          if (!instrument) continue;
          const sanity = checkTpSlSanity({
            direction: dec.decision as 'BUY' | 'SELL',
            rate: currentRate,
            tp: dec.tp_rate,
            sl: dec.sl_rate,
            instrument,
          });
          if (!sanity.valid) {
            await insertSystemLog(env.DB, 'WARN', 'SANITY', `Path B TP/SL異常値拒否: ${dec.pair}`, sanity.reason ?? undefined);
            continue;
          }
          await openPosition(env.DB, dec.pair, dec.decision as 'BUY' | 'SELL', currentRate, dec.tp_rate, dec.sl_rate, 'paper', null, getWebhookUrl(env));
          await insertSystemLog(env.DB, 'INFO', 'PATH_B', `ポジション開設: ${dec.pair} ${dec.decision} @ ${currentRate}`, JSON.stringify({ tp: dec.tp_rate, sl: dec.sl_rate }));
        } catch (e) {
          console.warn(`[fx-sim] Path B openPosition failed (${dec.pair}): ${String(e).slice(0, 80)}`);
        }
      }
    }

    // Path B decisions を decisions テーブルに記録
    // news_summary: そのdecisionに関連する注目ニュース(attention=true & affected_pairs一致)を格納
    if (pathBResult.decisions.length > 0) {
      const stmt = env.DB.prepare(
        `INSERT INTO decisions (pair, rate, decision, tp_rate, sl_rate, reasoning, news_summary, vix, us10y, nikkei, sp500, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      await env.DB.batch(pathBResult.decisions.map(d => {
        // この decision の pair に影響する注目ニュースを抽出
        const relevantNews = (d.news_analysis ?? pathBResult.newsAnalysis)
          .filter(a => a.attention && a.affected_pairs.includes(d.pair))
          .slice(0, 5)
          .map(a => ({
            title: news[a.index]?.title ?? a.title_ja,
            title_ja: a.title_ja,
            impact: a.impact,
          }));
        // フォールバック: pair一致がなければ attention=true の上位を使用
        const summaryItems = relevantNews.length > 0
          ? relevantNews
          : (d.news_analysis ?? pathBResult.newsAnalysis)
              .filter(a => a.attention)
              .slice(0, 3)
              .map(a => ({
                title: news[a.index]?.title ?? a.title_ja,
                title_ja: a.title_ja,
                impact: a.impact,
              }));
        const pathBNewsSummary = summaryItems.length > 0
          ? JSON.stringify(summaryItems)
          : newsSummary;
        return stmt.bind(
          d.pair, prices.get(d.pair) ?? d.rate, d.decision, d.tp_rate, d.sl_rate,
          `[PATH_B] ${d.reasoning}`, pathBNewsSummary,
          indicators.vix, indicators.us10y, indicators.nikkei, indicators.sp500,
          now.toISOString()
        );
      }));
    }

    // news_analysis + latest_news キャッシュ更新（Path B分析結果、title_ja付き）
    if (pathBResult.newsAnalysis.length > 0) {
      const enriched = pathBResult.newsAnalysis.map(a => ({
        ...a,
        title: news[a.index]?.title ?? null,
        pubDate: news[a.index]?.pubDate ?? null,
        description: news[a.index]?.description ?? null,
        source: (news[a.index] as any)?.source ?? null,
      }));
      await setCacheValue(env.DB, 'news_analysis', JSON.stringify(enriched));
      const titleJaMap = new Map(
        pathBResult.newsAnalysis.filter(a => a.title_ja).map(a => [a.index, a.title_ja] as [number, string])
      );
      await setCacheValue(env.DB, 'latest_news', JSON.stringify(
        news.slice(0, 30).map((n, i) => ({ ...n, title_ja: titleJaMap.get(i) || null }))
      ));
    }

    const newsMs = Date.now() - t2;

    // 4. 銘柄ごとにフィルタ → Gemini 判定 → 記録（並列化済み）
    const prevElapsedRaw = await getCacheValue(env.DB, 'prev_cron_elapsed');
    const prevElapsed = prevElapsedRaw ? parseInt(prevElapsedRaw) : 0;

    const t3 = Date.now();
    const aiSummary = await runAIDecisions(env, {
      indicators, news, redditSignal, newsSummary, activeNewsSources,
      brokerEnv, now, prices, prevElapsed,
      excludedPairs: pathBHandledPairs,
      economicEventGuard,
    }, cronStart);
    const aiLoopMs = Date.now() - t3;
    await insertSystemLog(env.DB, 'INFO', 'FLOW', 'PATH_A完了', JSON.stringify({
      ms: aiLoopMs,
      gemini: aiSummary.geminiOk,
      gpt: aiSummary.gptOk,
      claude: aiSummary.claudeOk,
      fail: aiSummary.fail,
    }));
    const totalMs = Date.now() - cronStart;
    const timings = { fetchMs, tpSlMs, newsMs, aiLoopMs, totalMs };
    await setCacheValue(env.DB, 'cron_phase_timings', JSON.stringify(timings));
    console.log(`[fx-sim] timings: fetch=${fetchMs}ms tpsl=${tpSlMs}ms news=${newsMs}ms ai=${aiLoopMs}ms total=${totalMs}ms`);

    const elapsed = totalMs;
    await setCacheValue(env.DB, 'prev_cron_elapsed', String(elapsed));
    const aiTotal = aiSummary.geminiOk + aiSummary.gptOk + aiSummary.claudeOk + aiSummary.fail;
    console.log(`[fx-sim] cron done in ${elapsed}ms` + (aiTotal > 0 ? ` | AI: Gemini=${aiSummary.geminiOk} GPT=${aiSummary.gptOk} Claude=${aiSummary.claudeOk} Fail=${aiSummary.fail}` : ''));
    // 実行時間が30秒超はWARN
    if (elapsed > 30000) {
      await insertSystemLog(env.DB, 'WARN', 'CRON', `実行時間超過: ${elapsed}ms`);
    }

    // 日次処理（JST 0:00 = UTC 15:00 に実行）
    const jstHour = (now.getUTCHours() + 9) % 24;
    if (jstHour === 0 && now.getUTCMinutes() === 0) {
      await runDailyTasks(env, now);
    }

  } catch (e) {
    console.error('[fx-sim] unhandled error:', e);
    // cron エラー通知
    await sendNotification(
      getWebhookUrl(env),
      `🔴 [fx-sim] cron エラー: ${String(e).slice(0, 200)}`,
    );
    try {
      await insertSystemLog(env.DB, 'ERROR', 'CRON', '予期しないエラー', String(e).slice(0, 300));
    } catch {}
  }
}

// ── 日次タスク（ログパージ・サマリー・銘柄スコア更新）──
async function runDailyTasks(env: Env, _now: Date): Promise<void> {
  // ログパージ
  try {
    await env.DB.prepare(`DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT 500)`).run();
    await env.DB.prepare(`DELETE FROM news_fetch_log WHERE id NOT IN (SELECT id FROM news_fetch_log ORDER BY id DESC LIMIT 5000)`).run();
  } catch {}

  // 日次サマリー記録
  try {
    const dailyPerf = await env.DB.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
       COALESCE(SUM(pnl), 0) AS totalPnl FROM positions WHERE status = 'CLOSED'`
    ).first<{ total: number; wins: number; totalPnl: number }>();
    const openCount = (await env.DB.prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'OPEN'`).first<{ c: number }>())?.c ?? 0;
    const balance = 10000 + (dailyPerf?.totalPnl ?? 0);
    const wr = dailyPerf && dailyPerf.total > 0 ? (dailyPerf.wins / dailyPerf.total * 100).toFixed(1) : '0';
    await insertSystemLog(env.DB, 'INFO', 'DAILY',
      `日次サマリー: ¥${Math.round(balance).toLocaleString()} ROI ${((balance - 10000) / 100).toFixed(1)}% 勝率${wr}% ${dailyPerf?.total ?? 0}件 OP${openCount}`);
  } catch {}

  // 銘柄スコア更新
  try {
    await updateInstrumentScores(env.DB);
  } catch (e) {
    console.error('[fx-sim] instrument_scores update failed:', e);
  }

  // SL パターン分析（日次バッチ）
  try {
    const slRows = await env.DB.prepare(
      `SELECT p.close_reason, p.closed_at, p.pair, d.vix
       FROM positions p
       LEFT JOIN decisions d ON d.pair = p.pair
         AND d.created_at <= p.closed_at
       WHERE p.status = 'CLOSED'
         AND p.close_reason IS NOT NULL
       ORDER BY p.closed_at DESC
       LIMIT 500`
    ).all<{ close_reason: string; closed_at: string; vix: number | null; pair: string }>();
    const patterns = slPatternAnalysis(slRows.results ?? []);
    await setCacheValue(env.DB, 'sl_patterns', JSON.stringify(patterns));
    console.log(`[daily] SL patterns: ${patterns.length} buckets`);
  } catch (e) {
    console.error('[daily] SL pattern analysis failed:', e);
  }

  // 日次サマリー Webhook 通知（前日の取引実績）
  try {
    // 前日の日付文字列を UTC で計算
    const yesterdayStart = new Date(Date.UTC(
      _now.getUTCFullYear(), _now.getUTCMonth(), _now.getUTCDate() - 1
    ));
    const todayStart = new Date(Date.UTC(
      _now.getUTCFullYear(), _now.getUTCMonth(), _now.getUTCDate()
    ));
    const dateStr = yesterdayStart.toISOString().slice(0, 10);

    const dailyStats = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        COALESCE(SUM(pnl), 0) as total_pnl
      FROM positions
      WHERE status = 'CLOSED'
        AND closed_at >= ? AND closed_at < ?
    `)
    .bind(yesterdayStart.toISOString(), todayStart.toISOString())
    .first<{ total: number; wins: number; total_pnl: number }>();

    if (dailyStats && dailyStats.total > 0) {
      // decisions.provider カラムは Batch C-3 で追加される予定
      // カラムが存在しない場合は 0 をフォールバックとして使う
      let geminiOk = 0, gptOk = 0, claudeOk = 0;
      try {
        const aiStats = await env.DB.prepare(`
          SELECT
            SUM(CASE WHEN provider = 'gemini' THEN 1 ELSE 0 END) as gemini_ok,
            SUM(CASE WHEN provider = 'gpt'    THEN 1 ELSE 0 END) as gpt_ok,
            SUM(CASE WHEN provider = 'claude' THEN 1 ELSE 0 END) as claude_ok
          FROM decisions
          WHERE decision IN ('BUY', 'SELL')
            AND created_at >= ? AND created_at < ?
        `)
        .bind(yesterdayStart.toISOString(), todayStart.toISOString())
        .first<{ gemini_ok: number; gpt_ok: number; claude_ok: number }>();
        if (aiStats) {
          geminiOk = aiStats.gemini_ok ?? 0;
          gptOk    = aiStats.gpt_ok    ?? 0;
          claudeOk = aiStats.claude_ok ?? 0;
        }
      } catch {
        // provider カラムが存在しない場合はスキップ（Batch C-3 適用前）
      }

      const msg = buildDailySummaryMessage({
        date: dateStr,
        totalTrades: dailyStats.total,
        wins: dailyStats.wins,
        totalPnl: dailyStats.total_pnl,
        geminiOk,
        gptOk,
        claudeOk,
      });
      await sendNotification(getWebhookUrl(env), msg);
    }
  } catch (e) {
    console.warn('[fx-sim] daily summary notification failed:', e);
  }

  // テスタ施策5: テクニカルキャンドル日次バッチ更新
  if (env.OANDA_API_TOKEN && env.OANDA_ACCOUNT_ID) {
    try {
      await updateAllCandles(
        env.DB, env.OANDA_API_TOKEN, env.OANDA_ACCOUNT_ID,
        env.OANDA_LIVE === 'true', INSTRUMENTS);
      console.log('[daily] Candles batch update complete');
    } catch (e) {
      console.warn('[daily] Candles batch update failed:', e);
    }
  }

  // テスタ施策12: 経済指標カレンダー日次更新
  try {
    await fetchEconomicCalendar(env.DB, env.FINNHUB_API_KEY);
  } catch {}

  // テスタ施策15: 週次/月次レビュー
  const dayOfWeek = _now.getUTCDay();
  const dayOfMonth = _now.getUTCDate();
  try {
    if (dayOfWeek === 1) { // 月曜日
      const review = await generateWeeklyReview(env.DB);
      await sendNotification(getWebhookUrl(env), review);
      console.log('[daily] Weekly review sent');
    }
    if (dayOfMonth === 1) { // 月初
      const review = await generateMonthlyReview(env.DB);
      await sendNotification(getWebhookUrl(env), review);
      console.log('[daily] Monthly review sent');
    }
  } catch (e) {
    console.warn('[daily] Review generation failed:', e);
  }
}

// ── 銘柄スコア日次更新 ──
async function updateInstrumentScores(db: D1Database): Promise<void> {
  // 各銘柄のクローズ済みポジションから統計を計算
  const rows = await db.prepare(
    `SELECT pair,
       COUNT(*) AS total_trades,
       COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
       COALESCE(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END), 0) AS total_win_pnl,
       COALESCE(SUM(CASE WHEN pnl <= 0 THEN ABS(pnl) ELSE 0 END), 0) AS total_loss_pnl,
       COALESCE(AVG(pnl), 0) AS avg_pnl,
       COALESCE(SUM(pnl), 0) AS total_pnl
     FROM positions WHERE status = 'CLOSED'
     GROUP BY pair`
  ).all<{
    pair: string; total_trades: number; wins: number;
    total_win_pnl: number; total_loss_pnl: number;
    avg_pnl: number; total_pnl: number;
  }>();

  if (!rows.results || rows.results.length === 0) return;

  // PnL配列（Sharpe計算用）
  const pnlByPair: Record<string, number[]> = {};
  const allPnl = await db.prepare(
    `SELECT pair, pnl FROM positions WHERE status = 'CLOSED' ORDER BY closed_at ASC`
  ).all<{ pair: string; pnl: number }>();
  for (const r of (allPnl.results ?? [])) {
    if (!pnlByPair[r.pair]) pnlByPair[r.pair] = [];
    pnlByPair[r.pair].push(r.pnl);
  }

  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO instrument_scores (pair, total_trades, win_rate, avg_rr, sharpe, correlation, score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pair) DO UPDATE SET
       total_trades = excluded.total_trades,
       win_rate = excluded.win_rate,
       avg_rr = excluded.avg_rr,
       sharpe = excluded.sharpe,
       correlation = excluded.correlation,
       score = excluded.score,
       updated_at = excluded.updated_at`
  );

  const batch = [];
  for (const r of rows.results) {
    const winRate = r.total_trades > 0 ? r.wins / r.total_trades : 0;
    const avgWin = r.wins > 0 ? r.total_win_pnl / r.wins : 0;
    const losses = r.total_trades - r.wins;
    const avgLoss = losses > 0 ? r.total_loss_pnl / losses : 0;
    const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;

    // Sharpe = mean / stdev
    const pnls = pnlByPair[r.pair] || [];
    let sharpe = 0;
    if (pnls.length >= 3) {
      const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
      const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length;
      const stdev = Math.sqrt(variance);
      sharpe = stdev > 0 ? mean / stdev : 0;
    }

    // 総合スコア: 勝率30% + RR比30% + Sharpe20% + 取引数20%（最低サンプル数考慮）
    const tradeScore = Math.min(r.total_trades / 20, 1); // 20件で満点
    const score = winRate * 0.3 + Math.min(avgRR / 2, 1) * 0.3 + Math.min(Math.max(sharpe, 0) / 1, 1) * 0.2 + tradeScore * 0.2;

    batch.push(stmt.bind(r.pair, r.total_trades, winRate, avgRR, sharpe, 0, score, now));
  }

  if (batch.length > 0) {
    await db.batch(batch);
    console.log(`[fx-sim] instrument_scores updated: ${batch.length} pairs`);
  }
}

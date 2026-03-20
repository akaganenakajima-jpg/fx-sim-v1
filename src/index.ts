// エントリーポイント
// scheduled: 1分ごとにレート取得→指標取得→TP/SL確認→フィルタ→Gemini判定→記録
// fetch:     GET / → ダッシュボード、GET /api/status → JSON、GET /style.css・/app.js → 静的ファイル

import { getUSDJPY } from './rate';
import { fetchNews, type SourceFetchStat } from './news';
import { fetchRedditSignal } from './reddit';
import { getMarketIndicators } from './indicators';
import { getDecision, getDecisionGPT, getDecisionClaude, getDecisionWithHedge, analyzeNews } from './gemini';
import { checkAndCloseAllPositions, openPosition } from './position';
import { shouldCallGemini } from './filter';
import {
  getOpenPositionByPair,
  insertDecision,
  insertSystemLog,
  getCacheValue,
  setCacheValue,
} from './db';
import { getDashboardHtml } from './dashboard';
import { getApiStatus } from './api';
import { CSS } from './style.css';
import { JS } from './app.js';
import { INSTRUMENTS, type InstrumentConfig } from './instruments';
import { getBroker, withFallback, type BrokerEnv } from './broker';
import { checkRisk, type RiskEnv } from './risk-guard';
import { checkTpSlSanity } from './sanity';
import { runMigrations } from './migration';
import { sendNotification, getWebhookUrl, buildDailySummaryMessage } from './notify';

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
}

let _keyIndex = 0;
function getApiKey(env: Env): string {
  const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3, env.GEMINI_API_KEY_4, env.GEMINI_API_KEY_5].filter(Boolean) as string[];
  const key = keys[_keyIndex % keys.length];
  _keyIndex++;
  return key;
}

const PREV_NEWS_HASH_KEY = 'prev_news_hash';

function newsHash(titles: string[]): string {
  return titles.join('|');
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
  const indicators = indicatorsResult.status === 'fulfilled' ? indicatorsResult.value : { vix: null, us10y: null, nikkei: null, sp500: null, usdjpy: null, btcusd: null, gold: null, eurusd: null, ethusd: null, crudeoil: null, natgas: null, copper: null, silver: null, gbpusd: null, audusd: null, solusd: null, dax: null, nasdaq: null };
  const frankfurterRate = frankfurterResult.status === 'fulfilled' ? frankfurterResult.value : null;

  const usdJpyRate = indicators.usdjpy ?? frankfurterRate;
  if (usdJpyRate == null) {
    console.error('[fx-sim] USD/JPY rate unavailable from all sources');
    await insertSystemLog(env.DB, 'ERROR', 'RATE', 'USD/JPYレート取得失敗（全ソース）', null);
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

async function run(env: Env): Promise<void> {
  const now = new Date();
  const cronStart = Date.now();
  console.log(`[fx-sim] cron start ${now.toISOString()}`);

  try {
    // スキーママイグレーション（バージョン管理方式）
    await runMigrations(env.DB);

    // 1. 全価格・共通データを一括取得
    const marketData = await fetchMarketData(env, now);
    if (marketData == null) return;

    const { news, newsFetchStats: _newsFetchStats, activeNewsSources, redditSignal, indicators, prices } = marketData;

    // ブローカー環境（TP/SL・ポジション開設で使用）
    const brokerEnv: BrokerEnv = {
      OANDA_API_TOKEN: env.OANDA_API_TOKEN,
      OANDA_ACCOUNT_ID: env.OANDA_ACCOUNT_ID,
      OANDA_LIVE: env.OANDA_LIVE,
      TRADING_ENABLED: env.TRADING_ENABLED,
    };

    // 2. 全銘柄のTP/SLを一括チェック（OANDA実弾ポジションはブローカー経由でクローズ）
    await checkAndCloseAllPositions(env.DB, prices, INSTRUMENTS, brokerEnv, getWebhookUrl(env));

    // 3. ニュースハッシュ更新
    const prevNewsHashRaw = await getCacheValue(env.DB, PREV_NEWS_HASH_KEY);
    const currentNewsHash = newsHash(news.map((n) => n.title));
    const hasNewNews = currentNewsHash !== (prevNewsHashRaw ?? '');
    await setCacheValue(env.DB, PREV_NEWS_HASH_KEY, currentNewsHash);

    // 失敗クールダウン: 直近2分以内に失敗していたらスキップ（Phase1: 5min→2min短縮）
    const newsFailedAtRaw = await getCacheValue(env.DB, 'news_analysis_failed_at');
    const newsFailedAt = newsFailedAtRaw ? parseInt(newsFailedAtRaw) : 0;
    const NEWS_COOLDOWN_MS = 2 * 60 * 1000; // 2分
    const inNewsCooldown = (Date.now() - newsFailedAt) < NEWS_COOLDOWN_MS;

    // 新ニュース検出時: Gemini 1回のみ（Phase1: 3段fallback廃止）
    let newsAnalysisRan = false;
    if (hasNewNews && news.length > 0 && !inNewsCooldown) {
      let analysis = null;
      try {
        analysis = await analyzeNews({ news, apiKey: getApiKey(env) });
      } catch (e) {
        console.warn(`[fx-sim] News analysis failed: ${String(e).split('\n')[0].slice(0, 80)}`);
        // 失敗 → 2分クールダウン開始（次のcronで再試行）
        await setCacheValue(env.DB, 'news_analysis_failed_at', String(Date.now()));
        await insertSystemLog(env.DB, 'WARN', 'NEWS', 'ニュース分析失敗→2分クールダウン', String(e).split('\n')[0].slice(0, 120));
      }
      if (analysis && analysis.length > 0) {
        // 分析結果にニュースタイトルを紐付け（index→titleマッチング用）
        const enriched = analysis.map((a: { index: number; attention: boolean; impact: string | null; title_ja: string | null }) => ({
          ...a,
          title: news[a.index]?.title ?? null,
          pubDate: news[a.index]?.pubDate ?? null,
          description: news[a.index]?.description ?? null,
          source: (news[a.index] as any)?.source ?? null,
        }));
        await setCacheValue(env.DB, 'news_analysis', JSON.stringify(enriched));
        // 分析と同じニュースセットをキャッシュ（APIで同期を保証）
        await setCacheValue(env.DB, 'latest_news', JSON.stringify(news.slice(0, 30)));
        // 成功時はクールダウンをクリア
        await setCacheValue(env.DB, 'news_analysis_failed_at', '0');
        newsAnalysisRan = true;
        console.log(`[fx-sim] News analysis: ${analysis.filter(a => a.attention).length}/${analysis.length} flagged`);
      }
    }

    // news_summary: JSON形式で保存（titleのみ、切り詰めなし）
    const newsSummary = news.length > 0
      ? JSON.stringify(news.slice(0, 5).map((n) => ({
          title: n.title,
        })))
      : null;

    // 🔥ニュースドリブン: 注目ニュースがあればフィルタをスキップ
    let hasAttentionNews = false;
    if (newsAnalysisRan) {
      // 今回分析した結果から注目フラグを確認
      try {
        const analysisRaw = await getCacheValue(env.DB, 'news_analysis');
        if (analysisRaw) {
          const analysis = JSON.parse(analysisRaw);
          hasAttentionNews = Array.isArray(analysis) && analysis.some((a: { attention: boolean }) => a.attention);
          if (hasAttentionNews) {
            console.log('[fx-sim] 🔥 Attention news detected! Forcing Gemini calls for all instruments');
            await insertSystemLog(env.DB, 'INFO', 'NEWS', '🔥注目ニュース検出 → 全銘柄即時判定', null);
          }
        }
      } catch {}
    }

    // 4. 銘柄ごとにフィルタ → Gemini 判定 → 記録
    // 429クールダウンチェック
    const cooldownKey = 'gemini_cooldown_until';
    const cooldownRaw = await getCacheValue(env.DB, cooldownKey);
    const cooldownUntil = cooldownRaw ? parseInt(cooldownRaw) : 0;
    const isInCooldown = Date.now() < cooldownUntil;
    if (isInCooldown) console.log(`[fx-sim] Gemini cooldown until ${new Date(cooldownUntil).toISOString()}`);

    // 動的上限: 前回実行時間に応じて調整
    const prevElapsedRaw = await getCacheValue(env.DB, 'prev_cron_elapsed');
    const prevElapsed = prevElapsedRaw ? parseInt(prevElapsedRaw) : 0;
    const baseLimit = prevElapsed > 30000 ? 3 : prevElapsed > 15000 ? 5 : 8;
    // Phase1: newsAnalysisRan ? 0 を廃止（ニュース分析後も銘柄判定を実行する）
    const MAX_GEMINI_PER_RUN = isInCooldown
      ? 0  // 429クールダウン中のみスキップ
      : hasAttentionNews ? Math.min(baseLimit + 3, 10) : baseLimit;
    // 4a. 全銘柄のレート変化・フィルタ結果を事前収集
    const candidateList: Array<{
      instrument: InstrumentConfig;
      currentRate: number;
      prevRate: number;
      filterResult: { shouldCall: boolean; reason: string };
      volatilityScore: number; // ボラティリティ %
      sessionBonus: number;    // 市場時間帯ボーナス
      totalScore: number;
    }> = [];

    // 市場時間帯マッピング（JST）
    const jstH = (now.getUTCHours() + 9) % 24;
    // 東京 8-15, ロンドン 16-1, NY 22-7（JST）
    const isTokyoSession = jstH >= 8 && jstH < 15;
    const isLondonSession = jstH >= 16 || jstH < 1;
    const isNYSession = jstH >= 22 || jstH < 7;

    const SESSION_MAP: Record<string, string[]> = {
      tokyo:  ['USD/JPY', 'Nikkei225', 'AUD/USD'],
      london: ['EUR/USD', 'GBP/USD', 'DAX', 'Gold', 'Silver', 'Copper'],
      ny:     ['S&P500', 'NASDAQ', 'US10Y', 'CrudeOil', 'NatGas', 'BTC/USD', 'ETH/USD', 'SOL/USD'],
    };

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
        continue; // キャッシュもない場合はスキップ（個別WARNは出さない — 上の一括WARNで十分）
      }

      const cacheKey = `prev_rate_${instrument.pair}`;
      const prevRateRaw = cacheMap.get(cacheKey) ?? null;
      const prevRate = prevRateRaw ? parseFloat(prevRateRaw) : currentRate;
      rateUpdates.push({ key: cacheKey, value: String(currentRate) });

      const lastCallKey = `last_ai_call_${instrument.pair}`;
      const lastCallTime = cacheMap.get(lastCallKey) ?? null;

      const filterResult = shouldCallGemini({
        currentRate, prevRate,
        rateChangeTh: instrument.rateChangeTh,
        hasNewNews, redditSignal, now, lastCallTime,
      });

      // ボラティリティスコア: レート変化率（%）÷ 閾値（正規化）
      const changePct = prevRate !== 0 ? Math.abs(currentRate - prevRate) / prevRate : 0;
      const volatilityScore = changePct / (instrument.rateChangeTh / (prevRate || 1));

      // 市場時間帯ボーナス: アクティブセッションの銘柄は +0.5
      let sessionBonus = 0;
      if (isTokyoSession && SESSION_MAP.tokyo.includes(instrument.pair)) sessionBonus = 0.5;
      if (isLondonSession && SESSION_MAP.london.includes(instrument.pair)) sessionBonus = 0.5;
      if (isNYSession && SESSION_MAP.ny.includes(instrument.pair)) sessionBonus = 0.5;

      candidateList.push({
        instrument, currentRate, prevRate, filterResult,
        volatilityScore, sessionBonus,
        totalScore: volatilityScore + sessionBonus,
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
    const passed = candidateList.filter(c => c.filterResult.shouldCall || hasAttentionNews);
    const skipped = candidateList.filter(c => !c.filterResult.shouldCall && !hasAttentionNews);
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
      // reverse each to chronological order
      for (const [pair, rates] of sparkMap) {
        sparkMap.set(pair, rates.reverse());
      }
    }

    // 4c. スコア上位からAI判定（予算チェック: 50s超で打ち切り）
    for (const candidate of aiCandidates) {
      if (Date.now() - cronStart > 50_000) {
        console.warn(`[fx-sim] Cron budget exhausted (${Date.now() - cronStart}ms), skipping remaining AI calls`);
        break;
      }
      const { instrument, currentRate } = candidate;

      const hasOpenPosition = openPositionSet.has(instrument.pair);
      const recentTrades = recentTradesMap.get(instrument.pair) ?? [];
      const sparkRates = sparkMap.get(instrument.pair) ?? [];

      // AI判定（ヘッジリクエスト: Gemini→4秒後GPT並行→最速採用）
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
          geminiApiKey: getApiKey(env),
          openaiApiKey: env.OPENAI_API_KEY,
          openaiApiKey2: env.OPENAI_API_KEY_2,
          anthropicApiKey: env.ANTHROPIC_API_KEY,
          keyIndex: _keyIndex,
        });
        geminiResult = hedgeResult.decision;
        if (hedgeResult.provider === 'gemini') geminiOkCount++;
        else if (hedgeResult.provider === 'gpt') gptOkCount++;
        else claudeOkCount++;
        if (hedgeResult.provider !== 'gemini') {
          await insertSystemLog(env.DB, 'INFO', hedgeResult.provider.toUpperCase(), `${hedgeResult.provider}ヘッジ成功 (${instrument.pair}) → ${geminiResult.decision}`, null);
        }
      } catch (e) {
        const errMsg = String(e);
        console.warn(`[fx-sim] All AI failed (${instrument.pair}): ${errMsg.split('\n')[0].slice(0, 120)}`);
        aiFailCount++;
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
        continue;
      }

      // decisions 記録
      await insertDecision(env.DB, {
        pair: instrument.pair,
        rate: currentRate,
        decision: geminiResult.decision,
        tp_rate: geminiResult.tp_rate,
        sl_rate: geminiResult.sl_rate,
        reasoning: geminiResult.reasoning,
        news_summary: newsSummary || null,
        reddit_signal: redditSignal.keywords.join(', ') || null,
        vix: indicators.vix,
        us10y: indicators.us10y,
        nikkei: indicators.nikkei,
        sp500: indicators.sp500,
        created_at: now.toISOString(),
        news_sources: activeNewsSources || null,
      });

      // 最終AI呼び出し時刻を更新（定期強制呼び出し用）
      await setCacheValue(env.DB, `last_ai_call_${instrument.pair}`, now.toISOString());

      // BUY/SELL なら新規ポジションをオープン
      if (
        (geminiResult.decision === 'BUY' || geminiResult.decision === 'SELL') &&
        !hasOpenPosition
      ) {
        // TP/SLサニティチェック: AIが極端な値を返した場合の防御
        const sanity = checkTpSlSanity({
          direction: geminiResult.decision,
          rate: currentRate,
          tp: geminiResult.tp_rate,
          sl: geminiResult.sl_rate,
          instrument,
        });
        if (!sanity.valid) {
          console.warn(`[fx-sim] Sanity rejected: ${instrument.pair} ${sanity.reason}`);
          await insertSystemLog(env.DB, 'WARN', 'SANITY',
            `TP/SL異常値拒否: ${instrument.pair} ${geminiResult.decision}`,
            sanity.reason ?? null);
          // ポジション開設をスキップ（decisionsには記録済み）
          continue;
        }

        // ブローカー判定 + リスクチェック
        const broker = getBroker(instrument, brokerEnv);
        const isLive = broker.name === 'oanda';
        let source: 'paper' | 'oanda' = 'paper';
        let oandaTradeId: string | null = null;

        if (isLive) {
          // RiskGuard: 実弾発注前の安全チェック
          const riskResult = await checkRisk({
            db: env.DB,
            env: env as RiskEnv,
            pair: instrument.pair,
            currentRate,
            prevRate: candidate.prevRate,
            requestedLot: 1, // lot は openPosition 内で動的計算
          });

          if (!riskResult.allowed) {
            console.warn(`[fx-sim] RiskGuard blocked: ${instrument.pair} → ${riskResult.reason}`);
            await insertSystemLog(env.DB, 'WARN', 'RISK',
              `実弾ブロック: ${instrument.pair} ${geminiResult.decision}`,
              riskResult.reason);
            // ペーパーにフォールバック（記録は残す）
          } else {
            // OANDA 実弾発注
            const brokerResult = await withFallback(broker, () => broker.openPosition({
              pair: instrument.pair,
              oandaSymbol: instrument.oandaSymbol,
              direction: geminiResult.decision,
              entryRate: currentRate,
              tpRate: geminiResult.tp_rate,
              slRate: geminiResult.sl_rate,
              lot: riskResult.adjustedLot ?? 1,
            }), env.DB, `open ${instrument.pair} ${geminiResult.decision}`);

            if (brokerResult.success && !brokerResult.error?.startsWith('Fallback')) {
              source = 'oanda';
              oandaTradeId = brokerResult.oandaTradeId ?? null;
              console.log(`[fx-sim] 🔴 LIVE: ${instrument.pair} ${geminiResult.decision} tradeId=${oandaTradeId}`);
            }
          }
        }

        await openPosition(
          env.DB,
          instrument.pair,
          geminiResult.decision,
          currentRate,
          geminiResult.tp_rate,
          geminiResult.sl_rate,
          source,
          oandaTradeId
        );
        await insertSystemLog(
          env.DB, 'INFO', 'POSITION',
          `ポジション開設: ${instrument.pair} ${geminiResult.decision} @ ${currentRate} [${source}]`,
          JSON.stringify({ tp: geminiResult.tp_rate, sl: geminiResult.sl_rate, source, oandaTradeId, reasoning: geminiResult.reasoning?.slice(0, 100) })
        );
      } else if (geminiResult.decision !== 'HOLD') {
        // BUY/SELLだがポジション既存のためスキップ
        await insertSystemLog(env.DB, 'INFO', 'GEMINI', `${instrument.pair} ${geminiResult.decision} シグナル（既存ポジあり）`, null);
      }

      console.log(
        `[fx-sim] ✅ ${instrument.pair} ${geminiResult.decision} @ ${currentRate}` +
          ` TP=${geminiResult.tp_rate ?? '-'} SL=${geminiResult.sl_rate ?? '-'}` +
          ` | ${geminiResult.reasoning}`
      );
    }
    const elapsed = Date.now() - cronStart;
    await setCacheValue(env.DB, 'prev_cron_elapsed', String(elapsed));
    const aiTotal = geminiOkCount + gptOkCount + claudeOkCount + aiFailCount;
    console.log(`[fx-sim] cron done in ${elapsed}ms (limit=${MAX_GEMINI_PER_RUN})` + (aiTotal > 0 ? ` | AI: Gemini=${geminiOkCount} GPT=${gptOkCount} Claude=${claudeOkCount} Fail=${aiFailCount}` : ''));
    // 実行時間が30秒超はWARN
    if (elapsed > 30000) {
      await insertSystemLog(env.DB, 'WARN', 'CRON', `実行時間超過: ${elapsed}ms`, null);
    }

    // 日次処理（JST 0:00 = UTC 15:00 に実行）
    const jstHour = (now.getUTCHours() + 9) % 24;
    if (jstHour === 0 && now.getUTCMinutes() === 0) {
      await runDailyTasks(env, now);
    }

  } catch (e) {
    console.error('[fx-sim] unhandled error:', e);
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
      `日次サマリー: ¥${Math.round(balance).toLocaleString()} ROI ${((balance - 10000) / 100).toFixed(1)}% 勝率${wr}% ${dailyPerf?.total ?? 0}件 OP${openCount}`,
      null);
  } catch {}

  // 銘柄スコア更新
  try {
    await updateInstrumentScores(env.DB);
  } catch (e) {
    console.error('[fx-sim] instrument_scores update failed:', e);
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

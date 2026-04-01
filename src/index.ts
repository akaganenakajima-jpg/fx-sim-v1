// エントリーポイント
// scheduled: 1分ごとにレート取得→指標取得→TP/SL確認→フィルタ→Gemini判定→記録
// fetch:     GET / → ダッシュボード、GET /api/status → JSON、GET /style.css・/app.js → 静的ファイル

import { getUSDJPY } from './rate';
import { fetchNews, filterAndTranslateNews, saveRawNews, purgeOldNewsRaw, type SourceFetchStat, type NewsApiKeys } from './news';
import { getMarketIndicators } from './indicators';
import { fetchOgDescription, newsStage1WithHedge, newsStage2, getAdaptiveB2Timeout, premarketAnalysis, RateLimitError, type NewsAnalysisItem, type NewsStage1Result } from './gemini';
import { checkAndCloseAllPositions, openPosition, calcRealizedRR } from './position';
import {
  insertSystemLog,
  getCacheValue,
  setCacheValue,
  closePosition,
  getOpenPositions,
} from './db';
import { slPatternAnalysis, logReturn } from './stats';
import { getDashboardHtml } from './dashboard';
import { getApiStatus, getApiParams } from './api';
import { CSS } from './style.css';
import { JS } from './app.js';
import { INSTRUMENTS } from './instruments';
import { type BrokerEnv } from './broker';
import { checkTpSlSanity } from './sanity';
import { runMigrations } from './migration';
import { sendNotification, getWebhookUrl, buildDailySummaryMessage } from './notify';
// テスタ施策 Phase 2-7
import { updateAllCandles } from './candles';
import { fetchEconomicCalendar, getUpcomingHighImpactEvents } from './calendar';
import { generateWeeklyReview, generateMonthlyReview } from './trade-journal';
import { detectBreakout } from './breakout';
import { determineRegime, formatRegimeForPrompt, getRegimeProhibitions } from './regime';
import { getWeekendStatus, lockProfitsForWeekend, forceCloseAllForWeekend, getWeekendNewsDigest, saveFridayClosePrices, detectGaps, resetWeekendFlags, getTradeableInstruments } from './weekend';
import { runLogicDecisions } from './logic-trading';
import { runParamReview } from './param-review';
import { evaluateRecoveryIfNeeded, getDrawdownLevel, getAllMarketDrawdownLevels, checkInstrumentDailyLoss, setGlobalDDEnabled, checkMarketCloseAndReleaseDDStop } from './risk-manager';
import { runNewsTrigger, consumeEmergencyForceFlag } from './news-trigger';
// AI銘柄マネージャー
import { fetchFundamentals, saveFundamentals, fetchAllListedStocks, cleanupOldFundamentals } from './jquants';
import { calcStockScore, saveScores, countNewsForSymbol, getSectorAvgPer, type StockScoreInput } from './scoring';
import { getTrackingList, getCandidateList, detectPromotionCandidates, detectDemotionCandidates, proposeRotation, processAutoApproval as autoApprove, recordResultPnl, decideRotation, getPendingRotations } from './rotation';
import { INITIAL_CAPITAL } from './constants';

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
  // JSON API ニュースソース
  POLYGON_API_KEY?: string;
  MARKETAUX_API_KEY?: string;
  CRYPTOPANIC_API_KEY?: string;
  // FINNHUB_API_KEY は calendar.ts と共有（上記に既に定義）
  // AI銘柄マネージャー
  JQUANTS_REFRESH_TOKEN?: string;
}

// ── キー別クールダウン管理 ──
// Workers は cron 実行ごとにリセット（ステートレス）なので Map で十分
const keyCooldowns = new Map<string, number>();  // apiKey → cooldownUntil timestamp
const keyUsageCount = new Map<string, number>(); // apiKey → 使用回数（均等分散用）

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

/** 全レスポンスにセキュリティヘッダーを付与 */
function withSec(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('X-Frame-Options', 'DENY');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  h.set('X-XSS-Protection', '1; mode=block');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // GET専用ルートへの非GETメソッドを早期リジェクト（PUT/DELETE/PATCH → 405）
    const GET_ONLY_ROUTES = ['/api/status', '/api/params', '/api/scores', '/api/rotation/pending', '/api/rotation/history'];
    if (GET_ONLY_ROUTES.includes(url.pathname) && request.method !== 'GET' && request.method !== 'HEAD') {
      return withSec(new Response('Method Not Allowed', { status: 405 }));
    }
    const res = await (async (): Promise<Response> => {
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
      case '/manifest.json':
        return new Response(JSON.stringify({
          name: 'FX Sim',
          short_name: 'FX Sim',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#000000',
          theme_color: '#000000',
          description: 'FX仮想トレードシミュレーター — Gemini AIによるリアルタイム売買判断',
          icons: [
            { src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
            { src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
          ],
        }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
        });
      case '/icon-192.svg':
      case '/icon-192.png':
      case '/icon-512.svg':
      case '/icon-512.png': {
        const size = url.pathname.includes('512') ? 512 : 192;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${Math.round(size * 0.2)}" fill="#1C1C1E"/><text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="#30D158" font-family="system-ui" font-size="${Math.round(size * 0.35)}" font-weight="800">FX</text></svg>`;
        return new Response(svg, {
          headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
        });
      }
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
      case '/api/params':
        try {
          const paramsData = await getApiParams(env.DB);
          return new Response(JSON.stringify(paramsData), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      case '/api/rotation/pending':
        try {
          const pending = await getPendingRotations(env.DB);
          return new Response(JSON.stringify({ rotations: pending }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, message: String(e) }), {
            headers: { 'Content-Type': 'application/json' },
            status: 500,
          });
        }
      case '/api/rotation/history':
        try {
          const histRows = await env.DB.prepare(
            'SELECT id, proposed_at, in_symbol, out_symbol, status, in_result_pnl, out_result_pnl FROM rotation_log ORDER BY proposed_at DESC LIMIT 20'
          ).all();
          return new Response(JSON.stringify({ rotations: histRows.results ?? [] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, message: String(e) }), {
            headers: { 'Content-Type': 'application/json' },
            status: 500,
          });
        }
      case '/api/rotation':
        if (request.method === 'POST') {
          // JSONパース失敗（空body含む）は 400 で返す
          let rotationBody: { id: number; action: 'approve' | 'reject' };
          try {
            rotationBody = await request.json() as { id: number; action: 'approve' | 'reject' };
          } catch {
            return new Response(JSON.stringify({ success: false, message: 'Invalid JSON body' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          if (!rotationBody.id || typeof rotationBody.id !== 'number' || !['approve', 'reject'].includes(rotationBody.action)) {
            return new Response(JSON.stringify({ success: false, message: 'Invalid input' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          try {
            const result = await decideRotation(env.DB, rotationBody.id, rotationBody.action);
            return new Response(JSON.stringify(result), {
              headers: { 'Content-Type': 'application/json' },
              status: result.success ? 200 : 404,
            });
          } catch (e) {
            return new Response(JSON.stringify({ success: false, message: String(e) }), {
              headers: { 'Content-Type': 'application/json' },
              status: 500,
            });
          }
        }
        return new Response('Method Not Allowed', { status: 405 });

      case '/api/settings':
        if (request.method === 'POST') {
          let settingsBody: { key: string; value: string };
          try {
            settingsBody = await request.json() as { key: string; value: string };
          } catch {
            return new Response(JSON.stringify({ success: false, message: 'Invalid JSON body' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          // ホワイトリスト検証（グローバルDD管理のみ許可）
          if (settingsBody.key !== 'global_dd_enabled' || !['true', 'false'].includes(settingsBody.value)) {
            return new Response(JSON.stringify({ success: false, message: 'Invalid key or value' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          try {
            await setGlobalDDEnabled(env.DB, settingsBody.value === 'true');
            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (e) {
            return new Response(JSON.stringify({ success: false, message: String(e) }), {
              headers: { 'Content-Type': 'application/json' },
              status: 500,
            });
          }
        }
        return new Response('Method Not Allowed', { status: 405 });

      case '/api/scores': {
        try {
          const today = new Date().toISOString().split('T')[0];
          const rows = await env.DB.prepare(`
            SELECT symbol, theme_score, funda_score, momentum_score, total_score, rank, in_universe
            FROM stock_scores
            WHERE scored_at = ?
            ORDER BY rank ASC
            LIMIT 60
          `).bind(today).all();

          const trackingRows = await env.DB.prepare(
            "SELECT pair, added_at FROM active_instruments"
          ).all<{ pair: string; added_at: string }>();

          return new Response(JSON.stringify({
            scoredAt: today,
            scores: rows.results ?? [],
            trackingList: trackingRows.results ?? [],
          }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      default:
        return new Response('Not Found', { status: 404 });
    }
    })();
    return withSec(res);
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const cron = event.cron;
    switch (cron) {
      case '* * * * *':
        ctx.waitUntil(runCore(env));
        break;
      case '*/5 * * * *':
        ctx.waitUntil(runAnalysis(env));
        break;
      case '0 15 * * *':
        ctx.waitUntil(runDailyAll(env));
        break;
      case '0 21 * * *':
        ctx.waitUntil(runDailyScoring(env));
        break;
      case '0 18 * * 6':
        ctx.waitUntil(runWeeklyScreening(env));
        break;
      default:
        ctx.waitUntil(runCore(env));
    }
  },
};

interface MarketData {
  news: ReturnType<typeof fetchNews> extends Promise<infer T> ? T extends { items: infer I } ? I : never : never;
  newsFetchStats: SourceFetchStat[];
  activeNewsSources: string;
  indicators: Awaited<ReturnType<typeof getMarketIndicators>>;
  prices: Map<string, number | null>;
}

/** 市場データ一括取得（RSS/Reddit/Yahoo Finance/Frankfurter + キャッシュフォールバック） */
async function fetchMarketData(env: Env, now: Date): Promise<MarketData | null> {
  const newsApiKeys: NewsApiKeys = {
    polygon:     env.POLYGON_API_KEY,
    finnhub:     env.FINNHUB_API_KEY,
    marketaux:   env.MARKETAUX_API_KEY,
    cryptopanic: env.CRYPTOPANIC_API_KEY,
  };

  const [newsResult, indicatorsResult, frankfurterResult] = await Promise.allSettled([
    fetchNews(newsApiKeys),
    getMarketIndicators(env.TWELVE_DATA_API_KEY, env.DB),
    getUSDJPY(),
  ]);

  if (newsResult.status === 'rejected') {
    await insertSystemLog(env.DB, 'WARN', 'NEWS', 'ニュース取得失敗', String(newsResult.reason).slice(0, 200));
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

  // Fix-B: ニュースフェッチ全ソース失敗検知
  const failedSources = newsFetchStats.filter(s => !s.ok);
  if (failedSources.length > 0 && newsData.items.length === 0) {
    const errorSummary = failedSources.map(s => `${s.source}:${s.error ?? 'unknown'}`).join(' | ').slice(0, 500);
    await insertSystemLog(env.DB, 'ERROR', 'NEWS',
      `ニュース全ソース失敗: ${failedSources.length}/${newsFetchStats.length}ソース — 記事0件`,
      errorSummary);
  } else if (failedSources.length >= newsFetchStats.length * 0.5 && newsFetchStats.length > 0) {
    await insertSystemLog(env.DB, 'WARN', 'NEWS',
      `ニュースソース半数以上失敗: ${failedSources.length}/${newsFetchStats.length}`,
      failedSources.map(s => s.source).join(','));
  }

  // news_raw ステージングテーブルに全記事を保存（Haikuフィルタ前）
  saveRawNews(newsData.items, env.DB).catch(e =>
    console.warn(`[fx-sim] saveRawNews error: ${String(e).slice(0, 100)}`)
  );

  // TTLパージ: 毎時0分台（分=0）のみ実行して負荷を分散
  if (now.getUTCMinutes() === 0) {
    purgeOldNewsRaw(env.DB).catch(e =>
      console.warn(`[fx-sim] purgeOldNewsRaw error: ${String(e).slice(0, 100)}`)
    );
  }

  // Gemini Flash でフィルタ + タイトル・概要の日本語化を一括処理（title_ja・desc_ja付与）
  const news = await filterAndTranslateNews(newsData.items, env.GEMINI_API_KEY, env.DB);
  const activeNewsSources = [...new Set(news.map(n => n.source))].join(',');
  const indicators = indicatorsResult.status === 'fulfilled' ? indicatorsResult.value : { vix: null, us10y: null, nikkei: null, sp500: null, usdjpy: null, btcusd: null, gold: null, eurusd: null, ethusd: null, crudeoil: null, natgas: null, copper: null, silver: null, gbpusd: null, audusd: null, solusd: null, dax: null, nasdaq: null, uk100: null, hk33: null, eurjpy: null, gbpjpy: null, audjpy: null, kawasaki_kisen: null, nippon_yusen: null, softbank_g: null, lasertec: null, tokyo_electron: null, disco: null, advantest: null, fast_retailing: null, nippon_steel: null, mufg: null, mitsui_osk: null, tokio_marine: null, mitsubishi_corp: null, toyota: null, sakura_internet: null, mhi: null, ihi: null, anycolor: null, cover_corp: null, nvda: null, tsla: null, aapl: null, amzn: null, amd: null, meta: null, msft: null, googl: null, fearGreed: null, fearGreedLabel: null, cftcJpyNetLong: null };
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
    // 円クロス
    ['EUR/JPY',   indicators.eurjpy],
    ['GBP/JPY',   indicators.gbpjpy],
    ['AUD/JPY',   indicators.audjpy],
    // 日本個別株
    ['川崎汽船',        indicators.kawasaki_kisen],
    ['日本郵船',        indicators.nippon_yusen],
    ['ソフトバンクG',    indicators.softbank_g],
    ['レーザーテック',    indicators.lasertec],
    ['東京エレクトロン',  indicators.tokyo_electron],
    ['ディスコ',        indicators.disco],
    ['アドバンテスト',    indicators.advantest],
    ['ファーストリテイリング', indicators.fast_retailing],
    ['日本製鉄',        indicators.nippon_steel],
    ['三菱UFJ',        indicators.mufg],
    ['商船三井',        indicators.mitsui_osk],
    ['東京海上HD',      indicators.tokio_marine],
    ['三菱商事',        indicators.mitsubishi_corp],
    ['トヨタ',          indicators.toyota],
    ['さくらインターネット', indicators.sakura_internet],
    ['三菱重工',        indicators.mhi],
    ['IHI',            indicators.ihi],
    ['ANYCOLOR',       indicators.anycolor],
    ['カバー',          indicators.cover_corp],
    // 米国個別株
    ['NVDA',      indicators.nvda],
    ['TSLA',      indicators.tsla],
    ['AAPL',      indicators.aapl],
    ['AMZN',      indicators.amzn],
    ['AMD',       indicators.amd],
    ['META',      indicators.meta],
    ['MSFT',      indicators.msft],
    ['GOOGL',     indicators.googl],
  ];

  const fallbackPairs: string[] = [];
  const prices = new Map<string, number | null>();
  // フォールバック候補を一括収集してバッチ取得（直列→1クエリに最適化）
  const needFallback: Array<[string, number]> = [];
  for (let idx = 0; idx < livePrices.length; idx++) {
    const [pair, liveRate] = livePrices[idx];
    if (liveRate != null) {
      prices.set(pair, liveRate);
    } else {
      needFallback.push([pair, idx]);
    }
  }
  if (needFallback.length > 0) {
    const keys = needFallback.map(([pair]) => `prev_rate_${pair}`);
    const placeholders = keys.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT key, value FROM market_cache WHERE key IN (${placeholders})`
    ).bind(...keys).all<{ key: string; value: string }>();
    const cacheMap = new Map((rows.results ?? []).map(r => [r.key, r.value]));
    for (const [pair] of needFallback) {
      const cached = cacheMap.get(`prev_rate_${pair}`);
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

  return { news, newsFetchStats, activeNewsSources, indicators, prices };
}

// ── v2: Path B 型定義 ──

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

// ── Path B: ニュースドリブン 2段階AI判定 ──

/**
 * Path B: ニュース駆動の売買シグナル生成
 *
 * B1（タイトル即断）→ og:description取得 → B2（補正）の2段階で売買シグナルを生成。
 * ニュースハッシュが変化したとき（新記事が届いたとき）に起動する。
 *
 * ⚠️ 週末制約（IPA §横断的関心事 / CLAUDE.md §週末市場クローズ制約）:
 *   取引対象銘柄は内部で getTradeableInstruments() を経由して決定する。
 *   週末クローズ中（marketClosed=true）は自動的に CRYPTO_PAIRS のみが対象になる。
 *   この関数を改修するときは getTradeableInstruments() の呼び出しを削除しないこと。
 */
async function runPathB(
  env: Env,
  sharedNewsStore: SharedNewsStore,
  indicators: Awaited<ReturnType<typeof getMarketIndicators>>,
  openPairs: Set<string>,
  apiKey: string,
  hedgeKeys?: { openaiApiKey?: string; anthropicApiKey?: string },
  regimeContext?: { text: string; prohibitions: string },
  prices?: Map<string, number | null>,
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

  // T09: 方向別平均RR集計（直近30件/銘柄）
  const biasRows = await env.DB
    .prepare(
      `SELECT pair, direction, AVG(realized_rr) AS avgRR
       FROM positions
       WHERE status = 'CLOSED' AND realized_rr IS NOT NULL
       GROUP BY pair, direction`
    )
    .all<{ pair: string; direction: string; avgRR: number }>();
  const biasMap = new Map<string, { buyAvgRR: number; sellAvgRR: number }>();
  for (const row of biasRows.results ?? []) {
    const existing = biasMap.get(row.pair) ?? { buyAvgRR: 0, sellAvgRR: 0 };
    if (row.direction === 'BUY') existing.buyAvgRR = row.avgRR;
    else if (row.direction === 'SELL') existing.sellAvgRR = row.avgRR;
    biasMap.set(row.pair, existing);
  }

  // 週末クローズ制約: getTradeableInstruments() 経由で対象銘柄を絞る（CLAUDE.md §週末市場クローズ制約）
  const weekendStatusForFilter = getWeekendStatus(new Date());
  const activeInstruments = getTradeableInstruments(INSTRUMENTS, weekendStatusForFilter);
  if (weekendStatusForFilter.marketClosed) {
    console.log(`[fx-sim] Path B: 暗号資産のみモード (${activeInstruments.length}銘柄)`);
  }

  const instrumentList = activeInstruments.map(i => ({
    pair: i.pair,
    hasOpenPosition: openPairs.has(i.pair),
    tpSlHint: i.tpSlHint,
    correlationGroup: i.correlationGroup,
    currentRate: prices?.get(i.pair) ?? undefined,
    directionBias: biasMap.get(i.pair) ?? undefined,
  }));

  // T10: 実績フィードバック — 直近30件の勝率・平均RR・連敗数・低パフォ銘柄
  let performanceSummary: { winRate: number; avgRR: number; recentStreak: number; worstPairs: string[] } | undefined;
  try {
    const recent30 = await env.DB
      .prepare(
        `SELECT pair, realized_rr FROM positions
         WHERE status = 'CLOSED' AND realized_rr IS NOT NULL
         ORDER BY id DESC LIMIT 30`
      )
      .all<{ pair: string; realized_rr: number }>();
    const rows = recent30.results ?? [];
    if (rows.length >= 10) {
      const wins = rows.filter(r => r.realized_rr >= 1.0).length;
      const winRate = wins / rows.length;
      const avgRR = rows.reduce((s, r) => s + r.realized_rr, 0) / rows.length;
      // 連敗数（最新から連続でRR<1.0の数、負の値）
      let streak = 0;
      for (const r of rows) {
        if (r.realized_rr < 1.0) streak--;
        else break;
      }
      // 低パフォーマンス銘柄（勝率30%未満 かつ 10件以上）
      const pairStats = new Map<string, { wins: number; total: number }>();
      for (const r of rows) {
        const s = pairStats.get(r.pair) ?? { wins: 0, total: 0 };
        s.total++;
        if (r.realized_rr >= 1.0) s.wins++;
        pairStats.set(r.pair, s);
      }
      const worstPairs = [...pairStats.entries()]
        .filter(([, s]) => s.total >= 5 && s.wins / s.total < 0.3)
        .map(([pair]) => pair);
      performanceSummary = { winRate, avgRR, recentStreak: streak, worstPairs };
    }
  } catch { /* 集計失敗は無視 */ }

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

  // 最適化: B1 API呼び出しと og:description 先行取得を並列実行
  // B1完了前でもニュースURLからog:descriptionを先行取得しておく（上位5件推定）
  const ogPreFetchPromise = Promise.allSettled(
    news.slice(0, 5).map(async (item, index) => {
      const og = await fetchOgDescription((item as any).link ?? '', (item as any).source ?? '');
      return { index, og };
    })
  );

  if (!b1CacheHit) {
    try {
      const tB1 = Date.now();
      const b1Result = await newsStage1WithHedge({
        news, indicators, instruments: instrumentList, apiKey,
        openaiApiKey: hedgeKeys?.openaiApiKey,
        anthropicApiKey: hedgeKeys?.anthropicApiKey,
        db: env.DB,
        // 施策6+20: テクニカル環境認識・禁止行動をAIプロンプトに注入
        regimeText: regimeContext?.text,
        regimeProhibitions: regimeContext?.prohibitions,
        // T10: 実績フィードバック
        performanceSummary,
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

  // B1成功後: filterAndTranslateWithHaikuで付与済みのtitle_jaを転写（APIコール不要）
  for (const item of stage1.news_analysis) {
    const src = news[item.index];
    item.title_ja = src?.title_ja ?? src?.title ?? '';
  }

  // og:description: 先行取得結果を回収し、attentionニュースに付与
  const ogPreResults = await ogPreFetchPromise;
  const ogMap = new Map<number, string>();
  for (const r of ogPreResults) {
    if (r.status === 'fulfilled' && r.value.og) {
      ogMap.set(r.value.index, r.value.og);
    }
  }
  // attention上位5件にog:descriptionを付与（先行取得でカバーできなかった分は追加取得）
  const attentionItems = stage1.news_analysis.filter((a: NewsAnalysisItem) => a.attention).slice(0, 5);
  const ogMissing = attentionItems.filter(a => !ogMap.has(a.index));
  if (ogMissing.length > 0) {
    const extraOg = await Promise.allSettled(
      ogMissing.map(async (a: NewsAnalysisItem) => {
        const item = news[a.index];
        if (!item) return { index: a.index, og: null };
        const og = await fetchOgDescription((item as any).link ?? '', (item as any).source ?? '');
        return { index: a.index, og };
      })
    );
    for (const r of extraOg) {
      if (r.status === 'fulfilled' && r.value.og) ogMap.set(r.value.index, r.value.og);
    }
  }
  for (const a of attentionItems) {
    const og = ogMap.get(a.index);
    if (og) a.og_description = og;
  }

  // 週末クローズガード: B1キャッシュヒット時でも取引可能銘柄のみにフィルタ
  // ⚠️ CLAUDE.md §週末市場クローズ制約: B1キャッシュは平日生成シグナルを含む可能性がある。
  //    再利用時に instrumentList（getTradeableInstruments()適用済み）で再フィルタして
  //    週末クローズ中に非クリプトペアがエントリーされるのを防ぐ。
  //    参考: 2026-03-29 Nikkei225 日曜エントリー（B1キャッシュ週末ガード欠落）の再発防止。
  const tradeablePairSet = new Set(instrumentList.map(i => i.pair));
  const filteredSignals = stage1.trade_signals.filter(s => tradeablePairSet.has(s.pair));
  if (b1CacheHit && filteredSignals.length < stage1.trade_signals.length) {
    const blocked = stage1.trade_signals.filter(s => !tradeablePairSet.has(s.pair)).map(s => s.pair);
    console.log(`[fx-sim] Path B: B1キャッシュ週末ガード — ${blocked.join(',')} をブロック`);
    await insertSystemLog(env.DB, 'INFO', 'PATH_B',
      `B1キャッシュ週末ガード: ${blocked.join(',')} をフィルタ（週末クローズ中）`,
    ).catch(() => {});
  }

  // 過剰検出ガード: 10件超は先頭5件のみ採用
  let signals = filteredSignals;
  if (signals.length > 10) {
    signals = signals.slice(0, 5);
    console.log(`[fx-sim] Path B: 過剰検出ガード (${filteredSignals.length}件→5件)`);
  }

  if (signals.length === 0) {
    // B3: market_cache保存（非同期、売買をブロックしない）
    void (async () => {
      try {
        await setCacheValue(env.DB, 'news_analysis_failed_at', '0');
      } catch {}
    })();

    // ── B1全スキップ「詰み」検出 ──
    // OPポジション多数 + シグナル0件 = [OP]スキップで全銘柄HOLDになった可能性
    // （PR#46で修正したREVERSAL不能状態の再発を検出するため）
    if (openPairs.size >= 8) {
      const attentionCount = stage1.news_analysis.filter((a: NewsAnalysisItem) => a.attention).length;
      await insertSystemLog(
        env.DB, 'WARN', 'PATH_B',
        `B1シグナル0件（詰み疑惑）: ${openPairs.size}銘柄OPENで[OP]全スキップの可能性`,
        JSON.stringify({ opCount: openPairs.size, attention: attentionCount })
      ).catch(() => {});
    }

    return { decisions: [], reversals: [], newsAnalysis: stage1.news_analysis };
  }

  // B2: og:desc付きで補正（タイムアウト8秒）+ サーキットブレーカー
  let b2Corrections: { pair: string; action: 'CONFIRM' | 'REVISE' | 'REVERSE'; new_tp_rate?: number; new_sl_rate?: number; reasoning: string }[] = [];

  // サーキットブレーカー: 連続5回失敗→30分クールダウン
  const B2_CB_THRESHOLD = 5;
  const B2_CB_COOLDOWN_MS = 30 * 60 * 1000; // 30分
  // 最適化: 2つのキャッシュ値を並列取得
  const [b2PrevFailsRaw, b2CbUntil] = await Promise.all([
    getCacheValue(env.DB, 'b2_consecutive_fails').catch(() => '0'),
    getCacheValue(env.DB, 'b2_circuit_breaker_until').catch(() => null),
  ]);
  const b2PrevFails = parseInt(b2PrevFailsRaw ?? '0');
  const b2CbActive = b2CbUntil ? new Date(b2CbUntil) > new Date() : false;

  if (b2CbActive) {
    // サーキットブレーカー発動中 → B2スキップ、B1シグナルをそのまま採用
    console.log(`[fx-sim] Path B B2: サーキットブレーカー発動中 (until ${b2CbUntil}) → B1採用`);
  } else {
    try {
      // T013: 適応的タイムアウトを取得（直近10回のP90+2s、5-15s範囲）
      const adaptiveTimeout = await getAdaptiveB2Timeout(env.DB);
      const tB2 = Date.now();

      let stage2result;
      try {
        stage2result = await newsStage2({ stage1Result: stage1, news, apiKey, db: env.DB, timeoutMs: adaptiveTimeout });
      } catch (firstErr) {
        // AbortError（タイムアウト）の場合のみ 1 回リトライ（1.5倍タイムアウト）
        const errName = (firstErr as Error)?.name;
        if (errName === 'AbortError') {
          console.warn(`[fx-sim] Path B B2: AbortError (${adaptiveTimeout}ms) → リトライ (${Math.round(adaptiveTimeout * 1.5)}ms)`);
          await new Promise(r => setTimeout(r, 500)); // 0.5s 待機
          stage2result = await newsStage2({ stage1Result: stage1, news, apiKey, db: env.DB, timeoutMs: Math.min(15_000, Math.round(adaptiveTimeout * 1.5)) });
        } else {
          throw firstErr;
        }
      }

      b2Ms = Date.now() - tB2;
      b2Corrections = stage2result.corrections;
      console.log(`[fx-sim] Path B B2: ${b2Corrections.filter(c => c.action === 'CONFIRM').length}件CONFIRM, ${b2Corrections.filter(c => c.action === 'REVISE').length}件REVISE, ${b2Corrections.filter(c => c.action === 'REVERSE').length}件REVERSE (${b2Ms}ms, timeout=${adaptiveTimeout}ms)`);
      // B2成功 → 連続失敗カウンター・サーキットブレーカーをリセット
      await setCacheValue(env.DB, 'b2_consecutive_fails', '0').catch(() => {});
      await setCacheValue(env.DB, 'b2_circuit_breaker_until', '').catch(() => {});
    } catch (e) {
      // B2タイムアウト/失敗 → B1シグナルをそのまま採用
      console.warn(`[fx-sim] Path B B2 failed/timeout → B1採用: ${String(e).split('\n')[0].slice(0, 80)}`);
      await insertSystemLog(env.DB, 'WARN', 'PATH_B', 'B2失敗→B1シグナルそのまま採用', String(e).split('\n')[0].slice(0, 120));

      // ── B2連続失敗カウンター + サーキットブレーカー ──
      const newFails = b2PrevFails + 1;
      await setCacheValue(env.DB, 'b2_consecutive_fails', String(newFails)).catch(() => {});

      // 5回連続失敗 → サーキットブレーカー発動（30分クールダウン）
      if (newFails >= B2_CB_THRESHOLD && !b2CbActive) {
        const cbUntil = new Date(Date.now() + B2_CB_COOLDOWN_MS).toISOString();
        await setCacheValue(env.DB, 'b2_circuit_breaker_until', cbUntil).catch(() => {});
        // CB発火時にカウンターをリセット → 解除後は5回失敗で再発動するサイクルに戻す
        await setCacheValue(env.DB, 'b2_consecutive_fails', '0').catch(() => {});
        await insertSystemLog(
          env.DB, 'ERROR', 'B2_OUTAGE',
          `B2 ${newFails}回連続失敗 → サーキットブレーカー発動 (until ${cbUntil})`,
          JSON.stringify({ consecutiveFails: newFails, cooldownMin: 30, lastError: String(e).split('\n')[0].slice(0, 100) })
        ).catch(() => {});
      } else if (newFails % 10 === 0) {
        await insertSystemLog(
          env.DB, 'ERROR', 'B2_OUTAGE',
          `B2 ${newFails}回連続失敗 — APIレート制限またはキー問題の可能性`,
          JSON.stringify({ consecutiveFails: newFails, lastError: String(e).split('\n')[0].slice(0, 100) })
        ).catch(() => {});
      }
    }
  }

  // B2補正適用
  const decisions: PathDecision[] = [];
  const reversals: string[] = [];

  for (const signal of signals) {
    const correction = b2Corrections.find(c => c.pair === signal.pair);
    const action = correction?.action ?? 'CONFIRM';

    if (action === 'REVERSE') {
      reversals.push(signal.pair);
      continue; // B2 REVERSE: 既存ポジションをクローズ、同サイクル再オープン禁止
    }

    // B1 REVERSAL: reasoningが"REVERSAL:"で始まる場合、既存ポジションをクローズ→新規エントリー
    // B2が429で失敗しているときでも逆行ニュースに反応できるフォールバック
    if (signal.reasoning?.startsWith('REVERSAL:')) {
      // reversalsリストに追加してクローズ後、同シグナルをdecisionsにも追加（再オープン）
      reversals.push(signal.pair);
      decisions.push({
        pair: signal.pair,
        decision: signal.decision,
        tp_rate: signal.tp_rate,
        sl_rate: signal.sl_rate,
        reasoning: signal.reasoning + ' [B1_REVERSAL]',
        rate: 0,
        source: 'PATH_B',
        news_analysis: stage1.news_analysis,
      });
      continue;
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

// ── runCore: 毎分実行（価格取得・TP/SL・Logic・週末処理）──
async function runCore(env: Env): Promise<void> {
  const now = new Date();
  const cronStart = Date.now();
  console.log(`[fx-sim] core start ${now.toISOString()}`);

  try {
    // スキーママイグレーション（バージョン管理方式）
    await runMigrations(env.DB);

    // 0. 週末ウィンドダウン判定
    const weekendStatus = getWeekendStatus(now);

    // Phase 4: 市場クローズ — 暗号資産（BTC/ETH/SOL）のみ継続、それ以外はスキップ
    const cryptoOnlyMode = weekendStatus.marketClosed;
    if (cryptoOnlyMode) {
      console.log(`[fx-sim] ${weekendStatus.label} — 暗号資産のみモード`);
    }

    // 1. 全価格・共通データを一括取得
    const t0 = Date.now();
    const marketData = await fetchMarketData(env, now);
    if (marketData == null) return;
    const fetchMs = Date.now() - t0;

    const { news, newsFetchStats: _newsFetchStats, activeNewsSources, indicators, prices } = marketData;
    await insertSystemLog(env.DB, 'INFO', 'FLOW', 'FETCH完了', JSON.stringify({
      ms: fetchMs, news: news.length,
      prices: [...prices.values()].filter(v => v != null).length,
      sources: activeNewsSources || 'none',
    }));

    // ── 施策B: プレマーケット分析（日曜20:00 UTC、Phase 4 中に1回のみ） ──
    if (weekendStatus.phase === 4 && now.getUTCDay() === 0
        && now.getUTCHours() === 20 && now.getUTCMinutes() <= 2) {
      const pmDone = await getCacheValue(env.DB, 'premarket_analysis_done');
      if (!pmDone) {
        try {
          const digestNews = await getWeekendNewsDigest(env.DB, 50);
          if (digestNews.length > 0) {
            const digestText = digestNews.slice(0, 30).map((n, i) =>
              `[W${i}] ${n.title_ja || n.title} (${n.source}) score=${n.composite_score?.toFixed(1) ?? 'N/A'}`
            ).join('\n');
            const instrumentList = INSTRUMENTS.map(i => i.pair).join(', ');
            const pmResult = await premarketAnalysis({
              weekendNews: digestText,
              instrumentList,
              apiKey: getApiKey(env),
              openaiApiKey: env.OPENAI_API_KEY,
              anthropicApiKey: env.ANTHROPIC_API_KEY,
              db: env.DB,
            });
            await setCacheValue(env.DB, 'premarket_analysis', JSON.stringify({
              generatedAt: now.toISOString(),
              provider: pmResult.provider,
              predictions: pmResult.predictions,
              market_summary: pmResult.market_summary,
              risk_events: pmResult.risk_events,
            }));
            await setCacheValue(env.DB, 'premarket_analysis_done', 'true');
            const highConf = pmResult.predictions.filter(p => p.confidence >= 70).length;
            await insertSystemLog(env.DB, 'INFO', 'PREMARKET',
              `プレマーケット分析完了 (${pmResult.provider}): ${highConf}件高確信`,
              pmResult.market_summary.slice(0, 200));
          }
        } catch (e) {
          await insertSystemLog(env.DB, 'WARN', 'PREMARKET',
            'プレマーケット分析失敗', String(e).slice(0, 200));
        }
      }
    }

    // ── 施策A: 週末ニュースダイジェスト + 施策C: ギャップ検知（Phase -2 初回） ──
    let weekendContext = '';
    if (weekendStatus.phase === -2) {
      // 施策A: ダイジェスト生成
      const digestDone = await getCacheValue(env.DB, 'weekend_digest_done');
      if (!digestDone) {
        const digestNews = await getWeekendNewsDigest(env.DB, 50);
        if (digestNews.length > 0) {
          const digestText = digestNews.slice(0, 30).map((n, i) =>
            `[W${i}] ${n.title_ja || n.title} (${n.source})`
          ).join('\n');
          await setCacheValue(env.DB, 'weekend_news_digest', JSON.stringify({
            generatedAt: now.toISOString(), count: digestNews.length, digest: digestText,
          }));
          await setCacheValue(env.DB, 'weekend_digest_done', 'true');
          await insertSystemLog(env.DB, 'INFO', 'WEEKEND',
            `週末ニュースダイジェスト: ${digestNews.length}件`, digestText.slice(0, 300));
        }
      }

      // 施策C: ギャップ検知
      const gapDone = await getCacheValue(env.DB, 'gap_detection_done');
      if (!gapDone) {
        const gaps = await detectGaps(env.DB, prices);
        if (gaps.length > 0) {
          await setCacheValue(env.DB, 'gap_signals', JSON.stringify({ detectedAt: now.toISOString(), gaps }));
          const summary = gaps.slice(0, 5)
            .map(g => `${g.pair} ${g.gapDirection} ${g.gapPercent.toFixed(2)}% (${g.magnitude})`)
            .join(', ');
          await insertSystemLog(env.DB, 'INFO', 'GAP',
            `ギャップ検知: ${gaps.length}件 (LARGE=${gaps.filter(g => g.magnitude === 'LARGE').length})`,
            summary);
        }
        await setCacheValue(env.DB, 'gap_detection_done', 'true');
      }
    }

    // Phase -2/-1: プレマーケット分析 + ギャップ情報を weekendContext に構築
    if (weekendStatus.phase >= -2 && weekendStatus.phase <= -1) {
      const parts: string[] = [];
      // プレマーケット分析
      const pmRaw = await getCacheValue(env.DB, 'premarket_analysis');
      if (pmRaw) {
        try {
          const pm = JSON.parse(pmRaw);
          const highConf = (pm.predictions ?? [])
            .filter((p: any) => p.confidence >= 70)
            .map((p: any) => `${p.pair}: ${p.bias} (確信度${p.confidence}%) ${p.reasoning}`)
            .join('\n');
          if (highConf) {
            parts.push(`【プレマーケット分析（日曜20:00生成）】\n${pm.market_summary}\n高確信シグナル:\n${highConf}`);
          }
        } catch { /* ignore */ }
      }
      // ギャップ情報
      const gapRaw = await getCacheValue(env.DB, 'gap_signals');
      if (gapRaw) {
        try {
          const { gaps } = JSON.parse(gapRaw);
          if (gaps && gaps.length > 0) {
            const gapText = gaps.slice(0, 10)
              .map((g: any) => `${g.pair}: ${g.gapDirection} ${g.gapPercent.toFixed(2)}% (${g.fridayClose}→${g.mondayOpen}) ${g.magnitude}`)
              .join('\n');
            parts.push(`【ギャップ検知（金曜終値 vs 月曜始値）】\n${gapText}\n※ ギャップフィルは発生確率60-70%だが、ファンダ要因の方向性ギャップは継続傾向`);
          }
        } catch { /* ignore */ }
      }
      // ダイジェスト
      const digestRaw = await getCacheValue(env.DB, 'weekend_news_digest');
      if (digestRaw) {
        try {
          const { digest } = JSON.parse(digestRaw);
          if (digest) parts.push(`【週末蓄積ニュース】\n${digest}`);
        } catch { /* ignore */ }
      }
      weekendContext = parts.join('\n\n');
    }

    // Phase 0 移行時にフラグリセット（月曜03:00 UTC）
    if (weekendStatus.phase === 0 && now.getUTCDay() === 1
        && now.getUTCHours() === 3 && now.getUTCMinutes() <= 1) {
      await resetWeekendFlags(env.DB);
    }

    // ブローカー環境（TP/SL・ポジション開設で使用）
    const brokerEnv: BrokerEnv = {
      OANDA_API_TOKEN: env.OANDA_API_TOKEN,
      OANDA_ACCOUNT_ID: env.OANDA_ACCOUNT_ID,
      OANDA_LIVE: env.OANDA_LIVE,
      TRADING_ENABLED: env.TRADING_ENABLED,
    };

    // ── 並列実行ブロック: Calendar + TP/SL + 孤立チェック ──
    // これらは相互依存がないため同時実行してwall-clock時間を短縮
    const t1 = Date.now();
    const [calendarResult, _tpSlResult, _orphanResult] = await Promise.allSettled([
      // テスタ施策12: 経済指標カレンダーチェック
      (async () => {
        const calendarEvents = await fetchEconomicCalendar(env.DB, env.FINNHUB_API_KEY);
        if (calendarEvents.length > 0) {
          return getUpcomingHighImpactEvents(calendarEvents, now);
        }
        return null;
      })(),
      // 2. 全銘柄のTP/SLを一括チェック
      checkAndCloseAllPositions(env.DB, prices, INSTRUMENTS, brokerEnv, getWebhookUrl(env)),
      // 1.9 除外銘柄の孤立ポジション自動キャンセル
      (async () => {
        const activePairs = new Set(INSTRUMENTS.map(i => i.pair));
        const openPositions = await getOpenPositions(env.DB);
        const orphaned = openPositions.filter(p => !activePairs.has(p.pair));
        for (const p of orphaned) {
          console.warn(`[fx-sim] ⚠️ 孤立ポジション検出: ${p.pair} id=${p.id} — 銘柄除外済みのため pnl=0 でキャンセル`);
          await closePosition(env.DB, p.id, p.entry_rate, 'DELISTED', 0, 0);
          await insertSystemLog(env.DB, 'WARN', 'POSITION',
            `孤立ポジションキャンセル: ${p.pair} id=${p.id} (銘柄除外済み)`,
            JSON.stringify({ pair: p.pair, direction: p.direction, entry_rate: p.entry_rate }));
        }
      })(),
    ]);
    const tpSlMs = Date.now() - t1;

    // Calendar 結果を適用
    let economicEventGuard = { highImpactNearby: false, mediumImpactNearby: false, events: [] as import('./calendar').EconomicEvent[] };
    if (calendarResult.status === 'fulfilled' && calendarResult.value) {
      economicEventGuard = calendarResult.value;
      if (economicEventGuard.highImpactNearby) {
        console.log(`[fx-sim] 📅 S級イベント接近 — 新規エントリー強制HOLD`);
        await insertSystemLog(env.DB, 'INFO', 'CALENDAR',
          'S級イベント接近: 新規エントリー停止',
          JSON.stringify(economicEventGuard.events.slice(0, 3).map(e => e.event)));
      }
    }
    await insertSystemLog(env.DB, 'INFO', 'FLOW', 'TPSL完了', JSON.stringify({ ms: tpSlMs }));

    // 2.5 週末ウィンドダウン処理
    // Phase 2/3 はクリプト以外（FX・株指数等）のみ対象
    const nonCryptoInstruments = INSTRUMENTS.filter(i => !['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(i.pair));
    if (weekendStatus.phase >= 2 && weekendStatus.phase < 4) {
      // 施策C: 金曜終値保存（Phase 2、金曜18:55 UTC 付近で1回のみ）
      if (weekendStatus.phase === 2 && now.getUTCDay() === 5
          && now.getUTCHours() === 18 && now.getUTCMinutes() >= 55) {
        const fridayDone = await getCacheValue(env.DB, 'friday_close_saved');
        if (!fridayDone) {
          const savedCount = await saveFridayClosePrices(env.DB, prices);
          await setCacheValue(env.DB, 'friday_close_saved', 'true');
          await insertSystemLog(env.DB, 'INFO', 'WEEKEND', `金曜終値保存: ${savedCount}銘柄`);
        }
      }
      // Phase 2: 含み益ポジションのSLを引き上げて利益ロック（クリプト以外）
      const lockedCount = await lockProfitsForWeekend(env.DB, prices, nonCryptoInstruments);
      if (lockedCount > 0) {
        console.log(`[fx-sim] 週末利益ロック: ${lockedCount}件のSLを引き上げ`);
        await insertSystemLog(env.DB, 'INFO', 'WEEKEND',
          `Phase ${weekendStatus.phase}: 利益ロック ${lockedCount}件`);
      }
    }
    if (weekendStatus.phase === 3) {
      // Phase 3 (金曜 19:00-21:00 UTC): クリプト以外を強制決済 → クリプトは継続
      const closedCount = await forceCloseAllForWeekend(env.DB, prices, nonCryptoInstruments);
      console.log(`[fx-sim] 週末強制決済（クリプト除く）: ${closedCount}件`);
      await insertSystemLog(env.DB, 'INFO', 'WEEKEND',
        `Phase 3 強制決済: ${closedCount}件`, weekendStatus.label);
      // Phase 3 では非クリプトの新規分析は不要 → cryptoOnlyMode で継続
    }

    // 2.7 ロジックトレーディング（AIを呼ばない定量エントリー）
    if (!cryptoOnlyMode && !economicEventGuard.highImpactNearby
        && weekendStatus.phase < 2 && weekendStatus.phase > -2) {
      try {
        const tLogic = Date.now();
        const logicResult = await runLogicDecisions(env.DB, prices, indicators, brokerEnv, now);
        if (logicResult.entered > 0) {
          await insertSystemLog(env.DB, 'INFO', 'FLOW',
            `LOGIC完了: ${logicResult.entered}件エントリー`,
            JSON.stringify({ ms: Date.now() - tLogic, entered: logicResult.entered }));
        }
      } catch (e) {
        console.warn(`[fx-sim] runLogicDecisions error: ${String(e).slice(0, 100)}`);
      }
    }

    // runCore 共通データをキャッシュ経由で runAnalysis に渡す
    // news / indicators / prices を market_cache に保存（runAnalysis が読み出す）
    const coreData = {
      news: news.map(n => ({ title: n.title, title_ja: n.title_ja, description: n.description, desc_ja: n.desc_ja, pubDate: n.pubDate, source: (n as any).source, link: (n as any).link, composite_score: (n as any).composite_score })),
      indicators,
      prices: [...prices.entries()],
      weekendContext,
      cryptoOnlyMode,
      activeNewsSources,
      fetchMs,
      tpSlMs,
    };
    await setCacheValue(env.DB, 'core_shared_data', JSON.stringify(coreData));

    // 毎cronパージ（system_logs ≤1000件維持）
    try {
      await env.DB.prepare(`DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT 1000)`).run();
      await env.DB.prepare(`DELETE FROM market_cache WHERE key LIKE 'news_filter_%' AND updated_at < datetime('now', '-2 hours')`).run();
      await env.DB.prepare(`DELETE FROM market_cache WHERE key LIKE 'news_haiku_%' AND updated_at < datetime('now', '-2 hours')`).run();
    } catch {}

    // 市場クローズ遷移検出 → dd_stopped:{assetClass} 自動解除
    // ⚠️ ユーザー指示による仕様（2026-04-01）: 翌営業日持ち越し禁止。バグではない。
    try {
      await checkMarketCloseAndReleaseDDStop(env.DB, now);
    } catch {}

    const coreMs = Date.now() - cronStart;
    console.log(`[fx-sim] core done in ${coreMs}ms (fetch=${fetchMs}ms tpsl=${tpSlMs}ms)`);

  } catch (e) {
    console.error('[fx-sim] core unhandled error:', e);
    await sendNotification(
      getWebhookUrl(env),
      `🔴 [fx-sim] core エラー: ${String(e).slice(0, 200)}`,
    );
    try {
      await insertSystemLog(env.DB, 'ERROR', 'CRON', 'core 予期しないエラー', String(e).slice(0, 300));
    } catch {}
  }
}

// ── runAnalysis: 5分ごと実行（Path B・Breakout・SPRT・ParamReview・AutoApproval）──
async function runAnalysis(env: Env): Promise<void> {
  const now = new Date();
  const cronStart = Date.now();
  console.log(`[fx-sim] analysis start ${now.toISOString()}`);

  try {
    // runCore が保存した共通データを読み出す
    const coreRaw = await getCacheValue(env.DB, 'core_shared_data');
    if (!coreRaw) {
      console.warn('[fx-sim] analysis: core_shared_data なし → スキップ');
      return;
    }
    const coreData = JSON.parse(coreRaw) as {
      news: any[];
      indicators: Awaited<ReturnType<typeof getMarketIndicators>>;
      prices: [string, number | null][];
      weekendContext: string;
      cryptoOnlyMode: boolean;
      activeNewsSources: string;
      fetchMs: number;
      tpSlMs: number;
    };
    const news = coreData.news;
    const indicators = coreData.indicators;
    const prices = new Map<string, number | null>(coreData.prices);
    const weekendContext = coreData.weekendContext;
    const fetchMs = coreData.fetchMs;
    const tpSlMs = coreData.tpSlMs;

    // 2.8 ニューストリガー（緊急→PATH_B強制）
    let lastTriggerId: number | undefined;
    try {
      const triggerResult = await runNewsTrigger(env.DB, getApiKey(env));
      lastTriggerId = triggerResult.triggerId;
      if (triggerResult.triggerType !== 'NONE') {
        console.log(`[fx-sim] NEWS_TRIGGER: ${triggerResult.triggerType} title=${triggerResult.newsTitle?.slice(0, 50)} triggerId=${lastTriggerId}`);
      }
    } catch (e) {
      console.warn(`[fx-sim] runNewsTrigger error: ${String(e).slice(0, 80)}`);
    }

    // 3. 共有ニュースストア構築 + Path B 実行（計測開始）
    // 最適化: prevNewsHash / lastPathBAt / openPairs / emergencyForce を並列取得
    const t2 = Date.now();
    const currentNewsHash = newsHash(news);
    const [prevNewsHashRaw, allOpenRawForPathB, lastPathBRaw, emergencyForce] = await Promise.all([
      getCacheValue(env.DB, PREV_NEWS_HASH_KEY),
      env.DB.prepare(`SELECT pair FROM positions WHERE status = 'OPEN'`).all<{ pair: string }>(),
      getCacheValue(env.DB, 'last_path_b_at'),
      consumeEmergencyForceFlag(env.DB),
    ]);
    const hasChanged = currentNewsHash !== (prevNewsHashRaw ?? '');
    await setCacheValue(env.DB, PREV_NEWS_HASH_KEY, currentNewsHash);

    const sharedNewsStore: SharedNewsStore = { items: news, hash: currentNewsHash, hasChanged };
    const openPairsForPathB = new Set((allOpenRawForPathB.results ?? []).map(p => p.pair));

    // news_summary: JSON形式で保存（titleのみ、切り詰めなし）
    const newsSummary = news.length > 0
      ? JSON.stringify(news.slice(0, 5).map((n) => ({
          title: n.title,
        })))
      : null;

    let pathBResult: PathBResult = { decisions: [], reversals: [], newsAnalysis: [] };
    let pathBMs = 0; // Path B 実行時間（AI呼び出し含む）

    // Path B 最小間隔チェック（5分）— 需要削減で429を構造的に防止
    // 緊急ニューストリガーがあれば間隔を無視して強制発火
    const PATH_B_MIN_INTERVAL_MS = 5 * 60 * 1000;
    const lastPathBAt = lastPathBRaw ? parseInt(lastPathBRaw) : 0;
    const pathBIntervalOk = emergencyForce || (Date.now() - lastPathBAt) >= PATH_B_MIN_INTERVAL_MS;

    if (emergencyForce) {
      await insertSystemLog(env.DB, 'INFO', 'PATH_B', 'PATH_B強制発火（緊急ニューストリガー）', '');
    }

    // Path B はニュースハッシュ変化かつ最小間隔OKの場合のみ実行
    const shouldRunPathB = sharedNewsStore.hasChanged && pathBIntervalOk;

    // 施策17: ブレイクアウト検知（ログ記録）
    // candles.tsのキャッシュにcandles[]が含まれている場合のみ動作
    // 最適化: 51銘柄の直列getCacheValueを1回のバッチクエリに統合
    {
      const breakoutTargets = INSTRUMENTS.filter(i =>
        !openPairsForPathB.has(i.pair) && prices.get(i.pair) != null
      );
      if (breakoutTargets.length > 0) {
        const candleKeys = breakoutTargets.map(i =>
          `candle_${(i as any).oandaSymbol ?? i.pair.replace('/', '_')}_H1`
        );
        const placeholders = candleKeys.map(() => '?').join(',');
        const rows = await env.DB.prepare(
          `SELECT key, value FROM market_cache WHERE key IN (${placeholders})`
        ).bind(...candleKeys).all<{ key: string; value: string }>();
        const candleCache = new Map((rows.results ?? []).map(r => [r.key, r.value]));

        for (let idx = 0; idx < breakoutTargets.length; idx++) {
          const instr = breakoutTargets[idx];
          const currentRate = prices.get(instr.pair)!;
          const cacheRaw = candleCache.get(candleKeys[idx]);
          if (!cacheRaw) continue;
          try {
            const cached = JSON.parse(cacheRaw) as { indicators?: Record<string, unknown>; candles?: unknown[] };
            if (!cached.candles || cached.candles.length < 20 || !cached.indicators) continue;
            const bk = detectBreakout(cached.candles as any, cached.indicators as any, currentRate);
            if (bk.detected && bk.genuine && bk.confidence >= 70) {
              console.log(`[fx-sim] BREAKOUT ${instr.pair} ${bk.type} conf=${bk.confidence}%`);
              void insertSystemLog(env.DB, 'INFO', 'BREAKOUT',
                `ブレイクアウト検知: ${instr.pair} ${bk.type} conf=${bk.confidence}%`,
                JSON.stringify({ rangeHigh: bk.rangeHigh, rangeLow: bk.rangeLow, rate: currentRate })
              ).catch(() => {});
            }
          } catch { /* キャッシュ破損無視 */ }
        }
      }
    }

    if (sharedNewsStore.hasChanged && !pathBIntervalOk) {
      const elapsedSec = Math.round((Date.now() - lastPathBAt) / 1000);
      console.log(`[fx-sim] Path B: 最小間隔未達（${elapsedSec}s < 300s）→スキップ`);
    }

    // ── Path B 後処理関数（REVERSE + ポジション開設 + decisions INSERT + キャッシュ更新）──
    // 直列/並列どちらでも同じ後処理を使う（DRY原則: ap.md §ソフトウェア設計）
    const applyPathBResults = async (result: PathBResult): Promise<Set<string>> => {
      const handledPairs = new Set([
        ...result.decisions.map(d => d.pair),
        ...result.reversals,
      ]);

      // REVERSE: 既存ポジションをクローズ
      if (result.reversals.length > 0) {
        for (const pair of result.reversals) {
          const rate = prices.get(pair);
          if (rate == null) continue;
          try {
            const openPos = await env.DB.prepare(
              `SELECT id, direction, entry_rate, sl_rate FROM positions WHERE pair = ? AND status = 'OPEN' LIMIT 1`
            ).bind(pair).first<{ id: number; direction: string; entry_rate: number; sl_rate: number | null }>();
            if (openPos) {
              const revInstr = INSTRUMENTS.find(i => i.pair === pair);
              const multiplier = revInstr?.pnlMultiplier ?? 100;
              const pnl = openPos.direction === 'BUY'
                ? (rate - openPos.entry_rate) * multiplier
                : (openPos.entry_rate - rate) * multiplier;
              const lr = logReturn(openPos.entry_rate, rate);
              const realizedRR = openPos.sl_rate != null
                ? calcRealizedRR(openPos.direction, openPos.entry_rate, rate, openPos.sl_rate)
                : undefined;
              await closePosition(env.DB, openPos.id, rate, 'B2_REVERSE', pnl, lr, realizedRR);
              await insertSystemLog(env.DB, 'INFO', 'PATH_B', `B2_REVERSE クローズ: ${pair} @ ${rate}`);
            }
          } catch (e) {
            console.warn(`[fx-sim] Path B REVERSE close failed (${pair}): ${String(e).slice(0, 80)}`);
          }
        }
      }

      // BUY/SELL: ポジション開設
      if (result.decisions.length > 0) {
        // DD STOPチェック（グローバル）: dd_stopped=true の場合は PATH_B 経由のエントリーも停止
        // （B2 CB 発動→B1フォールバックでも DD STOP をバイパスしないための保護）
        const ddCheckForPathB = await getDrawdownLevel(env.DB);
        if (ddCheckForPathB.level === 'STOP') {
          await insertSystemLog(env.DB, 'WARN', 'RISK',
            'DD STOP: PATH_Bエントリー全銘柄スキップ',
            `DD=${ddCheckForPathB.ddPct.toFixed(1)}% decisions=${result.decisions.length}件`);
          return handledPairs;
        }
        // 市場別 DD STOPチェック: 市場ごとのdd_stopped状態を一括取得
        const marketDDStopped = await getAllMarketDrawdownLevels(env.DB).catch(() => ({} as Record<string, boolean>));
        let pathBNewEntries = 0; // W005: このtickの新規開設数
        const PATH_B_OPEN_LIMIT = 10; // W005: 全体OPEN上限
        for (const dec of result.decisions) {
          if (dec.decision === 'HOLD') continue;
          const currentRate = prices.get(dec.pair);
          if (currentRate == null) continue;
          if (openPairsForPathB.has(dec.pair)) continue;
          // W005: OPEN上限ハードブロック（初期OPEN + このtick新規合計が上限以上なら停止）
          if (openPairsForPathB.size + pathBNewEntries >= PATH_B_OPEN_LIMIT) {
            await insertSystemLog(env.DB, 'WARN', 'RISK',
              `PATH_B OPEN上限ブロック: ${dec.pair}`,
              `OPEN=${openPairsForPathB.size + pathBNewEntries}/${PATH_B_OPEN_LIMIT}`
            ).catch(() => {});
            continue;
          }
          // 銘柄別日次損失上限チェック（テスタ流: シナリオ崩壊銘柄はやらない）
          const instDailyB = await checkInstrumentDailyLoss(env.DB, dec.pair, new Date());
          if (instDailyB.paused) {
            await insertSystemLog(env.DB, 'INFO', 'RISK',
              `PATH_B 銘柄日次Cap超過スキップ: ${dec.pair}`,
              `dailyPnl=${instDailyB.dailyPnl.toFixed(0)}円`);
            continue;
          }
          // 市場別 DD STOPチェック（銘柄の assetClass が STOP 中ならスキップ）
          {
            const instrument = INSTRUMENTS.find(i => i.pair === dec.pair);
            if (instrument && marketDDStopped[instrument.assetClass]) {
              await insertSystemLog(env.DB, 'INFO', 'RISK',
                `PATH_B 市場DD STOP スキップ: ${dec.pair} (${instrument.assetClass})`, '').catch(() => {});
              continue;
            }
          }
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
            const finalTp = sanity.correctedTp ?? dec.tp_rate;
            const finalSl = sanity.correctedSl ?? dec.sl_rate;
            if (sanity.correctedTp != null || sanity.correctedSl != null) {
              console.log(`[fx-sim] Path B TP/SL補正: ${dec.pair} TP ${dec.tp_rate}→${finalTp} SL ${dec.sl_rate}→${finalSl}`);
            }
            const pathBInstr = INSTRUMENTS.find(i => i.pair === dec.pair);
            await openPosition(env.DB, dec.pair, dec.decision as 'BUY' | 'SELL', currentRate, finalTp, finalSl, 'paper', null, getWebhookUrl(env),
              { pnlMultiplier: pathBInstr?.pnlMultiplier, trigger: 'NEWS' });
            pathBNewEntries++; // W005: 成功したらカウント増加
            await insertSystemLog(env.DB, 'INFO', 'PATH_B', `ポジション開設: ${dec.pair} ${dec.decision} @ ${currentRate}`, JSON.stringify({ tp: finalTp, sl: finalSl }));
          } catch (e) {
            console.warn(`[fx-sim] Path B openPosition failed (${dec.pair}): ${String(e).slice(0, 80)}`);
          }
        }
      }

      // decisions テーブルに記録
      if (result.decisions.length > 0) {
        const stmt = env.DB.prepare(
          `INSERT INTO decisions (pair, rate, decision, tp_rate, sl_rate, reasoning, news_summary, vix, us10y, nikkei, sp500, created_at, trigger_id, why_chain)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        await env.DB.batch(result.decisions.map(d => {
          const relevantNews = (d.news_analysis ?? result.newsAnalysis)
            .filter(a => a.attention && a.affected_pairs.includes(d.pair))
            .slice(0, 5)
            .map(a => ({ title: a.title_ja || news[a.index]?.title_ja || (news[a.index]?.title ?? ''), title_ja: a.title_ja, impact: a.impact }));
          const summaryItems = relevantNews.length > 0
            ? relevantNews
            : (d.news_analysis ?? result.newsAnalysis)
                .filter(a => a.attention).slice(0, 3)
                .map(a => ({ title: a.title_ja || news[a.index]?.title_ja || (news[a.index]?.title ?? ''), title_ja: a.title_ja, impact: a.impact }));
          const pathBNewsSummary = summaryItems.length > 0 ? JSON.stringify(summaryItems) : newsSummary;
          return stmt.bind(
            d.pair, prices.get(d.pair) ?? d.rate, d.decision, d.tp_rate, d.sl_rate,
            `[PATH_B] ${d.reasoning}`, pathBNewsSummary,
            indicators.vix, indicators.us10y, indicators.nikkei, indicators.sp500,
            now.toISOString(),
            lastTriggerId ?? null,
            null  // why_chain（将来的にAI生成）
          );
        }));
      }

      // news_analysis + latest_news キャッシュ更新
      if (result.newsAnalysis.length > 0) {
        const enriched = result.newsAnalysis.map(a => {
          // 同バッチのtrade_decisionsから該当ペアの判断を紐付け
          const pairedDecisions = (result.decisions ?? [])
            .filter(d => (a.affected_pairs ?? []).includes(d.pair))
            .map(d => ({ pair: d.pair, decision: d.decision, reasoning: d.reasoning?.replace(/^\[PATH_B\] /, '').slice(0, 60) ?? null }));
          // hold_reason: 注目ニュースで行動しなかった理由（機会損失の可視化）
          let hold_reason: string | null = null;
          if (a.attention && pairedDecisions.length === 0) {
            const hasOpenPos = (a.affected_pairs ?? []).some((p: string) => openPairsForPathB.has(p));
            hold_reason = hasOpenPos ? '既存ポジションあり' : 'AI判断: 様子見';
          }
          return {
            ...a,
            title: news[a.index]?.title_ja || (news[a.index]?.title ?? null),
            pubDate: news[a.index]?.pubDate ?? null,
            description: news[a.index]?.desc_ja || (news[a.index]?.description ?? null),
            source: (news[a.index] as any)?.source ?? null,
            trade_decisions: pairedDecisions.length > 0 ? pairedDecisions : null,
            hold_reason,
          };
        });

        // ── 過去24時間ローリングウィンドウ蓄積（上書きではなくマージ）──
        const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
        const existingAnalysisRaw = await getCacheValue(env.DB, 'news_analysis');
        const existingAnalysis: any[] = existingAnalysisRaw
          ? (() => { try { return JSON.parse(existingAnalysisRaw); } catch { return []; } })()
          : [];
        const existingIn24h = existingAnalysis.filter((e: any) => {
          const d = e.pubDate || e.analyzed_at || '';
          return d ? new Date(d).getTime() >= cutoff24h : false;
        });
        const newTitles = new Set(enriched.map((e: any) => e.title));
        const preserved = existingIn24h.filter((e: any) => !newTitles.has(e.title));
        const mergedAnalysis = [...enriched, ...preserved].slice(0, 80);
        await setCacheValue(env.DB, 'news_analysis', JSON.stringify(mergedAnalysis));

        // latest_news も過去24時間蓄積
        const existingLatestRaw = await getCacheValue(env.DB, 'latest_news');
        const existingLatest: any[] = existingLatestRaw
          ? (() => { try { return JSON.parse(existingLatestRaw); } catch { return []; } })()
          : [];
        const newLatestTitles = new Set(news.slice(0, 30).map((n: any) => n.title));
        const preservedLatest = existingLatest.filter((n: any) => {
          const d = n.pubDate || '';
          return d ? new Date(d).getTime() >= cutoff24h && !newLatestTitles.has(n.title) : false;
        });
        const mergedLatest = [
          ...news.slice(0, 30).map(n => ({ ...n, title_ja: n.title_ja || null })),
          ...preservedLatest,
        ].slice(0, 100);
        await setCacheValue(env.DB, 'latest_news', JSON.stringify(mergedLatest));
      }

      // 機会損失トラッキング: attention=true だがシグナルなしのペアを HOLD 記録
      const attentionPairs = new Set<string>();
      for (const a of result.newsAnalysis) {
        if (a.attention) {
          for (const p of (a.affected_pairs ?? [])) attentionPairs.add(p);
        }
      }
      const holdPairs = [...attentionPairs].filter(p => !handledPairs.has(p));
      if (holdPairs.length > 0) {
        try {
          const holdStmt = env.DB.prepare(
            `INSERT INTO decisions (pair, rate, decision, tp_rate, sl_rate, reasoning, news_summary, vix, us10y, nikkei, sp500, created_at, trigger_id, why_chain)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          );
          await env.DB.batch(holdPairs.map(pair => {
            const reason = openPairsForPathB.has(pair)
              ? '既存ポジションあり（機会損失候補）'
              : 'ニュース注目・シグナルなし（機会損失候補）';
            return holdStmt.bind(
              pair, prices.get(pair) ?? 0, 'HOLD', null, null,
              `[PATH_B_HOLD] ${reason}`, newsSummary,
              indicators.vix, indicators.us10y, indicators.nikkei, indicators.sp500,
              now.toISOString(),
              lastTriggerId ?? null,
              null  // why_chain
            );
          }));
        } catch (e) {
          console.warn(`[fx-sim] Path B HOLD記録失敗: ${String(e).slice(0, 80)}`);
        }
      }

      return handledPairs;
    };

    // ── Path B（ニュースドリブン AI）のみ実行 ─────────────────────────────
    // Path A（AI常時監視）は Ph.6 にて廃止。ロジック判断はRunLogicDecisionsで実施済み。
    let newsMs: number;

    if (shouldRunPathB) {
      // ═══════════════════════════════════════════════════════════════
      // Path B: ニュースハッシュ変化時のみ実行（緊急/トレンドニュース専用AI）
      // ═══════════════════════════════════════════════════════════════
      try {
        // 施策6+20: USD/JPYのH1キャッシュからレジーム計算（失敗時は無視）
        let regimeContext: { text: string; prohibitions: string } | undefined;
        try {
          const cacheRaw = await getCacheValue(env.DB, 'candle_USD_JPY_H1');
          if (cacheRaw) {
            const cached = JSON.parse(cacheRaw) as { indicators?: Record<string, unknown> };
            if (cached.indicators) {
              const regimeResult = determineRegime(cached.indicators as any);
              regimeContext = {
                text: formatRegimeForPrompt(regimeResult, cached.indicators as any),
                prohibitions: getRegimeProhibitions(regimeResult.regime),
              };
            }
          }
        } catch { /* regime計算失敗は従来動作を維持 */ }

        // 施策A/B/C: Phase -2/-1 のとき weekendContext を regimeText に追記
        if (weekendContext && regimeContext) {
          regimeContext = {
            text: regimeContext.text + '\n\n' + weekendContext,
            prohibitions: regimeContext.prohibitions,
          };
        } else if (weekendContext && !regimeContext) {
          regimeContext = { text: weekendContext, prohibitions: '' };
        }

        const tPathB = Date.now();
        pathBResult = await runPathB(env, sharedNewsStore, indicators, openPairsForPathB, getApiKey(env), {
          openaiApiKey: env.OPENAI_API_KEY,
          anthropicApiKey: env.ANTHROPIC_API_KEY,
        }, regimeContext, prices);
        pathBMs = Date.now() - tPathB;
        await setCacheValue(env.DB, 'last_path_b_at', String(Date.now()));
        console.log(`[fx-sim] Path B: ${pathBResult.decisions.length}件シグナル, ${pathBResult.reversals.length}件REVERSE (${pathBMs}ms)`);
      } catch (e) {
        if (e instanceof RateLimitError) {
          markKeyCooldown(e.apiKey, e.retryAfterSec);
        }
        cbRecordFailure();
        console.warn(`[fx-sim] Path B failed: ${String(e).split('\n')[0].slice(0, 80)}`);
        await insertSystemLog(env.DB, 'WARN', 'PATH_B', 'Path B実行失敗', String(e).split('\n')[0].slice(0, 120));
      }
    }

    await insertSystemLog(env.DB, 'INFO', 'FLOW', 'PATH_B完了', JSON.stringify({
      ms: Date.now() - t2, hasChanged: sharedNewsStore.hasChanged,
      signals: pathBResult.decisions.length, reversals: pathBResult.reversals.length,
    }));

    // Path B 後処理（ポジション開設・decisions記録）
    await applyPathBResults(pathBResult);

    newsMs = Date.now() - t2;

    const totalMs = Date.now() - cronStart;
    console.log(`[fx-sim] analysis timings: news=${newsMs}ms pathB=${pathBMs}ms total=${totalMs}ms`);

    // T014: SPRT 評価（DB専用で軽量 ~5ms）
    try {
      await evaluateRecoveryIfNeeded(env.DB);
    } catch (e) {
      console.warn(`[fx-sim] evaluateRecoveryIfNeeded error: ${String(e).slice(0, 80)}`);
    }

    // パラメーターレビュー（1銘柄のみ、時間予算内で実行）
    let paramReviewMs = 0;
    if (totalMs <= 25000) {
      try {
        const tParam = Date.now();
        const tierDPairs = INSTRUMENTS.filter(i => i.tier === 'D').map(i => i.pair);
        const reviewResult = await runParamReview(env.DB, getApiKey(env), env.OPENAI_API_KEY, tierDPairs);
        paramReviewMs = Date.now() - tParam;
        if (reviewResult.reviewed) {
          console.log(`[fx-sim] PARAM_REVIEW: ${reviewResult.pair} updated — ${reviewResult.summary}`);
        }
      } catch (e) {
        console.warn(`[fx-sim] runParamReview error: ${String(e).slice(0, 100)}`);
      }
    }

    // AutoApproval（毎時0分台のみ）
    if (now.getUTCMinutes() < 5) {
      try {
        await autoApprove(env.DB);
      } catch (e) {
        console.warn(`[fx-sim] autoApprove error: ${String(e).slice(0, 80)}`);
      }
    }

    // 実行時間計測
    const grandTotal = totalMs + paramReviewMs;
    const timingsWithParam = { fetchMs, tpSlMs, newsMs, pathBMs, paramReviewMs, grandTotalMs: grandTotal };
    await setCacheValue(env.DB, 'cron_phase_timings', JSON.stringify(timingsWithParam));
    if (grandTotal > 60000) {
      await insertSystemLog(env.DB, 'WARN', 'CRON',
        `analysis実行時間超過: ${grandTotal}ms`,
        JSON.stringify(timingsWithParam));
    }

    console.log(`[fx-sim] analysis done in ${grandTotal}ms`);

  } catch (e) {
    console.error('[fx-sim] analysis unhandled error:', e);
    await sendNotification(
      getWebhookUrl(env),
      `🔴 [fx-sim] analysis エラー: ${String(e).slice(0, 200)}`,
    );
    try {
      await insertSystemLog(env.DB, 'ERROR', 'CRON', 'analysis 予期しないエラー', String(e).slice(0, 300));
    } catch {}
  }
}

// ── 日次タスク（ログパージ・サマリー・銘柄スコア更新）──
async function runDailyTasks(env: Env, _now: Date): Promise<void> {
  // ログパージ
  try {
    await env.DB.prepare(`DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT 1000)`).run();
    await env.DB.prepare(`DELETE FROM news_fetch_log WHERE id NOT IN (SELECT id FROM news_fetch_log ORDER BY id DESC LIMIT 5000)`).run();
    // news_filter_* / news_haiku_* キャッシュパージ（2時間以上前のものを削除 → 10分毎パージと整合）
    await env.DB.prepare(`DELETE FROM market_cache WHERE key LIKE 'news_filter_%' AND updated_at < datetime('now', '-2 hours')`).run();
    await env.DB.prepare(`DELETE FROM market_cache WHERE key LIKE 'news_haiku_%' AND updated_at < datetime('now', '-2 hours')`).run();
    // b2_consecutive_fails リセット（CB解除済み且つ古い場合）
    await env.DB.prepare(
      `DELETE FROM market_cache WHERE key = 'b2_consecutive_fails' AND NOT EXISTS (
        SELECT 1 FROM market_cache WHERE key = 'b2_circuit_breaker_until'
          AND CAST(value AS INTEGER) > CAST(strftime('%s','now')*1000 AS INTEGER)
      )`
    ).run();
    // news_temp_params の期限切れレコードをパージ（無限蓄積防止）
    await env.DB.prepare(`DELETE FROM news_temp_params WHERE expires_at < datetime('now')`).run();
  } catch {}

  // 日次サマリー記録
  try {
    const dailyPerf = await env.DB.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END), 0) AS wins,
       COALESCE(SUM(pnl), 0) AS totalPnl FROM positions WHERE status = 'CLOSED'`
    ).first<{ total: number; wins: number; totalPnl: number }>();
    const openCount = (await env.DB.prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'OPEN'`).first<{ c: number }>())?.c ?? 0;
    const balance = INITIAL_CAPITAL + (dailyPerf?.totalPnl ?? 0);
    const wr = dailyPerf && dailyPerf.total > 0 ? (dailyPerf.wins / dailyPerf.total * 100).toFixed(1) : '0';
    await insertSystemLog(env.DB, 'INFO', 'DAILY',
      `日次サマリー: ¥${Math.round(balance).toLocaleString()} ROI ${((balance - INITIAL_CAPITAL) / 100).toFixed(1)}% 勝率(RR≥1.0)${wr}% ${dailyPerf?.total ?? 0}件 OP${openCount}`);
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
        SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END) as wins,
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
       COALESCE(SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END), 0) AS wins,
       COALESCE(SUM(CASE WHEN realized_rr >= 1.0 THEN pnl ELSE 0 END), 0) AS total_win_pnl,  -- RR≥1.0取引のPnL合計
       COALESCE(SUM(CASE WHEN realized_rr IS NULL OR realized_rr < 1.0 THEN ABS(pnl) ELSE 0 END), 0) AS total_loss_pnl,  -- RR<1.0取引の|PnL|合計
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

    // RR中心スコア: avg_rr 40% + RR勝率 25% + Sharpe 20% + RRトレンド 15%
    const tradeScore = Math.min(r.total_trades / 20, 1); // 20件で満点
    const avgRrNorm = Math.min(avgRR / 3, 1); // RR=3.0で満点（RR最大化ベクトル）
    const rrTrendScore = tradeScore; // 暫定: 取引数スコアをトレンド代用
    const score = avgRrNorm * 0.40 + winRate * 0.25 + Math.min(Math.max(sharpe, 0) / 1, 1) * 0.20 + rrTrendScore * 0.15;

    batch.push(stmt.bind(r.pair, r.total_trades, winRate, avgRR, sharpe, 0, score, now));
  }

  if (batch.length > 0) {
    await db.batch(batch);
    console.log(`[fx-sim] instrument_scores updated: ${batch.length} pairs`);
  }

  // 期間別RR集計
  try {
    const now = new Date();
    const todayStart = now.toISOString().slice(0, 10) + 'T00:00:00Z';
    const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
    const monthAgo = new Date(now.getTime() - 30 * 86400000).toISOString();

    // 銘柄別期間RR更新
    for (const r of rows.results) {
      // 直近30取引
      const last30 = await db.prepare(
        `SELECT AVG(realized_rr) as avg_rr,
                SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as wr
         FROM (SELECT realized_rr FROM positions WHERE pair = ? AND status = 'CLOSED' AND realized_rr IS NOT NULL ORDER BY id DESC LIMIT 30)`
      ).bind(r.pair).first<{ avg_rr: number | null; wr: number | null }>();

      // デイリー
      const daily = await db.prepare(
        `SELECT AVG(realized_rr) as avg_rr FROM positions WHERE pair = ? AND status = 'CLOSED' AND realized_rr IS NOT NULL AND closed_at >= ?`
      ).bind(r.pair, todayStart).first<{ avg_rr: number | null }>();

      // ウィークリー
      const weekly = await db.prepare(
        `SELECT AVG(realized_rr) as avg_rr FROM positions WHERE pair = ? AND status = 'CLOSED' AND realized_rr IS NOT NULL AND closed_at >= ?`
      ).bind(r.pair, weekAgo).first<{ avg_rr: number | null }>();

      // マンスリー
      const monthly = await db.prepare(
        `SELECT AVG(realized_rr) as avg_rr FROM positions WHERE pair = ? AND status = 'CLOSED' AND realized_rr IS NOT NULL AND closed_at >= ?`
      ).bind(r.pair, monthAgo).first<{ avg_rr: number | null }>();

      // RRトレンド判定（直近30取引 vs 全体）
      const allAvgRR = pnlByPair[r.pair] ? (pnlByPair[r.pair].reduce((s, v) => s + v, 0) / pnlByPair[r.pair].length) : 0;
      const recentRR = last30?.avg_rr ?? 0;
      const trend = recentRR > allAvgRR * 1.1 ? 'IMPROVING' : recentRR < allAvgRR * 0.9 ? 'DECLINING' : 'STABLE';

      await db.prepare(
        `UPDATE instrument_scores SET rr_30t = ?, wr_30t = ?, rr_daily = ?, rr_weekly = ?, rr_monthly = ?, rr_trend = ? WHERE pair = ?`
      ).bind(
        last30?.avg_rr ?? null, last30?.wr ?? null,
        daily?.avg_rr ?? null, weekly?.avg_rr ?? null, monthly?.avg_rr ?? null,
        trend, r.pair
      ).run();
    }

    // 総合集計を market_cache に保存
    const dailyTotal = await db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END) as wins, AVG(realized_rr) as avg_rr
       FROM positions WHERE status = 'CLOSED' AND realized_rr IS NOT NULL AND closed_at >= ?`
    ).bind(todayStart).first<{ total: number; wins: number; avg_rr: number | null }>();
    const weeklyTotal = await db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END) as wins, AVG(realized_rr) as avg_rr
       FROM positions WHERE status = 'CLOSED' AND realized_rr IS NOT NULL AND closed_at >= ?`
    ).bind(weekAgo).first<{ total: number; wins: number; avg_rr: number | null }>();
    const monthlyTotal = await db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END) as wins, AVG(realized_rr) as avg_rr
       FROM positions WHERE status = 'CLOSED' AND realized_rr IS NOT NULL AND closed_at >= ?`
    ).bind(monthAgo).first<{ total: number; wins: number; avg_rr: number | null }>();

    const rrSummary = {
      daily: { total: dailyTotal?.total ?? 0, wins: dailyTotal?.wins ?? 0, avg_rr: dailyTotal?.avg_rr ?? 0, win_rate: dailyTotal && dailyTotal.total > 0 ? (dailyTotal.wins / dailyTotal.total) : 0 },
      weekly: { total: weeklyTotal?.total ?? 0, wins: weeklyTotal?.wins ?? 0, avg_rr: weeklyTotal?.avg_rr ?? 0, win_rate: weeklyTotal && weeklyTotal.total > 0 ? (weeklyTotal.wins / weeklyTotal.total) : 0 },
      monthly: { total: monthlyTotal?.total ?? 0, wins: monthlyTotal?.wins ?? 0, avg_rr: monthlyTotal?.avg_rr ?? 0, win_rate: monthlyTotal && monthlyTotal.total > 0 ? (monthlyTotal.wins / monthlyTotal.total) : 0 },
    };
    await db.prepare(
      `INSERT INTO market_cache (key, value, updated_at) VALUES ('rr_summary', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(JSON.stringify(rrSummary), now.toISOString()).run();

    console.log(`[fx-sim] rr_summary updated: D=${rrSummary.daily.avg_rr?.toFixed(2)} W=${rrSummary.weekly.avg_rr?.toFixed(2)} M=${rrSummary.monthly.avg_rr?.toFixed(2)}`);
  } catch (e) {
    console.warn('[fx-sim] period RR update failed:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI銘柄マネージャー cronハンドラ
// ─────────────────────────────────────────────────────────────────────────────

/** 日次スコアリング: JST 06:00 (UTC 21:00) */
async function runDailyScoring(env: Env): Promise<void> {
  if (!env.JQUANTS_REFRESH_TOKEN) {
    console.warn('[daily-scoring] JQUANTS_REFRESH_TOKEN not set, skipping');
    await insertSystemLog(env.DB, 'WARN', 'SCORING',
      'daily-scoring スキップ: JQUANTS_REFRESH_TOKEN 未設定', '');
    return;
  }

  console.log('[daily-scoring] Start');
  const today = new Date().toISOString().split('T')[0];

  // 追跡リストの銘柄を取得
  const trackingInsts = await getTrackingList(env.DB);
  const trackingSymbols = trackingInsts
    .filter(i => i.stockSymbol?.endsWith('.T'))
    .map(i => i.stockSymbol!);

  // 財務データを取得・保存
  const fundaData = await fetchFundamentals(env.DB, env.JQUANTS_REFRESH_TOKEN, trackingSymbols);
  await saveFundamentals(env.DB, fundaData);

  // スコアリング入力データを構築
  const scores = [];
  for (const inst of trackingInsts.filter(i => i.stockSymbol?.endsWith('.T'))) {
    const symbol = inst.stockSymbol!;
    const newsCount3d = await countNewsForSymbol(env.DB, inst.pair, 3);
    const newsCount14d = await countNewsForSymbol(env.DB, inst.pair, 14);
    const funda = fundaData.find(f => f.symbol === symbol);
    const sectorAvgPer = await getSectorAvgPer(env.DB, funda?.sector ?? null);

    // Yahoo Finance から出来高・値幅・52週レンジを取得
    let vol5dAvg: number | null = null, vol20dAvg: number | null = null;
    let vol1d: number | null = null, volYesterday: number | null = null;
    let highLow1d: number | null = null, highLow20dAvg: number | null = null;
    let week52High: number | null = null, week52Low: number | null = null;
    let currentPrice: number | null = null;

    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (res.ok) {
        const data = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number }; indicators?: { quote?: Array<{ close?: number[]; volume?: number[]; high?: number[]; low?: number[] }> } }> } };
        const result = data?.chart?.result?.[0];
        const volumes: number[] = result?.indicators?.quote?.[0]?.volume ?? [];
        const highs: number[] = result?.indicators?.quote?.[0]?.high ?? [];
        const lows: number[] = result?.indicators?.quote?.[0]?.low ?? [];

        if (volumes.length >= 20) {
          const recentVols = volumes.filter(v => v > 0).slice(-20);
          vol20dAvg = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
          const last5 = recentVols.slice(-5);
          vol5dAvg = last5.reduce((a, b) => a + b, 0) / last5.length;
          vol1d = volumes[volumes.length - 1] ?? null;
          volYesterday = volumes[volumes.length - 2] ?? null;
        }

        if (highs.length >= 20 && lows.length >= 20) {
          const ranges = highs.map((h, i) => (h ?? 0) - (lows[i] ?? 0)).filter(r => r > 0);
          if (ranges.length > 0) {
            highLow1d = ranges[ranges.length - 1];
            highLow20dAvg = ranges.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, ranges.length);
          }
        }

        currentPrice = result?.meta?.regularMarketPrice ?? null;

        // 52週レンジ
        try {
          const res52 = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`,
            { signal: AbortSignal.timeout(6000) }
          );
          if (res52.ok) {
            const data52 = await res52.json() as { chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: number[] }> } }> } };
            const result52 = data52?.chart?.result?.[0];
            const closes52: number[] = result52?.indicators?.quote?.[0]?.close ?? [];
            const validCloses = closes52.filter((c): c is number => c !== null && c > 0);
            if (validCloses.length > 0) {
              week52High = Math.max(...validCloses);
              week52Low = Math.min(...validCloses);
            }
          }
        } catch {}
      }
    } catch (e) {
      console.warn(`[daily-scoring] Yahoo Finance error for ${symbol}:`, e);
    }

    // RSI/ADX取得（market_cacheから）
    let rsi: number | null = null;
    let adx: number | null = null;
    try {
      const cached = await env.DB.prepare(
        "SELECT value FROM market_cache WHERE key = ?"
      ).bind(`indicators_${symbol}_D`).first<{ value: string }>();
      if (cached) {
        const ind = JSON.parse(cached.value);
        rsi = ind.rsi14 ?? null;
        adx = ind.adx14 ?? null;
      }
    } catch {}

    const THEME_GROUPS = ['jp_ai_dc', 'jp_defense', 'jp_entertainment'];
    const isThemeStock = THEME_GROUPS.includes(inst.correlationGroup ?? '');

    const input: StockScoreInput = {
      symbol,
      stockSymbol: symbol,
      displayName: inst.pair,
      vol5dAvg, vol20dAvg, vol1d, volYesterday,
      highLow1d, highLow20dAvg,
      rsi, adx,
      week52High, week52Low, currentPrice,
      newsCount3d, newsCount14d,
      equityRatio: funda?.equityRatio ?? null,
      netProfit: funda?.netProfit ?? null,
      prevNetProfit: null,
      forecastOpChange: funda?.forecastOp && funda?.opProfit
        ? ((funda.forecastOp - funda.opProfit) / Math.abs(funda.opProfit)) * 100 : null,
      per: currentPrice && funda?.eps ? currentPrice / funda.eps : null,
      sectorAvgPer,
      dividendYield: currentPrice && funda?.dividend ? (funda.dividend / currentPrice) * 100 : null,
      marketCap: funda?.marketCap ?? null,
      nextEarningsDate: funda?.nextEarnings ?? null,
      isThemeStock,
    };

    const score = calcStockScore(input);
    scores.push(score);
  }

  await saveScores(env.DB, scores, today);

  // 入替え判定
  const promotable = await detectPromotionCandidates(env.DB, trackingSymbols);
  const trackingWithDates = await env.DB.prepare(
    "SELECT pair, added_at FROM active_instruments"
  ).all<{ pair: string; added_at: string }>();

  const demotable = await detectDemotionCandidates(
    env.DB,
    (trackingWithDates.results ?? []).map(r => ({
      symbol: r.pair,
      addedAt: r.added_at,
    }))
  );

  if (promotable.length > 0 && demotable.length > 0) {
    const candidates = await getCandidateList(env.DB);
    const bestPromotion = promotable[0];
    const worstDemotion = demotable[0];

    const promScore = candidates.find(c => c.symbol === bestPromotion)?.totalScore ?? 0;
    const demScore = scores.find(s => s.symbol === worstDemotion)?.totalScore ?? 0;

    await proposeRotation(env.DB, bestPromotion, promScore, worstDemotion, demScore);
  }

  await cleanupOldFundamentals(env.DB);
  console.log(`[daily-scoring] Done. Scored ${scores.length} stocks`);
}

/** 週次スクリーニング①: 全上場銘柄の財務サマリ取得（日曜03:00 JST） */
/** 週次スクリーニング統合: Batch → Finalize を1回のcronで実行（土曜 UTC18:00） */
async function runWeeklyScreening(env: Env): Promise<void> {
  if (!env.JQUANTS_REFRESH_TOKEN) return;
  console.log('[weekly-screening] Start (batch + finalize)');

  // Step 1: 全上場銘柄取得 + 時価総額フィルタ
  let pageToken: string | undefined;
  const allCandidates: Array<{ symbol: string; marketCap: number | null; sector: string | null }> = [];
  let page = 0;
  const MAX_PAGES = 10;

  do {
    const result = await fetchAllListedStocks(env.DB, env.JQUANTS_REFRESH_TOKEN, pageToken);
    allCandidates.push(...result.candidates);
    pageToken = result.nextPageToken ?? undefined;
    page++;
  } while (pageToken && page < MAX_PAGES);

  const filtered = allCandidates.filter(c =>
    c.marketCap !== null && c.marketCap >= 5000 && c.marketCap <= 500000
  );

  await env.DB.prepare(
    "INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)"
  ).bind(
    'weekly_screening_candidates',
    JSON.stringify(filtered.slice(0, 500)),
    new Date().toISOString()
  ).run();

  console.log(`[weekly-screening] Batch: ${allCandidates.length} total, ${filtered.length} filtered`);

  // Step 2: ファンダメンタルズ取得（旧 Finalize — Batch 直後に await で実行するため5分待ち不要）
  const top100 = filtered.slice(0, 100).map(c => c.symbol);
  const fundaData = await fetchFundamentals(env.DB, env.JQUANTS_REFRESH_TOKEN, top100);
  await saveFundamentals(env.DB, fundaData);

  console.log(`[weekly-screening] Finalize: ${fundaData.length} candidates — Done`);
}

/** 日次統合タスク: ResultPnl + DailyTasks（UTC15:00 = JST0:00） */
async function runDailyAll(env: Env): Promise<void> {
  const now = new Date();
  console.log('[daily-all] Start');

  // ResultPnl（旧 0 14 * * * を統合）
  try {
    await recordResultPnl(env.DB);
  } catch (e) {
    console.warn(`[daily-all] recordResultPnl error: ${String(e).slice(0, 100)}`);
  }

  // DailyTasks（旧 run() 内の JST 0:00 処理を独立化）
  await runDailyTasks(env, now);

  console.log('[daily-all] Done');
}

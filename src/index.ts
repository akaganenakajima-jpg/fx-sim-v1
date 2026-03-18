// エントリーポイント
// scheduled: 1分ごとにレート取得→指標取得→TP/SL確認→フィルタ→Gemini判定→記録
// fetch:     GET / → ダッシュボード、GET /api/status → JSON、GET /style.css・/app.js → 静的ファイル

import { getUSDJPY } from './rate';
import { fetchNews } from './news';
import { fetchRedditSignal } from './reddit';
import { getMarketIndicators } from './indicators';
import { getDecision } from './gemini';
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
import { INSTRUMENTS } from './instruments';

interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
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
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
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
          const status = await getApiStatus(env.DB);
          return new Response(JSON.stringify(status), {
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

async function run(env: Env): Promise<void> {
  const now = new Date();
  const cronStart = Date.now();
  console.log(`[fx-sim] cron start ${now.toISOString()}`);

  try {
    // 1. 全価格・共通データを一括取得
    let usdJpyRate: number;
    try {
      usdJpyRate = await getUSDJPY();
    } catch (e) {
      console.error('[fx-sim] rate fetch failed:', e);
      await insertSystemLog(env.DB, 'ERROR', 'RATE', 'レート取得失敗', String(e).slice(0, 200));
      return;
    }

    const [newsResult, redditResult, indicatorsResult] = await Promise.allSettled([
      fetchNews(),
      fetchRedditSignal(),
      getMarketIndicators(),
    ]);

    // 各外部API失敗をログに記録
    if (newsResult.status === 'rejected') {
      await insertSystemLog(env.DB, 'WARN', 'NEWS', 'ニュース取得失敗', String(newsResult.reason).slice(0, 200));
    }
    if (redditResult.status === 'rejected') {
      await insertSystemLog(env.DB, 'WARN', 'REDDIT', 'Reddit取得失敗', String(redditResult.reason).slice(0, 200));
    }
    if (indicatorsResult.status === 'rejected') {
      await insertSystemLog(env.DB, 'WARN', 'INDICATORS', '指標取得失敗', String(indicatorsResult.reason).slice(0, 200));
    }

    const news = newsResult.status === 'fulfilled' ? newsResult.value : [];
    const redditSignal = redditResult.status === 'fulfilled' ? redditResult.value : { hasSignal: false, keywords: [], topPosts: [] };
    const indicators = indicatorsResult.status === 'fulfilled' ? indicatorsResult.value : { vix: null, us10y: null, nikkei: null, sp500: null };

    // 価格マップ（USD/JPYはfrankfurter、他はYahoo Finance経由のindicators）
    const prices = new Map<string, number | null>([
      ['USD/JPY',   usdJpyRate],
      ['Nikkei225', indicators.nikkei],
      ['S&P500',    indicators.sp500],
      ['US10Y',     indicators.us10y],
    ]);

    // 2. 全銘柄のTP/SLを一括チェック
    await checkAndCloseAllPositions(env.DB, prices, INSTRUMENTS);

    // 3. ニュースハッシュ更新
    const prevNewsHashRaw = await getCacheValue(env.DB, PREV_NEWS_HASH_KEY);
    const currentNewsHash = newsHash(news.map((n) => n.title));
    const hasNewNews = currentNewsHash !== (prevNewsHashRaw ?? '');
    await setCacheValue(env.DB, PREV_NEWS_HASH_KEY, currentNewsHash);

    // news_summary: JSON形式で保存（title・pubDate・description）
    const newsSummary = news.length > 0
      ? JSON.stringify(news.slice(0, 8).map((n) => ({
          title: n.title,
          pubDate: n.pubDate,
          description: n.description?.slice(0, 200) || '',
        }))).slice(0, 2000)
      : null;

    // 4. 銘柄ごとにフィルタ → Gemini 判定 → 記録
    for (const instrument of INSTRUMENTS) {
      const currentRate = prices.get(instrument.pair);
      if (currentRate == null) {
        console.log(`[fx-sim] ${instrument.pair}: price unavailable, skipping`);
        continue;
      }

      // 前回レートをキャッシュから取得
      const cacheKey = `prev_rate_${instrument.pair}`;
      const prevRateRaw = await getCacheValue(env.DB, cacheKey);
      const prevRate = prevRateRaw ? parseFloat(prevRateRaw) : currentRate;
      await setCacheValue(env.DB, cacheKey, String(currentRate));

      // フィルタ判定
      const filterResult = shouldCallGemini({
        currentRate,
        prevRate,
        rateChangeTh: instrument.rateChangeTh,
        hasNewNews,
        redditSignal,
        now,
      });

      console.log(
        `[fx-sim] ${instrument.pair} rate=${currentRate} filter=${filterResult.shouldCall} reason="${filterResult.reason}"`
      );

      if (!filterResult.shouldCall) {
        await insertDecision(env.DB, {
          pair: instrument.pair,
          rate: currentRate,
          decision: 'HOLD',
          tp_rate: null,
          sl_rate: null,
          reasoning: `スキップ: ${filterResult.reason}`,
          news_summary: null,
          reddit_signal: null,
          vix: indicators.vix,
          us10y: indicators.us10y,
          nikkei: indicators.nikkei,
          sp500: indicators.sp500,
          created_at: now.toISOString(),
        });
        continue;
      }

      // オープンポジション確認（銘柄別）
      const openPos = await getOpenPositionByPair(env.DB, instrument.pair);
      const hasOpenPosition = openPos !== null;

      // Gemini 判定
      let geminiResult;
      try {
        geminiResult = await getDecision({
          instrument,
          rate: currentRate,
          indicators,
          news,
          redditSignal,
          hasOpenPosition,
          apiKey: env.GEMINI_API_KEY,
        });
      } catch (e) {
        console.error(`[fx-sim] Gemini error (${instrument.pair}):`, e);
        await insertSystemLog(env.DB, 'ERROR', 'GEMINI', `Gemini API エラー (${instrument.pair})`, String(e).slice(0, 200));
        await insertDecision(env.DB, {
          pair: instrument.pair,
          rate: currentRate,
          decision: 'HOLD',
          tp_rate: null,
          sl_rate: null,
          reasoning: `Geminiエラー: ${String(e).slice(0, 100)}`,
          news_summary: null,
          reddit_signal: redditSignal.keywords.join(', ') || null,
          vix: indicators.vix,
          us10y: indicators.us10y,
          nikkei: indicators.nikkei,
          sp500: indicators.sp500,
          created_at: now.toISOString(),
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
      });

      // BUY/SELL なら新規ポジションをオープン
      if (
        (geminiResult.decision === 'BUY' || geminiResult.decision === 'SELL') &&
        !hasOpenPosition
      ) {
        await openPosition(
          env.DB,
          instrument.pair,
          geminiResult.decision,
          currentRate,
          geminiResult.tp_rate,
          geminiResult.sl_rate
        );
        await insertSystemLog(
          env.DB, 'INFO', 'POSITION',
          `ポジション開設: ${instrument.pair} ${geminiResult.decision} @ ${currentRate}`,
          JSON.stringify({ tp: geminiResult.tp_rate, sl: geminiResult.sl_rate, reasoning: geminiResult.reasoning?.slice(0, 100) })
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
    console.log(`[fx-sim] cron done in ${elapsed}ms`);
    // 実行時間が30秒超はWARN
    if (elapsed > 30000) {
      await insertSystemLog(env.DB, 'WARN', 'CRON', `実行時間超過: ${elapsed}ms`, null);
    }

  } catch (e) {
    console.error('[fx-sim] unhandled error:', e);
    try {
      await insertSystemLog(env.DB, 'ERROR', 'CRON', '予期しないエラー', String(e).slice(0, 300));
    } catch {}
  }
}

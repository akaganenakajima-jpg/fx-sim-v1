// cron エントリーポイント
// 1分ごとに実行: レート取得→指標取得→TP/SL確認→フィルタ→Gemini判定→記録

import { getUSDJPY } from './rate';
import { fetchNews } from './news';
import { fetchRedditSignal } from './reddit';
import { getMarketIndicators } from './indicators';
import { getDecision } from './gemini';
import { checkAndClosePositions, openPosition } from './position';
import { shouldCallGemini } from './filter';
import {
  getOpenPositions,
  insertDecision,
  getCacheValue,
  setCacheValue,
} from './db';

interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  FRED_API_KEY: string;
}

const PREV_RATE_CACHE_KEY = 'prev_rate';
const PREV_NEWS_HASH_KEY = 'prev_news_hash';

/** ニュースタイトルの簡易ハッシュ（変化検出用）*/
function newsHash(titles: string[]): string {
  return titles.join('|');
}

export default {
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
  console.log(`[fx-sim] cron start ${now.toISOString()}`);

  try {
    // 1. レート取得
    let currentRate: number;
    try {
      currentRate = await getUSDJPY();
    } catch (e) {
      console.error('[fx-sim] rate fetch failed:', e);
      return;
    }

    // 2. ニュース取得
    const news = await fetchNews();

    // 3. Reddit シグナル取得
    const redditSignal = await fetchRedditSignal();

    // 4. 市場指標取得（VIX・米10年債・日経・S&P500）
    const indicators = await getMarketIndicators(env.DB, env.FRED_API_KEY);

    // 5. 既存オープンポジションの TP/SL チェック
    await checkAndClosePositions(env.DB, currentRate);

    // 6. 前回レート・前回ニュースをキャッシュから取得
    const [prevRateRaw, prevNewsHashRaw] = await Promise.all([
      getCacheValue(env.DB, PREV_RATE_CACHE_KEY),
      getCacheValue(env.DB, PREV_NEWS_HASH_KEY),
    ]);
    const prevRate = prevRateRaw ? parseFloat(prevRateRaw) : currentRate;
    const currentNewsHash = newsHash(news.map((n) => n.title));
    const hasNewNews = currentNewsHash !== (prevNewsHashRaw ?? '');

    // キャッシュ更新
    await Promise.all([
      setCacheValue(env.DB, PREV_RATE_CACHE_KEY, String(currentRate)),
      setCacheValue(env.DB, PREV_NEWS_HASH_KEY, currentNewsHash),
    ]);

    // 7. Gemini 呼び出し要否フィルタ判定
    const filterResult = shouldCallGemini({
      currentRate,
      prevRate,
      hasNewNews,
      redditSignal,
      now,
    });

    console.log(
      `[fx-sim] rate=${currentRate} filter=${filterResult.shouldCall} reason="${filterResult.reason}"`
    );

    // フィルタでスキップの場合は HOLD として記録して終了
    if (!filterResult.shouldCall) {
      await insertDecision(env.DB, {
        pair: 'USD/JPY',
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
      return;
    }

    // 8. オープンポジション確認
    const openPositions = await getOpenPositions(env.DB);
    const hasOpenPosition = openPositions.length > 0;

    // 9. Gemini に判定依頼
    let geminiResult;
    try {
      geminiResult = await getDecision({
        rate: currentRate,
        indicators,
        news,
        redditSignal,
        hasOpenPosition,
        apiKey: env.GEMINI_API_KEY,
      });
    } catch (e) {
      console.error('[fx-sim] Gemini API error:', e);
      // Gemini エラー時は HOLD として記録
      await insertDecision(env.DB, {
        pair: 'USD/JPY',
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
      return;
    }

    // 10. decisions テーブルに記録
    const newsSummary = news.map((n) => n.title).join(' | ').slice(0, 500);
    await insertDecision(env.DB, {
      pair: 'USD/JPY',
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

    // 11. BUY/SELL なら新規ポジションをオープン
    if (
      (geminiResult.decision === 'BUY' || geminiResult.decision === 'SELL') &&
      !hasOpenPosition
    ) {
      await openPosition(
        env.DB,
        geminiResult.decision,
        currentRate,
        geminiResult.tp_rate,
        geminiResult.sl_rate
      );
    }

    // 12. サマリーログ
    console.log(
      `[fx-sim] ✅ ${geminiResult.decision} @ ${currentRate}` +
        ` TP=${geminiResult.tp_rate ?? '-'} SL=${geminiResult.sl_rate ?? '-'}` +
        ` VIX=${indicators.vix ?? '-'} US10Y=${indicators.us10y ?? '-'}%` +
        ` | ${geminiResult.reasoning}`
    );
  } catch (e) {
    // cron が止まらないよう最外部でキャッチ
    console.error('[fx-sim] unhandled error:', e);
  }
}

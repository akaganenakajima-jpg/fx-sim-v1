// エントリーポイント
// scheduled: 1分ごとにレート取得→指標取得→TP/SL確認→フィルタ→Gemini判定→記録
// fetch:     GET / → ダッシュボード、GET /api/status → JSON、GET /style.css・/app.js → 静的ファイル

import { getUSDJPY } from './rate';
import { fetchNews } from './news';
import { fetchRedditSignal } from './reddit';
import { getMarketIndicators } from './indicators';
import { getDecision, getDecisionGPT, analyzeNews } from './gemini';
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
  GEMINI_API_KEY_2?: string;
  OPENAI_API_KEY?: string;
}

let _keyToggle = false;
function getApiKey(env: Env): string {
  _keyToggle = !_keyToggle;
  if (env.GEMINI_API_KEY_2 && _keyToggle) {
    return env.GEMINI_API_KEY_2;
  }
  return env.GEMINI_API_KEY;
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
          const status = await getApiStatus(env.DB);
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

async function run(env: Env): Promise<void> {
  const now = new Date();
  const cronStart = Date.now();
  console.log(`[fx-sim] cron start ${now.toISOString()}`);

  try {
    // ワンタイムマイグレーション: 旧PnL(pt)→円に変換（S&P500: ×100, US10Y: ×50）
    const migrated = await getCacheValue(env.DB, 'pnl_yen_migrated');
    if (!migrated) {
      await env.DB.prepare(`UPDATE positions SET pnl = pnl * 100 WHERE pair = 'S&P500' AND status = 'CLOSED' AND pnl IS NOT NULL`).run();
      await env.DB.prepare(`UPDATE positions SET pnl = pnl * 50 WHERE pair = 'US10Y' AND status = 'CLOSED' AND pnl IS NOT NULL`).run();
      await env.DB.prepare(`UPDATE positions SET pnl = pnl * 10 WHERE pair = 'Nikkei225' AND status = 'CLOSED' AND pnl IS NOT NULL`).run();
      // USD/JPYは倍率変更なし（100→100）
      await setCacheValue(env.DB, 'pnl_yen_migrated', '1');
      console.log('[fx-sim] PnL migration to yen completed');
    }

    // 1. 全価格・共通データを一括取得（Yahoo Finance + frankfurterフォールバック）
    const [newsResult, redditResult, indicatorsResult, frankfurterResult] = await Promise.allSettled([
      fetchNews(),
      fetchRedditSignal(),
      getMarketIndicators(),
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

    const news = newsResult.status === 'fulfilled' ? newsResult.value : [];
    const redditSignal = redditResult.status === 'fulfilled' ? redditResult.value : { hasSignal: false, keywords: [], topPosts: [] };
    const indicators = indicatorsResult.status === 'fulfilled' ? indicatorsResult.value : { vix: null, us10y: null, nikkei: null, sp500: null, usdjpy: null, btcusd: null, gold: null, eurusd: null, ethusd: null, crudeoil: null, natgas: null, copper: null };
    const frankfurterRate = frankfurterResult.status === 'fulfilled' ? frankfurterResult.value : null;

    // USD/JPY: Yahoo Finance優先、フォールバックでfrankfurter
    const usdJpyRate = indicators.usdjpy ?? frankfurterRate;
    if (usdJpyRate == null) {
      console.error('[fx-sim] USD/JPY rate unavailable from all sources');
      await insertSystemLog(env.DB, 'ERROR', 'RATE', 'USD/JPYレート取得失敗（全ソース）', null);
      return;
    }

    // 価格マップ（全てYahoo Finance経由）
    const prices = new Map<string, number | null>([
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
    ]);

    // 2. 全銘柄のTP/SLを一括チェック
    await checkAndCloseAllPositions(env.DB, prices, INSTRUMENTS);

    // 3. ニュースハッシュ更新
    const prevNewsHashRaw = await getCacheValue(env.DB, PREV_NEWS_HASH_KEY);
    const currentNewsHash = newsHash(news.map((n) => n.title));
    const hasNewNews = currentNewsHash !== (prevNewsHashRaw ?? '');
    await setCacheValue(env.DB, PREV_NEWS_HASH_KEY, currentNewsHash);

    // 一時的: 分析データがなければ強制実行（初回のみ）
    const existingAnalysis = await getCacheValue(env.DB, 'news_analysis');
    const forceAnalysis = !existingAnalysis && news.length > 0;

    // 新ニュース検出時: Geminiでマーケットインパクト分析
    let newsAnalysisRan = false;
    if ((hasNewNews || forceAnalysis) && news.length > 0) {
      try {
        const analysis = await analyzeNews({ news, apiKey: getApiKey(env) });
        await setCacheValue(env.DB, 'news_analysis', JSON.stringify(analysis));
        newsAnalysisRan = true;
        console.log(`[fx-sim] News analysis: ${analysis.filter(a => a.attention).length}/${analysis.length} flagged`);
      } catch (e) {
        console.error('[fx-sim] News analysis failed:', e);
        await insertSystemLog(env.DB, 'WARN', 'NEWS', 'ニュース分析失敗', String(e).slice(0, 200));
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

    let geminiCallsThisRun = (newsAnalysisRan || isInCooldown) ? 99 : 0; // クールダウン中は全スキップ
    const MAX_GEMINI_PER_RUN = hasAttentionNews ? 3 : 1;
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

      if (!filterResult.shouldCall && !hasAttentionNews) {
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

      // レート制限: 今回のcronでGemini呼出上限に達したらスキップ
      if (geminiCallsThisRun >= MAX_GEMINI_PER_RUN) {
        await insertDecision(env.DB, {
          pair: instrument.pair, rate: currentRate, decision: 'HOLD',
          tp_rate: null, sl_rate: null,
          reasoning: `レート制限: 次のcronで判定予定`,
          news_summary: null, reddit_signal: null,
          vix: indicators.vix, us10y: indicators.us10y,
          nikkei: indicators.nikkei, sp500: indicators.sp500,
          created_at: now.toISOString(),
        });
        continue;
      }

      // オープンポジション確認（銘柄別）
      const openPos = await getOpenPositionByPair(env.DB, instrument.pair);
      const hasOpenPosition = openPos !== null;

      // 過去履歴（この銘柄の直近5件のクローズ）+ 全ポジション方向
      const recentTradesRaw = await env.DB
        .prepare(`SELECT pair, direction, pnl, close_reason FROM positions WHERE pair = ? AND status = 'CLOSED' ORDER BY closed_at DESC LIMIT 5`)
        .bind(instrument.pair)
        .all<{ pair: string; direction: string; pnl: number; close_reason: string }>();
      const recentTrades = recentTradesRaw.results ?? [];

      const allOpenRaw = await env.DB
        .prepare(`SELECT pair, direction FROM positions WHERE status = 'OPEN'`)
        .all<{ pair: string; direction: string }>();
      const allPositionDirections = (allOpenRaw.results ?? []).map(p => `${p.pair}:${p.direction}`);

      // Gemini 判定
      geminiCallsThisRun++;
      let geminiResult;
      try {
        geminiResult = await getDecision({
          instrument,
          rate: currentRate,
          indicators,
          news,
          redditSignal,
          hasOpenPosition,
          recentTrades,
          allPositionDirections,
          apiKey: getApiKey(env),
        });
      } catch (e) {
        console.error(`[fx-sim] Gemini error (${instrument.pair}):`, e);
        // 429 → GPT-4o-mini フォールバック
        if (String(e).includes('429') && env.OPENAI_API_KEY) {
          try {
            console.log(`[fx-sim] Falling back to GPT-4o-mini for ${instrument.pair}`);
            geminiResult = await getDecisionGPT({
              instrument, rate: currentRate, indicators, news, redditSignal,
              hasOpenPosition, recentTrades, allPositionDirections,
              apiKey: env.OPENAI_API_KEY,
            });
            await insertSystemLog(env.DB, 'INFO', 'GPT', `GPTフォールバック成功 (${instrument.pair}) → ${geminiResult.decision}`, null);
          } catch (gptErr) {
            console.error(`[fx-sim] GPT fallback also failed:`, gptErr);
            await insertSystemLog(env.DB, 'ERROR', 'GPT', `GPTフォールバック失敗 (${instrument.pair})`, String(gptErr).slice(0, 200));
          }
        }
        if (!geminiResult) {
          await insertSystemLog(env.DB, 'ERROR', 'GEMINI', `Gemini API エラー (${instrument.pair})`, String(e).slice(0, 200));
        }
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

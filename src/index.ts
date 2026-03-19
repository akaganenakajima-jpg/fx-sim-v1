// エントリーポイント
// scheduled: 1分ごとにレート取得→指標取得→TP/SL確認→フィルタ→Gemini判定→記録
// fetch:     GET / → ダッシュボード、GET /api/status → JSON、GET /style.css・/app.js → 静的ファイル

import { getUSDJPY } from './rate';
import { fetchNews, type SourceFetchStat } from './news';
import { fetchRedditSignal } from './reddit';
import { getMarketIndicators } from './indicators';
import { getDecision, getDecisionGPT, getDecisionClaude, analyzeNews, analyzeNewsGPT, analyzeNewsClaude } from './gemini';
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
  GEMINI_API_KEY_3?: string;
  GEMINI_API_KEY_4?: string;
  GEMINI_API_KEY_5?: string;
  OPENAI_API_KEY?: string;
  OPENAI_API_KEY_2?: string;
  ANTHROPIC_API_KEY?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
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
      fetchRedditSignal(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET),
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

    const newsData = newsResult.status === 'fulfilled' ? newsResult.value : { items: [], stats: [] };
    const news = newsData.items;
    const newsFetchStats = newsData.stats;

    // ニュースソース統計をD1に記録（バッチINSERT）
    if (newsFetchStats.length > 0) {
      try {
        const stmt = env.DB.prepare(
          `INSERT INTO news_fetch_log (source, ok, latency_ms, item_count, avg_freshness, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        );
        const batch = newsFetchStats.map(s =>
          stmt.bind(s.source, s.ok ? 1 : 0, s.latencyMs, s.itemCount, s.avgFreshnessMin, now.toISOString())
        );
        await env.DB.batch(batch);
      } catch (e) {
        console.warn(`[fx-sim] news_fetch_log insert error: ${String(e).slice(0, 100)}`);
      }
    }

    // ニュースソース名リスト（decisions記録用）
    const activeNewsSources = [...new Set(news.map(n => n.source))].join(',');
    const redditSignal = redditResult.status === 'fulfilled' ? redditResult.value : { hasSignal: false, keywords: [], topPosts: [] };
    const indicators = indicatorsResult.status === 'fulfilled' ? indicatorsResult.value : { vix: null, us10y: null, nikkei: null, sp500: null, usdjpy: null, btcusd: null, gold: null, eurusd: null, ethusd: null, crudeoil: null, natgas: null, copper: null, silver: null, gbpusd: null, audusd: null, solusd: null, dax: null, nasdaq: null };
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
      ['Silver',    indicators.silver],
      ['GBP/USD',   indicators.gbpusd],
      ['AUD/USD',   indicators.audusd],
      ['SOL/USD',   indicators.solusd],
      ['DAX',       indicators.dax],
      ['NASDAQ',    indicators.nasdaq],
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
      let analysis = null;
      // Gemini → GPT → Claude フォールバック
      try {
        analysis = await analyzeNews({ news, apiKey: getApiKey(env) });
      } catch (e) {
        const is429 = String(e).includes('429');
        console.warn(`[fx-sim] News analysis Gemini ${is429 ? '429' : 'error'}: ${String(e).split('\n')[0].slice(0, 80)}`);
        if (is429 && env.OPENAI_API_KEY) {
          try {
            analysis = await analyzeNewsGPT({ news, apiKey: env.OPENAI_API_KEY });
            console.log('[fx-sim] News analysis: GPT fallback success');
          } catch (gptErr) {
            console.warn(`[fx-sim] News analysis GPT failed: ${String(gptErr).split('\n')[0].slice(0, 80)}`);
          }
        }
        if (!analysis && env.ANTHROPIC_API_KEY) {
          try {
            analysis = await analyzeNewsClaude({ news, apiKey: env.ANTHROPIC_API_KEY });
            console.log('[fx-sim] News analysis: Claude fallback success');
          } catch (claudeErr) {
            console.warn(`[fx-sim] News analysis Claude failed: ${String(claudeErr).split('\n')[0].slice(0, 80)}`);
          }
        }
        if (!analysis) {
          await insertSystemLog(env.DB, 'WARN', 'NEWS', 'ニュース分析失敗（全プロバイダー）', is429 ? 'Gemini 429→GPT/Claude失敗' : String(e).split('\n')[0].slice(0, 120));
        }
      }
      if (analysis) {
        await setCacheValue(env.DB, 'news_analysis', JSON.stringify(analysis));
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
    const MAX_GEMINI_PER_RUN = (newsAnalysisRan || isInCooldown)
      ? 0  // ニュース分析済 or クールダウン中 → AI呼出スキップ
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

    for (const instrument of INSTRUMENTS) {
      const currentRate = prices.get(instrument.pair);
      if (currentRate == null) {
        console.warn(`[fx-sim] ${instrument.pair}: price unavailable`);
        await insertSystemLog(env.DB, 'WARN', 'RATE', `レート取得失敗: ${instrument.pair}`, null);
        continue;
      }

      const cacheKey = `prev_rate_${instrument.pair}`;
      const prevRateRaw = await getCacheValue(env.DB, cacheKey);
      const prevRate = prevRateRaw ? parseFloat(prevRateRaw) : currentRate;
      await setCacheValue(env.DB, cacheKey, String(currentRate));

      const lastCallKey = `last_ai_call_${instrument.pair}`;
      const lastCallTime = await getCacheValue(env.DB, lastCallKey);

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

    // 4b. フィルタ通過銘柄をスコア降順でソート
    const passed = candidateList.filter(c => c.filterResult.shouldCall || hasAttentionNews);
    const skipped = candidateList.filter(c => !c.filterResult.shouldCall && !hasAttentionNews);
    passed.sort((a, b) => b.totalScore - a.totalScore);

    // スキップ銘柄を先に記録
    for (const c of skipped) {
      await insertDecision(env.DB, {
        pair: c.instrument.pair, rate: c.currentRate, decision: 'HOLD',
        tp_rate: null, sl_rate: null,
        reasoning: `スキップ: ${c.filterResult.reason}`,
        news_summary: null, reddit_signal: null,
        vix: indicators.vix, us10y: indicators.us10y,
        nikkei: indicators.nikkei, sp500: indicators.sp500,
        created_at: now.toISOString(),
      });
    }

    if (passed.length > 0) {
      console.log(`[fx-sim] フィルタ通過 ${passed.length}件 (上限${MAX_GEMINI_PER_RUN}) → ${passed.slice(0, MAX_GEMINI_PER_RUN).map(c => `${c.instrument.pair}(${c.totalScore.toFixed(1)})`).join(', ')}`);
    }

    // 上限超過分をHOLD記録
    for (const c of passed.slice(MAX_GEMINI_PER_RUN)) {
      await insertDecision(env.DB, {
        pair: c.instrument.pair, rate: c.currentRate, decision: 'HOLD',
        tp_rate: null, sl_rate: null,
        reasoning: `低優先度(スコア${c.totalScore.toFixed(1)}): 次のcronで判定予定`,
        news_summary: null, reddit_signal: null,
        vix: indicators.vix, us10y: indicators.us10y,
        nikkei: indicators.nikkei, sp500: indicators.sp500,
        created_at: now.toISOString(),
      });
    }

    let geminiOkCount = 0, gptOkCount = 0, claudeOkCount = 0, aiFailCount = 0;
    // 4c. スコア上位からAI判定
    for (const candidate of passed.slice(0, MAX_GEMINI_PER_RUN)) {
      const { instrument, currentRate } = candidate;

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

      // スパークラインデータ取得（トレンド分析用）
      const sparkRaw = await env.DB
        .prepare(`SELECT rate FROM decisions WHERE pair = ? ORDER BY id DESC LIMIT 20`)
        .bind(instrument.pair)
        .all<{ rate: number }>();
      const sparkRates = (sparkRaw.results ?? []).map(r => r.rate).reverse();

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
          recentTrades,
          allPositionDirections,
          sparkRates,
          apiKey: getApiKey(env),
        });
        geminiOkCount++;
      } catch (e) {
        const errMsg = String(e);
        const is429 = errMsg.includes('429');
        // ログは1行要約のみ（巨大JSONを吐かない）
        console.warn(`[fx-sim] Gemini ${is429 ? '429' : 'error'} (${instrument.pair}): ${errMsg.split('\n')[0].slice(0, 120)}`);
        // 429 → GPT-4o-mini フォールバック → Claude フォールバック
        if (is429 && env.OPENAI_API_KEY) {
          try {
            console.log(`[fx-sim] Falling back to GPT for ${instrument.pair}`);
            geminiResult = await getDecisionGPT({
              instrument, rate: currentRate, indicators, news, redditSignal,
              hasOpenPosition, recentTrades, allPositionDirections, sparkRates,
              apiKey: (_keyIndex % 2 === 0 ? env.OPENAI_API_KEY : env.OPENAI_API_KEY_2) || env.OPENAI_API_KEY!,
            });
            gptOkCount++;
            await insertSystemLog(env.DB, 'INFO', 'GPT', `GPTフォールバック成功 (${instrument.pair}) → ${geminiResult.decision}`, null);
          } catch (gptErr) {
            console.warn(`[fx-sim] GPT fallback failed (${instrument.pair}): ${String(gptErr).split('\n')[0].slice(0, 120)}`);
            // GPT失敗 → Claude フォールバック
            if (env.ANTHROPIC_API_KEY) {
              try {
                console.log(`[fx-sim] Falling back to Claude for ${instrument.pair}`);
                geminiResult = await getDecisionClaude({
                  instrument, rate: currentRate, indicators, news, redditSignal,
                  hasOpenPosition, recentTrades, allPositionDirections, sparkRates,
                  apiKey: env.ANTHROPIC_API_KEY,
                });
                claudeOkCount++;
                await insertSystemLog(env.DB, 'INFO', 'CLAUDE', `Claudeフォールバック成功 (${instrument.pair}) → ${geminiResult.decision}`, null);
              } catch (claudeErr) {
                console.warn(`[fx-sim] Claude fallback failed (${instrument.pair}): ${String(claudeErr).split('\n')[0].slice(0, 120)}`);
                await insertSystemLog(env.DB, 'ERROR', 'CLAUDE', `Claudeフォールバック失敗 (${instrument.pair})`, String(claudeErr).slice(0, 200));
              }
            }
            if (!geminiResult) {
              await insertSystemLog(env.DB, 'ERROR', 'GPT', `GPTフォールバック失敗 (${instrument.pair})`, String(gptErr).slice(0, 200));
            }
          }
        } else if (is429 && env.ANTHROPIC_API_KEY) {
          // GPTキーなし → Claude直接フォールバック
          try {
            console.log(`[fx-sim] Falling back to Claude for ${instrument.pair}`);
            geminiResult = await getDecisionClaude({
              instrument, rate: currentRate, indicators, news, redditSignal,
              hasOpenPosition, recentTrades, allPositionDirections, sparkRates,
              apiKey: env.ANTHROPIC_API_KEY,
            });
            claudeOkCount++;
            await insertSystemLog(env.DB, 'INFO', 'CLAUDE', `Claudeフォールバック成功 (${instrument.pair}) → ${geminiResult.decision}`, null);
          } catch (claudeErr) {
            console.warn(`[fx-sim] Claude fallback failed (${instrument.pair}): ${String(claudeErr).split('\n')[0].slice(0, 120)}`);
            await insertSystemLog(env.DB, 'ERROR', 'CLAUDE', `Claudeフォールバック失敗 (${instrument.pair})`, String(claudeErr).slice(0, 200));
          }
        }
        if (!geminiResult) {
          aiFailCount++;
          const logLevel = is429 ? 'WARN' : 'ERROR';
          await insertSystemLog(env.DB, logLevel, 'GEMINI', `Gemini ${is429 ? '429' : 'エラー'} (${instrument.pair})`, is429 ? '全フォールバック失敗' : errMsg.split('\n')[0].slice(0, 200));
        }
        await insertDecision(env.DB, {
          pair: instrument.pair,
          rate: currentRate,
          decision: 'HOLD',
          tp_rate: null,
          sl_rate: null,
          reasoning: is429 ? 'API制限: 次回判定予定' : `エラー: ${errMsg.split('\n')[0].slice(0, 80)}`,
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
    await setCacheValue(env.DB, 'prev_cron_elapsed', String(elapsed));
    const aiTotal = geminiOkCount + gptOkCount + claudeOkCount + aiFailCount;
    console.log(`[fx-sim] cron done in ${elapsed}ms (limit=${MAX_GEMINI_PER_RUN})` + (aiTotal > 0 ? ` | AI: Gemini=${geminiOkCount} GPT=${gptOkCount} Claude=${claudeOkCount} Fail=${aiFailCount}` : ''));
    // 実行時間が30秒超はWARN
    if (elapsed > 30000) {
      await insertSystemLog(env.DB, 'WARN', 'CRON', `実行時間超過: ${elapsed}ms`, null);
    }

    // ログパージ: 古いレコードを削除（DB肥大化防止）
    try {
      await env.DB.prepare(`DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT 500)`).run();
      await env.DB.prepare(`DELETE FROM news_fetch_log WHERE id NOT IN (SELECT id FROM news_fetch_log ORDER BY id DESC LIMIT 5000)`).run();
    } catch {}

    // 日次サマリー（JST 0:00〜0:01 = UTC 15:00〜15:01 に1日1回記録）
    const jstHour = (now.getUTCHours() + 9) % 24;
    if (jstHour === 0 && now.getUTCMinutes() === 0) {
      try {
        const dailyPerf = await env.DB.prepare(
          `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
           COALESCE(SUM(pnl), 0) AS totalPnl
           FROM positions WHERE status = 'CLOSED'`
        ).first<{ total: number; wins: number; totalPnl: number }>();
        const openCount = (await env.DB.prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'OPEN'`).first<{ c: number }>())?.c ?? 0;
        const balance = 10000 + (dailyPerf?.totalPnl ?? 0);
        const wr = dailyPerf && dailyPerf.total > 0 ? (dailyPerf.wins / dailyPerf.total * 100).toFixed(1) : '0';
        await insertSystemLog(env.DB, 'INFO', 'DAILY',
          `日次サマリー: ¥${Math.round(balance).toLocaleString()} ROI ${((balance - 10000) / 100).toFixed(1)}% 勝率${wr}% ${dailyPerf?.total ?? 0}件 OP${openCount}`,
          null);
      } catch {}
    }

  } catch (e) {
    console.error('[fx-sim] unhandled error:', e);
    try {
      await insertSystemLog(env.DB, 'ERROR', 'CRON', '予期しないエラー', String(e).slice(0, 300));
    } catch {}
  }
}

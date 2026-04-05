// core-workflow.ts — 毎分実行（価格取得・TP/SL・Logic・週末処理）

import { type Env, getApiKey } from '../env';
import { getUSDJPY } from '../rate';
import { fetchNews, filterAndTranslateNews, saveRawNews, purgeOldNewsRaw, type SourceFetchStat, type NewsApiKeys } from '../news';
import { getMarketIndicators } from '../indicators';
import { premarketAnalysis } from '../gemini';
import { checkAndCloseAllPositions } from '../position';
import {
  insertSystemLog,
  getCacheValue,
  setCacheValue,
  closePosition,
  getOpenPositions,
  getRunId,
} from '../db';
import { INSTRUMENTS } from '../instruments';
import { type BrokerEnv } from '../broker';
import { runMigrations } from '../migration';
import { sendNotification, getWebhookUrl } from '../notify';
// updateAllCandles is used in daily-workflow.ts
import { fetchEconomicCalendar, getUpcomingHighImpactEvents } from '../calendar';
import {
  getWeekendStatus,
  lockProfitsForWeekend,
  forceCloseAllForWeekend,
  getWeekendNewsDigest,
  saveFridayClosePrices,
  detectGaps,
  resetWeekendFlags,
} from '../weekend';
import { runLogicDecisions } from '../logic-trading';
// logReturn, checkTpSlSanity, getDrawdownLevel, checkInstrumentDailyLoss used in analysis-workflow.ts

export interface MarketData {
  news: ReturnType<typeof fetchNews> extends Promise<infer T> ? T extends { items: infer I } ? I : never : never;
  newsFetchStats: SourceFetchStat[];
  activeNewsSources: string;
  indicators: Awaited<ReturnType<typeof getMarketIndicators>>;
  prices: Map<string, number | null>;
}

/**
 * インジケーター + フランクフルタレート + D1フォールバックから全銘柄の price Map を構築する。
 * fetchMarketData / fetchAnalysisData の両方から呼ばれる共通ヘルパー。
 * @param indicators - getMarketIndicators の戻り値
 * @param frankfurterRate - getUSDJPY の戻り値（null 可）
 * @param db - prev_rate_* フォールバック用 D1
 * @returns prices Map と fallbackPairs（キャッシュを使った銘柄リスト）
 */
export async function buildPricesMap(
  indicators: Awaited<ReturnType<typeof getMarketIndicators>>,
  frankfurterRate: number | null,
  db: D1Database,
): Promise<{ prices: Map<string, number | null>; fallbackPairs: string[] }> {
  const usdJpyRate = indicators.usdjpy ?? frankfurterRate;

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
  const needFallback: Array<[string]> = [];
  for (const [pair, liveRate] of livePrices) {
    if (liveRate != null) {
      prices.set(pair, liveRate);
    } else {
      needFallback.push([pair]);
    }
  }
  if (needFallback.length > 0) {
    const keys = needFallback.map(([pair]) => `prev_rate_${pair}`);
    const placeholders = keys.map(() => '?').join(',');
    const rows = await db.prepare(
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
  return { prices, fallbackPairs };
}

/**
 * 週末コンテキスト文字列を構築する（プレマーケット分析・ギャップ・ダイジェスト）。
 * runCore / runAnalysis の両方から呼ばれる共通ヘルパー。
 * Phase -2/-1 のときのみ実質的な文字列を返し、それ以外は空文字列。
 */
export async function buildWeekendContext(
  db: D1Database,
  weekendStatus: ReturnType<typeof getWeekendStatus>,
): Promise<string> {
  if (weekendStatus.phase < -2 || weekendStatus.phase > -1) return '';

  const parts: string[] = [];

  // プレマーケット分析
  const pmRaw = await getCacheValue(db, 'premarket_analysis');
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
  const gapRaw = await getCacheValue(db, 'gap_signals');
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
  const digestRaw = await getCacheValue(db, 'weekend_news_digest');
  if (digestRaw) {
    try {
      const { digest } = JSON.parse(digestRaw);
      if (digest) parts.push(`【週末蓄積ニュース】\n${digest}`);
    } catch { /* ignore */ }
  }

  return parts.join('\n\n');
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
    await insertSystemLog(env.DB, 'WARN', 'NEWS', 'ニュース取得失敗', String(newsResult.reason).slice(0, 2000));
  }
  if (indicatorsResult.status === 'rejected') {
    await insertSystemLog(env.DB, 'WARN', 'INDICATORS', '指標取得失敗', String(indicatorsResult.reason).slice(0, 2000));
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

  // news_raw ステージングテーブルに全記事を保存（フィルタ前）
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
  const news = await filterAndTranslateNews(newsData.items, env.GEMINI_API_KEY, env.DB, env.AI);
  const activeNewsSources = [...new Set(news.map(n => n.source))].join(',');
  const indicators = indicatorsResult.status === 'fulfilled' ? indicatorsResult.value : { vix: null, us10y: null, nikkei: null, sp500: null, usdjpy: null, btcusd: null, gold: null, eurusd: null, ethusd: null, crudeoil: null, natgas: null, copper: null, silver: null, gbpusd: null, audusd: null, solusd: null, dax: null, nasdaq: null, uk100: null, hk33: null, eurjpy: null, gbpjpy: null, audjpy: null, kawasaki_kisen: null, nippon_yusen: null, softbank_g: null, lasertec: null, tokyo_electron: null, disco: null, advantest: null, fast_retailing: null, nippon_steel: null, mufg: null, mitsui_osk: null, tokio_marine: null, mitsubishi_corp: null, toyota: null, sakura_internet: null, mhi: null, ihi: null, anycolor: null, cover_corp: null, nvda: null, tsla: null, aapl: null, amzn: null, amd: null, meta: null, msft: null, googl: null, fearGreed: null, fearGreedLabel: null, cftcJpyNetLong: null };
  const frankfurterRate = frankfurterResult.status === 'fulfilled' ? frankfurterResult.value : null;

  const usdJpyRate = indicators.usdjpy ?? frankfurterRate;
  if (usdJpyRate == null) {
    console.error('[fx-sim] USD/JPY rate unavailable from all sources');
    await insertSystemLog(env.DB, 'ERROR', 'RATE', 'USD/JPYレート取得失敗（全ソース）');
    return null;
  }

  // 価格 Map 構築（buildPricesMap で livePrices 配列 + prev_rate_* フォールバックを一括処理）
  const { prices, fallbackPairs } = await buildPricesMap(indicators, frankfurterRate, env.DB);
  if (fallbackPairs.length > 0) {
    console.warn(`[fx-sim] Yahoo失敗→キャッシュ使用: ${fallbackPairs.join(', ')}`);
    if (fallbackPairs.length >= 3) {
      await insertSystemLog(env.DB, 'WARN', 'RATE', `Yahoo障害: ${fallbackPairs.length}銘柄キャッシュフォールバック`, fallbackPairs.join(', '));
    }
  }

  return { news, newsFetchStats, activeNewsSources, indicators, prices };
}

// ── runCore: 毎分実行（価格取得・TP/SL・Logic・週末処理）──
export async function runCore(env: Env): Promise<void> {
  const now = new Date();
  const cronStart = Date.now();
  // runId は scheduled ハンドラーで withRunId() により注入済み
  const runId = getRunId() ?? '?';
  console.log(`[fx-sim] core start ${now.toISOString()} runId=${runId}`);

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
              pmResult.market_summary.slice(0, 2000));
          }
        } catch (e) {
          await insertSystemLog(env.DB, 'WARN', 'PREMARKET',
            'プレマーケット分析失敗', String(e).slice(0, 2000));
        }
      }
    }

    // ── 施策A: 週末ニュースダイジェスト + 施策C: ギャップ検知（Phase -2 初回） ──
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
    let economicEventGuard = { highImpactNearby: false, mediumImpactNearby: false, events: [] as import('../calendar').EconomicEvent[] };
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

    // analysis_news: runAnalysis が fetchAnalysisData() で読み出すニュースキャッシュ
    // （core_shared_data を廃止し、ニュースのみを専用キーで管理する。
    //  価格・指標は runAnalysis が getMarketIndicators/getUSDJPY を直接呼ぶ）
    await setCacheValue(env.DB, 'analysis_news', JSON.stringify(
      news.map(n => ({
        title: n.title, title_ja: n.title_ja,
        description: n.description, desc_ja: n.desc_ja,
        pubDate: n.pubDate, source: (n as any).source,
        link: (n as any).link, composite_score: (n as any).composite_score,
      }))
    ));

    // 毎cronパージ（system_logs ≤5000件維持）
    try {
      await env.DB.prepare(`DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT 5000)`).run();
      await env.DB.prepare(`DELETE FROM market_cache WHERE key LIKE 'news_filter_%' AND updated_at < datetime('now', '-2 hours')`).run();
    } catch {}

    const coreMs = Date.now() - cronStart;
    console.log(`[fx-sim] core done in ${coreMs}ms (fetch=${fetchMs}ms tpsl=${tpSlMs}ms)`);

  } catch (e) {
    console.error('[fx-sim] core unhandled error:', e);
    await sendNotification(
      getWebhookUrl(env),
      `🔴 [fx-sim] core エラー: ${String(e).slice(0, 500)}`,
    );
    try {
      await insertSystemLog(env.DB, 'ERROR', 'CRON', 'core 予期しないエラー', String(e).slice(0, 2000));
    } catch {}
  }
}

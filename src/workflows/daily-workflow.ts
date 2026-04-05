// daily-workflow.ts — 日次・週次タスク（ログパージ・サマリー・銘柄スコア更新）

import { type Env, getApiKey } from '../env';
import { insertSystemLog, setCacheValue } from '../db';
import { INSTRUMENTS } from '../instruments';
import { sendNotification, getWebhookUrl, buildDailySummaryMessage, buildScreenerReportEmbeds } from '../notify';
import { updateAllCandles } from '../candles';
import { generateWeeklyReview, generateMonthlyReview } from '../trade-journal';
// getWeekendStatus, resetWeekendFlags, evaluateRecoveryIfNeeded, getDrawdownLevel used in other workflows
import { slPatternAnalysis } from '../stats';
import { fetchFundamentals, saveFundamentals, fetchAllListedStocks, cleanupOldFundamentals } from '../jquants';
import { calcStockScore, saveScores, countNewsForSymbol, getSectorAvgPer, type StockScoreInput } from '../scoring';
import {
  getTrackingList,
  getCandidateList,
  detectPromotionCandidates,
  detectDemotionCandidates,
  proposeRotation,
  recordResultPnl,
  aiSelectStocks,
  bootstrapSelectedStocks,
  pruneUnderperformers,
} from '../rotation';
import { screenCandidates, SP500_SCREEN_LIST, NIKKEI_SCREEN_LIST } from '../screener';
import { INITIAL_CAPITAL } from '../constants';
import { fetchEconomicCalendar } from '../calendar';

// ── 銘柄スコア日次更新 ──
async function updateInstrumentScores(db: D1Database): Promise<void> {
  // 各銘柄のクローズ済みポジションから統計を計算
  const rows = await db.prepare(
    `SELECT pair,
       COUNT(*) AS total_trades,
       COALESCE(SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END), 0) AS wins,
       COALESCE(AVG(CASE WHEN realized_rr IS NOT NULL THEN realized_rr END), 0) AS avg_rr_actual,
       COALESCE(AVG(pnl), 0) AS avg_pnl,
       COALESCE(SUM(pnl), 0) AS total_pnl
     FROM positions WHERE status = 'CLOSED'
     GROUP BY pair`
  ).all<{
    pair: string; total_trades: number; wins: number;
    avg_rr_actual: number;
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
    const avgRR = r.avg_rr_actual ?? 0;

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

// ── 日次タスク（ログパージ・サマリー・銘柄スコア更新）──
export async function runDailyTasks(env: Env, _now: Date): Promise<void> {
  // ログパージ（≤5000件維持）
  try {
    await env.DB.prepare(`DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT 5000)`).run();
    await env.DB.prepare(`DELETE FROM news_fetch_log WHERE id NOT IN (SELECT id FROM news_fetch_log ORDER BY id DESC LIMIT 5000)`).run();
    // news_filter_* キャッシュパージ（2時間以上前）
    await env.DB.prepare(`DELETE FROM market_cache WHERE key LIKE 'news_filter_%' AND updated_at < datetime('now', '-2 hours')`).run();
    // b2_consecutive_fails リセット（CB解除済み且つ古い場合）
    await env.DB.prepare(
      `DELETE FROM market_cache WHERE key = 'b2_consecutive_fails' AND NOT EXISTS (
        SELECT 1 FROM market_cache WHERE key = 'b2_circuit_breaker_until'
          AND CAST(value AS INTEGER) > CAST(strftime('%s','now')*1000 AS INTEGER)
      )`
    ).run();
    // news_temp_params の期限切れレコードをパージ（無限蓄積防止）
    await env.DB.prepare(`DELETE FROM news_temp_params WHERE expires_at < datetime('now')`).run();
    // system_logs: 30日以上前の古いレコードを時刻ベースでパージ（IDベース上限と併用）
    await env.DB.prepare(`DELETE FROM system_logs WHERE created_at < datetime('now', '-30 days')`).run();
    // news_fetch_log: 30日以上前の古いレコードを時刻ベースでパージ
    await env.DB.prepare(`DELETE FROM news_fetch_log WHERE created_at < datetime('now', '-30 days')`).run();
    // market_cache: 7日以上前の不要なレコードをパージ（screener_results は週次更新のため除外）
    await env.DB.prepare(
      `DELETE FROM market_cache WHERE updated_at < datetime('now', '-7 days') AND key != 'screener_results'`
    ).run();
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

// ─────────────────────────────────────────────────────────────────────────────
// AI銘柄マネージャー cronハンドラ
// ─────────────────────────────────────────────────────────────────────────────

/** 日次スコアリング: JST 06:00 (UTC 21:00) */
export async function runDailyScoring(env: Env): Promise<void> {
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
export async function runWeeklyScreening(env: Env): Promise<void> {
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

  // ── AIモメンタム・スクリーナー ──────────────────────────────────────────────
  // 米国株・日本株をスクリーニング → AI選定 → ブートストラップ → 新陳代謝
  try {
    console.log('[weekly-screening] AI Momentum Screener start');

    // 1. スクリーニング（米国株・日本株を並列実行）
    const [usCandidates, jpCandidates] = await Promise.all([
      screenCandidates(SP500_SCREEN_LIST, 'us'),
      screenCandidates(NIKKEI_SCREEN_LIST, 'jp'),
    ]);

    // スクリーニング結果をキャッシュ（ダッシュボード表示用）
    if (usCandidates.length > 0 || jpCandidates.length > 0) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)"
      ).bind('screener_results', JSON.stringify({ us: usCandidates.slice(0, 10), jp: jpCandidates.slice(0, 10) }), new Date().toISOString()).run();
    }

    // 2. AI銘柄選定（米国株・日本株を順次実行 — Geminiレート制限対策）
    const apiKey = getApiKey(env);
    const usPicks = await aiSelectStocks(usCandidates, 'us', apiKey);
    const jpPicks = await aiSelectStocks(jpCandidates, 'jp', apiKey);

    // 3. ブートストラップ（active_instruments + instrument_params）
    const usResult = await bootstrapSelectedStocks(env.DB, usPicks, 'us');
    const jpResult = await bootstrapSelectedStocks(env.DB, jpPicks, 'jp');

    // 4. パフォーマンス不良銘柄の新陳代謝
    const pruned = await pruneUnderperformers(env.DB);

    // 5. system_logsに記録
    await insertSystemLog(env.DB, 'INFO', 'SCREENER',
      `AI Screener完了: US=${usPicks.map(p => p.ticker).join(',')} JP=${jpPicks.map(p => p.ticker).join(',')} pruned=${pruned.length}件`,
      JSON.stringify({
        us: { candidates: usCandidates.length, picks: usPicks, added: usResult.added, skipped: usResult.skipped },
        jp: { candidates: jpCandidates.length, picks: jpPicks, added: jpResult.added, skipped: jpResult.skipped },
        pruned,
      })
    ).catch(() => {});

    // 6. Discord通知（AIスクリーナーレポート）
    try {
      const webhookUrl = getWebhookUrl(env);
      if (webhookUrl) {
        const embeds = buildScreenerReportEmbeds({
          usPicks, jpPicks,
          usAdded: usResult.added, jpAdded: jpResult.added,
          pruned,
          usCandidates: usCandidates.length, jpCandidates: jpCandidates.length,
        });
        await sendNotification(webhookUrl, '', embeds);
      }
    } catch (notifyErr) {
      console.warn(`[weekly-screening] Discord notify failed: ${String(notifyErr).slice(0, 80)}`);
    }

    console.log(`[weekly-screening] AI Screener done: US +${usResult.added.length} JP +${jpResult.added.length} pruned ${pruned.length}`);
  } catch (e) {
    console.warn(`[weekly-screening] AI Screener error: ${String(e).slice(0, 120)}`);
    await insertSystemLog(env.DB, 'WARN', 'SCREENER', 'AIスクリーナー失敗', String(e).slice(0, 200)).catch(() => {});
  }
}

/** 日次統合タスク: ResultPnl + DailyTasks（UTC15:00 = JST0:00） */
export async function runDailyAll(env: Env): Promise<void> {
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

// ═══════════════════════════════════════════════════════════════════════
// AI Monitoring Report — LLM巡回用Markdownレポート生成
// ═══════════════════════════════════════════════════════════════════════

export async function generateAiReport(db: D1Database): Promise<string> {
  const now = new Date();
  const nowISO = now.toISOString();
  const h24Ago = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

  // ── 並列DBクエリ ──
  const [openRows, closedRows, todayRows, activeRows] = await Promise.all([
    // 1. OPENポジション全件
    db.prepare(
      `SELECT pair, direction, entry_rate, sl_rate, tp_rate, lot, entry_at, strategy
       FROM positions WHERE status = 'OPEN' ORDER BY entry_at ASC`
    ).all<{
      pair: string; direction: string; entry_rate: number;
      sl_rate: number | null; tp_rate: number | null; lot: number;
      entry_at: string; strategy: string | null;
    }>(),
    // 2. 直近20件クローズ
    db.prepare(
      `SELECT pair, direction, entry_at, closed_at, pnl, close_reason, realized_rr
       FROM positions WHERE status = 'CLOSED' ORDER BY closed_at DESC LIMIT 20`
    ).all<{
      pair: string; direction: string; entry_at: string; closed_at: string;
      pnl: number; close_reason: string; realized_rr: number | null;
    }>(),
    // 3. 直近24hの集計
    db.prepare(
      `SELECT
         COUNT(*) as cnt,
         COALESCE(SUM(pnl), 0) as totalPnl,
         COALESCE(SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END), 0) as wins
       FROM positions WHERE status = 'CLOSED' AND closed_at >= ?`
    ).bind(h24Ago).first<{ cnt: number; totalPnl: number; wins: number }>(),
    // 4. アクティブ銘柄
    db.prepare(
      `SELECT pair, source, added_at FROM active_instruments ORDER BY pair ASC`
    ).all<{ pair: string; source: string; added_at: string }>(),
  ]);

  const openPositions = openRows.results ?? [];
  const closedPositions = closedRows.results ?? [];
  const today = todayRows ?? { cnt: 0, totalPnl: 0, wins: 0 };
  const activeInstruments = activeRows.results ?? [];

  // ── Markdown組み立て ──
  const lines: string[] = [];

  lines.push('# FX Sim AI Monitoring Report');
  lines.push(`生成時刻: ${nowISO}`);
  lines.push('');

  // § 1. 稼働ステータス & 本日の成績
  const winRate = today.cnt > 0 ? ((today.wins / today.cnt) * 100).toFixed(1) : '-';
  lines.push('## 1. 稼働ステータス & 本日の成績');
  lines.push(`- 集計期間: 直近24時間 (${h24Ago} 〜 ${nowISO})`);
  lines.push(`- 取引件数: ${today.cnt}件`);
  lines.push(`- 勝率 (RR≥1.0): ${winRate}%`);
  lines.push(`- トータルPnL: ${today.totalPnl >= 0 ? '+' : ''}${today.totalPnl.toFixed(2)}`);
  lines.push(`- 勝ち: ${today.wins}件 / 負け: ${today.cnt - today.wins}件`);
  lines.push('');

  // § 2. オープンポジション
  lines.push('## 2. 現在のオープンポジション');
  if (openPositions.length === 0) {
    lines.push('現在保有中のポジションはありません。');
  } else {
    lines.push(`保有数: ${openPositions.length}件`);
    lines.push('');
    lines.push('| Pair | Direction | Entry Rate | SL | TP | Lot | Entry Time | Strategy |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const p of openPositions) {
      const entryTime = p.entry_at.replace('T', ' ').slice(0, 19);
      lines.push(
        `| ${p.pair} | ${p.direction} | ${p.entry_rate} | ${p.sl_rate ?? '-'} | ${p.tp_rate ?? '-'} | ${p.lot.toFixed(2)} | ${entryTime} | ${p.strategy ?? '-'} |`
      );
    }
  }
  lines.push('');

  // § 3. 直近の決済履歴
  lines.push('## 3. 直近の決済履歴 (Top 20)');
  if (closedPositions.length === 0) {
    lines.push('決済履歴がありません。');
  } else {
    lines.push('| Pair | Direction | PnL | RR | Close Reason | Duration |');
    lines.push('|---|---|---|---|---|---|');
    for (const p of closedPositions) {
      const durationMs = new Date(p.closed_at).getTime() - new Date(p.entry_at).getTime();
      const durationMin = Math.round(durationMs / 60000);
      const durationStr = durationMin >= 60
        ? `${Math.floor(durationMin / 60)}h${durationMin % 60}m`
        : `${durationMin}m`;
      const pnlStr = p.pnl >= 0 ? `+${p.pnl.toFixed(2)}` : p.pnl.toFixed(2);
      const rrStr = p.realized_rr != null ? p.realized_rr.toFixed(2) : '-';
      lines.push(
        `| ${p.pair} | ${p.direction} | ${pnlStr} | ${rrStr} | ${p.close_reason} | ${durationStr} |`
      );
    }
  }
  lines.push('');

  // § 4. アクティブ銘柄
  lines.push('## 4. 現在のアクティブ銘柄 (AI Universe)');
  if (activeInstruments.length === 0) {
    lines.push('アクティブ銘柄が登録されていません。');
  } else {
    const bySource = new Map<string, string[]>();
    for (const a of activeInstruments) {
      const src = a.source ?? 'static';
      const arr = bySource.get(src) ?? [];
      arr.push(a.pair);
      bySource.set(src, arr);
    }
    for (const [source, pairs] of bySource) {
      lines.push(`- **${source}** (${pairs.length}件): ${pairs.join(', ')}`);
    }
  }
  lines.push('');

  // § フッター
  lines.push('---');
  lines.push(`*このレポートは /api/ai-report エンドポイントで自動生成されています。勝率の定義: realized_rr ≥ 1.0*`);

  return lines.join('\n');
}

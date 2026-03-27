// ロジックトレーディング実行モジュール（Ph.3）
// AIを呼ばずに定量指標（RSI/ATR/ER）でエントリーを判断する
//
// 設計根拠:
//   fx-strategy.md §2.2: EV = 勝率×RR - 敗率 → RSI逆張り×RR2.0でEV正
//   kelly-rl.md §3: OGD — 取引ごとに trades_since_review を更新しレビュートリガーへ
//   ipa/sa.md: 単一責任原則 — ロジック判断 / AI判断 / リスク管理を分離

import {
  calcTechnicalSignal,
  type InstrumentParamsRow,
} from './logic-indicators';
import { checkTpSlSanity } from './sanity';
import { checkCorrelationGuard, getDrawdownLevel, updateHWM, getCurrentBalance, applyDrawdownControl } from './risk-manager';
import { openPosition } from './position';
import { insertDecision, insertSystemLog, insertIndicatorLog, getCacheValue, setCacheValue } from './db';
import { INSTRUMENTS } from './instruments';
import type { MarketIndicators } from './indicators';
import { getBroker, type BrokerEnv } from './broker';
import { getActiveTempParams } from './news-trigger';

export interface LogicDecisionSummary {
  entered: number;
  skipped: number;
  signals: Array<{ pair: string; signal: string; reason: string }>;
}

// ─── instrument_params 全件読み込み ────────────────────────────────────────

async function loadAllParams(db: D1Database): Promise<Map<string, InstrumentParamsRow>> {
  const rows = await db
    .prepare(`SELECT * FROM instrument_params`)
    .all<InstrumentParamsRow>();
  const map = new Map<string, InstrumentParamsRow>();
  for (const row of rows.results ?? []) {
    map.set(row.pair, row);
  }
  return map;
}

// ─── 価格履歴取得（RSI/ATR計算用: 最大120件）─────────────────────────────
// price_history テーブル（毎分積み上げ）を参照することで
// decisions への循環依存（NEUTRAL=保存なし→履歴枯渇→常にNEUTRAL）を解消
// fallback: price_history が空の場合（初期起動直後）は decisions から取得

async function loadPriceHistory(
  db: D1Database,
  pairs: string[],
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (pairs.length === 0) return map;

  await Promise.all(pairs.map(async (pair) => {
    // まず price_history から取得（最大120件 = 約2時間分）
    const rows = await db
      .prepare(`SELECT rate FROM price_history WHERE pair = ? ORDER BY id DESC LIMIT 120`)
      .bind(pair)
      .all<{ rate: number }>();
    if (rows.results && rows.results.length >= 20) {
      // DESC取得を正順（最古→最新）に並び替え
      // 閾値20: rsi_period(最大14)+1=15を確実に超えてからprice_historyを使用
      map.set(pair, rows.results.map(r => r.rate).reverse());
      return;
    }
    // fallback: price_history が不足している場合（初期起動直後）
    const fallback = await db
      .prepare(`SELECT rate FROM decisions WHERE pair = ? ORDER BY id DESC LIMIT 50`)
      .bind(pair)
      .all<{ rate: number }>();
    if (fallback.results && fallback.results.length > 0) {
      map.set(pair, fallback.results.map(r => r.rate).reverse());
    }
  }));

  return map;
}

// ─── trades_since_review インクリメント ────────────────────────────────────

async function incrementTradesSinceReview(db: D1Database, pair: string): Promise<void> {
  await db
    .prepare(
      `UPDATE instrument_params
       SET trades_since_review = trades_since_review + 1,
           updated_at = ?
       WHERE pair = ?`
    )
    .bind(new Date().toISOString(), pair)
    .run();
}

// ─── メイン関数 ──────────────────────────────────────────────────────────────

export async function runLogicDecisions(
  db: D1Database,
  prices: Map<string, number | null>,
  indicators: MarketIndicators,
  brokerEnv: BrokerEnv,
  now: Date,
): Promise<LogicDecisionSummary> {
  const summary: LogicDecisionSummary = { entered: 0, skipped: 0, signals: [] };

  // 全パラメーター読み込み
  const paramsMap = await loadAllParams(db);
  if (paramsMap.size === 0) return summary;

  // 価格履歴を一括取得
  const activePairs = INSTRUMENTS.map(i => i.pair).filter(p => paramsMap.has(p));
  const historyMap = await loadPriceHistory(db, activePairs);

  // 現在のOPENポジション数・銘柄セット
  const openRaw = await db
    .prepare(`SELECT pair FROM positions WHERE status = 'OPEN'`)
    .all<{ pair: string }>();
  const openPairs = new Set((openRaw.results ?? []).map(p => p.pair));
  const OPEN_LIMIT = 10;

  // DD状態を事前取得（全銘柄共通）
  const ddResult = await getDrawdownLevel(db);
  const balance = await getCurrentBalance(db);
  await updateHWM(db, balance);
  await applyDrawdownControl(db, ddResult);

  if (ddResult.level === 'STOP') {
    await insertSystemLog(db, 'WARN', 'LOGIC',
      'DD STOP: ロジックエントリー全銘柄スキップ',
      `DD=${ddResult.ddPct.toFixed(1)}%`);
    return summary;
  }

  let logicNewEntries = 0; // このtickで新規開設したロジックポジション数

  for (const instrument of INSTRUMENTS) {
    const { pair } = instrument;
    const baseParams = paramsMap.get(pair);
    if (!baseParams) continue;

    // 臨時パラメーターを取得してマージ（NULLの項目は通常値を維持）
    const tempParams = await getActiveTempParams(db, pair, now);
    const params: InstrumentParamsRow = tempParams
      ? {
          ...baseParams,
          ...(tempParams.rsi_oversold      != null && { rsi_oversold:      tempParams.rsi_oversold }),
          ...(tempParams.rsi_overbought     != null && { rsi_overbought:    tempParams.rsi_overbought }),
          ...(tempParams.adx_min            != null && { adx_min:           tempParams.adx_min }),
          ...(tempParams.atr_tp_multiplier  != null && { atr_tp_multiplier: tempParams.atr_tp_multiplier }),
          ...(tempParams.atr_sl_multiplier  != null && { atr_sl_multiplier: tempParams.atr_sl_multiplier }),
          ...(tempParams.vix_max            != null && { vix_max:           tempParams.vix_max }),
        }
      : baseParams;

    const currentRate = prices.get(pair);
    if (currentRate == null) continue;

    // すでにOPENポジションあり → スキップ
    if (openPairs.has(pair)) {
      summary.skipped++;
      continue;
    }

    // OPEN上限チェック
    if (openPairs.size + logicNewEntries >= OPEN_LIMIT) {
      summary.skipped++;
      continue;
    }

    // VIXフィルター
    const vix = indicators.vix;
    if (vix != null && vix > params.vix_max) {
      summary.skipped++;
      summary.signals.push({ pair, signal: 'SKIP', reason: `VIX=${vix.toFixed(1)}>${params.vix_max}` });
      continue;
    }

    // ── Ph.8: セッション制限 ──
    const currentHour = now.getUTCHours();
    if (params.session_start_utc !== 0 || params.session_end_utc !== 24) {
      const inSession = params.session_start_utc < params.session_end_utc
        ? (currentHour >= params.session_start_utc && currentHour < params.session_end_utc)
        : (currentHour >= params.session_start_utc || currentHour < params.session_end_utc);
      if (!inSession) {
        summary.skipped++;
        summary.signals.push({ pair, signal: 'SKIP', reason: `session外(${currentHour}h UTC)` });
        continue;
      }
    }

    // ── Ph.8: SL後クールダウン ──
    if (params.cooldown_after_sl > 0) {
      const lastSl = await db.prepare(
        `SELECT closed_at FROM positions WHERE pair=? AND close_reason='SL' AND status='CLOSED' ORDER BY id DESC LIMIT 1`
      ).bind(pair).first<{closed_at: string}>();
      if (lastSl) {
        const slTime = new Date(lastSl.closed_at).getTime();
        const cooldownMs = params.cooldown_after_sl * 60 * 1000;
        if (now.getTime() - slTime < cooldownMs) {
          summary.skipped++;
          summary.signals.push({ pair, signal: 'SKIP', reason: `SLクールダウン中(${params.cooldown_after_sl}分)` });
          continue;
        }
      }
    }

    // ── Ph.8: 日次エントリー回数制限 ──
    if (params.daily_max_entries > 0) {
      const todayEntries = await db.prepare(
        `SELECT COUNT(*) as cnt FROM positions WHERE pair=? AND entry_at > datetime('now','start of day')`
      ).bind(pair).first<{cnt: number}>();
      if (todayEntries && todayEntries.cnt >= params.daily_max_entries) {
        summary.skipped++;
        summary.signals.push({ pair, signal: 'SKIP', reason: `日次上限(${todayEntries.cnt}/${params.daily_max_entries})` });
        continue;
      }
    }

    // 価格履歴不足チェック（RSI計算には period+1 件必要）
    const closes = historyMap.get(pair) ?? [];
    const minRequired = params.rsi_period + 1;
    if (closes.length < minRequired) {
      summary.skipped++;
      summary.signals.push({ pair, signal: 'SKIP', reason: `価格履歴不足(${closes.length}/${minRequired}件)` });
      continue;
    }

    // テクニカルシグナル計算（臨時パラメーターが適用中なら reason に付記）
    const techSignal = calcTechnicalSignal(pair, closes, currentRate, params, vix ?? null);
    const signalReason = tempParams
      ? `[TEMP:${tempParams.expires_at.slice(11, 16)}まで] ${techSignal.reason}`
      : techSignal.reason;
    summary.signals.push({ pair, signal: techSignal.signal, reason: signalReason });

    // ── アクティビティフィード: RSI/ER変化ログ ──────────────────────
    // 前回値と比較し有意な変化（RSI±5以上、ER±0.1以上）があれば indicator_logs に記録
    if (techSignal.rsi != null) {
      const prevRsiStr = await getCacheValue(db, `logic_prev_rsi_${pair}`);
      const prevRsi = prevRsiStr ? parseFloat(prevRsiStr) : null;
      if (prevRsi != null && Math.abs(techSignal.rsi - prevRsi) >= 5) {
        void insertIndicatorLog(db, pair, 'RSI', prevRsi, techSignal.rsi, now);
      }
      void setCacheValue(db, `logic_prev_rsi_${pair}`, techSignal.rsi.toFixed(1));
    }
    if (techSignal.er != null) {
      const prevErStr = await getCacheValue(db, `logic_prev_er_${pair}`);
      const prevEr = prevErStr ? parseFloat(prevErStr) : null;
      if (prevEr != null && Math.abs(techSignal.er - prevEr) >= 0.1) {
        void insertIndicatorLog(db, pair, 'ER', prevEr, techSignal.er, now);
      }
      void setCacheValue(db, `logic_prev_er_${pair}`, techSignal.er.toFixed(3));
    }

    if (techSignal.signal === 'NEUTRAL') {
      summary.skipped++;
      continue;
    }

    // ── Ph.9 ER上限チェック（mean_reversion時の強トレンド逆張り禁止）──
    if (params.strategy_primary === 'mean_reversion' && techSignal.er != null && params.er_upper_limit > 0) {
      if (techSignal.er > params.er_upper_limit) {
        summary.skipped++;
        summary.signals.push({ pair, signal: 'SKIP',
          reason: `ER=${techSignal.er.toFixed(3)}>${params.er_upper_limit}(mean_rev上限)` });
        continue;
      }
    }

    // ── Ph.7 重みつきエントリースコアリング ──────────────────────────

    // スコアが計算されている場合のみチェック
    if (techSignal.scores && params.entry_score_min > 0) {
      if (techSignal.scores.total < params.entry_score_min) {
        summary.skipped++;
        summary.signals.push({ pair, signal: 'SKIP',
          reason: `entry_score=${techSignal.scores.total.toFixed(2)}<${params.entry_score_min} [${techSignal.scores.breakdown}]` });
        continue;
      }
    }

    // フォールバック: min_signal_strength が設定済みで scores 未計算の場合（後方互換性）
    if (!techSignal.scores && techSignal.rsi != null && techSignal.er != null && params.min_signal_strength > 0) {
      const rsiDev = techSignal.signal === 'BUY'
        ? Math.max(0, (params.rsi_oversold - techSignal.rsi) / Math.max(1, params.rsi_oversold))
        : Math.max(0, (techSignal.rsi - params.rsi_overbought) / Math.max(1, 100 - params.rsi_overbought));
      const signalStrength = Math.min(1, (rsiDev + techSignal.er) / 2);
      if (signalStrength < params.min_signal_strength) {
        summary.skipped++;
        summary.signals.push({ pair, signal: 'SKIP',
          reason: `signal_str=${signalStrength.toFixed(2)}<${params.min_signal_strength}(min)` });
        continue;
      }
    }

    // ── Ph.9 エントリー根拠の多様性チェック ──────────────────────────
    if (techSignal.scores && params.min_confirm_signals > 0) {
      const significantSignals = [
        techSignal.scores.rsi > 0.1 ? 1 : 0,
        techSignal.scores.er > 0.1 ? 1 : 0,
        techSignal.scores.mtf > 0.1 ? 1 : 0,
        techSignal.scores.sr > 0.1 ? 1 : 0,
        techSignal.scores.pa > 0.1 ? 1 : 0,
        techSignal.scores.bb > 0.1 ? 1 : 0,
        techSignal.scores.div > 0.1 ? 1 : 0,
      ].reduce((a, b) => a + b, 0);

      if (significantSignals < params.min_confirm_signals) {
        summary.skipped++;
        summary.signals.push({ pair, signal: 'SKIP',
          reason: `confirm=${significantSignals}<${params.min_confirm_signals}(根拠不足)` });
        continue;
      }
    }

    // BUY/SELL シグナル → TP/SL null チェック
    if (techSignal.tp_rate == null || techSignal.sl_rate == null) {
      summary.skipped++;
      continue;
    }

    // 3. VIX/マクロスケール適用（calcTechnicalSignal の base TP/SL を上書き）
    let scaledTp = techSignal.tp_rate;
    let scaledSl = techSignal.sl_rate;

    const atrVal = techSignal.atr ?? 0;
    if (atrVal > 0) {
      const vixAboveAlert = vix != null && vix > params.vix_max * 0.7;
      const macroBearish  = vix != null && vix > params.vix_max * 0.5
                            && params.macro_sl_scale !== 1.0;

      if (vixAboveAlert || macroBearish) {
        const tpMult = params.atr_tp_multiplier * (vixAboveAlert ? params.vix_tp_scale : 1.0);
        const slMult = params.atr_sl_multiplier
          * (vixAboveAlert ? params.vix_sl_scale  : 1.0)
          * (macroBearish  ? params.macro_sl_scale : 1.0);
        const scaleReason = [
          vixAboveAlert ? `VIX警戒(×${params.vix_tp_scale.toFixed(2)})` : '',
          macroBearish  ? `マクロ(SL×${params.macro_sl_scale.toFixed(2)})` : '',
        ].filter(Boolean).join(' ');

        if (techSignal.signal === 'BUY') {
          scaledTp = parseFloat((currentRate + atrVal * tpMult).toFixed(5));
          scaledSl = parseFloat((currentRate - atrVal * slMult).toFixed(5));
        } else {
          scaledTp = parseFloat((currentRate - atrVal * tpMult).toFixed(5));
          scaledSl = parseFloat((currentRate + atrVal * slMult).toFixed(5));
        }
        summary.signals.find(s => s.pair === pair && s.signal !== 'SKIP')
          && (summary.signals[summary.signals.length - 1].reason += ` [${scaleReason}]`);
      }
    }

    // ── Ph.6.5: tpSlMin下限クランプ（ATR過小時の対策）──────────────
    {
      const isBuySignal = techSignal.signal === 'BUY';
      const rawSlDist = Math.abs(scaledSl - currentRate);
      if (rawSlDist < instrument.tpSlMin && instrument.tpSlMin > 0) {
        const rawTpDist = Math.abs(scaledTp - currentRate);
        const rrRatio = rawSlDist > 0 ? rawTpDist / rawSlDist : 1.5;
        const clampedSlDist = instrument.tpSlMin;
        const clampedTpDist = clampedSlDist * Math.max(rrRatio, 2.0);
        scaledSl = parseFloat((isBuySignal ? currentRate - clampedSlDist : currentRate + clampedSlDist).toFixed(5));
        scaledTp = parseFloat((isBuySignal ? currentRate + clampedTpDist : currentRate - clampedTpDist).toFixed(5));
      }
    }

    // ── Ph.7 RR比チェック（スケール適用後）──────────────────────────
    const tpDist = Math.abs(scaledTp - currentRate);
    const slDist = Math.abs(scaledSl - currentRate);
    const actualRR = slDist > 0 ? tpDist / slDist : 0;

    if (actualRR < params.min_rr_ratio) {
      summary.skipped++;
      summary.signals.push({ pair, signal: 'SKIP',
        reason: `RR=${actualRR.toFixed(2)}<${params.min_rr_ratio}(min)` });
      continue;
    }

    const sanity = checkTpSlSanity({
      direction: techSignal.signal,
      rate: currentRate,
      tp: scaledTp,
      sl: scaledSl,
      instrument,
    });

    if (!sanity.valid) {
      await insertSystemLog(db, 'WARN', 'SANITY',
        `LOGIC TP/SL異常: ${pair} ${techSignal.signal}`,
        sanity.reason ?? undefined);
      summary.skipped++;
      continue;
    }

    const finalTp = sanity.correctedTp ?? techSignal.tp_rate;
    const finalSl = sanity.correctedSl ?? techSignal.sl_rate;

    // 相関ガード
    const corrGuard = await checkCorrelationGuard(
      db, pair, techSignal.signal, INSTRUMENTS);
    if (!corrGuard.allowed) {
      await insertSystemLog(db, 'WARN', 'RISK', `LOGIC 相関ガード: ${pair}`, corrGuard.reason);
      summary.skipped++;
      continue;
    }

    // ロット倍率（DD段階 × ティア × 連敗縮退）
    const ddLotMult  = ddResult.lotMultiplier;
    const tierMult   = instrument.tierLotMultiplier;

    // ── Ph.8: 連敗ロット縮退 ──
    let consecutiveLossMult = 1.0;
    if (params.consecutive_loss_shrink > 0) {
      const recentClosedRows = await db.prepare(
        `SELECT pnl, realized_rr FROM positions WHERE pair=? AND status='CLOSED' ORDER BY id DESC LIMIT ?`
      ).bind(pair, params.consecutive_loss_shrink).all<{pnl: number; realized_rr: number | null}>();
      const recentClosed = recentClosedRows.results ?? [];
      if (recentClosed.length >= params.consecutive_loss_shrink && recentClosed.every(r => (r.realized_rr ?? 0) < 1.0)) {
        consecutiveLossMult = 0.5;
      }
    }
    const requestedLot = 1 * ddLotMult * tierMult * consecutiveLossMult;

    if (requestedLot <= 0) {
      summary.skipped++;
      continue;
    }

    // decisions テーブルに記録
    const reasoning = `[LOGIC] ${techSignal.reason} score=${techSignal.scores?.total.toFixed(2) ?? '-'} [${techSignal.scores?.breakdown ?? ''}] RR=${actualRR.toFixed(2)}`;
    await insertDecision(db, {
      pair,
      rate: currentRate,
      decision: techSignal.signal,
      tp_rate: finalTp,
      sl_rate: finalSl,
      reasoning,
      news_summary: null,
      reddit_signal: null,
      vix: indicators.vix,
      us10y: indicators.us10y,
      nikkei: indicators.nikkei,
      sp500: indicators.sp500,
      created_at: now.toISOString(),
      news_sources: null,
      prompt_version: 'LOGIC_v1',
      strategy: techSignal.signal === 'BUY' ? 'mean_reversion' : 'mean_reversion',
      confidence: null,
    });

    // ポジション開設
    try {
      const broker = getBroker(instrument, brokerEnv);
      const isLive = broker.name === 'oanda';

      await openPosition(
        db,
        pair,
        techSignal.signal,
        currentRate,
        finalTp,
        finalSl,
        isLive ? 'oanda' : 'paper',
        null,
        undefined,
        {
          strategy: 'mean_reversion',
          trigger: 'LOGIC',
        },
      );

      logicNewEntries++;
      summary.entered++;
      openPairs.add(pair); // 同tick内の二重エントリー防止

      // trades_since_review インクリメント（AIレビュートリガー用: kelly-rl.md §3）
      await incrementTradesSinceReview(db, pair);

      await insertSystemLog(db, 'INFO', 'LOGIC',
        `LOGIC エントリー: ${pair} ${techSignal.signal} @ ${currentRate}`,
        `TP=${finalTp} SL=${finalSl} lot=${requestedLot.toFixed(2)} RSI=${techSignal.rsi?.toFixed(1)} ER=${techSignal.er?.toFixed(3)}`);

    } catch (e) {
      await insertSystemLog(db, 'WARN', 'LOGIC',
        `LOGIC ポジション開設失敗: ${pair}`,
        String(e).slice(0, 200));
      summary.skipped++;
    }
  }

  if (summary.entered > 0 || summary.signals.some(s => s.signal !== 'SKIP')) {
    const nonSkip = summary.signals.filter(s => s.signal !== 'SKIP').map(s => `${s.pair}:${s.signal}`);
    const skips = summary.signals.filter(s => s.signal === 'SKIP').map(s => `${s.pair}:${s.reason?.slice(0, 40) ?? '?'}`);
    await insertSystemLog(db, 'INFO', 'FLOW',
      `LOGIC完了: ${summary.entered}件エントリー / ${summary.skipped}件スキップ`,
      JSON.stringify({ signals: nonSkip, skips }));
  }

  return summary;
}

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
import { insertDecision, insertSystemLog } from './db';
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

// ─── 価格履歴取得（RSI/ATR計算用: 最大50件）──────────────────────────────

async function loadPriceHistory(
  db: D1Database,
  pairs: string[],
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (pairs.length === 0) return map;

  const placeholders = pairs.map(() => '?').join(',');
  // decisions テーブルの rate カラムを価格履歴として使用
  // 50件取得（RSI14安定化には最低30件必要: ts.md §1）
  const raw = await db
    .prepare(
      `SELECT pair, rate FROM decisions
       WHERE pair IN (${placeholders})
       ORDER BY id DESC LIMIT ${pairs.length * 50}`
    )
    .bind(...pairs)
    .all<{ pair: string; rate: number }>();

  const countMap = new Map<string, number>();
  for (const row of raw.results ?? []) {
    const cnt = countMap.get(row.pair) ?? 0;
    if (cnt < 50) {
      const arr = map.get(row.pair) ?? [];
      arr.push(row.rate);
      map.set(row.pair, arr);
      countMap.set(row.pair, cnt + 1);
    }
  }
  // 時系列を正順（最古→最新）に並び替え
  for (const [pair, rates] of map) {
    map.set(pair, rates.reverse());
  }
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

    if (techSignal.signal === 'NEUTRAL') {
      summary.skipped++;
      continue;
    }

    // ── Ph.6 拡張パラメーター適用 ── ─────────────────────────────────────

    // 1. min_signal_strength フィルタ（RSI偏差 + ER の複合強度チェック）
    if (techSignal.rsi != null && techSignal.er != null && params.min_signal_strength > 0) {
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

    // 2. strategy_primary フィルタ（trend_follow はER閾値を25%強化）
    if (params.strategy_primary === 'trend_follow' && techSignal.er != null) {
      const strictErThreshold = (params.adx_min / 60) * 1.25;
      if (techSignal.er < strictErThreshold) {
        summary.skipped++;
        summary.signals.push({ pair, signal: 'SKIP',
          reason: `trend_follow: ER=${techSignal.er.toFixed(3)}<${strictErThreshold.toFixed(3)}` });
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

    // ロット倍率（DD段階 × ティア）
    const ddLotMult  = ddResult.lotMultiplier;
    const tierMult   = instrument.tierLotMultiplier;
    const requestedLot = 1 * ddLotMult * tierMult;

    if (requestedLot <= 0) {
      summary.skipped++;
      continue;
    }

    // decisions テーブルに記録
    const reasoning = `[LOGIC] ${techSignal.reason}`;
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
    await insertSystemLog(db, 'INFO', 'FLOW',
      `LOGIC完了: ${summary.entered}件エントリー / ${summary.skipped}件スキップ`,
      JSON.stringify(summary.signals.filter(s => s.signal !== 'SKIP').map(s => `${s.pair}:${s.signal}`)));
  }

  return summary;
}

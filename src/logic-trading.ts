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
import { checkCorrelationGuard, getDrawdownLevel, updateHWM, getCurrentBalance, applyDrawdownControl, checkDailyLossCap } from './risk-manager';
import { openPosition } from './position';
import { insertDecision, insertSystemLog, insertIndicatorLog, getCacheValue, setCacheValue } from './db';
import { INSTRUMENTS, getDefaultParams, getYahooSymbol } from './instruments';
import type { MarketIndicators } from './indicators';
import { getBroker, type BrokerEnv } from './broker';
import { getActiveTempParams } from './news-trigger';
import { isNakaneWindow, getCurrentSession, getSessionLotMultiplier, getSessionInstrumentMultiplier } from './session';
import { getWeekendStatus } from './weekend';
import { fetchYahooCandles } from './candles';

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

  // ── 自動ブートストラップ: INSTRUMENTS にあるが instrument_params にない銘柄を自動登録 ──
  const missing = INSTRUMENTS.filter(inst => !map.has(inst.pair));
  for (const inst of missing) {
    const defaults = getDefaultParams(inst);
    const cols = Object.keys(defaults);
    const vals = Object.values(defaults);
    const placeholders = cols.map(() => '?').join(',');
    try {
      await db.prepare(
        `INSERT OR IGNORE INTO instrument_params (${cols.join(',')}) VALUES (${placeholders})`
      ).bind(...vals).run();
      // 再読み込みして map に追加
      const newRow = await db.prepare(
        `SELECT * FROM instrument_params WHERE pair = ?`
      ).bind(inst.pair).first<InstrumentParamsRow>();
      if (newRow) {
        map.set(inst.pair, newRow);
        console.log(`[logic] Auto-bootstrap: ${inst.pair} instrument_params 自動初期化`);
      }
    } catch (e) {
      console.warn(`[logic] Auto-bootstrap failed for ${inst.pair}:`, String(e).slice(0, 100));
    }
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

  // ── フォールバック: decisions履歴が不足する銘柄は自動補完 ──
  // Step 1: candle cache（H1）のclose列を試す
  // Step 2: キャッシュもなければ Yahoo Finance から H1 candle を直接取得
  const minRequired = 15; // RSI14 + 1
  const insufficientPairs = pairs.filter(p => (map.get(p)?.length ?? 0) < minRequired);
  if (insufficientPairs.length > 0) {
    const pairToCacheKey = new Map<string, string>();
    const pairToYahooSymbol = new Map<string, string>();
    for (const inst of INSTRUMENTS) {
      if (inst.stockSymbol) {
        pairToCacheKey.set(inst.pair, `candle_stock_${inst.stockSymbol}_H1`);
      } else if (inst.oandaSymbol) {
        pairToCacheKey.set(inst.pair, `candle_${inst.oandaSymbol}_H1`);
      }
      const ySym = getYahooSymbol(inst);
      if (ySym) pairToYahooSymbol.set(inst.pair, ySym);
    }

    const stillInsufficient: string[] = [];
    for (const pair of insufficientPairs) {
      const cacheKey = pairToCacheKey.get(pair);
      if (!cacheKey) { stillInsufficient.push(pair); continue; }
      try {
        const row = await db
          .prepare('SELECT value FROM market_cache WHERE key = ?')
          .bind(cacheKey)
          .first<{ value: string }>();
        if (row) {
          const cached = JSON.parse(row.value) as { candles?: Array<{ close: number }> };
          if (cached.candles && cached.candles.length >= minRequired) {
            map.set(pair, cached.candles.map(c => c.close));
            continue;
          }
        }
      } catch { /* ignore */ }
      stillInsufficient.push(pair);
    }

    // Step 2: Yahoo Finance H1 candle 直接取得（並列、最大5銘柄ずつ）
    if (stillInsufficient.length > 0) {
      const batch = stillInsufficient.slice(0, 5); // cron時間制約対策: 最大5銘柄
      const fetches = batch.map(async (pair) => {
        const sym = pairToYahooSymbol.get(pair);
        if (!sym) return;
        try {
          const candles = await fetchYahooCandles(sym, 'H1');
          if (candles.length >= minRequired) {
            map.set(pair, candles.map(c => c.close));
          }
        } catch { /* ignore */ }
      });
      await Promise.all(fetches);
    }
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

  // ── Weekend Phase ゲート: Phase 2/3/4 は新規エントリー完全禁止 ──
  const weekendStatus = getWeekendStatus(now);
  if (weekendStatus.phase >= 2 || weekendStatus.phase <= -2) {
    return summary; // Phase 2以降 or 月曜ウォームアップ観察期: Logic自体をスキップ
  }

  // ── セッション判定（全銘柄共通） ──
  const session = getCurrentSession(now);
  const sessionLotMult = getSessionLotMultiplier(session);
  if (sessionLotMult === 0) {
    return summary; // early_morning: 全銘柄取引禁止
  }

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

  // ── 日次損失上限チェック（HWM × 0.5%/日） ──
  const dailyCap = await checkDailyLossCap(db, now);
  if (dailyCap.capped) {
    await insertSystemLog(db, 'WARN', 'LOGIC',
      `Daily Loss Cap: 当日損失 ${dailyCap.dailyLoss.toFixed(2)}円 >= 上限 ${dailyCap.capAmount.toFixed(2)}円 — 全銘柄スキップ`);
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

    // ── Ph.8: SL後クールダウン（段階強化） ──
    // 1回目SL→10分、2回目→30分、3回目→60分、4回目以降→当日エントリー禁止
    if (params.cooldown_after_sl > 0) {
      // 当日（UTC 0:00〜）の同一銘柄SL回数を取得
      const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
      const slCountRow = await db.prepare(
        `SELECT COUNT(*) as cnt FROM positions WHERE pair=? AND close_reason='SL' AND status='CLOSED' AND closed_at >= ?`
      ).bind(pair, todayStart).first<{cnt: number}>();
      const todaySLCount = slCountRow?.cnt ?? 0;

      if (todaySLCount >= 4) {
        // 4回目以降: 当日エントリー禁止
        summary.skipped++;
        summary.signals.push({ pair, signal: 'SKIP', reason: `SL当日禁止(本日${todaySLCount}回SL)` });
        continue;
      }

      const lastSl = await db.prepare(
        `SELECT closed_at FROM positions WHERE pair=? AND close_reason='SL' AND status='CLOSED' ORDER BY id DESC LIMIT 1`
      ).bind(pair).first<{closed_at: string}>();
      if (lastSl) {
        const slTime = new Date(lastSl.closed_at).getTime();
        // 段階的クールダウン: 1回目10分、2回目30分、3回目60分
        const cooldownMinutes = todaySLCount <= 1 ? 10 : todaySLCount === 2 ? 30 : 60;
        const cooldownMs = cooldownMinutes * 60 * 1000;
        if (now.getTime() - slTime < cooldownMs) {
          summary.skipped++;
          summary.signals.push({ pair, signal: 'SKIP', reason: `SLクールダウン中(${cooldownMinutes}分, 本日${todaySLCount}回目)` });
          continue;
        }
      }
    }

    // ── 相関グループクールダウン（施策4拡張） ──
    // 同グループ内の他銘柄が直近30分以内にSLされた場合、この銘柄もクールダウン
    const group = instrument.correlationGroup;
    if (group !== 'standalone') {
      const groupPairs = INSTRUMENTS
        .filter(i => i.correlationGroup === group && i.pair !== pair)
        .map(i => i.pair);
      if (groupPairs.length > 0) {
        const placeholders = groupPairs.map(() => '?').join(',');
        const groupLastSl = await db.prepare(
          `SELECT pair, closed_at FROM positions
           WHERE pair IN (${placeholders}) AND close_reason='SL' AND status='CLOSED'
           ORDER BY id DESC LIMIT 1`
        ).bind(...groupPairs).first<{pair: string; closed_at: string}>();
        if (groupLastSl) {
          const groupSlTime = new Date(groupLastSl.closed_at).getTime();
          const groupCooldownMs = 30 * 60 * 1000; // 30分
          if (now.getTime() - groupSlTime < groupCooldownMs) {
            summary.skipped++;
            summary.signals.push({ pair, signal: 'SKIP', reason: `相関グループCD(${group}: ${groupLastSl.pair}がSL)` });
            continue;
          }
        }
      }
    }

    // ── Ph.8: 動的日次エントリー回数制限 ──
    // 直近5取引のavg_rrに応じてベースライン(daily_max_entries)を動的調整
    //   avg_rr ≥ 1.0 → ×2（最大10）
    //   avg_rr ≥ 0.5 → +2
    //   avg_rr < 0   → ×0.6（最低3）
    if (params.daily_max_entries > 0) {
      const recentRr = await db.prepare(
        `SELECT AVG(realized_rr) as avg_rr FROM (
          SELECT realized_rr FROM positions
          WHERE pair=? AND status='CLOSED' AND realized_rr IS NOT NULL
          ORDER BY id DESC LIMIT 5
        )`
      ).bind(pair).first<{avg_rr: number | null}>();
      const avgRr = recentRr?.avg_rr ?? 0;
      const base = params.daily_max_entries;
      let dynamicLimit = base;
      if (avgRr >= 1.0) {
        dynamicLimit = Math.min(base * 2, 10);
      } else if (avgRr >= 0.5) {
        dynamicLimit = Math.min(base + 2, 10);
      } else if (avgRr < 0) {
        dynamicLimit = Math.max(Math.round(base * 0.6), 3);
      }

      const todayEntries = await db.prepare(
        `SELECT COUNT(*) as cnt FROM positions WHERE pair=? AND entry_at > datetime('now','start of day')`
      ).bind(pair).first<{cnt: number}>();
      if (todayEntries && todayEntries.cnt >= dynamicLimit) {
        summary.skipped++;
        summary.signals.push({ pair, signal: 'SKIP', reason: `日次上限(${todayEntries.cnt}/${dynamicLimit})[avgRR=${avgRr.toFixed(2)}]` });
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

    // ── Ph.8: 連敗ロット縮退（銘柄別） ──
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

    // ── 全銘柄横断連敗カウンタ（P2: 銘柄変更による連敗リセット回避） ──
    // 全銘柄直近5件のSL率を見て追加縮退
    let globalLossMult = 1.0;
    {
      const globalRecent = await db.prepare(
        `SELECT close_reason FROM positions WHERE status='CLOSED' ORDER BY id DESC LIMIT 5`
      ).all<{close_reason: string | null}>();
      const globalRows = globalRecent.results ?? [];
      if (globalRows.length >= 5) {
        const slCount = globalRows.filter(r => r.close_reason === 'SL').length;
        if (slCount >= 4) globalLossMult = 0.3;       // 5件中4件以上SL → 0.3倍
        else if (slCount >= 3) globalLossMult = 0.5;   // 5件中3件SL → 0.5倍
      }
    }
    // 施策18: confidence乗数（0.7〜1.3倍）— スコアが高いほど大きいロット
    const confidenceScore = techSignal.scores?.total ?? null;
    const confidenceMult = confidenceScore != null
      ? 0.7 + Math.min(confidenceScore, 1.0) * 0.6
      : 1.0;
    // セッション×銘柄マトリクス乗数 + Weekend乗数
    const sessionInstrMult = getSessionInstrumentMultiplier(session, pair);
    const weekendEntryMult = weekendStatus.entryLotMultiplier;
    const requestedLot = 1 * ddLotMult * tierMult * consecutiveLossMult * globalLossMult * confidenceMult
                           * sessionLotMult * sessionInstrMult * weekendEntryMult;

    if (requestedLot <= 0) {
      summary.skipped++;
      continue;
    }

    // 施策19: 東京仲値ウィンドウ中は reasoning に付記（ドル買い実需増加の傾向）
    const nakaneNote = (isNakaneWindow(now) && pair === 'USD/JPY')
      ? ' [仲値ウィンドウ: ドル買い実需増]'
      : '';
    // decisions テーブルに記録
    const reasoning = `[LOGIC] ${techSignal.reason} score=${techSignal.scores?.total.toFixed(2) ?? '-'} [${techSignal.scores?.breakdown ?? ''}] RR=${actualRR.toFixed(2)}${nakaneNote}`;
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
      // 施策18: TechnicalSignal.scores.total を [0,1]→[0,100] に変換してconfidenceに記録
      confidence: confidenceScore != null
        ? Math.round(Math.min(confidenceScore, 1.0) * 100)
        : null,
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

  {
    // 日次上限・ER超過等のSKIP理由は常にログに記録（動的上限の動作確認用）
    const skipReasons = summary.signals
      .filter(s => s.signal === 'SKIP')
      .map(s => `${s.pair}:${s.reason ?? 'SKIP'}`)
      .slice(0, 8);
    await insertSystemLog(db, 'INFO', 'FLOW',
      `LOGIC完了: ${summary.entered}件エントリー / ${summary.skipped}件スキップ`,
      JSON.stringify([
        ...summary.signals.filter(s => s.signal !== 'SKIP').map(s => `${s.pair}:${s.signal}`),
        ...(skipReasons.length > 0 ? [`SKIP理由:${skipReasons.join(',')}`.slice(0, 300)] : []),
      ]));
  }

  // T07: 日次BUY+SELL件数モニタリング — 時刻比例チェック（T015修正）
  // 根本原因: 固定目標100件が一日中発火していた → 時刻経過率に応じた動的目標に変更
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const dailyRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM decisions
       WHERE decision IN ('BUY','SELL') AND created_at >= ?`
    )
    .bind(todayStart)
    .first<{ cnt: number }>();
  const dailySignals = dailyRow?.cnt ?? 0;

  // UTC 03:00（市場開始想定）からの経過割合で動的目標を計算
  const MARKET_START_HOUR = 3;
  const DAILY_TARGET = 100;
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const elapsedMinutes = Math.max(0, (utcHour - MARKET_START_HOUR) * 60 + utcMin);
  const elapsedRate = Math.min(1.0, elapsedMinutes / (21 * 60)); // 21h 営業想定
  const dynamicTarget = Math.floor(DAILY_TARGET * elapsedRate * 1.1); // 10% バッファ

  if (dynamicTarget >= 5 && dailySignals < dynamicTarget) {
    // 発火頻度制限: 15分に1回まで（market_cache で最終発火時刻を管理）
    const WARN_COOLDOWN_KEY = 'daily_count_warn_last_fired';
    const lastFiredRow = await db.prepare(
      "SELECT updated_at FROM market_cache WHERE key = ?"
    ).bind(WARN_COOLDOWN_KEY).first<{ updated_at: string }>();
    const lastFired = lastFiredRow ? new Date(lastFiredRow.updated_at).getTime() : 0;
    const cooldownMs = 15 * 60 * 1000; // 15分

    if (Date.now() - lastFired >= cooldownMs) {
      await insertSystemLog(db, 'WARN', 'MONITOR',
        `日次BUY+SELL件数不足: ${dailySignals}件 (現時点目標: ${dynamicTarget}件, 経過率${Math.round(elapsedRate * 100)}%)`,
        `todayStart=${todayStart}`);
      // 最終発火時刻を更新
      await db.prepare(
        "INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      ).bind(WARN_COOLDOWN_KEY, String(dailySignals)).run();
    }
  }

  return summary;
}

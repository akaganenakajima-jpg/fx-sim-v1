// ポジション管理（TP/SL チェック + ブローカー統合）
// 同時オープンポジションは銘柄ごとに最大1件

import { getOpenPositions, getOpenPositionByPair, closePosition, insertSystemLog, updateDecisionOutcome, getRecentTPOpposite } from './db';
import type { Position } from './db';
import type { InstrumentConfig } from './instruments';
import { getBroker, withFallback, type BrokerEnv } from './broker';
import { kellyFraction, logReturn } from './stats';
import { sendNotification, buildTpSlMessage, buildDrawdownMessage } from './notify';
import { updateThompsonParams } from './thompson';
import { logTradeJournal } from './trade-journal';
import { getCurrentBalance } from './risk-manager';

function calcPnl(
  direction: 'BUY' | 'SELL',
  entryRate: number,
  closeRate: number,
  pnlMultiplier: number
): number {
  return direction === 'BUY'
    ? (closeRate - entryRate) * pnlMultiplier
    : (entryRate - closeRate) * pnlMultiplier;
}

/** 実現RR計算: 実現利益 / 初期リスク（エントリー時SL距離）
 *  RR ≥ 1.0 = 勝ち（リスクと同等以上のリターン）
 *  RR < 1.0 = 負け */
export function calcRealizedRR(direction: string, entryRate: number, closeRate: number, slRate: number): number {
  if (direction === 'BUY') {
    const risk = entryRate - slRate;
    if (risk <= 0) {
      // トレイリングストップでSLがentry上方に移動済み → SL決済でも利益確定 → 勝ち(≥1.0)
      return 1.0;
    }
    return (closeRate - entryRate) / risk;
  } else {
    const risk = slRate - entryRate;
    if (risk <= 0) {
      // トレイリングストップでSLがentry下方に移動済み → SL決済でも利益確定 → 勝ち(≥1.0)
      return 1.0;
    }
    return (entryRate - closeRate) / risk;
  }
}

function shouldTriggerTP(pos: Position, currentRate: number): boolean {
  if (pos.tp_rate == null) return false;
  return pos.direction === 'BUY'
    ? currentRate >= pos.tp_rate
    : currentRate <= pos.tp_rate;
}

function shouldTriggerSL(pos: Position, currentRate: number): boolean {
  if (pos.sl_rate == null) return false;
  return pos.direction === 'BUY'
    ? currentRate <= pos.sl_rate
    : currentRate >= pos.sl_rate;
}

/** 全銘柄のオープンポジションを一括チェック（instrument map で PnL乗数を解決） */
export async function checkAndCloseAllPositions(
  db: D1Database,
  prices: Map<string, number | null>,
  instruments: InstrumentConfig[],
  brokerEnv?: BrokerEnv,
  webhookUrl?: string,
): Promise<void> {
  const positions = await getOpenPositions(db);
  const instrMap = new Map(instruments.map((i) => [i.pair, i]));

  for (const pos of positions) {
    const currentRate = prices.get(pos.pair);
    if (currentRate == null) continue;

    const instr = instrMap.get(pos.pair);
    if (!instr) {
      // 除外銘柄のポジション — 誤った pnlMultiplier で計算すると大事故になるためスキップ
      console.log(`[position] WARN: ${pos.pair} id=${pos.id} は有効銘柄リストに存在しない → TP/SLチェック スキップ`);
      continue;
    }
    const multiplier = instr.pnlMultiplier;

    // ── Ph.8: 最大保有時間チェック ──
    const paramRow = await db.prepare('SELECT max_hold_minutes FROM instrument_params WHERE pair=?').bind(pos.pair).first<{max_hold_minutes: number}>();
    const maxHold = paramRow?.max_hold_minutes ?? 480;
    if (maxHold > 0 && maxHold < 9999) {
      const entryTime = new Date(pos.entry_at).getTime();
      const holdMinutes = (Date.now() - entryTime) / 60000;
      if (holdMinutes > maxHold) {
        const pnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier);
        const lr = logReturn(pos.entry_rate, currentRate);
        const timeRealizedRR = pos.sl_rate != null ? calcRealizedRR(pos.direction, pos.entry_rate, currentRate, pos.sl_rate) : 0;
        console.log(`[position] TIME_STOP: ${pos.pair} id=${pos.id} held=${Math.round(holdMinutes)}min > ${maxHold}min pnl=${pnl.toFixed(2)}`);
        await closePosition(db, pos.id, currentRate, 'TIME_STOP', pnl, lr, timeRealizedRR);
        await insertSystemLog(db, 'INFO', 'POSITION',
          `時間切れ決済: ${pos.pair} ${pos.direction} ${Math.round(holdMinutes)}分保有 PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
          JSON.stringify({ id: pos.id, holdMinutes: Math.round(holdMinutes), maxHold, pnl }));
        continue;
      }
    }

    // トレイリングストップ: 含み益が activation 幅を超えたらSLを引き上げ
    if (instr && pos.sl_rate != null) {
      const activation = instr.trailingActivation;
      const distance = instr.trailingDistance;
      const isBuy = pos.direction === 'BUY';
      const profit = isBuy
        ? currentRate - pos.entry_rate
        : pos.entry_rate - currentRate;

      if (profit >= activation) {
        const newSl = isBuy
          ? currentRate - distance
          : currentRate + distance;
        // SLは利益方向にのみ移動（BUY: 上方向、SELL: 下方向）
        const shouldUpdate = isBuy
          ? newSl > pos.sl_rate
          : newSl < pos.sl_rate;

        if (shouldUpdate) {
          const oldSl = pos.sl_rate;
          await db.prepare('UPDATE positions SET sl_rate = ? WHERE id = ?').bind(newSl, pos.id).run();
          console.log(`[position] Trailing SL: ${pos.pair} id=${pos.id} SL ${oldSl.toFixed(4)} → ${newSl.toFixed(4)}`);
          await insertSystemLog(db, 'INFO', 'TRAILING',
            `トレイリングSL: ${pos.pair} ${oldSl.toFixed(4)} → ${newSl.toFixed(4)}`,
            JSON.stringify({ id: pos.id, direction: pos.direction, entry: pos.entry_rate, oldSl, newSl, currentRate }));
          pos.sl_rate = newSl; // 以降のSLチェックで新しいSLを使う

          // OANDA実弾: ブローカーのSLも更新
          if (pos.source === 'oanda' && pos.oanda_trade_id && instr && brokerEnv) {
            const broker = getBroker(instr, brokerEnv);
            if (broker.name === 'oanda') {
              await withFallback(broker, () => broker.updateStopLoss({
                positionId: pos.id,
                oandaTradeId: pos.oanda_trade_id,
                newSlRate: newSl,
              }), db, `trailing-sl ${pos.pair}`);
            }
          }
        }
      }
    }

    // テスタ施策10: 分割決済 — TP1(RR1:1地点)で決済 + 建値ストップ
    if (pos.sl_rate != null && !pos.tp1_hit && pos.lot > 0) {
      const slDist = Math.abs(pos.entry_rate - pos.sl_rate);
      const isBuy = pos.direction === 'BUY';
      const tp1Rate = isBuy ? pos.entry_rate + slDist : pos.entry_rate - slDist;
      const tp1Hit = isBuy ? currentRate >= tp1Rate : currentRate <= tp1Rate;

      if (tp1Hit && slDist > 0) {
        // Ph.8: tp1_ratio パラメーター化（デフォルト0.5）
        const tp1Params = await db.prepare(
          'SELECT tp1_ratio FROM instrument_params WHERE pair=?'
        ).bind(pos.pair).first<{tp1_ratio: number}>();
        const tp1Ratio = tp1Params?.tp1_ratio ?? 0.5;
        const halfLot = pos.lot * tp1Ratio;
        const partialPnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier) * tp1Ratio;
        console.log(`[position] TP1 hit: ${pos.pair} id=${pos.id} partial_close=${(tp1Ratio * 100).toFixed(0)}% pnl=${partialPnl.toFixed(2)}`);

        // tp1_ratio部分決済 + SLを建値に移動 + tp1_hit フラグ
        await db.prepare(
          `UPDATE positions SET lot = lot * ?, partial_closed_lot = COALESCE(partial_closed_lot, 0) + ?,
           sl_rate = entry_rate, tp1_hit = 1 WHERE id = ?`
        ).bind(1 - tp1Ratio, halfLot, pos.id).run();
        pos.lot = pos.lot * (1 - tp1Ratio);
        pos.sl_rate = pos.entry_rate;
        pos.tp1_hit = 1;

        await insertSystemLog(db, 'INFO', 'POSITION',
          `TP1分割決済: ${pos.pair} 50%決済 PnL+${partialPnl.toFixed(2)} SL→建値`,
          JSON.stringify({ id: pos.id, tp1Rate, currentRate, halfLot }));

        // OANDA実弾: 部分決済 + SL更新
        if (pos.source === 'oanda' && pos.oanda_trade_id && instr && brokerEnv) {
          const broker = getBroker(instr, brokerEnv);
          if (broker.name === 'oanda') {
            await withFallback(broker, () => broker.updateStopLoss({
              positionId: pos.id, oandaTradeId: pos.oanda_trade_id,
              newSlRate: pos.entry_rate,
            }), db, `tp1-sl ${pos.pair}`);
          }
        }
      }
    }

    if (shouldTriggerTP(pos, currentRate)) {
      const pnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier);
      const lr = logReturn(pos.entry_rate, currentRate);
      console.log(`[position] TP hit: ${pos.pair} id=${pos.id} pnl=${pnl.toFixed(2)}`);

      // OANDA実弾: ブローカー側もクローズ
      if (pos.source === 'oanda' && pos.oanda_trade_id && instr && brokerEnv) {
        const broker = getBroker(instr, brokerEnv);
        if (broker.name === 'oanda') {
          await withFallback(broker, () => broker.closePosition({
            positionId: pos.id, oandaTradeId: pos.oanda_trade_id,
            pair: pos.pair, closeRate: currentRate, reason: 'TP', pnl,
          }), db, `tp-close ${pos.pair}`);
        }
      }

      const tpRealizedRR = calcRealizedRR(pos.direction, pos.entry_rate, currentRate, pos.sl_rate!);
      await closePosition(db, pos.id, currentRate, 'TP', pnl, lr, tpRealizedRR);
      // TP 通知（currentRate はこの時点で number に絞り込まれている）
      await sendNotification(webhookUrl, buildTpSlMessage({
        pair: pos.pair,
        direction: pos.direction as 'BUY' | 'SELL',
        reason: 'TP',
        pnl,
        entryRate: pos.entry_rate,
        closeRate: currentRate,
      }));
      await updateDecisionOutcome(db, pos.pair, pos.direction, pos.entry_at, tpRealizedRR >= 1.0 ? 'WIN' : 'LOSE');
      // トンプソン・サンプリングパラメータ更新
      await updateThompsonParams(db, pos.pair, tpRealizedRR >= 1.0).catch(() => {});
      await insertSystemLog(db, 'INFO', 'POSITION',
        `TP決済: ${pos.pair} ${pos.direction} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
        JSON.stringify({ id: pos.id, entry: pos.entry_rate, close: currentRate, pnl }));
      // テスタ施策13: トレード日誌自動記録
      await logTradeJournal(db,
        { ...pos, close_rate: currentRate, pnl, closed_at: new Date().toISOString(), close_reason: 'TP' },
        { strategy: pos.strategy ?? undefined, regime: pos.regime ?? undefined, session: pos.session ?? undefined, confidence: pos.confidence ?? undefined },
      ).catch(() => {});
    } else if (shouldTriggerSL(pos, currentRate)) {
      const pnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier);
      const lr = logReturn(pos.entry_rate, currentRate);
      console.log(`[position] SL hit: ${pos.pair} id=${pos.id} pnl=${pnl.toFixed(2)}`);

      // OANDA実弾: ブローカー側もクローズ
      if (pos.source === 'oanda' && pos.oanda_trade_id && instr && brokerEnv) {
        const broker = getBroker(instr, brokerEnv);
        if (broker.name === 'oanda') {
          await withFallback(broker, () => broker.closePosition({
            positionId: pos.id, oandaTradeId: pos.oanda_trade_id,
            pair: pos.pair, closeRate: currentRate, reason: 'SL', pnl,
          }), db, `sl-close ${pos.pair}`);
        }
      }

      const slRealizedRR = calcRealizedRR(pos.direction, pos.entry_rate, currentRate, pos.sl_rate!);
      await closePosition(db, pos.id, currentRate, 'SL', pnl, lr, slRealizedRR);
      // SL 通知
      await sendNotification(webhookUrl, buildTpSlMessage({
        pair: pos.pair,
        direction: pos.direction as 'BUY' | 'SELL',
        reason: 'SL',
        pnl,
        entryRate: pos.entry_rate,
        closeRate: currentRate,
      }));
      await updateDecisionOutcome(db, pos.pair, pos.direction, pos.entry_at, slRealizedRR >= 1.0 ? 'WIN' : 'LOSE');
      // トンプソン・サンプリングパラメータ更新
      await updateThompsonParams(db, pos.pair, slRealizedRR >= 1.0).catch(() => {});
      await insertSystemLog(db, 'WARN', 'POSITION',
        `SL決済: ${pos.pair} ${pos.direction} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
        JSON.stringify({ id: pos.id, entry: pos.entry_rate, close: currentRate, pnl }));

      // テスタ施策13: トレード日誌自動記録
      await logTradeJournal(db,
        { ...pos, close_rate: currentRate, pnl, closed_at: new Date().toISOString(), close_reason: 'SL' },
        { strategy: pos.strategy ?? undefined, regime: pos.regime ?? undefined, session: pos.session ?? undefined, confidence: pos.confidence ?? undefined },
      ).catch(() => {});

      // ドローダウン検知: 直近3件がすべてSLなら警告
      try {
        const recent = await db.prepare(
          `SELECT close_reason FROM positions WHERE status = 'CLOSED' ORDER BY closed_at DESC LIMIT 3`
        ).all<{ close_reason: string }>();
        const reasons = (recent.results ?? []).map(r => r.close_reason);
        if (reasons.length >= 3 && reasons.every(r => r === 'SL')) {
          const totalSlPnl = await db.prepare(
            `SELECT COALESCE(SUM(pnl), 0) AS slLoss FROM positions WHERE status = 'CLOSED' AND close_reason = 'SL' ORDER BY closed_at DESC LIMIT 3`
          ).first<{ slLoss: number }>();
          await insertSystemLog(db, 'WARN', 'DRAWDOWN',
            `⚠️ 3連続SL損切 — 累計損失 ¥${Math.round(totalSlPnl?.slLoss ?? 0)}`);
          console.warn(`[position] ⚠️ DRAWDOWN: 3 consecutive SL hits`);
        }
      } catch {}
    }
  }
}

/** 直近の連続損失数を取得（全銘柄通算: 縮退判定用）
 *  最新クローズからrealized_rr<1.0が続く件数を返す（RR≥1.0勝率統一定義）
 */
export async function getConsecutiveLosses(db: D1Database): Promise<number> {
  const recent = await db
    .prepare(`SELECT pnl, realized_rr FROM positions WHERE status = 'CLOSED' ORDER BY closed_at DESC LIMIT 10`)
    .all<{ pnl: number; realized_rr: number | null }>();
  let streak = 0;
  for (const row of (recent.results ?? [])) {
    if ((row.realized_rr ?? 0) < 1.0) streak++;
    else break;
  }
  return streak;
}

/** 連敗縮退: 連続損失数からロット乗数を計算
 *  3連敗 → ×0.5, 5連敗 → ×0.25, 7連敗以上 → ×0（当日停止）
 */
export function drawdownLotMultiplier(consecutiveLosses: number): number {
  if (consecutiveLosses >= 7) return 0;   // 当日停止
  if (consecutiveLosses >= 5) return 0.25; // 75%削減
  if (consecutiveLosses >= 3) return 0.5;  // 50%削減
  return 1.0;
}

export async function openPosition(
  db: D1Database,
  pair: string,
  direction: 'BUY' | 'SELL',
  entryRate: number,
  tpRate: number | null,
  slRate: number | null,
  source: 'paper' | 'oanda' = 'paper',
  oandaTradeId: string | null = null,
  webhookUrl?: string,
  extra?: {
    strategy?: string | null;
    regime?: string | null;
    session?: string | null;
    confidence?: number | null;
    pnlMultiplier?: number;
    trigger?: string | null;  // 'RATE'=レート変動, 'SCHED'=定期30m, 'NEWS'=ニュース
  },
): Promise<void> {
  const existing = await getOpenPositionByPair(db, pair);
  if (existing) {
    console.log(`[position] Already has open position for ${pair}, skipping`);
    return;
  }

  // TP後クールダウン: 同銘柄の逆方向TPから60分以内は逆張りエントリー禁止
  const TP_COOLDOWN_MIN = 60;
  const recentTP = await getRecentTPOpposite(db, pair, direction, TP_COOLDOWN_MIN);
  if (recentTP) {
    const minAgo = Math.round((Date.now() - new Date(recentTP.closed_at).getTime()) / 60000);
    await insertSystemLog(db, 'INFO', 'COOLDOWN',
      `TP後クールダウン: ${pair} ${direction}エントリーをブロック (${minAgo}分前に逆${recentTP.direction}がTP)`,
      JSON.stringify({ pair, blockedDir: direction, tpId: recentTP.id, tpDir: recentTP.direction, minAgo, cooldownMin: TP_COOLDOWN_MIN }));
    console.log(`[position] TP-cooldown block: ${pair} ${direction} (${minAgo}min after ${recentTP.direction} TP)`);
    return;
  }

  // ポジションサイジング: ケリー基準（勝率 × RR比）
  // サンプル数20件以上で Kelly ゲートを適用:
  //   Kelly < 0   → 期待値マイナス銘柄 → エントリー停止
  //   Kelly < 0.1 → 最小ロット (0.1)
  //   Kelly ≥ 0.1 → Kelly 値をそのままロットに使用（上限 1.0）
  const perfRow = await db
    .prepare(`SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END), 0) as wins,
      COALESCE(AVG(CASE WHEN realized_rr >= 1.0 THEN pnl ELSE NULL END), 0) as avgWin,
      COALESCE(AVG(CASE WHEN realized_rr IS NULL OR realized_rr < 1.0 THEN ABS(pnl) ELSE NULL END), 1) as avgLoss
      FROM positions WHERE pair = ? AND status = 'CLOSED'`)
    .bind(pair)
    .first<{ total: number; wins: number; avgWin: number; avgLoss: number }>();
  let lot = 1.0;
  if (perfRow && perfRow.total >= 20) {
    const winRate = perfRow.wins / perfRow.total;
    const avgRR = perfRow.avgLoss > 0 ? perfRow.avgWin / perfRow.avgLoss : 0;
    const kelly = kellyFraction(winRate, avgRR);
    // Kelly ゲート: 負のKellyは期待値マイナス → 取引停止
    if (kelly < 0) {
      await insertSystemLog(db, 'WARN', 'KELLY',
        `Kelly負: ${pair} ${direction}エントリーをブロック (kelly=${kelly.toFixed(3)})`,
        JSON.stringify({ pair, kelly, winRate: winRate.toFixed(3), avgRR: avgRR.toFixed(3), total: perfRow.total }));
      console.warn(`[position] Kelly block: ${pair} kelly=${kelly.toFixed(3)} (wr=${(winRate*100).toFixed(0)}% rr=${avgRR.toFixed(2)}) n=${perfRow.total}`);
      return;
    }
    // Kelly 比例ロットサイジング: Kelly<0.1→最小, Kelly≥0.1→Kelly値（上限1.0）
    lot = kelly < 0.1 ? 0.1 : Math.min(kelly, 1.0);
    console.log(`[position] Kelly: ${pair} wr=${(winRate*100).toFixed(0)}% rr=${avgRR.toFixed(2)} f=${kelly.toFixed(3)} → lot=${lot.toFixed(2)}`);
  }

  // テスタ式: SL幅ベースポジションサイズ（複利 + RR傾斜配分）
  // ① 実残高ベースで複利効果を有効化（テスタ「利益は口座に残して複利で増やす」）
  // ② 銘柄RR実績で傾斜配分（テスタ「確信度に応じてサイズを変える」）
  if (slRate != null) {
    const slPips = Math.abs(entryRate - slRate);
    const multiplier = extra?.pnlMultiplier ?? 1;
    const riskPerLot = slPips * multiplier;
    const balance = await getCurrentBalance(db);

    // RR傾斜: 直近5取引のavg_rrで銘柄ごとにリスク率を調整
    const recentRr = await db.prepare(
      `SELECT AVG(realized_rr) as avg_rr FROM (
        SELECT realized_rr FROM positions
        WHERE pair=? AND status='CLOSED' AND realized_rr IS NOT NULL
        ORDER BY id DESC LIMIT 5
      )`
    ).bind(pair).first<{avg_rr: number | null}>();
    const avgRr = recentRr?.avg_rr ?? 0;
    let riskMultiplier = 1.0;
    if (avgRr >= 1.0) riskMultiplier = 1.5;       // 勝者: リスク拡大
    else if (avgRr >= 0.5) riskMultiplier = 1.25;  // 好調: やや拡大
    else if (avgRr < 0) riskMultiplier = 0.5;      // 不調: リスク半減

    const maxRisk = balance * 0.01 * riskMultiplier;
    if (riskPerLot > 0) {
      const slBasedLot = maxRisk / riskPerLot;
      if (slBasedLot < lot) {
        console.log(`[position] テスタ式lot: ${pair} kelly=${lot.toFixed(2)} sl_lot=${slBasedLot.toFixed(2)} bal=${balance.toFixed(0)} riskMult=${riskMultiplier} avgRR=${avgRr.toFixed(2)}`);
        lot = slBasedLot;
      }
    }
  }

  // 連敗縮退: 直近連続損失数に応じてロットを削減
  const consecutiveLosses = await getConsecutiveLosses(db);
  const ddMultiplier = drawdownLotMultiplier(consecutiveLosses);
  if (ddMultiplier === 0) {
    await insertSystemLog(db, 'WARN', 'DRAWDOWN',
      `7連敗縮退: ${pair} ${direction} 当日発注停止`,
      JSON.stringify({ consecutiveLosses, lot }));
    console.warn(`[position] 7連敗縮退: ${pair} 発注停止`);
    // 7連敗通知（return の直前）
    await sendNotification(webhookUrl, buildDrawdownMessage({
      consecutiveLosses, lotMultiplier: 0, pair,
    }));
    return;
  }
  if (ddMultiplier < 1.0) {
    const prevLot = lot;
    lot = Math.max(0.1, lot * ddMultiplier);
    console.log(`[position] 連敗縮退: ${consecutiveLosses}連敗 ×${ddMultiplier} lot ${prevLot.toFixed(1)} → ${lot.toFixed(1)}`);
    await insertSystemLog(db, 'INFO', 'DRAWDOWN',
      `連敗縮退 ${consecutiveLosses}連敗 → lot×${ddMultiplier}: ${pair}`);
    // 縮退通知
    await sendNotification(webhookUrl, buildDrawdownMessage({
      consecutiveLosses, lotMultiplier: ddMultiplier, pair,
    }));
  }

  await db
    .prepare(
      `INSERT INTO positions
         (pair, direction, entry_rate, tp_rate, sl_rate, lot, status, entry_at, source, oanda_trade_id,
          strategy, regime, session, confidence, original_lot, trigger)
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(pair, direction, entryRate, tpRate, slRate, lot, new Date().toISOString(), source, oandaTradeId,
      extra?.strategy ?? null, extra?.regime ?? null, extra?.session ?? null, extra?.confidence ?? null, lot,
      extra?.trigger ?? null)
    .run();

  console.log(`[position] Opened ${pair} ${direction} @ ${entryRate} TP=${tpRate} SL=${slRate} [${source}${oandaTradeId ? ` trade=${oandaTradeId}` : ''}]`);
}

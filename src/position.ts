// ポジション管理（TP/SL チェック + ブローカー統合）
// 同時オープンポジションは銘柄ごとに最大1件

import { getOpenPositions, getOpenPositionByPair, closePosition, insertSystemLog, updateDecisionOutcome } from './db';
import type { Position } from './db';
import type { InstrumentConfig } from './instruments';
import { getBroker, withFallback, type BrokerEnv } from './broker';
import { kellyFraction } from './stats';

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
  brokerEnv?: BrokerEnv
): Promise<void> {
  const positions = await getOpenPositions(db);
  const instrMap = new Map(instruments.map((i) => [i.pair, i]));

  for (const pos of positions) {
    const currentRate = prices.get(pos.pair);
    if (currentRate == null) continue;

    const instr = instrMap.get(pos.pair);
    const multiplier = instr?.pnlMultiplier ?? 100;

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

    if (shouldTriggerTP(pos, currentRate)) {
      const pnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier);
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

      await closePosition(db, pos.id, currentRate, 'TP', pnl);
      await updateDecisionOutcome(db, pos.pair, pos.direction, pos.entry_at, pnl > 0 ? 'WIN' : 'LOSE');
      await insertSystemLog(db, 'INFO', 'POSITION',
        `TP決済: ${pos.pair} ${pos.direction} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
        JSON.stringify({ id: pos.id, entry: pos.entry_rate, close: currentRate, pnl }));
    } else if (shouldTriggerSL(pos, currentRate)) {
      const pnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier);
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

      await closePosition(db, pos.id, currentRate, 'SL', pnl);
      await updateDecisionOutcome(db, pos.pair, pos.direction, pos.entry_at, pnl > 0 ? 'WIN' : 'LOSE');
      await insertSystemLog(db, 'WARN', 'POSITION',
        `SL決済: ${pos.pair} ${pos.direction} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
        JSON.stringify({ id: pos.id, entry: pos.entry_rate, close: currentRate, pnl }));

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
            `⚠️ 3連続SL損切 — 累計損失 ¥${Math.round(totalSlPnl?.slLoss ?? 0)}`,
            null);
          console.warn(`[position] ⚠️ DRAWDOWN: 3 consecutive SL hits`);
        }
      } catch {}
    }
  }
}

export async function openPosition(
  db: D1Database,
  pair: string,
  direction: 'BUY' | 'SELL',
  entryRate: number,
  tpRate: number | null,
  slRate: number | null,
  source: 'paper' | 'oanda' = 'paper',
  oandaTradeId: string | null = null
): Promise<void> {
  const existing = await getOpenPositionByPair(db, pair);
  if (existing) {
    console.log(`[position] Already has open position for ${pair}, skipping`);
    return;
  }

  // ポジションサイジング: ケリー基準（勝率 × RR比）
  const perfRow = await db
    .prepare(`SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) as wins,
      COALESCE(AVG(CASE WHEN pnl > 0 THEN pnl ELSE NULL END), 0) as avgWin,
      COALESCE(AVG(CASE WHEN pnl <= 0 THEN ABS(pnl) ELSE NULL END), 1) as avgLoss
      FROM positions WHERE pair = ? AND status = 'CLOSED'`)
    .bind(pair)
    .first<{ total: number; wins: number; avgWin: number; avgLoss: number }>();
  let lot = 1.0;
  if (perfRow && perfRow.total >= 5) {
    const winRate = perfRow.wins / perfRow.total;
    const avgRR = perfRow.avgLoss > 0 ? perfRow.avgWin / perfRow.avgLoss : 0;
    const kelly = kellyFraction(winRate, avgRR);
    // kelly 0〜0.25 → lot 0.5〜2.0
    lot = Math.max(0.5, Math.min(0.5 + kelly * 6, 2.0));
    console.log(`[position] Kelly: ${pair} wr=${(winRate*100).toFixed(0)}% rr=${avgRR.toFixed(2)} f=${kelly.toFixed(3)} → lot=${lot.toFixed(1)}`);
  }

  await db
    .prepare(
      `INSERT INTO positions
         (pair, direction, entry_rate, tp_rate, sl_rate, lot, status, entry_at, source, oanda_trade_id)
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`
    )
    .bind(pair, direction, entryRate, tpRate, slRate, lot, new Date().toISOString(), source, oandaTradeId)
    .run();

  console.log(`[position] Opened ${pair} ${direction} @ ${entryRate} TP=${tpRate} SL=${slRate} [${source}${oandaTradeId ? ` trade=${oandaTradeId}` : ''}]`);
}

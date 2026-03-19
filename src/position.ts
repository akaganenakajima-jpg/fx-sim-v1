// 仮想ポジション管理（TP/SL チェック）
// 同時オープンポジションは銘柄ごとに最大1件

import { getOpenPositions, getOpenPositionByPair, closePosition, insertSystemLog } from './db';
import type { Position } from './db';
import type { InstrumentConfig } from './instruments';

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
  instruments: InstrumentConfig[]
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
          await db.prepare('UPDATE positions SET sl_rate = ? WHERE id = ?').bind(newSl, pos.id).run();
          console.log(`[position] Trailing SL: ${pos.pair} id=${pos.id} SL ${pos.sl_rate.toFixed(4)} → ${newSl.toFixed(4)}`);
          pos.sl_rate = newSl; // 以降のSLチェックで新しいSLを使う
        }
      }
    }

    if (shouldTriggerTP(pos, currentRate)) {
      const pnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier);
      console.log(`[position] TP hit: ${pos.pair} id=${pos.id} pnl=${pnl.toFixed(2)}`);
      await closePosition(db, pos.id, currentRate, 'TP', pnl);
      await insertSystemLog(db, 'INFO', 'POSITION',
        `TP決済: ${pos.pair} ${pos.direction} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
        JSON.stringify({ id: pos.id, entry: pos.entry_rate, close: currentRate, pnl }));
    } else if (shouldTriggerSL(pos, currentRate)) {
      const pnl = calcPnl(pos.direction, pos.entry_rate, currentRate, multiplier);
      console.log(`[position] SL hit: ${pos.pair} id=${pos.id} pnl=${pnl.toFixed(2)}`);
      await closePosition(db, pos.id, currentRate, 'SL', pnl);
      await insertSystemLog(db, 'WARN', 'POSITION',
        `SL決済: ${pos.pair} ${pos.direction} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
        JSON.stringify({ id: pos.id, entry: pos.entry_rate, close: currentRate, pnl }));
    }
  }
}

export async function openPosition(
  db: D1Database,
  pair: string,
  direction: 'BUY' | 'SELL',
  entryRate: number,
  tpRate: number | null,
  slRate: number | null
): Promise<void> {
  const existing = await getOpenPositionByPair(db, pair);
  if (existing) {
    console.log(`[position] Already has open position for ${pair}, skipping`);
    return;
  }

  // ポジションサイジング: 銘柄別勝率に応じてlot調整
  const perfRow = await db
    .prepare(`SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) as wins FROM positions WHERE pair = ? AND status = 'CLOSED'`)
    .bind(pair)
    .first<{ total: number; wins: number }>();
  let lot = 1.0;
  if (perfRow && perfRow.total >= 3) {
    const winRate = perfRow.wins / perfRow.total;
    if (winRate >= 0.7) lot = 2.0;       // 勝率70%以上: 2倍
    else if (winRate >= 0.5) lot = 1.5;   // 勝率50%以上: 1.5倍
    else if (winRate < 0.3) lot = 0.5;    // 勝率30%未満: 半分
    console.log(`[position] Sizing: ${pair} winRate=${(winRate*100).toFixed(0)}% → lot=${lot}`);
  }

  await db
    .prepare(
      `INSERT INTO positions
         (pair, direction, entry_rate, tp_rate, sl_rate, lot, status, entry_at)
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)`
    )
    .bind(pair, direction, entryRate, tpRate, slRate, lot, new Date().toISOString())
    .run();

  console.log(`[position] Opened ${pair} ${direction} @ ${entryRate} TP=${tpRate} SL=${slRate}`);
}

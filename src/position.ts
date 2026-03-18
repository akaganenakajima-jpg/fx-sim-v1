// 仮想ポジション管理（TP/SL チェック）
// 同時オープンポジションは最大1件に制限
// pnl計算:
//   BUY  → (close_rate - entry_rate) * 100（pip）
//   SELL → (entry_rate - close_rate) * 100（pip）

import { getOpenPositions, closePosition } from './db';
import type { Position } from './db';

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

export async function checkAndClosePositions(
  db: D1Database,
  currentRate: number
): Promise<void> {
  const positions = await getOpenPositions(db);

  for (const pos of positions) {
    if (shouldTriggerTP(pos, currentRate)) {
      console.log(`[position] TP hit: id=${pos.id} rate=${currentRate}`);
      await closePosition(db, pos.id, currentRate, 'TP');
    } else if (shouldTriggerSL(pos, currentRate)) {
      console.log(`[position] SL hit: id=${pos.id} rate=${currentRate}`);
      await closePosition(db, pos.id, currentRate, 'SL');
    }
  }
}

export async function openPosition(
  db: D1Database,
  direction: 'BUY' | 'SELL',
  entryRate: number,
  tpRate: number | null,
  slRate: number | null
): Promise<void> {
  // 既存オープンポジション確認（最大1件制限）
  const existing = await getOpenPositions(db);
  if (existing.length > 0) {
    console.log('[position] Already has open position, skipping openPosition');
    return;
  }

  await db
    .prepare(
      `INSERT INTO positions
         (pair, direction, entry_rate, tp_rate, sl_rate, lot, status, entry_at)
       VALUES ('USD/JPY', ?, ?, ?, ?, 1.0, 'OPEN', ?)`
    )
    .bind(direction, entryRate, tpRate, slRate, new Date().toISOString())
    .run();

  console.log(
    `[position] Opened ${direction} @ ${entryRate} TP=${tpRate} SL=${slRate}`
  );
}

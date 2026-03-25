/**
 * 週末ウィンドダウン（フェードアウト）モジュール
 *
 * FX市場: 月曜早朝（UTC日曜22:00）〜 金曜NYクローズ（UTC金曜21:00）
 *
 * 金曜日のフェードアウト戦略:
 *   Phase 0 (〜UTC 06:00):  通常運転
 *   Phase 1 (UTC 06:00-12:00): ロット50%、TP縮小（ATR×0.7）
 *   Phase 2 (UTC 12:00-19:00): 新規禁止、含み益SL→建値以上に引き上げ
 *   Phase 3 (UTC 19:00-21:00): 残ポジション強制決済
 *   Phase 4 (UTC 21:00〜日曜22:00): 全停止（市場クローズ）
 *
 * 月曜ウォームアップ（ランプアップ）:
 *   Phase -2 (日曜 22:00-23:00 UTC): 観察のみ（HOLD強制、TP/SLチェックのみ）
 *   Phase -1 (日曜 23:00 〜 月曜 03:00 UTC): ロット30%で様子見エントリー
 *   Phase 0  (月曜 03:00〜):  通常運転
 *
 * ロジック:
 *   - 勝っているポジション → TP到達で自然利確を待つ（Phase 2でTP縮小済み）
 *   - 含み損ポジション → Phase 2でSLを通常通り管理、Phase 3で最終決済
 *   - 新規エントリー → Phase 1でロット半減、Phase 2以降は完全禁止
 */

import { getOpenPositions, closePosition, insertSystemLog } from './db';
import { calcRealizedRR } from './position';
import { logReturn } from './stats';
import type { InstrumentConfig } from './instruments';

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export type WeekendPhase = -2 | -1 | 0 | 1 | 2 | 3 | 4;

export interface WeekendStatus {
  /** 現在のフェーズ (0-4) */
  phase: WeekendPhase;
  /** 人間が読めるラベル */
  label: string;
  /** 新規エントリー用のロット乗数 (0 = 禁止) */
  entryLotMultiplier: number;
  /** TP縮小率 (1.0 = 通常、0.7 = 30%縮小) */
  tpShrinkFactor: number;
  /** 市場が完全に閉まっているか */
  marketClosed: boolean;
  /** 残り時間の目安（分）— 次のフェーズまで */
  minutesToNextPhase: number;
}

// ---------------------------------------------------------------------------
// フェーズ判定
// ---------------------------------------------------------------------------

/**
 * 現在の週末ウィンドダウンフェーズを判定
 *
 * FX市場の営業時間（UTC基準）:
 *   月曜: 日曜 22:00 UTC にオープン（シドニー）
 *   金曜: 金曜 21:00 UTC にクローズ（NYクローズ）
 *
 * 金曜フェードアウト:
 *   Phase 0: 金曜 00:00-06:00 UTC → 通常
 *   Phase 1: 金曜 06:00-12:00 UTC → ロット半減・TP縮小
 *   Phase 2: 金曜 12:00-19:00 UTC → 新規禁止・利益ロック
 *   Phase 3: 金曜 19:00-21:00 UTC → 残ポジション強制決済
 *   Phase 4: 金曜 21:00 〜 日曜 22:00 UTC → 市場クローズ
 */
export function getWeekendStatus(now: Date): WeekendStatus {
  const day = now.getUTCDay();   // 0=Sun, 5=Fri, 6=Sat
  const hour = now.getUTCHours();
  const min = now.getUTCMinutes();
  const totalMin = hour * 60 + min;

  // 土曜: 完全クローズ
  if (day === 6) {
    return {
      phase: 4, label: '市場クローズ（土曜）', entryLotMultiplier: 0,
      tpShrinkFactor: 1.0, marketClosed: true,
      minutesToNextPhase: (24 - hour) * 60 - min + 22 * 60, // 日曜22:00まで
    };
  }

  // 日曜: 22:00 UTCまでクローズ、以降は通常
  if (day === 0) {
    if (totalMin < 22 * 60) {
      return {
        phase: 4, label: '市場クローズ（日曜）', entryLotMultiplier: 0,
        tpShrinkFactor: 1.0, marketClosed: true,
        minutesToNextPhase: 22 * 60 - totalMin,
      };
    }
    // 日曜22:00-23:00 = ウォームアップ Phase -2（観察のみ）
    if (totalMin < 23 * 60) {
      return {
        phase: -2, label: '月曜ウォームアップ（観察のみ）', entryLotMultiplier: 0,
        tpShrinkFactor: 1.0, marketClosed: false,
        minutesToNextPhase: 23 * 60 - totalMin,
      };
    }
    // 日曜23:00-24:00 = ウォームアップ Phase -1（ロット30%）
    return {
      phase: -1, label: '月曜ウォームアップ（ロット30%）', entryLotMultiplier: 0.3,
      tpShrinkFactor: 1.0, marketClosed: false,
      minutesToNextPhase: 24 * 60 - totalMin,
    };
  }

  // 月曜
  if (day === 1) {
    // 月曜 00:00-03:00 UTC = ウォームアップ Phase -1（ロット30%）
    if (totalMin < 3 * 60) {
      return {
        phase: -1, label: '月曜ウォームアップ（ロット30%）', entryLotMultiplier: 0.3,
        tpShrinkFactor: 1.0, marketClosed: false,
        minutesToNextPhase: 3 * 60 - totalMin,
      };
    }
    // 月曜 03:00以降 = 通常運転
    return {
      phase: 0, label: '通常運転（月曜）', entryLotMultiplier: 1.0,
      tpShrinkFactor: 1.0, marketClosed: false,
      minutesToNextPhase: 9999,
    };
  }

  // 火〜木: 通常運転
  if (day >= 2 && day <= 4) {
    return {
      phase: 0, label: '通常運転', entryLotMultiplier: 1.0,
      tpShrinkFactor: 1.0, marketClosed: false,
      minutesToNextPhase: 9999,
    };
  }

  // 金曜日: フェードアウト
  if (day === 5) {
    // Phase 3: 19:00-21:00 UTC — 強制決済
    if (totalMin >= 19 * 60 && totalMin < 21 * 60) {
      return {
        phase: 3, label: '週末クローズ（強制決済）', entryLotMultiplier: 0,
        tpShrinkFactor: 0.5, marketClosed: false,
        minutesToNextPhase: 21 * 60 - totalMin,
      };
    }
    // Phase 4: 21:00以降 — 市場クローズ
    if (totalMin >= 21 * 60) {
      return {
        phase: 4, label: '市場クローズ（金曜NYクローズ後）', entryLotMultiplier: 0,
        tpShrinkFactor: 1.0, marketClosed: true,
        minutesToNextPhase: (24 - hour) * 60 - min + 46 * 60, // 日曜22:00まで
      };
    }
    // Phase 2: 12:00-19:00 UTC — 新規禁止・利益ロック
    if (totalMin >= 12 * 60) {
      return {
        phase: 2, label: '週末準備（新規禁止・利益ロック）', entryLotMultiplier: 0,
        tpShrinkFactor: 0.7, marketClosed: false,
        minutesToNextPhase: 19 * 60 - totalMin,
      };
    }
    // Phase 1: 06:00-12:00 UTC — ロット半減
    if (totalMin >= 6 * 60) {
      return {
        phase: 1, label: '週末フェードアウト（ロット半減）', entryLotMultiplier: 0.5,
        tpShrinkFactor: 0.85, marketClosed: false,
        minutesToNextPhase: 12 * 60 - totalMin,
      };
    }
    // Phase 0: 00:00-06:00 UTC — 通常
    return {
      phase: 0, label: '金曜通常（フェードアウト前）', entryLotMultiplier: 1.0,
      tpShrinkFactor: 1.0, marketClosed: false,
      minutesToNextPhase: 6 * 60 - totalMin,
    };
  }

  // fallback
  return {
    phase: 0, label: '通常運転', entryLotMultiplier: 1.0,
    tpShrinkFactor: 1.0, marketClosed: false,
    minutesToNextPhase: 9999,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: 含み益ポジションのSLを利益ロック方向に引き上げ
// ---------------------------------------------------------------------------

/**
 * 含み益ポジションのSLを建値以上に引き上げる（利益ロック）
 *
 * BUY: SLを entry_rate + (含み益 × lockRatio) に移動
 * SELL: SLを entry_rate - (含み益 × lockRatio) に移動
 *
 * lockRatio: 含み益の何%を確保するか（0.3 = 30%利益確保）
 */
export async function lockProfitsForWeekend(
  db: D1Database,
  prices: Map<string, number | null>,
  _instruments: InstrumentConfig[],
  lockRatio: number = 0.3,
): Promise<number> {
  const positions = await getOpenPositions(db);
  let lockedCount = 0;

  for (const pos of positions) {
    const currentRate = prices.get(pos.pair);
    if (currentRate == null || pos.sl_rate == null) continue;

    const isBuy = pos.direction === 'BUY';
    const profit = isBuy
      ? currentRate - pos.entry_rate
      : pos.entry_rate - currentRate;

    // 含み益がないポジションはスキップ
    if (profit <= 0) continue;

    // ロックSL: 建値 + 含み益の lockRatio 分を確保
    const lockAmount = profit * lockRatio;
    const newSl = isBuy
      ? pos.entry_rate + lockAmount
      : pos.entry_rate - lockAmount;

    // 現在のSLより有利な場合のみ更新
    const shouldUpdate = isBuy
      ? newSl > pos.sl_rate
      : newSl < pos.sl_rate;

    if (shouldUpdate) {
      await db.prepare('UPDATE positions SET sl_rate = ? WHERE id = ?')
        .bind(newSl, pos.id).run();
      lockedCount++;

      console.log(`[weekend] 利益ロック: ${pos.pair} id=${pos.id} SL ${pos.sl_rate.toFixed(4)} → ${newSl.toFixed(4)} (profit=${profit.toFixed(4)})`);
      await insertSystemLog(db, 'INFO', 'WEEKEND',
        `利益ロック: ${pos.pair} SL→${newSl.toFixed(4)}`,
        JSON.stringify({ id: pos.id, direction: pos.direction, profit, lockRatio, oldSl: pos.sl_rate, newSl }));
    }
  }

  return lockedCount;
}

// ---------------------------------------------------------------------------
// Phase 3: 残ポジション強制決済
// ---------------------------------------------------------------------------

/**
 * 全オープンポジションを強制決済する
 * close_reason = 'WEEKEND' で記録
 */
export async function forceCloseAllForWeekend(
  db: D1Database,
  prices: Map<string, number | null>,
  instruments: InstrumentConfig[],
): Promise<number> {
  const positions = await getOpenPositions(db);
  const instrMap = new Map(instruments.map(i => [i.pair, i]));
  let closedCount = 0;

  for (const pos of positions) {
    const currentRate = prices.get(pos.pair);
    if (currentRate == null) continue;

    const instr = instrMap.get(pos.pair);
    const multiplier = instr?.pnlMultiplier ?? 100;

    const pnl = pos.direction === 'BUY'
      ? (currentRate - pos.entry_rate) * multiplier
      : (pos.entry_rate - currentRate) * multiplier;

    // realized_rr計算（Bロジック: 値幅ベース・方向補正・ABS分母・original_sl_rate優先）
    const slRef = pos.original_sl_rate ?? pos.sl_rate;
    const realizedRR = slRef != null ? calcRealizedRR(pos.direction, pos.entry_rate, currentRate, slRef) : null;
    const lr = logReturn(pos.entry_rate, currentRate);

    await closePosition(db, pos.id, currentRate, 'WEEKEND', pnl, lr, realizedRR ?? undefined);

    closedCount++;
    console.log(`[weekend] 週末強制決済: ${pos.pair} id=${pos.id} ${pos.direction} pnl=${pnl.toFixed(2)}`);
    await insertSystemLog(db, 'INFO', 'WEEKEND',
      `週末決済: ${pos.pair} ${pos.direction} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
      JSON.stringify({ id: pos.id, entry: pos.entry_rate, close: currentRate, pnl }));
  }

  return closedCount;
}

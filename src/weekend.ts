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

import { getOpenPositions, insertSystemLog, getCacheValue, setCacheValue } from './db';
import { INSTRUMENTS, type InstrumentConfig } from './instruments';
import { logReturn } from './stats';
import { calcRealizedRR } from './position';

// ---------------------------------------------------------------------------
// 週末制約定数（Single Source of Truth）
// ---------------------------------------------------------------------------

/**
 * 週末市場クローズ中でも取引可能な銘柄リスト（配列）。
 *
 * ⚠️ 設計制約（IPA §横断的関心事 / CLAUDE.md §週末市場クローズ制約）:
 *   - この定数はプロジェクト全体で唯一の定義。他ファイルで独自定義しないこと
 *   - FX・株指数は週末クローズのためエントリー禁止
 *   - 暗号資産は24時間365日取引可能なため除外対象外
 *   - O(1) 検索が必要な場合は CRYPTO_PAIRS_SET を使用すること
 */
export const CRYPTO_PAIRS: string[] = ['BTC/USD', 'ETH/USD', 'SOL/USD'];

/** O(1) 検索用 Set（CRYPTO_PAIRS の派生）— 直接 import して使用可 */
export const CRYPTO_PAIRS_SET = new Set<string>(CRYPTO_PAIRS);

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

    // log_return と realized_rr を計算（EWMA Vol / 統計分析の母集団に含めるため）
    const lr = logReturn(pos.entry_rate, currentRate);
    const realizedRR = pos.sl_rate != null
      ? calcRealizedRR(pos.direction as 'BUY' | 'SELL', pos.entry_rate, currentRate, pos.sl_rate)
      : undefined;

    // D1で直接CLOSEする（ブローカー側は別途対応）
    await db.prepare(
      `UPDATE positions SET status = 'CLOSED', close_rate = ?, pnl = ?,
       closed_at = ?, close_reason = 'WEEKEND', log_return = ?, realized_rr = ? WHERE id = ?`
    ).bind(currentRate, pnl, new Date().toISOString(), lr, realizedRR ?? null, pos.id).run();

    closedCount++;
    console.log(`[weekend] 週末強制決済: ${pos.pair} id=${pos.id} ${pos.direction} pnl=${pnl.toFixed(2)}`);
    await insertSystemLog(db, 'INFO', 'WEEKEND',
      `週末決済: ${pos.pair} ${pos.direction} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
      JSON.stringify({ id: pos.id, entry: pos.entry_rate, close: currentRate, pnl }));
  }

  return closedCount;
}

// ---------------------------------------------------------------------------
// 施策A: 週末ニュースダイジェスト生成
// ---------------------------------------------------------------------------

export interface WeekendNewsItem {
  title: string;
  title_ja: string | null;
  source: string;
  pub_date: string | null;
  composite_score: number | null;
}

/**
 * 週末（Phase 4）中に news_raw に蓄積されたフィルタ済みニュースを取得
 * @param hoursBack Phase 4 の期間（金曜21:00〜日曜22:00 ≒ 49時間、余裕を持って50）
 */
export async function getWeekendNewsDigest(
  db: D1Database,
  hoursBack: number = 50,
): Promise<WeekendNewsItem[]> {
  const rows = await db
    .prepare(
      `SELECT title, title_ja, source, pub_date, composite_score
       FROM news_raw
       WHERE fetched_at >= datetime('now', '-' || ? || ' hours')
         AND filter_accepted = 1
       ORDER BY composite_score DESC, fetched_at DESC
       LIMIT 100`
    )
    .bind(hoursBack)
    .all();
  return (rows.results ?? []) as unknown as WeekendNewsItem[];
}

// ---------------------------------------------------------------------------
// 施策C: 金曜終値保存 + ギャップ検知
// ---------------------------------------------------------------------------

export interface GapSignal {
  pair: string;
  fridayClose: number;
  mondayOpen: number;
  gapPercent: number;
  gapDirection: 'UP' | 'DOWN';
  magnitude: 'SMALL' | 'MEDIUM' | 'LARGE';
}

const FRIDAY_CLOSE_KEY = 'friday_close_prices';

/**
 * 金曜終値を market_cache に保存（Phase 2 末期、18:55 UTC 頃に呼び出す）
 */
export async function saveFridayClosePrices(
  db: D1Database,
  prices: Map<string, number | null>,
): Promise<number> {
  const snapshot: Record<string, number> = {};
  let count = 0;
  for (const [pair, rate] of prices) {
    if (rate != null) {
      snapshot[pair] = rate;
      count++;
    }
  }
  await setCacheValue(db, FRIDAY_CLOSE_KEY, JSON.stringify({
    savedAt: new Date().toISOString(),
    prices: snapshot,
  }));
  return count;
}

/**
 * 月曜始値と金曜終値を比較し、ギャップを検知
 * Phase -2 の最初の cron で呼び出す
 */
export async function detectGaps(
  db: D1Database,
  currentPrices: Map<string, number | null>,
): Promise<GapSignal[]> {
  const raw = await getCacheValue(db, FRIDAY_CLOSE_KEY);
  if (!raw) return [];

  let fridayPrices: Record<string, number>;
  try {
    fridayPrices = JSON.parse(raw).prices;
  } catch { return []; }

  const gaps: GapSignal[] = [];
  for (const inst of INSTRUMENTS) {
    const fridayClose = fridayPrices[inst.pair];
    const mondayOpen = currentPrices.get(inst.pair);
    if (fridayClose == null || mondayOpen == null) continue;

    const gapPercent = ((mondayOpen - fridayClose) / fridayClose) * 100;
    const absGap = Math.abs(gapPercent);

    // アセットクラス別閾値
    const isStock = !!(inst as any).tradingHoursJST || !!(inst as any).tradingHoursET;
    const isCommodity = ['Gold', 'Silver', 'CrudeOil', 'NatGas', 'Copper'].includes(inst.pair);
    const threshold = isStock ? 0.5 : isCommodity ? 0.3 : 0.15;

    if (absGap >= threshold) {
      gaps.push({
        pair: inst.pair,
        fridayClose,
        mondayOpen,
        gapPercent: Math.round(gapPercent * 1000) / 1000,
        gapDirection: gapPercent > 0 ? 'UP' : 'DOWN',
        magnitude: absGap >= threshold * 3 ? 'LARGE'
          : absGap >= threshold * 1.5 ? 'MEDIUM'
          : 'SMALL',
      });
    }
  }

  gaps.sort((a, b) => Math.abs(b.gapPercent) - Math.abs(a.gapPercent));
  return gaps;
}

// ---------------------------------------------------------------------------
// 共通: フラグリセット
// ---------------------------------------------------------------------------

const WEEKEND_FLAG_KEYS = [
  'weekend_digest_done',
  'premarket_analysis_done',
  'friday_close_saved',
  'gap_detection_done',
];

/**
 * 月曜 Phase 0 移行時に全週末フラグをリセット
 */
export async function resetWeekendFlags(db: D1Database): Promise<void> {
  for (const key of WEEKEND_FLAG_KEYS) {
    await setCacheValue(db, key, '');
  }
}

// ---------------------------------------------------------------------------
// 取引可能銘柄フィルタ（Single Source of Truth）
// ---------------------------------------------------------------------------

/**
 * 週末クローズ状態に応じて取引可能な銘柄リストを返す。
 *
 * ⚠️ 設計制約（IPA §横断的関心事 / CLAUDE.md §週末市場クローズ制約）:
 *   取引判断を行う関数（runPathB, runLogicDecisions 等）は
 *   直接 INSTRUMENTS をループせず、必ずこの関数を経由すること。
 *   こうすることで「週末制限ロジックの変更が1箇所で完結する」状態を維持する。
 *
 * @param instruments 全銘柄リスト（通常は INSTRUMENTS を渡す）
 * @param weekendStatus getWeekendStatus() の戻り値
 * @returns 現在取引可能な銘柄リスト
 *
 * @example
 *   const tradeable = getTradeableInstruments(INSTRUMENTS, weekendStatus);
 *   // 週末クローズ中 → [BTC/USD, ETH/USD, SOL/USD] のみ
 *   // 平日 → 全銘柄
 */
export function getTradeableInstruments<T extends { pair: string }>(
  instruments: T[],
  weekendStatus: WeekendStatus,
): T[] {
  if (!weekendStatus.marketClosed) return instruments;
  return instruments.filter(i => CRYPTO_PAIRS_SET.has(i.pair));
}

// src/rotation.ts
// 銘柄入替え判定・承認・自動承認ロジック
// 2層構造: 追跡リスト（最大15銘柄、7日ロック）+ 候補リスト（最大50銘柄）

import type { D1Database } from '@cloudflare/workers-types';
import { INSTRUMENTS, type InstrumentConfig } from './instruments';

const TRACKING_MAX = 15;
const LOCK_DAYS = 7;
const AUTO_APPROVE_HOURS = 24;
const PROMOTION_TOP_N = 20;
const PROMOTION_DAYS = 3;
const DEMOTION_LOW_THEME = 20;
const DEMOTION_DAYS = 5;
const DEMOTION_WINDOW = 7;
const REJECTION_BLOCK_DAYS = 7;

export interface RotationProposal {
  id?: number;
  proposedAt: string;
  inSymbol: string;
  inScore: number;
  outSymbol: string;
  outScore: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'AUTO_APPROVED';
  decidedAt?: string;
  decidedBy?: string;
  inResultPnl?: number | null;
  outResultPnl?: number | null;
}

/** 現在の追跡リストを取得 */
export async function getTrackingList(db: D1Database): Promise<InstrumentConfig[]> {
  const rows = await db.prepare(
    "SELECT config_json FROM active_instruments ORDER BY added_at DESC"
  ).all<{ config_json: string }>();

  if (!rows.results || rows.results.length === 0) {
    // D1が空 → instruments.tsのハードコード日本株をフォールバック
    return INSTRUMENTS.filter(
      (i: InstrumentConfig) => i.assetClass === 'stock' && i.stockSymbol?.endsWith('.T')
    );
  }

  return rows.results.map(r => JSON.parse(r.config_json) as InstrumentConfig);
}

/** active_instrumentsテーブルを追跡リストで更新 */
export async function updateActiveInstruments(
  db: D1Database,
  instruments: InstrumentConfig[],
  addedAt: string
): Promise<void> {
  // 既存の全行を削除してから再挿入
  await db.prepare("DELETE FROM active_instruments").run();

  for (const inst of instruments) {
    await db.prepare(`
      INSERT INTO active_instruments (pair, config_json, added_at, source, updated_at)
      VALUES (?, ?, ?, 'auto', ?)
    `).bind(
      inst.pair,
      JSON.stringify(inst),
      addedAt,
      new Date().toISOString()
    ).run();
  }
}

/** 候補リスト（stock_scoresから上位50銘柄）を取得 */
export async function getCandidateList(db: D1Database): Promise<Array<{ symbol: string; rank: number; totalScore: number; themeScore: number }>> {
  const today = new Date().toISOString().split('T')[0];
  const rows = await db.prepare(`
    SELECT symbol, rank, total_score, theme_score FROM stock_scores
    WHERE scored_at = ? AND rank <= 50
    ORDER BY rank ASC
  `).bind(today).all<{ symbol: string; rank: number; total_score: number; theme_score: number }>();

  return (rows.results ?? []).map(r => ({
    symbol: r.symbol,
    rank: r.rank,
    totalScore: r.total_score,
    themeScore: r.theme_score,
  }));
}

/** 昇格候補を検出（候補リストで3日連続Top20 かつ 需給熱≥60） */
export async function detectPromotionCandidates(
  db: D1Database,
  currentTrackingSymbols: string[]
): Promise<string[]> {
  const today = new Date();
  const dates = Array.from({ length: PROMOTION_DAYS }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    return d.toISOString().split('T')[0];
  });

  const promotable: string[] = [];

  // 各候補銘柄が3日連続Top20 かつ 需給熱≥60かチェック
  const candidateRows = await db.prepare(`
    SELECT symbol, COUNT(*) as days, MIN(theme_score) as min_theme
    FROM stock_scores
    WHERE scored_at IN (${dates.map(() => '?').join(',')})
    AND rank <= ${PROMOTION_TOP_N}
    AND theme_score >= 60
    GROUP BY symbol
    HAVING days = ${PROMOTION_DAYS}
  `).bind(...dates).all<{ symbol: string; days: number; min_theme: number }>();

  for (const row of (candidateRows.results ?? [])) {
    if (!currentTrackingSymbols.includes(row.symbol)) {
      promotable.push(row.symbol);
    }
  }

  return promotable;
}

/** 降格候補を検出（7日ロック終了後、直近7日のうち需給熱≤20が5日以上） */
export async function detectDemotionCandidates(
  db: D1Database,
  trackingList: Array<{ symbol: string; addedAt: string }>
): Promise<string[]> {
  const today = new Date();
  const demotable: string[] = [];

  for (const t of trackingList) {
    // 7日ロック確認（added_atから7日経過していること）
    const addedAt = new Date(t.addedAt);
    const lockExpired = (today.getTime() - addedAt.getTime()) / (1000 * 3600 * 24) >= LOCK_DAYS;
    if (!lockExpired) continue;

    // 直近7日の需給熱スコア
    const dates = Array.from({ length: DEMOTION_WINDOW }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      return d.toISOString().split('T')[0];
    });

    const rows = await db.prepare(`
      SELECT COUNT(*) as low_days FROM stock_scores
      WHERE symbol = ?
      AND scored_at IN (${dates.map(() => '?').join(',')})
      AND theme_score <= ${DEMOTION_LOW_THEME}
    `).bind(t.symbol, ...dates).first<{ low_days: number }>();

    if ((rows?.low_days ?? 0) >= DEMOTION_DAYS) {
      demotable.push(t.symbol);
    }
  }

  return demotable;
}

/** 拒否ブロック中かどうかチェック */
async function isRejectionBlocked(db: D1Database, inSymbol: string): Promise<boolean> {
  const since = new Date(Date.now() - REJECTION_BLOCK_DAYS * 24 * 3600 * 1000).toISOString();
  const row = await db.prepare(`
    SELECT id FROM rotation_log
    WHERE in_symbol = ? AND status = 'REJECTED' AND proposed_at >= ?
    LIMIT 1
  `).bind(inSymbol, since).first();
  return !!row;
}

/** 入替え提案を作成（PENDING状態でrotation_logに挿入） */
export async function proposeRotation(
  db: D1Database,
  inSymbol: string,
  inScore: number,
  outSymbol: string,
  outScore: number
): Promise<void> {
  // 拒否ブロック確認
  if (await isRejectionBlocked(db, inSymbol)) {
    console.log(`[rotation] ${inSymbol} is rejection-blocked, skipping proposal`);
    return;
  }

  // 既存のPENDINGがあれば重複しない
  const existing = await db.prepare(
    "SELECT id FROM rotation_log WHERE status = 'PENDING' AND in_symbol = ?"
  ).bind(inSymbol).first();
  if (existing) return;

  await db.prepare(`
    INSERT INTO rotation_log (proposed_at, in_symbol, in_score, out_symbol, out_score, status)
    VALUES (?, ?, ?, ?, ?, 'PENDING')
  `).bind(new Date().toISOString(), inSymbol, inScore, outSymbol, outScore).run();

  console.log(`[rotation] Proposed: IN=${inSymbol}(${inScore}) OUT=${outSymbol}(${outScore})`);
}

/** ユーザーによる承認/拒否処理 */
export async function decideRotation(
  db: D1Database,
  id: number,
  action: 'approve' | 'reject'
): Promise<{ success: boolean; message: string }> {
  const row = await db.prepare(
    "SELECT * FROM rotation_log WHERE id = ? AND status = 'PENDING'"
  ).bind(id).first<{ id: number; in_symbol: string; out_symbol: string }>();

  if (!row) {
    return { success: false, message: 'Not found or already decided' };
  }

  const status = action === 'approve' ? 'APPROVED' : 'REJECTED';
  await db.prepare(
    "UPDATE rotation_log SET status = ?, decided_at = ?, decided_by = 'user' WHERE id = ?"
  ).bind(status, new Date().toISOString(), id).run();

  if (action === 'approve') {
    await executeRotation(db, row.in_symbol, row.out_symbol);
  }

  return { success: true, message: `${action}d rotation #${id}` };
}

/** 24時間タイムアウトで自動承認 */
export async function processAutoApproval(db: D1Database): Promise<void> {
  const threshold = new Date(Date.now() - AUTO_APPROVE_HOURS * 3600 * 1000).toISOString();
  const pending = await db.prepare(`
    SELECT * FROM rotation_log
    WHERE status = 'PENDING' AND proposed_at < ?
  `).bind(threshold).all<{ id: number; in_symbol: string; out_symbol: string }>();

  for (const row of (pending.results ?? [])) {
    await db.prepare(
      "UPDATE rotation_log SET status = 'AUTO_APPROVED', decided_at = ?, decided_by = 'timer' WHERE id = ?"
    ).bind(new Date().toISOString(), row.id).run();

    await executeRotation(db, row.in_symbol, row.out_symbol);
    console.log(`[rotation] Auto-approved: IN=${row.in_symbol} OUT=${row.out_symbol}`);
  }
}

/** 承認後に実際の入替えを実行（active_instrumentsを更新） */
async function executeRotation(db: D1Database, inSymbol: string, outSymbol: string): Promise<void> {
  // outSymbolを追跡リストから削除
  await db.prepare("DELETE FROM active_instruments WHERE pair LIKE ?")
    .bind(`%${outSymbol}%`).run();

  // inSymbolのInstrumentConfigを構築
  const baseConfig = INSTRUMENTS.find((i: InstrumentConfig) => i.stockSymbol === inSymbol)
    ?? buildDefaultJpStockConfig(inSymbol);

  await db.prepare(`
    INSERT OR REPLACE INTO active_instruments (pair, config_json, added_at, source, updated_at)
    VALUES (?, ?, ?, 'auto', ?)
  `).bind(
    baseConfig.pair,
    JSON.stringify(baseConfig),
    new Date().toISOString(),
    new Date().toISOString()
  ).run();

  console.log(`[rotation] Executed: IN=${inSymbol} OUT=${outSymbol}`);
}

/** 新銘柄のデフォルトInstrumentConfig構築 */
function buildDefaultJpStockConfig(stockSymbol: string): InstrumentConfig {
  const code = stockSymbol.replace('.T', '');
  return {
    pair: `JP${code}`,
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 50,
    tpSlHint: '300-500円幅',
    tpSlMin: 100,
    tpSlMax: 1000,
    rrMax: 5.0,
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 200,
    trailingDistance: 100,
    correlationGroup: 'jp_value',
    tier: 'C',
    tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol,
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  };
}

/** 7日後のPnLを計算して記録 */
export async function recordResultPnl(db: D1Database): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const readyRows = await db.prepare(`
    SELECT id, in_symbol, out_symbol, decided_at FROM rotation_log
    WHERE status IN ('APPROVED', 'AUTO_APPROVED')
    AND decided_at < ?
    AND in_result_pnl IS NULL
  `).bind(sevenDaysAgo).all<{ id: number; in_symbol: string; out_symbol: string; decided_at: string }>();

  for (const row of (readyRows.results ?? [])) {
    const inPnl = await calcSevenDayReturn(db, row.in_symbol, row.decided_at);
    const outPnl = await calcSevenDayReturn(db, row.out_symbol, row.decided_at);

    await db.prepare(
      "UPDATE rotation_log SET in_result_pnl = ?, out_result_pnl = ? WHERE id = ?"
    ).bind(inPnl, outPnl, row.id).run();
  }
}

/** 承認日から現在までの株価リターン（%）を計算 */
async function calcSevenDayReturn(
  db: D1Database,
  symbol: string,
  fromDate: string
): Promise<number | null> {
  try {
    // market_cacheから承認日の株価を取得
    const cacheKey = `price_${symbol}_${fromDate.split('T')[0]}`;
    const cached = await db.prepare("SELECT value FROM market_cache WHERE key = ?")
      .bind(cacheKey).first<{ value: string }>();

    const fromPrice = cached ? parseFloat(cached.value) : null;
    if (!fromPrice) return null;

    // 現在の株価をYahoo Financeから取得
    const code = symbol.replace('.T', '');
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?interval=1d&range=1d`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
    const currentPrice = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!currentPrice) return null;

    return Math.round((currentPrice / fromPrice - 1) * 100 * 10) / 10;
  } catch {
    return null;
  }
}

/** 未決定のPENDING提案一覧 */
export async function getPendingRotations(db: D1Database): Promise<Array<{
  id: number;
  proposed_at: string;
  in_symbol: string;
  in_score: number;
  out_symbol: string;
  out_score: number;
  status: string;
}>> {
  const rows = await db.prepare(
    "SELECT id, proposed_at, in_symbol, in_score, out_symbol, out_score, status FROM rotation_log WHERE status = 'PENDING' ORDER BY proposed_at DESC"
  ).all<{ id: number; proposed_at: string; in_symbol: string; in_score: number; out_symbol: string; out_score: number; status: string }>();
  return rows.results ?? [];
}

// TRACKING_MAX は将来の拡張用にエクスポートしておく
export { TRACKING_MAX };

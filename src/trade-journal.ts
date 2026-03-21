// ============================================================
// trade-journal.ts — 施策13-15: PDCA自動化（トレード日誌・手法別統計・週次/月次レビュー）
// ============================================================
//
// DBマイグレーション（v205）:
// ```sql
// CREATE TABLE IF NOT EXISTS trade_logs (
//   id INTEGER PRIMARY KEY AUTOINCREMENT,
//   position_id INTEGER NOT NULL,
//   pair TEXT NOT NULL,
//   direction TEXT NOT NULL,
//   strategy TEXT,
//   regime TEXT,
//   session TEXT,
//   confidence INTEGER,
//   entry_rate REAL NOT NULL,
//   close_rate REAL,
//   tp_rate REAL, sl_rate REAL,
//   lot REAL,
//   pnl REAL,
//   rr_ratio REAL,
//   entry_at TEXT NOT NULL,
//   closed_at TEXT,
//   close_reason TEXT,
//   vix_at_entry REAL,
//   atr_at_entry REAL,
//   reasoning TEXT,
//   created_at TEXT NOT NULL
// );
// CREATE INDEX IF NOT EXISTS idx_trade_logs_strategy ON trade_logs(strategy, regime);
// CREATE INDEX IF NOT EXISTS idx_trade_logs_pair ON trade_logs(pair, closed_at DESC);
// ```

// ----------------------------------------------------------
// トレード日誌記録（施策13）
// ----------------------------------------------------------

export async function logTradeJournal(
  db: D1Database,
  position: {
    id: number;
    pair: string;
    direction: string;
    entry_rate: number;
    close_rate: number | null;
    tp_rate: number | null;
    sl_rate: number | null;
    lot: number;
    pnl: number | null;
    entry_at: string;
    closed_at: string | null;
    close_reason: string | null;
    source: string | null;
  },
  extra?: {
    strategy?: string;
    regime?: string;
    session?: string;
    confidence?: number;
    reasoning?: string;
    vix?: number | null;
    atr?: number | null;
  }
): Promise<void> {
  // RRレシオ算出: |tp - entry| / |sl - entry|
  let rrRatio: number | null = null;
  if (
    position.tp_rate != null &&
    position.sl_rate != null &&
    position.entry_rate != null
  ) {
    const reward = Math.abs(position.tp_rate - position.entry_rate);
    const risk = Math.abs(position.sl_rate - position.entry_rate);
    if (risk > 0) {
      rrRatio = Math.round((reward / risk) * 100) / 100;
    }
  }

  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO trade_logs (
        position_id, pair, direction, strategy, regime, session,
        confidence, entry_rate, close_rate, tp_rate, sl_rate,
        lot, pnl, rr_ratio, entry_at, closed_at, close_reason,
        vix_at_entry, atr_at_entry, reasoning, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )`
    )
    .bind(
      position.id,
      position.pair,
      position.direction,
      extra?.strategy ?? null,
      extra?.regime ?? null,
      extra?.session ?? null,
      extra?.confidence ?? null,
      position.entry_rate,
      position.close_rate,
      position.tp_rate,
      position.sl_rate,
      position.lot,
      position.pnl,
      rrRatio,
      position.entry_at,
      position.closed_at,
      position.close_reason,
      extra?.vix ?? null,
      extra?.atr ?? null,
      extra?.reasoning ?? null,
      now
    )
    .run();
}

// ----------------------------------------------------------
// 手法別統計（施策14）
// ----------------------------------------------------------

export interface StrategyStats {
  strategy: string;
  regime: string;
  count: number;
  wins: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  avgRR: number;
  reliabilityLabel: 'reference' | 'tentative' | 'reliable';
}

interface StrategyStatsRow {
  strategy: string;
  regime: string;
  count: number;
  wins: number;
  avg_pnl: number;
  total_pnl: number;
  avg_rr: number | null;
}

function getReliabilityLabel(n: number): 'reference' | 'tentative' | 'reliable' {
  if (n < 50) return 'reference';
  if (n < 200) return 'tentative';
  return 'reliable';
}

export async function getStrategyStats(db: D1Database): Promise<StrategyStats[]> {
  const result = await db
    .prepare(
      `SELECT
        strategy,
        regime,
        COUNT(*) as count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        AVG(pnl) as avg_pnl,
        SUM(pnl) as total_pnl,
        AVG(rr_ratio) as avg_rr
      FROM trade_logs
      WHERE strategy IS NOT NULL
      GROUP BY strategy, regime
      ORDER BY count DESC`
    )
    .all<StrategyStatsRow>();

  return (result.results ?? []).map((row) => ({
    strategy: row.strategy,
    regime: row.regime ?? 'unknown',
    count: row.count,
    wins: row.wins,
    winRate: row.count > 0 ? Math.round((row.wins / row.count) * 10000) / 100 : 0,
    avgPnl: Math.round((row.avg_pnl ?? 0) * 100) / 100,
    totalPnl: Math.round((row.total_pnl ?? 0) * 100) / 100,
    avgRR: Math.round((row.avg_rr ?? 0) * 100) / 100,
    reliabilityLabel: getReliabilityLabel(row.count),
  }));
}

// ----------------------------------------------------------
// 週次レビュー（施策15）
// ----------------------------------------------------------

interface ReviewRow {
  count: number;
  wins: number;
  total_pnl: number;
  total_profit: number;
  total_loss: number;
}

interface StrategyReviewRow {
  strategy: string;
  count: number;
  wins: number;
  win_rate: number;
  total_pnl: number;
}

export async function generateWeeklyReview(db: D1Database): Promise<string> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 全体サマリー
  const summary = await db
    .prepare(
      `SELECT
        COUNT(*) as count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        COALESCE(SUM(pnl), 0) as total_pnl,
        COALESCE(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END), 0) as total_profit,
        COALESCE(SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END), 0) as total_loss
      FROM trade_logs
      WHERE closed_at >= ?`
    )
    .bind(sevenDaysAgo)
    .first<ReviewRow>();

  if (!summary || summary.count === 0) {
    return '[週次レビュー] 直近7日間のトレード記録がありません。';
  }

  const winRate = Math.round((summary.wins / summary.count) * 10000) / 100;
  const pf = summary.total_loss > 0
    ? Math.round((summary.total_profit / summary.total_loss) * 100) / 100
    : summary.total_profit > 0 ? Infinity : 0;

  // 手法別（Top3 / Worst3）
  const strategyRows = await db
    .prepare(
      `SELECT
        strategy,
        COUNT(*) as count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        ROUND(CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) as win_rate,
        COALESCE(SUM(pnl), 0) as total_pnl
      FROM trade_logs
      WHERE closed_at >= ? AND strategy IS NOT NULL
      GROUP BY strategy
      ORDER BY win_rate DESC`
    )
    .bind(sevenDaysAgo)
    .all<StrategyReviewRow>();

  const strategies = strategyRows.results ?? [];
  const top3 = strategies.slice(0, 3);
  const worst3 = strategies.length > 3
    ? strategies.slice(-3).reverse()
    : [];

  const lines: string[] = [
    '=== 週次レビュー ===',
    `期間: ${sevenDaysAgo.slice(0, 10)} ~ ${new Date().toISOString().slice(0, 10)}`,
    '',
    `総トレード数: ${summary.count}`,
    `勝率: ${winRate}% (${summary.wins}/${summary.count})`,
    `PnL合計: ${Math.round(summary.total_pnl * 100) / 100} pips`,
    `PF (Profit Factor): ${pf === Infinity ? '∞' : pf}`,
    '',
  ];

  if (top3.length > 0) {
    lines.push('--- 手法別 勝率Top3 ---');
    top3.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.strategy}: ${s.win_rate}% (${s.wins}/${s.count}) PnL=${Math.round(s.total_pnl * 100) / 100}`);
    });
    lines.push('');
  }

  if (worst3.length > 0) {
    lines.push('--- 手法別 勝率Worst3 ---');
    worst3.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.strategy}: ${s.win_rate}% (${s.wins}/${s.count}) PnL=${Math.round(s.total_pnl * 100) / 100}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

// ----------------------------------------------------------
// 月次レビュー（施策15）
// ----------------------------------------------------------

interface MatrixRow {
  strategy: string;
  regime: string;
  count: number;
  wins: number;
  win_rate: number;
  avg_pnl: number;
  total_pnl: number;
  avg_rr: number | null;
}

export async function generateMonthlyReview(db: D1Database): Promise<string> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // 全体サマリー
  const summary = await db
    .prepare(
      `SELECT
        COUNT(*) as count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        COALESCE(SUM(pnl), 0) as total_pnl,
        COALESCE(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END), 0) as total_profit,
        COALESCE(SUM(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE 0 END), 0) as total_loss
      FROM trade_logs
      WHERE closed_at >= ?`
    )
    .bind(thirtyDaysAgo)
    .first<ReviewRow>();

  if (!summary || summary.count === 0) {
    return '[月次レビュー] 直近30日間のトレード記録がありません。';
  }

  const winRate = Math.round((summary.wins / summary.count) * 10000) / 100;
  const pf = summary.total_loss > 0
    ? Math.round((summary.total_profit / summary.total_loss) * 100) / 100
    : summary.total_profit > 0 ? Infinity : 0;

  // 平均RR
  const avgRRRow = await db
    .prepare(
      `SELECT AVG(rr_ratio) as avg_rr FROM trade_logs WHERE closed_at >= ? AND rr_ratio IS NOT NULL`
    )
    .bind(thirtyDaysAgo)
    .first<{ avg_rr: number | null }>();
  const avgRR = Math.round((avgRRRow?.avg_rr ?? 0) * 100) / 100;

  // 最大ドローダウン（簡易: 連続損失の最大合計）
  const allPnl = await db
    .prepare(
      `SELECT pnl FROM trade_logs WHERE closed_at >= ? AND pnl IS NOT NULL ORDER BY closed_at ASC`
    )
    .bind(thirtyDaysAgo)
    .all<{ pnl: number }>();

  let maxDD = 0;
  let currentDD = 0;
  for (const row of allPnl.results ?? []) {
    if (row.pnl < 0) {
      currentDD += Math.abs(row.pnl);
      if (currentDD > maxDD) maxDD = currentDD;
    } else {
      currentDD = 0;
    }
  }
  maxDD = Math.round(maxDD * 100) / 100;

  // Sharpe近似（pnlの平均/標準偏差）
  const pnlValues = (allPnl.results ?? []).map((r) => r.pnl);
  const meanPnl = pnlValues.length > 0
    ? pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length
    : 0;
  const variance = pnlValues.length > 1
    ? pnlValues.reduce((sum, v) => sum + (v - meanPnl) ** 2, 0) / (pnlValues.length - 1)
    : 0;
  const stdPnl = Math.sqrt(variance);
  const sharpe = stdPnl > 0
    ? Math.round((meanPnl / stdPnl) * 100) / 100
    : 0;

  // 手法 x 環境 マトリクス
  const matrix = await db
    .prepare(
      `SELECT
        strategy,
        regime,
        COUNT(*) as count,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        ROUND(CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) as win_rate,
        ROUND(AVG(pnl), 2) as avg_pnl,
        ROUND(SUM(pnl), 2) as total_pnl,
        ROUND(AVG(rr_ratio), 2) as avg_rr
      FROM trade_logs
      WHERE closed_at >= ? AND strategy IS NOT NULL
      GROUP BY strategy, regime
      ORDER BY total_pnl DESC`
    )
    .bind(thirtyDaysAgo)
    .all<MatrixRow>();

  const lines: string[] = [
    '=== 月次レビュー ===',
    `期間: ${thirtyDaysAgo.slice(0, 10)} ~ ${new Date().toISOString().slice(0, 10)}`,
    '',
    '--- KPI達成状況 ---',
    `  Sharpe Ratio (近似): ${sharpe}`,
    `  最大ドローダウン: ${maxDD} pips`,
    `  平均RR: ${avgRR}`,
    `  的中率: ${winRate}% (${summary.wins}/${summary.count})`,
    `  PF: ${pf === Infinity ? '∞' : pf}`,
    `  PnL合計: ${Math.round(summary.total_pnl * 100) / 100} pips`,
    '',
  ];

  const matrixRows = matrix.results ?? [];
  if (matrixRows.length > 0) {
    lines.push('--- 手法 x 環境 マトリクス ---');
    lines.push('  手法 | 環境 | 件数 | 勝率 | 平均PnL | 合計PnL | 平均RR');
    lines.push('  ' + '-'.repeat(70));
    matrixRows.forEach((row) => {
      lines.push(
        `  ${row.strategy} | ${row.regime ?? '-'} | ${row.count} | ${row.win_rate}% | ${row.avg_pnl} | ${row.total_pnl} | ${row.avg_rr ?? '-'}`
      );
    });
    lines.push('');
  }

  return lines.join('\n');
}

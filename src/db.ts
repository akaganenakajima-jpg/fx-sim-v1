export interface Position {
  id: number;
  pair: string;
  direction: 'BUY' | 'SELL';
  entry_rate: number;
  tp_rate: number | null;
  sl_rate: number | null;
  lot: number;
  status: 'OPEN' | 'CLOSED';
  pnl: number | null;
  entry_at: string;
  closed_at: string | null;
  close_rate: number | null;
  close_reason: string | null;
  source: string | null;
  oanda_trade_id: string | null;
  // テスタ施策7: 手法・環境タグ
  strategy?: string | null;
  regime?: string | null;
  session?: string | null;
  confidence?: number | null;
  // テスタ施策10: 分割決済
  partial_closed_lot?: number | null;
  original_lot?: number | null;
  tp1_hit?: number | null;
}

export interface DecisionRecord {
  pair: string;
  rate: number;
  decision: string;
  tp_rate: number | null;
  sl_rate: number | null;
  reasoning: string | null;
  news_summary: string | null;
  reddit_signal: string | null;
  vix: number | null;
  us10y: number | null;
  nikkei: number | null;
  sp500: number | null;
  created_at: string;
  news_sources?: string | null;  // カンマ区切りソース名
  prompt_version?: string | null; // AIプロンプトバージョン
  strategy?: string | null; // テスタ施策7: 手法タグ
  confidence?: number | null; // テスタ施策7: 確信度
}

export async function getOpenPositions(db: D1Database): Promise<Position[]> {
  const result = await db
    .prepare("SELECT * FROM positions WHERE status = 'OPEN'")
    .all<Position>();
  return result.results ?? [];
}

export async function getOpenPositionByPair(
  db: D1Database,
  pair: string
): Promise<Position | null> {
  const row = await db
    .prepare("SELECT * FROM positions WHERE status = 'OPEN' AND pair = ? LIMIT 1")
    .bind(pair)
    .first<Position>();
  return row ?? null;
}

export async function insertDecision(
  db: D1Database,
  record: DecisionRecord
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO decisions
        (pair, rate, decision, tp_rate, sl_rate, reasoning, news_summary,
         reddit_signal, vix, us10y, nikkei, sp500, created_at, news_sources, prompt_version,
         strategy, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.pair,
      record.rate,
      record.decision,
      record.tp_rate,
      record.sl_rate,
      record.reasoning,
      record.news_summary,
      record.reddit_signal,
      record.vix,
      record.us10y,
      record.nikkei,
      record.sp500,
      record.created_at,
      record.news_sources ?? null,
      record.prompt_version ?? null,
      record.strategy ?? null,
      record.confidence ?? null
    )
    .run();
}

export async function closePosition(
  db: D1Database,
  id: number,
  closeRate: number,
  reason: string,
  pnl: number,
  logReturnVal?: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE positions
       SET status       = 'CLOSED',
           close_rate   = ?,
           close_reason = ?,
           closed_at    = ?,
           pnl          = ?,
           log_return   = ?
       WHERE id = ?`
    )
    .bind(closeRate, reason, new Date().toISOString(), pnl, logReturnVal ?? null, id)
    .run();
}

export async function getCacheValue(
  db: D1Database,
  key: string
): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM market_cache WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function insertSystemLog(
  db: D1Database,
  level: 'INFO' | 'WARN' | 'ERROR',
  category: string,
  message: string,
  detail?: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO system_logs (level, category, message, detail, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(level, category, message, detail ?? null, new Date().toISOString())
    .run();
}

export async function setCacheValue(
  db: D1Database,
  key: string,
  value: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, new Date().toISOString())
    .run();
}

/**
 * ポジションクローズ時に対応するdecisionのoutcomeを更新（AI的中率トラッキング用）
 * 同ペア・同方向で entry_at 直前に作成された最新の未評価 BUY/SELL decision を対象とする。
 */
export async function updateDecisionOutcome(
  db: D1Database,
  pair: string,
  direction: 'BUY' | 'SELL',
  entryAt: string,
  outcome: 'WIN' | 'LOSE'
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE decisions SET outcome = ?
         WHERE id = (
           SELECT id FROM decisions
           WHERE pair = ? AND decision = ? AND created_at <= ? AND outcome IS NULL
           ORDER BY created_at DESC LIMIT 1
         )`
      )
      .bind(outcome, pair, direction, entryAt)
      .run();
  } catch {
    // outcomeカラムが未作成（マイグレーション前）の場合は無視
  }
}

// RiskManager — HWMドローダウン管理 + 相関リスクガード
// テスタ施策2: HWM更新 + DD段階制御
// テスタ施策4: 相関グループによる同方向ポジション制限

import { insertSystemLog } from './db';
import type { InstrumentConfig } from './instruments';

// ─── DD段階 ──────────────────────────────────────

export type DrawdownLevel = 'NORMAL' | 'CAUTION' | 'HALT' | 'STOP';

export interface DrawdownResult {
  level: DrawdownLevel;
  ddPct: number;
  hwm: number;
  balance: number;
  lotMultiplier: number;
}

// ─── risk_state KV操作 ──────────────────────────

async function getRiskStateValue(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM risk_state WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function setRiskStateValue(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO risk_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, new Date().toISOString())
    .run();
}

// ─── HWM管理 ────────────────────────────────────

const INITIAL_BALANCE = 10000;

export async function getHWM(db: D1Database): Promise<number> {
  const val = await getRiskStateValue(db, 'hwm');
  return val ? parseFloat(val) : INITIAL_BALANCE;
}

export async function updateHWM(db: D1Database, balance: number): Promise<boolean> {
  const hwm = await getHWM(db);
  if (balance > hwm) {
    await setRiskStateValue(db, 'hwm', balance.toString());
    return true;
  }
  return false;
}

// ─── 残高算出 ────────────────────────────────────

export async function getCurrentBalance(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS totalPnl
       FROM positions
       WHERE status = 'CLOSED'`
    )
    .first<{ totalPnl: number }>();
  return INITIAL_BALANCE + (row?.totalPnl ?? 0);
}

// ─── DD段階判定 ──────────────────────────────────

export async function getDrawdownLevel(db: D1Database): Promise<DrawdownResult> {
  // DD停止中チェック
  const ddStopped = await getRiskStateValue(db, 'dd_stopped');
  if (ddStopped === 'true') {
    const hwm = await getHWM(db);
    const balance = await getCurrentBalance(db);
    return { level: 'STOP', ddPct: ((hwm - balance) / hwm) * 100, hwm, balance, lotMultiplier: 0 };
  }

  const ddPausedUntil = await getRiskStateValue(db, 'dd_paused_until');
  if (ddPausedUntil) {
    const pauseEnd = new Date(ddPausedUntil);
    if (new Date() < pauseEnd) {
      const hwm = await getHWM(db);
      const balance = await getCurrentBalance(db);
      return { level: 'HALT', ddPct: ((hwm - balance) / hwm) * 100, hwm, balance, lotMultiplier: 0 };
    }
    // 停止期間終了 → フラグ解除
    await setRiskStateValue(db, 'dd_paused_until', '');
  }

  const balance = await getCurrentBalance(db);
  const hwm = await getHWM(db);
  const ddPct = hwm > 0 ? ((hwm - balance) / hwm) * 100 : 0;

  let level: DrawdownLevel;
  let lotMultiplier: number;

  if (ddPct >= 15) {
    level = 'STOP';
    lotMultiplier = 0;
  } else if (ddPct >= 10) {
    level = 'HALT';
    lotMultiplier = 0;
  } else if (ddPct >= 5) {
    level = 'CAUTION';
    lotMultiplier = 0.5;
  } else {
    level = 'NORMAL';
    lotMultiplier = 1.0;
  }

  return { level, ddPct, hwm, balance, lotMultiplier };
}

// ─── DD制御アクション ────────────────────────────

export async function applyDrawdownControl(
  db: D1Database,
  result: DrawdownResult
): Promise<void> {
  if (result.level === 'HALT') {
    // 1週間停止フラグ
    const pauseUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await setRiskStateValue(db, 'dd_paused_until', pauseUntil);
    await insertSystemLog(db, 'WARN', 'RISK',
      `DD HALT: ${result.ddPct.toFixed(1)}% — 1週間停止 (until ${pauseUntil})`);
  } else if (result.level === 'STOP') {
    await setRiskStateValue(db, 'dd_stopped', 'true');
    await insertSystemLog(db, 'WARN', 'RISK',
      `DD STOP: ${result.ddPct.toFixed(1)}% — 完全停止`);
  }
}

// ─── 相関リスクガード（テスタ施策4） ─────────────

export type CorrelationGroup =
  | 'usd_strong' | 'risk_on' | 'precious'
  | 'energy' | 'europe' | 'standalone';

export interface CorrelationGuardResult {
  allowed: boolean;
  reason: string;
}

export async function checkCorrelationGuard(
  db: D1Database,
  pair: string,
  direction: 'BUY' | 'SELL',
  instruments: InstrumentConfig[]
): Promise<CorrelationGuardResult> {
  const targetInst = instruments.find(i => i.pair === pair);
  if (!targetInst || !('correlationGroup' in targetInst)) {
    return { allowed: true, reason: 'OK' };
  }

  const group = (targetInst as InstrumentConfig & { correlationGroup: CorrelationGroup }).correlationGroup;
  if (group === 'standalone') {
    return { allowed: true, reason: 'OK' };
  }

  // 同グループの銘柄一覧
  const groupPairs = instruments
    .filter(i => 'correlationGroup' in i &&
      (i as InstrumentConfig & { correlationGroup: CorrelationGroup }).correlationGroup === group &&
      i.pair !== pair)
    .map(i => i.pair);

  if (groupPairs.length === 0) {
    return { allowed: true, reason: 'OK' };
  }

  // 同グループのOPENポジション取得
  const placeholders = groupPairs.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT pair, direction FROM positions
       WHERE status = 'OPEN' AND pair IN (${placeholders})`
    )
    .bind(...groupPairs)
    .all<{ pair: string; direction: string }>();

  const sameDirectionCount = (rows.results ?? [])
    .filter(r => r.direction === direction)
    .length;

  if (sameDirectionCount >= 2) {
    const msg = `相関ガード: ${group}グループ ${direction}方向 既に${sameDirectionCount}件 — ${pair}をブロック`;
    return { allowed: false, reason: msg };
  }

  return { allowed: true, reason: 'OK' };
}

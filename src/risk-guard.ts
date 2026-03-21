// RiskGuard — 実弾取引の安全装置
// 1. 日次損失キルスイッチ
// 2. 週次損失キルスイッチ（テスタ施策1）
// 3. 月次損失キルスイッチ（テスタ施策1）
// 4. 最大同時ポジション数制限
// 5. 最大ロットサイズ制限
// 6. 異常レート検知

import { insertSystemLog } from './db';

export interface RiskEnv {
  RISK_MAX_DAILY_LOSS?: string;      // 日次最大損失額(円)。デフォルト500
  RISK_MAX_WEEKLY_LOSS?: string;     // 週次最大損失額(円)。デフォルト500
  RISK_MAX_MONTHLY_LOSS?: string;    // 月次最大損失額(円)。デフォルト1000
  RISK_MAX_LIVE_POSITIONS?: string;  // 最大実弾ポジション数。デフォルト5
  RISK_MAX_LOT_SIZE?: string;        // 1注文最大ロット。デフォルト0.1
  RISK_ANOMALY_THRESHOLD?: string;   // 異常レート乖離率。デフォルト0.02
}

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
  adjustedLot?: number;  // ロット制限で調整された場合
}

// ─── 日次損失キルスイッチ ────────────────────────

async function checkDailyLoss(
  db: D1Database,
  maxLoss: number
): Promise<{ exceeded: boolean; todayLoss: number }> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS todayLoss
       FROM positions
       WHERE status = 'CLOSED'
         AND source = 'oanda'
         AND closed_at >= ?`
    )
    .bind(today + 'T00:00:00.000Z')
    .first<{ todayLoss: number }>();

  const todayLoss = row?.todayLoss ?? 0;
  return {
    exceeded: todayLoss <= -maxLoss, // 損失がマイナスなので符号注意
    todayLoss,
  };
}

// ─── 週次損失チェック（テスタ施策1） ────────────────

async function checkWeeklyLoss(
  db: D1Database,
  maxLoss: number
): Promise<{ exceeded: boolean; weeklyLoss: number }> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS weeklyLoss
       FROM positions
       WHERE status = 'CLOSED'
         AND source = 'oanda'
         AND closed_at >= ?`
    )
    .bind(weekAgo.toISOString())
    .first<{ weeklyLoss: number }>();

  const weeklyLoss = row?.weeklyLoss ?? 0;
  return {
    exceeded: weeklyLoss <= -maxLoss,
    weeklyLoss,
  };
}

// ─── 月次損失チェック（テスタ施策1） ────────────────

async function checkMonthlyLoss(
  db: D1Database,
  maxLoss: number
): Promise<{ exceeded: boolean; monthlyLoss: number }> {
  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS monthlyLoss
       FROM positions
       WHERE status = 'CLOSED'
         AND source = 'oanda'
         AND closed_at >= ?`
    )
    .bind(monthAgo.toISOString())
    .first<{ monthlyLoss: number }>();

  const monthlyLoss = row?.monthlyLoss ?? 0;
  return {
    exceeded: monthlyLoss <= -maxLoss,
    monthlyLoss,
  };
}

// ─── 最大同時ポジション数チェック ──────────────────

async function checkPositionCount(
  db: D1Database,
  maxPositions: number
): Promise<{ exceeded: boolean; currentCount: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM positions
       WHERE status = 'OPEN'
         AND source = 'oanda'`
    )
    .first<{ cnt: number }>();

  const currentCount = row?.cnt ?? 0;
  return {
    exceeded: currentCount >= maxPositions,
    currentCount,
  };
}

// ─── 異常レート検知 ──────────────────────────────

function checkRateAnomaly(
  currentRate: number,
  prevRate: number | null,
  threshold: number
): { anomaly: boolean; deviation: number } {
  if (prevRate == null || prevRate === 0) return { anomaly: false, deviation: 0 };
  const deviation = Math.abs(currentRate - prevRate) / prevRate;
  return {
    anomaly: deviation > threshold,
    deviation,
  };
}

// ─── メイン: 発注前チェック ──────────────────────

export async function checkRisk(params: {
  db: D1Database;
  env: RiskEnv;
  pair: string;
  currentRate: number;
  prevRate: number | null;
  requestedLot: number;
}): Promise<RiskCheckResult> {
  const { db, env, pair, currentRate, prevRate, requestedLot } = params;

  const maxDailyLoss = parseFloat(env.RISK_MAX_DAILY_LOSS ?? '500');
  const maxWeeklyLoss = parseFloat(env.RISK_MAX_WEEKLY_LOSS ?? '500');
  const maxMonthlyLoss = parseFloat(env.RISK_MAX_MONTHLY_LOSS ?? '1000');
  const maxPositions = parseInt(env.RISK_MAX_LIVE_POSITIONS ?? '5', 10);
  const maxLot = parseFloat(env.RISK_MAX_LOT_SIZE ?? '0.1');
  const anomalyThreshold = parseFloat(env.RISK_ANOMALY_THRESHOLD ?? '0.02');

  // 1. 日次損失キルスイッチ
  const daily = await checkDailyLoss(db, maxDailyLoss);
  if (daily.exceeded) {
    const msg = `キルスイッチ発動: 本日損失 ¥${Math.round(daily.todayLoss)} が上限 ¥-${maxDailyLoss} を超過`;
    console.warn(`[risk-guard] ${msg}`);
    await insertSystemLog(db, 'WARN', 'RISK', msg);
    return { allowed: false, reason: msg };
  }

  // 2. 週次損失キルスイッチ（テスタ施策1）
  const weekly = await checkWeeklyLoss(db, maxWeeklyLoss);
  if (weekly.exceeded) {
    const msg = `週次キルスイッチ発動: 7日間損失 ¥${Math.round(weekly.weeklyLoss)} が上限 ¥-${maxWeeklyLoss} を超過`;
    console.warn(`[risk-guard] ${msg}`);
    await insertSystemLog(db, 'WARN', 'RISK', msg);
    return { allowed: false, reason: msg };
  }

  // 3. 月次損失キルスイッチ（テスタ施策1）
  const monthly = await checkMonthlyLoss(db, maxMonthlyLoss);
  if (monthly.exceeded) {
    const msg = `月次キルスイッチ発動: 30日間損失 ¥${Math.round(monthly.monthlyLoss)} が上限 ¥-${maxMonthlyLoss} を超過`;
    console.warn(`[risk-guard] ${msg}`);
    await insertSystemLog(db, 'WARN', 'RISK', msg);
    return { allowed: false, reason: msg };
  }

  // 4. 最大同時ポジション数
  const posCount = await checkPositionCount(db, maxPositions);
  if (posCount.exceeded) {
    const msg = `ポジション上限: 実弾 ${posCount.currentCount}/${maxPositions} 件で上限到達`;
    console.warn(`[risk-guard] ${msg}`);
    return { allowed: false, reason: msg };
  }

  // 5. 異常レート検知
  const anomaly = checkRateAnomaly(currentRate, prevRate, anomalyThreshold);
  if (anomaly.anomaly) {
    const msg = `異常レート検知: ${pair} 乖離率 ${(anomaly.deviation * 100).toFixed(2)}% > ${(anomalyThreshold * 100).toFixed(0)}%`;
    console.warn(`[risk-guard] ${msg}`);
    await insertSystemLog(db, 'WARN', 'RISK', msg);
    return { allowed: false, reason: msg };
  }

  // 6. ロットサイズ制限（超過時はクランプ）
  let adjustedLot = requestedLot;
  if (adjustedLot > maxLot) {
    console.log(`[risk-guard] Lot clamped: ${pair} ${requestedLot} → ${maxLot}`);
    adjustedLot = maxLot;
  }

  return { allowed: true, reason: 'OK', adjustedLot };
}

/** RiskGuard の現在状態を返す（ダッシュボード用） */
export async function getRiskStatus(db: D1Database, env: RiskEnv): Promise<{
  killSwitchActive: boolean;
  todayLoss: number;
  maxDailyLoss: number;
  weeklyLoss: number;
  maxWeeklyLoss: number;
  weeklyExceeded: boolean;
  monthlyLoss: number;
  maxMonthlyLoss: number;
  monthlyExceeded: boolean;
  livePositions: number;
  maxPositions: number;
}> {
  const maxDailyLoss = parseFloat(env.RISK_MAX_DAILY_LOSS ?? '500');
  const maxWeeklyLoss = parseFloat(env.RISK_MAX_WEEKLY_LOSS ?? '500');
  const maxMonthlyLoss = parseFloat(env.RISK_MAX_MONTHLY_LOSS ?? '1000');
  const maxPositions = parseInt(env.RISK_MAX_LIVE_POSITIONS ?? '5', 10);

  const daily = await checkDailyLoss(db, maxDailyLoss);
  const weekly = await checkWeeklyLoss(db, maxWeeklyLoss);
  const monthly = await checkMonthlyLoss(db, maxMonthlyLoss);
  const posCount = await checkPositionCount(db, maxPositions);

  return {
    killSwitchActive: daily.exceeded,
    todayLoss: daily.todayLoss,
    maxDailyLoss,
    weeklyLoss: weekly.weeklyLoss,
    maxWeeklyLoss,
    weeklyExceeded: weekly.exceeded,
    monthlyLoss: monthly.monthlyLoss,
    maxMonthlyLoss,
    monthlyExceeded: monthly.exceeded,
    livePositions: posCount.currentCount,
    maxPositions,
  };
}

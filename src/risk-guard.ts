// RiskGuard — 実弾取引の安全装置
// 1. 日次損失キルスイッチ
// 2. 最大同時ポジション数制限
// 3. 最大ロットサイズ制限
// 4. 異常レート検知

import { insertSystemLog } from './db';

export interface RiskEnv {
  RISK_MAX_DAILY_LOSS?: string;      // 日次最大損失額(円)。デフォルト500
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
  const maxPositions = parseInt(env.RISK_MAX_LIVE_POSITIONS ?? '5', 10);
  const maxLot = parseFloat(env.RISK_MAX_LOT_SIZE ?? '0.1');
  const anomalyThreshold = parseFloat(env.RISK_ANOMALY_THRESHOLD ?? '0.02');

  // 1. 日次損失キルスイッチ
  const daily = await checkDailyLoss(db, maxDailyLoss);
  if (daily.exceeded) {
    const msg = `キルスイッチ発動: 本日損失 ¥${Math.round(daily.todayLoss)} が上限 ¥-${maxDailyLoss} を超過`;
    console.warn(`[risk-guard] ${msg}`);
    await insertSystemLog(db, 'WARN', 'RISK', msg, null);
    return { allowed: false, reason: msg };
  }

  // 2. 最大同時ポジション数
  const posCount = await checkPositionCount(db, maxPositions);
  if (posCount.exceeded) {
    const msg = `ポジション上限: 実弾 ${posCount.currentCount}/${maxPositions} 件で上限到達`;
    console.warn(`[risk-guard] ${msg}`);
    return { allowed: false, reason: msg };
  }

  // 3. 異常レート検知
  const anomaly = checkRateAnomaly(currentRate, prevRate, anomalyThreshold);
  if (anomaly.anomaly) {
    const msg = `異常レート検知: ${pair} 乖離率 ${(anomaly.deviation * 100).toFixed(2)}% > ${(anomalyThreshold * 100).toFixed(0)}%`;
    console.warn(`[risk-guard] ${msg}`);
    await insertSystemLog(db, 'WARN', 'RISK', msg, null);
    return { allowed: false, reason: msg };
  }

  // 4. ロットサイズ制限（超過時はクランプ）
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
  livePositions: number;
  maxPositions: number;
}> {
  const maxDailyLoss = parseFloat(env.RISK_MAX_DAILY_LOSS ?? '500');
  const maxPositions = parseInt(env.RISK_MAX_LIVE_POSITIONS ?? '5', 10);

  const daily = await checkDailyLoss(db, maxDailyLoss);
  const posCount = await checkPositionCount(db, maxPositions);

  return {
    killSwitchActive: daily.exceeded,
    todayLoss: daily.todayLoss,
    maxDailyLoss,
    livePositions: posCount.currentCount,
    maxPositions,
  };
}

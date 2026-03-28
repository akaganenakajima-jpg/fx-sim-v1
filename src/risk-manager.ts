// RiskManager — HWMドローダウン管理 + 相関リスクガード
// テスタ施策2: HWM更新 + DD段階制御（5段階: NORMAL/CAUTION/WARNING/HALT/STOP）
// テスタ施策4: 相関グループによる同方向ポジション制限
// SPRT回復判定: パフォーマンスベースでDD段階を昇降

import { insertSystemLog } from './db';
import type { InstrumentConfig } from './instruments';

// ─── DD段階（5段階: DDベース段階縮小 + Kelly基準） ────
// ※ テスタ語録「守りを考えた方が結果として増える」の実装。
//   具体的な閾値(5%/8%/12%/15%)はKelly基準を根拠とした独自設計。

export type DrawdownLevel = 'NORMAL' | 'CAUTION' | 'WARNING' | 'HALT' | 'STOP';

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

// ─── 日次損失チェック（Daily Loss Cap） ──────────

/**
 * 当日（UTC 0:00〜）の実現損失合計を取得し、HWM × capPct を超えているか判定。
 * @returns { dailyLoss: 当日損失合計（負値）, capped: 上限超過か, capAmount: 上限額 }
 */
export async function checkDailyLossCap(
  db: D1Database,
  now: Date,
  capPct: number = 0.02, // デフォルト 2%（一般トレーディング基準: Alexander Elder等）
): Promise<{ dailyLoss: number; capped: boolean; capAmount: number }> {
  const hwm = await getHWM(db);
  const capAmount = hwm * capPct;
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS dailyPnl
       FROM positions
       WHERE status = 'CLOSED' AND closed_at >= ?`
    )
    .bind(todayStart)
    .first<{ dailyPnl: number }>();
  const dailyLoss = row?.dailyPnl ?? 0;
  return { dailyLoss, capped: dailyLoss <= -capAmount, capAmount };
}

// ─── DD段階判定 ──────────────────────────────────

export async function getDrawdownLevel(db: D1Database): Promise<DrawdownResult> {
  // DD完全停止チェック（>=15%で手動リセットまで復帰不可）
  const ddStopped = await getRiskStateValue(db, 'dd_stopped');
  if (ddStopped === 'true') {
    const hwm = await getHWM(db);
    const balance = await getCurrentBalance(db);
    return { level: 'STOP', ddPct: ((hwm - balance) / hwm) * 100, hwm, balance, lotMultiplier: 0 };
  }

  // 旧方式の dd_paused_until が残っていれば解除（パフォーマンスベースに移行済み）
  const ddPausedUntil = await getRiskStateValue(db, 'dd_paused_until');
  if (ddPausedUntil) {
    await setRiskStateValue(db, 'dd_paused_until', '');
  }

  const balance = await getCurrentBalance(db);
  const hwm = await getHWM(db);
  const ddPct = hwm > 0 ? ((hwm - balance) / hwm) * 100 : 0;

  // 5段階DD制御（DDベース段階縮小 + Kelly基準）
  // STOP: 完全停止, HALT: Micro Kelly(0.1), WARNING: Quarter Kelly(0.25)
  // CAUTION: Half Kelly(0.5), NORMAL: Full Kelly(1.0)
  let level: DrawdownLevel;
  let lotMultiplier: number;

  if (ddPct >= 15) {
    level = 'STOP';
    lotMultiplier = 0;
  } else if (ddPct >= 12) {
    level = 'HALT';
    lotMultiplier = 0.1;  // Micro Kelly: 最小ロットで検証トレード
  } else if (ddPct >= 8) {
    level = 'WARNING';
    lotMultiplier = 0.25; // Quarter Kelly
  } else if (ddPct >= 5) {
    level = 'CAUTION';
    lotMultiplier = 0.5;  // Half Kelly
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
  if (result.level === 'STOP') {
    await setRiskStateValue(db, 'dd_stopped', 'true');
    await insertSystemLog(db, 'WARN', 'RISK',
      `DD STOP: ${result.ddPct.toFixed(1)}% — 完全停止`);
  } else if (result.level === 'HALT' || result.level === 'WARNING') {
    // 段階的縮小（DDベース）: 完全停止せずロット縮小で継続
    await insertSystemLog(db, 'WARN', 'RISK',
      `DD ${result.level}: ${result.ddPct.toFixed(1)}% — lotMult=${result.lotMultiplier}で継続`,
      `HWM=${result.hwm.toFixed(0)} Balance=${result.balance.toFixed(0)}`);
  }
}

// ─── SPRT回復判定（逐次確率比検定・Gaussian版） ──────────────
// Wald (1945): 固定サンプルサイズ不要でデータ到着ごとに判定可能
// 改訂: バイナリ勝敗 → 連続リターン（pnl/残高）ベースの Gaussian SPRT
// H₀: 平均リターン μ ≤ μ₀（回復なし）
// H₁: 平均リターン μ ≥ μ₁（回復あり）
// Δllr = (μ₁-μ₀)/σ² × r_t − (μ₁²-μ₀²)/(2σ²)  where r_t = pnl / INITIAL_BALANCE

interface SPRTConfig {
  mu0: number;   // H₀: 平均リターン（回復なし: -0.1%/trade）
  mu1: number;   // H₁: 平均リターン（回復あり: +0.3%/trade）
  sigma: number; // リターンの標準偏差（実績ベース: 約1%）
  alpha: number; // 第一種過誤（誤って回復と判定）
  beta: number;  // 第二種過誤（回復を見逃す）
}

const SPRT_CONFIG: SPRTConfig = {
  mu0:   -0.001,  // 回復なし: -0.1%/trade 以下
  mu1:   +0.003,  // 回復あり: +0.3%/trade 以上
  sigma:  0.010,  // リターンSD ≈1%（実績: avgLoss/10000 ≈ 0.008）
  alpha:  0.05,
  beta:   0.10,
};

export type SPRTResult = 'UPGRADE' | 'DOWNGRADE' | 'CONTINUE';

/**
 * SPRT（逐次確率比検定・Gaussian版）でDD回復を判定する。
 * DD開始後のトレードリターン（pnl/残高）を逐次的に評価し、統計的に有意な回復/悪化を検出する。
 * バイナリ勝敗ではなく連続値を使うため RR の大小も自動的に考慮される。
 *
 * @returns UPGRADE: 回復と判定（DD段階を1段階上げる）
 *          DOWNGRADE: 悪化と判定（DD段階を1段階下げる）
 *          CONTINUE: まだ判定不能（データ蓄積中）
 */
export async function evaluateRecovery(db: D1Database): Promise<SPRTResult> {
  const { mu0, mu1, sigma, alpha, beta } = SPRT_CONFIG;

  // 上限・下限閾値（対数尤度比）
  const upperBound = Math.log((1 - beta) / alpha);   // ≈ 2.89
  const lowerBound = Math.log(beta / (1 - alpha));    // ≈ -2.25

  // Gaussian SPRT の1観測あたりLLR増分係数
  // Δllr = (μ₁-μ₀)/σ² × r_t − (μ₁²-μ₀²)/(2σ²)
  const sigma2 = sigma * sigma;
  const coeff  = (mu1 - mu0) / sigma2;                          // ≈ 40.0
  const offset = (mu1 * mu1 - mu0 * mu0) / (2 * sigma2);       // ≈ 0.04

  // risk_state から現在の累積対数尤度比を取得
  const storedLLR = await getRiskStateValue(db, 'sprt_log_likelihood');
  let llr = storedLLR ? parseFloat(storedLLR) : 0;

  // DD開始以降の未評価トレード（sprt_last_evaluated_id 以降）を取得
  const lastEvalId = await getRiskStateValue(db, 'sprt_last_evaluated_id');
  const lastId = lastEvalId ? parseInt(lastEvalId, 10) : 0;

  const trades = await db
    .prepare(
      `SELECT id, pnl FROM positions
       WHERE status = 'CLOSED' AND id > ?
       ORDER BY id ASC LIMIT 50`
    )
    .bind(lastId)
    .all<{ id: number; pnl: number }>();

  const rows = trades.results ?? [];
  if (rows.length === 0) {
    return 'CONTINUE'; // 新規トレードなし
  }

  let maxId = lastId;
  for (const trade of rows) {
    const r_t = trade.pnl / INITIAL_BALANCE;  // リターン（例: +50円 → +0.005）
    llr += coeff * r_t - offset;
    if (trade.id > maxId) maxId = trade.id;
  }

  // 状態を保存
  await setRiskStateValue(db, 'sprt_log_likelihood', llr.toFixed(6));
  await setRiskStateValue(db, 'sprt_last_evaluated_id', maxId.toString());

  // 判定
  if (llr >= upperBound) {
    // H₁採択: 回復と判定 → LLRリセット
    await setRiskStateValue(db, 'sprt_log_likelihood', '0');
    await insertSystemLog(db, 'INFO', 'RISK',
      `SPRT UPGRADE: LLR=${llr.toFixed(3)} >= ${upperBound.toFixed(3)} — 回復判定`,
      `直近${rows.length}件評価`);
    return 'UPGRADE';
  }

  if (llr <= lowerBound) {
    // H₀採択: 悪化と判定 → LLRリセット
    await setRiskStateValue(db, 'sprt_log_likelihood', '0');
    await insertSystemLog(db, 'INFO', 'RISK',
      `SPRT DOWNGRADE: LLR=${llr.toFixed(3)} <= ${lowerBound.toFixed(3)} — 悪化判定`,
      `直近${rows.length}件評価`);
    return 'DOWNGRADE';
  }

  return 'CONTINUE'; // まだ判定不能
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

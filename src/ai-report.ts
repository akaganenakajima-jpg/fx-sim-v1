/**
 * /api/ai-report — 機械可読統合レポート API
 *
 * 設計方針:
 *   - riskRaw:      bypass / dd_stopped を無視した「生の」リスク計算値（常に算出）
 *   - riskEffective: bypass 考慮後の実効値（実際の制御結果）
 *   - monitoringVerdict: サーバー側で導出した監視結論（LLM が数値を誤解釈しないよう補助）
 *   - 純粋関数 (deriveDDLevel / classifyLog / computeVerdict) は DB 不要 → 単体テスト可
 *   - 8本並列クエリで DB ラウンドトリップを最小化
 *
 * ⚠️ INC-20260406-001: bypassMode 判定は globalDDEnabled から導出。
 *   実弾投入後は bypass 関連フィールドを除去し schemaVersion を '3' へ上げること。
 */

import { DD_CAUTION, DD_WARNING, DD_HALT, DD_STOP, INITIAL_CAPITAL } from './constants';
import type { DrawdownLevel } from './risk-manager';

// ─── 定数 ────────────────────────────────────────────────────────

export const AI_REPORT_SCHEMA_VERSION = '2' as const;

// ─── 公開型 ──────────────────────────────────────────────────────

/** イベントコード: システムログから分類したイベントの種別 */
export type EventCode =
  | 'DD_STOP_BYPASSED'        // ADVISORY: STOP 相当だが検証モードで継続
  | 'DD_HALT_BYPASSED'        // ADVISORY: HALT 相当だが検証モードで継続
  | 'DAILY_LOSS_CAP_BYPASSED' // ADVISORY: 日次上限超過だが検証モードで継続
  | 'ENTRY_BLOCKED_DD'        // DD STOP による全銘柄スキップ（実ブロック）
  | 'ENTRY_BLOCKED_DAILY_CAP' // 日次損失上限による全銘柄スキップ（実ブロック）;

/**
 * monitoringVerdict: サーバー側の監視結論
 *  bypass_working       — DD OFF 検証モード中、ADVISORY ログが出ている（正常）
 *  risk_blocking_active — DD ON かつ実際にブロックが発生している
 *  stale_state_suspected — dd_stopped=true だが DD% は STOP 未満（残留フラグ疑い）
 *  healthy_running      — DD ON、リスク指標は正常範囲内
 *  unknown              — 判定条件が不明確
 */
export type MonitoringVerdict =
  | 'bypass_working'
  | 'risk_blocking_active'
  | 'stale_state_suspected'
  | 'healthy_running'
  | 'unknown';

export interface AiReportMeta {
  generatedAt: string;
  schemaVersion: typeof AI_REPORT_SCHEMA_VERSION;
  view: 'summary' | 'full';
  /** ⚠️ INC-20260406-001: true = DD OFF 検証モード中 */
  bypassMode: boolean;
}

/** 生の計算値。bypass / dd_stopped フラグを無視して常に算出 */
export interface AiReportRiskRaw {
  ddPct: number;
  /** ddPct から純粋に導出した DD 段階（bypass/dd_stopped 無視） */
  ddLevelRaw: DrawdownLevel;
  hwm: number;
  balance: number;
  dailyLoss: number;
  dailyCapAmount: number;
  dailyCapExceeded: boolean;
  ddStoppedFlag: boolean;
  globalDDEnabled: boolean;
}

/** bypass 考慮後の実効値（実際の制御に使われる値） */
export interface AiReportRiskEffective {
  /** 実際に適用される DD 段階（bypass=true の場合は常に NORMAL） */
  ddLevel: DrawdownLevel;
  lotMultiplier: number;
  /** true = 取引が実際にブロックされている */
  blocked: boolean;
  /** ⚠️ INC-20260406-001: true = DD OFF 検証モード */
  bypassActive: boolean;
}

export interface OpenPositionItem {
  pair: string;
  direction: string;
  entryRate: number;
  slRate: number | null;
  tpRate: number | null;
  lot: number;
  entryAt: string;
  strategy: string | null;
}

export interface AiReportExecution {
  openCount: number;
  /** view=full のときのみポジション一覧を含む（summary では null） */
  openPositions: OpenPositionItem[] | null;
  /** 最後のエントリー戦略から分類: 'LOGIC' | 'PATH_B' | 戦略名 | null */
  lastEntrySource: string | null;
  /** 直近24h の平均 realized_rr（取引なしは null） */
  recentAvgRR: number | null;
}

export interface Perf24h {
  tradeCount: number;
  totalPnl: number;
  wins: number;
  winRate: number | null;
}

export interface RecentEvent {
  code: EventCode;
  ts: string;
  detail: string;
}

export interface AiReportDiagnostics {
  monitoringVerdict: MonitoringVerdict;
  verdictReason: string;
  recentEvents: RecentEvent[];
}

export interface AiReportHint {
  key: string;
  text: string;
}

export interface AiReportResponse {
  schemaVersion: typeof AI_REPORT_SCHEMA_VERSION;
  meta: AiReportMeta;
  /** 直近24h の損益・勝率サマリー */
  summary: Perf24h;
  riskRaw: AiReportRiskRaw;
  riskEffective: AiReportRiskEffective;
  execution: AiReportExecution;
  diagnostics: AiReportDiagnostics;
  aiHints: AiReportHint[];
}

// ─── 純粋関数（単体テスト可） ─────────────────────────────────────

/**
 * DD% から DD 段階を導出する純粋関数。
 * bypass / dd_stopped を無視した「生の」レベルを返す。
 */
export function deriveDDLevel(ddPct: number): DrawdownLevel {
  if (ddPct >= DD_STOP)    return 'STOP';
  if (ddPct >= DD_HALT)    return 'HALT';
  if (ddPct >= DD_WARNING) return 'WARNING';
  if (ddPct >= DD_CAUTION) return 'CAUTION';
  return 'NORMAL';
}

/**
 * DD 段階から lotMultiplier を導出する純粋関数。
 * Kelly 基準に準拠（テスタ理論）。
 */
export function deriveLotMultiplier(level: DrawdownLevel): number {
  switch (level) {
    case 'STOP':    return 0;
    case 'HALT':    return 0.1;
    case 'WARNING': return 0.25;
    case 'CAUTION': return 0.5;
    case 'NORMAL':  return 1.0;
  }
}

/**
 * strategy カラムから lastEntrySource を分類する純粋関数。
 * - `logic_*` → 'LOGIC'
 * - `path_b*` / `PATH_B` → 'PATH_B'
 * - それ以外 → strategy をそのまま返す
 */
export function classifyEntrySource(strategy: string | null): string | null {
  if (!strategy) return null;
  if (strategy.startsWith('logic_')) return 'LOGIC';
  if (strategy === 'PATH_B' || strategy.startsWith('path_b') || strategy.startsWith('pathb')) return 'PATH_B';
  return strategy;
}

/**
 * システムログのメッセージからイベントコードに分類する純粋関数。
 * null を返した場合はイベントなし（呼び出し側でフィルタアウト）。
 */
export function classifyLog(message: string): EventCode | null {
  if (message.includes('[ADVISORY]')) {
    if (message.includes('DD STOP')) return 'DD_STOP_BYPASSED';
    if (message.includes('DD HALT'))  return 'DD_HALT_BYPASSED';
    if (message.includes('Daily Loss Cap')) return 'DAILY_LOSS_CAP_BYPASSED';
  } else {
    if (message.includes('DD STOP'))      return 'ENTRY_BLOCKED_DD';
    if (message.includes('Daily Loss Cap')) return 'ENTRY_BLOCKED_DAILY_CAP';
  }
  return null;
}

// ─── computeVerdict パラメータ型 ─────────────────────────────────

export interface ComputeVerdictParams {
  bypassMode: boolean;
  ddStoppedFlag: boolean;
  globalDDEnabled: boolean;
  ddLevelRaw: DrawdownLevel;
  dailyCapExceeded: boolean;
  recentEvents: RecentEvent[];
}

/**
 * monitoringVerdict を計算する純粋関数。
 * 優先順位: bypass_working > stale_state_suspected > risk_blocking_active > healthy_running > unknown
 */
export function computeVerdict(params: ComputeVerdictParams): { verdict: MonitoringVerdict; reason: string } {
  const { bypassMode, ddStoppedFlag, globalDDEnabled, ddLevelRaw, dailyCapExceeded, recentEvents } = params;

  // ─ bypass_working: DD OFF 検証モード ─────────────────────────
  if (bypassMode) {
    const hasAdvisory = recentEvents.some(e =>
      e.code === 'DD_STOP_BYPASSED' ||
      e.code === 'DD_HALT_BYPASSED' ||
      e.code === 'DAILY_LOSS_CAP_BYPASSED'
    );
    if (hasAdvisory) {
      return {
        verdict: 'bypass_working',
        reason: 'DD OFF 検証モード中。ADVISORY ログで停止スキップを確認済み。取引は継続しています。',
      };
    }
    return {
      verdict: 'bypass_working',
      reason: 'DD OFF 検証モード中。直近1時間に ADVISORY ログ未発火（閾値未到達 or まだ発火前）。',
    };
  }

  // ─ stale_state_suspected: dd_stopped=true だが DD% < STOP ─
  if (ddStoppedFlag && globalDDEnabled && ddLevelRaw !== 'STOP') {
    return {
      verdict: 'stale_state_suspected',
      reason: `dd_stopped=true だが DD% は STOP 水準（${DD_STOP}%）未満（${ddLevelRaw}）。残留フラグの可能性があります。/api/resume で確認してください。`,
    };
  }

  // ─ risk_blocking_active: DD ON かつブロック発生 ────────────
  if (globalDDEnabled) {
    if (ddStoppedFlag || ddLevelRaw === 'STOP' || dailyCapExceeded) {
      return {
        verdict: 'risk_blocking_active',
        reason: `DD 管理が有効で取引ブロック中 (dd_stopped=${ddStoppedFlag}, level=${ddLevelRaw}, dailyCapExceeded=${dailyCapExceeded})。`,
      };
    }
    // ─ healthy_running: DD ON、リスク正常 ──────────────────
    if (ddLevelRaw === 'NORMAL') {
      return {
        verdict: 'healthy_running',
        reason: `DD 管理有効。DD%・日次損失は正常範囲内 (level=${ddLevelRaw})。`,
      };
    }
    // DD ON + CAUTION/WARNING/HALT だが STOP 未満
    return {
      verdict: 'healthy_running',
      reason: `DD 管理有効。DD% は ${ddLevelRaw} 段階ですがブロックは発生していません。ロット縮小中。`,
    };
  }

  return {
    verdict: 'unknown',
    reason: '判定条件が不明確です。globalDDEnabled の状態を確認してください。',
  };
}

// ─── 内部 DB 型 ─────────────────────────────────────────────────

interface RiskStateRow { key: string; value: string }
interface PnlSumRow   { totalPnl: number }
interface DailyPnlRow { dailyPnl: number }
interface StatsRow    { cnt: number; totalPnl: number; wins: number }
interface AvgRRRow    { avgRR: number | null }
interface OpenPositionRow {
  pair: string; direction: string; entry_rate: number;
  sl_rate: number | null; tp_rate: number | null;
  lot: number; entry_at: string; strategy: string | null;
}
interface LastStrategyRow { strategy: string | null }
interface SystemLogRow    { level: string; category: string; message: string; created_at: string }

// ─── メイン組み立て関数 ──────────────────────────────────────────

/**
 * /api/ai-report 用の構造化 JSON レポートを組み立てる。
 * DB への 8 本並列クエリでレイテンシを最小化。
 *
 * @param db   Cloudflare D1Database
 * @param view 'summary'（デフォルト）または 'full'（オープンポジション一覧含む）
 */
export async function buildAiReport(
  db: D1Database,
  view: 'summary' | 'full' = 'summary',
): Promise<AiReportResponse> {
  const now        = new Date();
  const nowISO     = now.toISOString();
  const h24Ago     = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const h1Ago      = new Date(now.getTime() -      3600 * 1000).toISOString();
  const todayStart = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
  )).toISOString();

  // ── 8本並列 DB クエリ ────────────────────────────────────────
  const [
    riskStateRows,
    balanceRow,
    dailyPnlRow,
    statsRow,
    avgRRRow,
    openRows,
    lastStrategyRow,
    recentLogRows,
  ] = await Promise.all([
    // 1. risk_state: hwm / global_dd_enabled / dd_stopped（1往復で取得）
    db.prepare(
      `SELECT key, value FROM risk_state WHERE key IN ('hwm', 'global_dd_enabled', 'dd_stopped')`
    ).all<RiskStateRow>(),

    // 2. 全期間の実現損益合計（残高計算用）
    db.prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS totalPnl FROM positions WHERE status = 'CLOSED'`
    ).first<PnlSumRow>(),

    // 3. 当日 UTC 0:00〜 の損益（日次 Cap 比較用）
    db.prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS dailyPnl FROM positions WHERE status = 'CLOSED' AND closed_at >= ?`
    ).bind(todayStart).first<DailyPnlRow>(),

    // 4. 直近 24h の取引統計
    db.prepare(
      `SELECT
         COUNT(*)                                                  AS cnt,
         COALESCE(SUM(pnl), 0)                                    AS totalPnl,
         COALESCE(SUM(CASE WHEN realized_rr >= 1.0 THEN 1 ELSE 0 END), 0) AS wins
       FROM positions WHERE status = 'CLOSED' AND closed_at >= ?`
    ).bind(h24Ago).first<StatsRow>(),

    // 5. 直近 24h の平均 realized_rr
    db.prepare(
      `SELECT AVG(realized_rr) AS avgRR
       FROM positions WHERE status = 'CLOSED' AND closed_at >= ? AND realized_rr IS NOT NULL`
    ).bind(h24Ago).first<AvgRRRow>(),

    // 6. オープンポジション全件
    db.prepare(
      `SELECT pair, direction, entry_rate, sl_rate, tp_rate, lot, entry_at, strategy
       FROM positions WHERE status = 'OPEN' ORDER BY entry_at ASC`
    ).all<OpenPositionRow>(),

    // 7. 最後のエントリー（戦略分類用）
    db.prepare(
      `SELECT strategy FROM positions ORDER BY entry_at DESC LIMIT 1`
    ).first<LastStrategyRow>(),

    // 8. 直近 1h のシステムログ（ADVISORY / BLOCK イベント抽出用）
    db.prepare(
      `SELECT level, category, message, created_at
       FROM system_logs WHERE created_at >= ?
       ORDER BY created_at DESC LIMIT 30`
    ).bind(h1Ago).all<SystemLogRow>(),
  ]);

  // ── risk_state パース ─────────────────────────────────────────
  const rsMap = new Map<string, string>();
  for (const row of (riskStateRows.results ?? [])) rsMap.set(row.key, row.value);

  const hwm            = parseFloat(rsMap.get('hwm') ?? String(INITIAL_CAPITAL));
  const globalDDEnabled = (rsMap.get('global_dd_enabled') ?? 'false') === 'true';
  const ddStoppedFlag   = (rsMap.get('dd_stopped') ?? 'false') === 'true';
  const bypassMode      = !globalDDEnabled; // ⚠️ INC-20260406-001

  // ── リスク計算 ────────────────────────────────────────────────
  const balance        = INITIAL_CAPITAL + (balanceRow?.totalPnl ?? 0);
  const ddPct          = hwm > 0 ? ((hwm - balance) / hwm) * 100 : 0;
  const ddLevelRaw     = deriveDDLevel(ddPct);
  const dailyLoss      = dailyPnlRow?.dailyPnl ?? 0;
  const dailyCapAmount = hwm * 0.02;
  const dailyCapExceeded = dailyLoss <= -dailyCapAmount;

  // ── riskEffective: bypass 考慮後の実効値 ─────────────────────
  let effectiveLevel: DrawdownLevel;
  let effectiveLotMul: number;
  let effectiveBlocked: boolean;

  if (bypassMode) {
    // DD OFF: 全停止ロジックをバイパス。常に NORMAL として動く
    effectiveLevel   = 'NORMAL';
    effectiveLotMul  = 1.0;
    effectiveBlocked = false;
  } else if (ddStoppedFlag) {
    // DD ON + dd_stopped=true: 残留フラグまたは真の STOP
    effectiveLevel   = 'STOP';
    effectiveLotMul  = 0;
    effectiveBlocked = true;
  } else {
    effectiveLevel   = ddLevelRaw;
    effectiveLotMul  = deriveLotMultiplier(ddLevelRaw);
    effectiveBlocked = ddLevelRaw === 'STOP' || dailyCapExceeded;
  }

  // ── イベント分類 ──────────────────────────────────────────────
  const recentEvents: RecentEvent[] = [];
  for (const log of (recentLogRows.results ?? [])) {
    const code = classifyLog(log.message);
    if (code) {
      recentEvents.push({
        code,
        ts:     log.created_at,
        detail: log.message.slice(0, 120),
      });
    }
  }

  // ── monitoringVerdict ─────────────────────────────────────────
  const { verdict, reason } = computeVerdict({
    bypassMode, ddStoppedFlag, globalDDEnabled,
    ddLevelRaw, dailyCapExceeded, recentEvents,
  });

  // ── 統計 ─────────────────────────────────────────────────────
  const stats     = statsRow ?? { cnt: 0, totalPnl: 0, wins: 0 };
  const winRate24h = stats.cnt > 0 ? stats.wins / stats.cnt : null;

  // ── オープンポジション（full のみ展開） ───────────────────────
  const openArr = openRows.results ?? [];
  const openPositions: OpenPositionItem[] | null = view === 'full'
    ? openArr.map(p => ({
        pair:      p.pair,
        direction: p.direction,
        entryRate: p.entry_rate,
        slRate:    p.sl_rate,
        tpRate:    p.tp_rate,
        lot:       p.lot,
        entryAt:   p.entry_at,
        strategy:  p.strategy,
      }))
    : null;

  // ── aiHints ──────────────────────────────────────────────────
  const aiHints: AiReportHint[] = [];

  if (bypassMode) {
    aiHints.push({
      key:  'bypass_mode', // ⚠️ INC-20260406-001
      text: 'DD 管理は現在 OFF（検証モード）です。DD%・日次損失が閾値を超えても取引は止まりません。' +
            '実弾投入前に /api/dd-toggle で DD を ON にしてください。',
    });
  }
  if (ddStoppedFlag && !bypassMode) {
    aiHints.push({
      key:  'dd_stopped',
      text: 'dd_stopped フラグが true です。システムは完全停止状態です。' +
            '/api/resume を POST するか DD 管理をリセットしてください。',
    });
  }
  if (!bypassMode && ddPct >= DD_WARNING) {
    aiHints.push({
      key:  'dd_high',
      text: `DD% が ${ddPct.toFixed(1)}% です。WARNING 水準（${DD_WARNING}%）` +
            `${ddPct >= DD_HALT ? ` を超えて HALT（${DD_HALT}%）` : ''} 段階。` +
            `ロット縮小係数: ${effectiveLotMul}。`,
    });
  }

  // ── レスポンス組み立て ─────────────────────────────────────────
  return {
    schemaVersion: AI_REPORT_SCHEMA_VERSION,
    meta: {
      generatedAt: nowISO,
      schemaVersion: AI_REPORT_SCHEMA_VERSION,
      view,
      bypassMode,
    },
    summary: {
      tradeCount: stats.cnt,
      totalPnl:   Math.round(stats.totalPnl * 100) / 100,
      wins:       stats.wins,
      winRate:    winRate24h,
    },
    riskRaw: {
      ddPct:           Math.round(ddPct * 100) / 100,
      ddLevelRaw,
      hwm:             Math.round(hwm * 100) / 100,
      balance:         Math.round(balance * 100) / 100,
      dailyLoss:       Math.round(dailyLoss * 100) / 100,
      dailyCapAmount:  Math.round(dailyCapAmount * 100) / 100,
      dailyCapExceeded,
      ddStoppedFlag,
      globalDDEnabled,
    },
    riskEffective: {
      ddLevel:       effectiveLevel,
      lotMultiplier: effectiveLotMul,
      blocked:       effectiveBlocked,
      bypassActive:  bypassMode,
    },
    execution: {
      openCount:       openArr.length,
      openPositions,
      lastEntrySource: classifyEntrySource(lastStrategyRow?.strategy ?? null),
      recentAvgRR:     avgRRRow?.avgRR != null ? Math.round(avgRRRow.avgRR * 1000) / 1000 : null,
    },
    diagnostics: {
      monitoringVerdict: verdict,
      verdictReason:     reason,
      recentEvents,
    },
    aiHints,
  };
}

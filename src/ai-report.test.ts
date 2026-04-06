/**
 * ai-report.ts ユニットテスト
 *
 * 純粋関数（deriveDDLevel / deriveLotMultiplier / classifyLog /
 * classifyEntrySource / computeVerdict）を DB モックなしでテスト。
 *
 * ⚠️ INC-20260406-001: bypassMode / bypass 関連ケースを含む。
 *   実弾投入前に bypassMode=true のケースを削除すること。
 */
import { describe, it, expect } from 'vitest';
import {
  deriveDDLevel,
  deriveLotMultiplier,
  classifyLog,
  classifyEntrySource,
  computeVerdict,
  type ComputeVerdictParams,
  type RecentEvent,
} from './ai-report';

// ─── deriveDDLevel ────────────────────────────────────────────────

describe('deriveDDLevel', () => {
  it('0% → NORMAL',   () => expect(deriveDDLevel(0)).toBe('NORMAL'));
  it('6.9% → NORMAL', () => expect(deriveDDLevel(6.9)).toBe('NORMAL'));
  it('7% → CAUTION',  () => expect(deriveDDLevel(7)).toBe('CAUTION'));
  it('9.9% → CAUTION',() => expect(deriveDDLevel(9.9)).toBe('CAUTION'));
  it('10% → WARNING', () => expect(deriveDDLevel(10)).toBe('WARNING'));
  it('14.9% → WARNING',()=> expect(deriveDDLevel(14.9)).toBe('WARNING'));
  it('15% → HALT',    () => expect(deriveDDLevel(15)).toBe('HALT'));
  it('19.9% → HALT',  () => expect(deriveDDLevel(19.9)).toBe('HALT'));
  it('20% → STOP',    () => expect(deriveDDLevel(20)).toBe('STOP'));
  it('25% → STOP',    () => expect(deriveDDLevel(25)).toBe('STOP'));
});

// ─── deriveLotMultiplier ─────────────────────────────────────────

describe('deriveLotMultiplier', () => {
  it('STOP → 0',      () => expect(deriveLotMultiplier('STOP')).toBe(0));
  it('HALT → 0.1',    () => expect(deriveLotMultiplier('HALT')).toBe(0.1));
  it('WARNING → 0.25',() => expect(deriveLotMultiplier('WARNING')).toBe(0.25));
  it('CAUTION → 0.5', () => expect(deriveLotMultiplier('CAUTION')).toBe(0.5));
  it('NORMAL → 1.0',  () => expect(deriveLotMultiplier('NORMAL')).toBe(1.0));
});

// ─── classifyLog ────────────────────────────────────────────────

describe('classifyLog', () => {
  // ADVISORY 系（検証モードのバイパスログ）
  it('[ADVISORY] DD STOP相当 → DD_STOP_BYPASSED', () => {
    expect(classifyLog('[ADVISORY] DD STOP相当(22.0%) — 検証モードのためエントリー継続')).toBe('DD_STOP_BYPASSED');
  });
  it('[ADVISORY] DD STOP: ... → DD_STOP_BYPASSED（applyDrawdownControl の ADVISORY ログ）', () => {
    expect(classifyLog('[ADVISORY] DD STOP相当: 22.0% — 検証モードのため停止しない')).toBe('DD_STOP_BYPASSED');
  });
  it('[ADVISORY] DD HALT → DD_HALT_BYPASSED', () => {
    expect(classifyLog('[ADVISORY] DD HALT: 16.0% — lotMult=0.1で継続')).toBe('DD_HALT_BYPASSED');
  });
  it('[ADVISORY] Daily Loss Cap超過 → DAILY_LOSS_CAP_BYPASSED', () => {
    expect(classifyLog('[ADVISORY] Daily Loss Cap超過(-2095.84円) — 検証モードのためスキップなし')).toBe('DAILY_LOSS_CAP_BYPASSED');
  });

  // ブロック系（実弾モードでの実ブロック）
  it('DD STOP（ADVISORY なし） → ENTRY_BLOCKED_DD', () => {
    expect(classifyLog('DD STOP: ロジックエントリー全銘柄スキップ')).toBe('ENTRY_BLOCKED_DD');
  });
  it('Daily Loss Cap（ADVISORY なし） → ENTRY_BLOCKED_DAILY_CAP', () => {
    expect(classifyLog('Daily Loss Cap: 当日損失 -250.00円 >= 上限 200.00円 — 全銘柄スキップ')).toBe('ENTRY_BLOCKED_DAILY_CAP');
  });

  // 無関係なログ
  it('通常の LOGIC 完了ログ → null', () => {
    expect(classifyLog('LOGIC完了: 5件エントリー / 41件スキップ')).toBeNull();
  });
  it('空文字 → null', () => {
    expect(classifyLog('')).toBeNull();
  });
  it('PATH_B エントリーログ → null', () => {
    expect(classifyLog('PATH_B ENTRY: USD/JPY BUY lot=0.01')).toBeNull();
  });
});

// ─── classifyEntrySource ─────────────────────────────────────────

describe('classifyEntrySource', () => {
  it('logic_bb_breakout → LOGIC', () => expect(classifyEntrySource('logic_bb_breakout')).toBe('LOGIC'));
  it('logic_trend       → LOGIC', () => expect(classifyEntrySource('logic_trend')).toBe('LOGIC'));
  it('logic_            → LOGIC', () => expect(classifyEntrySource('logic_')).toBe('LOGIC'));
  it('path_b            → PATH_B', () => expect(classifyEntrySource('path_b')).toBe('PATH_B'));
  it('path_b_emergency  → PATH_B', () => expect(classifyEntrySource('path_b_emergency')).toBe('PATH_B'));
  it('PATH_B            → PATH_B', () => expect(classifyEntrySource('PATH_B')).toBe('PATH_B'));
  it('pathb_signal      → PATH_B', () => expect(classifyEntrySource('pathb_signal')).toBe('PATH_B'));
  it('null              → null',   () => expect(classifyEntrySource(null)).toBeNull());
  it('空文字            → 空文字', () => expect(classifyEntrySource('')).toBeNull());
  it('unknown_strat     → そのまま返す', () => expect(classifyEntrySource('custom_strat')).toBe('custom_strat'));
});

// ─── computeVerdict ─────────────────────────────────────────────

describe('computeVerdict', () => {
  const noEvents: RecentEvent[] = [];
  const advisoryStopEvents: RecentEvent[] = [
    { code: 'DD_STOP_BYPASSED', ts: '2026-04-06T06:27:00Z', detail: '[ADVISORY] DD STOP相当...' },
  ];
  const advisoryCapEvents: RecentEvent[] = [
    { code: 'DAILY_LOSS_CAP_BYPASSED', ts: '2026-04-06T06:28:00Z', detail: '[ADVISORY] Daily Loss Cap超過...' },
  ];
  const blockEvents: RecentEvent[] = [
    { code: 'ENTRY_BLOCKED_DD', ts: '2026-04-06T06:27:00Z', detail: 'DD STOP: 全銘柄スキップ' },
  ];

  // ⚠️ INC-20260406-001: バイパスモード系テスト ──────────────────
  it('bypass=true + ADVISORY ログあり → bypass_working', () => {
    const params: ComputeVerdictParams = {
      bypassMode: true, ddStoppedFlag: false, globalDDEnabled: false,
      ddLevelRaw: 'STOP', dailyCapExceeded: true,
      recentEvents: advisoryStopEvents,
    };
    expect(computeVerdict(params).verdict).toBe('bypass_working');
  });
  it('bypass=true + ADVISORY なし + ddLevel=STOP → bypass_working（まだ発火前）', () => {
    const params: ComputeVerdictParams = {
      bypassMode: true, ddStoppedFlag: false, globalDDEnabled: false,
      ddLevelRaw: 'STOP', dailyCapExceeded: false,
      recentEvents: noEvents,
    };
    expect(computeVerdict(params).verdict).toBe('bypass_working');
  });
  it('bypass=true + 日次Cap ADVISORY → bypass_working', () => {
    const params: ComputeVerdictParams = {
      bypassMode: true, ddStoppedFlag: false, globalDDEnabled: false,
      ddLevelRaw: 'NORMAL', dailyCapExceeded: true,
      recentEvents: advisoryCapEvents,
    };
    expect(computeVerdict(params).verdict).toBe('bypass_working');
  });
  it('bypass=true + NORMAL + noEvents → bypass_working（リスク正常）', () => {
    const params: ComputeVerdictParams = {
      bypassMode: true, ddStoppedFlag: false, globalDDEnabled: false,
      ddLevelRaw: 'NORMAL', dailyCapExceeded: false,
      recentEvents: noEvents,
    };
    expect(computeVerdict(params).verdict).toBe('bypass_working');
  });

  // stale_state_suspected ──────────────────────────────────────
  it('DD ON + dd_stopped=true + level=NORMAL → stale_state_suspected', () => {
    const params: ComputeVerdictParams = {
      bypassMode: false, ddStoppedFlag: true, globalDDEnabled: true,
      ddLevelRaw: 'NORMAL', dailyCapExceeded: false,
      recentEvents: noEvents,
    };
    expect(computeVerdict(params).verdict).toBe('stale_state_suspected');
  });
  it('DD ON + dd_stopped=true + level=CAUTION → stale_state_suspected', () => {
    const params: ComputeVerdictParams = {
      bypassMode: false, ddStoppedFlag: true, globalDDEnabled: true,
      ddLevelRaw: 'CAUTION', dailyCapExceeded: false,
      recentEvents: noEvents,
    };
    expect(computeVerdict(params).verdict).toBe('stale_state_suspected');
  });

  // risk_blocking_active ────────────────────────────────────────
  it('DD ON + ddLevel=STOP → risk_blocking_active', () => {
    const params: ComputeVerdictParams = {
      bypassMode: false, ddStoppedFlag: false, globalDDEnabled: true,
      ddLevelRaw: 'STOP', dailyCapExceeded: false,
      recentEvents: noEvents,
    };
    expect(computeVerdict(params).verdict).toBe('risk_blocking_active');
  });
  it('DD ON + dd_stopped=true + level=STOP → risk_blocking_active', () => {
    const params: ComputeVerdictParams = {
      bypassMode: false, ddStoppedFlag: true, globalDDEnabled: true,
      ddLevelRaw: 'STOP', dailyCapExceeded: false,
      recentEvents: blockEvents,
    };
    expect(computeVerdict(params).verdict).toBe('risk_blocking_active');
  });
  it('DD ON + dailyCapExceeded=true → risk_blocking_active', () => {
    const params: ComputeVerdictParams = {
      bypassMode: false, ddStoppedFlag: false, globalDDEnabled: true,
      ddLevelRaw: 'NORMAL', dailyCapExceeded: true,
      recentEvents: noEvents,
    };
    expect(computeVerdict(params).verdict).toBe('risk_blocking_active');
  });

  // healthy_running ─────────────────────────────────────────────
  it('DD ON + NORMAL + no issues → healthy_running', () => {
    const params: ComputeVerdictParams = {
      bypassMode: false, ddStoppedFlag: false, globalDDEnabled: true,
      ddLevelRaw: 'NORMAL', dailyCapExceeded: false,
      recentEvents: noEvents,
    };
    expect(computeVerdict(params).verdict).toBe('healthy_running');
  });
  it('DD ON + WARNING（ブロックなし）→ healthy_running（ロット縮小中）', () => {
    const params: ComputeVerdictParams = {
      bypassMode: false, ddStoppedFlag: false, globalDDEnabled: true,
      ddLevelRaw: 'WARNING', dailyCapExceeded: false,
      recentEvents: noEvents,
    };
    expect(computeVerdict(params).verdict).toBe('healthy_running');
  });

  // reason が含まれること ────────────────────────────────────────
  it('computeVerdict は reason 文字列を返す', () => {
    const params: ComputeVerdictParams = {
      bypassMode: false, ddStoppedFlag: false, globalDDEnabled: true,
      ddLevelRaw: 'NORMAL', dailyCapExceeded: false,
      recentEvents: noEvents,
    };
    const { reason } = computeVerdict(params);
    expect(typeof reason).toBe('string');
    expect(reason.length).toBeGreaterThan(0);
  });
});

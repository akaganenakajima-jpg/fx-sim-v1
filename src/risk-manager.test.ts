/**
 * risk-manager.ts ユニットテスト
 *
 * ⚠️ ユーザー指示による仕様テスト（2026-04-01）
 * - 総合DD: global_dd_enabled='false'/null → 常に NORMAL。バグではない。
 * - 市場別DD: 市場クローズ遷移で dd_stopped 自動クリア。バグではない。
 */
import { describe, it, expect } from 'vitest';
import { isGlobalDDEnabled, setGlobalDDEnabled, isMarketOpen, checkMarketCloseAndReleaseDDStop, getDrawdownLevel, isPaperTestBypassMode, clearDDStoppedFlag, checkDailyLossCap, checkInstrumentDailyLoss, applyDrawdownControl } from './risk-manager';

// ─── D1Database ミニマルモック ───────────────────────────────────────────────

function makeDb(kvStore: Record<string, string> = {}): D1Database & { _store: Record<string, string> } {
  const store = { ...kvStore };

  // SQLに応じたfirstレスポンスを生成（bind引数あり・なし共通）
  function resolveFirst(sql: string, args: unknown[]) {
    return async () => {
      // positions テーブル操作 → null（totalPnl=0相当）
      if (sql.includes('FROM positions')) return null;
      // system_logs INSERT → null
      if (sql.includes('system_logs') || sql.includes('INSERT INTO system')) return null;
      // risk_state SELECT → キーで引く
      if (sql.includes('FROM risk_state') || sql.includes('risk_state WHERE')) {
        const key = args[0] as string;
        const val = store[key];
        return val !== undefined ? { value: val } : null;
      }
      return null;
    };
  }

  const db = {
    _store: store,
    prepare: (sql: string) => {
      const stmt = {
        // bind あり
        bind: (...args: unknown[]) => ({
          first: resolveFirst(sql, args),
          run: async () => {
            if (sql.includes('risk_state')) {
              const key = args[0] as string;
              const value = args[1] as string;
              store[key] = value;
            }
            return {};
          },
          all: async () => ({ results: [] }),
        }),
        // bind なし（直接 first/run/all）
        first: resolveFirst(sql, []),
        run: async () => ({}),
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & { _store: Record<string, string> };
}

// ─── isGlobalDDEnabled ───────────────────────────────────────────────────────

describe('isGlobalDDEnabled', () => {
  it('risk_state に global_dd_enabled がない場合は false（未設定=OFF）', async () => {
    const db = makeDb({});
    expect(await isGlobalDDEnabled(db)).toBe(false);
  });

  it("global_dd_enabled='false' の場合は false", async () => {
    const db = makeDb({ global_dd_enabled: 'false' });
    expect(await isGlobalDDEnabled(db)).toBe(false);
  });

  it("global_dd_enabled='true' の場合は true", async () => {
    const db = makeDb({ global_dd_enabled: 'true' });
    expect(await isGlobalDDEnabled(db)).toBe(true);
  });
});

// ─── setGlobalDDEnabled ──────────────────────────────────────────────────────

describe('setGlobalDDEnabled', () => {
  it('true を書き込んだ後に isGlobalDDEnabled が true を返す', async () => {
    const db = makeDb({});
    await setGlobalDDEnabled(db, true);
    expect(await isGlobalDDEnabled(db)).toBe(true);
  });

  it('false を書き込んだ後に isGlobalDDEnabled が false を返す', async () => {
    const db = makeDb({ global_dd_enabled: 'true' });
    await setGlobalDDEnabled(db, false);
    expect(await isGlobalDDEnabled(db)).toBe(false);
  });
});

// ─── getDrawdownLevel — グローバルトグル動作 ────────────────────────────────

describe('getDrawdownLevel — globalDDEnabled=false', () => {
  it('global_dd_enabled=false のとき dd_stopped=true でも NORMAL を返す', async () => {
    const db = makeDb({
      global_dd_enabled: 'false',
      dd_stopped: 'true',
      hwm: '10000',
    });
    const result = await getDrawdownLevel(db);
    expect(result.level).toBe('NORMAL');
    expect(result.lotMultiplier).toBe(1.0);
  });

  it('global_dd_enabled 未設定のとき NORMAL を返す（null=false）', async () => {
    const db = makeDb({ dd_stopped: 'true', hwm: '10000' });
    const result = await getDrawdownLevel(db);
    expect(result.level).toBe('NORMAL');
    expect(result.lotMultiplier).toBe(1.0);
  });

  it('global_dd_enabled=true のとき dd_stopped=true なら STOP を返す', async () => {
    const db = makeDb({
      global_dd_enabled: 'true',
      dd_stopped: 'true',
      hwm: '10000',
    });
    const result = await getDrawdownLevel(db);
    expect(result.level).toBe('STOP');
    expect(result.lotMultiplier).toBe(0);
  });
});

// ─── isMarketOpen ────────────────────────────────────────────────────────────

describe('isMarketOpen', () => {
  /** UTC指定でDate生成（2026-03-30月曜起点） */
  function utc(weekday: number, hour: number, min = 0): Date {
    const base = new Date('2026-03-30T00:00:00Z');
    base.setUTCDate(base.getUTCDate() + (weekday - 1));
    base.setUTCHours(hour, min, 0, 0);
    return base;
  }

  describe('forex（21:00 UTC月〜金クローズ）', () => {
    it('月曜10:00 UTC → open', () => expect(isMarketOpen('forex', utc(1, 10))).toBe(true));
    it('金曜20:59 UTC → open', () => expect(isMarketOpen('forex', utc(5, 20, 59))).toBe(true));
    it('金曜21:00 UTC → closed', () => expect(isMarketOpen('forex', utc(5, 21))).toBe(false));
    it('土曜10:00 UTC → closed（週末）', () => expect(isMarketOpen('forex', utc(6, 10))).toBe(false));
    it('日曜10:00 UTC → closed（週末）', () => expect(isMarketOpen('forex', new Date('2026-04-05T10:00:00Z'))).toBe(false));
  });

  describe('crypto（00:00 UTC 日次リセット — ユーザー指示仕様）', () => {
    it('月曜10:00 UTC → open', () => expect(isMarketOpen('crypto', utc(1, 10))).toBe(true));
    it('月曜23:59 UTC → open', () => expect(isMarketOpen('crypto', utc(1, 23, 59))).toBe(true));
    it('火曜00:00 UTC → closed（日次リセット）', () => expect(isMarketOpen('crypto', utc(2, 0, 0))).toBe(false));
    it('土曜10:00 UTC → open（crypto は週末も取引可能）', () => expect(isMarketOpen('crypto', utc(6, 10))).toBe(true));
  });

  describe('stock（21:00 UTC = US close）', () => {
    it('月曜10:00 UTC → open', () => expect(isMarketOpen('stock', utc(1, 10))).toBe(true));
    it('月曜20:59 UTC → open', () => expect(isMarketOpen('stock', utc(1, 20, 59))).toBe(true));
    it('月曜21:00 UTC → closed', () => expect(isMarketOpen('stock', utc(1, 21))).toBe(false));
    it('土曜10:00 UTC → closed（週末）', () => expect(isMarketOpen('stock', utc(6, 10))).toBe(false));
  });

  describe('index / commodity', () => {
    it('月曜20:59 UTC → open', () => expect(isMarketOpen('index', utc(1, 20, 59))).toBe(true));
    it('月曜21:00 UTC → closed', () => expect(isMarketOpen('index', utc(1, 21))).toBe(false));
    it('commodity 月曜20:59 UTC → open', () => expect(isMarketOpen('commodity', utc(1, 20, 59))).toBe(true));
    it('commodity 月曜21:00 UTC → closed', () => expect(isMarketOpen('commodity', utc(1, 21))).toBe(false));
  });
});

// ─── checkMarketCloseAndReleaseDDStop ───────────────────────────────────────

describe('checkMarketCloseAndReleaseDDStop', () => {
  function utc(weekday: number, hour: number, min = 0): Date {
    const base = new Date('2026-03-30T00:00:00Z');
    base.setUTCDate(base.getUTCDate() + (weekday - 1));
    base.setUTCHours(hour, min, 0, 0);
    return base;
  }

  it('金曜21:00 UTC: market_open:forex が true→false に遷移 → dd_stopped:forex をクリア', async () => {
    const db = makeDb({
      'market_open:forex': 'true',
      'dd_stopped:forex': 'true',
    });
    await checkMarketCloseAndReleaseDDStop(db, utc(5, 21));
    expect(db._store['dd_stopped:forex']).toBe('false');
    expect(db._store['market_open:forex']).toBe('false');
  });

  it('土曜（forex既にclosed）: false→false なので dd_stopped はクリアされない', async () => {
    const db = makeDb({
      'market_open:forex': 'false',
      'dd_stopped:forex': 'true',
    });
    await checkMarketCloseAndReleaseDDStop(db, utc(6, 10));
    expect(db._store['dd_stopped:forex']).toBe('true');
  });

  it('dd_stopped:forex が存在しない場合もエラーなし', async () => {
    const db = makeDb({ 'market_open:forex': 'true' });
    await expect(checkMarketCloseAndReleaseDDStop(db, utc(5, 21))).resolves.not.toThrow();
  });

  it('crypto 00:00 UTC: market_open:crypto が true→false に遷移 → dd_stopped:crypto をクリア', async () => {
    const db = makeDb({
      'market_open:crypto': 'true',
      'dd_stopped:crypto': 'true',
    });
    // 火曜 00:00 UTC
    await checkMarketCloseAndReleaseDDStop(db, utc(2, 0));
    expect(db._store['dd_stopped:crypto']).toBe('false');
  });

  it('market_open 未設定（初回）: 遷移ありと見なしてクリアする（wasOpen=true として扱う）', async () => {
    const db = makeDb({
      'dd_stopped:forex': 'true',
      // market_open:forex は未設定
    });
    await checkMarketCloseAndReleaseDDStop(db, utc(5, 21)); // 金曜21:00 closed
    // wasOpen=true（未設定はtrue扱い）、currentlyOpen=false → クリアされる
    expect(db._store['dd_stopped:forex']).toBe('false');
  });
});

// ─── isPaperTestBypassMode ─────────────────────────────────────────────────
// ⚠️ INC-20260406-001: 検証モードのテスト。実弾投入前にこのテストブロックを削除すること。

describe('isPaperTestBypassMode', () => {
  it('global_dd_enabled=false のとき true（バイパス有効）', async () => {
    const db = makeDb({ global_dd_enabled: 'false' });
    expect(await isPaperTestBypassMode(db)).toBe(true);
  });

  it('global_dd_enabled 未設定のとき true（デフォルトOFF=バイパス有効）', async () => {
    const db = makeDb({});
    expect(await isPaperTestBypassMode(db)).toBe(true);
  });

  it('global_dd_enabled=true のとき false（バイパス無効 = 実弾モード）', async () => {
    const db = makeDb({ global_dd_enabled: 'true' });
    expect(await isPaperTestBypassMode(db)).toBe(false);
  });
});

// ─── checkDailyLossCap — バイパスモード ─────────────────────────────────────
// ⚠️ INC-20260406-001: bypass=true テスト

describe('checkDailyLossCap — bypass=true', () => {
  it('日次損失が上限超過していても bypass=true なら capped=false を返す', async () => {
    // HWM=10000, capPct=0.02 → capAmount=200円
    // dailyLoss が -300円（上限超過）でも capped=false
    const db = makeDb({ hwm: '10000' });
    // positions テーブルのモックに-300円を返すよう拡張
    const origPrepare = (db as any).prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (sql.includes('FROM positions') && sql.includes('SUM(pnl)') && !sql.includes('pair =')) {
        return {
          bind: (..._a: unknown[]) => ({
            first: async () => ({ dailyPnl: -300 }),
            run: async () => ({}),
            all: async () => ({ results: [] }),
          }),
        };
      }
      return origPrepare(sql);
    };
    const result = await checkDailyLossCap(db, new Date(), 0.02, true);
    expect(result.capped).toBe(false);
    expect(result.bypassed).toBe(true);
    expect(result.dailyLoss).toBe(-300); // 損失額は正しく計算される
  });

  it('bypass=false（デフォルト）のとき上限超過で capped=true を返す', async () => {
    const db = makeDb({ hwm: '10000' });
    const origPrepare = (db as any).prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (sql.includes('FROM positions') && sql.includes('SUM(pnl)') && !sql.includes('pair =')) {
        return {
          bind: (..._a: unknown[]) => ({
            first: async () => ({ dailyPnl: -300 }),
            run: async () => ({}),
            all: async () => ({ results: [] }),
          }),
        };
      }
      return origPrepare(sql);
    };
    const result = await checkDailyLossCap(db, new Date(), 0.02, false);
    expect(result.capped).toBe(true);
    expect(result.bypassed).toBeUndefined();
  });
});

// ─── checkInstrumentDailyLoss — バイパスモード ───────────────────────────────
// ⚠️ INC-20260406-001

describe('checkInstrumentDailyLoss — bypass=true', () => {
  it('銘柄日次損失が上限超過していても bypass=true なら paused=false を返す', async () => {
    const db = makeDb({});
    const origPrepare = (db as any).prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (sql.includes('FROM positions') && sql.includes('pair =')) {
        return {
          bind: (..._a: unknown[]) => ({
            first: async () => ({ dailyPnl: -9999 }), // 上限を大幅超過
            run: async () => ({}),
            all: async () => ({ results: [] }),
          }),
        };
      }
      return origPrepare(sql);
    };
    const result = await checkInstrumentDailyLoss(db, 'USD/JPY', new Date(), true);
    expect(result.paused).toBe(false);
    expect(result.bypassed).toBe(true);
  });

  it('bypass=false（デフォルト）のとき上限超過で paused=true を返す', async () => {
    const db = makeDb({});
    const origPrepare = (db as any).prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (sql.includes('FROM positions') && sql.includes('pair =')) {
        return {
          bind: (..._a: unknown[]) => ({
            first: async () => ({ dailyPnl: -9999 }),
            run: async () => ({}),
            all: async () => ({ results: [] }),
          }),
        };
      }
      return origPrepare(sql);
    };
    const result = await checkInstrumentDailyLoss(db, 'USD/JPY', new Date(), false);
    expect(result.paused).toBe(true);
    expect(result.bypassed).toBeUndefined();
  });
});

// ─── applyDrawdownControl — バイパスモード ─────────────────────────────────
// ⚠️ INC-20260406-001

describe('applyDrawdownControl — bypass=true', () => {
  it('bypass=true のとき STOP でも dd_stopped フラグを書き込まない', async () => {
    const db = makeDb({ global_dd_enabled: 'false', hwm: '10000' });
    const stopResult = { level: 'STOP' as const, ddPct: 22.0, hwm: 10000, balance: 7800, lotMultiplier: 0 };
    await applyDrawdownControl(db, stopResult, true);
    // dd_stopped が 'true' に書き込まれていないことを確認
    expect(db._store['dd_stopped']).not.toBe('true');
  });

  it('bypass=false のとき STOP で dd_stopped=true が書き込まれる', async () => {
    const db = makeDb({ global_dd_enabled: 'true', hwm: '10000' });
    const stopResult = { level: 'STOP' as const, ddPct: 22.0, hwm: 10000, balance: 7800, lotMultiplier: 0 };
    await applyDrawdownControl(db, stopResult, false);
    expect(db._store['dd_stopped']).toBe('true');
  });
});

// ─── clearDDStoppedFlag ─────────────────────────────────────────────────────
// ⚠️ INC-20260406-001

describe('clearDDStoppedFlag', () => {
  it('dd_stopped=true の状態から clearDDStoppedFlag を呼ぶと false になる', async () => {
    const db = makeDb({ dd_stopped: 'true' });
    await clearDDStoppedFlag(db);
    expect(db._store['dd_stopped']).toBe('false');
  });

  it('DD OFF → ON 遷移時に stale flag が悪さしない（clears before re-enable）', async () => {
    // DD ONにする前に clearDDStoppedFlag を呼ぶことで即STOPを防ぐシナリオ
    const db = makeDb({ global_dd_enabled: 'false', dd_stopped: 'true' });
    await clearDDStoppedFlag(db);
    await setGlobalDDEnabled(db, true);
    // DD ON 後、dd_stopped が false → STOP にならない
    const result = await getDrawdownLevel(db);
    expect(result.level).not.toBe('STOP');
  });
});

// ─── getDrawdownLevel — bypass mode（INC-20260406-001 保証） ───────────────
// bypass mode では getDrawdownLevel() が lotMultiplier=1.0 を保証する。
// 「bypass=true なのに ddLotMult=0 で LOT_ZERO になる」経路は存在しないことを確認。
// ⚠️ INC-20260406-001: 実弾投入前にこのテストブロックを削除すること。

describe('getDrawdownLevel — DD OFF(bypass)時は必ず lotMultiplier=1.0', () => {
  it('global_dd_enabled=false + dd_stopped=true でも lotMultiplier=1.0', async () => {
    // dd_stopped=true は DD ON 時のみ有効。DD OFF では無視される。
    const db = makeDb({ global_dd_enabled: 'false', dd_stopped: 'true', hwm: '10000', balance: '7000' });
    const result = await getDrawdownLevel(db);
    expect(result.lotMultiplier).toBe(1.0);
    expect(result.level).toBe('NORMAL');
  });

  it('global_dd_enabled=false + ddPct=30%(STOP相当) でも lotMultiplier=1.0', async () => {
    // DD OFF なら DD% が STOP閾値(20%)超でも lot=0 にならない保証
    const db = makeDb({ global_dd_enabled: 'false', dd_stopped: 'false', hwm: '10000' });
    // getCurrentBalance が 7000 を返すよう balance をオーバーライド
    const origPrepare = (db as any).prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (sql.includes('risk_state') && sql.includes('current_balance')) {
        return { bind: (..._a: unknown[]) => ({ first: async () => ({ value: '7000' }), run: async () => ({}), all: async () => ({ results: [] }) }) };
      }
      return origPrepare(sql);
    };
    const result = await getDrawdownLevel(db);
    expect(result.lotMultiplier).toBe(1.0);
    expect(result.level).toBe('NORMAL');
  });

  it('global_dd_enabled=true + ddPct=30%(STOP) → lotMultiplier=0（実弾モードは正常にブロック）', async () => {
    // DD ON ではブロックされることを確認（上記テストとの対比）
    const db = makeDb({ global_dd_enabled: 'true', dd_stopped: 'true', hwm: '10000' });
    const result = await getDrawdownLevel(db);
    expect(result.lotMultiplier).toBe(0);
    expect(result.level).toBe('STOP');
  });
});

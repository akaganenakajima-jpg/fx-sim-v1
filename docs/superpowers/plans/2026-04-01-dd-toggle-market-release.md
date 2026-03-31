# 総合DDトグル + 市場別DD自動解除 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 総合DD管理のON/OFFをフロントエンドスイッチで制御し、市場別DDストップを日次クローズ時に自動解除する。

**Architecture:** `risk-manager.ts` に `isGlobalDDEnabled` / `checkMarketCloseAndReleaseDDStop` を追加。`getDrawdownLevel()` の冒頭でグローバルトグルをチェック。`runCore()`（1分cron）の末尾で市場クローズ遷移を検出。フロントのリスクタブにApple HIGトグルスイッチを配置し `POST /api/settings` で切り替え。

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare D1, Vitest

---

## ファイルマップ

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `src/risk-manager.ts` | Modify | `isGlobalDDEnabled`, `setGlobalDDEnabled`, `isMarketOpen`, `checkMarketCloseAndReleaseDDStop` 追加。`getDrawdownLevel()` 冒頭にトグルチェック追加 |
| `src/risk-manager.test.ts` | **Create** | 全新規テスト（Vitest / D1モックなし純粋関数テスト） |
| `src/api.ts` | Modify | `StatusResponse` に `globalDDEnabled: boolean` 追加。`getApiStatus()` の return に `globalDDEnabled` 追加 |
| `src/index.ts` | Modify | `runCore()` 末尾に `checkMarketCloseAndReleaseDDStop()` 呼び出し追加。`/api/settings` POSTルート追加 |
| `src/app.js.ts` | Modify | リスクタブ DD段階表示の直上にトグルスイッチHTMLと操作ロジック追加 |

---

## ⚠️ 仕様記録（バグ誤検知防止）

実装前にコードに以下コメントを残すこと（各タスクに含める）:

```
⚠️ ユーザー指示による仕様（2026-04-01）
・総合DD: 実弾投入まで OFF がデフォルト。null も false 扱い。バグではない。
・市場別DD: 市場クローズ時に dd_stopped を自動解除。翌営業日持ち越し禁止。バグではない。
```

---

## Task 1: `isGlobalDDEnabled` + `setGlobalDDEnabled` + `getDrawdownLevel()` 修正（TDD）

**Files:**
- Modify: `src/risk-manager.ts`（末尾付近に関数追加、`getDrawdownLevel()` 冒頭修正）
- Create: `src/risk-manager.test.ts`

### ステップ

- [ ] **Step 1: テストファイルを作成（失敗するテストを書く）**

`src/risk-manager.test.ts` を新規作成:

```typescript
/**
 * risk-manager.ts ユニットテスト
 *
 * ⚠️ ユーザー指示による仕様テスト（2026-04-01）
 * - 総合DD: global_dd_enabled='false'/null → 常に NORMAL。バグではない。
 * - 市場別DD: 市場クローズ遷移で dd_stopped 自動クリア。バグではない。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isGlobalDDEnabled, setGlobalDDEnabled } from './risk-manager';

// D1Database のミニマルモック
function makeDb(kvStore: Record<string, string> = {}): D1Database {
  const store = { ...kvStore };
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          // SELECT value FROM risk_state WHERE key = ?
          const key = args[0] as string;
          const val = store[key];
          return val !== undefined ? { value: val } : null;
        },
        run: async () => {
          // INSERT INTO risk_state ... ON CONFLICT DO UPDATE
          const key = args[0] as string;
          const value = args[1] as string;
          store[key] = value;
          return {};
        },
      }),
    }),
  } as unknown as D1Database;
}

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
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim && npm test -- risk-manager
```
期待: `isGlobalDDEnabled is not a function` などのエラーで FAIL

- [ ] **Step 3: `risk-manager.ts` に関数を追加**

`src/risk-manager.ts` の `getRiskStateValue` / `setRiskStateValue` 関数の後（`getHWM` の前）に追加:

```typescript
// ─── 総合DD toggle ────────────────────────────────
/**
 * 総合DD管理の有効/無効を返す。
 *
 * ⚠️ ユーザー指示による仕様（2026-04-01）:
 *   実弾投入まで OFF がデフォルト。未設定（null）も false として扱う。
 *   これはバグではなく意図的な設計。
 *
 * @returns false → DD完全無効（常にNORMAL）、true → 従来のDD管理が有効
 */
export async function isGlobalDDEnabled(db: D1Database): Promise<boolean> {
  const val = await getRiskStateValue(db, 'global_dd_enabled');
  return (val ?? 'false') === 'true';
}

/**
 * 総合DD管理のON/OFFを書き込む。
 * フロントエンドの POST /api/settings から呼び出される。
 */
export async function setGlobalDDEnabled(db: D1Database, enabled: boolean): Promise<void> {
  await setRiskStateValue(db, 'global_dd_enabled', enabled ? 'true' : 'false');
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm test -- risk-manager
```
期待: `isGlobalDDEnabled`, `setGlobalDDEnabled` のテストが PASS

- [ ] **Step 5: `getDrawdownLevel()` の冒頭にトグルチェックを追加**

`src/risk-manager.ts` の `getDrawdownLevel()` 関数の冒頭（`const ddStopped = await getRiskStateValue(db, 'dd_stopped');` の前）に挿入:

```typescript
  // ─── グローバルDDトグルチェック ─────────────────
  // ⚠️ ユーザー指示による仕様（2026-04-01）:
  //   global_dd_enabled=false（デフォルト）の場合、DD%やdd_stoppedの値に
  //   関わらず常にNORMAL/lotMultiplier=1.0を返す。実弾投入まで無効。バグではない。
  const globalDDEnabled = await isGlobalDDEnabled(db);
  if (!globalDDEnabled) {
    const balance = await getCurrentBalance(db);
    const hwm = await getHWM(db);
    const ddPct = hwm > 0 ? ((hwm - balance) / hwm) * 100 : 0;
    return { level: 'NORMAL', ddPct, hwm, balance, lotMultiplier: 1.0 };
  }
```

- [ ] **Step 6: `getDrawdownLevel` の統合テストを追加**

`src/risk-manager.test.ts` の末尾に追記:

```typescript
// getDrawdownLevel のトグル動作テスト
// NOTE: getDrawdownLevel は DB から残高・HWMを読むため、
//       完全なD1モックが必要。ここでは「トグルがNORMALを返すか」の最小検証のみ行う。
import { getDrawdownLevel } from './risk-manager';

describe('getDrawdownLevel — globalDDEnabled=false', () => {
  it('global_dd_enabled=false のとき dd_stopped=true でも NORMAL を返す', async () => {
    // dd_stopped=true + global_dd_enabled=false の共存
    const db = makeDb({
      global_dd_enabled: 'false',
      dd_stopped: 'true',
      hwm: '10000',
    });
    // getCurrentBalance は positions テーブルを読むが、モックでは first() が null を返す
    // → totalPnl=0 → balance=INITIAL_CAPITAL(10000) → ddPct=0
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
```

> **注意**: `makeDb` は `prepare().bind().first()` の SQL 文字列に関わらず key で引くシンプルモック。`getCurrentBalance` の SQL（`FROM positions`）では `first()` が null を返すため totalPnl=0 になる。これで十分。

- [ ] **Step 7: テスト全件パス確認**

```bash
npm test -- risk-manager
```
期待: 全テスト PASS

- [ ] **Step 8: コミット**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim && git add src/risk-manager.ts src/risk-manager.test.ts && git commit -m "feat: 総合DDトグル isGlobalDDEnabled/setGlobalDDEnabled + getDrawdownLevel統合"
```

---

## Task 2: `isMarketOpen` + `checkMarketCloseAndReleaseDDStop`（TDD）

**Files:**
- Modify: `src/risk-manager.ts`
- Modify: `src/risk-manager.test.ts`

### ステップ

- [ ] **Step 1: テストを追加（失敗させる）**

`src/risk-manager.test.ts` に追記:

```typescript
import { isMarketOpen, checkMarketCloseAndReleaseDDStop } from './risk-manager';

// isMarketOpen テスト
describe('isMarketOpen', () => {
  // ヘルパー: UTC指定でDate生成
  function utc(weekday: number, hour: number, min = 0): Date {
    // 2026-03-30(月)起点
    const base = new Date('2026-03-30T00:00:00Z');
    base.setUTCDate(base.getUTCDate() + (weekday - 1));
    base.setUTCHours(hour, min, 0, 0);
    return base;
  }

  describe('forex', () => {
    it('月曜10:00 UTC → open', () => expect(isMarketOpen('forex', utc(1, 10))).toBe(true));
    it('金曜20:59 UTC → open', () => expect(isMarketOpen('forex', utc(5, 20, 59))).toBe(true));
    it('金曜21:00 UTC → closed', () => expect(isMarketOpen('forex', utc(5, 21))).toBe(false));
    it('土曜10:00 UTC → closed（週末）', () => expect(isMarketOpen('forex', utc(6, 10))).toBe(false));
    it('日曜10:00 UTC → closed（週末）', () => expect(isMarketOpen('forex', new Date('2026-04-05T10:00:00Z'))).toBe(false));
  });

  describe('crypto（日次リセット：ユーザー指示仕様）', () => {
    it('月曜10:00 UTC → open', () => expect(isMarketOpen('crypto', utc(1, 10))).toBe(true));
    it('月曜23:59 UTC → open', () => expect(isMarketOpen('crypto', utc(1, 23, 59))).toBe(true));
    it('火曜00:00 UTC → closed（日次リセット）', () => expect(isMarketOpen('crypto', utc(2, 0))).toBe(false));
    it('土曜10:00 UTC → open（crypto は週末も取引可能）', () => expect(isMarketOpen('crypto', utc(6, 10))).toBe(true));
  });

  describe('stock（21:00 UTC = US close）', () => {
    it('月曜10:00 UTC → open', () => expect(isMarketOpen('stock', utc(1, 10))).toBe(true));
    it('月曜20:59 UTC → open', () => expect(isMarketOpen('stock', utc(1, 20, 59))).toBe(true));
    it('月曜21:00 UTC → closed', () => expect(isMarketOpen('stock', utc(1, 21))).toBe(false));
    it('土曜10:00 UTC → closed（週末）', () => expect(isMarketOpen('stock', utc(6, 10))).toBe(false));
  });
});

// checkMarketCloseAndReleaseDDStop テスト
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
    // 金曜21:00 UTC → forex は closed
    await checkMarketCloseAndReleaseDDStop(db, utc(5, 21));
    // dd_stopped:forex が削除 or 'false' になること
    const val = (db as any)._store?.['dd_stopped:forex'];
    expect(val === undefined || val === 'false').toBe(true);
    // market_open:forex が false に更新されること
    expect((db as any)._store?.['market_open:forex']).toBe('false');
  });

  it('土→日（forex既にclosed）: false→false なので dd_stopped はクリアされない', async () => {
    const db = makeDb({
      'market_open:forex': 'false',
      'dd_stopped:forex': 'true',
    });
    await checkMarketCloseAndReleaseDDStop(db, new Date('2026-04-05T10:00:00Z')); // 日曜
    // dd_stopped:forex は変わらず 'true'
    expect((db as any)._store?.['dd_stopped:forex']).toBe('true');
  });

  it('dd_stopped:forex が存在しない場合もエラーなし', async () => {
    const db = makeDb({ 'market_open:forex': 'true' });
    await expect(checkMarketCloseAndReleaseDDStop(db, utc(5, 21))).resolves.not.toThrow();
  });
});
```

> **Note**: `makeDb` を拡張して `_store` を外から参照できるようにする（Stepで修正）。

- [ ] **Step 2: `makeDb` を拡張して `_store` を公開**

`src/risk-manager.test.ts` の `makeDb` 関数を以下に置き換え:

```typescript
function makeDb(kvStore: Record<string, string> = {}): D1Database & { _store: Record<string, string> } {
  const store = { ...kvStore };
  const db = {
    _store: store,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          const key = args[0] as string;
          const val = store[key];
          return val !== undefined ? { value: val } : null;
        },
        run: async () => {
          // INSERT INTO risk_state ... ON CONFLICT DO UPDATE
          if (sql.includes('INSERT INTO risk_state')) {
            const key = args[0] as string;
            const value = args[1] as string;
            store[key] = value;
          }
          return {};
        },
        all: async () => ({ results: [] }),
      }),
    }),
  };
  return db as unknown as D1Database & { _store: Record<string, string> };
}
```

- [ ] **Step 3: テストが失敗することを確認**

```bash
npm test -- risk-manager
```
期待: `isMarketOpen is not a function` で FAIL

- [ ] **Step 4: `isMarketOpen` を `risk-manager.ts` に実装**

`src/risk-manager.ts` の末尾（`evaluateRecoveryIfNeeded` の後）に追加:

```typescript
// ─── 市場別クローズ判定（DD管理専用） ──────────────
/**
 * 指定 AssetClass が現在オープン中かを返す（DD管理専用ユーティリティ）。
 *
 * ⚠️ CLAUDE.md §週末市場クローズ制約の適用外:
 *   取引判断ではなくDD管理のための判定。取引エントリー制御は weekend.ts を使うこと。
 *
 * ⚠️ ユーザー指示による仕様（2026-04-01）:
 *   crypto の 00:00 UTC は「日次リセット」。24/7市場だが意図的な設計。バグではない。
 *   stock は JP株（06:00 UTC）+ US株（21:00 UTC）が混在。最後に閉じるUS株に合わせ 21:00 UTC を採用。
 *
 * @param assetClass 判定対象の市場区分
 * @param now 判定時刻（UTC）
 */
export function isMarketOpen(assetClass: AssetClass, now: Date): boolean {
  const day = now.getUTCDay();    // 0=日, 1=月, ..., 5=金, 6=土
  const h   = now.getUTCHours();
  const m   = now.getUTCMinutes();
  const hm  = h * 60 + m;        // 分単位で比較

  // crypto: 00:00 UTC にクローズ（日次リセット）。週末も取引可能。
  if (assetClass === 'crypto') {
    return hm !== 0; // 00:00:00 UTC のみ closed
  }

  // 土日は全市場クローズ（crypto除く）
  if (day === 0 || day === 6) return false;

  // 平日: 21:00 UTC にクローズ（forex / index / stock / commodity）
  return hm < 21 * 60; // 21:00 UTC 未満なら open
}
```

- [ ] **Step 5: `checkMarketCloseAndReleaseDDStop` を実装**

`isMarketOpen` の直後に追加:

```typescript
const ASSET_CLASSES_FOR_DD: AssetClass[] = ['forex', 'index', 'stock', 'commodity', 'crypto'];

/**
 * 市場クローズ遷移（open→closed）を検出し、dd_stopped:{assetClass} を自動クリアする。
 * runCore()（1分cron）の末尾から呼び出すこと。
 *
 * ⚠️ ユーザー指示による仕様（2026-04-01）:
 *   市場クローズ時に DD STOP を自動解除。翌営業日持ち越し禁止。バグではない。
 * ⚠️ CLAUDE.md §週末市場クローズ制約の適用外（取引判断関数ではない）
 *
 * @param db Cloudflare D1 Database
 * @param now 現在時刻（UTC）
 */
export async function checkMarketCloseAndReleaseDDStop(db: D1Database, now: Date): Promise<void> {
  for (const ac of ASSET_CLASSES_FOR_DD) {
    try {
      const currentlyOpen = isMarketOpen(ac, now);
      const storedVal = await getRiskStateValue(db, `market_open:${ac}`);
      // 未設定の場合は 'true'（前回 open）として扱う
      const wasOpen = (storedVal ?? 'true') === 'true';

      // 状態を常に更新（遷移がなくても同期する）
      await setRiskStateValue(db, `market_open:${ac}`, currentlyOpen ? 'true' : 'false');

      // 遷移検出: open → closed
      if (wasOpen && !currentlyOpen) {
        // dd_stopped:{ac} があればクリア
        const ddStopped = await getRiskStateValue(db, `dd_stopped:${ac}`);
        if (ddStopped === 'true') {
          await setRiskStateValue(db, `dd_stopped:${ac}`, 'false');
          await insertSystemLog(db, 'INFO', 'RISK',
            `[${ac}] 市場クローズで DD STOP を自動解除`,
            `isMarketOpen=${currentlyOpen}, now=${now.toISOString()}`);
        }
      }
    } catch {
      // DD管理エラーは cron 全体を止めない
    }
  }
}
```

- [ ] **Step 6: テストが通ることを確認**

```bash
npm test -- risk-manager
```
期待: 全テスト PASS

- [ ] **Step 7: コミット**

```bash
git add src/risk-manager.ts src/risk-manager.test.ts && git commit -m "feat: 市場別DD自動解除 isMarketOpen + checkMarketCloseAndReleaseDDStop"
```

---

## Task 3: API — `StatusResponse.globalDDEnabled` + `POST /api/settings`

**Files:**
- Modify: `src/api.ts`（`StatusResponse` 型 + `getApiStatus()` の return）
- Modify: `src/index.ts`（`/api/settings` POSTルート追加）

### ステップ

- [ ] **Step 1: `StatusResponse` に `globalDDEnabled` を追加**

`src/api.ts` の `StatusResponse` インターフェース内（`ddByMarket` フィールドの直後）に追加:

```typescript
  /** 総合DD管理の有効/無効。フロントエンドのトグル初期状態用。 */
  globalDDEnabled: boolean;
```

- [ ] **Step 2: `getApiStatus()` の return に `globalDDEnabled` を追加**

`src/api.ts` の `getApiStatus()` 関数の return オブジェクト内、`ddByMarket` の直後に追加。まず import に `isGlobalDDEnabled` を追加:

`src/api.ts` の `getAllMarketDrawdownLevels` import を確認し、同行に `isGlobalDDEnabled` を追加:

```typescript
import { getAllMarketDrawdownLevels, isGlobalDDEnabled, type DrawdownLevel } from './risk-manager';
```

次に return オブジェクトの `ddByMarket` の行の直後に追加:

```typescript
    globalDDEnabled: await isGlobalDDEnabled(db).catch(() => false),
```

- [ ] **Step 3: `POST /api/settings` ルートを `index.ts` に追加**

`src/index.ts` の switch 文内、`/api/rotation` ケースの直後に追加:

```typescript
      case '/api/settings':
        if (request.method === 'POST') {
          let settingsBody: { key: string; value: string };
          try {
            settingsBody = await request.json() as { key: string; value: string };
          } catch {
            return new Response(JSON.stringify({ success: false, message: 'Invalid JSON body' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          // ホワイトリスト: global_dd_enabled のみ許可
          if (settingsBody.key !== 'global_dd_enabled') {
            return new Response(JSON.stringify({ success: false, message: 'Invalid key' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          if (settingsBody.value !== 'true' && settingsBody.value !== 'false') {
            return new Response(JSON.stringify({ success: false, message: 'Invalid value: must be "true" or "false"' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          try {
            await setGlobalDDEnabled(env.DB, settingsBody.value === 'true');
            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (e) {
            return new Response(JSON.stringify({ success: false, message: String(e) }), {
              status: 500, headers: { 'Content-Type': 'application/json' },
            });
          }
        }
        return new Response('Method Not Allowed', { status: 405 });
```

- [ ] **Step 4: `setGlobalDDEnabled` の import を `index.ts` に追加**

`src/index.ts` の `risk-manager` import 行を確認し、`setGlobalDDEnabled` を追加:

```typescript
import { evaluateRecoveryIfNeeded, getDrawdownLevel, checkInstrumentDailyLoss, getMarketDrawdownLevel, setGlobalDDEnabled } from './risk-manager';
```

- [ ] **Step 5: TypeScript コンパイルエラーがないことを確認**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim && npx tsc --noEmit
```
期待: エラーなし

- [ ] **Step 6: テスト全件パス確認**

```bash
npm test
```
期待: 全テスト PASS

- [ ] **Step 7: コミット**

```bash
git add src/api.ts src/index.ts && git commit -m "feat: API — StatusResponse.globalDDEnabled + POST /api/settings"
```

---

## Task 4: `runCore()` に `checkMarketCloseAndReleaseDDStop` を統合

**Files:**
- Modify: `src/index.ts`

### ステップ

- [ ] **Step 1: `runCore()` 末尾に呼び出しを追加**

`src/index.ts` の `runCore()` 関数内、`await env.DB.prepare(\`DELETE FROM system_logs...` のパージ処理の直後（`const coreMs = Date.now() - cronStart;` の前）に追加:

```typescript
    // 市場クローズ遷移検出 → 市場別DD STOP 自動解除
    // ⚠️ ユーザー指示による仕様（2026-04-01）: 市場クローズ時にdd_stoppedを自動解除。バグではない。
    try {
      await checkMarketCloseAndReleaseDDStop(env.DB, now);
    } catch (e) {
      console.warn(`[fx-sim] checkMarketCloseAndReleaseDDStop error: ${String(e).slice(0, 80)}`);
    }
```

- [ ] **Step 2: `checkMarketCloseAndReleaseDDStop` の import を追加**

`src/index.ts` の `risk-manager` import 行に `checkMarketCloseAndReleaseDDStop` を追加:

```typescript
import { evaluateRecoveryIfNeeded, getDrawdownLevel, checkInstrumentDailyLoss, getMarketDrawdownLevel, setGlobalDDEnabled, checkMarketCloseAndReleaseDDStop } from './risk-manager';
```

- [ ] **Step 3: TypeScript コンパイルエラーがないことを確認**

```bash
npx tsc --noEmit
```
期待: エラーなし

- [ ] **Step 4: テスト全件パス確認**

```bash
npm test
```
期待: 全テスト PASS

- [ ] **Step 5: コミット**

```bash
git add src/index.ts && git commit -m "feat: runCore に市場別DD自動解除を統合（1分cron）"
```

---

## Task 5: フロントエンド — リスクタブにトグルスイッチ追加

**Files:**
- Modify: `src/app.js.ts`

### ステップ

- [ ] **Step 1: トグルスイッチ CSS を追加**

`src/app.js.ts` の CSS テンプレートリテラル（`const CSS = \`...` 部分）の末尾付近に以下を追加。既存 CSS の最後の `\`` の直前に挿入:

```css
/* ─── 総合DDトグルスイッチ ─── */
.dd-toggle-row { display:flex; align-items:center; justify-content:space-between; padding:12px 0; border-bottom:1px solid var(--border); }
.dd-toggle-label { flex:1; }
.dd-toggle-label .dd-toggle-title { font-size:15px; font-weight:600; color:var(--label); }
.dd-toggle-label .dd-toggle-sub { font-size:12px; color:var(--sec); margin-top:2px; }
.toggle-switch { position:relative; width:51px; height:31px; flex-shrink:0; }
.toggle-switch input { opacity:0; width:0; height:0; }
.toggle-slider { position:absolute; inset:0; background:var(--border); border-radius:34px; cursor:pointer; transition:background 0.2s; }
.toggle-slider:before { content:''; position:absolute; height:27px; width:27px; left:2px; bottom:2px; background:#fff; border-radius:50%; transition:transform 0.2s; box-shadow:0 1px 4px rgba(0,0,0,.3); }
.toggle-switch input:checked + .toggle-slider { background:var(--red); }
.toggle-switch input:checked + .toggle-slider:before { transform:translateX(20px); }
```

- [ ] **Step 2: `renderHealthChecks` の先頭にトグルスイッチHTMLを注入**

`src/app.js.ts` の `renderHealthChecks(data)` 関数内、`var container = el('health-checks');` の後に追加:

```javascript
    // 総合DDトグルスイッチを描画（health-checks コンテナの前に挿入）
    var ddToggleEl = el('dd-global-toggle-row');
    if (!ddToggleEl) {
      // 初回のみ挿入
      var ddToggleHtml = '<div id="dd-global-toggle-row" class="dd-toggle-row">' +
        '<div class="dd-toggle-label">' +
          '<div class="dd-toggle-title">総合DD管理</div>' +
          '<div class="dd-toggle-sub" id="dd-toggle-sub">実弾投入まで無効（検証モード）</div>' +
        '</div>' +
        '<label class="toggle-switch">' +
          '<input type="checkbox" id="dd-global-toggle" onchange="onDDToggleChange(this)">' +
          '<span class="toggle-slider"></span>' +
        '</label>' +
      '</div>';
      if (container) container.insertAdjacentHTML('beforebegin', ddToggleHtml);
    }
    // 初期状態を反映（data.globalDDEnabled）
    var ddToggleInput = el('dd-global-toggle');
    var ddToggleSub = el('dd-toggle-sub');
    if (ddToggleInput && data.globalDDEnabled !== undefined) {
      ddToggleInput.checked = !!data.globalDDEnabled;
      if (ddToggleSub) {
        ddToggleSub.textContent = data.globalDDEnabled
          ? '有効 — DD 20%で完全停止'
          : '実弾投入まで無効（検証モード）';
      }
    }
```

- [ ] **Step 3: `onDDToggleChange` 関数を追加**

`src/app.js.ts` の `window.switchTab = switchTab;` の直後に追加:

```javascript
    // 総合DDトグル操作ハンドラ
    async function onDDToggleChange(checkbox) {
      var prev = !checkbox.checked;
      try {
        var res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'global_dd_enabled', value: checkbox.checked ? 'true' : 'false' })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // 成功: サブテキスト更新
        var sub = el('dd-toggle-sub');
        if (sub) sub.textContent = checkbox.checked ? '有効 — DD 20%で完全停止' : '実弾投入まで無効（検証モード）';
      } catch (e) {
        // 失敗: スイッチを元に戻す
        checkbox.checked = prev;
        console.error('DD toggle failed:', e);
      }
    }
    window.onDDToggleChange = onDDToggleChange;
```

- [ ] **Step 4: TypeScript コンパイル確認**

```bash
npx tsc --noEmit
```
期待: エラーなし

- [ ] **Step 5: テスト全件パス確認**

```bash
npm test
```
期待: 全テスト PASS

- [ ] **Step 6: コミット**

```bash
git add src/app.js.ts && git commit -m "feat: フロントエンド 総合DDトグルスイッチ（リスクタブ）"
```

---

## Task 6: デプロイ + デプロイ後リセット

**Files:** なし（コマンド実行のみ）

### ステップ

- [ ] **Step 1: PR作成**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim && gh pr create --title "feat: 総合DDトグル + 市場別DD自動解除" --body "$(cat <<'EOF'
## Summary
- 総合DD管理のON/OFFをフロントエンドスイッチで制御（デフォルトOFF）
- 市場別DDストップを日次クローズ時（21:00 UTC / crypto 00:00 UTC）に自動解除
- ⚠️ ユーザー指示による仕様（2026-04-01）— バグではない

## 変更ファイル
- `src/risk-manager.ts`: isGlobalDDEnabled / checkMarketCloseAndReleaseDDStop 追加
- `src/risk-manager.test.ts`: 新規テストファイル
- `src/api.ts`: StatusResponse.globalDDEnabled 追加
- `src/index.ts`: POST /api/settings + runCore 統合
- `src/app.js.ts`: トグルスイッチ UI

## Test plan
- [ ] `npm test` 全件パス
- [ ] デプロイ後 wrangler tail でcronログ確認
- [ ] フロントのリスクタブでトグルスイッチ表示確認

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: PRをマージ**

```bash
gh pr merge --squash --auto
```

- [ ] **Step 3: デプロイ**

```bash
npx wrangler deploy
```

期待: `Deployed fx-sim-v1` のメッセージ

- [ ] **Step 4: デプロイ後DDリセット（一回限り）**

```bash
wrangler d1 execute fx-sim-v1-db --command="INSERT INTO risk_state (key, value, updated_at) VALUES ('global_dd_enabled', 'false', datetime('now')) ON CONFLICT(key) DO UPDATE SET value='false', updated_at=datetime('now');"
wrangler d1 execute fx-sim-v1-db --command="DELETE FROM risk_state WHERE key = 'dd_stopped';"
wrangler d1 execute fx-sim-v1-db --command="DELETE FROM risk_state WHERE key LIKE 'dd_stopped:%';"
```

期待: 各コマンドが `{ results: [], success: true }` を返す

- [ ] **Step 5: フロントエンドで動作確認（Chrome DevTools MCP使用）**

1. 本番URL をブラウザで開く
2. リスクタブを開く
3. トグルスイッチが OFF（グレー）で表示されることを確認
4. トグルをONにして「有効 — DD 20%で完全停止」に変わることを確認
5. ページリロードしてON状態が保持されることを確認
6. OFFに戻す

- [ ] **Step 6: wrangler tail でcronログ確認**

```bash
wrangler tail --format=pretty
```

期待ログ例（市場クローズ時）:
```
[fx-sim] [forex] 市場クローズで DD STOP を自動解除
```

---

## 完了チェックリスト

- [ ] `npm test` 全件パス
- [ ] `npx tsc --noEmit` エラーなし
- [ ] フロントのトグルスイッチ表示・動作確認
- [ ] デプロイ後DDリセット実行済み
- [ ] コードに仕様コメント（「ユーザー指示による仕様 2026-04-01」）が入っていること

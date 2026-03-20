# Batch A: インフラ基盤 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** マイグレーション管理を `schema_version` テーブルで体系化し、Yahoo Finance 障害時に Twelve Data API へ自動フォールバックする。

**Architecture:** `src/migration.ts` を番号管理方式に刷新。`src/indicators.ts` に Twelve Data フォールバック層を追加。どちらも既存 API・DB スキーマへの影響なし。

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare D1 (SQLite), Twelve Data API (無料枠)

**Spec:** `docs/superpowers/specs/2026-03-21-full-roadmap-design.md` §Batch A

---

## ファイルマップ

| ファイル | 操作 | 内容 |
|---|---|---|
| `src/migration.ts` | **修正** | schema_version テーブル導入・番号管理方式へ刷新 |
| `src/indicators.ts` | **修正** | Twelve Data フォールバック追加 |
| `wrangler.toml` | **修正** | `TWELVE_DATA_API_KEY` vars 欄に追記（空値） |

---

## Task 1: schema_version テーブル導入

**Files:**
- Modify: `src/migration.ts`

- [ ] **Step 1: 現在の migration.ts を読む**

```bash
cat src/migration.ts
```

確認点: 既存の `MIGRATIONS` 配列の構造と `runMigrations()` の実装。

- [ ] **Step 2: schema_version テーブルを作る migration を追加**

`src/migration.ts` の `MIGRATIONS` 配列の先頭に追加（既存エントリは末尾へ）:

```typescript
// src/migration.ts
const MIGRATIONS: Array<{ version: number; description: string; sql: string }> = [
  {
    version: 1,
    description: 'schema_version テーブル作成',
    sql: `CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL
    )`,
  },
  // === 既存マイグレーションをここに移動（version 2 以降に番号付け）===
  // 例: { version: 2, description: '...既存の説明...', sql: '...既存SQL...' },
];
```

- [ ] **Step 3: runMigrations() を番号管理方式に書き換える**

```typescript
export async function runMigrations(db: D1Database): Promise<void> {
  // schema_version テーブル自体がなければ先に作成（ブートストラップ）
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       description TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`
  ).run();

  // 適用済みバージョン一覧を取得
  const applied = await db
    .prepare('SELECT version FROM schema_version')
    .all<{ version: number }>();
  const appliedSet = new Set((applied.results ?? []).map(r => r.version));

  // 未適用のマイグレーションを順番に実行
  for (const m of MIGRATIONS) {
    if (appliedSet.has(m.version)) continue;
    try {
      await db.prepare(m.sql).run();
      await db.prepare(
        'INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
      ).bind(m.version, m.description, new Date().toISOString()).run();
      console.log(`[migration] Applied v${m.version}: ${m.description}`);
    } catch (e) {
      // 既存テーブルの "already exists" は無視
      const msg = String(e);
      if (msg.includes('already exists')) {
        await db.prepare(
          'INSERT OR IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)'
        ).bind(m.version, m.description, new Date().toISOString()).run();
      } else {
        console.error(`[migration] Failed v${m.version}: ${msg}`);
        throw e;
      }
    }
  }
}
```

- [ ] **Step 4: 既存マイグレーションを新方式に移行**

既存 `migration.ts` にある全マイグレーション SQL を `MIGRATIONS` 配列の version 2 以降として移動する。既存のフラグチェック（`schema_v2_migrated` 等）は削除。

- [ ] **Step 5: C-2・D-1 に必要なインデックスを migration に追加**

```typescript
{
  version: 100,  // 既存マイグレーション数に合わせて番号付け
  description: 'SL分析・トンプソンサンプリング用インデックス',
  sql: `CREATE INDEX IF NOT EXISTS idx_positions_close_reason ON positions(close_reason, closed_at DESC)`,
},
{
  version: 101,
  description: '決定履歴インデックス',
  sql: `CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at DESC)`,
},
```

- [ ] **Step 6: 型チェック**

```bash
npx tsc --noEmit 2>&1 | grep "migration.ts"
```

期待: エラーなし

- [ ] **Step 7: デプロイ & 確認**

```bash
npx wrangler deploy
```

```bash
curl -s "https://fx-sim-v1.ai-battle-sim.workers.dev/api/status" | python -c "import json,sys; d=json.load(sys.stdin); print('OK' if d.get('tradingMode') else 'NG')"
```

期待: `OK`（cron ログに `[migration] Applied v1` が出ることを wrangler tail で確認）

- [ ] **Step 8: コミット**

```bash
git add src/migration.ts
git commit -m "feat(A-1): schema_version テーブル導入・マイグレーション番号管理方式に刷新"
```

---

## Task 2: Yahoo Finance 代替プロバイダー（Twelve Data）

**Files:**
- Modify: `src/indicators.ts`
- Modify: `wrangler.toml`

- [ ] **Step 1: 現在の indicators.ts を読む**

```bash
cat src/indicators.ts
```

確認点: `getMarketIndicators()` の構造、Yahoo Finance の呼び出し方、失敗時の処理。

- [ ] **Step 2: wrangler.toml に環境変数を追加**

`wrangler.toml` の `[vars]` セクションに追加:

```toml
TWELVE_DATA_API_KEY = ""  # wrangler secret put TWELVE_DATA_API_KEY で設定
```

- [ ] **Step 3: Twelve Data フェッチ関数を追加**

`src/indicators.ts` に追加:

```typescript
/** Twelve Data API から主要銘柄を取得（Yahoo Finance 障害時フォールバック）
 *  無料枠: 800 req/day → 障害検知時のみ呼び出す
 */
async function fetchFromTwelveData(apiKey: string): Promise<Partial<MarketIndicators>> {
  // Twelve Data は複数銘柄をカンマ区切りで1リクエストに集約
  const symbols = 'USD/JPY,XAU/USD,BTC/USD,EUR/USD,GBP/USD,AUD/USD';
  const url = `https://api.twelvedata.com/price?symbol=${symbols}&apikey=${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return {};
    const data = await res.json() as Record<string, { price?: string; code?: number }>;
    return {
      usdjpy:  data['USD/JPY']?.price  ? parseFloat(data['USD/JPY'].price!)  : null,
      gold:    data['XAU/USD']?.price  ? parseFloat(data['XAU/USD'].price!)  : null,
      btcusd:  data['BTC/USD']?.price  ? parseFloat(data['BTC/USD'].price!)  : null,
      eurusd:  data['EUR/USD']?.price  ? parseFloat(data['EUR/USD'].price!)  : null,
      gbpusd:  data['GBP/USD']?.price  ? parseFloat(data['GBP/USD'].price!)  : null,
      audusd:  data['AUD/USD']?.price  ? parseFloat(data['AUD/USD'].price!)  : null,
    };
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: getMarketIndicators() にフォールバックロジックを組み込む**

`getMarketIndicators()` のシグネチャを変更:

```typescript
export async function getMarketIndicators(
  twelveDataApiKey?: string
): Promise<MarketIndicators>
```

Yahoo Finance の結果が 3 銘柄以上 null の場合に Twelve Data を呼び出す:

```typescript
// Yahoo Finance 結果のnull数をカウント
const nullCount = [result.usdjpy, result.gold, result.btcusd, result.eurusd, result.nikkei, result.sp500]
  .filter(v => v == null).length;

if (nullCount >= 3 && twelveDataApiKey) {
  console.warn(`[indicators] Yahoo障害(${nullCount}件null) → Twelve Data フォールバック`);
  const tdResult = await fetchFromTwelveData(twelveDataApiKey);
  // null の値だけ Twelve Data で補完
  for (const [k, v] of Object.entries(tdResult)) {
    if (v != null && (result as any)[k] == null) {
      (result as any)[k] = v;
    }
  }
}
```

- [ ] **Step 5: src/index.ts の getMarketIndicators() 呼び出しを更新**

`src/index.ts` の `fetchMarketData()` 内:

```typescript
// Before:
getMarketIndicators(),
// After:
getMarketIndicators(env.TWELVE_DATA_API_KEY),
```

Env インターフェースに追加:

```typescript
TWELVE_DATA_API_KEY?: string;
```

- [ ] **Step 6: 型チェック**

```bash
npx tsc --noEmit 2>&1 | grep -E "indicators.ts|index.ts" | grep -v "error TS6133\|error TS2345"
```

期待: 新規エラーなし

- [ ] **Step 7: デプロイ & 確認**

```bash
npx wrangler deploy
curl -s "https://fx-sim-v1.ai-battle-sim.workers.dev/api/status" | python -c "
import json,sys; d=json.load(sys.stdin)
sp = d.get('latestDecision',{}).get('sp500')
print(f'S&P500: {sp}')
"
```

期待: S&P500 の値が表示される（Yahoo 正常時は Twelve Data 未使用）

- [ ] **Step 8: コミット**

```bash
git add src/indicators.ts src/index.ts wrangler.toml
git commit -m "feat(A-2): Yahoo Finance障害時に Twelve Data API へ自動フォールバック"
```

---

## Task 3: PR 作成

- [ ] **Step 1: feature ブランチに push して PR を作成**

```bash
git push
gh pr create --title "feat: Batch A — インフラ基盤（マイグレーション管理 + Yahoo フォールバック）" --body "$(cat <<'EOF'
## 変更内容
- schema_version テーブル導入（T004-08）
- マイグレーションを番号管理方式に刷新（冪等性保証）
- SL分析・トンプソン用インデックスを追加
- Yahoo Finance 障害時に Twelve Data API へ自動フォールバック（T004-15）

## テスト確認
- [x] `npx tsc --noEmit` 新規エラーなし
- [x] `npx wrangler deploy` 成功
- [x] `/api/status` で正常レスポンス確認

## 影響範囲
- DB: schema_version テーブル追加（既存データ影響なし）
- API: 変更なし
EOF
)"
```

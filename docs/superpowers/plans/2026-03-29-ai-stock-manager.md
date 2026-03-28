# AI銘柄マネージャー Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** J-Quants APIを使ったテスタ式需給重視スコアリングで日本株15銘柄を動的入替えし、AI判断・TP設定・ニュースフィルタにファンダデータを統合する。

**Architecture:** 3新ファイル（jquants.ts/scoring.ts/rotation.ts）と既存ファイル8つを修正。4新テーブル+5新cronを追加。全ての変更はfeature/20260329-ai-stock-managerブランチで進め、PR経由でmasterにマージ。

**Tech Stack:** Cloudflare Workers (TypeScript), Cloudflare D1, J-Quants V2 API, Yahoo Finance API（既存）

---

## ファイル構造マップ

| ファイル | アクション | 責務 |
|---|---|---|
| `schema.sql` | Modify | 4新テーブル追加（fundamentals/stock_scores/rotation_log/active_instruments） |
| `wrangler.toml` | Modify | 5新cron追加、JQUANTS_API_KEY vars追加 |
| `src/jquants.ts` | **Create** | J-Quants V2 API認証・財務データ取得 |
| `src/scoring.ts` | **Create** | 3軸スコアリングエンジン（需給熱/モメンタム/ファンダ） |
| `src/rotation.ts` | **Create** | 2層リスト管理・入替え判定・承認・自動承認 |
| `src/instruments.ts` | Modify | `getActiveInstruments()` D1フォールバック追加 |
| `src/news.ts` | Modify | composite閾値動的制御、isStockSpecific分岐、注目フラグバイアス |
| `src/gemini.ts` | Modify | ファンダ参考情報プロンプト注入、funda_contextフィールド |
| `src/sanity.ts` | Modify | TP multiplier補正（clampTpSl直前適用） |
| `src/index.ts` | Modify | cron分岐ロジック（event.cronによるswitch） |
| `src/api.ts` | Modify | 3新エンドポイント（/api/rotation, /api/rotation/pending, /api/scores） |
| `src/dashboard.ts` | Modify | Tab1入替えバナー+追跡リスト、Tab3入替え履歴 |

---

## Task 1: DB Schema Migration

**Files:**
- Modify: `schema.sql`
- Modify: `wrangler.toml`

- [ ] **Step 1: schema.sqlに4新テーブルを追加**

`schema.sql` の末尾に以下を追記:

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- AI銘柄マネージャー: テスタ式スコアリング & 動的銘柄入替え
-- ─────────────────────────────────────────────────────────────────────────────

-- J-Quantsから取得した財務データ（2期分保持して2期連続赤字判定に使用）
CREATE TABLE IF NOT EXISTS fundamentals (
  symbol        TEXT NOT NULL,           -- '7203.T'
  fiscal_year   TEXT NOT NULL,           -- '2026'
  fiscal_quarter TEXT NOT NULL,          -- 'Q1'/'Q2'/'Q3'/'FY'
  eps           REAL,
  bps           REAL,
  revenue       REAL,
  op_profit     REAL,
  net_profit    REAL,
  forecast_rev  REAL,
  forecast_op   REAL,
  forecast_net  REAL,
  dividend      REAL,
  equity_ratio  REAL,
  next_earnings TEXT,
  sector        TEXT,
  market_cap    REAL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (symbol, fiscal_year, fiscal_quarter)
);
CREATE INDEX IF NOT EXISTS idx_fundamentals_symbol_period
  ON fundamentals(symbol, fiscal_year DESC, fiscal_quarter DESC);

-- 日次3軸スコアリング結果（需給熱/モメンタム/ファンダ）
CREATE TABLE IF NOT EXISTS stock_scores (
  symbol         TEXT NOT NULL,
  scored_at      TEXT NOT NULL,          -- 'YYYY-MM-DD'
  theme_score    REAL NOT NULL,          -- 需給熱 0-100
  funda_score    REAL NOT NULL,          -- ファンダ補正 0-100
  momentum_score REAL NOT NULL,          -- モメンタム 0-100
  total_score    REAL NOT NULL,          -- 重み付き合計
  rank           INTEGER NOT NULL,
  in_universe    INTEGER DEFAULT 0,      -- 1=現在の追跡リスト
  PRIMARY KEY (symbol, scored_at)
);
CREATE INDEX IF NOT EXISTS idx_stock_scores_date_rank ON stock_scores(scored_at, rank);
CREATE INDEX IF NOT EXISTS idx_stock_scores_symbol_date ON stock_scores(symbol, scored_at DESC);

-- 銘柄入替え提案・承認・結果ログ
CREATE TABLE IF NOT EXISTS rotation_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  proposed_at    TEXT NOT NULL,
  in_symbol      TEXT NOT NULL,
  in_score       REAL NOT NULL,
  out_symbol     TEXT NOT NULL,
  out_score      REAL NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING/APPROVED/REJECTED/AUTO_APPROVED
  decided_at     TEXT,
  decided_by     TEXT,                              -- 'user' | 'timer'
  in_result_pnl  REAL,                              -- IN銘柄の7日間リターン(%)
  out_result_pnl REAL                               -- OUT銘柄の7日間仮想リターン(%)
);

-- 動的銘柄設定（日本株のみ。FX/指数/米株はinstruments.tsのハードコードを使用）
CREATE TABLE IF NOT EXISTS active_instruments (
  pair        TEXT PRIMARY KEY,       -- InstrumentConfig.pair と一致
  config_json TEXT NOT NULL,          -- JSON.stringify(InstrumentConfig)
  added_at    TEXT NOT NULL,          -- 7日ロックの起算日
  source      TEXT DEFAULT 'auto',    -- 'auto' | 'manual'
  updated_at  TEXT NOT NULL
);
```

- [ ] **Step 2: wrangler.tomlにcronとenv変数を追加**

`wrangler.toml` を以下のように修正:

```toml
[triggers]
crons = [
  "* * * * *",      # 毎分: 既存メインloop
  "0 21 * * *",     # JST 06:00: 日次スコアリング
  "0 18 * * 6",     # JST 日曜03:00: 週次スクリーニング①（全銘柄財務取得）
  "5 18 * * 6",     # JST 日曜03:05: 週次スクリーニング②（候補50銘柄確定）
  "0 * * * *",      # 毎時: 自動承認チェック
  "0 14 * * *"      # JST 23:00: 入替え7日後PnL記録
]
```

`[vars]` セクションに追加:
```toml
[vars]
JQUANTS_REFRESH_TOKEN = ""  # wrangler secret put JQUANTS_REFRESH_TOKEN で上書き予定
```

- [ ] **Step 3: D1マイグレーション実行**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim
npx wrangler d1 execute fx-sim-v1-db --file=schema.sql --remote
```

Expected: `Successfully executed X statement(s)` (エラーなし)

- [ ] **Step 4: J-QuantsリフレッシュトークンをSecretに設定**

```bash
npx wrangler secret put JQUANTS_REFRESH_TOKEN
```

入力値: `mukXh1G6TkLDEXlUGpI0vPGcud23Py2vWeph87F1xYw`

- [ ] **Step 5: テーブル作成を確認**

```bash
npx wrangler d1 execute fx-sim-v1-db --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" --remote
```

Expected: `fundamentals`, `stock_scores`, `rotation_log`, `active_instruments` が含まれる

- [ ] **Step 6: コミット**

```bash
git add schema.sql wrangler.toml
git commit -m "feat: DB schema migration — 4 new tables for AI stock manager"
```

---

## Task 2: J-Quants API Client (`src/jquants.ts`)

**Files:**
- Create: `src/jquants.ts`

J-Quants V2 APIはリフレッシュトークン→IDトークンの2段階認証。IDトークンは24時間有効。`market_cache` テーブルにキャッシュする。

- [ ] **Step 1: `src/jquants.ts` を作成**

```typescript
// src/jquants.ts
// J-Quants V2 API クライアント
// 認証: リフレッシュトークン → IDトークン（24時間有効）
// market_cache テーブルに 'jquants_id_token' でキャッシュ

const JQUANTS_BASE = 'https://api.jquants.com/v1';
const TOKEN_CACHE_KEY = 'jquants_id_token';
const TOKEN_TTL_HOURS = 23; // 24h有効だが余裕を持って23hでリフレッシュ

export interface FundamentalsData {
  symbol: string;         // '7203.T'
  fiscalYear: string;     // '2026'
  fiscalQuarter: string;  // 'Q1'/'Q2'/'Q3'/'FY'
  eps: number | null;
  bps: number | null;
  revenue: number | null;       // 百万円
  opProfit: number | null;      // 百万円
  netProfit: number | null;     // 百万円
  forecastRev: number | null;
  forecastOp: number | null;
  forecastNet: number | null;
  dividend: number | null;
  equityRatio: number | null;   // %
  nextEarnings: string | null;  // ISO8601 date
  sector: string | null;
  marketCap: number | null;     // 百万円
}

export interface ScreeningCandidate {
  symbol: string;
  marketCap: number | null;   // 百万円
  sector: string | null;
  netProfit: number | null;
}

/** IDトークンを取得（market_cacheから取得 or リフレッシュ） */
async function getIdToken(db: D1Database, refreshToken: string): Promise<string> {
  // キャッシュ確認
  const cached = await db
    .prepare("SELECT value, updated_at FROM market_cache WHERE key = ?")
    .bind(TOKEN_CACHE_KEY)
    .first<{ value: string; updated_at: string }>();

  if (cached) {
    const updatedAt = new Date(cached.updated_at);
    const hoursOld = (Date.now() - updatedAt.getTime()) / (1000 * 3600);
    if (hoursOld < TOKEN_TTL_HOURS) {
      return cached.value;
    }
  }

  // リフレッシュトークンでIDトークンを取得
  const res = await fetch(`${JQUANTS_BASE}/token/auth_refresh?refreshtoken=${refreshToken}`, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`J-Quants auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { idToken: string };
  const idToken = data.idToken;

  // キャッシュ保存
  await db
    .prepare("INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(TOKEN_CACHE_KEY, idToken, new Date().toISOString())
    .run();

  return idToken;
}

/** 指定銘柄リストの最新財務データを取得 */
export async function fetchFundamentals(
  db: D1Database,
  refreshToken: string,
  symbols: string[]   // ['7203.T', '8035.T', ...]
): Promise<FundamentalsData[]> {
  if (symbols.length === 0) return [];

  let idToken: string;
  try {
    idToken = await getIdToken(db, refreshToken);
  } catch (e) {
    console.error('[jquants] getIdToken failed:', e);
    return [];
  }

  const results: FundamentalsData[] = [];

  // 銘柄ごとに取得（バッチAPIが利用可能な場合は後で最適化）
  for (const symbol of symbols) {
    try {
      // J-Quants V2の銘柄コード: 4桁 (例: '7203' from '7203.T')
      const code = symbol.replace('.T', '');
      const url = `${JQUANTS_BASE}/fins/statements?code=${code}`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${idToken}` },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        console.warn(`[jquants] fetchFundamentals failed for ${symbol}: ${res.status}`);
        continue;
      }

      const data = await res.json() as {
        statements?: Array<{
          Code: string;
          FiscalYear: string;
          TypeOfDocument: string;
          EarningsPerShare: string;
          BookValuePerShare: string;
          NetSales: string;
          OperatingProfit: string;
          NetIncome: string;
          ForecastNetSales: string;
          ForecastOperatingProfit: string;
          ForecastNetIncome: string;
          AnnualDividendPerShare: string;
          EquityToAssetRatio: string;
          NextYearForecastEarningsPerShare: string;
          TypeOfCurrentPeriod: string;
        }>;
      };

      const stmts = data.statements ?? [];
      if (stmts.length === 0) continue;

      // 最新レコード（リストの先頭）
      const latest = stmts[0];
      const quarter = mapTypeOfDocument(latest.TypeOfDocument);

      results.push({
        symbol,
        fiscalYear: latest.FiscalYear ?? '',
        fiscalQuarter: quarter,
        eps: parseFloat(latest.EarningsPerShare) || null,
        bps: parseFloat(latest.BookValuePerShare) || null,
        revenue: parseFloat(latest.NetSales) || null,
        opProfit: parseFloat(latest.OperatingProfit) || null,
        netProfit: parseFloat(latest.NetIncome) || null,
        forecastRev: parseFloat(latest.ForecastNetSales) || null,
        forecastOp: parseFloat(latest.ForecastOperatingProfit) || null,
        forecastNet: parseFloat(latest.ForecastNetIncome) || null,
        dividend: parseFloat(latest.AnnualDividendPerShare) || null,
        equityRatio: parseFloat(latest.EquityToAssetRatio) || null,
        nextEarnings: null, // /fins/announcement で別途取得
        sector: null,
        marketCap: null, // Yahoo Financeから補完
      });

    } catch (e) {
      console.warn(`[jquants] error for ${symbol}:`, e);
    }
  }

  return results;
}

/** 週次スクリーニング: 全上場銘柄の財務サマリを取得（500銘柄ずつ） */
export async function fetchAllListedStocks(
  db: D1Database,
  refreshToken: string,
  pageToken?: string
): Promise<{ candidates: ScreeningCandidate[]; nextPageToken: string | null }> {
  let idToken: string;
  try {
    idToken = await getIdToken(db, refreshToken);
  } catch (e) {
    console.error('[jquants] getIdToken failed:', e);
    return { candidates: [], nextPageToken: null };
  }

  const url = pageToken
    ? `${JQUANTS_BASE}/listed/info?pagetoken=${pageToken}`
    : `${JQUANTS_BASE}/listed/info`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    console.error(`[jquants] fetchAllListedStocks failed: ${res.status}`);
    return { candidates: [], nextPageToken: null };
  }

  const data = await res.json() as {
    info?: Array<{
      Code: string;
      CompanyName: string;
      Sector17CodeName: string;
      MarketCapitalization?: string;
    }>;
    pagination_key?: string;
  };

  const candidates: ScreeningCandidate[] = (data.info ?? []).map(item => ({
    symbol: `${item.Code}.T`,
    marketCap: parseFloat(item.MarketCapitalization ?? '') || null,
    sector: item.Sector17CodeName ?? null,
    netProfit: null, // 別途fins/statementsで取得
  }));

  return {
    candidates,
    nextPageToken: data.pagination_key ?? null,
  };
}

/** 決算発表予定日を取得 */
export async function fetchEarningsAnnouncements(
  db: D1Database,
  refreshToken: string,
  symbol: string
): Promise<string | null> {
  let idToken: string;
  try {
    idToken = await getIdToken(db, refreshToken);
  } catch (e) {
    return null;
  }

  const code = symbol.replace('.T', '');
  const res = await fetch(`${JQUANTS_BASE}/fins/announcement?code=${code}`, {
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return null;

  const data = await res.json() as {
    announcement?: Array<{ PeriodEndDate: string; DisclosedDate: string }>;
  };

  const announcements = data.announcement ?? [];
  if (announcements.length === 0) return null;

  // 最も直近の予定日
  const future = announcements
    .filter(a => new Date(a.DisclosedDate) >= new Date())
    .sort((a, b) => a.DisclosedDate.localeCompare(b.DisclosedDate));

  return future[0]?.DisclosedDate ?? null;
}

/** TypeOfDocumentを四半期コードに変換 */
function mapTypeOfDocument(type: string): string {
  if (type.includes('FY') || type.includes('Annual')) return 'FY';
  if (type.includes('Q3') || type.includes('3Q')) return 'Q3';
  if (type.includes('Q2') || type.includes('2Q') || type.includes('Semi')) return 'Q2';
  if (type.includes('Q1') || type.includes('1Q')) return 'Q1';
  return 'FY';
}

/** D1のfundamentalsテーブルに保存（UPSERT） */
export async function saveFundamentals(
  db: D1Database,
  data: FundamentalsData[]
): Promise<void> {
  for (const f of data) {
    await db.prepare(`
      INSERT OR REPLACE INTO fundamentals
        (symbol, fiscal_year, fiscal_quarter, eps, bps, revenue, op_profit, net_profit,
         forecast_rev, forecast_op, forecast_net, dividend, equity_ratio,
         next_earnings, sector, market_cap, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      f.symbol, f.fiscalYear, f.fiscalQuarter,
      f.eps, f.bps, f.revenue, f.opProfit, f.netProfit,
      f.forecastRev, f.forecastOp, f.forecastNet,
      f.dividend, f.equityRatio, f.nextEarnings,
      f.sector, f.marketCap, new Date().toISOString()
    ).run();
  }
}

/** 直近2期分のnet_profitを返す（2期連続赤字判定用） */
export async function getRecentNetProfits(
  db: D1Database,
  symbol: string
): Promise<number[]> {
  const rows = await db.prepare(`
    SELECT net_profit FROM fundamentals
    WHERE symbol = ?
    ORDER BY fiscal_year DESC, fiscal_quarter DESC
    LIMIT 2
  `).bind(symbol).all<{ net_profit: number | null }>();

  return (rows.results ?? [])
    .map(r => r.net_profit)
    .filter((v): v is number => v !== null);
}

/** 3期以上前のデータを削除（クリーンアップ） */
export async function cleanupOldFundamentals(db: D1Database): Promise<void> {
  // 各銘柄で最新2件以外を削除
  await db.prepare(`
    DELETE FROM fundamentals
    WHERE rowid NOT IN (
      SELECT rowid FROM fundamentals f2
      WHERE f2.symbol = fundamentals.symbol
      ORDER BY fiscal_year DESC, fiscal_quarter DESC
      LIMIT 2
    )
  `).run().catch(e => console.warn('[jquants] cleanupOldFundamentals:', e));
}
```

- [ ] **Step 2: TypeScriptのビルドエラーを確認**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim
npx tsc --noEmit 2>&1 | head -30
```

Expected: エラーなし（または既存エラーのみ）

- [ ] **Step 3: コミット**

```bash
git add src/jquants.ts
git commit -m "feat: add J-Quants V2 API client (src/jquants.ts)"
```

---

## Task 3: Scoring Engine (`src/scoring.ts`)

**Files:**
- Create: `src/scoring.ts`

テスタ式3軸スコアリング: 需給熱(50%) + モメンタム(30%) + ファンダフィルタ(20%)

- [ ] **Step 1: `src/scoring.ts` を作成**

```typescript
// src/scoring.ts
// テスタ式3軸スコアリングエンジン
// 設計根拠:
//   需給熱50%: テスタ「出来高が急増している」「ボラが大きい」
//   モメンタム30%: テスタ「エントリー時に株価が上がっていないといけない」
//   ファンダフィルタ20%: テスタ「どうしたら負けないで済むか」(地雷除外)

import type { D1Database } from '@cloudflare/workers-types';
import { getRecentNetProfits } from './jquants';

export interface StockScoreInput {
  symbol: string;           // '7203.T'
  stockSymbol: string;      // '7203.T' (Yahoo Finance用)
  displayName: string;
  // 出来高データ（candles.tsから）
  vol5dAvg: number | null;   // 5日平均出来高
  vol20dAvg: number | null;  // 20日平均出来高
  vol1d: number | null;      // 当日出来高（直近）
  volYesterday: number | null;
  // 値幅データ
  highLow1d: number | null;  // 当日high-low
  highLow20dAvg: number | null; // 20日平均high-low
  // テクニカル（logic-indicators.ts から）
  rsi: number | null;
  adx: number | null;
  // 52週レンジ
  week52High: number | null;
  week52Low: number | null;
  currentPrice: number | null;
  // ニュース言及数
  newsCount3d: number;   // 過去3日の言及件数
  newsCount14d: number;  // 過去14日の言及件数
  // ファンダ（fundamentalsテーブルから）
  equityRatio: number | null;
  netProfit: number | null;
  prevNetProfit: number | null;  // 前期net_profit（2期連続赤字判定用）
  forecastOpChange: number | null; // 営業利益前年比変化率
  per: number | null;
  sectorAvgPer: number | null;
  dividendYield: number | null;
  marketCap: number | null;
  nextEarningsDate: string | null;
  isThemeStock: boolean;  // correlationGroupがテーマ株グループかどうか
}

export interface StockScore {
  symbol: string;
  displayName: string;
  themeScore: number;    // 需給熱 0-100
  fundaScore: number;    // ファンダ補正 0-100
  momentumScore: number; // モメンタム 0-100
  totalScore: number;    // 重み付き合計
  fundaFail: boolean;    // trueなら強制除外
  fundaFailReason: string | null;
  daysToEarnings: number | null;  // 決算まで何日
}

/** ファンダフィルタ: 強制除外条件を判定 */
function checkFundaFail(input: StockScoreInput): { fail: boolean; reason: string | null } {
  // 債務超過
  if (input.equityRatio !== null && input.equityRatio < 0) {
    return { fail: true, reason: '債務超過（自己資本比率<0）' };
  }

  // 2期連続赤字
  if (
    input.netProfit !== null && input.netProfit < 0 &&
    input.prevNetProfit !== null && input.prevNetProfit < 0
  ) {
    return { fail: true, reason: '2期連続赤字' };
  }

  // 時価総額10億未満
  if (input.marketCap !== null && input.marketCap < 1000) { // 百万円 = 10億円
    return { fail: true, reason: '時価総額10億円未満（上場廃止基準）' };
  }

  // 決算3日以内
  if (input.nextEarningsDate) {
    const daysUntil = Math.ceil(
      (new Date(input.nextEarningsDate).getTime() - Date.now()) / (1000 * 3600 * 24)
    );
    if (daysUntil >= 0 && daysUntil <= 3) {
      return { fail: true, reason: `決算${daysUntil}日前` };
    }
  }

  return { fail: false, reason: null };
}

/** ファンダ補正スコア計算（0-100） */
function calcFundaScore(input: StockScoreInput): number {
  let score = 50; // 基礎点

  // 業績修正方向
  if (input.forecastOpChange !== null) {
    if (input.forecastOpChange > 5) score += 20;       // 上方修正
    else if (input.forecastOpChange < -5) score -= 20;  // 下方修正
  }

  // PER割安/割高
  if (input.per !== null && input.sectorAvgPer !== null && input.sectorAvgPer > 0) {
    const perRatio = input.per / input.sectorAvgPer;
    if (perRatio < 0.8) score += 15;  // 割安（業種平均の80%未満）
    else if (perRatio > 1.3) score -= 10; // 割高（業種平均の130%超）
  }

  // 配当利回り
  if (input.dividendYield !== null) {
    if (input.dividendYield >= 3.0) score += 10;  // 高配当
    else if (input.dividendYield === 0) score -= 5; // 無配
  }

  // 自己資本比率
  if (input.equityRatio !== null) {
    if (input.equityRatio >= 50) score += 5;      // 財務健全
    else if (input.equityRatio < 20) score -= 10;  // 財務脆弱
  }

  return Math.min(100, Math.max(5, score)); // 5-100にクランプ
}

/** 需給熱スコア計算（0-100） */
function calcThemeScore(input: StockScoreInput): number {
  const scores: number[] = [];

  // 出来高変化率（5日平均/20日平均）— 重み40%
  if (input.vol5dAvg && input.vol20dAvg && input.vol20dAvg > 0) {
    const ratio = input.vol5dAvg / input.vol20dAvg;
    // ratio=1.0 → 50点、ratio=2.0 → 100点、ratio=0.5 → 0点
    const volScore = Math.min(100, Math.max(0, (ratio - 0.5) / 1.5 * 100));
    scores.push({ score: volScore, weight: 0.40 } as any);
  } else {
    scores.push({ score: 50, weight: 0.40 } as any); // データなし→中間値
  }

  // 出来高加速度（昨日 vs 前々日）— 重み20%
  if (input.vol1d && input.volYesterday && input.vol20dAvg && input.vol20dAvg > 0) {
    const accelToday = input.vol1d / input.vol20dAvg;
    const accelYesterday = input.volYesterday / input.vol20dAvg;
    const accel = accelToday - accelYesterday;
    const accelScore = Math.min(100, Math.max(0, 50 + accel * 50));
    scores.push({ score: accelScore, weight: 0.20 } as any);
  } else {
    scores.push({ score: 50, weight: 0.20 } as any);
  }

  // 値幅変化率（当日high-low / 20日平均high-low）— 重み25%
  if (input.highLow1d !== null && input.highLow20dAvg && input.highLow20dAvg > 0) {
    const ratio = input.highLow1d / input.highLow20dAvg;
    const rangeScore = Math.min(100, Math.max(0, (ratio - 0.5) / 1.5 * 100));
    scores.push({ score: rangeScore, weight: 0.25 } as any);
  } else {
    scores.push({ score: 50, weight: 0.25 } as any);
  }

  // ニュース言及急増（過去3日/14日比）— 重み15%
  const newsRatio = input.newsCount14d > 0
    ? (input.newsCount3d / 3) / (input.newsCount14d / 14)
    : 1.0;
  const newsScore = Math.min(100, Math.max(0, (newsRatio - 0.5) / 2.5 * 100));
  scores.push({ score: newsScore, weight: 0.15 } as any);

  // 加重合計
  const total = (scores as any[]).reduce((sum, s) => sum + s.score * s.weight, 0);
  return Math.min(100, Math.max(0, total));
}

/** モメンタムスコア計算（0-100） */
function calcMomentumScore(input: StockScoreInput): number {
  const scores: Array<{ score: number; weight: number }> = [];

  // 方向明確度: |RSI-50|/50 — 重み40%
  if (input.rsi !== null) {
    const dirScore = Math.abs(input.rsi - 50) / 50 * 100;
    scores.push({ score: dirScore, weight: 0.40 });
  } else {
    scores.push({ score: 50, weight: 0.40 });
  }

  // トレンド強度: ADX — 重み30%
  if (input.adx !== null) {
    // ADX<20 → 0点、ADX=25 → 50点、ADX=40+ → 100点
    const adxScore = Math.min(100, Math.max(0, (input.adx - 20) / 20 * 100));
    scores.push({ score: adxScore, weight: 0.30 });
  } else {
    scores.push({ score: 50, weight: 0.30 });
  }

  // 価格位置（52週レンジ）— 重み30%
  if (input.week52High !== null && input.week52Low !== null && input.currentPrice !== null) {
    const range = input.week52High - input.week52Low;
    if (range > 0) {
      const pos = (input.currentPrice - input.week52Low) / range; // 0-1
      // 上位20%または下位20%で高スコア（方向性明確）
      const posScore = pos >= 0.8 || pos <= 0.2
        ? 100
        : Math.abs(pos - 0.5) / 0.5 * 80;
      scores.push({ score: posScore, weight: 0.30 });
    } else {
      scores.push({ score: 50, weight: 0.30 });
    }
  } else {
    scores.push({ score: 50, weight: 0.30 });
  }

  return scores.reduce((sum, s) => sum + s.score * s.weight, 0);
}

/** 総合スコアを計算 */
export function calcStockScore(input: StockScoreInput): StockScore {
  const { fail, reason } = checkFundaFail(input);

  if (fail) {
    return {
      symbol: input.symbol,
      displayName: input.displayName,
      themeScore: 0,
      fundaScore: 0,
      momentumScore: 0,
      totalScore: 0,
      fundaFail: true,
      fundaFailReason: reason,
      daysToEarnings: calcDaysToEarnings(input.nextEarningsDate),
    };
  }

  const themeScore = calcThemeScore(input);
  const fundaScore = calcFundaScore(input);
  const momentumScore = calcMomentumScore(input);
  const totalScore = themeScore * 0.50 + momentumScore * 0.30 + fundaScore * 0.20;

  return {
    symbol: input.symbol,
    displayName: input.displayName,
    themeScore: Math.round(themeScore * 10) / 10,
    fundaScore: Math.round(fundaScore * 10) / 10,
    momentumScore: Math.round(momentumScore * 10) / 10,
    totalScore: Math.round(totalScore * 10) / 10,
    fundaFail: false,
    fundaFailReason: null,
    daysToEarnings: calcDaysToEarnings(input.nextEarningsDate),
  };
}

function calcDaysToEarnings(nextEarningsDate: string | null): number | null {
  if (!nextEarningsDate) return null;
  const days = Math.ceil(
    (new Date(nextEarningsDate).getTime() - Date.now()) / (1000 * 3600 * 24)
  );
  return days >= 0 ? days : null;
}

/** スコアをD1に保存（UPSERT） */
export async function saveScores(
  db: D1Database,
  scores: StockScore[],
  scoredAt: string  // 'YYYY-MM-DD'
): Promise<void> {
  // ランクを付与
  const ranked = [...scores]
    .filter(s => !s.fundaFail)
    .sort((a, b) => b.totalScore - a.totalScore);

  for (let i = 0; i < ranked.length; i++) {
    const s = ranked[i];
    await db.prepare(`
      INSERT OR REPLACE INTO stock_scores
        (symbol, scored_at, theme_score, funda_score, momentum_score, total_score, rank, in_universe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      s.symbol, scoredAt,
      s.themeScore, s.fundaScore, s.momentumScore, s.totalScore,
      i + 1, 0  // in_universeはrotation.tsで更新
    ).run();
  }
}

/** ニュース言及数をカウント */
export async function countNewsForSymbol(
  db: D1Database,
  displayName: string,  // 'トヨタ' or '7203' etc
  days: number
): Promise<number> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const result = await db.prepare(`
    SELECT COUNT(*) as cnt FROM news_raw
    WHERE created_at >= ?
    AND (title_ja LIKE ? OR desc_ja LIKE ?)
    AND haiku_accepted = 1
  `).bind(since, `%${displayName}%`, `%${displayName}%`)
    .first<{ cnt: number }>();
  return result?.cnt ?? 0;
}

/** 業種平均PERを取得（market_cacheから。なければYahoo Financeから推定） */
export async function getSectorAvgPer(
  db: D1Database,
  sector: string | null
): Promise<number | null> {
  if (!sector) return null;
  const key = `sector_per_${sector}`;
  const cached = await db.prepare("SELECT value FROM market_cache WHERE key = ?")
    .bind(key).first<{ value: string }>();
  if (cached) return parseFloat(cached.value) || null;
  // デフォルト値（業種平均PER参考値）
  const defaults: Record<string, number> = {
    '半導体': 30, '電機': 20, '輸送用機器': 12, '銀行': 10,
    '保険': 15, '小売': 25, '情報・通信': 28, '医薬品': 35,
    '化学': 18, '機械': 16, '鉄鋼': 10, '建設': 14,
  };
  for (const [key2, val] of Object.entries(defaults)) {
    if (sector.includes(key2)) return val;
  }
  return 20; // 全業種平均
}
```

- [ ] **Step 2: ビルドエラーを確認**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: コミット**

```bash
git add src/scoring.ts
git commit -m "feat: add Testa-style 3-axis scoring engine (src/scoring.ts)"
```

---

## Task 4: Rotation Logic (`src/rotation.ts`)

**Files:**
- Create: `src/rotation.ts`

2層リスト管理（追跡15銘柄/候補50銘柄）と入替え判定・承認・自動承認

- [ ] **Step 1: `src/rotation.ts` を作成**

```typescript
// src/rotation.ts
// 銘柄入替え判定・承認・自動承認ロジック
// 2層構造: 追跡リスト（最大15銘柄、7日ロック）+ 候補リスト（最大50銘柄）

import type { D1Database } from '@cloudflare/workers-types';
import { INSTRUMENTS, InstrumentConfig } from './instruments';

const TRACKING_MAX = 15;
const LOCK_DAYS = 7;
const AUTO_APPROVE_HOURS = 24;
const PROMOTION_TOP_N = 20;
const PROMOTION_DAYS = 3;
const DEMOTION_LOW_THEME = 20;
const DEMOTION_DAYS = 5;
const DEMOTION_WINDOW = 7;
const REJECTION_BLOCK_DAYS = 7;

export interface RotationProposal {
  id?: number;
  proposedAt: string;
  inSymbol: string;
  inScore: number;
  outSymbol: string;
  outScore: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'AUTO_APPROVED';
  decidedAt?: string;
  decidedBy?: string;
  inResultPnl?: number | null;
  outResultPnl?: number | null;
}

/** 現在の追跡リストを取得 */
export async function getTrackingList(db: D1Database): Promise<InstrumentConfig[]> {
  const rows = await db.prepare(
    "SELECT config_json FROM active_instruments ORDER BY added_at DESC"
  ).all<{ config_json: string }>();

  if (!rows.results || rows.results.length === 0) {
    // D1が空 → instruments.tsのハードコード日本株をフォールバック
    return INSTRUMENTS.filter(
      i => i.assetClass === 'stock' && i.stockSymbol?.endsWith('.T')
    );
  }

  return rows.results.map(r => JSON.parse(r.config_json) as InstrumentConfig);
}

/** active_instrumentsテーブルを追跡リストで更新 */
export async function updateActiveInstruments(
  db: D1Database,
  instruments: InstrumentConfig[],
  addedAt: string
): Promise<void> {
  // 既存の全行を削除してから再挿入
  await db.prepare("DELETE FROM active_instruments").run();

  for (const inst of instruments) {
    await db.prepare(`
      INSERT INTO active_instruments (pair, config_json, added_at, source, updated_at)
      VALUES (?, ?, ?, 'auto', ?)
    `).bind(
      inst.pair,
      JSON.stringify(inst),
      addedAt,
      new Date().toISOString()
    ).run();
  }
}

/** 候補リスト（stock_scoresから上位50銘柄）を取得 */
export async function getCandidateList(db: D1Database): Promise<Array<{ symbol: string; rank: number; totalScore: number; themeScore: number }>> {
  const today = new Date().toISOString().split('T')[0];
  const rows = await db.prepare(`
    SELECT symbol, rank, total_score, theme_score FROM stock_scores
    WHERE scored_at = ? AND rank <= 50
    ORDER BY rank ASC
  `).bind(today).all<{ symbol: string; rank: number; total_score: number; theme_score: number }>();

  return (rows.results ?? []).map(r => ({
    symbol: r.symbol,
    rank: r.rank,
    totalScore: r.total_score,
    themeScore: r.theme_score,
  }));
}

/** 昇格候補を検出（候補リストで3日連続Top20 かつ 需給熱≥60） */
export async function detectPromotionCandidates(
  db: D1Database,
  currentTrackingSymbols: string[]
): Promise<string[]> {
  const today = new Date();
  const dates = Array.from({ length: PROMOTION_DAYS }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    return d.toISOString().split('T')[0];
  });

  const promotable: string[] = [];

  // 各候補銘柄が3日連続Top20 かつ 需給熱≥60かチェック
  const candidateRows = await db.prepare(`
    SELECT symbol, COUNT(*) as days, MIN(theme_score) as min_theme
    FROM stock_scores
    WHERE scored_at IN (${dates.map(() => '?').join(',')})
    AND rank <= ${PROMOTION_TOP_N}
    AND theme_score >= 60
    GROUP BY symbol
    HAVING days = ${PROMOTION_DAYS}
  `).bind(...dates).all<{ symbol: string; days: number; min_theme: number }>();

  for (const row of (candidateRows.results ?? [])) {
    if (!currentTrackingSymbols.includes(row.symbol)) {
      promotable.push(row.symbol);
    }
  }

  return promotable;
}

/** 降格候補を検出（7日ロック終了後、直近7日のうち需給熱≤20が5日以上） */
export async function detectDemotionCandidates(
  db: D1Database,
  trackingList: Array<{ symbol: string; addedAt: string }>
): Promise<string[]> {
  const today = new Date();
  const demotable: string[] = [];

  for (const t of trackingList) {
    // 7日ロック確認
    const addedAt = new Date(t.addedAt);
    const lockExpired = (today.getTime() - addedAt.getTime()) / (1000 * 3600 * 24) >= LOCK_DAYS;
    if (!lockExpired) continue;

    // 直近7日の需給熱スコア
    const dates = Array.from({ length: DEMOTION_WINDOW }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      return d.toISOString().split('T')[0];
    });

    const rows = await db.prepare(`
      SELECT COUNT(*) as low_days FROM stock_scores
      WHERE symbol = ?
      AND scored_at IN (${dates.map(() => '?').join(',')})
      AND theme_score <= ${DEMOTION_LOW_THEME}
    `).bind(t.symbol, ...dates).first<{ low_days: number }>();

    if ((rows?.low_days ?? 0) >= DEMOTION_DAYS) {
      demotable.push(t.symbol);
    }
  }

  return demotable;
}

/** 拒否ブロック中かどうかチェック */
async function isRejectionBlocked(db: D1Database, inSymbol: string): Promise<boolean> {
  const since = new Date(Date.now() - REJECTION_BLOCK_DAYS * 24 * 3600 * 1000).toISOString();
  const row = await db.prepare(`
    SELECT id FROM rotation_log
    WHERE in_symbol = ? AND status = 'REJECTED' AND proposed_at >= ?
    LIMIT 1
  `).bind(inSymbol, since).first();
  return !!row;
}

/** 入替え提案を作成（PENDING状態でrotation_logに挿入） */
export async function proposeRotation(
  db: D1Database,
  inSymbol: string,
  inScore: number,
  outSymbol: string,
  outScore: number
): Promise<void> {
  // 拒否ブロック確認
  if (await isRejectionBlocked(db, inSymbol)) {
    console.log(`[rotation] ${inSymbol} is rejection-blocked, skipping proposal`);
    return;
  }

  // 既存のPENDINGがあれば重複しない
  const existing = await db.prepare(
    "SELECT id FROM rotation_log WHERE status = 'PENDING' AND in_symbol = ?"
  ).bind(inSymbol).first();
  if (existing) return;

  await db.prepare(`
    INSERT INTO rotation_log (proposed_at, in_symbol, in_score, out_symbol, out_score, status)
    VALUES (?, ?, ?, ?, ?, 'PENDING')
  `).bind(new Date().toISOString(), inSymbol, inScore, outSymbol, outScore).run();

  console.log(`[rotation] Proposed: IN=${inSymbol}(${inScore}) OUT=${outSymbol}(${outScore})`);
}

/** ユーザーによる承認/拒否処理 */
export async function decideRotation(
  db: D1Database,
  id: number,
  action: 'approve' | 'reject'
): Promise<{ success: boolean; message: string }> {
  const row = await db.prepare(
    "SELECT * FROM rotation_log WHERE id = ? AND status = 'PENDING'"
  ).bind(id).first<RotationProposal & { id: number }>();

  if (!row) {
    return { success: false, message: 'Not found or already decided' };
  }

  const status = action === 'approve' ? 'APPROVED' : 'REJECTED';
  await db.prepare(
    "UPDATE rotation_log SET status = ?, decided_at = ?, decided_by = 'user' WHERE id = ?"
  ).bind(status, new Date().toISOString(), id).run();

  if (action === 'approve') {
    await executeRotation(db, row.inSymbol, row.outSymbol);
  }

  return { success: true, message: `${action}d rotation #${id}` };
}

/** 24時間タイムアウトで自動承認 */
export async function processAutoApproval(db: D1Database): Promise<void> {
  const threshold = new Date(Date.now() - AUTO_APPROVE_HOURS * 3600 * 1000).toISOString();
  const pending = await db.prepare(`
    SELECT * FROM rotation_log
    WHERE status = 'PENDING' AND proposed_at < ?
  `).bind(threshold).all<RotationProposal & { id: number }>();

  for (const row of (pending.results ?? [])) {
    await db.prepare(
      "UPDATE rotation_log SET status = 'AUTO_APPROVED', decided_at = ?, decided_by = 'timer' WHERE id = ?"
    ).bind(new Date().toISOString(), row.id).run();

    await executeRotation(db, row.inSymbol, row.outSymbol);
    console.log(`[rotation] Auto-approved: IN=${row.inSymbol} OUT=${row.outSymbol}`);
  }
}

/** 承認後に実際の入替えを実行（active_instrumentsを更新） */
async function executeRotation(db: D1Database, inSymbol: string, outSymbol: string): Promise<void> {
  // outSymbolを追跡リストから削除
  await db.prepare("DELETE FROM active_instruments WHERE pair LIKE ?")
    .bind(`%${outSymbol}%`).run();

  // inSymbolのInstrumentConfigを構築（instruments.tsのデフォルト設定を使用）
  // 注意: inSymbolが既存の43銘柄リストにない場合、defaultパラメータで追加
  const baseConfig = INSTRUMENTS.find(i => i.stockSymbol === inSymbol)
    ?? buildDefaultJpStockConfig(inSymbol);

  await db.prepare(`
    INSERT OR REPLACE INTO active_instruments (pair, config_json, added_at, source, updated_at)
    VALUES (?, ?, ?, 'auto', ?)
  `).bind(
    baseConfig.pair,
    JSON.stringify(baseConfig),
    new Date().toISOString(),
    new Date().toISOString()
  ).run();

  console.log(`[rotation] Executed: IN=${inSymbol} OUT=${outSymbol}`);
}

/** 新銘柄のデフォルトInstrumentConfig構築 */
function buildDefaultJpStockConfig(stockSymbol: string): InstrumentConfig {
  const code = stockSymbol.replace('.T', '');
  return {
    pair: `JP${code}`,
    broker: 'paper',
    oandaSymbol: null,
    rateChangeTh: 50,
    tpSlHint: '300-500円幅',
    tpSlMin: 100,
    tpSlMax: 1000,
    rrMax: 5.0,
    pnlUnit: '円',
    pnlMultiplier: 100,
    trailingActivation: 200,
    trailingDistance: 100,
    correlationGroup: 'jp_value',
    tier: 'C',
    tierLotMultiplier: 0.5,
    assetClass: 'stock',
    stockSymbol,
    minUnit: 100,
    tradingHoursJST: { open: 9, close: 15 },
  };
}

/** 7日後のPnLを計算して記録 */
export async function recordResultPnl(db: D1Database): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const readyRows = await db.prepare(`
    SELECT * FROM rotation_log
    WHERE status IN ('APPROVED', 'AUTO_APPROVED')
    AND decided_at < ?
    AND in_result_pnl IS NULL
  `).bind(sevenDaysAgo).all<RotationProposal & { id: number }>();

  for (const row of (readyRows.results ?? [])) {
    // Yahoo Financeから現在の株価を取得してリターンを計算
    // （実装は indicators.ts の既存パターンに合わせる）
    const inPnl = await calcSevenDayReturn(db, row.inSymbol, row.decidedAt!);
    const outPnl = await calcSevenDayReturn(db, row.outSymbol, row.decidedAt!);

    await db.prepare(
      "UPDATE rotation_log SET in_result_pnl = ?, out_result_pnl = ? WHERE id = ?"
    ).bind(inPnl, outPnl, row.id).run();
  }
}

/** 承認日から現在までの株価リターン（%）を計算 */
async function calcSevenDayReturn(
  db: D1Database,
  symbol: string,
  fromDate: string
): Promise<number | null> {
  try {
    // market_cacheから承認日の株価を取得（なければスキップ）
    const cacheKey = `price_${symbol}_${fromDate.split('T')[0]}`;
    const cached = await db.prepare("SELECT value FROM market_cache WHERE key = ?")
      .bind(cacheKey).first<{ value: string }>();

    const fromPrice = cached ? parseFloat(cached.value) : null;
    if (!fromPrice) return null;

    // 現在の株価をYahoo Financeから取得
    const code = symbol.replace('.T', '');
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?interval=1d&range=1d`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    const currentPrice = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!currentPrice) return null;

    return Math.round((currentPrice / fromPrice - 1) * 100 * 10) / 10;
  } catch {
    return null;
  }
}

/** 未決定のPENDING提案一覧 */
export async function getPendingRotations(db: D1Database): Promise<(RotationProposal & { id: number })[]> {
  const rows = await db.prepare(
    "SELECT * FROM rotation_log WHERE status = 'PENDING' ORDER BY proposed_at DESC"
  ).all<RotationProposal & { id: number }>();
  return rows.results ?? [];
}
```

- [ ] **Step 2: ビルドエラーを確認**

```bash
npx tsc --noEmit 2>&1 | head -50
```

- [ ] **Step 3: コミット**

```bash
git add src/rotation.ts
git commit -m "feat: add rotation logic with 2-tier list management (src/rotation.ts)"
```

---

## Task 5: Active Instruments D1 Integration (`src/instruments.ts`)

**Files:**
- Modify: `src/instruments.ts`

`getActiveInstruments()` 関数を追加。日本株のみD1フォールバック。

- [ ] **Step 1: `src/instruments.ts` の末尾に関数を追加**

ファイルの末尾（最後のexport文の後）に追加:

```typescript
/**
 * 日本株の追跡リストをD1から取得する。
 * D1が空またはエラーの場合はINSTRUMENTS配列のハードコード日本株をフォールバック。
 * FX・コモディティ・株式指数・米株は常にINSTRUMENTS配列を使用。
 */
export async function getActiveJpStocks(db: D1Database): Promise<InstrumentConfig[]> {
  try {
    const rows = await db.prepare(
      "SELECT config_json FROM active_instruments ORDER BY added_at DESC"
    ).all<{ config_json: string }>();

    if (rows.results && rows.results.length > 0) {
      return rows.results.map(r => JSON.parse(r.config_json) as InstrumentConfig);
    }
  } catch (e) {
    console.warn('[instruments] getActiveJpStocks D1 error, using fallback:', e);
  }

  // フォールバック: instruments.tsのハードコード日本株
  return INSTRUMENTS.filter(
    i => i.assetClass === 'stock' && i.stockSymbol?.endsWith('.T')
  );
}

/** 全銘柄（FX+指数+商品+米株+アクティブ日本株）を取得 */
export async function getAllActiveInstruments(db: D1Database): Promise<InstrumentConfig[]> {
  const nonJpStocks = INSTRUMENTS.filter(
    i => !(i.assetClass === 'stock' && i.stockSymbol?.endsWith('.T'))
  );
  const jpStocks = await getActiveJpStocks(db);
  return [...nonJpStocks, ...jpStocks];
}
```

`src/instruments.ts` の先頭のimportに追加（まだない場合）:

```typescript
import type { D1Database } from '@cloudflare/workers-types';
```

- [ ] **Step 2: ビルドエラーを確認**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: コミット**

```bash
git add src/instruments.ts
git commit -m "feat: add getActiveJpStocks() D1 fallback to instruments.ts"
```

---

## Task 6: News Filter Bias (`src/news.ts`)

**Files:**
- Modify: `src/news.ts` (L617, L696, L840, L867, plus new bias logic)

composite閾値の動的制御と個別株ニュースのbreadth無効化

- [ ] **Step 1: `computeComposite`関数に`isStockSpecific`パラメータを追加**

`src/news.ts` L617の関数を以下に変更:

```typescript
/** 7軸加重合計スコアを計算（0〜10）
 * isStockSpecific=trueの場合、breadth(b)を無効化しrelevance(r)に再配分 */
function computeComposite(
  t: number, u: number, r: number, c: number,
  s: number, b: number, n: number,
  isStockSpecific = false
): number {
  if (isStockSpecific) {
    // 個別株ニュース: breadthは無関係（そのニュースが自銘柄に関係あるかが全て）
    return t * 0.20 + u * 0.15 + r * 0.35 + c * 0.15 + s * 0.10 + n * 0.05;
  }
  return (
    t * 0.20 + u * 0.15 + r * 0.30 + c * 0.15 + s * 0.10 + b * 0.05 + n * 0.05
  );
}
```

- [ ] **Step 2: L696とL867の呼び出し箇所に`isStockSpecific`を渡す**

L696付近の呼び出し:
```typescript
// 変更前:
const composite = computeComposite(t, u, ai.r, ai.c, ai.s, ai.b, ai.n);
// 変更後（キャッシュヒット時）:
const isStockSpecific = r.source?.includes('JP') || r.source?.includes('.T') || false;
const composite = computeComposite(t, u, ai.r, ai.c, ai.s, ai.b, ai.n, isStockSpecific);
```

L867付近の呼び出し:
```typescript
// 変更後（Haiku結果処理時）:
const itemIsStockSpecific = items[r.index]?.source?.includes('.T') || false;
const composite = computeComposite(t, u, ai.r, ai.c, ai.s, ai.b, ai.n, itemIsStockSpecific);
```

- [ ] **Step 3: 保有状態バイアス関数を追加**

`src/news.ts` に以下を追加（`getNewsForPair` 関数の前あたり）:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// 保有状態バイアス（composite閾値の動的制御）
// テスタ: 「どうしたら負けないで済むか」— 保有中は些細なニュースも見逃さない
// ─────────────────────────────────────────────────────────────────────────────

export interface HoldingBias {
  thresholdOverrides: Map<string, number>;   // pair → composite閾値
  attentionPairs: string[];                  // 注目優先銘柄
  maxItemsOverrides: Map<string, number>;    // pair → 最大取得件数
}

/**
 * 保有・追跡・候補状態に応じたcomposite閾値バイアスを計算
 * @param openPositionPairs 保有中のpair名リスト
 * @param trackingPairs 追跡リストのpair名リスト
 * @param candidatePairs 候補リストのpair名リスト
 */
export function buildHoldingBias(
  openPositionPairs: string[],
  trackingPairs: string[],
  candidatePairs: string[]
): HoldingBias {
  const thresholdOverrides = new Map<string, number>();
  const maxItemsOverrides = new Map<string, number>();

  for (const pair of openPositionPairs) {
    thresholdOverrides.set(pair, 4.0);  // 緩和
    maxItemsOverrides.set(pair, 10);
  }
  for (const pair of trackingPairs) {
    if (!thresholdOverrides.has(pair)) {
      thresholdOverrides.set(pair, 5.0);  // やや緩
      maxItemsOverrides.set(pair, 7);
    }
  }
  for (const pair of candidatePairs) {
    if (!thresholdOverrides.has(pair)) {
      thresholdOverrides.set(pair, 6.0);  // 通常
      maxItemsOverrides.set(pair, 5);
    }
  }

  return {
    thresholdOverrides,
    attentionPairs: [...openPositionPairs, ...trackingPairs],
    maxItemsOverrides,
  };
}

/**
 * ニュースアイテムに対する実効的なcomposite閾値を返す
 * デフォルト6.5、保有中なら緩和
 */
export function getEffectiveThreshold(
  news: { source?: string; pair?: string },
  bias: HoldingBias | null,
  defaultThreshold = 6.5
): number {
  if (!bias) return defaultThreshold;
  // pairフィールドがあればそれで検索
  if (news.pair && bias.thresholdOverrides.has(news.pair)) {
    return bias.thresholdOverrides.get(news.pair)!;
  }
  return defaultThreshold;
}
```

- [ ] **Step 4: ビルドエラーを確認**

```bash
npx tsc --noEmit 2>&1 | head -50
```

- [ ] **Step 5: コミット**

```bash
git add src/news.ts
git commit -m "feat: news filter bias — dynamic composite threshold by holding status"
```

---

## Task 7: Gemini Funda Prompt Integration (`src/gemini.ts`)

**Files:**
- Modify: `src/gemini.ts`

株式銘柄のみファンダ参考情報をnewsStage1プロンプトに注入

- [ ] **Step 1: ファンダ参考情報生成関数を追加**

`src/gemini.ts` に以下を追加（`newsStage1` 関数の前）:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// ファンダメンタル参考情報プロンプト生成
// ─────────────────────────────────────────────────────────────────────────────

export interface FundaContext {
  per: number | null;
  sectorAvgPer: number | null;
  forecastOpChange: number | null;  // 前年比%
  daysToEarnings: number | null;
  themeScore: number | null;        // 需給熱スコア
  volChange: number | null;         // 出来高変化率
  fundaFail: boolean;
  fundaFailReason: string | null;
  isThemeStock: boolean;
}

export function buildFundaPromptSection(ctx: FundaContext): string {
  if (ctx.fundaFail && ctx.fundaFailReason) {
    return `\n【地雷警告: ${ctx.fundaFailReason}。エントリー禁止。】\n`;
  }

  if (ctx.daysToEarnings !== null && ctx.daysToEarnings <= 3 && ctx.daysToEarnings >= 0) {
    return `\n【決算直前（${ctx.daysToEarnings}日後）: 新規エントリー非推奨。】\n`;
  }

  const lines: string[] = [];
  lines.push('\n=== ファンダメンタル参考情報（判断の主因にしないこと）===');

  if (ctx.per !== null && ctx.sectorAvgPer !== null) {
    const ratio = ctx.per / ctx.sectorAvgPer;
    const label = ratio < 0.8 ? '割安' : ratio > 1.3 ? '割高' : '適正';
    lines.push(`PER: ${ctx.per.toFixed(1)}倍（業種平均${ctx.sectorAvgPer.toFixed(1)}倍）→ ${label}`);
  }

  if (ctx.forecastOpChange !== null) {
    const dir = ctx.forecastOpChange > 5 ? '上方修正' : ctx.forecastOpChange < -5 ? '下方修正' : '据置';
    lines.push(`業績予想: 営業利益 前年比${ctx.forecastOpChange.toFixed(1)}%（${dir}）`);
  }

  if (ctx.daysToEarnings !== null) {
    lines.push(`次回決算: ${ctx.daysToEarnings}日後`);
  }

  if (ctx.themeScore !== null) {
    const volStr = ctx.volChange !== null ? `出来高変化率${ctx.volChange.toFixed(0)}%` : '';
    lines.push(`需給熱スコア: ${ctx.themeScore.toFixed(0)}/100（${volStr}）`);
  }

  lines.push('ファンダ判定: PASS');

  if (ctx.isThemeStock) {
    lines.push('【テーマ株モード: ファンダより需給を優先せよ】');
  }

  lines.push('===');
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 2: `newsStage1` の instruments処理に funda_context注入を追加**

`newsStage1` 関数内の instruments描写部分（対象ペアのプロンプト生成）で、stockかどうかを判定してファンダセクションを追加。

`src/gemini.ts` の `newsStage1` 関数の instruments処理部分を探し、以下を追加:

```typescript
// instruments.map()の中で、各instrumentについて:
// 変更前:
const instLine = `${inst.pair}${openTag}[rate=${inst.currentRate ?? '?'}]`;

// 変更後:
const isStock = inst.pair.includes('T)') || inst.pair.startsWith('JP');
const fundaSection = isStock && inst.fundaContext
  ? buildFundaPromptSection(inst.fundaContext)
  : '';
const instLine = `${inst.pair}${openTag}[rate=${inst.currentRate ?? '?'}]${fundaSection}`;
```

newsStage1のparams interfaceに`fundaContext`を追加:

```typescript
instruments: Array<{
  pair: string;
  hasOpenPosition: boolean;
  tpSlHint?: string;
  correlationGroup?: string;
  currentRate?: number;
  directionBias?: { buyAvgRR: number; sellAvgRR: number };
  fundaContext?: FundaContext;  // 追加
}>;
```

- [ ] **Step 3: `funda_context`フィールドをGeminiレスポンスに追加**

`GeminiDecision` interfaceに追加:

```typescript
export interface GeminiDecision {
  decision: 'BUY' | 'SELL' | 'HOLD';
  tp_rate: number | null;
  sl_rate: number | null;
  reasoning: string;
  funda_context?: 'used' | 'ignored' | 'blocked';  // 追加
}
```

- [ ] **Step 4: ビルドエラーを確認**

```bash
npx tsc --noEmit 2>&1 | head -50
```

- [ ] **Step 5: コミット**

```bash
git add src/gemini.ts
git commit -m "feat: inject funda context into Gemini newsStage1 prompt (stocks only)"
```

---

## Task 8: TP Correction in Sanity (`src/sanity.ts`)

**Files:**
- Modify: `src/sanity.ts`

Gemini提案TP/SLへのファンダベースmultiplier補正をclampTpSl直前に適用

- [ ] **Step 1: `src/sanity.ts` にTP補正関数を追加**

`checkTpSlSanity` 関数の手前に追加:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// ファンダベースTP multiplier補正
// テスタ: SLは変えない。TPのみ理論株価との乖離率で微調整
// ─────────────────────────────────────────────────────────────────────────────

export interface FundaTpCorrectionParams {
  direction: 'BUY' | 'SELL';
  rate: number;      // 現在株価
  tp: number | null;
  eps: number | null;
  sectorAvgPer: number | null;
  isThemeStock: boolean;
  fundaUpdatedAt: string | null;  // fundamentals.updated_atのISO8601
}

/**
 * ファンダデータに基づいてTP multiplierを補正する
 * - 割安(乖離率>15%): multiplier ×1.2
 * - 割高(乖離率<-10%): multiplier ×0.8
 * - テーマ株 or データ古い(7日以上): 補正なし
 */
export function applyFundaTpCorrection(params: FundaTpCorrectionParams): number | null {
  const { direction, rate, tp, eps, sectorAvgPer, isThemeStock, fundaUpdatedAt } = params;

  if (!tp) return tp;

  // テーマ株は補正無効（モメンタム優先）
  if (isThemeStock) return tp;

  // データが7日以上古い場合は補正無効
  if (fundaUpdatedAt) {
    const daysOld = (Date.now() - new Date(fundaUpdatedAt).getTime()) / (1000 * 3600 * 24);
    if (daysOld > 7) return tp;
  } else {
    return tp; // データなし → 補正なし
  }

  // 理論株価を計算
  if (!eps || !sectorAvgPer || sectorAvgPer <= 0 || rate <= 0) return tp;

  const theoreticalPrice = eps * sectorAvgPer;
  const deviation = (theoreticalPrice - rate) / rate; // 正=割安、負=割高

  let multiplier = 1.0;
  if (deviation > 0.15) {
    multiplier = 1.2; // 割安: TPを広げる
  } else if (deviation < -0.10) {
    multiplier = 0.8; // 割高: TPを狭める
  } else {
    return tp; // 適正: 補正なし
  }

  // TP距離を補正
  const tpDist = Math.abs(tp - rate);
  const correctedDist = tpDist * multiplier;

  return direction === 'BUY'
    ? rate + correctedDist
    : rate - correctedDist;
}
```

- [ ] **Step 2: ビルドエラーを確認**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 3: コミット**

```bash
git add src/sanity.ts
git commit -m "feat: add funda-based TP multiplier correction to sanity.ts"
```

---

## Task 9: Index.ts Cron Integration

**Files:**
- Modify: `src/index.ts`

新cronハンドラをscheduled()のswitchに追加

- [ ] **Step 1: `Env` interfaceに`JQUANTS_REFRESH_TOKEN`を追加**

`src/index.ts` の `Env` interface に追加:

```typescript
JQUANTS_REFRESH_TOKEN?: string;
```

- [ ] **Step 2: `scheduled()` ハンドラをcron分岐対応に変更**

```typescript
async scheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const cron = event.cron;
  switch (cron) {
    case '* * * * *':
      // 既存のメインloop
      ctx.waitUntil(run(env));
      break;
    case '0 21 * * *':
      // 日次スコアリング (JST 06:00)
      ctx.waitUntil(runDailyScoring(env));
      break;
    case '0 18 * * 6':
      // 週次スクリーニング① (JST 日曜03:00)
      ctx.waitUntil(runWeeklyScreeningBatch(env));
      break;
    case '5 18 * * 6':
      // 週次スクリーニング② (JST 日曜03:05)
      ctx.waitUntil(runWeeklyScreeningFinalize(env));
      break;
    case '0 * * * *':
      // 自動承認チェック (毎時)
      ctx.waitUntil(runAutoApproval(env));
      break;
    case '0 14 * * *':
      // 結果PnL記録 (JST 23:00)
      ctx.waitUntil(runResultPnl(env));
      break;
    default:
      // 未知のcron (念のため既存mainを呼ぶ)
      ctx.waitUntil(run(env));
  }
},
```

- [ ] **Step 3: 4つの新cronハンドラ関数を追加**

`src/index.ts` の末尾付近に追加:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// AI銘柄マネージャー cronハンドラ
// ─────────────────────────────────────────────────────────────────────────────
import { fetchFundamentals, saveFundamentals, fetchAllListedStocks, cleanupOldFundamentals } from './jquants';
import { calcStockScore, saveScores, countNewsForSymbol, getSectorAvgPer, StockScoreInput } from './scoring';
import { getTrackingList, getCandidateList, detectPromotionCandidates, detectDemotionCandidates, proposeRotation, processAutoApproval as autoApprove, recordResultPnl } from './rotation';
import { getAllActiveInstruments } from './instruments';

/** 日次スコアリング: JST 06:00 */
async function runDailyScoring(env: Env): Promise<void> {
  if (!env.JQUANTS_REFRESH_TOKEN) {
    console.warn('[daily-scoring] JQUANTS_REFRESH_TOKEN not set, skipping');
    return;
  }

  console.log('[daily-scoring] Start');
  const today = new Date().toISOString().split('T')[0];

  // 追跡リスト + 候補リストの銘柄を取得
  const trackingInsts = await getTrackingList(env.DB);
  const trackingSymbols = trackingInsts
    .filter(i => i.stockSymbol?.endsWith('.T'))
    .map(i => i.stockSymbol!);

  // 財務データを取得・保存
  const fundaData = await fetchFundamentals(env.DB, env.JQUANTS_REFRESH_TOKEN, trackingSymbols);
  await saveFundamentals(env.DB, fundaData);

  // スコアリング入力データを構築
  const scores = [];
  for (const inst of trackingInsts.filter(i => i.stockSymbol?.endsWith('.T'))) {
    const symbol = inst.stockSymbol!;
    const newsCount3d = await countNewsForSymbol(env.DB, inst.pair, 3);
    const newsCount14d = await countNewsForSymbol(env.DB, inst.pair, 14);
    const funda = fundaData.find(f => f.symbol === symbol);
    const sectorAvgPer = await getSectorAvgPer(env.DB, funda?.sector ?? null);

    // Yahoo Finance から出来高・値幅・52週レンジを取得
    let vol5dAvg = null, vol20dAvg = null, vol1d = null, volYesterday = null;
    let highLow1d = null, highLow20dAvg = null;
    let week52High = null, week52Low = null, currentPrice = null;

    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (res.ok) {
        const data = await res.json() as any;
        const result = data?.chart?.result?.[0];
        const closes: number[] = result?.indicators?.quote?.[0]?.close ?? [];
        const volumes: number[] = result?.indicators?.quote?.[0]?.volume ?? [];
        const highs: number[] = result?.indicators?.quote?.[0]?.high ?? [];
        const lows: number[] = result?.indicators?.quote?.[0]?.low ?? [];

        if (volumes.length >= 20) {
          const recentVols = volumes.filter(v => v > 0).slice(-20);
          vol20dAvg = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
          const last5 = recentVols.slice(-5);
          vol5dAvg = last5.reduce((a, b) => a + b, 0) / last5.length;
          vol1d = volumes[volumes.length - 1] || null;
          volYesterday = volumes[volumes.length - 2] || null;
        }

        if (highs.length >= 20 && lows.length >= 20) {
          const ranges = highs.map((h, i) => (h || 0) - (lows[i] || 0)).filter(r => r > 0);
          if (ranges.length > 0) {
            highLow1d = ranges[ranges.length - 1];
            highLow20dAvg = ranges.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, ranges.length);
          }
        }

        currentPrice = result?.meta?.regularMarketPrice ?? null;

        // 52週レンジ
        const res52 = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (res52.ok) {
          const data52 = await res52.json() as any;
          const result52 = data52?.chart?.result?.[0];
          const closes52: number[] = result52?.indicators?.quote?.[0]?.close ?? [];
          const validCloses = closes52.filter(c => c > 0);
          if (validCloses.length > 0) {
            week52High = Math.max(...validCloses);
            week52Low = Math.min(...validCloses);
          }
        }
      }
    } catch (e) {
      console.warn(`[daily-scoring] Yahoo Finance error for ${symbol}:`, e);
    }

    // RSI/ADX取得（既存logic-indicatorsから）
    let rsi: number | null = null;
    let adx: number | null = null;
    try {
      const cached = await env.DB.prepare(
        "SELECT value FROM market_cache WHERE key = ?"
      ).bind(`indicators_${symbol}_D`).first<{ value: string }>();
      if (cached) {
        const ind = JSON.parse(cached.value);
        rsi = ind.rsi14 ?? null;
        adx = ind.adx14 ?? null;
      }
    } catch {}

    const THEME_GROUPS = ['jp_ai_dc', 'jp_defense', 'jp_entertainment'];
    const isThemeStock = THEME_GROUPS.includes(inst.correlationGroup ?? '');

    const input: StockScoreInput = {
      symbol,
      stockSymbol: symbol,
      displayName: inst.pair,
      vol5dAvg, vol20dAvg, vol1d, volYesterday,
      highLow1d, highLow20dAvg,
      rsi, adx,
      week52High, week52Low, currentPrice,
      newsCount3d, newsCount14d,
      equityRatio: funda?.equityRatio ?? null,
      netProfit: funda?.netProfit ?? null,
      prevNetProfit: null, // 別途取得
      forecastOpChange: funda?.forecastOp && funda?.opProfit
        ? ((funda.forecastOp - funda.opProfit) / Math.abs(funda.opProfit)) * 100 : null,
      per: currentPrice && funda?.eps ? currentPrice / funda.eps : null,
      sectorAvgPer,
      dividendYield: currentPrice && funda?.dividend ? (funda.dividend / currentPrice) * 100 : null,
      marketCap: funda?.marketCap ?? null,
      nextEarningsDate: funda?.nextEarnings ?? null,
      isThemeStock,
    };

    const score = calcStockScore(input);
    scores.push(score);
  }

  await saveScores(env.DB, scores, today);

  // 入替え判定
  const trackingSymbolsSet = new Set(trackingSymbols);
  const promotable = await detectPromotionCandidates(env.DB, trackingSymbols);
  const trackingWithDates = await env.DB.prepare(
    "SELECT pair, added_at FROM active_instruments"
  ).all<{ pair: string; added_at: string }>();

  const demotable = await detectDemotionCandidates(
    env.DB,
    (trackingWithDates.results ?? []).map(r => ({
      symbol: r.pair,
      addedAt: r.added_at,
    }))
  );

  // 降格候補がいて、昇格候補がいれば入替え提案
  if (promotable.length > 0 && demotable.length > 0) {
    const candidates = await getCandidateList(env.DB);
    const bestPromotion = promotable[0];
    const worstDemotion = demotable[0];

    const promScore = candidates.find(c => c.symbol === bestPromotion)?.totalScore ?? 0;
    const demScore = scores.find(s => s.symbol === worstDemotion)?.totalScore ?? 0;

    await proposeRotation(env.DB, bestPromotion, promScore, worstDemotion, demScore);
  }

  await cleanupOldFundamentals(env.DB);
  console.log(`[daily-scoring] Done. Scored ${scores.length} stocks`);
}

/** 週次スクリーニング①: 全上場銘柄の財務サマリ取得（日曜03:00 JST） */
async function runWeeklyScreeningBatch(env: Env): Promise<void> {
  if (!env.JQUANTS_REFRESH_TOKEN) return;
  console.log('[weekly-screening-1] Start');

  // 全銘柄をページネーションで取得し、時価総額フィルタ後にmarket_cacheに候補リストを保存
  let pageToken: string | undefined;
  const allCandidates: Array<{ symbol: string; marketCap: number | null; sector: string | null }> = [];
  let page = 0;
  const MAX_PAGES = 10;

  do {
    const result = await fetchAllListedStocks(env.DB, env.JQUANTS_REFRESH_TOKEN, pageToken);
    allCandidates.push(...result.candidates);
    pageToken = result.nextPageToken ?? undefined;
    page++;
  } while (pageToken && page < MAX_PAGES);

  // 時価総額フィルタ: 50億〜5000億円（百万円単位: 5000〜500000）
  const filtered = allCandidates.filter(c =>
    c.marketCap !== null && c.marketCap >= 5000 && c.marketCap <= 500000
  );

  // market_cacheに保存
  await env.DB.prepare(
    "INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)"
  ).bind(
    'weekly_screening_candidates',
    JSON.stringify(filtered.slice(0, 500)), // 上位500件
    new Date().toISOString()
  ).run();

  console.log(`[weekly-screening-1] Done. ${allCandidates.length} total, ${filtered.length} filtered, stored ${Math.min(filtered.length, 500)}`);
}

/** 週次スクリーニング②: 候補50銘柄確定（日曜03:05 JST） */
async function runWeeklyScreeningFinalize(env: Env): Promise<void> {
  if (!env.JQUANTS_REFRESH_TOKEN) return;
  console.log('[weekly-screening-2] Start');

  const cached = await env.DB.prepare(
    "SELECT value FROM market_cache WHERE key = 'weekly_screening_candidates'"
  ).first<{ value: string }>();

  if (!cached) {
    console.warn('[weekly-screening-2] No candidates from step 1');
    return;
  }

  const candidates = JSON.parse(cached.value) as Array<{ symbol: string; marketCap: number | null; sector: string | null }>;

  // 今後の候補として財務データを取得（上位100銘柄）
  const top100 = candidates.slice(0, 100).map(c => c.symbol);
  const fundaData = await fetchFundamentals(env.DB, env.JQUANTS_REFRESH_TOKEN, top100);
  await saveFundamentals(env.DB, fundaData);

  console.log(`[weekly-screening-2] Done. Fetched fundamentals for ${fundaData.length} candidates`);
}

/** 自動承認チェック: 毎時 */
async function runAutoApproval(env: Env): Promise<void> {
  await autoApprove(env.DB);
}

/** 結果PnL記録: JST 23:00 */
async function runResultPnl(env: Env): Promise<void> {
  await recordResultPnl(env.DB);
}
```

- [ ] **Step 4: ビルドエラーを確認・修正**

```bash
npx tsc --noEmit 2>&1 | head -50
```

- [ ] **Step 5: コミット**

```bash
git add src/index.ts
git commit -m "feat: add cron handlers for daily scoring, weekly screening, auto-approval"
```

---

## Task 10: New API Endpoints (`src/api.ts`)

**Files:**
- Modify: `src/api.ts`

3つの新エンドポイント: `/api/rotation`, `/api/rotation/pending`, `/api/scores`

- [ ] **Step 1: `src/api.ts` に3新エンドポイント処理を追加**

`src/api.ts` の `handleApiRequest` 関数（またはメインの `fetch` ハンドラ）の中で、既存の `/api/status` の処理の後に追加:

```typescript
// src/index.ts の fetch ハンドラの routing 部分に追加
// (パスによるswitch/if文の適切な位置に)

if (pathname === '/api/rotation' && request.method === 'POST') {
  // 承認/拒否
  try {
    const body = await request.json() as { id: number; action: 'approve' | 'reject' };
    const { decideRotation } = await import('./rotation');
    const result = await decideRotation(env.DB, body.id, body.action);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
      status: result.success ? 200 : 404,
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, message: String(e) }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    });
  }
}

if (pathname === '/api/rotation/pending' && request.method === 'GET') {
  // 未決定の入替え提案一覧
  const { getPendingRotations } = await import('./rotation');
  const pending = await getPendingRotations(env.DB);
  return new Response(JSON.stringify({ rotations: pending }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

if (pathname === '/api/scores' && request.method === 'GET') {
  // スコア一覧（当日）
  const today = new Date().toISOString().split('T')[0];
  const rows = await env.DB.prepare(`
    SELECT symbol, theme_score, funda_score, momentum_score, total_score, rank, in_universe
    FROM stock_scores
    WHERE scored_at = ?
    ORDER BY rank ASC
    LIMIT 60
  `).bind(today).all();

  const trackingRows = await env.DB.prepare(
    "SELECT pair, added_at FROM active_instruments"
  ).all<{ pair: string; added_at: string }>();

  return new Response(JSON.stringify({
    scoredAt: today,
    scores: rows.results ?? [],
    trackingList: trackingRows.results ?? [],
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 2: ビルドエラーを確認**

```bash
npx tsc --noEmit 2>&1 | head -50
```

- [ ] **Step 3: コミット**

```bash
git add src/index.ts src/api.ts
git commit -m "feat: add 3 new API endpoints (rotation, pending, scores)"
```

---

## Task 11: Dashboard UI (`src/dashboard.ts`)

**Files:**
- Modify: `src/dashboard.ts`

Tab1に入替えバナー+追跡リスト、Tab3に入替え履歴を追加

- [ ] **Step 1: 入替えバナーHTML生成関数を追加**

`src/dashboard.ts` の適切な場所に追加:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// AI銘柄マネージャー UIコンポーネント
// ─────────────────────────────────────────────────────────────────────────────

export function renderRotationBanner(pending: Array<{
  id: number;
  in_symbol: string;
  in_score: number;
  out_symbol: string;
  out_score: number;
  proposed_at: string;
}>): string {
  if (pending.length === 0) return '';

  const p = pending[0];
  const proposedAt = new Date(p.proposed_at);
  const expiresAt = new Date(proposedAt.getTime() + 24 * 3600 * 1000);
  const nowMs = Date.now();
  const remainingMs = expiresAt.getTime() - nowMs;
  const remainingH = Math.floor(remainingMs / 3600000);
  const remainingM = Math.floor((remainingMs % 3600000) / 60000);

  return `
    <div class="rotation-banner" style="
      background: linear-gradient(135deg, #1c1c1e 0%, #2c2c2e 100%);
      border: 1px solid rgba(255,159,10,0.4);
      border-radius: 16px;
      padding: 16px;
      margin: 12px 16px;
    ">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <span style="font-size:13px; font-weight:600; color:#ff9f0a;">🔄 銘柄入替え提案</span>
        <span style="font-size:11px; color:#8e8e93;">残り ${remainingH}h${remainingM}m</span>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px;">
        <div style="background:rgba(48,209,88,0.1); border-radius:10px; padding:10px;">
          <div style="font-size:10px; color:#30d158; font-weight:600; margin-bottom:2px;">IN</div>
          <div style="font-size:14px; font-weight:700; color:#fff;">${p.in_symbol}</div>
          <div style="font-size:11px; color:#8e8e93;">スコア ${p.in_score.toFixed(0)}</div>
        </div>
        <div style="background:rgba(255,69,58,0.1); border-radius:10px; padding:10px;">
          <div style="font-size:10px; color:#ff453a; font-weight:600; margin-bottom:2px;">OUT</div>
          <div style="font-size:14px; font-weight:700; color:#fff;">${p.out_symbol}</div>
          <div style="font-size:11px; color:#8e8e93;">スコア ${p.out_score.toFixed(0)}</div>
        </div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
        <button onclick="rotationDecide(${p.id},'approve')" style="
          background:#30d158; color:#000; border:none; border-radius:10px;
          padding:10px; font-size:13px; font-weight:600; cursor:pointer;
        ">✓ 承認</button>
        <button onclick="rotationDecide(${p.id},'reject')" style="
          background:#ff453a; color:#fff; border:none; border-radius:10px;
          padding:10px; font-size:13px; font-weight:600; cursor:pointer;
        ">✕ 拒否</button>
      </div>
    </div>
  `;
}

export function renderTrackingList(scores: Array<{
  symbol: string;
  theme_score: number;
  total_score: number;
  in_universe: number;
}>): string {
  const trackingScores = scores.filter(s => s.in_universe === 1);
  if (trackingScores.length === 0) return '';

  const rows = trackingScores.map(s => {
    const color = s.total_score >= 200 ? '#30d158' : s.total_score >= 150 ? '#ff9f0a' : '#ff453a';
    const barWidth = Math.min(100, s.total_score / 3);
    const isLowTheme = s.theme_score <= 20;
    return `
      <div style="display:flex; align-items:center; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
        <span style="font-size:12px; color:#fff; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${isLowTheme ? '⚠ ' : ''}${s.symbol}
        </span>
        <div style="width:80px; height:4px; background:rgba(255,255,255,0.1); border-radius:2px; margin:0 8px;">
          <div style="width:${barWidth}%; height:100%; background:${color}; border-radius:2px;"></div>
        </div>
        <span style="font-size:11px; color:${color}; font-weight:600; width:32px; text-align:right;">
          ${s.total_score.toFixed(0)}
        </span>
      </div>
    `;
  }).join('');

  return `
    <div style="background:#1c1c1e; border-radius:16px; padding:12px 16px; margin:12px 16px;">
      <div style="font-size:12px; font-weight:600; color:#8e8e93; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">
        追跡中 (${trackingScores.length}銘柄)
      </div>
      ${rows}
    </div>
  `;
}

export function renderRotationHistory(rotations: Array<{
  id: number;
  proposed_at: string;
  in_symbol: string;
  out_symbol: string;
  status: string;
  in_result_pnl: number | null;
  out_result_pnl: number | null;
}>): string {
  if (rotations.length === 0) return '<div style="padding:16px; color:#8e8e93; font-size:13px; text-align:center;">入替え履歴なし</div>';

  const formatPnl = (pnl: number | null) => {
    if (pnl === null) return '<span style="color:#8e8e93">─</span>';
    const color = pnl >= 0 ? '#30d158' : '#ff453a';
    return `<span style="color:${color}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%</span>`;
  };

  const statusLabel: Record<string, string> = {
    'APPROVED': '手動承認',
    'AUTO_APPROVED': '自動承認',
    'REJECTED': '拒否',
    'PENDING': '保留中',
  };

  const rows = rotations.slice(0, 20).map(r => {
    const date = new Date(r.proposed_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
    return `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
        <td style="padding:8px 4px; font-size:11px; color:#8e8e93;">${date}</td>
        <td style="padding:8px 4px; font-size:11px; color:#30d158;">${r.in_symbol}</td>
        <td style="padding:8px 4px; font-size:11px; color:#ff453a;">${r.out_symbol}</td>
        <td style="padding:8px 4px; font-size:11px; color:#8e8e93;">${statusLabel[r.status] ?? r.status}</td>
        <td style="padding:8px 4px; font-size:11px;">${formatPnl(r.in_result_pnl)}</td>
        <td style="padding:8px 4px; font-size:11px;">${formatPnl(r.out_result_pnl)}</td>
      </tr>
    `;
  }).join('');

  return `
    <div style="background:#1c1c1e; border-radius:16px; padding:12px 16px; margin:12px 16px;">
      <div style="font-size:12px; font-weight:600; color:#8e8e93; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">
        入替え履歴
      </div>
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr>
            <th style="font-size:10px; color:#636366; text-align:left; padding:4px;">日付</th>
            <th style="font-size:10px; color:#636366; text-align:left; padding:4px;">IN</th>
            <th style="font-size:10px; color:#636366; text-align:left; padding:4px;">OUT</th>
            <th style="font-size:10px; color:#636366; text-align:left; padding:4px;">判定</th>
            <th style="font-size:10px; color:#636366; text-align:left; padding:4px;">IN結果</th>
            <th style="font-size:10px; color:#636366; text-align:left; padding:4px;">OUT仮想</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}
```

- [ ] **Step 2: Tab1のヒーロー直下（メトリクスストリップの前）にバナーを挿入**

`src/dashboard.ts` でTab1のHTMLを生成している部分を探し、ヒーローPnLカードの後に以下を追加:

```typescript
// Tab1のHTML生成部分に追加（ヒーローの後、メトリクスの前）
${pendingRotations.length > 0 ? renderRotationBanner(pendingRotations) : ''}
// ポジション一覧の後に追加:
${renderTrackingList(scores)}
```

- [ ] **Step 3: Tab3の統計KPIセクションの後に入替え履歴を追加**

Tab3のHTML生成部分に以下を追加:

```typescript
// Tab3: ペアパフォーマンスの後
${renderRotationHistory(rotationHistory)}
```

- [ ] **Step 4: `rotationDecide` のJavaScript関数を追加**

アプリJavaScript（`src/app.js.ts` または dashboard.tsのインラインscript）に追加:

```javascript
async function rotationDecide(id, action) {
  try {
    const res = await fetch('/api/rotation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    const data = await res.json();
    if (data.success) {
      // バナーを非表示にしてリロード
      location.reload();
    } else {
      alert('エラー: ' + data.message);
    }
  } catch (e) {
    alert('通信エラー: ' + e);
  }
}
```

- [ ] **Step 5: ビルドエラーを確認**

```bash
npx tsc --noEmit 2>&1 | head -50
```

- [ ] **Step 6: コミット**

```bash
git add src/dashboard.ts src/app.js.ts
git commit -m "feat: add rotation banner, tracking list, history to dashboard"
```

---

## Task 12: Deploy & Secret Setup

- [ ] **Step 1: ビルドが通ることを確認**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim
npx tsc --noEmit 2>&1
```

Expected: エラーなし

- [ ] **Step 2: ローカルでwrangler devを起動してcronをテスト**

```bash
npx wrangler dev --local
```

別ターミナルでcronをトリガー:
```bash
curl "http://localhost:8787/__scheduled?cron=0+21+*+*+*"
```

Expected: `[daily-scoring] Start` のログが出る（J-QuantsトークンなしでもWARNのみでクラッシュしない）

- [ ] **Step 3: 本番デプロイ**

```bash
npx wrangler deploy
```

Expected: `✅ Deployed to fx-sim-v1.workers.dev`

- [ ] **Step 4: D1マイグレーションを本番に適用**

```bash
npx wrangler d1 execute fx-sim-v1-db --file=schema.sql --remote
```

- [ ] **Step 5: コミットとPR作成**

```bash
git add -A
git commit -m "chore: deploy AI stock manager feature"

gh pr create \
  --title "feat: AI銘柄マネージャー — テスタ式スコアリング & 動的入替え" \
  --body "$(cat <<'EOF'
## Summary
- J-Quants V2 API統合でファンダメンタルデータ取得（月3,300円）
- テスタ初期スタイルの3軸スコアリング（需給熱50%/モメンタム30%/ファンダ20%）
- 日本株15銘柄の動的入替え（7日ロック + 24時間拒否権付き自動承認）
- newsStage1プロンプトにファンダ参考情報を注入（株式のみ）
- composite閾値を保有状態で動的制御（保有中4.0/追跡5.0/候補6.0/外7.0）
- TP multiplierをファンダ乖離率で補正（テーマ株は無効）
- ダッシュボード: Tab1に入替えバナー+追跡リスト、Tab3に入替え履歴

## テスタ原則との対応（全ソース付き）
- 需給熱最重視: [ZUU online](https://zuuonline.com/archives/209968)
- 1銘柄追跡（7日ロック）: [楽天証券トウシル中編](https://media.rakuten-sec.net/articles/-/34085)
- 負けない原則（地雷除外）: [楽天証券トウシル前編](https://media.rakuten-sec.net/articles/-/34084)

## Test plan
- [ ] `npx tsc --noEmit` エラーなし
- [ ] wrangler dev で各cronが動くこと
- [ ] Chrome DevTools MCPでTab1バナー・Tab3履歴の表示確認
- [ ] モバイルプレビュー(375x812)で表示崩れなし
- [ ] J-Quants APIエラー時のフォールバック確認

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Task 13: E2E Verification

- [ ] **Step 1: Chrome DevTools MCPで本番URL確認**

Chrome DevTools MCPで本番URLを開き、スクリーンショット確認:
- Tab1: ヒーローカードの下に追跡リストが表示されること
- Tab1: 入替えバナーが表示されること（入替え提案がある場合）
- Tab3: 入替え履歴テーブルが表示されること

- [ ] **Step 2: モバイルエミュレーション確認**

```
preview_resize preset:mobile
```

375x812で表示崩れがないこと

- [ ] **Step 3: /api/scoresエンドポイント確認**

```bash
curl https://fx-sim-v1.workers.dev/api/scores | jq .
```

Expected: `{ "scoredAt": "...", "scores": [...], "trackingList": [...] }`

- [ ] **Step 4: /api/rotation/pendingエンドポイント確認**

```bash
curl https://fx-sim-v1.workers.dev/api/rotation/pending | jq .
```

Expected: `{ "rotations": [] }` （まだ提案がない場合）

- [ ] **Step 5: wrangler tailでcronログ確認**

```bash
npx wrangler tail --format=pretty
```

日次スコアリングcron（JST 06:00）が実行されるまで待機、またはD1に手動でデータを挿入してテスト

---

## Task 14: Documentation Updates

**Files:** 4高優先ドキュメント

- [ ] **Step 1: `docs/03_DB設計書.md` に4新テーブルを追加**

既存テーブル定義の末尾に追加（schema.sqlと同内容の表形式）

- [ ] **Step 2: `docs/05_開発者仕様書.md` に3新モジュールとcronを追加**

3.3 jquants.ts / 3.4 scoring.ts / 3.5 rotation.ts の仕様を追加

- [ ] **Step 3: `docs/02_要件定義書.md` にFR-106〜111を追加**

- [ ] **Step 4: CLAUDE.mdのディレクトリ構成とスキーマを更新**

新ファイル3つとD1テーブル4つを追記

- [ ] **Step 5: コミットとマージ**

```bash
git add docs/ CLAUDE.md
git commit -m "docs: update specs for AI stock manager feature"

# PRをマージ
gh pr merge --squash
```

---

## 完了後の確認チェックリスト

- [ ] `npx tsc --noEmit` エラーなし
- [ ] スキーマ4テーブルが本番D1に作成済み
- [ ] J-QuantsリフレッシュトークンがSecret設定済み
- [ ] 日次スコアリングcron（JST 06:00）が動作
- [ ] `/api/scores` が正常レスポンス
- [ ] Tab1に追跡リストが表示
- [ ] Tab3に入替え履歴テーブルが表示
- [ ] モバイル375x812で表示崩れなし
- [ ] PRがmasterにマージ済み

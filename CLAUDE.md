# fx-sim-v1 実装指示書

## 会話ルール
- **必ず日本語で会話すること。英語での返答は禁止。**

## プロジェクト概要

USD/JPY を対象とした FX 仮想トレードシステム。
Gemini 2.5 Pro がニュース・SNS・複数指標を分析し、買い/売り/様子見を判定。
仮想ポジションを D1 に記録し、損益をシミュレートする。

**実弾発注は行わない。あくまで仮想（ペーパートレード）。**

---

## 技術スタック

- **ランタイム**: Cloudflare Workers (TypeScript)
- **スケジューラ**: Cloudflare Cron Triggers（1分ごと）
- **DB**: Cloudflare D1
- **AI**: Google Gemini API (`gemini-3.1-pro-preview`)

---

## 情報ソース（全て無料）

| ソース | URL | 用途 | 更新頻度 |
|--------|-----|------|----------|
| Reuters RSS | `https://feeds.reuters.com/reuters/businessNews` | メインニュース | 1分ポーリング |
| Reddit r/Forex | `https://www.reddit.com/r/Forex/new.json` | 市場センチメント | 1分ポーリング |
| frankfurter.app | `https://api.frankfurter.app/latest?from=USD&to=JPY` | USD/JPYレート | 1分ポーリング |
| FRED API | `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=YOUR_KEY&file_type=json` | 米10年債利回り | 日次キャッシュ |
| Yahoo Finance | `https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX` | VIX・日経・S&P500 | 1分ポーリング |

> FRED API キーは無料登録で取得: https://fred.stlouisfed.org/

---

## ディレクトリ構成

```
fx-sim-v1/
├── src/
│   ├── index.ts          # cron エントリーポイント
│   ├── news.ts           # Reuters RSS フェッチ・パース
│   ├── reddit.ts         # Reddit r/Forex 取得・キーワード検出
│   ├── rate.ts           # USD/JPY レート取得
│   ├── indicators.ts     # VIX・米10年債・日経・S&P500取得
│   ├── gemini.ts         # Gemini API 呼び出し・レスポンス解析
│   ├── position.ts       # 仮想ポジション管理（TP/SL チェック）
│   ├── filter.ts         # Gemini呼び出し要否判定・スキップ判定
│   └── db.ts             # D1 CRUD 操作
├── schema.sql
├── wrangler.toml
├── package.json
└── tsconfig.json
```

---

## D1 スキーマ（schema.sql）

```sql
CREATE TABLE IF NOT EXISTS positions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pair         TEXT    NOT NULL DEFAULT 'USD/JPY',
  direction    TEXT    NOT NULL,           -- 'BUY' | 'SELL'
  entry_rate   REAL    NOT NULL,
  tp_rate      REAL,
  sl_rate      REAL,
  lot          REAL    NOT NULL DEFAULT 1.0,
  status       TEXT    NOT NULL DEFAULT 'OPEN',  -- 'OPEN' | 'CLOSED'
  pnl          REAL,                       -- 損益（pip換算）
  entry_at     TEXT    NOT NULL,
  closed_at    TEXT,
  close_rate   REAL,
  close_reason TEXT                        -- 'TP' | 'SL' | 'MANUAL'
);

CREATE TABLE IF NOT EXISTS decisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pair          TEXT    NOT NULL DEFAULT 'USD/JPY',
  rate          REAL    NOT NULL,
  decision      TEXT    NOT NULL,          -- 'BUY' | 'SELL' | 'HOLD'
  tp_rate       REAL,
  sl_rate       REAL,
  reasoning     TEXT,
  news_summary  TEXT,
  reddit_signal TEXT,                      -- 検出キーワード
  vix           REAL,
  us10y         REAL,
  nikkei        REAL,
  sp500         REAL,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS market_cache (
  key        TEXT PRIMARY KEY,             -- 'us10y' など
  value      TEXT NOT NULL,               -- JSON文字列
  updated_at TEXT NOT NULL
);
```

---

## wrangler.toml

```toml
name = "fx-sim-v1"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[triggers]
crons = ["* * * * *"]  # 1分ごと（Cloudflare最短単位）

[[d1_databases]]
binding = "DB"
database_name = "fx-sim-v1-db"
database_id = "YOUR_D1_DATABASE_ID"

[vars]
# wrangler secret put GEMINI_API_KEY
# wrangler secret put FRED_API_KEY
```

---

## 各モジュールの仕様

### src/rate.ts

```typescript
// frankfurter.app から USD/JPY の現在レートを取得
// レスポンス例: { "rates": { "JPY": 149.85 } }
export async function getUSDJPY(): Promise<number>
```

### src/news.ts

```typescript
// Reuters RSS をフェッチし直近5件を返す
// RSSパースは正規表現で <title><description> を抽出（xml2js不使用）
export interface NewsItem {
  title: string;
  description: string;
  pubDate: string;
}
export async function fetchNews(): Promise<NewsItem[]>
```

### src/reddit.ts

```typescript
// Reddit r/Forex の新着投稿を取得しキーワード検出
const KEYWORDS = [
  'intervention', 'BOJ', 'Fed', 'rate hike', 'rate cut',
  '日銀', '介入', '利上げ', '利下げ', 'FOMC', 'CPI'
];

export interface RedditSignal {
  hasSignal: boolean;
  keywords: string[];
  topPosts: string[];   // 上位3件のタイトル
}
export async function fetchRedditSignal(): Promise<RedditSignal>
```

### src/indicators.ts

```typescript
export interface MarketIndicators {
  vix: number | null;
  us10y: number | null;   // 米10年債利回り（%）
  nikkei: number | null;
  sp500: number | null;
}

// Yahoo Finance から VIX・日経(^N225)・S&P500(^GSPC) を取得
// FRED API から米10年債利回りを取得（日次・market_cacheでキャッシュ）
export async function getMarketIndicators(
  db: D1Database,
  fredApiKey: string
): Promise<MarketIndicators>
```

### src/filter.ts

```typescript
// 重要指標発表時間帯（UTC）この時間帯は強制HOLD
const SKIP_SCHEDULES = [
  { weekday: 5, hour: 13, min: 30, duration: 60 }, // 米雇用統計（第1金曜）
  { hour: 23, min: 0,  duration: 60 },              // 日銀会合発表時間帯
  { hour: 13, min: 30, duration: 60 },              // 米CPI発表時間帯
];

export interface FilterResult {
  shouldCall: boolean;
  reason: string;
}

// Gemini を呼ぶべきか判定
// 以下のいずれかを満たす場合のみ true を返す:
//   1. スキップ時間帯でない かつ
//   2. レート変化 ±0.05円以上 OR 新規ニュースあり OR Redditキーワード検出
// 目標: 1日あたり 20〜50回 程度に抑える
export function shouldCallGemini(params: {
  currentRate: number;
  prevRate: number;
  hasNewNews: boolean;
  redditSignal: RedditSignal;
  now: Date;
}): FilterResult
```

### src/gemini.ts

```typescript
export interface GeminiDecision {
  decision: 'BUY' | 'SELL' | 'HOLD';
  tp_rate: number | null;
  sl_rate: number | null;
  reasoning: string;   // 日本語100文字以内
}

// システムプロンプト（概要）:
// あなたはFXデイトレーダーのAIアシスタントです。
// 以下のデータを分析し USD/JPY の売買判断を JSON で返してください。
// 既にオープンポジションがある場合は原則 HOLD を返すこと。
// TP/SL は現在レートから ±0.3〜1.0円 の範囲で設定すること。
// {
//   "decision": "BUY" | "SELL" | "HOLD",
//   "tp_rate": number | null,
//   "sl_rate": number | null,
//   "reasoning": "日本語100文字以内"
// }

// Gemini に渡す入力フォーマット:
// 現在のUSD/JPY: {rate}円
// 米10年債利回り: {us10y}%
// VIX: {vix}
// 日経平均: {nikkei}
// S&P500: {sp500}
// Redditシグナル: {keywords}
// 直近ニュース（箇条書き5件）: {news}
// オープンポジション: {あり/なし}

export async function getDecision(params: {
  rate: number;
  indicators: MarketIndicators;
  news: NewsItem[];
  redditSignal: RedditSignal;
  hasOpenPosition: boolean;
  apiKey: string;
}): Promise<GeminiDecision>
```

### src/position.ts

```typescript
// pnl計算:
//   BUY  → (close_rate - entry_rate) * 100（pip）
//   SELL → (entry_rate - close_rate) * 100（pip）

// 同時オープンポジションは最大1件に制限

export async function checkAndClosePositions(
  db: D1Database,
  currentRate: number
): Promise<void>

export async function openPosition(
  db: D1Database,
  direction: 'BUY' | 'SELL',
  entryRate: number,
  tpRate: number | null,
  slRate: number | null
): Promise<void>
```

### src/db.ts

```typescript
export async function getOpenPositions(db: D1Database): Promise<Position[]>
export async function insertDecision(db: D1Database, record: DecisionRecord): Promise<void>
export async function closePosition(db: D1Database, id: number, closeRate: number, reason: string): Promise<void>
export async function getCacheValue(db: D1Database, key: string): Promise<string | null>
export async function setCacheValue(db: D1Database, key: string, value: string): Promise<void>
```

### src/index.ts

```typescript
interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  FRED_API_KEY: string;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 1. レート取得
    // 2. ニュース取得
    // 3. Reddit シグナル取得
    // 4. 市場指標取得（VIX・米10年債・日経・S&P500）
    // 5. 既存オープンポジションの TP/SL チェック
    // 6. Gemini 呼び出し要否フィルタ判定
    // 7. 呼び出す場合: Gemini に判定依頼
    // 8. decisions テーブルに記録（スキップ含む全判定）
    // 9. BUY/SELL なら新規ポジションをオープン
    // 10. コンソールにサマリーをログ出力
  }
}
```

---

## Gemini API 呼び出し方法

```typescript
const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  }
);
const data = await response.json();
const text = data.candidates[0].content.parts[0].text;
return JSON.parse(text) as GeminiDecision;
```

---

## コスト試算

| サービス | 月額 |
|----------|------|
| Cloudflare Workers | 無料枠内 |
| Cloudflare D1 | 無料枠内 |
| Gemini 3.1 Pro Preview | 無料枠 or 数百円 |
| 全情報ソース | 無料 |
| **合計** | **ほぼ ¥0** |

---

## フェーズ計画

**Phase 1（初期実装）**
- Reuters RSS + frankfurter.app + Gemini のみ
- フィルタなし・cron 1分

**Phase 2（本実装）**
- Reddit・VIX・米10年債・日経・S&P500 追加
- フィルタロジック実装
- 重要指標スキップ実装

**Phase 3（分析・改善）**
- 勝率・シャープレシオを D1 で集計
- Slack 通知追加
- 戦略パラメータのチューニング

---

## セットアップ・デプロイ自動化

**実装完了後、以下を実行するだけで環境構築からデプロイまで完結する。**
**人間の操作は APIキー入力のみ。**

---

### setup.sh（プロジェクトルートに作成すること）

```bash
#!/bin/bash
set -e

echo "=== fx-sim-v1 セットアップ開始 ==="

# 1. 依存インストール
echo "[1/5] 依存パッケージインストール..."
npm install

# 2. D1作成 & wrangler.toml 自動更新
echo "[2/5] D1データベース作成..."
DB_OUTPUT=$(wrangler d1 create fx-sim-v1-db 2>&1)
DB_ID=$(echo "$DB_OUTPUT" | grep -oP 'database_id = "\K[^"]+')

if [ -z "$DB_ID" ]; then
  # 既に存在する場合はリストから取得
  DB_ID=$(wrangler d1 list 2>/dev/null | grep "fx-sim-v1-db" | awk '{print $NF}')
fi

if [ -z "$DB_ID" ]; then
  echo "❌ D1のIDが取得できませんでした。手動で wrangler.toml を更新してください。"
  exit 1
fi

sed -i "s/YOUR_D1_DATABASE_ID/$DB_ID/" wrangler.toml
echo "  D1 ID: $DB_ID を wrangler.toml に書き込みました"

# 3. スキーマ適用
echo "[3/5] スキーマ適用..."
wrangler d1 execute fx-sim-v1-db --file=schema.sql

# 4. Secret設定（ここだけ手動入力が必要）
echo "[4/5] APIキー設定（キーを入力してください）..."
echo "--- GEMINI_API_KEY ---"
wrangler secret put GEMINI_API_KEY
echo "--- FRED_API_KEY ---"
wrangler secret put FRED_API_KEY

# 5. デプロイ
echo "[5/5] デプロイ..."
wrangler deploy

echo ""
echo "=== ✅ セットアップ完了 ==="
echo ""
echo "ログ確認:    wrangler tail --format=pretty"
echo "DB確認:      wrangler d1 execute fx-sim-v1-db --command=\"SELECT * FROM decisions ORDER BY id DESC LIMIT 5;\""
echo "動作確認:    wrangler dev（ローカル）"
```

---

### 実行方法

```bash
chmod +x setup.sh
./setup.sh
```

**1コマンドで完結する。**

---

## 実装上の注意

- **仮想発注のみ**。実際のFX発注コードは一切書かない
- APIキーは env から取得（ハードコード禁止）
- エラー時はコンソールにログを出して握りつぶす（cron が止まらないよう）
- 同時オープンポジションは **最大1件** に制限
- RSS パースは正規表現で抽出（xml2js 等のパーサー不使用）
- Yahoo Finance はレート制限に注意。失敗時は `null` を返してスキップ
- market_cache テーブルで FRED（日次）データをキャッシュしAPI呼び出しを節約

---

## デプロイ後ワークフロー（必須）

**本番デプロイ（`npx wrangler deploy`）後は、必ず以下を実施すること。**

1. Chrome DevTools MCP でブラウザを開き、本番 URL を表示する
2. **E2Eチェック**を実施する（機能・表示・UX 全項目）
3. 問題が見つかった場合は修正→デプロイ→再チェックを繰り返す
4. **「あるべき姿」になるまで繰り返しを止めない**

### E2Eチェック観点

| 観点 | チェック内容 |
|---|---|
| 機能 | データ取得・PnL計算・TP/SL・バナー表示 |
| レイアウト | 3タブ・ヘッダー・タブバー・safe-area |
| UX | スパークライン・アニメーション・ボトムシート |
| Apple HIG | 44pt タッチターゲット・8pt グリッド・SF Pro |
| UX心理学 | Peak-End・Variable Reward・Goal Gradient・Loss Aversion |
| スマホ表示 | `preview_resize preset:mobile` でモバイルプレビュー確認 |

---

## 完成後の確認ポイント

- [ ] `wrangler tail` で cron 実行ログが出る
- [ ] `decisions` テーブルに記録が積まれる
- [ ] フィルタが機能して Gemini 呼び出しが間引かれている
- [ ] BUY/SELL 判定時に `positions` テーブルにレコードが入る
- [ ] TP/SL 到達時に `status` が `CLOSED` に更新される
- [ ] `pnl` が正しく計算されている
- [ ] 重要指標時間帯にスキップされる

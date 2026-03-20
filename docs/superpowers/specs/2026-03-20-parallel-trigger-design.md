# 並列トリガーアーキテクチャ設計書

**作成日**: 2026-03-20
**更新日**: 2026-03-20 22:40 JST
**ステータス**: 設計確定（v2 — RSSソース・二段構え・ニュース共有化を反映）

---

## 0. 設計変更サマリー（v2）

| 項目 | v1 | v2 |
|---|---|---|
| RSSソース | 8ソース（NHK, Investing等） | **10ソース**（CNBC, Bloomberg, FXStreet, CoinDesk, Reuters_Markets, Reuters_World, Nikkei, Minkabu_FX, Minkabu_Stock, Minkabu_Commodity） |
| Path B構造 | 1回のAI呼出で分析+判断 | **二段構え**: Stage 1（タイトル即断）→ Stage 2（og:description補正） |
| ニュースデータ | Path A/Bが各自取得 | **共有化**: 1回取得 → cache → 全Path参照 |
| フロント用加工 | ニュース分析3-tier AI | **B3**: 売買完了後に残り時間でUI加工 |
| description取得 | RSSのdescription依存 | **og:description**: 日本語6ソースはリンク先HTMLから取得 |

---

## 1. 現状の問題点

### 1.1 直列ボトルネック: ニュース分析フェーズ

現在の `run()` 関数は以下の順序で直列実行されている:

```
並列データ取得 (3-5秒)
  → TP/SL チェック (1-2秒)
  → ニュースハッシュ比較
  → ニュース分析 3段フォールバック (10-30秒) ★ボトルネック
  → 銘柄フィルタ + AI判定ループ (10-20秒)
```

ニュース分析（`analyzeNews` → `analyzeNewsGPT` → `analyzeNewsClaude`）は:
- 各プロバイダーに **10秒タイムアウト** (`NEWS_ANALYSIS_TIMEOUT_MS = 10_000`)
- 3段直列フォールバック → 最悪ケース **30秒消費**
- 結果が出ない場合でも `cronStart` からの経過時間を食い潰し、後続の銘柄AI判定の予算が残らない

### 1.2 数値で見る問題

| 指標 | 現状値 | 問題 |
|---|---|---|
| Cron時間予算 | 60秒（CF Workers制限） | - |
| ニュース分析のみ | 10〜30秒 | 全予算の17〜50%を消費 |
| 銘柄AI判定の予算残り | 50秒 - ニュース分析 = 20〜40秒 | ニュース分析が長いとAI呼出0件になる |
| `MAX_GEMINI_PER_RUN` | ニュース分析済の場合 **0** | 分析した瞬間、銘柄判定を諦めている |
| ニュース分析の成功率 | 常態的に失敗 → 5分クールダウン | 実質的に機能していない |
| 動的上限 (`baseLimit`) | 前回30秒超 → 3件まで | 前回のボトルネックが次回の判定数も制限 |

### 1.3 構造的な問題

1. **ニュース分析と銘柄判定が排他的**: `newsAnalysisRan` が `true` になると `MAX_GEMINI_PER_RUN = 0` になり、そのcronでは一切の銘柄判定が行われない（index.ts 344行目）
2. **ニュース分析結果の使われ方が間接的**: 分析結果は `news_analysis` キャッシュに保存され、`hasAttentionNews` フラグとしてフィルタスキップに使われるだけ。「どの銘柄に影響するか」は判定されず、全銘柄を強制チェックするだけ
3. **3段フォールバックの設計不良**: Gemini失敗 → 残り予算チェック → GPT → Claude と直列実行。途中で予算が尽きるとどこで打ち切られるか予測不能
4. **フィルタがニュースに過度に反応**: `hasNewNews` が `true` になると全銘柄のフィルタが通過し（filter.ts 119行目）、レート変化がなくてもAI呼出対象になる

---

## 2. RSSソース構成（v2確定）

### 2.1 ソース一覧

| # | ソース | URL | desc | レイテンシ | 役割 |
|---|--------|-----|------|------------|------|
| 1 | CNBC | `search.cnbc.com/rs/...` | あり | 1,736ms | 米国株・指標 |
| 2 | CoinDesk | `coindesk.com/arc/outboundfeeds/rss/` | あり | 1,794ms | 暗号資産 |
| 3 | FXStreet | `fxstreet.com/rss` | あり | 1,697ms | FX・指標速報 |
| 4 | Bloomberg | `feeds.bloomberg.com/markets/news.rss` | あり | 1,935ms | 金利・マクロ |
| 5 | Reuters_Markets | `assets.wor.jp/.../reuters/markets.rdf` | なし | 63ms | 日本語マーケット |
| 6 | Reuters_World | `assets.wor.jp/.../reuters/world.rdf` | なし | 111ms | 世界ニュース |
| 7 | Nikkei | `assets.wor.jp/.../nikkei/news.rdf` | なし | 64ms | 日本全般 |
| 8 | Minkabu_FX | `assets.wor.jp/.../minkabufx/statement.rdf` | なし | 59ms | 要人発言 |
| 9 | Minkabu_Stock | `assets.wor.jp/.../minkabufx/stock.rdf` | なし | 64ms | 株式概況 |
| 10 | Minkabu_Commodity | `assets.wor.jp/.../minkabufx/commodity.rdf` | なし | 64ms | 金・原油・債券 |

### 2.2 description取得戦略

```
英語4ソース（CNBC, CoinDesk, FXStreet, Bloomberg）
  → RSSのdescriptionをそのまま使用

日本語6ソース（wor.jp経由）
  → RSSにdescriptionなし
  → リンク先HTMLの og:description を取得して補完
  → 取得タイミング: Path B Stage 2（後述）
```

全ソースにリンクあり。og:description取得を確認済み:
- `fx.minkabu.jp` → 要人発言の詳細テキスト
- `jp.reuters.com` → 記事リード文
- `nikkei.com` → 記事冒頭100-150文字

### 2.3 旧ソースからの変更

| 削除 | 理由 |
|------|------|
| NHK | 経済ニュースが少ない。政治・外交中心 |
| Investing | 9時間更新停止が頻発。速報性なし |
| 2NN_Biz | 7日前の記事が混在。論外 |
| Reuters_JP (top.rdf) | Reuters_Markets / Reuters_World に分割・置換 |

| 追加 | 理由 |
|------|------|
| Reuters_Markets | マーケット特化。レイテンシ63ms |
| Reuters_World | 地政学リスク。レイテンシ111ms |
| Nikkei | 日本経済全般。レイテンシ64ms |
| Minkabu_FX | 要人発言がリアルタイム。レイテンシ59ms |
| Minkabu_Stock | 株式市場概況。レイテンシ64ms |
| Minkabu_Commodity | 金・原油・債券速報。レイテンシ64ms |

---

## 3. 新アーキテクチャ: 並列トリガー

### 3.1 全体図

```
毎分cron
  │
  ├─① 並列データ取得（価格・ニュース10ソース・指標・Reddit）
  │     └─ Promise.allSettled で 3-5秒
  │     └─ ニュースデータは共有ストアに保持（Path A/B/C共通）
  │
  ├─② TP/SL・トレイリングストップ管理（常時）
  │     └─ checkAndCloseAllPositions
  │
  ├─③ トリガー判定（3つのPathを並列評価）
  │   │
  │   ├─ Path A: レート変化トリガー
  │   │    銘柄ごとに rateChangeTh を超えたものだけリストアップ
  │   │    → 該当銘柄を個別AI判定
  │   │    → ニュースは共有キャッシュから参照（自身では取得しない）
  │   │
  │   ├─ Path B: ニューストリガー（二段構え）
  │   │    ニュースハッシュ変化時のみ発火
  │   │    ├─ B1: タイトルのみでAI即断 → ポジション操作（~3秒）
  │   │    ├─ B2: og:description並列取得 → AI補正判断（+2秒）
  │   │    │       → CONFIRM / REVISE / REVERSE
  │   │    └─ B3: UI用加工（翻訳・注目フラグ）→ market_cache保存
  │   │           → 時間余ったらやる。なければ次回に回す
  │   │
  │   └─ Path C: 定期巡回
  │        30分以上AIチェックされていない銘柄を巡回
  │        → 個別AI判定
  │        → ニュースは共有キャッシュから参照
  │
  ├─④ 重複排除・マージ
  │     Path A/B/Cの結果を統合
  │     同一銘柄が複数Pathでヒット → Path Bの結果を優先
  │
  └─⑤ サニティチェック → ポジション開設
```

### 3.2 優先度モデル

```
🔴 最優先: B1 タイトル即断 → ポジション操作（売買が最優先）
🟡 次点:   B2 og:description取得 → 補正判断 → TP/SL調整
🟢 最後:   B3 UI用加工（翻訳・注目フラグ・impact分析）→ market_cache保存
```

売買行動が最優先。フロント表示用の加工は残り時間で行い、間に合わなければ次のcronに委譲する。

### 3.3 ニュースデータの共有化

```
ニュース取得（1回だけ、①で実行）
    │
    ├── 共有ストア（メモリ内）に保持
    │     ├─ titles: タイトル一覧
    │     ├─ descriptions: RSSのdesc（英語4ソースのみ）
    │     ├─ links: リンクURL一覧
    │     └─ hash: ニュースハッシュ（変化検知用）
    │
    ├── Path B: ハッシュ変化時に発火。タイトル→即断→og:desc取得→補正
    │     └─ B2/B3の結果をmarket_cacheに保存
    │
    ├── Path A: レート変化で発火時、共有ストアのニュースをAIプロンプトに含める
    │
    └── Path C: 定期巡回時、共有ストアのニュースをAIプロンプトに含める
```

Path Aが独自にニュースを取得する必要はない。B2/B3が加工済みのニュースデータ（market_cache）を参照する。

### 3.4 設計原則

1. **売買最優先**: ニュース到着→即座にタイトルで判断→ポジション操作。UI加工は後回し
2. **二段構え**: タイトル即断（速度）→ og:description補正（精度）で速度と精度を両立
3. **ニュース共有化**: 1回取得→全Path共有。重複取得を排除
4. **フォールバックチェーン廃止**: 1プロバイダーで1回試行。失敗したら次のcronで再試行（1分後）
5. **Pathごとに独立した予算管理**: 互いに時間を食い合わない

---

## 4. 各Pathの詳細仕様

### 4.1 Path A: レート変化トリガー

**目的**: 価格が急変した銘柄だけをAI判定する（現行フィルタの簡素化版）

**判定条件**:
- `|currentRate - prevRate| >= instrument.rateChangeTh`
- 重要指標スキップ時間帯（`isSkipSchedule`）は除外

**現行との違い**:
- `hasNewNews` によるフィルタ通過を **廃止**（ニュースはPath Bが担当）
- `redditSignal.hasSignal` によるフィルタ通過を **廃止**（低信頼度のため。Redditデータ自体はPath Bプロンプトの補助情報として活用）
- 市場時間帯ボーナス（`sessionBonus`）とボラティリティスコアによる優先順位付けは **維持**

**AI呼出**: 銘柄ごとに個別呼出（現行の `getDecisionWithHedge` と同等）

**ニュース参照**: 共有ストアから最新ニュースタイトルをAIプロンプトに含める（Path A自身はニュースを取得しない）。B2/B3が完了していればog:description付きの加工済みデータを参照する。

**予算**: 最大5銘柄（超過分はPath Cの次回に回す）

### 4.2 Path B: ニューストリガー（二段構え）

**目的**: ニュース変化を検知し、二段構えで速度と精度を両立した売買判断を行う

**発火条件**:
- `newsHash` が前回と異なる（新ニュース検出時のみ）
- 直前のPath B失敗から **2分以上** 経過

#### B1: タイトル即断（Stage 1）

```
入力:  ニュースタイトル一覧（descriptionなし）
速度:  ~3秒
判断:  BUY / SELL / HOLD（銘柄ごと）
動作:  BUY/SELLなら即ポジションオープン
```

AI出力フォーマット:
```json
{
  "news_analysis": [
    {
      "index": 0,
      "attention": true,
      "impact": "日銀利上げ示唆。円高要因",
      "title_ja": "BOJ Signals Rate Hike → 日銀、利上げ示唆",
      "affected_pairs": ["USD/JPY", "EUR/USD", "Nikkei225"]
    }
  ],
  "trade_signals": [
    {
      "pair": "USD/JPY",
      "decision": "SELL",
      "tp_rate": 148.50,
      "sl_rate": 149.80,
      "reasoning": "日銀利上げ示唆で円高進行見込み"
    }
  ]
}
```

#### B2: og:description補正（Stage 2）

```
B1完了後、並列でog:description取得を開始（B1を待たずに開始してもよい）

入力:  タイトル + og:description（日本語6ソースのリンク先HTMLから取得）
速度:  +1-3秒（og:description取得 + AI呼出）
判断:  CONFIRM / REVISE / REVERSE
```

| Stage 2判断 | 動作 |
|---|---|
| CONFIRM | Stage 1の判断を維持。そのまま保持 |
| REVISE | TP/SL を調整（方向は同じ、精度を改善） |
| REVERSE | Stage 1の判断を取消 → 即クローズ（逆転） |

Stage 2 AI出力フォーマット:
```json
{
  "corrections": [
    {
      "pair": "USD/JPY",
      "action": "REVISE",
      "new_tp_rate": 148.20,
      "new_sl_rate": 149.50,
      "reasoning": "詳細を読むと利上げ幅が0.1%と小幅。TP/SLを控えめに調整"
    }
  ]
}
```

Stage 2のAIプロンプトは「新規判断」ではなく「Stage 1の検証」:
- 「先ほどタイトルだけでBUY判断した。詳細を読んで、この判断を維持するか修正するか」

**og:description取得方法**:
- 日本語6ソース（wor.jp経由）のみ対象
- リンク先HTMLをfetch → `<meta property="og:description" content="...">` を抽出
- 英語4ソースはRSSのdescriptionを使用（追加fetchなし）
- 取得対象: B1で `attention: true` になったニュースのリンクのみ（全件ではない）

#### B3: UI用加工（最低優先度）

```
B1/B2完了後、時間バジェットの残りで実行
失敗しても売買に影響ゼロ

処理内容:
  - ニュース分析結果（attention, impact, title_ja）をmarket_cacheに保存
  - Path Aが参照する「加工済みニュースデータ」もここで更新
  - 翻訳・注目フラグはUIのニュースドロワー表示に使用

時間バジェット:
  - 60秒のcron制限のうち、B1+B2で最大10秒
  - 残り時間でB3を実行。間に合わなければ次のcronに委譲
  - 現行の3-tier fallback（Gemini→GPT→Claude）は完全廃止
  - B3は単発AI 1回で十分（失敗してもリトライなし）
```

**フォールバック**: 全Stage共通でなし。Gemini 1回のみ。失敗したら次のcronで再試行。

**予算影響**: B1+B2で最大2回のAI呼出。Path A・Cの予算を圧迫しない。

### 4.4 Path C: 定期巡回

**目的**: レート変化もニュース影響もなかった銘柄を定期的にチェックする

**判定条件**:
- `last_ai_call_{pair}` から **30分以上** 経過（現行の `FORCE_CALL_INTERVAL_MIN = 30` と同じ）
- 重要指標スキップ時間帯は除外

**AI呼出**: 銘柄ごとに個別呼出

**ニュース参照**: Path Aと同様、共有ストアのニュースをAIプロンプトに含める

**予算**: 1 cronあたり最大2銘柄（Path Aが少ない時に余裕があれば+1）

**優先順位**: `instrument_scores` テーブルのスコアが高い銘柄を優先

---

## 5. Path B AIプロンプト設計（二段構え）

### 5.1 B1: タイトル即断プロンプト

**システムプロンプト**:
```
あなたは金融マーケットアナリスト兼トレーダーのAIアシスタントです。
以下のニュースタイトル一覧を分析し、2つのタスクを同時に実行してください:

【タスク1: ニュース分析】
各ニュースについて、マーケット（為替・株式・債券・暗号資産・コモディティ）への影響を評価し、
注目フラグと影響銘柄を判定してください。

【タスク2: 売買シグナル】
注目ニュースに基づき、影響を受ける銘柄について売買判断を返してください。
- 既にオープンポジションがある銘柄は含めないこと
- TP/SLは各銘柄の特性に合わせて設定すること
- 確信度が低い場合はその銘柄を含めないこと（HOLDは返さない）
- リスクリワード比（TP距離÷SL距離）は必ず1.5以上にすること

必ず以下のJSONフォーマットのみで返答してください:
{
  "news_analysis": [{index, attention, impact, title_ja, affected_pairs}],
  "trade_signals": [{pair, decision, tp_rate, sl_rate, reasoning}]
}

注目ニュースがない場合: news_analysis は全て attention:false, trade_signals は空配列。
```

**ユーザーメッセージ**:
```
【ニュースタイトル一覧】（※タイトルのみ。詳細は後続ステージで補完）
[0] Fed's Waller Cautious On Oil, May Advocate for Rate Cuts Later
[1] ビルロワドガロー仏中銀総裁 利上げの可能性については会合ごとに判断する
...

【現在の市場状況】
VIX: 22.5, 米10年債: 4.35%, 日経: 38,200, S&P500: 5,820
Redditシグナル: BOJ, intervention

【対象銘柄と現在値】
USD/JPY: 149.50 (TP/SL: ±0.3〜1.0円)
Nikkei225: 38,200 (TP/SL: ±100〜500pt)
...（17銘柄全て列挙、OP保有中は除外マーク）
```

### 5.2 B2: og:description補正プロンプト

**システムプロンプト**:
```
先ほどニュースのタイトルのみで以下の売買判断を行いました。
今回、各ニュースの詳細（og:description）を取得しました。

詳細を読んで、先ほどの判断を検証してください。
各判断に対して以下の3つのうち1つを返してください:

- CONFIRM: 判断を維持（詳細が判断を裏付けている）
- REVISE: TP/SLを調整（方向は同じだが、詳細を踏まえて精度を改善）
- REVERSE: 判断を取消（詳細がタイトルの印象と異なり、逆の判断が適切）

必ず以下のJSONフォーマットのみで返答してください:
{
  "corrections": [
    {
      "pair": "USD/JPY",
      "action": "CONFIRM" | "REVISE" | "REVERSE",
      "new_tp_rate": number | null,
      "new_sl_rate": number | null,
      "reasoning": "理由（日本語50文字以内）"
    }
  ]
}

全てCONFIRMの場合も明示的に返してください。
```

**ユーザーメッセージ**:
```
【先ほどの判断】
USD/JPY: SELL @ 149.50, TP=148.50, SL=149.80
  理由: 日銀利上げ示唆で円高進行見込み

【ニュース詳細（og:description）】
[0] Fed's Waller Cautious On Oil...
    詳細: Federal Reserve Governor Christopher Waller said he is cautious about how surging oil prices...
[1] ビルロワドガロー仏中銀総裁...
    詳細: 利上げの可能性については会合ごとに判断する ECBは引き続き警戒を怠らない エネルギー市場の変動に対して...
```

### 5.3 現行プロンプトとの違い

| 項目 | 現行 | 新設計（二段構え） |
|---|---|---|
| AI呼出回数 | ニュース分析1回 + 銘柄判定N回 | **B1: 1回 + B2: 1回 = 最大2回** |
| 判断速度 | 分析完了後にやっと判定開始 | **B1で即ポジション操作** |
| description活用 | AI判断に不使用（UIのみ） | **B2でAI判断の精度向上に活用** |
| 影響銘柄の特定 | なし（全銘柄強制チェック） | AIが `affected_pairs` で特定 |
| 失敗時の影響 | 3段fallbackで30秒消費 | **失敗は次のcronで再試行。Path A/Cに影響なし** |

---

## 6. 重複排除ルール

Path A/B/Cの結果が同一銘柄に対して競合する場合のマージ規則:

### 6.1 優先順位

```
Path B（ニュース起因） > Path A（レート変化起因） > Path C（定期巡回）
```

### 6.2 マージロジック

1. Path B の `trade_signals` に含まれる銘柄 → Path Bの判断を採用。Path A/Cの同一銘柄結果は破棄
2. Path B に含まれない銘柄 → Path Aの結果を採用
3. Path A にも含まれない銘柄 → Path Cの結果を採用
4. どのPathにも含まれない銘柄 → HOLD（decisions記録のみ）

### 6.3 理由

- ニュースは「突発的な方向転換」を示唆するため、レートのトレンド分析（Path A）より優先すべき
- Path Bは全銘柄の文脈を一度に見ているため、個別判定（Path A）より一貫性がある
- Path Cは「念のため確認」なので最低優先

---

## 7. 削除するもの

### 7.1 コード削除対象

| 対象 | ファイル | 行 | 理由 |
|---|---|---|---|
| `analyzeNews()` | gemini.ts 347-383 | ニュース分析専用関数 → Path Bに統合 |
| `analyzeNewsGPT()` | gemini.ts 399-433 | GPTフォールバック → 廃止 |
| `analyzeNewsClaude()` | gemini.ts 435-470 | Claudeフォールバック → 廃止 |
| ニュース分析3段フォールバック | index.ts 250-306 | 30行の直列フォールバックチェーン → Path B 1回呼出に置換 |
| `hasAttentionNews` フラグ | index.ts 316-330 | 全銘柄強制チェック → Path Bの `affected_pairs` に置換 |
| `news_analysis` キャッシュ読み書き | index.ts 240, 298-299 | Path Bが直接 `trade_signals` を返すため不要 |
| `news_analysis_failed_at` キャッシュ | index.ts 244-246, 285, 302 | クールダウン管理を簡素化 |
| `forceAnalysis` ロジック | index.ts 240-241 | 初回強制実行 → Path Cが代替 |
| `newsAnalysisRan` によるAI上限0件化 | index.ts 344 | ニュース分析とAI判定が排他でなくなるため不要 |
| `NEWS_ANALYSIS_SYSTEM_PROMPT` 定数 | gemini.ts 385-391 | Path Bの新プロンプトに統合 |
| `buildNewsList()` ヘルパー | gemini.ts 393-397 | Path B専用のメッセージビルダーに置換 |

### 7.2 データベース変更

- `market_cache` の `news_analysis` キー → **削除不要**（UIが参照している場合があるため、Path Bの `news_analysis` 部分で引き続き書き込む）
- `market_cache` の `news_analysis_failed_at` キー → 廃止（Path Bは `pathb_cooldown_until` に置換）

### 7.3 filter.ts の変更

- `hasNewNews` パラメータを **削除**（ニュースはPath Bが担当）
- `redditSignal` パラメータを **削除**（Reddit情報はPath BのAIプロンプトに直接渡す）
- 残るのは: レート変化閾値チェック + 重要指標スキップ + 定期強制呼出

---

## 8. 時間予算比較

### 8.1 現行（最悪ケース）

```
Phase                              時間     累計
────────────────────────────────────────────────
並列データ取得                      5秒      5秒
TP/SL チェック                      2秒      7秒
ニュース分析 Gemini (タイムアウト)  10秒     17秒
ニュース分析 GPT (タイムアウト)     10秒     27秒
ニュース分析 Claude (タイムアウト)  10秒     37秒
銘柄AI判定 (予算残り23秒 → 1-2件)  12秒     49秒
DB記録・ログ                        2秒     51秒
────────────────────────────────────────────────
合計                                         ~51秒（しかもニュース分析失敗）
```

**問題**: ニュース分析が全滅しても37秒消費。銘柄判定は1-2件しかできない。

### 8.2 新設計（最悪ケース — 二段構え版）

```
Phase                              時間     累計
────────────────────────────────────────────────
並列データ取得（10ソースRSS）        5秒      5秒
TP/SL チェック                      2秒      7秒
                                            ─┐
Path B-B1: タイトル即断 (1回)       5秒     ─┤
  → ポジション操作                   1秒     ─┤
Path B-B2: og:desc取得+補正 (1回)   5秒     ─┤ 並列実行
Path A: レート変化AI判定 (並列)    12秒     ─┤ → max 15秒 = 22秒
Path C: 定期巡回AI判定 (並列)      12秒     ─┘
重複排除・マージ + B2補正適用        1秒     23秒
サニティチェック + ポジション開設    2秒     25秒
B3: UI用加工（残り時間で実行）     10秒     35秒
DB記録・ログ                        2秒     37秒
────────────────────────────────────────────────
合計                                         ~37秒（B3含む）/ ~27秒（B3なし）
```

### 8.3 新設計（Path B失敗時）

```
Phase                              時間     累計
────────────────────────────────────────────────
並列データ取得（10ソースRSS）        5秒      5秒
TP/SL チェック                      2秒      7秒
Path B-B1: タイムアウト (10秒)     10秒     ─┐
Path A: レート変化AI判定 (並列)    12秒     ─┤ 並列実行
Path C: 定期巡回AI判定 (並列)      12秒     ─┘ → max 12秒 = 19秒
重複排除（Path Bなし）              0秒     19秒
サニティチェック + ポジション開設    2秒     21秒
DB記録・ログ                        2秒     23秒
────────────────────────────────────────────────
合計                                         ~23秒（Path B失敗でも売買は正常動作）
```

**改善ポイント**: Path Bが失敗してもPath A/Cに影響しない。B3が間に合わなくても売買には影響なし。

### 8.4 比較サマリー

| 指標 | 現行 | 新設計 | 改善 |
|---|---|---|---|
| 最悪ケース実行時間 | ~51秒 | ~37秒（B3含む）/ ~27秒（B3なし） | **-14〜-24秒** |
| 通常ケース実行時間 | ~30-40秒 | ~20-30秒 | **-10秒 (-30%)** |
| ニュース分析失敗時のAI判定数 | 0件 | 5-7件 | **大幅改善** |
| AI呼出回数（通常） | 分析1回 + 判定3-8回 = 4-9回 | B1: 1回 + B2: 1回 + Path A 3-5回 + Path C 1-2回 = 6-9回 | 同等 |
| AI呼出コスト（失敗時） | 3回消費（3段fallback） | 1回のみ | **-67%削減** |
| ニュース→売買の速度 | 分析完了まで待機（10-30秒後） | **B1で即座に売買（3秒後）** | **即時性大幅向上** |
| description活用 | UIのみ（AI判断に不使用） | **B2でAI補正に活用** | 判断精度向上 |

---

## 9. UIへの影響

### 9.1 `news_analysis` データ

現行UIは `market_cache` の `news_analysis` キーを参照してニュース一覧を表示している。

**対応方針**: Path Bの結果から `news_analysis` 部分を抽出し、同じフォーマットで `market_cache` に保存する。

```
Path Bの response.news_analysis → 既存フォーマットに変換 → setCacheValue('news_analysis', ...)
```

UI側の変更は **不要**。

### 9.2 `latest_news` データ

現行: ニュース分析成功時に `latest_news` キャッシュも更新（index.ts 300行目）

**対応方針**: Path Bの処理内で同様に更新する。変更なし。

### 9.3 decisions テーブルの `reasoning` フィールド

Path Bで返された `trade_signals[].reasoning` は、現行と同じ `reasoning` フィールドに格納する。ただし、ニュース起因であることを明示するため、プレフィックスを付ける:

```
[ニュース] 日銀利上げ示唆で円高進行見込み
```

### 9.4 新規UIデータ（将来対応）

Path Bの `affected_pairs` 情報は現行UIでは表示しないが、将来的に「このニュースが影響した銘柄」をUI上で可視化する際に利用可能。`news_analysis` キャッシュに `affected_pairs` フィールドを含めて保存しておく。

---

## 10. 段階的移行計画

一度に全部変えるとリスクが高い。以下の4ステップで段階的に移行する。

### Phase 1: RSSソース差し替え + フォールバック撤去（低リスク）

**変更範囲**: news.ts, index.ts のニュース分析セクション

**内容**:
- news.ts の SOURCES を10ソースに差し替え
- 3段フォールバック（Gemini→GPT→Claude）を **Gemini 1回のみ** に変更
- タイムアウトを10秒→12秒に緩和
- 失敗時のクールダウンを5分→2分に短縮
- `newsAnalysisRan` による `MAX_GEMINI_PER_RUN = 0` のロジックを **廃止**

**効果**:
- 最悪ケースのニュース分析時間: 30秒 → 12秒
- ニュース分析後もAI判定が実行される
- 速報性の高いソースからニュース取得

**リスク**: 低

**検証**: デプロイ後、`system_logs` で実行時間と判定件数を確認

### Phase 2: Path B 二段構え導入（中リスク）

**変更範囲**: gemini.ts に新関数追加、index.ts のニュース分析セクション置換

**内容**:
- `newsStage1()` 関数を新設（B1: タイトル即断）
- `newsStage2()` 関数を新設（B2: og:description補正）
- `fetchOgDescription()` 関数を新設（リンク先HTMLからog:description抽出）
- 旧 `analyzeNews()` / `analyzeNewsGPT()` / `analyzeNewsClaude()` を削除
- B1で即ポジション操作 → B2でCONFIRM/REVISE/REVERSE

**効果**:
- ニュース→売買が3秒で完了（現行: 10-30秒後）
- og:descriptionによるAI判断精度向上

**リスク**: 中（新プロンプトの出力品質を検証する必要がある）

**検証**:
- Path Bが返す `trade_signals` のTP/SL値がサニティチェックを通過するか
- `affected_pairs` の精度（関係ない銘柄を挙げていないか）
- 1週間のペーパートレードで勝率・RR比を比較

### Phase 3: 3Path並列実行 + 重複排除（中リスク）

**変更範囲**: index.ts のニュース共有化

**内容**:
- ニュース取得を1回だけ実行 → 共有ストアに保持
- Path A/Cのプロンプトが共有ストアのニュースを参照
- Path Aから `hasNewNews` / `redditSignal` によるフィルタ通過を削除
- B3のUI加工結果をmarket_cacheに保存 → Path A/Cが加工済みデータを参照

**効果**:
- ニュースデータの重複取得を排除
- Path Aのニュース参照が常に最新のB2/B3加工済みデータ

**リスク**: 低（ニュースデータの受け渡しのみ）

### Phase 4: 3Path並列実行 + 重複排除（中リスク）

**変更範囲**: index.ts の `run()` 関数を構造的にリファクタリング

**内容**:
- `run()` 内のメインロジックを3つの関数に分割:
  - `runPathA(candidates, sharedNews, env)`: レート変化トリガー → 個別AI判定
  - `runPathB(news, indicators, prices, openPairs, env)`: ニューストリガー → B1即断 → B2補正 → B3 UI加工
  - `runPathC(candidates, sharedNews, env)`: 定期巡回 → 個別AI判定
- 3つのPathを `Promise.allSettled` で並列実行
- 結果をマージ関数で統合（Path B優先の重複排除）
- filter.ts から `hasNewNews` / `redditSignal` パラメータを削除

**効果**:
- 実行時間が「直列の合計」→「最長Pathの時間」に短縮
- Path Bの失敗がPath A/Cに影響しない

**リスク**: 中（並列実行による D1 同時書き込みの競合に注意）

**検証**:
- `wrangler tail` で各Pathの実行時間を確認
- D1の同時書き込みエラーが発生していないか
- decisions テーブルの記録に重複がないか

### 移行タイムライン

```
Phase 1: 即日実施可能（1-2時間）— RSSソース差し替え + fallback撤去
  ↓ 1日観察
Phase 2: Phase 1確認後（3-4時間）— 二段構え導入
  ↓ 3日観察
Phase 3: Phase 2確認後（1-2時間）— ニュース共有化
  ↓ 1日観察
Phase 4: Phase 3確認後（4-6時間）— 3Path並列実行
```

---

## 11. 注意事項・リスク

### 11.1 Path B のAI出力品質（二段構え固有）

B1（タイトル即断）はタイトルだけで判断するため、精度が下がる可能性がある。対策:
- サニティチェック（`checkTpSlSanity`）は引き続き適用
- B2（og:description補正）でREVISE/REVERSEにより誤判断を修正
- B1は「ニュースに影響される銘柄のみ」を返すため、通常は2-4銘柄程度
- B2のREVERSE率が高い場合は、B1の即ポジション操作を停止し、B2完了後に一括操作に変更する（フォールバックプラン）

### 11.2 og:description取得の信頼性

- リンク先が404やタイムアウトの場合 → B2をスキップし、B1の結果をそのまま採用
- og:descriptionが空の場合 → 同上
- タイムアウト: 1リンクあたり3秒。注目ニュースのリンクのみ取得（全件ではない）
- Cloudflare Workersからのfetch制限に注意（同時接続数）

### 11.3 D1 同時書き込み

Phase 4で3つのPathが並列実行されると、`decisions` テーブルや `market_cache` への同時書き込みが発生する。

対策:
- 各PathはAI判定結果を配列として返し、マージ後に一括でDB書き込みする
- Path内ではDB書き込みをしない（判定のみ）

### 11.4 ニュースが全銘柄に影響するケース

「米FOMC利下げ」のようなニュースは全銘柄に影響する。Path Bが17銘柄分の `trade_signals` を返すと、Path A/Cの結果が全て上書きされる。

対策:
- Path Bが返す `trade_signals` が10件以上の場合は「過剰検出」として警告ログを出す
- 上位5件のみ採用し、残りはPath A/Cの結果を尊重する

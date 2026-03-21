# パラレルトリガー v2 実装仕様書

**作成日**: 2026-03-21
**ステータス**: 承認済み（ユーザー全権委任）
**前提**: `2026-03-20-parallel-trigger-design.md` の設計を基に、実装上の決定事項を確定した仕様書

---

## 1. 実装スコープ

| Phase | 内容 | 本仕様書での扱い |
|---|---|---|
| Phase 1 | RSSソース差し替え・3段fallback廃止 | **実装済み**（対象外） |
| Phase 2 | Path B 二段構え（B1/B2/B3） | **実装対象** |
| Phase 3 | ニュース共有ストア化 | **実装対象** |
| Phase 4 | 3Path 並列実行・重複排除 | **実装対象** |

---

## 2. 確定した設計決定事項

| 項目 | 決定 | 理由 |
|---|---|---|
| B1のポジション操作タイミング | **B2完了後に一括操作**（B2待ち） | スプレッド往復コスト回避、B1精度未検証 |
| B2タイムアウト時の挙動 | **B1シグナルをそのまま採用** | タイムアウト=精度補正できなかっただけで判断は有効 |
| DB書き込み方式 | **マージ後一括書き込み** | D1同時書き込み競合をゼロに抑える |
| 過剰検出ガード | **Path Bが10件超→返却順先頭5件のみ採用** | 全銘柄影響ニュースでの誤爆防止。ソート基準は返却インデックス昇順 |
| 旧コード | **コメントアウト→動作確認後に完全削除** | 段階的ロールバック対応 |
| B2 REVERSE後の再オープン | **同サイクル内は再オープンしない** | クローズ直後の逆張りはスプレッド損失が大きい |
| positions/decisionsの原子性 | **positions INSERT → 成功後にdecisions INSERT** | 整合性確保。positions失敗時はdecisions書き込みをスキップ |
| Redditシグナルの扱い | **Path B の newsStage1 プロンプトに含める（廃止しない）** | 補助情報として精度に貢献する可能性がある |
| B3の実行タイミング | **Path B内部でB2完了後に非同期起動（ctx.waitUntil相当）** | 売買処理をブロックしない。失敗しても次cronで再試行 |

---

## 3. アーキテクチャ全体図

```
毎分 Cron
  │
  ├─① 並列データ取得（価格・RSS10ソース・指標）
  │     └─ 共有ニュースストア構築（SharedNewsStore）
  │
  ├─② TP/SL・トレイリングストップ管理（常時）
  │
  ├─③ 3Path を Promise.allSettled で並列実行
  │   │                              ← wall-clock タイムアウト基準
  │   ├─ Path A: レート変化した銘柄 → 個別AI判定 → PathDecision[]
  │   │
  │   ├─ Path B: ニュースハッシュ変化時のみ発火
  │   │    B1: タイトル即断 → trade_signals 収集（wall-clock ~10秒）
  │   │    og:description 並列取得（attention上位5件、各3秒）
  │   │    B2: og:desc付きで補正 → CONFIRM/REVISE/REVERSE（wall-clock ~8秒）
  │   │         タイムアウト時: B1シグナルをそのまま採用
  │   │    B3: 別Promise起動（B2完了後）→ market_cache保存（売買をブロックしない）
  │   │    → PathDecision[]（BUY/SELLのみ。REVERSE対象はb2Reversalsに追加）
  │   │
  │   └─ Path C: 30分以上未チェック銘柄 → 個別AI判定 → PathDecision[]
  │
  ├─④ 重複排除・マージ（Path B > A > C 優先）
  │     REVERSE pair は toClose へ、同サイクル内再オープン禁止
  │
  ├─⑤ サニティチェック → positions INSERT → 成功後に decisions INSERT
  │
  └─⑥ 残りの decisions（HOLD・スキップ）を一括DB書き込み
```

---

## 4. 変更ファイル一覧

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `src/gemini.ts` | 追加 | `fetchOgDescription()`, `newsStage1()`, `newsStage2()` |
| `src/gemini.ts` | コメントアウト | `analyzeNews()`, `analyzeNewsGPT()`, `analyzeNewsClaude()` |
| `src/index.ts` | 追加 | `runPathA()`, `runPathB()`, `runPathC()`, `mergePaths()` |
| `src/index.ts` | 全面刷新 | `run()` 関数を3Path並列構造に変更 |
| `src/filter.ts` | 変更 | `hasNewNews` / `redditSignal` パラメータ削除 |

---

## 5. 型定義

```typescript
// 共有ニュースストア
interface SharedNewsStore {
  items: NewsItem[];
  hash: string;        // ニュースハッシュ（変化検知用）
  hasChanged: boolean; // 前回cronからの変化フラグ
}

// ニュース分析アイテム（B1出力・market_cache保存用）
interface NewsAnalysisItem {
  index: number;
  attention: boolean;
  impact: string;
  title_ja: string;
  affected_pairs: string[];
  link?: string;
  og_description?: string;  // B2でfetch後に付与
}

// 各Pathの返り値（統一型）
interface PathDecision {
  pair: string;
  decision: 'BUY' | 'SELL' | 'HOLD';
  tp_rate: number | null;
  sl_rate: number | null;
  reasoning: string;
  rate: number;
  source: 'PATH_A' | 'PATH_B' | 'PATH_C';
  news_analysis?: NewsAnalysisItem[];  // Path Bのみ
}

// Path B B1出力
interface NewsStage1Result {
  news_analysis: NewsAnalysisItem[];
  trade_signals: Array<{
    pair: string;
    decision: 'BUY' | 'SELL';
    tp_rate: number;   // non-nullable（B1は必ず値を返す）
    sl_rate: number;
    reasoning: string;
  }>;
}

// Path B B2出力
interface NewsStage2Result {
  corrections: Array<{
    pair: string;
    action: 'CONFIRM' | 'REVISE' | 'REVERSE';
    new_tp_rate?: number;  // REVISE時のみ。nullはB1値を維持
    new_sl_rate?: number;
    reasoning: string;
  }>;
}

// B2補正適用ルール:
// - CONFIRM: B1のtp_rate/sl_rateをそのまま使用
// - REVISE:  new_tp_rate/new_sl_rateが存在すれば上書き、なければB1値を維持
// - REVERSE: toCloseに追加。同サイクルのtoOpenから除外
```

---

## 6. gemini.ts 追加関数仕様

### `fetchOgDescription(url: string, sourceName?: string): Promise<string | null>`

- タイムアウト: 3秒（wall-clock）
- **全ソース対象**（除外リスト廃止済み 2026-03-21）
  - CNBC/Bloomberg/FXStreet/CoinDesk を含む全ソースの `og:description` を取得試行
  - `og:description` は HTML `<head>` 内のメタタグでペイウォールの影響を受けない
- `<meta property="og:description" content="...">` を正規表現で抽出
- 失敗（404/タイムアウト/パースエラー）時は `null` を返す（例外を投げない）
- **呼び出し上限**: attention:true ニュース上位5件のみ対象（`slice(0, 5)`で制限）

### `newsStage1(params): Promise<NewsStage1Result>`

- モデル: `gemini-2.5-pro-preview`
- タイムアウト: 10秒（wall-clock）
- 入力: ニュースタイトル一覧 + 市場状況 + Redditシグナル + 銘柄一覧（OPありは除外マーク）
- responseMimeType: `application/json`
- 失敗時: 例外を投げる（呼び出し元でcatchしてPath Bをスキップ）
- **`title_ja` 出力ルール**（2026-03-21追加）:
  - `attention:true` / `attention:false` に関わらず、**全ニュースに `title_ja`（日本語タイトル）を返す**
  - ダッシュボードのニュース一覧で和訳表示に使用される
  - 翻訳はB1の既存Gemini呼び出しに相乗りさせる（APIハンドラ側でのGemini呼び出しは429問題のため禁止）

### `newsStage2(params): Promise<NewsStage2Result>`

- タイムアウト: 8秒（wall-clock）
- 入力: B1の`trade_signals` + og:description付きニュース詳細
- responseMimeType: `application/json`
- タイムアウト・失敗時: 呼び出し元で catch → B1シグナルをそのまま採用

---

## 7. filter.ts 変更仕様

```typescript
// Before
export function shouldCallGemini(params: {
  currentRate: number;
  prevRate: number;
  hasNewNews: boolean;       // 削除（Path Bが担当）
  redditSignal: RedditSignal; // 削除（Path BのAIプロンプトに直接渡す）
  now: Date;
}): FilterResult

// After（Path A / Path C 専用フィルタ）
export function shouldCallGemini(params: {
  currentRate: number;
  prevRate: number;
  now: Date;
}): FilterResult
```

---

## 8. マージロジック詳細

```typescript
function mergePaths(
  pathA: PathDecision[],
  pathB: PathDecision[],
  pathC: PathDecision[],
  b2Reversals: string[],  // B2でREVERSEされた pair 一覧
): {
  toOpen: PathDecision[];        // ポジション開設対象（BUY/SELLのみ）
  toClose: Array<{ pair: string; reason: string }>;  // クローズ対象
  allDecisions: PathDecision[];  // decisions テーブル書き込み用（全件）
}
```

**優先ルール（順序通り適用）:**

1. `b2Reversals` に含まれる pair → `toClose` に追加（`reason: 'B2_REVERSE'`）
   - **同サイクル内の再オープン禁止**: `toClose`の pair は `toOpen` から除外する
2. Path B の BUY/SELL（`decision !== 'HOLD'`）→ `toOpen` に追加
   - Path A/C の同 pair 結果は `allDecisions` のみ（`toOpen`には含めない）
3. Path B に含まれない pair は Path A の結果を確認
   - `decision === 'BUY' | 'SELL'` の場合のみ `toOpen` に追加（HOLD は含めない）
4. Path A にも含まれない pair は Path C の結果を確認
   - 同様に BUY/SELL のみ `toOpen` に追加
5. Path B が BUY/SELL を 10件超返した場合 → **返却順（インデックス昇順）で先頭5件**のみ `toOpen` に採用
   - 残りは `allDecisions` のみ

**全件 `allDecisions` に含める**（HOLDも含む全PathDecision）

---

## 9. positions / decisions の原子性保証

```
ポジション開設フロー:
  1. サニティチェック（TP/SL妥当性）
  2. positions INSERT（失敗→例外をthrow）
  3. 成功後のみ decisions INSERT（positions と紐付いたレコード）

HOLD・スキップのdecisions:
  - 全て一括でINSERT（ポジション操作なし）
  - 失敗は握りつぶし（次cronで問題なし）
```

---

## 10. 旧コード対応

| 対象 | 処置 |
|---|---|
| `analyzeNews()` in gemini.ts | `/* DEPRECATED_v2: ... */` でコメントアウト |
| `analyzeNewsGPT()` in gemini.ts | 同上 |
| `analyzeNewsClaude()` in gemini.ts | 同上 |
| `newsAnalysisRan` ロジック in index.ts | コメントアウト（Path B に置換） |
| `hasAttentionNews` フラグ in index.ts | コメントアウト（Path B の affected_pairs に置換） |
| `hasNewNews` パラメータ in filter.ts | 削除（Path B が担当） |

**動作確認後に完全削除するトリガー:**
- 本番でPath Bが連続10回以上成功した段階でユーザーに削除提案する

---

## 11. 時間予算（目標・wall-clock基準）

| フェーズ | 通常ケース | 最悪ケース | 累計（最悪） |
|---|---|---|---|
| 並列データ取得 | 3秒 | 5秒 | 5秒 |
| TP/SLチェック | 1秒 | 2秒 | 7秒 |
| Path A（並列） | 8秒 | 12秒 | ─ |
| Path B B1 | 5秒 | 10秒 | ─ |
| Path B og:取得（5件並列） | 2秒 | 3秒 | ─ |
| Path B B2 | 5秒 | 8秒 | ─ |
| **3Path最長（並列）** | 12秒 | **21秒** | **28秒** |
| マージ + サニティ | 1秒 | 1秒 | 29秒 |
| positions/decisions書き込み | 3秒 | 5秒 | 34秒 |
| B3 UI加工（非同期・任意） | 非同期 | 非同期 | ブロックせず |
| **合計目標** | **~23秒** | **~34秒** | Cloudflare 60秒制限に対して余裕あり |

> Path B の直列最悪ケース（B1:10秒 + og:3秒 + B2:8秒 = 21秒）が3Pathの律速になる想定。
> それでも全体で ~34秒 に収まり、Workers の 60秒制限に対して 26秒の余裕がある。

---

## 12. リスクと対策

| リスク | 対策 |
|---|---|
| B1の精度が低くREVERSEが多発 | REVERSE率を`systemLogs`で監視。20%超でB2待ち→強制HOLD化を検討 |
| og:description取得で同時接続数超過 | attention:true 上位5件に制限。Workers subリクエスト上限50に対して余裕あり |
| D1 HOLD decisions一括書き込み失敗 | 握りつぶし。次cronで再試行（ポジション操作と分離済みのため整合性に影響なし） |
| 3Path並列でGemini 429エラー | 既存の`gemini_cooldown_until`キャッシュで対応済み |
| Path B発火なし（土日・市場休場） | Path A/Cは独立して動作するため売買に影響なし |
| APIハンドラからGemini呼び出しで429 | **APIハンドラ内でのGemini呼び出し禁止**。翻訳等はcron側（B1相乗り）で処理しキャッシュ経由で提供 |

---

## 13. ダッシュボード連携仕様（2026-03-21追加）

### `latest_news` キャッシュ

Path B実行時に `market_cache` テーブルの `latest_news` キーに以下の形式で保存:

```typescript
// latest_news キャッシュ構造
Array<{
  title: string;         // 元の英語タイトル
  title_ja: string | null; // B1が返した日本語翻訳（全ニュース対象）
  pubDate: string;
  description: string;
  source?: string;       // RSSソース名
}>
```

- Path B が発火した場合のみ更新（ニュースハッシュ変化時）
- `pathBResult.newsAnalysis` が空の場合は上書きしない（前回値を維持）
- B1の `title_ja` を `index` でマッピングして付与

### api.ts ニュース表示ロジック

1. RSSから直接取得したニュース一覧を基本とする
2. `latest_news` キャッシュで補完（RSSで取得できなかった記事を追加）
3. キャッシュに `title_ja` があれば和訳タイトルを優先表示（`title_ja || title`）
4. `pubDate` 降順ソート（新しい記事が先頭）
5. 上限30件

### 制約事項

- **APIハンドラ内でGeminiを呼ばない**（cron側のPath A/B/Cと429競合するため）
- 翻訳はB1の既存Gemini呼び出しに相乗りさせる
- 翻訳反映タイミング: 次回ニュースハッシュ変化時にB1が全記事翻訳

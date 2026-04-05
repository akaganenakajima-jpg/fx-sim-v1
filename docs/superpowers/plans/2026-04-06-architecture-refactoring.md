# アーキテクチャリファクタリング計画

> **作成日**: 2026-04-06
> **ステータス**: 計画中（コード未変更）
> **優先度順**: Task 4 → Task 3 → Task 2 → Task 1
> **対象ブランチ**: 各Taskで `feature/YYYYMMDD-refactor-xxx` を切って着手すること

---

## 背景・動機

急速な機能追加（スクリーナー・パラメーターレビュー・週末制約・サーキットブレーカー等）の結果、
コアファイルに技術的負債が蓄積している。現時点のコードベース規模:

| ファイル | 行数 | 問題の深刻度 |
|---|---|---|
| `src/index.ts` | 2,530行 | 🔴 God Object（runCore:291行 + runAnalysis:468行 + 15関数が混在） |
| `src/api.ts` | 1,429行 | 🟠 Fat Payload（getApiStatus:506行が全データを一括取得） |
| `src/app.js.ts` | 3,210行 | 🟡 Template Literal地獄（IDEサポートなし） |
| `src/style.css.ts` | 723行 | 🟡 同上 |

実弾運用・拡張に耐えるアーキテクチャへの移行を目的として、以下4つのTaskを計画する。

---

## Task 1: フロントエンドとバックエンドの境界分離

### 課題

`src/app.js.ts` (3,210行) と `src/style.css.ts` (723行) に、クライアント側のJavaScriptとCSSが
TypeScriptのTemplate Literalとして直書きされている。

**具体的な弊害:**
- IDEのLint・型チェック・構文ハイライトが一切効かない（文字列扱いのため）
- `app.js.ts` 内のJSにバグを埋め込んでもビルド時に検出不可能
- `renderSystemTab()` や `calcRealDDPct()` のような複雑なロジックがTypeScript側の
  `InstrumentParamsRow` 等の型定義と完全に乖離している
- コード補完が効かないため、変数名・関数名のtypoが頻発しやすい

**現状の実装パターン:**
```typescript
// src/app.js.ts (現状)
export function getAppJs(): string {
  return `
    // 3,210行のJavaScriptがここに...
    function calcRealDDPct(data) { ... }
    function renderSystemTab(data) { ... }
  `;
}
```

### 解決方針

#### Option A（推奨・軽量）: 静的ファイル分離 + Cloudflare Workers Assets

```
src/
├── client/           ← 新設
│   ├── app.js        ← TypeScriptから独立した純粋なJS
│   └── style.css     ← 同上
└── index.ts          ← getAppJs()/getAppCss()の呼び出しを静的ファイル参照に変更
```

`wrangler.toml` に `[assets]` セクションを追加し、`/app.js` と `/style.css` を
Cloudflare CDNから直接配信する。Workers側は `Content-Type: text/javascript` の
動的生成が不要になる。

#### Option B（将来的・重量）: Vite + esbuild ビルドプロセス導入

- `src/client/` をViteで管理し、型安全なTypeScriptで書く
- `wrangler deploy` 前に `vite build` を実行し、`dist/` に静的アセットを生成
- Cloudflare Workers AssetsまたはPages経由で配信

**推奨**: まずOption Aで分離し、IDEサポートを得てから必要に応じてOption Bへ移行。

### 影響範囲
- `src/app.js.ts`, `src/style.css.ts`
- `src/index.ts`（HTMLレスポンスの `<script>` / `<link>` タグの参照変更）
- `wrangler.toml`（assets設定追加）

### 完了条件
- [ ] `src/client/app.js` が独立したファイルとして存在し、VSCodeでJSとして認識される
- [ ] `src/client/style.css` が独立したファイルとして存在する
- [ ] `npm run deploy` 後、ブラウザでUIが正常に動作する
- [ ] `src/app.js.ts` と `src/style.css.ts` が削除（または空の転送ファイルに縮小）される

---

## Task 2: APIのファットペイロード化の解消

### 課題

`src/api.ts` の `getApiStatus()` (506行) が、**UIに必要な全データをD1から一括取得**し、
巨大な単一JSONとして `/api/status` で返却している。

**現在の `/api/status` が取得するデータ（抜粋）:**
```
- 全オープンポジション
- 直近500件のクローズポジション履歴
- 全決定履歴（decisions）
- システムログ（system_logs）
- ニュース（market_cache['latest_news']）
- AI分析結果（causal_summary, news_analysis）
- スパークライン用時系列データ
- 戦略マップ（strategyMap）
- パラメーター履歴（param_review_log）
- RRサマリー（market_cache['rr_summary']）
- スクリーナー結果
- 因果チェーン（causalSummary）
```

**リスク:**
- Cloudflare Workers の CPU時間制限（10ms/req on free → 50ms on paid）に接近
- D1の読み取りユニット消費が1リクエストで極大化（全タブ分を毎回取得）
- タブを1つも開いていないデータも常にフェッチされる

### 解決方針

**エンドポイント分割 + Lazy Load戦略:**

```
現状:                          目標:
GET /api/status                GET /api/status       ← コアのみ（<50ms）
  └─ 全データ (~2-5秒)          GET /api/history      ← 履歴タブ開時に呼ぶ
                                GET /api/news         ← ニュースタブ開時
                                GET /api/analysis     ← AI分析タブ開時
                                GET /api/params       ← 既存（変更不要）
```

**`/api/status` (軽量版) が返すコアデータ:**
```typescript
interface CoreStatusResponse {
  balance: number;           // 現在残高
  openPositions: Position[]; // OPENポジション（件数は通常10件以下）
  todayPnl: number;
  todayWins: number;
  todayLosses: number;
  weekendStatus: WeekendStatus;
  systemHealth: { uptime: number; errorRate: number; ddPct: number };
  latestDecision: LatestDecision; // 最新1件のみ
}
```

**フロントエンド側の対応（`app.js.ts` / `src/client/app.js`）:**
```javascript
// タブ切り替えイベントで遅延フェッチ
async function switchTab(tab) {
  if (tab === 'history' && !historyLoaded) {
    const data = await fetch('/api/history').then(r => r.json());
    renderHistoryTab(data);
    historyLoaded = true;
  }
}
```

### 影響範囲
- `src/api.ts`（`getApiStatus` を分割・軽量化）
- `src/app.js.ts`（フロントエンドのフェッチ戦略変更）
- `src/index.ts`（新エンドポイントのルーティング追加）

### 完了条件
- [ ] `/api/status` のレスポンスタイムが 200ms 以下になる
- [ ] 履歴タブを開かない場合、fulfillment履歴がフェッチされない（Network Tabで確認）
- [ ] 全タブが正常に表示される

---

## Task 3: God Object (`index.ts`) の解体

### 課題

`src/index.ts` (2,530行) に以下が混在し、責務の境界が消失している:

```
src/index.ts
├── APIキー管理 (getCacheValue/setCacheValue経由のサーキットブレーカー)
├── cronルーティング (scheduled handler, fetch handler)
├── runCore (291行) — 価格取得・TP/SL・Logic取引・週末処理
├── runAnalysis (468行) — Path B・Breakout・SPRT・ParamReview・AutoApproval
├── runDailyTasks (100行程度)
├── updateInstrumentScores (150行程度)
├── runDailyScoring (90行程度)
├── runWeeklyScreening (80行程度)
├── runDailyAll (20行程度)
├── generateAiReport (100行程度)
└── 15個前後のヘルパー関数
```

**弊害:**
- `runAnalysis` (468行) が `runPathB`, `runBreakout`, `runSPRT`, `runParamReview`,
  `autoApprovePositions` を直接呼び出しており、エラーの伝播が複雑
- `runCore` と `runAnalysis` の間の `market_cache` バケツリレー（Task 4参照）が
  この構造から生まれている
- 新しい分析フロー（例: T023 Workers AIセンチメント）を追加するたびに
  `runAnalysis` がさらに肥大化する

### 解決方針

**レイヤー分離:**

```
src/
├── index.ts          ← cronハンドラー + fetchハンドラーのみ（~100行に縮小）
├── workflows/        ← 新設：業務フローのオーケストレーター
│   ├── core-workflow.ts       (現runCoreの本体)
│   ├── analysis-workflow.ts   (現runAnalysisの本体)
│   ├── daily-workflow.ts      (現runDailyTasks + runDailyAll)
│   └── scoring-workflow.ts    (現updateInstrumentScores + runDailyScoring)
├── services/         ← 新設：個別の業務ロジック（現在index.ts内の関数）
│   ├── circuit-breaker.ts     (cbRecord系)
│   ├── api-key-manager.ts     (getApiKey/getAllApiKeys/markKeyCooldown)
│   └── run-id.ts              (withRunId/getRunId)
└── (既存ファイル群)
```

**目標後の `index.ts` イメージ:**
```typescript
export default {
  async scheduled(event, env, ctx) {
    const minute = new Date().getMinutes();
    ctx.waitUntil(runCoreWorkflow(env));
    if (minute % 5 === 0) ctx.waitUntil(runAnalysisWorkflow(env));
    if (minute === 0) ctx.waitUntil(runDailyWorkflow(env));
  },
  async fetch(request, env, ctx) {
    // ルーティングのみ
  }
};
```

### 実装戦略
- **段階的リファクタリング**: 一度に全部移動せず、1 Taskファイル = 1 PRで進める
- 移動時は関数シグネチャを変えず、`index.ts` から `import` する形で接続を保つ
- 週末制約（`CLAUDE.md` §週末市場クローズ制約）の引き継ぎを必ず確認する（大規模改修チェックリスト参照）

### 影響範囲
- `src/index.ts`（大幅縮小）
- `src/workflows/` (新設)
- `src/services/` (新設)

### 完了条件
- [ ] `src/index.ts` が 200行以下になる
- [ ] `npm test` が全パス
- [ ] `npm run deploy` 後、全cronが正常動作する
- [ ] 週末制約（`cryptoOnlyMode`）が `core-workflow.ts` に正しく引き継がれている

---

## Task 4: DBキャッシュを介した暗黙の状態リレーの解消

### 課題

`runCore`（毎分）が取得した市場データを `market_cache` の `core_shared_data` キーに保存し、
`runAnalysis`（5分ごと）がそれを読み出してAIに渡している。

**コード上の証拠:**
```typescript
// src/index.ts:1317 — runCore の末尾
await setCacheValue(env.DB, 'core_shared_data', JSON.stringify(coreData));

// src/index.ts:1349 — runAnalysis の冒頭
const coreRaw = await getCacheValue(env.DB, 'core_shared_data');
if (!coreRaw) {
  console.warn('[fx-sim] analysis: core_shared_data なし → スキップ');
  return; // ← AIが動かない
}
```

**Race Conditionのシナリオ:**

```
時刻      runCore (毎分)          runAnalysis (5分ごと)
T+0:00    市場データ取得開始
T+0:08    core_shared_data保存     （まだ起動前）
T+5:00    市場データ取得開始       core_shared_data読み出し ← 4分52秒前のデータ
T+5:09    core_shared_data更新     ↓
          （古いデータでAI判断済み）
```

最大で**4分59秒前の市場データ**でAIがトレード判断を下す可能性がある。
ボラティリティが高い局面（例: 雇用統計直後）では致命的な誤エントリーに繋がりうる。

また、`core_shared_data` の欠如（cronの実行順序の入れ替わりや再試行）で
`runAnalysis` が全スキップされるサイレント障害が発生している可能性がある。

### 解決方針

**「1トランザクション内でデータ取得→判断→実行」を原則とする:**

#### 短期対応（推奨・即着手可能）

`runAnalysis` の冒頭で `core_shared_data` を読むのではなく、
`runAnalysis` 自身が必要なデータを直接取得する:

```typescript
// 変更前
async function runAnalysis(env: Env) {
  const coreData = JSON.parse(await getCacheValue(env.DB, 'core_shared_data'));
  ...
}

// 変更後
async function runAnalysis(env: Env) {
  // runAnalysis が必要なデータを自律的に取得（runCoreへの依存を排除）
  const [news, indicators, prices] = await Promise.all([
    fetchNewsWithCache(env.DB),           // market_cache['latest_news']利用
    fetchIndicatorsWithCache(env.DB),     // market_cache['indicators']利用
    fetchPricesForAnalysis(env.DB, env),  // 現在レートを直接取得
  ]);
  ...
}
```

市場データ（ニュース・指標）は本来的にキャッシュを持つ（ニュースは15分、指標は1時間程度で変化）
ため、`runAnalysis` が個別キャッシュを読む設計は合理的。問題は「runCoreに依存した
1つの巨大キャッシュキー」であり、個別キーに分解することでRace Conditionを解消できる。

#### 中期対応（Task 3完了後）

`analysis-workflow.ts` が独立したデータフェッチを持つため、
`core_shared_data` キー自体を廃止する。

### 影響範囲
- `src/index.ts`（`runAnalysis` のデータ取得部分）
- `src/db.ts`（個別キャッシュ取得ヘルパーの追加）

### 完了条件
- [ ] `core_shared_data` キーへの依存が `runAnalysis` から削除される
- [ ] `runAnalysis` が `core_shared_data` なしでも正常に実行される
- [ ] 5分ごとのcronログに `core_shared_data なし → スキップ` が出なくなる
- [ ] `npm test` が全パス

---

## ロードマップ

```
Phase 1 (1-2週): リスク排除
  └── Task 4: Race Condition解消
        ├── 変更量: 小（runAnalysisのデータ取得部分のみ）
        ├── テスト容易性: 高（ユニットテストで検証可能）
        └── 効果: 実弾運用時の誤トレードリスクを直接排除

Phase 2 (2-4週): 構造改善
  └── Task 3: index.ts分解
        ├── 変更量: 中（ファイル分割・移動がメイン）
        ├── テスト容易性: 中（動作変化なし・npm testで確認）
        └── 効果: 以降のすべての機能追加コストを下げる基盤を作る

Phase 3 (4-6週): パフォーマンス改善
  └── Task 2: APIファットペイロード解消
        ├── 変更量: 中-大（エンドポイント追加 + フロントエンド変更）
        ├── テスト容易性: 中（E2Eチェックが必要）
        └── 効果: D1読み取りコスト削減・APIレスポンスタイム改善

Phase 4 (6-8週以降): 開発体験改善
  └── Task 1: フロントエンド分離
        ├── 変更量: 大（3,200行のリライトに相当）
        ├── テスト容易性: 低（UIの目視確認が中心）
        └── 効果: 長期的な保守性向上（即時の稼働改善には直結しない）
```

### なぜこの順番か

1. **Task 4を最初に**: Race Conditionは**実弾運用時に金銭的損失に直結する唯一のバグ**。
   変更量が最小でリスクが最大のため、最優先で潰す。

2. **Task 3を2番目に**: `index.ts` を整理しないとTask 2・Task 4の修正が入り組み、
   「どこに書くべきか」が不明瞭になる。構造改善は他のリファクタリングの前提条件。

3. **Task 2を3番目に**: Task 3の完了でAPI層の責務が明確になってから実施する。
   Task 3前にエンドポイントを追加すると、さらにindex.tsが肥大化する。

4. **Task 1を最後に**: 機能の正確性・安全性に直接影響しない。
   開発体験の改善は重要だが、上位3つのTaskが完了して安定してから着手する。

---

## 関連ファイル・参考

- `CLAUDE.md` §大規模改修チェックリスト — Task 3実施時に必須参照
- `CLAUDE.md` §週末市場クローズ制約 — `runAnalysis` 移動時に引き継ぎ必須
- `tasks/20260320_T002_システム改修.md` — 既存技術的負債タスク（T004-22等と整合させること）
- `docs/03_DB設計書.md` — `market_cache` テーブルの全キー一覧

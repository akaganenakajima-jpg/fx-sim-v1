# AI銘柄マネージャー設計書

> テスタ初期スタイルの需給重視スコアリングによる動的銘柄入替えシステム

**作成日**: 2026-03-29
**ステータス**: 設計承認済み・実装前

---

## 1. 背景と目的

fx-simは43銘柄を運用する仮想トレードシステム。現在の課題:

- 銘柄選定が手動固定（instruments.ts にハードコード）
- AI判断がニュース+テクニカルのみ。ファンダメンタルズ情報がゼロ
- TP設定がATR基準の機械的設定のみで、理論株価との乖離を考慮していない
- ニュースフィルタが保有状態を考慮していない

**解決策**: J-Quants API（JPX公式）でファンダメンタルデータを取得し、テスタ初期スタイルの需給重視スコアリングで銘柄を動的に入替える。同時にAI判断・TP設定・ニュースフィルタにもファンダデータを統合する。

**月額コスト**: J-Quants Standard ¥3,300/月

---

## 2. テスタ初期スタイルの設計根拠

本設計はテスタ（累計利益100億円超の個人トレーダー）の初期スキャルピング時代の手法を銘柄選定ロジックに翻訳したもの。全ての設計判断にテスタ本人の一次ソースを付記する。

| 原則 | テスタ本人の発言 | ソース | 本設計での実装 |
|---|---|---|---|
| 小型・高ボラ集中 | 「時価総額100億円台前半」「ボラが大きい」「出来高が急増している」 | [ZUU online](https://zuuonline.com/archives/209968) | 需給熱スコア50%（出来高変化率+値幅変化率） |
| 1銘柄追跡 | 「一つの銘柄を長く追っていると、クセや傾向が見えてくる」 | [楽天証券トウシル中編](https://media.rakuten-sec.net/articles/-/34085) | 追跡リスト7日ロック |
| ファンダ軽視 | 銘柄選定でPER・配当等を基準にした一次ソース発言は不在 | （不在の確認） | ファンダは地雷フィルタ（20%補正のみ） |
| 板・出来高・変化が命 | 「見るべきは価格ではなく変化」「板の出現タイミングが重要」 | [note.com書起こし](https://note.com/takurot/n/n634612686f9e) | 出来高変化率40%+出来高加速度20% |
| 負けない＞勝つ | 「勝ち方ではなく"どうしたら負けないで済むか"を毎日ひたすら考えてきた」 | [楽天証券トウシル前編](https://media.rakuten-sec.net/articles/-/34084) | 地雷除外+決算前利確+SL不変+ネガティブ昇格 |
| 止まったら利確 | 「止まったら利確が基本原則」「動いた分だけ取る」 | [sannji.com](https://sannji.com/supply-and-demand-testa/) | 需給熱低下→降格候補（動きが止まった銘柄を外す） |
| 勝率6割で十分 | 「勝率5割でも利益を残すのが理想」 | [MONEY PLUS](https://media.moneyforward.com/articles/3960/summary) | RR≥1.0定義との整合（勝率より期待値重視） |

---

## 3. データ取得層

### 3.1 データソース

| ソース | 用途 | 頻度 | コスト |
|---|---|---|---|
| J-Quants Standard（V2 API） | EPS/BPS/業績予想/配当/決算日 | 日次+週次 | 月3,300円 |
| Yahoo Finance（既存） | リアルタイム株価/PER/PBR/時価総額/出来高 | 既存1分cron | 無料 |
| 既存ニュース15ソース | 銘柄別ニュース話題量の集計 | 既存1分cron | 無料 |

### 3.2 J-Quants V2 API

- **認証方式**: 実装前に `j-quants-doc-mcp` で最新認証フローを確認すること。V1ではリフレッシュトークン→IDトークンの2段階認証。V2で簡略化された可能性があるが未確認。リフレッシュトークン方式の場合、IDトークンの有効期限管理（`market_cache` テーブルでキャッシュ）が必要。
- **APIキー/トークン**: `wrangler secret put JQUANTS_API_KEY` で設定（リフレッシュトークンの場合は `JQUANTS_REFRESH_TOKEN`）
- **CSV一括取得**: V2で対応済み
- **MCP公式サーバー**: `j-quants-doc-mcp` — 実装時のAPI仕様確認に活用（認証フロー・エンドポイント・レスポンス形式の正確な確認）
- **主要エンドポイント**:
  - `/fins/statements` — 財務諸表（EPS/BPS/売上/利益/予想）
  - `/fins/announcement` — 決算発表予定日
- **エラーハンドリング**: J-Quants API障害時は直前の `fundamentals` テーブルデータをそのまま使用。ただし `updated_at` が7日以上古い場合はファンダ軸を無効化（需給熱+モメンタムの2軸のみでスコアリング）

### 3.3 新テーブル: `fundamentals`

最新の財務データを保持。UPSERT（INSERT OR REPLACE）で更新。

```sql
CREATE TABLE IF NOT EXISTS fundamentals (
  symbol        TEXT NOT NULL,           -- '7203.T'
  fiscal_year   TEXT NOT NULL,           -- '2026' 決算年度
  fiscal_quarter TEXT NOT NULL,          -- 'Q1'/'Q2'/'Q3'/'FY'
  eps           REAL,                    -- 1株当たり利益
  bps           REAL,                    -- 1株当たり純資産
  revenue       REAL,                    -- 売上高（百万円）
  op_profit     REAL,                    -- 営業利益（百万円）
  net_profit    REAL,                    -- 当期純利益（百万円）
  forecast_rev  REAL,                    -- 会社予想売上高
  forecast_op   REAL,                    -- 会社予想営業利益
  forecast_net  REAL,                    -- 会社予想純利益
  dividend      REAL,                    -- 年間配当
  equity_ratio  REAL,                    -- 自己資本比率
  next_earnings TEXT,                    -- 次回決算発表日
  sector        TEXT,                    -- 業種（J-Quantsの33業種分類）
  market_cap    REAL,                    -- 時価総額
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (symbol, fiscal_year, fiscal_quarter)
);

-- 2期連続赤字判定用: 同一symbolの直近2レコードのnet_profitを参照
CREATE INDEX idx_fundamentals_symbol_period ON fundamentals(symbol, fiscal_year DESC, fiscal_quarter DESC);
```

**注意**: 「2期連続赤字」判定（セクション4.4）のために、最低2期分のデータを保持する。古いデータ（3期以上前）は週次cronで自動削除。

---

## 4. テスタ式スコアリングエンジン

### 4.1 3軸スコアリング

```
総合スコア = 需給熱(0-100)×0.50 + モメンタム(0-100)×0.30 + ファンダフィルタ(0-100)×0.20
```

### 4.2 軸1: 需給熱スコア（0-100）— 最重要

| 要素 | 重み | 算出方法 |
|---|---|---|
| 出来高変化率 | 40% | 5日平均出来高 / 20日平均出来高 |
| 出来高加速度 | 20% | 昨日の変化率 vs 一昨日の変化率 |
| 値幅変化率 | 25% | 当日の高値-安値幅 / 20日平均値幅 |
| ニュース言及急増 | 15% | 過去3日 vs 過去14日のニュース件数比 |

### 4.3 軸2: モメンタムスコア（0-100）

| 要素 | 重み | 算出方法 |
|---|---|---|
| 方向明確度 | 40% | \|RSI - 50\| / 50 |
| トレンド強度 | 30% | ADX値（25以上でトレンド有り） |
| 価格位置 | 30% | 52週レンジ内の位置 |

### 4.4 軸3: ファンダフィルタ（Pass/Fail + 補正）

**強制除外（スコア0）:**
- 債務超過（自己資本比率 < 0）
- 2期連続赤字
- 上場廃止基準抵触（時価総額10億未満が継続）
- 次回決算発表が3日以内

**Pass後の補正（0-100、基礎点50から加減算）:**
- 業績上方修正中: +20点 / 下方修正中: -20点
- PER同業種比割安: +15点 / 割高: -10点
- 配当利回り3%超: +10点 / 無配: -5点
- 自己資本比率50%超: +5点 / 20%未満: -10点

スコア範囲: 5〜100（下限クランプ5、Passした以上は最低5点）

### 4.5 銘柄管理: 2層構造

**追跡リスト（最大15銘柄）:**
- **7日ロック**: `active_instruments.added_at` を起算日とし、追加後7日間は降格判定をスキップ
- **昇格条件**: 候補リスト50銘柄中のスコアTop20に3日連続ランクイン かつ 需給熱≥60
- **降格条件**: ロック期間終了後、直近ローリング7日間のうち需給熱≤20が5日以上 → 候補リストに戻す

**候補リスト（最大50銘柄）:**
- 週次フルスクリーニングで更新
- 時価総額フィルタ: 50億〜5000億円

**動的入替え対象**: 日本株のみ。FX・コモディティ・株式指数・米株は引き続き `instruments.ts` のハードコード定義を使用（将来的に米株も対象にする余地あり）。

### 4.6 スコアリングの入力データソース

| データ | 取得元 | 取得方法 |
|---|---|---|
| 5日/20日平均出来高 | Yahoo Finance chart API | 既存 `candles.ts` の `fetchCandlesYahoo()` から日足出来高を取得 |
| 出来高加速度 | `stock_scores` テーブル | 前日・前々日のスコアから差分計算（日次蓄積） |
| 20日平均値幅 | Yahoo Finance chart API | 日足のhigh-lowから算出 |
| RSI / ADX | 既存 `logic-indicators.ts` | `getStockIndicatorsWithCache()` で日本株対応済み |
| 52週レンジ | Yahoo Finance chart API | `range=1y` で取得し、min/maxを算出 |
| ニュース言及数 | `news_raw` テーブル | `title_ja` / `desc_ja` に銘柄名を含む記事をCOUNT |

### 4.7 新テーブル: `stock_scores`

```sql
CREATE TABLE IF NOT EXISTS stock_scores (
  symbol         TEXT NOT NULL,
  scored_at      TEXT NOT NULL,          -- 日付のみ 'YYYY-MM-DD'（日次1レコード）
  theme_score    REAL NOT NULL,          -- 需給熱 0-100
  funda_score    REAL NOT NULL,          -- ファンダ補正 0-100
  momentum_score REAL NOT NULL,          -- モメンタム 0-100
  total_score    REAL NOT NULL,          -- 重み付き合計
  rank           INTEGER NOT NULL,       -- 当日順位
  in_universe    INTEGER DEFAULT 0,      -- 1=現在の取引対象
  PRIMARY KEY (symbol, scored_at)
);

CREATE INDEX idx_stock_scores_date_rank ON stock_scores(scored_at, rank);
CREATE INDEX idx_stock_scores_symbol_date ON stock_scores(symbol, scored_at DESC);
```

**注意**: `scored_at` は日付のみ（`YYYY-MM-DD`）。同日に複数回スコアリングした場合はUPSERTで上書き。昇格判定（3日連続Top20）は `scored_at` を日付でGROUP BYして検索。

---

## 5. AI判断プロンプト統合

### 5.1 ファンダ参考情報の注入

株式銘柄のみ、Gemini newsStage1プロンプトに以下を注入:

```
=== ファンダメンタル参考情報（判断の主因にしないこと）===
PER: {per}倍（業種平均{sector_avg_per}倍）→ {割安/適正/割高}
業績予想: 営業利益 前年比{forecast_change}%（{上方修正/据置/下方修正}）
次回決算: {days_to_earnings}日後
需給熱スコア: {theme_score}/100（出来高変化率{vol_change}%）
ファンダ判定: {PASS / 地雷警告: {理由}}
```

### 5.2 注入ルール

| 条件 | 動作 |
|---|---|
| FX・コモディティ・指数 | ファンダ情報なし（今まで通り） |
| 日本株・米株 | ファンダ参考情報を注入 |
| テーマ株グループ | `【ファンダより需給を優先せよ】`を明記 |
| 決算3日以内 | `【決算直前: 新規エントリー非推奨】`を明記 |
| ファンダFail（地雷） | `【地雷警告: {理由}。エントリー禁止。】`を明記 |

### 5.3 Gemini応答フィールド追加

`funda_context`: `"used"` | `"ignored"` | `"blocked"` — 振り返りフェーズでの集計用

---

## 6. TP設定根拠強化

### 6.1 TP補正ロジック

**適用タイミング**: Gemini AIがTP/SLを提案した**後**の後処理（`src/sanity.ts` の既存サニティチェックと同じ層）。プロンプトには含めない（AIの判断を汚染しないため）。

```
理論株価 = EPS × 業種平均PER
乖離率 = (理論株価 - 現在株価) / 現在株価

if 乖離率 > +15%（割安）: TP multiplier ×1.2（上値余地あり）
if 乖離率 < -10%（割高）: TP multiplier ×0.8（天井が近い）
if テーマ株: 補正無効化（モメンタム優先）
if ファンダデータ7日以上古い: 補正無効化
```

**既存 `src/sanity.ts` との統合**: TP補正は `clampTpSl()` 関数の直前に適用し、補正後の値がsanity範囲を超えた場合はclampで切られる（安全側に倒す）。

### 6.2 SLは変更なし

SLはATR基準を維持。ファンダでSLを緩めるのは「負けない」原則に反する。

### 6.3 決算前利確

次回決算まで3日以内 + オープンポジションあり:
- 含み益 → 利確推奨シグナル
- 含み損 → SLタイトニング（建値に近づける）

---

## 7. ニュースフィルタバイアス

### 7.1 composite閾値の動的制御

Haikuプロンプトは変更しない（中立な品質評価を維持）。閾値側で保有状態バイアスを制御。

| 銘柄の状態 | composite閾値 | 最大取得件数 | 注目フラグ(attention) |
|---|---|---|---|
| OPEN保有中 | 4.0（緩和） | 10件（増量） | 自動ON |
| 追跡リスト | 5.0（やや緩） | 7件（やや増） | 自動ON |
| 候補リスト | 6.0（通常） | 5件（通常） | 通常判定 |
| リスト外 | 7.0（厳格） | 3件（絞る） | 通常判定 |

### 7.2 ネガティブニュース昇格

保有中銘柄のネガティブニュースはimpact_level +1段階:
- 通常C → B扱いに昇格
- 通常B + ネガティブ → 利確/SLタイトニング検討シグナル

### 7.3 注目フラグ事前バイアス

newsStage1プロンプトに保有中・追跡中銘柄を「注目優先銘柄」として注入。

### 7.4 過集中防止

保有銘柄ニュース占有率70%上限、新規機会枠30%確保。

### 7.5 B2追加情報

保有状態・含み損益・保有期間をnewsStage2に注入。

### 7.6 composite計算の微修正

個別株ニュースの場合、breadth重みを0%に無効化しrelevanceに再配分:

```typescript
function computeComposite(t, u, r, c, s, b, n, isStockSpecific: boolean): number {
  if (isStockSpecific) {
    return t*0.20 + u*0.15 + r*0.35 + c*0.15 + s*0.10 + n*0.05;
  }
  return t*0.20 + u*0.15 + r*0.30 + c*0.15 + s*0.10 + b*0.05 + n*0.05;
}
```

---

## 8. ダッシュボード・拒否権UI

### 8.1 統合方針

新タブは追加しない。既存タブに自然に溶け込ませる。

### 8.2 Tab 1「今」への追加

**入替え通知バナー（Hero下）:**
- IN/OUT銘柄とスコア表示
- 24時間カウントダウンタイマー
- 承認/拒否ボタン
- タイムアウトで自動承認

**追跡リスト表示（ポジション一覧の下）:**
- 15銘柄のスコアバー（緑≥200、黄≥150、赤<150）
- 降格候補は⚠マーク + 赤ハイライト

### 8.3 Tab 3「学び」への追加

**入替え履歴テーブル:**
- IN/OUT銘柄、判定方法（手動承認/自動承認/拒否）、入替え後7日PnL
- 拒否した場合の仮想PnL表示（反実仮想）

### 8.4 拒否権ルール

- 24時間タイマー → タイムアウトで自動承認
- 拒否した銘柄は7日間再提案ブロック

### 8.5 新テーブル: `rotation_log`

```sql
CREATE TABLE IF NOT EXISTS rotation_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  proposed_at    TEXT NOT NULL,
  in_symbol      TEXT NOT NULL,
  in_score       REAL NOT NULL,
  out_symbol     TEXT NOT NULL,
  out_score      REAL NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/APPROVED/REJECTED/AUTO_APPROVED
  decided_at     TEXT,
  decided_by     TEXT,                             -- 'user' | 'timer'
  in_result_pnl  REAL,                             -- IN銘柄の7日間リターン（%）
  out_result_pnl REAL                              -- OUT銘柄の7日間仮想リターン（%、拒否時も記録）
);
```

**`in_result_pnl`**: 入替えで追加された銘柄の、承認日から7日間の株価リターン（%）。
**`out_result_pnl`**: 入替えで除外された銘柄の、同期間の仮想リターン（%）。拒否された場合も記録し、「もし入替えていたら」の比較に使用。

### 8.6 APIエンドポイント

- `POST /api/rotation` — 承認/拒否（body: `{ id, action: 'approve'|'reject' }`）
- `GET /api/rotation/pending` — 未決定の入替え提案一覧
- `GET /api/scores` — 追跡+候補リストのスコア一覧

---

## 9. cronスケジュールとデータフロー

### 9.1 新規cronトリガー

| cron | cron式 | 内容 | 想定wall time | 想定CPU time |
|---|---|---|---|---|
| 日次スコアリング | `0 21 * * *`（UTC 21:00 = JST 6:00） | J-Quants財務取得+3軸スコア+入替え判定 | ~30秒 | ~5秒 |
| 週次フルスクリーニング① | `0 18 * * 6`（UTC 土曜18:00 = JST 日曜3:00） | 全上場銘柄の財務サマリ取得（500銘柄ずつバッチ） | ~60秒 | ~10秒 |
| 週次フルスクリーニング② | `5 18 * * 6`（5分後） | バッチ結果から候補50銘柄再構成 | ~10秒 | ~3秒 |
| 自動承認チェック | `0 * * * *`（毎時0分） | 24h経過PENDING→AUTO_APPROVED | <1秒 | <1秒 |
| 結果PnL記録 | `0 14 * * *`（UTC 14:00 = JST 23:00） | 入替え7日後PnL自動記入 | <1秒 | <1秒 |

**Cloudflare Workers Unbound mode**: 有料プラン契約済みのため、CPU時間上限は30秒/呼び出し。wall timeとCPU timeは区別が必要（fetch()の待ち時間はCPU timeに含まれない）。

**週次スクリーニングの分割戦略**: 全3,800社を1回で処理するとCPU制限超過のリスクがあるため、2段階に分割。①で`fundamentals`テーブルにバッチ保存し、②で集約・スコアリング・候補リスト更新を行う。

### 9.2 cron分岐ロジック

現在の `src/index.ts` の `scheduled()` ハンドラは `event.cron` プロパティでトリガー元を判定できる。

```typescript
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  const cron = event.cron;
  switch (cron) {
    case '* * * * *':        // 既存の毎分cron
      return ctx.waitUntil(run(env));
    case '0 21 * * *':       // 日次スコアリング
      return ctx.waitUntil(runDailyScoring(env));
    case '0 18 * * 6':       // 週次スクリーニング①
      return ctx.waitUntil(runWeeklyScreeningBatch(env));
    case '5 18 * * 6':       // 週次スクリーニング②
      return ctx.waitUntil(runWeeklyScreeningFinalize(env));
    case '0 * * * *':        // 自動承認チェック
      return ctx.waitUntil(runAutoApproval(env));
    case '0 14 * * *':       // 結果PnL記録
      return ctx.waitUntil(runResultPnl(env));
  }
}
```

**注意**: `wrangler.toml` の `crons` 配列に全cron式を列挙する必要がある。

### 9.2 instruments.tsのランタイム化

#### 新テーブル: `active_instruments`

`InstrumentConfig` インターフェースの全フィールドをJSON化して保存する方式。個別カラムに分解するとフィールド追加のたびにマイグレーションが必要になるため、`config_json` に全設定を格納する。

```sql
CREATE TABLE IF NOT EXISTS active_instruments (
  pair           TEXT PRIMARY KEY,       -- 'LeserTech(6920.T)' — InstrumentConfig.pair と一致
  config_json    TEXT NOT NULL,          -- InstrumentConfig を JSON.stringify() した値
  added_at       TEXT NOT NULL,          -- 追跡リスト追加日時（7日ロックの起算日）
  source         TEXT DEFAULT 'auto',    -- 'auto'（スコアリングエンジン）| 'manual'（ユーザー手動）
  updated_at     TEXT NOT NULL
);
```

**読み込みロジック** (`src/instruments.ts` に `getActiveInstruments()` を追加):
1. D1の `active_instruments` からアセットクラス `stock` の日本株レコードを取得
2. `config_json` を `InstrumentConfig` にパース
3. 取得できなかった場合（テーブル空 or D1エラー）、`INSTRUMENTS` 配列のハードコード定義をフォールバック
4. FX・コモディティ・株式指数・米株は常に `INSTRUMENTS` 配列から取得（動的入替え対象外）

---

## 10. 修正対象ファイル

| ファイル | 変更内容 |
|---|---|
| `schema.sql` | 4テーブル追加（fundamentals, stock_scores, rotation_log, active_instruments） |
| `wrangler.toml` | cron追加（日次/週次/毎時）、JQUANTS_API_KEY環境変数 |
| `src/instruments.ts` | D1フォールバック対応の`getActiveInstruments()`追加 |
| `src/news.ts` | composite閾値の動的制御、`computeComposite()`にisStockSpecificパラメータ追加、注目フラグバイアス（呼び出し元2箇所: L696, L867も修正） |
| `src/gemini.ts` | ファンダ参考情報プロンプト注入、`funda_context`フィールド |
| `src/position.ts` | TP multiplier補正ロジック、決算前利確推奨 |
| `src/sanity.ts` | TP補正をclampTpSl()の直前に適用する統合ポイント |
| `src/logic-indicators.ts` | 日本株向けRSI/ADXデータ取得の確認・必要に応じた拡張 |
| `src/index.ts` | 新cron分岐（日次スコアリング/週次スクリーニング/毎時承認/PnL記録） |
| `src/dashboard.ts` | Tab1入替えバナー+追跡リスト、Tab3入替え履歴 |
| `src/api.ts` | `/api/rotation`, `/api/rotation/pending`, `/api/scores`エンドポイント |
| **新規** `src/jquants.ts` | J-Quants V2 API認証・データ取得（APIキー認証方式） |
| **新規** `src/scoring.ts` | 3軸スコアリングエンジン |
| **新規** `src/rotation.ts` | 銘柄入替え判定・承認・自動承認ロジック |

---

## 11. 関連ドキュメント更新

### 高優先（実装と同時に更新）

| ドキュメント | 更新内容 |
|---|---|
| `docs/03_DB設計書.md` | 4新テーブルのスキーマ定義追加、ER図更新、インデックス定義 |
| `docs/05_開発者仕様書.md` | 3新モジュール仕様追加、cronフロー図更新、3新APIエンドポイント仕様 |
| `docs/02_要件定義書.md` | FR-106〜111追加、FR-509〜511追加（Tab1/Tab3 UI変更） |
| `docs/06_デザイン_ブランドガイドライン.md` | Tab1/Tab3画面構成更新、スコアカード・ローテーションバッジのコンポーネント仕様 |

### 中優先（実装完了後に更新）

| ドキュメント | 更新内容 |
|---|---|
| `docs/04_IT管理台帳.md` | J-Quants API追加、環境変数追加、3新ファイル追加、監視アラート追加 |
| `docs/01_RFP_要求定義書.md` | BR-08〜11、TR-07〜10、成功基準にローテーション精度KPI |
| `docs/instrument_params_reference.md` | J-Quantsファンダの影響範囲追記 |
| `CLAUDE.md`（プロジェクトルート） | ディレクトリ構成に3新ファイル追加、D1スキーマに4新テーブル参照追加 |

### 要確認（既存との整合性チェック）

| ドキュメント | 確認内容 |
|---|---|
| `docs/superpowers/specs/2026-03-22-testa-strategy-integration-proposal.md` | 既存テスタ施策との重複・競合確認。ローテーション精度KPI追加 |

---

## 12. 検証方法

### ユニットテスト
- `scoring.ts`: 各軸スコア計算の境界値テスト（出来高0、RSI=50、ファンダFail条件）
- `rotation.ts`: 昇格/降格条件、7日ロック、拒否ブロック
- `news.ts`: composite閾値の動的制御が銘柄状態で正しく切り替わるか
- `gemini.ts`: ファンダ注入がFX銘柄に混入しないこと

### 統合テスト
- `wrangler dev` でローカル実行 → 日次スコアリングcronを手動トリガー → fundamentals/stock_scores/rotation_logにデータが入るか
- ダッシュボードで入替えバナー表示 → 承認/拒否 → active_instruments更新確認

### E2Eテスト（本番デプロイ後）
- Chrome DevTools MCPで本番URL確認
- Tab1: 入替えバナー表示・承認/拒否動作
- Tab1: 追跡リスト表示・スコアバー色分け
- Tab3: 入替え履歴テーブル
- モバイルプレビュー（375x812）で表示崩れないか
- J-Quants APIの応答遅延・エラー時のフォールバック動作

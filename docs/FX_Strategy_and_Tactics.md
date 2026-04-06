# FX_Strategy_and_Tactics.md — クオンツ戦略・AIロジック仕様書

> **対象システム**: fx-sim-v1（Cloudflare Workers + D1）
> **更新日**: 2026-04-06
> **真実の源泉**: 本文書はコード（`src/`）から直接読み取った実装を記述する。
> 設計思想が変わった場合は必ず本文書を更新すること。

---

## 目次

1. [システム全体のトレード哲学](#1-システム全体のトレード哲学)
2. [マルチストラテジー・ポートフォリオ](#2-マルチストラテジーポートフォリオ)
3. [戦略① 平均回帰（Mean Reversion）](#3-戦略-平均回帰mean-reversion)
4. [戦略② SMA BB Breakout（順張り）](#4-戦略-sma-bb-breakout順張り)
5. [ER によるダイナミック・ルーティングの神髄](#5-er-によるダイナミックルーティングの神髄)
6. [重みつきエントリースコアリング（Ph.7）](#6-重みつきエントリースコアリングph7)
7. [AI（Gemini）とニュースロジック](#7-aigeminniとニュースロジック)
8. [リスク管理レイヤー](#8-リスク管理レイヤー)
9. [戦略パフォーマンスの評価・分類定義](#9-戦略パフォーマンスの評価分類定義)
10. [パラメーター一覧と設計原則](#10-パラメーター一覧と設計原則)

---

## 1. システム全体のトレード哲学

### 1.1 勝率の公式定義（変更禁止）

本システムにおける「勝ち」は **実現 RR ≥ 1.0** と定義する。

```
勝ち   = 実現RR ≥ 1.0（リスクと同等以上のリターンを獲得した取引）
負け   = 実現RR < 1.0
実現RR = 実現利益 / 初期リスク（エントリー時のSL距離）
  BUY : (close_rate - entry_rate) / (entry_rate - sl_rate)
  SELL: (entry_rate - close_rate) / (sl_rate - entry_rate)
```

- `pnl > 0` を勝ちの判定に使うことは禁止（旧定義）
- `RR_DEFINITION_PROMPT` が全 AI プロンプトの先頭にハードコードされている（`src/gemini.ts`）

### 1.2 期待値中心設計

> `勝率 × avgRR - 敗率 ≥ 0` が全戦略の共通ハードル

- **勝率35%でも EV 正** となるのは `avgRR ≥ 1.86` のとき
- ダッシュボードの緑表示は勝率 **35% 以上**（`WIN_RATE_GREEN`定数）
- RR ≥ 2.0 が目標値（全 AI プロンプトで RR 2.0 以上を要求）

### 1.3 Cloudflare Workers の制約と設計への影響

| 制約 | 値 | 設計への影響 |
|---|---|---|
| AI API タイムアウト | **15秒** (`AI_TIMEOUT_MS`) | 複雑な Chain-of-Thought を避けシンプル JSON 出力に特化 |
| cron 最短間隔 | 1分 | Cron × 毎分実行 + 5分間隔の2層構成 |
| Workers 実行時間 | Paid: CPU 30秒 | タイムアウト設計の余裕を確保 |
| D1 容量 | 自動パージで維持 | `daily-workflow.ts` が毎日 UTC15:00 に掃除 |

---

## 2. マルチストラテジー・ポートフォリオ

### 2.1 戦略の構成

```
fx-sim-v1 の戦略ポートフォリオ（2026-04-06 時点）
├── ロジックエンジン（Cron 毎分・`logic-trading.ts`）
│   ├── 戦略① 平均回帰（Mean Reversion）― RSI 逆張り
│   └── 戦略② SMA BB Breakout ― BBスクイーズ後の順張りブレイクアウト（Ph.10）
│
└── AI エンジン（Cron 5分毎・`analysis-workflow.ts`）
    └── Gemini 2.5 Flash による Path B ニューストリガー
```

### 2.2 戦略の棲み分け

| 項目 | 平均回帰 | BB Breakout | AI ニューストリガー |
|---|---|---|---|
| 実装ファイル | `logic-indicators.ts` | `logic-indicators.ts` | `gemini.ts` / `news-trigger.ts` |
| エントリー根拠 | RSI 売られすぎ/買われすぎ | BBスクイーズ後の±2σ突破 | ニューススコア ≥ 閾値 |
| 方向性 | 逆張り（相場が戻ると予測） | 順張り（ブレイクアウト継続） | ニュース依存 |
| ER の扱い | **低い方が好ましい**（レンジ相場） | **高い方が好ましい**（強トレンド） | ER 非参照 |
| TP/SL 設定 | ATR × 倍率（レート側と反対） | ATR × 倍率（レート側と同方向） | Gemini が指定 |
| `trigger` 値 | `'LOGIC'` | `'LOGIC'` | `'NEWS'` |
| `isBBBreakout` | `false`（設定なし） | **`true`** | 該当なし |

---

## 3. 戦略① 平均回帰（Mean Reversion）

### 3.1 エントリー条件

```
BUY  条件: RSI < rsi_oversold（売られすぎ）
SELL 条件: RSI > rsi_overbought（買われすぎ）
```

デフォルトパラメーター例: `rsi_oversold=30, rsi_overbought=70`

### 3.2 MACD フィルター（Ph.10b）

RSI 条件を満たしても MACD ヒストグラムが逆方向に拡大していれば NEUTRAL を返す（`logic-indicators.ts`）。

```typescript
// BUY シグナルの場合
if (macdData && macdData.histogram < macdData.prevHistogram) {
  return NEUTRAL;  // 下方向に力が強い → RSI だけでは買えない
}
```

`macd_histogram_trend = 0` でフィルターを無効化できる（銘柄ごとに設定）。

### 3.3 TP/SL 計算

```
TP_BUY  = entry + ATR × atr_tp_multiplier
SL_BUY  = entry − ATR × atr_sl_multiplier
TP_SELL = entry − ATR × atr_tp_multiplier
SL_SELL = entry + ATR × atr_sl_multiplier
```

ATR は **クローズtoクローズ近似**（H/L データ非保有のため）:

```
ATR ≈ average(|close[t] - close[t-1]|) over atr_period 本
```

---

## 4. 戦略② SMA BB Breakout（順張り）

> Ph.10 として 2026-04-03 に実装・本番接続。SQL: `20260403_ph10_sma_bb_breakout.sql`

### 4.1 戦略の直感

**「嵐の前の静けさ（スクイーズ）→ 暴発（ブレイクアウト）」** を捉える戦略。

ボラティリティが収縮してバンドが狭くなっている状態（スクイーズ）のあと、レートが一方向に抜けた瞬間を順張りでエントリーする。

### 4.2 発火条件（3段階ゲート）

```
Gate 1: ATR / historicalAtrMean ≥ volatility_ratio_min
         → 現在のボラティリティが歴史平均以上（静止相場を除外）
Gate 2: BB.width / BB.avgWidth < bb_squeeze_threshold
         → バンド幅が平均より十分に狭い（スクイーズ状態）
Gate 3: currentRate > upperBand（BUY）or currentRate < lowerBand（SELL）
         → 実際に±2σを突破（ブレイクアウト確認）
```

全て満たした場合のみ BB Breakout シグナルを発行し、**`isBBBreakout: true`** を付与する。

### 4.3 BB Breakout 時の TP/SL（順張り方向）

```
BUY  ブレイクアウト: TP = entry + ATR × atr_tp_multiplier  ← 価格の延長方向
                      SL = entry − ATR × atr_sl_multiplier  ← 価格の反対方向
SELL ブレイクアウト: TP = entry − ATR × atr_tp_multiplier  ← 価格の延長方向
                      SL = entry + ATR × atr_sl_multiplier  ← 価格の反対方向
```

平均回帰と **TP/SL の方向は同一式** だが、BB Breakout はすでに±2σを突破した方向にエントリーするため、結果として「ブレイクアウト方向にTP」「戻り方向にSL」となる。

### 4.4 MACD フィルター（Ph.10b）との組み合わせ

BB Breakout 時も MACD フィルターが適用される。ただし、フィルタ不通過の場合は「キャンセル」ではなく「フォールスルー」してRSI判定に委ねる設計（完全な無効化ではない）。

### 4.5 専用パラメーター（`instrument_params`）

| カラム | 型 | デフォルト | 説明 |
|---|---|---|---|
| `sma_short_period` | INTEGER | 10 | 短期SMA（MTF整合判定用） |
| `sma_long_period` | INTEGER | 40 | 長期SMA（MTF整合判定用） |
| `volatility_ratio_min` | REAL | 0.8 | Gate1: ATR/historicalAtrMean の最低値 |
| `bb_squeeze_threshold` | REAL | (既存) | Gate2: width/avgWidth の上限値 |

---

## 5. ER によるダイナミック・ルーティングの神髄

> ここが本システムの最も重要な設計概念。必ず読むこと。

### 5.1 ER（Efficiency Ratio）とは

Perry Kaufman の AMA 理論に基づく指標。**相場がどれだけ一直線に動いているか**を 0〜1 で表す。

```
ER = |直近N本の終値変動（始点→終点の絶対距離）| / Σ|各1本ごとの変動の絶対値|

ER = 1.0 → 完全トレンド（一直線に動いている）
ER = 0.0 → 完全レンジ（往復してほぼ動いていない）
参考: ADX > 25 ≈ ER > 0.40
```

### 5.2 戦略ごとの ER の「意味」が真逆である

```
平均回帰: ERが低い = レンジ相場 = 逆張りが機能しやすい  → ERが低いほど高スコア
BB Breakout: ERが高い = トレンド中 = 順張りが機能しやすい → ERが高いほど高スコア
```

### 5.3 `er_upper_limit` による安全装置（逆張りの誤エントリー防止）

`strategy_primary = 'mean_reversion'` の銘柄で、ER が `er_upper_limit` を超えた場合は **強制スキップ**する。

```typescript
// logic-trading.ts
if (params.strategy_primary === 'mean_reversion' && !techSignal.isBBBreakout
    && techSignal.er != null && params.er_upper_limit > 0) {
  if (techSignal.er > params.er_upper_limit) {
    SKIP; // 「強トレンド中の逆張り」を禁止
  }
}
```

**直感**: 「相場が一直線に上昇しているのに RSI が oversold になった → 買いシグナル」は誤り。強トレンドでの RSI は戻る前にどんどん下がることがある。`er_upper_limit` はこの誤エントリーを防ぐ安全弁。

### 5.4 `overrideTrendFollow` による「戦略スコアの動的切り替え」

BB Breakout が発火した瞬間、`calcScores('BUY', true)` と呼ばれ、`overrideTrendFollow=true` が渡される。

```typescript
// logic-indicators.ts
const calcScores = (direction: 'BUY' | 'SELL', overrideTrendFollow = false) => {
  const effectiveStrategy = overrideTrendFollow ? 'trend_follow' : params.strategy_primary;
  //                         ↑ BB Breakout時は mean_reversion 銘柄でも trend_follow 扱い

  const erScore = effectiveStrategy === 'trend_follow'
    ? Math.min(1, er!)              // trend_follow: ERが高いほど高スコア ← 逆転！
    : Math.min(1, Math.max(0, 1-er!)); // mean_reversion: ERが低いほど高スコア

  const bbScore = effectiveStrategy === 'mean_reversion'
    ? Math.max(0, Math.min(1, 1 - ratio))  // 狭い（スクイーズ）ほど高スコア
    : Math.max(0, Math.min(1, ratio));      // 広がっている（ブレイクアウト後）ほど高スコア
};
```

### 5.5 全体フロー：相場環境に応じた戦略切り替えの完全図

```
相場が一直線に動き始める（ER が上昇）
          ↓
[mean_reversion ルート]
  RSI が oversold/overbought → BUY/SELL シグナル生成
          ↓
  er_upper_limit チェック（`isBBBreakout=false`）
          ↓
  ER > er_upper_limit → ✗ SKIP（強トレンド逆張り禁止）
          ↓
  ER ≤ er_upper_limit → ✓ 通過 → entry_score チェック → エントリー

          ＜ER が高く BB スクイーズが解放された瞬間＞

[BB Breakout ルート]（同じ mean_reversion 銘柄でも）
  BB Gates 1〜3 全通過 → `isBBBreakout: true` でシグナル生成
          ↓
  er_upper_limit チェック → `isBBBreakout=true` なので【免除】
          ↓
  calcScores に `overrideTrendFollow=true` → ER が高いほど高スコアに「反転」
          ↓
  entry_score チェック → エントリー（順張り）
```

**ポイント**: 1つの銘柄定義（`strategy_primary='mean_reversion'`）から、相場環境次第で **逆張りと順張りの両方** が出力される。銘柄パラメーターは固定のまま、シグナルの性質が自動切り替えされる。

---

## 6. 重みつきエントリースコアリング（Ph.7）

### 6.1 スコア構成（7因子）

```
total = w_rsi × rsiScore
      + w_er  × erScore
      + w_mtf × mtfScore
      + w_sr  × srScore
      + w_pa  × paScore
      + w_bb  × bbScore
      + w_div × divScore
```

| 因子 | 計算元 | 意味 |
|---|---|---|
| `rsiScore` | RSI の oversold/overbought からの乖離 | 価格の過熱・冷却度 |
| `erScore` | ER（戦略により解釈が逆転） | トレンド/レンジの強度 |
| `mtfScore` | SMA short/long のクロスと傾き | 上位足との方向整合性 |
| `srScore` | 直近高安へのレート近接度 | サポレジ近くでのエントリー |
| `paScore` | 直近パターン（連続陽線/陰線等） | プライスアクションの後押し |
| `bbScore` | BB width / avgWidth | スクイーズ状態（逆張り）or 拡大中（順張り） |
| `divScore` | RSI ダイバージェンス（2点近似） | 価格と RSI の乖離 |

### 6.2 エントリーゲート

| ゲート | 設定 | 説明 |
|---|---|---|
| `entry_score_min` | REAL | total スコアがこれ未満ならスキップ |
| `min_confirm_signals` | INTEGER | 有効因子数（> 0.1）が N 個以上必要 |
| `er_upper_limit` | REAL | mean_reversion 時の ER 上限 |

### 6.3 VIX・マクロ環境によるスケール調整

```
VIX > vix_max × 0.7 → TP幅に vix_tp_scale、SL幅に vix_sl_scale を乗算
VIX > vix_max × 0.5 → SL幅に macro_sl_scale を追加乗算（マクロ警戒）
```

---

## 7. AI（Gemini）とニュースロジック

### 7.1 モデル構成

| 用途 | モデル | バージョン | 設定 |
|---|---|---|---|
| ニュースフィルター（採用判定） | gemini-2.5-flash | v1beta | `thinkingBudget: 0` |
| Path B Stage1（注目判定） | gemini-2.5-flash | v1beta | 通常 |
| Path B Stage2（トレード判断） | gemini-2.5-flash | v1beta | 通常 |
| GPT フォールバック | gpt-4o-mini | - | Gemini 全滅時のみ |

### 7.2 ニュースフィルター：`thinkingBudget:0` とブラックリスト設計

#### なぜ `thinkingBudget: 0` か

`thinkingBudget: 0` は Gemini の "thinking tokens" を無効化する設定。高速で JSON 出力に特化できる反面、**判断を簡略化する傾向**がある。

「疑わしければ何でも除外」というホワイトリスト型指示では、thinking なしの Gemini は**保守的すぎる判断**をして採用率がゼロに張り付く問題が 2026-04 に確認された（PR #161 での教訓）。

#### 現在のプロンプト設計：ブラックリスト型

```
【基本方針】
迷ったときは採用する。除外するのは以下の条件に明確に該当する場合のみ。
FX・為替・金融・経済・株式・債券・商品市場・地政学リスク・
金融政策・マクロ経済に少しでも関連すれば採用する。

【除外条件（ブラックリスト）】
明確に以下に該当する場合のみ除外：
- スポーツ・芸能・社会面・天気・事件・生活情報
- まとめ記事・過去の事後分析・新事実のないオピニオン
- 完全に同一の発表を別ソースが伝えているだけの記事
  （ただし新しい発言者・数値・角度があれば採用）
```

**設計原則**: 過少採用（False Negative）のコストが過剰採用（False Positive）のコストより高い。ニュースを取り逃がすリスク > ノイズが混入するリスク。

### 7.3 適応的採用閾値（Adaptive Threshold）

ニュース採用率を **15〜25%** の目標範囲に保つため、スコア閾値を自動調整する（`src/news.ts` の `getAdaptiveCompositeThreshold()`）。

#### 閾値調整アルゴリズム

```
入力: 直近 200 件の news_raw.filter_accepted の採用率

採用率 < 5%   → 緊急下限 4.5（大幅緩和）
採用率 5-15%  → 4.5〜6.5（線形補間、緩和方向）
採用率 15-25% → 6.5（デフォルト・維持）
採用率 > 25%  → 6.5〜8.5（線形補間、厳格化）
```

#### サーキットブレーカー（CB）

200件ローリング窓は「過去の好成績で希釈される」問題がある。直近の急激な劣化を見逃さないため、独立した CB を搭載:

```
条件: 直近 30 件（うち 20 件以上が有効値）の accepted が 0 件
対応: 200件窓の計算をスキップし、即座に閾値 = 4.5 を返す
ログ: "[news] adaptive-threshold: circuit-breaker OPEN → threshold=4.5"
```

**CB は 200件窓より優先度が高い**。閾値が 200件窓で高くなっていても、直近30件が全滅なら強制的に 4.5 に落とす。

### 7.4 ニューススコア評価軸

フィルター通過後、各ニュースは 5 軸で 0〜10 採点される:

| 軸 | 略称 | 意味 |
|---|---|---|
| relevance | `r` | 市場有効性（金融市場への直接影響度） |
| credibility | `c` | 信憑性（ソースの信頼度・一次情報か） |
| sentiment | `s` | シグナル強度（方向性の明確さ） |
| breadth | `b` | 影響銘柄数（広く影響するか） |
| novelty | `n` | 新規情報度（既報でない新事実か） |

`composite_score = Σ(各軸) / 5`（0〜10 スケール）→ ×10 で 0〜100 に変換して DB 保存

### 7.5 Path B のエントリー発火スコア閾値

```typescript
NEWS_SCORE_EMERGENCY = 90  // composite_score ≥ 90 → 強制発火
NEWS_SCORE_TREND     = 70  // composite_score ≥ 70 → パラメーター一時調整
NEWS_TRIGGER_EMERGENCY_RELEVANCE = 9  // r軸 ≥ 9 が必要（EMERGENCY判定）
NEWS_TRIGGER_EMERGENCY_SENTIMENT = 8  // s軸 ≥ 8 が必要（EMERGENCY判定）
```

### 7.6 API タイムアウトと多層フォールバック

```
Gemini API 呼び出し
├── 15秒タイムアウト（AI_TIMEOUT_MS = 15_000）
│   └── 超過 → AbortError をスロー
│
├── キー別クールダウン（429受信でそのキーをマーク）
│   └── GEMINI_API_KEY_2〜5 に自動ローテーション
│
├── サーキットブレーカー（analysis-workflow.ts）
│   └── 連続3回失敗（CB_FAIL_THRESHOLD=3）→ 1分間 AI停止（OPEN状態）
│   └── 1分後 HALF_OPEN → 次回成功で CLOSED 復帰
│
└── GPT フォールバック
    └── OPENAI_API_KEY 設定時のみ自動切替
```

---

## 8. リスク管理レイヤー

### 8.1 HWM ドローダウン 5 段階制御

高値更新額（HWM）からのドローダウンを常時監視:

```
NORMAL  : DD < 7%   → lotMultiplier = 1.0（Full Kelly）
CAUTION : DD ≥ 7%   → lotMultiplier = 0.5（Half Kelly）
WARNING : DD ≥ 10%  → lotMultiplier = 0.25（Quarter Kelly）
HALT    : DD ≥ 15%  → lotMultiplier = 0.1（Micro Kelly、最小ロットで継続）
STOP    : DD ≥ 20%  → lotMultiplier = 0（完全停止、手動解除まで）
```

> **⚠️ 現在の設定**: `global_dd_enabled = false`（デフォルト）。
> 仮想トレード中は DD に関わらず常に NORMAL として動作する。
> **実弾投入前に `true` へ切り替えること**。

### 8.2 銘柄別日次損失上限

```
INSTRUMENT_DAILY_LOSS_CAP = ¥100/銘柄/日
```

1銘柄が1日にこの額を超えて負けると、その銘柄はその日の取引をスキップする（UTC 0:00 で自動リセット）。

### 8.3 RiskGuard（OANDA 実弾発注専用）

| チェック | デフォルト | Secret 名 |
|---|---|---|
| 日次最大損失 | ¥500 | `RISK_MAX_DAILY_LOSS` |
| 最大実弾ポジション数 | 5件 | `RISK_MAX_LIVE_POSITIONS` |
| 最大ロットサイズ | （設定値） | `RISK_MAX_LOT_SIZE` |

### 8.4 週末クローズ制約

```
FX 市場クローズ: 金曜 21:00 UTC 〜 日曜 22:00 UTC
クローズ中に取引可能: CRYPTO_PAIRS（BTC/USD・ETH/USD・SOL/USD）のみ
FX・株指数: 新規エントリー禁止
```

実装: `src/weekend.ts` の `getTradeableInstruments()` を必ず経由する。

---

## 9. 戦略パフォーマンスの評価・分類定義

### 9.1 フロントエンドの戦略分類（パイチャート）

`public/app.js` の `classifyStrategyType(trade)` が定義する分類。

#### 分類基準: `strategy` フィールドではなく `trigger` フィールドを優先

```javascript
function classifyStrategyType(trade) {
  var trigger  = (trade.trigger  || '').toLowerCase();
  var strategy = (trade.strategy || '').toLowerCase();

  if (trigger === 'news' || strategy.indexOf('news') >= 0 || strategy.indexOf('ai') >= 0) {
    return 'news';       // オレンジ: ニューストリガー
  }
  if (strategy.indexOf('trend') >= 0 || strategy.indexOf('breakout') >= 0) {
    return 'trend';      // グリーン: トレンド/ブレイクアウト
  }
  return 'reversion';    // ブルー: 平均回帰（デフォルト）
}
```

#### なぜ `strategy` ではなく `trigger` なのか

`positions.strategy` カラムはエントリー時に `instrument_params.strategy_primary` の値が入るが、BB Breakout エントリーも `strategy_primary='mean_reversion'` の銘柄から生成されるため、DB 上は `strategy='mean_reversion'` と記録されてしまう（`logic-trading.ts` の既存実装）。

一方、`positions.trigger` カラムは **エントリーの真のきっかけ**を記録する設計:

| `trigger` 値 | 意味 |
|---|---|
| `'NEWS'` | ニューストリガー経由（`analysis-workflow.ts` で設定） |
| `'LOGIC'` | ロジックエンジン経由（`logic-trading.ts` で設定） |
| `'RATE'` | レート変動起点 |
| `'SCHED'` | 定期スケジュール |

この設計により「`strategy='mean_reversion'` でも `trigger='NEWS'` なら News カテゴリ」という正確な分類が可能。

#### 集計方法

```javascript
// losses = Math.max(0, pnl) → 損失はゼロ換算
// パイの面積 ∝ 利益貢献量（損失は面積を減らさない）
buckets[cat].pnl += Math.max(0, trade.pnl || 0);
```

損失で面積がマイナスになる視覚的問題を避けつつ、**どの戦略が利益を生んでいるか**に焦点を当てる設計。

### 9.2 パフォーマンス評価指標

| 指標 | 定義 | 目標値 |
|---|---|---|
| 勝率（RR≥1.0） | 実現RR≥1.0の取引数/全取引数 | ≥ 35% |
| avgRR | 全取引の平均実現RR | ≥ 2.0 |
| EV | `勝率×avgRR - (1-勝率)` | > 0 |
| プロフィットファクター | 総利益/総損失 | > 1.5 |
| シャープレシオ | mean(pnl)/stdev(pnl) | > 0.5 |
| 最大ドローダウン | HWMからの最大下落率 | < 15% |

---

## 10. パラメーター一覧と設計原則

### 10.1 `instrument_params` の主要パラメーター

| パラメーター | 型 | 設計根拠 |
|---|---|---|
| `rsi_period` | INT | RSI 計算期間（標準14） |
| `rsi_oversold` | REAL | 売られすぎ閾値（標準30） |
| `rsi_overbought` | REAL | 買われすぎ閾値（標準70） |
| `atr_period` | INT | ATR 平均期間（標準14） |
| `atr_tp_multiplier` | REAL | TP = entry ± ATR×この値 |
| `atr_sl_multiplier` | REAL | SL = entry ∓ ATR×この値 |
| `strategy_primary` | TEXT | `mean_reversion` or `trend_follow` |
| `er_upper_limit` | REAL | mean_reversion 時の ER 上限（0=無効） |
| `entry_score_min` | REAL | 重みつきスコア最低値（0=スコア無効） |
| `bb_squeeze_threshold` | REAL | BBスクイーズ判定閾値（BB Breakout用） |
| `volatility_ratio_min` | REAL | ATR/historicalAtrMean の最低値 |
| `sma_short_period` | INT | 短期SMA期間（MTF用）（Ph.10） |
| `sma_long_period` | INT | 長期SMA期間（MTF用）（Ph.10） |
| `max_hold_minutes` | INT | 最大保有時間（分）、超過でTIME_STOP |
| `trailing_activation_atr` | REAL | トレイリング開始距離（ATR倍） |
| `trailing_distance_atr` | REAL | トレイリング追従幅（ATR倍） |

### 10.2 パラメーター設計の禁則

> `CLAUDE.md` より（プロジェクト全体で変更禁止）

1. **`pnl > 0` を勝ち判定に使用禁止** — RR≥1.0 が唯一の勝ち基準
2. **週末クローズ制約の回避禁止** — `CRYPTO_PAIRS` は `src/weekend.ts` からのみ定義
3. **`RR_DEFINITION_PROMPT` の変更禁止** — `src/gemini.ts` にハードコード
4. **`strategy_primary` の値は2値のみ** — `mean_reversion` | `trend_follow`

---

*本文書の真実の源泉: `src/logic-indicators.ts`, `src/logic-trading.ts`, `src/news.ts`, `src/gemini.ts`, `public/app.js`*
*実装が変わった場合は必ず本文書を更新すること。*

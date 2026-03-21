# テスタ戦略 × fx-sim 統合企画書

**作成日**: 2026-03-22（銘柄戦略追記: 同日、IPA/統計レビュー反映: 同日）
**ステータス**: ドラフト（ユーザーレビュー待ち）
**前提**: `FX_Strategy_and_Tactics.md` の戦略・戦術を fx-sim-v1 に統合するための企画・アイデア一覧
**レビュー**: IPA（IT戦略・PM・ITSM）+ 統計学（推測・ベイズ・時系列・実験計画・回帰）で評価済み

---

## エグゼクティブサマリー

テスタ氏の投資哲学（生存第一・期待値重視・環境認識・100手法使い分け）と、最新のアルゴリズムトレーディング手法を融合し、fx-sim を「テスタ流AI自動売買システム」に進化させる。

**現在のシステムが既に持つ強み:**
- 3 AI プロバイダ（Gemini/GPT/Claude）のヘッジ戦略
- 16 銘柄対応（12 OANDA 実弾 + 4 ペーパー）→ **18銘柄に拡張提案（UK100・HK33 追加）**
- Kalman フィルタによるレジーム推定
- Thompson サンプリングによる銘柄ランキング
- 20+ 統計関数（Sharpe、VaR、Kelly、Bootstrap 等）
- 連敗時ロット縮退（3連敗→50%、5連敗→25%、7連敗→停止）
- リスクガード4層（日次損失キル・最大ポジション数・最大ロット・異常レート）

---

## 戦略評価（IPA・統計学レビュー反映）

### バリューチェーン分析（IPA st.md §バリューチェーン）

現在のシステムの価値創造フローとボトルネック:

```
データ取得(10%) → 環境認識(25%) → AI判断(30%) → 発注管理(20%) → 検証改善(15%)
                      ↑                ↑
               ボトルネック①      ボトルネック②
          テクニカル指標なし      手法分類・RR管理なし
```

- **ボトルネック①**: 環境認識に Kalman フィルタのみ。ADX/ATR/RSI がないため、トレンド/レンジの判定精度が限定的
- **ボトルネック②**: AI 判断は1手法のみ。環境に合わない手法を使うリスクがある
- **対応**: Phase 2（テクニカル基盤）がボトルネック①を、Phase 3（AI高度化）がボトルネック②を解消

### KGI / KPI（IPA st.md §BSC）

```
KGI: 月次期待値がプラス（= 持続的に資産が増える状態）

KPI:
  ① 月間 Sharpe Ratio    ≧ 0.5
  ② 月間最大ドローダウン  ≦ 5%
  ③ 平均 RR 比            ≧ 1.5
  ④ AI 方向的中率         ≧ 55%
  ⑤ 環境認識正答率        ≧ 60%（事後検証）
  ⑥ 月間プロフィットファクター ≧ 1.3

測定: 既存の stats.ts 関数 + 新規追加の手法別統計で自動算出
```

### 意思決定ゲート（IPA pm.md §ステージゲート）

各 Phase 完了時にユーザーがレビューし、次 Phase のスコープを確認する:

```
Phase 1 完了 → ユーザーレビュー: 生存力ルールの閾値は適切か
Phase 2 完了 → バックテスト結果: テクニカル指標は判断精度を改善したか
Phase 3 完了 → AI精度検証: Mann-Whitney U で施策前後の有意差を確認
Phase 4 完了 → 統計妥当性: 手法別統計のサンプルサイズは十分か（power analysis）
Phase 5 完了 → 総合検証: KPI 6項目の達成状況で継続判断
```

### 施策効果検証フレームワーク（統計 doe.md §フィッシャーの3原則）

施策の導入効果を交絡なく測定するための方法:

```
■ A/Bテスト方式（推奨 — 交絡排除が可能）
  施策あり・なしの2系統を同時に走らせる（Worktree活用）
  同じマーケットデータに対して両系統の判断を比較
  統計検定: Mann-Whitney U or Welch's t-test で有意差判定

■ Before/After方式（次善策）
  施策導入前30日 vs 導入後30日の成績を比較
  レジームの変化をブロック因子として局所管理
  DID（差分の差分法）で環境変化の影響を除去

■ 判定基準
  p < 0.05 かつ効果量 Cohen's d ≧ 0.3 → 効果あり
  p < 0.05 だが d < 0.3 → 統計的に有意だが実用的効果は小さい
  p ≧ 0.05 → 効果不明（サンプル不足の可能性 → power analysis で確認）
```

### リスク登録簿（IPA pm.md §リスクマネジメント）

| ID | リスク | 影響度 | 発生確率 | 対策 | フォールバック |
|---|---|---|---|---|---|
| R1 | ATR/ADX算出の精度不足（OANDAキャンドル品質依存） | 高 | 中 | バックテストで精度検証してから本番投入 | Kalmanフィルタのみで判断（現状維持） |
| R2 | 経済カレンダーAPI（Finnhub）のサービス停止 | 中 | 低 | 複数API候補を確保（FinanceFlowAPI等） | ハードコードSKIP_SCHEDULESを維持 |
| R3 | 手法タグの分類精度（AI任せの曖昧さ） | 高 | 高 | Few-shot例を5つ以上用意し分類の一貫性を検証 | strategy='unknown'としてログ、統計から除外 |
| R4 | 分割決済のPnL計算バグ | 高 | 中 | ペーパートレードで1週間検証してから実弾適用 | 分割なし（現状の全量決済）に自動切替 |
| R5 | 相関リスクガードの誤判定（相関は動的に変化） | 中 | 中 | 30日ローリング相関で更新、固定値を避ける | 相関ガードを無効化し従来の最大ポジション制限のみ |
| R6 | セッション×銘柄マトリクスが硬直的 | 中 | 中 | 初期は固定→統計蓄積後に動的最適化 | デフォルト全銘柄アクティブ |
| R7 | 手法別統計のサンプルサイズ不足で過学習 | 高 | 高 | 信頼度ラベル付与（n<50:参考/50≦n<200:暫定/n≧200:信頼） | セル数が少ない統計は判断に使わない |
| R8 | 多重比較問題（25セルの同時検定） | 中 | 高 | BH法（FDR制御）を手法別統計にも適用 | ボンフェローニ補正で保守的に判定 |

---

**戦略資料が求めるもの vs 現在のギャップ:**

| 戦略資料の要件 | 現在の実装状態 | ギャップ |
|---|---|---|
| 日次/週次/月次損失キャップ | 日次のみ（¥-500） | 🔴 週次・月次が未実装 |
| ピーク基準ドローダウン管理 | 連敗ベースのみ | 🔴 HWM（最高水準）ベースが未実装 |
| RR比 1:1.5 以上の強制 | TP/SL sanity check のみ | 🟡 RR比の明示的チェックなし |
| 複数手法の分類・選択 | 単一AI判定 | 🔴 手法タグ・環境別切替なし |
| ADX/ATR/RSI 等のテクニカル指標 | Kalman のみ | 🔴 クラシック指標なし |
| マルチタイムフレーム分析 | 1分足のレート変化のみ | 🔴 日足・4H・1H の分析なし |
| ポジションサイズ計算（SL幅ベース） | 固定ロット + Kelly 倍率 | 🟡 SL幅ベース未実装 |
| 分割決済・建値ストップ | 未実装 | 🔴 |
| セッション別ロット倍率 | SKIP_SCHEDULES のみ | 🟡 ロット倍率調整なし |
| 早朝取引禁止（3:00-7:00 JST） | 未実装 | 🔴 |
| 経済指標カレンダー連携 | ハードコード SKIP_SCHEDULES | 🔴 動的カレンダー未連携 |
| 相関リスクガード | 共積分分析は統計のみ | 🔴 発注時ガードなし |
| トレード日誌（手法タグ付き） | decisions テーブル | 🟡 手法・環境タグなし |
| 戦略別統計・期待値算出 | 全体統計のみ | 🔴 手法別統計なし |
| 週次/月次自動レビュー | 未実装 | 🔴 |
| 銘柄ティア制（流動性・因果・セッション評価） | 16銘柄均等扱い | 🔴 ティア制なし |
| セッション×銘柄マトリクス | なし | 🔴 時間帯で銘柄を絞る仕組みなし |
| 指数のセッションカバレッジ | 東京午後〜ロンドンに穴 | 🟡 HK33で補完可能 |

---

## 銘柄戦略（テスタ適合度分析）

### テスタ氏の銘柄選定基準（Webリサーチより）

テスタ氏の実際の銘柄選定基準をFXシステムに翻訳すると、以下の5条件になる:

1. **流動性が高い** — SLが滑らず約定する（板が厚い = スプレッドが狭い）
2. **因果関係が明確** — 「なぜ動くか」が説明できる（金利差、政策、地政学等）
3. **セッション特性がある** — 時間帯ごとの値動きパターンが読める
4. **複数手法が使える** — トレンドフォロー・レンジ逆張り・ブレイクアウトの全てで戦える
5. **値幅が出る** — RR 1:2 が狙えるだけのボラティリティがある

> **テスタの言葉**: 「よさそうな銘柄が見つからなかったら無理にはやりません」
> → 16銘柄を均等に扱うのではなく、**戦う場所を選ぶ = ティア制で集中配分**

### 現在の18銘柄 テスタ適合度ランキング

| 順位 | 銘柄 | カテゴリ | 適合度 | 理由 |
|---|---|---|---|---|
| 1 | **USD/JPY** | 為替 | ★★★★★ | 流動性◎、日米金利差で因果明確、東京仲値+NYの2つのピーク、全手法対応 |
| 2 | **EUR/USD** | 為替 | ★★★★ | 世界最大流動性、ECB/FRB政策差で読みやすい、RR取りやすい |
| 3 | **Gold** | コモディティ | ★★★★ | マクロ相関明確（リスクオフ）、$2,000等の節目でブレイクアウト |
| 4 | **S&P500** | 指数 | ★★★☆ | 長期上昇バイアス、流動性抜群、NYセッション中心 |
| 5 | **UK100** 🆕 | 指数 | ★★★☆ | ロンドン本番カバー、コモディティ連動（Shell/BP重い）、BOE政策 |
| 6 | **GBP/USD** | 為替 | ★★★ | ボラ高でRR狙いやすい、ただしノイズも大きくSL食われやすい |
| 7 | **AUD/USD** | 為替 | ★★★ | 中国経済連動で方向感明確な時期あり、平時はボラ不足 |
| 8 | **HK33** 🆕 | 指数 | ★★★ | 中国プロキシ、東京午後〜ロンドンの穴を埋める唯一の選択肢 |
| 9 | **Nikkei225** | 指数 | ★★☆ | 東京セッション親和性高いが取引時間限定 |
| 10 | **NASDAQ** | 指数 | ★★☆ | テック主導・高ボラだがS&P500と高相関 |
| 11 | **CrudeOil** | コモディティ | ★★ | 地政学で大トレンドだが急変リスク高、テスタの「守り」と相性△ |
| 12 | **DAX** | 指数 | ★★ | 欧州株だがドライバー分散、UK100追加後は相対的価値↓ |
| 13 | **US10Y** | 債券 | ★★ | 金利方向明確だが値幅が小さくRR取りにくい |
| 14 | **Silver** | コモディティ | ★☆ | Goldと高相関（r>0.9）で冗長 |
| 15 | **BTC/USD** | 暗号資産 | ★☆ | 超高ボラだが24h・週末リスク・因果不明確・SL滑る |
| 16 | **Copper** | コモディティ | ★ | 流動性低、スプレッド広い |
| 17 | **NatGas** | コモディティ | ★ | 天候ランダム要因大、レジーム判定困難 |
| 18 | **ETH/USD, SOL/USD** | 暗号資産 | ★ | BTC以上にボラ・リスク大 |

### 施策 23: 銘柄ティア制の導入

**テスタの原則**: 「戦う場所を選ぶ」「良い銘柄がなければ休む」

**提案**:
```
Tier A（フルロット）: USD/JPY, EUR/USD, Gold
  → 全リソースの50%以上をここに集中

Tier B（70%ロット）: S&P500, UK100, GBP/USD, AUD/USD
  → セッション補完・分散目的

Tier C（50%ロット）: HK33, Nikkei225, NASDAQ, CrudeOil, DAX, US10Y
  → 環境が合うときだけ

Tier D（30%ロット）: BTC/USD, Silver, Copper, NatGas, ETH/USD, SOL/USD
  → テスタ戦略との相性△、統計蓄積目的
```

**実装イメージ**:
- `INSTRUMENTS` 配列に `tier: 'A' | 'B' | 'C' | 'D'` フィールドを追加
- 各ティアに `lotMultiplier`（1.0 / 0.7 / 0.5 / 0.3）を設定
- AI判定時、ティアに応じてプロンプトの強調度を変える（Tier A は詳細分析、Tier D は簡易）

**Thompson サンプリングとの整合性（レビュー指摘 ⑧ 反映）**:

Thompson サンプリングの探索-活用バランスを壊さないため、ティア情報は**事前分布に組み込む**（スコアに直接掛けない）。

```
案A（推奨）: 事前分布への組み込み
  Tier A: Beta(3, 1) — 事前分布で「良い」と仮定
  Tier B: Beta(2, 1) — やや楽観的
  Tier C: Beta(1, 1) — 無情報事前分布（フラット）
  Tier D: Beta(1, 1) — 同上
  → データが蓄積すれば事前分布の影響は消える（ベイズの大数の法則）
  → 理論的に正しく、探索も保証される

案B（次善策）: ロット倍率を別レイヤーで分離
  Thompson サンプリングは純粋にデータから学習
  ロット倍率は別レイヤーでティアに応じて調整
  → Thompson の探索-活用バランスは壊さない
  → ただし2つの仕組みが独立に動くのでチューニングが複雑
```

**工数**: 小
**リスクレベル**: 🟢 低（ロット倍率の追加のみ）
**ROI**: ★★★★★

### 施策 24: UK100（FTSE 100）の追加

**追加理由**:
- **ロンドンセッションの直接カバー** — DAXはフランクフルト、UK100はロンドン本番
- **構成がDAXと異なる** — FTSE は石油（Shell/BP）・鉱業（Rio Tinto）・金融が重い → Gold/CrudeOil との連動で環境認識しやすい
- **BOE金利政策** という明確なドライバー（FRB/BOJ と同じ構造）
- DAXとの相関 0.7〜0.8 — 完全な冗長ではなく異なる局面で異なる動き

**OANDA API名**: `UK100_GBP`
**カテゴリ**: 株式指数
**ブローカー**: oanda

**工数**: 小（INSTRUMENTS 配列に1行追加 + OANDA レート取得追加）
**リスクレベル**: 🟢 低
**ROI**: ★★★★

### 施策 25: HK33（香港ハンセン指数）の追加

**追加理由**:
- **時間帯の穴を埋める** — 香港市場は JST 10:30-17:00。東京午後〜ロンドンオープンの「指数が手薄な時間帯」をカバーする唯一の選択肢
- **中国経済の直接プロキシ** — 中国政策・不動産・テック規制で大きく動く。ニュース（Path B）との連動が強い
- **高ボラティリティ** — 日中値幅が大きく RR 1:2 が狙いやすい
- **既存銘柄と低相関** — S&P500/Nikkei とは異なるドライバー

**OANDA API名**: `HK33_HKD`
**カテゴリ**: 株式指数
**ブローカー**: oanda

**工数**: 小
**リスクレベル**: 🟢 低
**ROI**: ★★★★

### 施策 26: セッション × 銘柄マトリクス

**テスタの原則**: 「時合が悪いときは無理にトレードしない」の銘柄版

**提案**: 各セッションでアクティブな銘柄のみをAI分析対象にする

```
                 東京前半    東京午後     ロンドン      NY          早朝
                 (JST 8-12)  (JST 12-16)  (JST 16-21)  (JST 21-3)  (JST 3-7)
USD/JPY          ◎ 仲値     ○           ◎           ◎          ✗ 禁止
EUR/USD          △           △           ◎           ◎          ✗
GBP/USD          △           △           ◎           ◎          ✗
AUD/USD          ◎           ○           ○           ○          ✗
S&P500           △           △           ○           ◎          ✗
NASDAQ           △           △           ○           ◎          ✗
Nikkei225        ◎           ○           △           △          ✗
UK100            △           △           ◎           ○          ✗
HK33             ○           ◎           △           △          ✗
DAX              △           △           ◎           ○          ✗
Gold             ○           ○           ◎           ◎          ✗
CrudeOil         △           △           ○           ◎          ✗
Silver           △           △           ○           ◎          ✗
US10Y            △           △           ○           ◎          ✗

◎ = メイン（ロット × 1.0）  ○ = サブ（ロット × 0.7）  △ = 消極的（ロット × 0.3）  ✗ = 取引禁止
```

**活用方法**:
- cron で現在のセッションを判定 → そのセッションで ◎/○ の銘柄のみ AI 分析
- △ の銘柄は TP/SL チェックのみ（新規エントリーなし）
- ✗ は全操作停止（早朝スプレッド拡大対策）
- Gemini API 呼び出し回数の節約にもなる

**工数**: 中
**リスクレベル**: 🟡 中
**ROI**: ★★★★★

### 施策 27: 相関グループ管理（同方向制限の具体化）

**既存銘柄間の隠れた相関**:
```
高相関グループ（同方向ポジション禁止）:
  ① ドル高バスケット: USD/JPY↑ ≒ EUR/USD↓ ≒ GBP/USD↓ ≒ AUD/USD↓
  ② リスクオン系: S&P500↑ ≒ NASDAQ↑ ≒ Nikkei↑ ≒ AUD/USD↑ ≒ BTC↑ ≒ HK33↑
  ③ 貴金属系: Gold↑ ≒ Silver↑ （r > 0.9）
  ④ エネルギー系: CrudeOil ≒ NatGas（中程度）
  ⑤ 欧州指数系: DAX↑ ≒ UK100↑ （r ≈ 0.75）

逆相関ペア（ヘッジ利用可能）:
  Gold↑ ≒ S&P500↓（リスクオフ局面）
  USD/JPY↑ ≒ Gold↓（ドル高→金安）
  VIX↑ ≒ S&P500↓（恐怖指数）
```

**実装**: 施策4（相関リスクガード）と統合。発注前に同グループ内の同方向ポジションをチェック。

**動的相関への対応（レビュー指摘 ⑫ 反映）**:

上記の固定グループは経験的知識に基づくが、相関は動的に変化する（例: リスクオフ局面では全銘柄が同方向に動く）。

```
■ ローリング相関行列（30日ウィンドウ）
  既存の pairCorrelation() を日次で算出 → market_cache に保存
  → 固定グループではなく「今日の相関構造」に基づく制限

■ 階層的クラスタリング（ウォード法）で自動グループ化
  相関行列 → 距離行列 → デンドログラム → 閾値0.7でカット → グループ自動生成
  → 固定5グループの初期値として上記を使い、データ蓄積後に動的化

■ 段階的導入
  Phase 5 初期: 固定グループ（上記5グループ）でガード
  Phase 5 後期: 30日ローリング相関に基づく動的グループに移行
```

**工数**: 小（施策4に含む。動的化は Phase 5 後期）
**リスクレベル**: 🟢 低
**ROI**: ★★★★

### 追加後の24時間カバレッジマップ

```
時間帯(JST)   7   9   11  13  15  17  19  21  23  1   3   5   7
              |---東京前半---|---東京午後-|
                                  |--香港--|
                                          |-----ロンドン------|
                                                      |------NY------|
                                                                  |早朝|

為替:         USD/JPY(仲値)              EUR/USD  GBP/USD         (禁止)
              AUD/USD                    AUD/USD
指数:         Nikkei    Nikkei  HK33     DAX      S&P500  NASDAQ  (禁止)
                                HK33     UK100
コモディティ:                            Gold     Gold            (禁止)
                                         CrudeOil CrudeOil

→ 「指数がアクティブでない時間帯」がほぼゼロに
→ 東京午後の "死に時間" が HK33 でカバーされる
```

### 不採用とした指数（根拠）

| 指数 | OANDA名 | 不採用理由 |
|---|---|---|
| US30（ダウ） | US30_USD | S&P500 と相関 0.95 — 完全に冗長 |
| EU50（ユーロストックス） | EU50_EUR | DAX と相関 0.90 — ほぼ冗長 |
| FR40（CAC 40） | FR40_EUR | DAX/EU50 と高相関 — 3つ目は不要 |
| CN50（中国A50） | CN50_USD | HK33 と高相関 — HK33 の方が流動性高い |
| AU200（豪ASX） | AU200_AUD | AUD/USD と高相関 — 為替でカバー済み |
| SG30（シンガポール） | SG30_SGD | 流動性不足 — テスタ基準に不適合 |
| NL25, CH20, ESPIX | 各種 | 欧州指数は DAX + UK100 で十分 |

### US2000（ラッセル2000）の扱い

取引銘柄としては不採用（S&P500 と被る）。ただし **環境認識の先行指標** として活用する:
- US2000 は S&P500 より先にリスクオフを反映する傾向
- VIX と同様に Gemini プロンプトの「市場環境データ」として参照情報に加える
- OANDA API で `US2000_USD` のレートを取得 → `market_cache` に保存 → プロンプト注入

### 日本個別株について（調査結果）

日本個別株はテスタ氏の本来のフィールドだが、以下の理由で **現時点では不採用**:
- **kabuステーション API は localhost 限定** — Cloudflare Workers から直接呼べない
- 中継サーバー（Windows VPS）が必要 → 月額 ¥2,000〜5,000 のコスト増
- テスタの核心「板読み」は AI で完全再現困難（大口の意図読みは人間の瞬間判断）
- テスタ氏自身が 2025 年以降デイトレから中長期にシフト

**将来の選択肢**: 立花証券 e支店 API（localhost制限なし、REST対応、無料）を使えば、Cloudflare Workers から直接日本株にアクセス可能。戦略が安定した Phase 3 以降で検討。

---

## 施策一覧（優先度順）

### ━━━ Tier 1: 生存力を飛躍的に高める（最優先） ━━━

---

### 施策 1: 多層リスクキャップ（週次・月次損失上限）

**テスタの原則**: 「守りを考えた方が結果として増える」

**現状**: 日次損失上限（¥-500）のみ。週単位・月単位の歯止めがない。

**提案**:
```
日次損失上限:  口座資金の 2% → 到達で当日停止
週次損失上限:  口座資金の 5% → 到達で当週停止、翌週は50%ロットで再開
月次損失上限:  口座資金の 10% → 到達で当月停止、戦略見直しアラート
```

**実装イメージ**:
- `risk_state` テーブルを新設（または `market_cache` に weekly/monthly PnL を保存）
- `risk-guard.ts` に `checkWeeklyLimit()` / `checkMonthlyLimit()` を追加
- 翌週の50%ロット再開は `lot_multiplier` を自動調整
- ダッシュボードに週次/月次の残りリスク予算バーを表示

**Webリサーチ根拠**: プロトレーダーの多くは最大ドローダウンを20%以下に維持。20%のドローダウンからの回復に25%の利益が必要だが、50%なら100%必要と指数関数的に困難になる。多層キャップは回復不能ゾーンへの突入を構造的に防ぐ。

**工数**: 小（risk-guard.ts + DB に数カラム追加）
**リスクレベル**: 🟢 低（新規ガードの追加のみ）
**ROI**: ★★★★★（破産確率を大幅に低減）

---

### 施策 2: HWM（High Water Mark）ドローダウン管理

**テスタの原則**: 「最悪な状況になってもいいように備える。経済ショック時はポジションを減らす」

**現状**: 連敗回数ベースの縮退（3連敗→50%）はあるが、口座最高水準からの下落率管理がない。

**提案**:
```
口座HWM（最高水準）を記録
HWMから 5%下落  → ロット50%に縮退 + Slack警告
HWMから 10%下落 → 全ポジション決済 + 1週間取引停止
HWMから 15%下落 → 完全停止 + ユーザーへ緊急通知
```

**実装イメージ**:
- `market_cache` に `account_hwm`（最高水準）を保存
- 毎 cron で現在口座残高を HWM と比較
- 段階的に `lot_multiplier` を自動縮退
- 回復時（HWM 更新時）に自動で通常ロットに復帰

**工数**: 小
**リスクレベル**: 🟢 低
**ROI**: ★★★★★

---

### 施策 3: RR比（リスクリワード比）の強制チェック

**テスタの原則**: 「勝率よりも損益比」

**現状**: `sanity.ts` で TP/SL の方向や範囲はチェックしているが、RR比 ≧ 1.5 のような品質ゲートがない。

**提案**:
```
RR比 = |TP - entry| / |SL - entry|

ルール:
  RR ≧ 1.5  → 通常発注
  1.0 ≦ RR < 1.5 → 発注するがロットを50%に縮小 + ログ警告
  RR < 1.0  → 発注拒否（損切りの方が大きい = 期待値マイナス）
```

**実装イメージ**:
- `sanity.ts` の `checkSanity()` に RR 比計算を追加
- RR が基準未満の場合、AI に再計算を要求するか、自動で TP を RR 1.5 に調整
- `decisions` テーブルに `rr_ratio` カラムを追加して統計追跡

**Webリサーチ根拠**: RR 1:2 なら勝率35%以上で期待値プラス。テスタ氏も「損少利大」を一貫して強調。

**工数**: 小
**リスクレベル**: 🟢 低
**ROI**: ★★★★★

---

### 施策 4: 相関リスクガード（同方向ペア制限）

**テスタの原則**: 分散投資によるリスク管理

**現状**: `stats.ts` に共積分分析（`engleGrangerCointegration`）と相関行列（`pairCorrelation`）があるが、統計表示のみ。発注時のガードに使われていない。

**提案**:
```
同方向の高相関ペアを同時に保有しない:
  - USD/JPY ロング + EUR/USD ショート → 実質ドルロング2倍 → ブロック
  - Gold ロング + Silver ロング → 高相関 → 2つ目を50%ロット制限

判定ロジック:
  1. 新規発注時に既存オープンポジションを走査
  2. 相関係数 > 0.7 の同方向ペアが既にあれば警告
  3. 合計エクスポージャーが上限を超えたら発注拒否
```

**実装イメージ**:
- `risk-guard.ts` に `checkCorrelationRisk()` を追加
- 相関マトリックスは `market_cache` に日次キャッシュ（既存の `pairCorrelation` を流用）
- 発注前にチェック → 同方向高相関なら `lot_multiplier` を半減

**工数**: 中
**リスクレベル**: 🟡 中
**ROI**: ★★★★

---

### ━━━ Tier 2: テクニカル分析力の獲得（高インパクト） ━━━

---

### 施策 5: OANDA ヒストリカルキャンドル取得 → テクニカル指標算出

**テスタの原則**: 「100種類以上の手法を相場に合わせて選ぶ」— 手法選択にはテクニカル指標が必須

**現状**: レートは「現在値」のみ。過去のOHLCデータがないため、ADX/ATR/RSI/MA 等を計算できない。

**提案**:
OANDA REST API v20 の `/v3/instruments/{instrument}/candles` エンドポイントから複数タイムフレームのキャンドルデータを取得し、テクニカル指標を自前で算出する。

```
取得タイムフレーム:
  - H1 (1時間足) × 50本 → RSI(14), ADX(14), ATR(14), EMA(20/50)
  - H4 (4時間足) × 30本 → 上位足トレンド確認
  - D  (日足)    × 20本 → 長期トレンド確認

算出指標:
  - RSI(14): 過熱感判定（70超=買われすぎ、30未満=売られすぎ）
  - ADX(14): トレンド強度（25超=トレンド、20未満=レンジ）
  - ATR(14): ボラティリティ（動的SL幅に使用）
  - EMA(20/50): ゴールデンクロス/デッドクロス
  - ボリンジャーバンド(20,2): レンジ上下限判定
```

**実装イメージ**:
- 新ファイル `src/candles.ts` — OANDA キャンドル取得 + キャッシュ
- 新ファイル `src/technical.ts` — 指標算出（RSI/ADX/ATR/EMA/BB を TypeScript で純粋実装）
- `market_cache` に `candles_H1_USD_JPY` 等でキャッシュ（5分TTL）
- 毎 cron で更新（ただし毎分ではなく5分間隔で十分）

**代替案**: TAAPI.io API を使う（月額 $8.99〜、200+ 指標即利用可）。ただし外部依存が増える。OANDA からキャンドル取得して自前算出の方が、コスト0・レイテンシ低・依存少ない。

**Webリサーチ根拠**:
- OANDA API は `S5` から `M`（月足）まで全粒度対応、デモ口座で無料利用可
- ADX(20) > 25 がトレンド/レンジの最も一般的な判定基準
- ATR × 1.5〜2.5 が動的SL幅の業界標準

**工数**: 中〜大
**リスクレベル**: 🟡 中（API呼び出し追加）
**ROI**: ★★★★★（全後続施策の基盤）

---

### 施策 6: AI 環境認識の高度化（レジーム分類をプロンプトに統合）

**テスタの原則**: 「なぜ上がるか・下がるかを毎日復習する。外部指標と比較して背景を理解する」

**現状**: Kalman フィルタが `trending/ranging/volatile` の3状態を推定しているが、Gemini プロンプトへの統合が浅い。ADX/ATR 等のクラシック指標は渡していない。

**提案**:
施策5で取得したテクニカル指標を、Gemini プロンプトに構造化して渡す。

```
プロンプト追加セクション:

## 環境認識（Market Regime）
現在のレジーム: トレンド（ADX=32.5, 上昇方向）
1時間足RSI: 58.3（中立）
ATR(14): 0.28円（通常ボラティリティ）
EMA(20) > EMA(50): ゴールデンクロス状態
日足トレンド: 上昇（直近20日で+2.1円）
4時間足: 押し目形成中（RSI=42）

## 環境に応じた判断ガイドライン
- トレンド環境（ADX > 25）→ 順張りのみ推奨、逆張り禁止
- レンジ環境（ADX < 20）→ RSI 70超/30未満での逆張りのみ
- 高ボラ環境（ATR > 通常の1.5倍）→ ロット縮小 or 見送り推奨
```

**コンセンサスレジーム方式（統計レビュー指摘 ⑨ 反映）**:

ADX 単体（ルールベース）は定常過程の仮定を暗黙に破るため、既存の Kalman フィルタとの合意（コンセンサス）でレジーム判定の信頼度を上げる。

```
第1段階（ルールベース・高速）:
  ADX > 25 → トレンド候補
  ADX < 20 → レンジ候補
  ATR > 平均×1.5 → 高ボラ候補

第2段階（Kalman フィルタとの照合）:
  ADX判定 と Kalman判定 が一致 → 確信度 HIGH → ロットそのまま
  ADX判定 と Kalman判定 が不一致 → 確信度 LOW → ロット50%に縮小
  → 2つの手法の合意でレジーム判定の信頼度を担保
```

**Webリサーチ根拠**:
- 2026年の学術論文で、HMM + テクニカル指標の組み合わせが最高パフォーマンスを記録
- Gemini のプロンプト設計は「データリッチ・パラメータ明示・構造化」が最も効果的
- レジーム別に異なるモデル/戦略を適用するのが最新のベストプラクティス

**工数**: 中
**リスクレベル**: 🟡 中
**ROI**: ★★★★★

---

### 施策 7: 手法タグ × 環境タグによるトレード分類

**テスタの原則**: 「手法は100種類以上。その時その時の相場に適した手法を選ぶ」

**現状**: `decisions` テーブルに手法タグがなく、「なぜその判断をしたか」の構造化データがない。

**提案**:
AI に判断結果だけでなく「どの手法で判断したか」「どの環境と認識したか」も返させる。

```typescript
// AI出力の拡張
interface GeminiDecision {
  decision: 'BUY' | 'SELL' | 'HOLD';
  tp_rate: number | null;
  sl_rate: number | null;
  reasoning: string;
  // ↓ 新規追加
  strategy: 'trend_follow' | 'range_reversal' | 'breakout' | 'news_driven' | 'mean_reversion';
  regime: 'trend_strong' | 'trend_weak' | 'range' | 'high_vol' | 'low_vol';
  confidence: number;  // 0-100
}
```

**活用方法**:
- `decisions` テーブルに `strategy`, `regime`, `confidence` カラム追加
- 手法別の勝率・期待値・RR比を自動集計
- 「この環境でこの手法は勝率X%」を可視化
- 期待値マイナスの手法×環境の組み合わせを自動検出 → 次回からAIに「この組み合わせは避けよ」と指示

**工数**: 中
**リスクレベル**: 🟡 中
**ROI**: ★★★★

---

### ━━━ Tier 3: ポジション管理の精緻化 ━━━

---

### 施策 8: ATR ベース動的 TP/SL 算出

**現状**: Gemini が TP/SL を提案し、sanity.ts が範囲チェックするだけ。ボラティリティに応じた動的調整がない。

**提案**:
```
ATR(14) を使った TP/SL 自動算出:

トレンド環境（ADX > 25）:
  SL = entry ± ATR × 2.0（広め = ノイズに耐える）
  TP = entry ± ATR × 3.0（RR 1:1.5）

レンジ環境（ADX < 20）:
  SL = entry ± ATR × 1.0（タイト = 早期撤退）
  TP = entry ± ATR × 1.5（RR 1:1.5）

高ボラ環境（ATR > 平均の1.5倍）:
  SL = entry ± ATR × 2.5（非常に広い）
  TP = entry ± ATR × 4.0（RR 1:1.6）
  ただしロットを50%に縮小
```

**メリット**: AI の「感覚的な」TP/SL 提案を、統計的に裏付けのある値で補正できる。

**工数**: 中
**リスクレベル**: 🟡 中
**ROI**: ★★★★

---

### 施策 9: SL幅ベースのポジションサイズ計算

**テスタの原則**: 1回のトレードで失ってよい金額を固定

**現状**: 固定ロット（1.0）に Kelly 倍率（0.5x〜2.0x）を掛けるだけ。SL までの距離が考慮されていない。

**提案**:
```
ポジションサイズ = 許容損失額 ÷ SL幅（pips）÷ 1pipの価値

例:
  口座 100万円、1トレード許容損失 1%（= 1万円）
  SL幅 = ATR × 2.0 = 0.30円 = 30pips
  1pip = ¥1,000/1lot（USD/JPY）
  → 1万円 ÷ 30 ÷ 1,000 = 0.33 lot

  SL幅が広い（ボラ高）→ ロット自動縮小
  SL幅が狭い（ボラ低）→ ロット自動拡大
```

**実装イメージ**:
- `position.ts` に `calculatePositionSize()` 関数を追加
- 入力: 許容損失率(%), SL幅(pips), 口座残高
- Kelly 倍率と組み合わせ: `lot = baseLot × kellyMultiplier × drawdownMultiplier`

**Webリサーチ根拠**: ATR ベースのポジションサイジングは「ATR が高い = 大きな値動き = ポジション縮小」「ATR が低い = 小さな値動き = ポジション拡大」で自動リスク均衡。

**工数**: 中
**リスクレベル**: 🟡 中
**ROI**: ★★★★

---

### 施策 10: 分割決済 × 建値ストップ

**テスタの原則**: 「含み損のナンピン禁止、希望的観測排除」→ 逆に含み益は確保する仕組み

**現状**: ポジションは1回で全量決済。途中で利益確定する仕組みがない。

**提案**:
```
分割決済ルール:
  第1TP（RR 1:1 到達）: 50% 決済 → SL を建値に移動（=負けないトレード化）
  第2TP（RR 1:2 到達）: 残り 50% をトレイリングストップで追従

OANDA API での実装:
  - 初回エントリー: 1ロット全量
  - 第1TP到達時: PUT /trades/{id}/close (units=0.5) で半分決済
  - 同時に PUT /trades/{id}/orders で SL を entry_rate に移動
  - 残りはトレイリングストップ（既存ロジック）で管理
```

**考慮事項**:
- OANDA API は部分決済（partial close）をサポート
- ペーパートレードでも `positions` テーブルを2行に分割して管理可能
- PnL 計算ロジックの修正が必要

**工数**: 大
**リスクレベル**: 🟠 高（PnL計算・ポジション管理の大幅変更）
**ROI**: ★★★★

---

### ━━━ Tier 4: 時間・イベント戦術の自動化 ━━━

---

### 施策 11: セッション別ロット倍率 × 早朝取引禁止

**テスタの原則**: 時合（市場の雰囲気）が悪いときは無理にトレードしない

**現状**: `SKIP_SCHEDULES` で特定の指標発表時間のみスキップ。セッション別の戦術がない。

**提案**:
```typescript
// セッション定義（UTC → JST -9h）
const SESSION_CONFIG = {
  tokyo_open:    { utcStart: 23, utcEnd: 1,  lotMultiplier: 1.2, note: '仲値に向けた円売り',
                   activePairs: ['USD/JPY','AUD/USD','Nikkei225'] },
  tokyo_pm:      { utcStart: 1,  utcEnd: 6,  lotMultiplier: 0.5, note: '低ボラ',
                   activePairs: ['HK33','Nikkei225','AUD/USD'] },         // HK33がこの時間帯をカバー
  london_open:   { utcStart: 7,  utcEnd: 9,  lotMultiplier: 1.5, note: 'メイン取引時間帯',
                   activePairs: ['EUR/USD','GBP/USD','UK100','DAX','Gold'] },  // UK100追加
  ny_indicators: { utcStart: 12, utcEnd: 14, lotMultiplier: 0.3, note: '指標急変動',
                   activePairs: [] },                                      // 全銘柄消極的
  ny_active:     { utcStart: 14, utcEnd: 16, lotMultiplier: 1.3, note: '流動性最大',
                   activePairs: ['USD/JPY','EUR/USD','S&P500','NASDAQ','Gold','CrudeOil'] },
  early_morning: { utcStart: 18, utcEnd: 22, lotMultiplier: 0.0, note: '取引禁止',
                   activePairs: [] },                                      // 全銘柄禁止
};
```

**Webリサーチ根拠**:
- London-NY オーバーラップ（13:00-17:00 UTC）で全FX取引量の50%超が発生
- USD/JPY は東京セッションと NY セッションの2つの流動性ピークを持つ
- 早朝（JST 3:00-7:00）はスプレッド拡大・流動性薄で不利

**工数**: 小
**リスクレベル**: 🟢 低
**ROI**: ★★★★

---

### 施策 12: 経済指標カレンダー API 連携

**テスタの原則**: S級イベント（FOMC・雇用統計・日銀）はノーポジ or 超小ロット

**現状**: `filter.ts` に SKIP_SCHEDULES がハードコードされているが、日付固定で「第1金曜」等の動的判定は不正確。

**提案**:
```
Finnhub Economic Calendar API（無料）を利用:
  - 毎日1回、今日+翌日の経済指標を取得
  - market_cache に 'economic_calendar' として保存
  - 各イベントの impact レベル（high/medium/low）を判定

イベントレベル → 自動対応:
  S級（FOMC, NFP, BOJ, CPI）: 発表前30分〜後30分 → ノーポジ
  A級（GDP, ISM, 小売売上高）: ロット50%縮小
  B級（ADP, PPI, 失業保険）: 通常運用 + 注意フラグ
```

**代替候補API**:
- **Finnhub**: 無料枠あり、JSON形式、impact付き
- **FinanceFlowAPI**: 無料開始可、前回値・コンセンサス・実績値付き
- **Trading Economics API**: 最も網羅的だが有料

**工数**: 中
**リスクレベル**: 🟡 中
**ROI**: ★★★★

---

### ━━━ Tier 5: 検証ループの自動化（テスタ流PDCA） ━━━

---

### 施策 13: トレード日誌の自動生成

**テスタの原則**: 「毎日復習する。なぜ動いたかを検証する」

**現状**: `decisions` テーブルに記録はあるが、「エントリー根拠（どの手法・どのシグナル）」「環境認識」「結果の検証」が構造化されていない。

**提案**:
```sql
-- trade_logs テーブル（既存 positions + decisions を統合した検証用ビュー）
CREATE TABLE trade_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_rate REAL NOT NULL,
  close_rate REAL,
  tp_rate REAL,
  sl_rate REAL,
  pnl REAL,
  rr_ratio REAL,              -- 実績RR比
  strategy TEXT,               -- trend_follow / range_reversal / breakout / news_driven
  regime TEXT,                 -- trend_strong / trend_weak / range / high_vol / low_vol
  session TEXT,                -- tokyo / london / newyork
  confidence INTEGER,          -- AI確信度 0-100
  entry_reasoning TEXT,         -- エントリー根拠
  exit_reason TEXT,             -- TP / SL / MANUAL / TRAILING
  was_correct_direction BOOLEAN,-- 方向は正しかったか
  entry_at TEXT NOT NULL,
  closed_at TEXT
);
```

**活用**:
- ダッシュボードに「日誌」タブを追加
- 各トレードに対して「根拠は正しかったか」「環境認識は正しかったか」を自動判定
- 勝ちトレード/負けトレードのパターンを自動抽出

**工数**: 中
**リスクレベル**: 🟢 低
**ROI**: ★★★★

---

### 施策 14: 手法別・環境別・時間帯別の自動統計

**現状**: `stats.ts` に20+の統計関数があるが、全て「全体」の集計。手法別やセッション別のブレークダウンがない。

**提案**:
```sql
-- 手法別の期待値（戦略資料 V2 の SQL そのもの）
SELECT strategy,
       COUNT(*) as trades,
       AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) as win_rate,
       AVG(CASE WHEN pnl > 0 THEN pnl END) as avg_win,
       AVG(CASE WHEN pnl < 0 THEN ABS(pnl) END) as avg_loss,
       SUM(pnl) as total_pnl
FROM trade_logs
GROUP BY strategy;

-- 環境 × 手法 の組み合わせ成績
SELECT regime, strategy,
       AVG(pnl) as avg_pnl,
       COUNT(*) as sample_size
FROM trade_logs
GROUP BY regime, strategy
HAVING sample_size >= 10;

-- セッション別勝率
SELECT session,
       COUNT(*) as trades,
       AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) as win_rate
FROM trade_logs
GROUP BY session;
```

**自動アクション**:
- 期待値がマイナスの手法×環境の組み合わせ → Gemini プロンプトに「この環境ではこの手法を避けよ」と動的に注入
- ただし「信頼値」（n ≧ 200）のセルのみ自動アクション対象（下記参照）

**統計的注意事項（レビュー指摘 ⑥⑦⑩ 反映）**:

```
■ サンプルサイズ問題
  勝率10%差（50% vs 60%）を検出力80%で検出するには n ≈ 392 件必要
  5手法 × 5環境 = 25セルの場合、各セル 392件 × 25 = 9,800件の総取引が必要
  → 現実的には数ヶ月〜1年のデータ蓄積が必要

■ 統計的信頼度ラベル
  n < 50:   🔵 参考値 — 仮説生成用。判断に使わない
  50 ≦ n < 200: 🟡 暫定値 — 傾向の確認に使うが確定判断は保留
  n ≧ 200:  🟢 信頼値 — 自動アクション（プロンプト注入）の対象

■ 多重比較補正（既存の fdrCorrection() を流用）
  25セルを同時に検定 → BH法（FDR制御）で補正
  補正前 p < 0.05 でも補正後に有意でなくなるケースに注意

■ 自己相関チェック
  DW検定（ダービン・ワトソン）を手法別PnL系列に適用
  DW ≈ 2: 自己相関なし → iid仮定OK
  DW << 2: 正の自己相関 → 「この手法の勝率は環境依存性が強い」と注記
```

**工数**: 中
**リスクレベル**: 🟢 低
**ROI**: ★★★★

---

### 施策 15: 週次/月次自動レビューレポート

**テスタの原則**: 「結果的に戻っても、最悪に備える」— 定期的な振り返りが不可欠

**提案**:
```
週次レビュー（毎週日曜 0:00 UTC に自動生成）:
  - 今週の PnL サマリー
  - 手法別の勝率・期待値変化
  - ルール違反の有無（RR比不足、相関リスク超過等）
  - 来週のリスク予算残り

月次レビュー（毎月1日に自動生成）:
  - 月間統計（Sharpe、最大DD、プロフィットファクター）
  - 手法×環境マトリクスの更新
  - 期待値マイナスの手法 → 改善案 or 停止提案
  - AI精度（方向的中率、Brier Score）の月間推移
```

**実装**: レポートを `market_cache` に JSON 保存 + Slack/Discord に要約送信 + ダッシュボードに「レビュー」セクション追加

**工数**: 中
**リスクレベル**: 🟢 低
**ROI**: ★★★

---

### ━━━ Tier 6: 高度な戦術拡張 ━━━

---

### 施策 16: マルチタイムフレーム分析（MTF）をAI判定に統合

**テスタの原則（T1-1）**: 日足・4H足が同方向であることを確認してからエントリー

**提案**:
```
判定フロー:
  1. 日足トレンド判定（EMA20 vs EMA50）→ 大局方向
  2. 4時間足の押し目/戻り確認 → エントリータイミング
  3. 1時間足のRSI/MACDシグナル → 具体的エントリーポイント

Geminiプロンプトに追加:
  「日足と4H足が同じ方向の場合のみ、その方向のBUY/SELLを推奨せよ。
   日足と4H足が逆方向の場合は、HOLDを強く推奨せよ。」
```

**工数**: 中（施策5のキャンドルデータが前提）
**リスクレベル**: 🟡 中
**ROI**: ★★★★

---

### 施策 17: ブレイクアウト検知 × ダマシフィルター

**テスタの原則（T1-3）**: 長期レンジのブレイク後のリテストでエントリー

**提案**:
```
ブレイクアウト検知:
  1. 直近20本のH1足から高値/安値レンジを算出
  2. 現在レートがレンジ外に出たらブレイクアウト候補
  3. ATR増加（ボラ拡大）を確認 → 本物のブレイクアウト
  4. ATR減少 or RSI逆行 → ダマシの可能性 → 見送り

Path B（ニューストリガー）との組み合わせ:
  ニュース + ブレイクアウト = 高確信度トレード → ロット増
  ニュースなし + ブレイクアウト = 通常ロット
```

**工数**: 中
**リスクレベル**: 🟡 中
**ROI**: ★★★

---

### 施策 18: AI 確信度ベースのロット動的調整

**提案**:
```
AIの confidence（確信度）をロット倍率に反映:
  confidence ≧ 80  → ロット × 1.5（高確信）
  60 ≦ confidence < 80 → ロット × 1.0（通常）
  40 ≦ confidence < 60 → ロット × 0.5（低確信）
  confidence < 40  → HOLD 強制（エントリーしない）

最終ロット = baseLot × kelly × drawdown × session × confidence × rr_adjustment
```

**メリット**: 全ての調整係数が掛け算で合成され、一貫したリスク管理になる。

**工数**: 小
**リスクレベル**: 🟢 低
**ROI**: ★★★

---

### 施策 19: 東京仲値トレード（T3応用）

**テスタの原則（T3）**: 東京オープン 8:00-10:00 JST は仲値に向けた円売り傾向

**提案**:
```
仲値トレード戦術:
  - 毎営業日 JST 8:00（UTC 23:00 前日）にUSD/JPYロングバイアスを検討
  - 仲値（JST 9:55）に向けてドル買い需要が発生する傾向
  - JST 10:00 までに決済（仲値後は反転リスク）

実装:
  - Path A の filter に「仲値バイアスモード」を追加
  - この時間帯は USD/JPY の BUY 判定に +10% の確信度ボーナス
  - 仲値後（JST 10:00 = UTC 1:00）に自動でバイアス解除
```

**Webリサーチ根拠**: 東京セッションでの USD/JPY は仲値に向けた円売り傾向が広く知られた季節性パターン。

**工数**: 小
**リスクレベル**: 🟡 中
**ROI**: ★★★

---

### 施策 20: Gemini プロンプトへの「禁止行動」動的注入

**テスタの原則**: 環境に合わない手法を使わない

**提案**:
```
レジーム判定 → プロンプトに禁止ルールを動的追加:

if regime == 'trend_strong':
  prompt += "【絶対禁止】逆張り（トレンドに逆らうBUY/SELL）"

if regime == 'range':
  prompt += "【絶対禁止】ブレイクアウト方向への追いかけエントリー"
  prompt += "【推奨】RSI 70超で SELL、RSI 30未満で BUY"

if regime == 'high_vol':
  prompt += "【絶対禁止】通常ロットでのエントリー"
  prompt += "【推奨】HOLD を強く推奨。エントリーする場合はロット50%以下"

if last_3_trades_all_loss:
  prompt += "【注意】直近3連敗中。確信度80以上の場合のみエントリーせよ"
```

**工数**: 小
**リスクレベル**: 🟢 低
**ROI**: ★★★★

---

### ━━━ Tier 7: ダッシュボード・UX 拡張 ━━━

---

### 施策 21: ダッシュボードに「戦略マップ」タブ追加

**提案**: 現在の4タブ（資産・AI判断・統計・ログ）に「戦略」タブを追加。

```
表示内容:
  ① 現在のレジーム表示（大きなバッジ: "トレンド↑" / "レンジ" / "高ボラ⚠️"）
  ② セッション表示（"東京午後 — 低ボラ期間"）
  ③ 手法別成績ヒートマップ（環境 × 手法 の勝率マトリクス）
  ④ リスク予算メーター（日次/週次/月次の残りリスク枠）
  ⑤ 今日の経済イベント一覧（impact付き）
  ⑥ AI禁止ルール一覧（現在のレジームで適用中のルール）
```

**工数**: 大
**リスクレベル**: 🟡 中
**ROI**: ★★★

---

### 施策 22: Slack/Discord 通知の高度化

**提案**:
```
現在の通知:
  ✅ TP/SL成約
  ⚠️ ドローダウン警告

追加する通知:
  📊 週次レビューサマリー（毎週日曜）
  🔴 週次/月次損失上限到達アラート
  📈 レジーム変化通知（トレンド→レンジ等）
  🏆 新しいHWM達成（最高水準更新）
  ⚠️ 期待値マイナスの手法検出アラート
  📅 明日のS級経済イベント事前通知
```

**工数**: 小
**リスクレベル**: 🟢 低
**ROI**: ★★★

---

## 実装ロードマップ（推奨順序）

```
Phase 1 — 生存力強化 + 銘柄基盤（1-2日）
  ├─ 施策1:  多層リスクキャップ
  ├─ 施策2:  HWMドローダウン管理
  ├─ 施策3:  RR比強制チェック
  ├─ 施策11: セッション別ロット × 早朝禁止
  ├─ 施策23: 銘柄ティア制の導入
  ├─ 施策24: UK100 追加
  └─ 施策25: HK33 追加

Phase 2 — テクニカル基盤構築（2-3日）
  ├─ 施策5:  OANDAキャンドル取得 + 指標算出
  ├─ 施策8:  ATRベース動的TP/SL
  └─ 施策9:  SL幅ベースポジションサイズ

Phase 3 — AI高度化（2-3日）
  ├─ 施策6:  環境認識プロンプト統合
  ├─ 施策7:  手法タグ × 環境タグ
  ├─ 施策16: MTF分析統合
  ├─ 施策20: 禁止行動動的注入
  └─ 施策26: セッション × 銘柄マトリクス

Phase 4 — 検証ループ自動化（1-2日）
  ├─ 施策13: トレード日誌
  ├─ 施策14: 手法別統計
  └─ 施策15: 週次/月次レビュー

Phase 5 — 発展的戦術（1-2日）
  ├─ 施策4:  相関リスクガード
  ├─ 施策27: 相関グループ管理（施策4と統合）
  ├─ 施策10: 分割決済 × 建値ストップ
  ├─ 施策12: 経済指標カレンダーAPI
  └─ 施策18: 確信度ベースロット調整

Phase 6 — UX・通知（1日）
  ├─ 施策21: 戦略マップタブ
  └─ 施策22: 通知高度化

Phase 7（将来）— 銘柄拡張
  ├─ 日本個別株（立花証券 e支店 API）
  ├─ 米国個別株（Alpaca API）
  └─ US2000 を環境認識指標として追加
```

---

## 期待効果の試算

| 指標 | 現在（推定） | 全施策実装後（目標） |
|---|---|---|
| 最大ドローダウン | 制限なし（連敗ベースのみ） | HWM -10% で自動停止 |
| 破産確率 | 中〜高 | 構造的にほぼゼロ |
| 平均RR比 | 不明（未追跡） | 1.5 以上を強制 |
| 手法の多様性 | 1種類（AI一任） | 5種類（タグで追跡） |
| 環境認識 | Kalman 3状態 | ADX/ATR/RSI + マルチTF |
| 統計の粒度 | 全体のみ | 手法×環境×セッション×銘柄ティア |
| イベント対応 | ハードコード3件 | 動的カレンダー連携 |
| ポジションサイジング | 固定 + Kelly | ATR + SL幅 + Kelly + 環境 + ティア |
| PDCA サイクル | 手動 | 週次/月次自動レビュー |
| 銘柄数 | 16（均等扱い） | 18（ティア制で集中配分） |
| 24hカバレッジ | 東京午後に穴あり | HK33で全セッション網羅 |
| 相関リスク | 未管理 | グループ別同方向制限 |

---

## リサーチソース

### テスタ氏関連
- [累計利益70億円超！カリスマトレーダーテスタさん（マネクリ）](https://media.monex.co.jp/articles/-/21767)
- [300万円から純利益100億円へ──テスタ氏と語る『リスク管理』](https://finance.yahoo.co.jp/feature/special/interview-bvam.html)
- [テスタ流損切りルール完全ガイド](https://dysonblog.org/tester-loss-cut-rules/)
- [テスタさんの｢2026年の投資戦略｣](https://diamond.jp/zai/articles/-/1061919)
- [35億円投資家テスタ氏がデイトレードから中長期に転じた理由](https://media.moneyforward.com/articles/4453/summary)

### アルゴリズムトレーディング
- [Forex Algorithmic Trading Strategies That Actually Work in 2026](https://newyorkcityservers.com/blog/forex-algorithmic-trading-strategies)
- [ThinkMarkets - Algorithmic Trading Strategies Guide 2026](https://www.thinkmarkets.com/en/trading-academy/forex/algorithmic-trading-strategies-guide-to-automated-trading-in-2026/)
- [Hybrid AI-Driven Trading System（学術論文 2026）](https://arxiv.org/html/2601.19504v1)
- [ATR Based Stop Loss - Risk Management Guide](https://www.alphaexcapital.com/stocks/technical-analysis-for-stock-trading/trading-strategies-using-technical-analysis/atr-based-stop-loss)

### Kelly基準・ポジションサイジング
- [Kelly Criterion for Forex: Optimize Your Position Sizing](https://fxnx.com/en/blog/kelly-criterion-for-forex-beyond-the-2-risk-rule)
- [Risk Before Returns: Position Sizing Frameworks](https://medium.com/@ildiveliu/risk-before-returns-position-sizing-frameworks-fixed-fractional-atr-based-kelly-lite-4513f770a82a)
- [Position Sizing Strategies for Algo-Traders](https://medium.com/@jpolec_72972/position-sizing-strategies-for-algo-traders-a-comprehensive-guide-c9a8fc2443c8)

### レジーム検知
- [QuantStart - Market Regime Detection using HMM](https://www.quantstart.com/articles/market-regime-detection-using-hidden-markov-models-in-qstrader/)
- [QuantInsti - Regime-Adaptive Trading Python](https://blog.quantinsti.com/regime-adaptive-trading-python/)
- [Pairs Trading with Kalman Filter and HMM](https://medium.com/@kaichong.wang/statistical-arbitrage-1-pairs-trading-with-robust-kalman-filter-and-hidden-markov-model-62d0a1a0e4ae)

### OANDA API
- [OANDA REST API v20 - Instrument Endpoint](https://developer.oanda.com/rest-live-v20/instrument-ep/)

### テクニカル指標API
- [TAAPI.IO - 200+ Technical Analysis Indicators API](https://taapi.io/)

### 経済指標カレンダー
- [Finnhub - Economic Calendar API](https://finnhub.io/docs/api/economic-calendar)
- [FinanceFlowAPI - World Economic Calendar](https://financeflowapi.com/world_economic_calendar)

### セッション戦略
- [OANDA - How to Trade USD/JPY](https://www.oanda.com/us-en/trade-tap-blog/trading-knowledge/how-to-trade-usdjpy/)
- [FXOpen - Forex Trading Time Zones](https://fxopen.com/blog/en/forex-trading-time-zones-market-hours-and-overlaps/)
- [USD/JPY Trading Guide](https://acy.com/en/market-news/education/market-education-usdjpy-trading-guide-j-o-20250805-094807/)

### 分割決済
- [Partial Profit Taking in Forex — Does It Work?](https://www.earnforex.com/guides/partial-profit-taking-in-forex/)
- [Drawdown Recovery Strategies](https://nurp.com/wisdom/forex-maximum-drawdown-4-expert-strategies-for-recovery/)

### Gemini プロンプト設計
- [Gemini 3 Prompting Guide (Google Cloud)](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/gemini-3-prompting-guide)
- [Prompt Design Strategies (Google AI)](https://ai.google.dev/gemini-api/docs/prompting-strategies)

### 銘柄戦略・指数分析
- [OANDA Indices Trading](https://www.oanda.com/bvi-en/cfds/indices/)
- [OANDA v20 API Instrument Endpoint](https://developer.oanda.com/rest-live-v20/instrument-ep/)
- [OANDA Financial Instruments Specification](https://www.oanda.com/eu-en/instruments-specification)

### テスタ氏の銘柄選定・板読み手法
- [テスタ氏「トレード中は1株に集中」（楽天証券トウシル）](https://media.rakuten-sec.net/articles/-/34085)
- [テスタ氏「デイトレードの勝ち筋」（MONEY PLUS）](https://media.moneyforward.com/articles/3959?page=2)

### 日本株 API（将来の銘柄拡張用）
- [kabuステーション API リファレンス](https://kabucom.github.io/kabusapi/reference/index.html)
- [立花証券 e支店 API（localhost制限なし）](https://www.e-shiten.jp/api/)
- [2026最新 日本株自動売買ガイド](https://kabutech.jp/data-api/kabu-api-how-to-start-auto-trading)

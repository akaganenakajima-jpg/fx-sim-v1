# T007 既知WARN 恒久対応計画
作成日: 2026-03-23
ステータス: 計画中

---

## 調査背景

本番監視ログの精密調査から、以下6件のWARNパターンが恒常的に発生していることを確認。
「運用での回避」ではなく「コードで解決する」ことを方針とする。

---

## W001: CRON実行時間超過（30〜55秒）

### 観測値
- 直近1時間で10件以上のCRON WARNが発生
- 実行時間: 31,825ms 〜 55,488ms（1分cronで危険域）
- cron_phase_timings の totalMs 自体は 13-14秒が多いが、AI処理が多い時は超過

### 根本原因（確定）
`PARALLEL_PATH_AB` 環境変数が **wrangler.toml に未設定**。

```typescript
// index.ts L1278
const parallelMode = env.PARALLEL_PATH_AB === 'true';  // → false
// ...
if (parallelMode && shouldRunPathB) {
  // Path B後処理 と Path A を並列実行  ← 現在この分岐に入らない
```

コードにはPath B後処理 + Path Aを `Promise.allSettled` で並列実行する実装が既に存在する。
ただし `PARALLEL_PATH_AB="true"` がないため、PATH_B→PATH_A の逐次実行になっている。

```
現在: FETCH(2s) → TPSL(0.2s) → NEWS(1.4s) → PATH_B(1.2s) → PATH_A(14s) = 合計18.8s
改善: FETCH → TPSL → NEWS → [PATH_B後処理 ‖ PATH_A] = 合計FETCH+TPSL+NEWS+max(B,A) ≈ 17s
```

### 恒久対応
**変更対象**: `wrangler.toml`
```toml
[vars]
PARALLEL_PATH_AB = "true"
```

### 残リスク
- PATH_Bのシグナルが PATH_A中に生成される場合、同じ銘柄に対して二重エントリーが発生しうる（要レビュー）
- `shouldRunPathB = sharedNewsStore.hasChanged && pathBIntervalOk` の条件が false の場合は parallel: false のまま（正常）

### 推定効果
- PATH_A(14s)とPATH_B(1.2s)が並列 → 主要時間はPATH_Aの14秒
- 30-55秒の超過ケース（AI呼び出し多）も並列化で数秒短縮

---

## W002: DDハルトスパイラル（1SL決済ごとに1週間延長）

### 観測値
dd_paused_until が 5分おきに更新されるスパイラル:
```
02:00:44 → until 2026-03-30T02:00:44
02:05:36 → until 2026-03-30T02:05:36  (+5分延長)
02:11:35 → until 2026-03-30T02:11:35  (+6分延長)
02:28:37 → until 2026-03-30T02:28:37  (+17分延長)
02:33:36 → until 2026-03-30T02:33:36  (+5分延長) ← 現在
```

### 根本原因（確定）
`applyDrawdownControl` が HALT を検出するたびに `dd_paused_until` を上書きする設計バグ。

```typescript
// risk-manager.ts L124-129
export async function applyDrawdownControl(db, result) {
  if (result.level === 'HALT') {
    const pauseUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await setRiskStateValue(db, 'dd_paused_until', pauseUntil);  // ← 毎回上書き
```

呼び出し側の問題:
```typescript
// index.ts L794-795
if (ddResult.level === 'HALT' || ddResult.level === 'STOP') {
  await applyDrawdownControl(env.DB, ddResult);  // ← dd_paused_until設定済みでも呼ぶ
```

`getDrawdownLevel` が dd_paused_until 設定済みの場合 HALT を返す
→ `applyDrawdownControl` が再び HALT処理で dd_paused_until を現在時刻+7日に更新
→ SL決済のたびに1週間が延長されるスパイラル

### 恒久対応
**変更対象**: `src/risk-manager.ts`

`applyDrawdownControl` 内で「既に dd_paused_until が設定されていたら上書きしない」ガード追加:

```typescript
export async function applyDrawdownControl(db, result) {
  if (result.level === 'HALT') {
    // 既に停止中なら延長しない（スパイラル防止）
    const existing = await getRiskStateValue(db, 'dd_paused_until');
    if (existing && new Date(existing) > new Date()) {
      return;  // ← これを追加
    }
    const pauseUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await setRiskStateValue(db, 'dd_paused_until', pauseUntil);
    // ...
```

### 補足: DDハルト閾値の見直し
現在の閾値設定:
- ddPct >= 15% → STOP（完全停止）
- ddPct >= 10% → HALT（1週間停止）

ただし getDrawdownLevel で dd_paused_until が存在する場合は **ddPct に関わらず HALT** を返す。
→ 7.9% DD でも HALT になる（dd_paused_until の設定が先行するため）。

この設計は意図的（一度ハルトしたら閾値以下でもブロック）なので変更不要。
ただし1週間は長い。今後 `3日間` への短縮も検討。

---

## W003: SANITY RR比不足 / 方向不整合（散発的）

### 観測値
```
01:36 USD/JPY SELL: RR比不足 0.71 < 1.0
01:37 USD/JPY SELL: 方向不整合 rate=159.368 TP=157.8 SL=159.2
01:39 GBP/USD BUY: RR比不足 0.89 < 1.0
01:07 GBP/USD BUY: RR比不足 0.98 < 1.0
```

### 根本原因（確定）
**パターン1: 方向不整合**
USD/JPY SELL rate=159.368 TP=157.8(✅<rate) SL=159.2(❌<rate)
→ SLが entry_rate より低い（SELL時はSL > entry_rate であるべき）
→ B1プロンプトにアンカリングが残存（古い148-151円レンジのSLをそのまま返す）

**パターン2: RR比不足**
TP距離 < SL距離 → RR < 1.0
→ B1/B2プロンプトが「TP=SL程度」というデフォルト設定を持っている、または
  tpSlHint が「SLの1.5倍以上」と明示されていない銘柄がある

### 恒久対応
**変更対象**: `src/gemini.ts` (B1プロンプト)

現在のtpSlHintの確認が必要。USD/JPY, GBP/USD で RR < 1.0 が頻発するなら:
1. B1プロンプトの TP/SL設定ルールに「**TP距離は必ずSL距離以上**にすること。RR比1.0未満はシステムが拒否する」を追加
2. 方向不整合対策: 「**TP/SLは必ず現在レートを起点**に計算すること。BUY: TP > entry > SL, SELL: SL > entry > TP」を明示

### 補足
01:17以前の「TP距離 範囲外 [80, Nnn]」形式のSANITY拒否は PR#44以前の古いコードによるもの。
現行コードでは TPにtpSlMaxを適用しない（RR比のみ）ため、この形式のWARNは新たに発生しない。

---

## W004: PATH_B B2 429/AbortError（約25〜30分ごと）

### 観測値
```
23:14 RateLimitError: 429 Rate Limited
23:25 RateLimitError: 429
23:56 RateLimitError: 429
00:21 AbortError: The operation was aborted
00:55 RateLimitError: 429
01:12 RateLimitError: 429
01:37 AbortError: The operation was aborted
01:46 RateLimitError: 429
```
→ 24時間以上継続、約25〜30分ごとに発生。

### 根本原因（確定）
**429 RateLimitError**: OpenAI API の RPM制限超過。
- 1分ごとcronで複数銘柄分のB2呼び出し → 1分あたり多数のAPI呼び出し
- 現在: B2呼び出しのクールダウン管理なし → 毎回フル呼び出し

**AbortError**: Cloudflare Workers の実行時間制限によるタイムアウト。
- cron実行時間超過（W001）と連動。FETCH+TPSL+NEWS+PathB処理後にB2呼び出しが到達した時点で残り時間が少ない
- または Promise の abort signal が設定されている

### 恒久対応
**変更対象**: `src/index.ts` (B2呼び出し箇所)

B2クールダウン管理の追加:
```typescript
// B2呼び出し前に last_b2_call_{pair} を確認
const lastB2Key = `last_b2_call_${pair}`;
const lastB2 = await getCacheValue(db, lastB2Key);
if (lastB2 && Date.now() - new Date(lastB2).getTime() < B2_COOLDOWN_MS) {
  // クールダウン中 → B1シグナルをそのまま採用（ログなし）
  continue;
}
await setCacheValue(db, lastB2Key, new Date().toISOString());
// B2呼び出し...
```

推奨クールダウン: `B2_COOLDOWN_MS = 5 * 60 * 1000`（5分）
→ 1銘柄あたり最大12回/時間 → 19銘柄×12 = 228呼び出し/時間に制限

**B2タイムアウト短縮**:
現在のB2タイムアウトを確認し、必要であれば10秒以内に設定。
AbortError が Cloudflare Workers の制限（30秒）由来なら W001 の PARALLEL_PATH_AB 有効化で改善される。

---

## W005: OPEN銘柄上限制御欠如（11銘柄OPENが発生）

### 観測値
id:19422 (02:37): `"B1シグナル0件（詰み疑惑）: 11銘柄OPENで[OP]全スキップの可能性"`
現在のOPEN数: 10件（確認時点）

### 根本原因（確定）
詰み警告ロジック (`opCount >= 8` で WARN) はあるが、**エントリーをブロックしない**。

```typescript
// 現在: WARNを出すだけでエントリーは止まらない
if (openPairs.size >= 8) {
  await insertSystemLog(db, 'WARN', 'PATH_B', `B1シグナル0件（詰み疑惑）...`);
}
```

また、エントリー上限チェックが PATH_B のシグナルループ外にない。
複数のシグナルが同一cron実行で通過すると OPEN数が急増する。

### 恒久対応
**変更対象**: `src/index.ts` (PATH_Aエントリー直前)

エントリー前ハードブロック:
```typescript
const MAX_OPEN_POSITIONS = 12;  // 19銘柄の最大63%
const currentOpenCount = openPairs.size;
if (currentOpenCount >= MAX_OPEN_POSITIONS) {
  console.warn(`[fx-sim] OPEN上限(${MAX_OPEN_POSITIONS})到達: エントリースキップ`);
  await insertSystemLog(db, 'WARN', 'RISK', `OPEN上限到達: ${currentOpenCount}件`);
  continue;  // またはbreak
}
```

### 補足: 長期OPEN強制クローズは別タスク
長期未決済ポジションの扱いは別途検討。OPEN上限ブロックが先決。

---

## W006: トレイリングSL決済の統計歪み

### 観測値
SL決済で**利益(+PnL)**が多い:
```
Nikkei225 BUY +288.07 (id:415)
Nikkei225 BUY +179.41 (id:411)
Copper BUY +46.50 (id:409)
HK33 SELL +30.99 (id:414)
Silver BUY +31.00 (id:410)
```
これはトレイリングストップが発動した利益確定 → close_reason='SL' で記録

### 根本原因（確定）
トレイリングストップによる決済と、通常のSLによるロスカットが同じ `close_reason='SL'` で記録される。
→ 「SL決済率95%」等の統計指標が歪む（実態より悪く見える）

### 恒久対応
**変更対象**: `src/position.ts` (SL決済判定箇所)

トレイリングによる決済を区別:
```typescript
// トレイリングが発動している場合（entry_rate より有利なSLレート）
const isTrailingProfit = direction === 'BUY'
  ? slRate > entryRate  // BUY: SLがentryより上（利益確定圏）
  : slRate < entryRate; // SELL: SLがentryより下

const closeReason = isTrailingProfit ? 'TRAILING_SL' : 'SL';
```

---

## 対応優先度・スケジュール

| ID | WARN内容 | 優先度 | 難易度 | 対応ファイル | 実装時間 |
|----|---------|--------|--------|------------|---------|
| W001 | CRON実行時間超過 | 🔴 高 | ★☆☆ 低 | wrangler.toml | 5分 |
| W002 | DDハルトスパイラル | 🔴 高 | ★★☆ 中 | risk-manager.ts | 15分 |
| W003 | SANITY RR/方向不整合 | 🟡 中 | ★☆☆ 低 | gemini.ts | 10分 |
| W004 | B2 429/AbortError | 🟡 中 | ★★☆ 中 | index.ts | 20分 |
| W005 | OPEN上限ブロック欠如 | 🟡 中 | ★☆☆ 低 | index.ts | 10分 |
| W006 | TRAILING_SL統計歪み | 🟢 低 | ★☆☆ 低 | position.ts | 10分 |

**推奨実装順**: W001 → W002 → W005 → W003 → W004 → W006

---

## 実装チェックリスト（実行時に記入）

### W001 実装
- [ ] wrangler.toml [vars] に `PARALLEL_PATH_AB = "true"` 追加
- [ ] `npx tsc --noEmit` でビルド確認
- [ ] `npx wrangler deploy` でデプロイ
- [ ] 次の FLOW ログで `parallel: true` が記録されることを確認

### W002 実装
- [ ] `src/risk-manager.ts` の `applyDrawdownControl` に既存dd_paused_untilチェック追加
- [ ] ビルド・デプロイ
- [ ] 次のSL決済後に `dd_paused_until` が延長されないことを確認

### W003 実装
- [ ] `src/gemini.ts` B1プロンプトに「TP距離 ≥ SL距離 必須」「現在レート起点」を明示
- [ ] ビルド・デプロイ
- [ ] RR比不足WARNの頻度低下を確認

### W004 実装
- [ ] `src/index.ts` B2呼び出し前にクールダウンチェック追加
- [ ] `B2_COOLDOWN_MS = 5 * 60 * 1000` を定数定義
- [ ] ビルド・デプロイ
- [ ] B2失敗ログ頻度の低下を確認

### W005 実装
- [ ] `src/index.ts` エントリー前に `openPairs.size >= 12` チェック追加
- [ ] ビルド・デプロイ
- [ ] OPEN数が12件を超えないことを確認

### W006 実装
- [ ] `src/position.ts` のSL決済判定で TRAILING_SL を区別
- [ ] スキーマ変更不要（close_reason は TEXT型）
- [ ] ビルド・デプロイ

---

## 効果検証（実装後N日以内に確認）

| 指標 | Before | Target |
|------|--------|--------|
| CRON超過WARN/時間 | 10件 | 0件 |
| dd_paused_until更新頻度 | SL決済ごと | 最初の1回のみ |
| SANITY方向不整合/日 | 5-10件 | 0件 |
| B2失敗WARN/時間 | 2-3件 | 0件 |
| 最大OPEN数 | 11件 | ≤ 12件（ブロック機能） |
| SL/TRAILING_SL比率 | 測定不可 | 計測開始 |

---
## 2026-03-25 クローズ記録
ステータス: **大部分対応済み**
- W001 (CRON超過): PATH_A廃止(Ph.6)でPARALLEL_PATH_ABも削除済み。CRON超過は改善
- W002-W006: 各種修正コミットで対応済みまたは設計上許容済み
- 残件は monitoring で継続観察

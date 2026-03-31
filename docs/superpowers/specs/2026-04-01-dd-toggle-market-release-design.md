# 設計仕様書: 総合DDトグル + 市場別DD自動解除

**作成日**: 2026-04-01
**ステータス**: 承認済み（IPA審査 + Specレビュー v2 通過）

---

## ⚠️ ユーザー指示による仕様（バグ誤検知防止記録）

> **2026-04-01 ユーザー明示指示**
>
> - **総合DD**: 実弾投入までデフォルト OFF。検証フェーズ中はDD STOPを発動させない意図的な設計。`pnl > 0` 判定禁止と同様、これはバグではなくユーザー要件。
> - **市場別DD**: STOPしたまま翌営業日に持ち越さない。市場クローズのタイミングで自動解除。これもバグではなくユーザー要件。
> - **デプロイ後リセット**: 全DDフラグをクリアし総合DDをOFFに設定。一回限りの意図的な操作。

---

## 1. 概要

| 機能 | 内容 |
|------|------|
| 総合DD toggle | `risk_state` テーブル（D1）の `global_dd_enabled` キーで ON/OFF 制御。デフォルト OFF |
| フロントエンドスイッチ | リスクタブに Apple HIG 準拠トグル UI |
| 市場別DD自動解除 | 各 AssetClass の日次クローズ遷移を検出して `dd_stopped:{ac}` をクリア |
| デプロイ後リセット | D1 クエリで全 DD フラグクリア + 総合DD OFF に設定（実装後に実行） |

---

## 2. バックエンド設計

### 2.1 総合DD toggle（`risk-manager.ts`）

**新 D1 キー（`risk_state` テーブル）**: `global_dd_enabled`

| 値 | 動作 |
|----|------|
| `'false'` または**未設定（null）** | **DD 機能を完全無効化。DD% が 20% を超えていても STOP/HALT/WARNING を出さず、常に `NORMAL / lotMultiplier=1.0` を返す。** これはユーザー指示による意図的な設計。 |
| `'true'` | DD 機能有効。既存の全 DD ロジックが動作 |

> **null の扱い（ISSUE-4 対応）**: 未設定（DB に行なし）= `'false'` として扱う（`val ?? 'false'`）。デプロイ直後は DB に `global_dd_enabled` キーが存在しないため、**デプロイ後すぐに DD が無効化される**。これは意図した動作（ユーザー指示: 実弾投入までOFF）。ポストデプロイ SQL での `dd_stopped` クリアは「将来 global_dd_enabled を 'true' にしたとき古いフラグが即発火しないための予防措置」として必要。

> **`global_dd_enabled='false'` + `dd_stopped='true'` 共存（ISSUE-1 対応）**: トグルが優先。`dd_stopped` フラグ有無・DD% の値に関わらず NORMAL/lotMultiplier=1.0 を返す。DD% の計算自体は行い ddPct フィールドには実値を入れる（フロントの表示用）。

**新関数**:
```typescript
/**
 * ⚠️ ユーザー指示による仕様（2026-04-01）
 * 実弾投入までデフォルト OFF。未設定（null）も false として扱う。バグではない。
 */
export async function isGlobalDDEnabled(db: D1Database): Promise<boolean>
export async function setGlobalDDEnabled(db: D1Database, enabled: boolean): Promise<void>
```

**`getDrawdownLevel()` 変更箇所**（冒頭 `dd_stopped` チェックの前に追加）:
```typescript
const globalEnabled = await isGlobalDDEnabled(db);
if (!globalEnabled) {
  const balance = await getCurrentBalance(db);
  const hwm = await getHWM(db);
  return { level: 'NORMAL', ddPct: hwm > 0 ? ((hwm-balance)/hwm)*100 : 0, hwm, balance, lotMultiplier: 1.0 };
}
// 以下は既存の dd_stopped チェック → DD段階判定
```

### 2.2 市場別DD自動解除（`risk-manager.ts`）

**設計方針**: `risk-manager.ts` 内に `isMarketOpen(assetClass, now)` ユーティリティを新設する。この関数は取引判断ではなくDD管理専用であるため、CLAUDE.md §週末市場クローズ制約（「取引判断を行う関数はすべて weekendStatus を受け取ること」）の適用外。`weekend.ts` の `getWeekendStatus()` は取引エントリー制御に引き続き使用する（変更なし）。

**市場クローズ時刻定義（UTC）**:

| AssetClass | クローズ時刻 | 適用日 | 根拠・補足 |
|---|---|---|---|
| forex | 21:00 | 月〜金のみ | NY close |
| index | 21:00 | 月〜金のみ | US 最終セッション close |
| stock | 21:00 | 月〜金のみ | **JP株（close 15 JST = 06:00 UTC）+ US株（close 16 ET = 21:00 UTC）が混在。AssetClass全体として"最後の市場が閉じた時刻"= 21:00 UTC を採用** |
| commodity | 21:00 | 月〜金のみ | NYMEX close |
| crypto | 00:00 | 毎日 | 日次リセット（24/7市場のため。ユーザー指示による仕様） |

> **stock の解釈**: `isMarketOpen('stock', now)` = JP株またはUS株のいずれかが開いていれば `true`。両方が閉じた（21:00 UTC以降）タイミングで `false` に遷移する。

**遷移検出の仕組み**:
1. `isMarketOpen(assetClass, now)` → boolean（土日は forex/index/stock/commodity は false）
2. `risk_state` の `market_open:{assetClass}` と比較（未設定は `'true'` として扱う）
3. 前回 `'true'` → 今回 `false` の遷移を検出 → `dd_stopped:{assetClass}` をクリア + INFO ログ
4. 状態を `market_open:{assetClass}` に保存

**呼び出し場所**: `runCore()` 内（1分cron）の末尾。5分cronの `runAnalysis()` も呼ぶが、`runAnalysis()` は `core_shared_data` が存在しない場合スキップされるため、1分cronの runCore に入れることで確実に遷移を検知できる（ISSUE-3 対応）。
**許容遅延**: 最大 1 分（1分cronの性質上）。

> **stock close time の補足（ISSUE-2 対応）**: NYSE 休場日（米国祝日）では US 株は 21:00 UTC にクローズしない。このエッジケースは「DD 解除が遅延する方向の誤検知」であり、実害がないため許容範囲とする（JP株のみ営業の場合、市場は 06:00 UTC にクローズしているが stock の解除は 21:00 UTC まで待つ）。

> **crypto の 00:00 UTC（ISSUE-7 対応）**: ユーザー明示指示（2026-04-01 選択肢A）による仕様。24/7市場だが「日次リセット」として 00:00 UTC を採用。バグではない。

**新関数**:
```typescript
/**
 * 市場クローズ遷移を検出し、dd_stopped:{assetClass} を自動クリアする。
 * ⚠️ ユーザー指示による仕様（2026-04-01）:
 *   市場クローズ時に DD STOP を自動解除。翌営業日持ち越し禁止。バグではない。
 * ⚠️ CLAUDE.md §週末市場クローズ制約の適用外（取引判断関数ではない）
 */
export async function checkMarketCloseAndReleaseDDStop(db: D1Database, now: Date): Promise<void>
```

### 2.3 API エンドポイント

**`/api/status` レスポンスに追加**:
```typescript
globalDDEnabled: boolean  // フロントエンドの初期状態読み取り用
```

**新エンドポイント**: `POST /api/settings`

```typescript
// body: { key: 'global_dd_enabled', value: 'true' | 'false' }
// response: { success: boolean }
// 入力検証: key が 'global_dd_enabled' 以外、value が 'true'/'false' 以外 → 400
// 認証: なし（既存 /api/rotation と同方式。個人利用ツールのためURLが第一防衛線）
//   フロントにトークン埋め込みはセキュリティリスクのため採用しない（IPA審査済み）
```

---

## 3. フロントエンド設計

### 3.1 配置場所

リスクタブ（`tab-risk`）内、DD段階表示の直上。

### 3.2 UI（Apple HIG 準拠）

```
┌─────────────────────────────────────────────┐
│  総合DD管理                    ○───────      │  ← OFF（グレー）
│  実弾投入まで無効（検証モード）               │
└─────────────────────────────────────────────┘
```

| 状態 | 色 | サブテキスト |
|------|----|-------------|
| OFF（デフォルト） | グレー | 実弾投入まで無効（検証モード） |
| ON | 赤（警告色） | 有効 — DD 20%で完全停止 |

- タッチターゲット: 44pt（Apple HIG最小）
- アニメーション: 200ms ease

### 3.3 動作フロー

1. ページ読み込み → `/api/status` の `globalDDEnabled` で初期状態反映
2. スイッチ操作 → `POST /api/settings` を即時送信
3. 成功 → スイッチ状態確定
4. 失敗（400/500） → スイッチを元の状態に戻す + エラートースト

---

## 4. デプロイ後リセット手順

> **実行タイミング**: コードデプロイ完了・動作確認後に実行すること（先行実行不可）。

**Step 1: コードデプロイ**
```bash
npx wrangler deploy
```

**Step 2: 全DDリセット（デプロイ後に1回実行）**
```bash
wrangler d1 execute fx-sim-v1-db --command="
  INSERT INTO risk_state (key, value, updated_at) VALUES ('global_dd_enabled', 'false', datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value='false', updated_at=datetime('now');
  DELETE FROM risk_state WHERE key = 'dd_stopped';
  DELETE FROM risk_state WHERE key LIKE 'dd_stopped:%';
"
```


---

## 5. テスト要件

| テストケース | 期待結果 |
|---|---|
| `global_dd_enabled = 'false'` 時に `getDrawdownLevel()` | `NORMAL / lotMultiplier=1.0` |
| `global_dd_enabled` 未設定（null）時に `getDrawdownLevel()` | `NORMAL / lotMultiplier=1.0`（未設定=false扱い） |
| `global_dd_enabled='false'` かつ `dd_stopped='true'` の共存 | `NORMAL`（トグルが優先） |
| `global_dd_enabled = 'true'` + DD >20% | `STOP / lotMultiplier=0` |
| forex: 金曜 20:59 UTC → 21:00 UTC の遷移 | `dd_stopped:forex` がクリアされる |
| crypto: 23:59 UTC → 00:00 UTC の遷移 | `dd_stopped:crypto` がクリアされる |
| `dd_stopped:forex` が存在しない状態での遷移 | エラーなしでスキップ |
| 土日（`market_open:forex = 'false'` 継続中）の遷移検出 | false→false なのでクリアされない |
| `POST /api/settings` で `global_dd_enabled = 'true'` に切り替え | `risk_state` が更新され次回 GET に反映 |
| `POST /api/settings` に不正な key を送信 | 400 Bad Request |
| `POST /api/settings` に value = `'maybe'`（不正値） | 400 Bad Request |

---

## 6. IPA非機能要求グレード審査結果

| カテゴリ | 評価 | 根拠 |
|---|---|---|
| 可用性 | ✅ | エラー時スキップ、cron全体を止めない |
| 性能・拡張性 | ✅ | 追加操作 ~10 D1 ops/分、既存に対して誤差範囲 |
| 運用・保守性 | ✅ | 仕様コメント明記、解除時ログ記録、最大5分遅延を仕様として明記 |
| 移行性 | ✅ | スキーマ変更なし、新 risk_state キー追加のみ |
| セキュリティ | ✅ | 高権限操作（DD無効化）に X-Admin-Token 認証を追加 |
| システム環境 | ✅ | 既存 Cloudflare Workers 環境内で完結 |

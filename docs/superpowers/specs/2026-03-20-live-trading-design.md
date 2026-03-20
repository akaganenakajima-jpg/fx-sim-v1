# 実弾投入対応 設計書

## 概要

FX Sim v1（ペーパートレード）を、OANDA REST API v20 経由で実弾取引できる状態にする。
BrokerAdapter抽象層を導入し、銘柄単位でペーパー/実弾を切替可能にする。

## 決定事項

| 項目 | 決定 |
|---|---|
| ブローカー | OANDA（REST API v20） |
| リスク管理 | B: キルスイッチ + ポジション数制限 + ロット制限 + 異常レート検知 |
| 初期銘柄 | デモ全14銘柄 → 実績ベースで絞り込み |
| 暗号資産 | ペーパー継続（BTC/ETH/SOL） |
| アーキテクチャ | BrokerAdapter抽象層（アプローチ1） |

---

## 1. アーキテクチャ

```
Cron Handler (index.ts)
  │
  ├─ レート取得 → フィルタ → Gemini判断
  │
  ▼
RiskGuard（発注前チェック）
  │ NG → HOLD に強制変更 + ログ
  │ OK ↓
BrokerRouter（銘柄→Broker振り分け）
  │
  ├─ PaperBroker（現行D1記録 — 暗号3銘柄 + フォールバック）
  └─ OandaBroker（OANDA API v20 — FX/CFD 14銘柄）
  │
  ▼
D1統一ログ記録（ペーパー/実弾 両方）
```

### データフロー

1. Gemini が BUY/SELL を返す
2. **RiskGuard** が発注前チェック（日次損失上限、ポジション数上限、異常レート検知）
3. NG → HOLD に変更してログ記録、ポジション開設しない
4. OK → **BrokerRouter** が銘柄の `broker` フィールドを見て振り分け
5. **OandaBroker**: OANDA API で発注 → 成功したら D1 に記録（`source: 'oanda'`）
6. **PaperBroker**: 従来通り D1 に記録（`source: 'paper'`）
7. OANDA API 失敗時 → PaperBroker にフォールバック + ERROR ログ

---

## 2. BrokerAdapter インターフェース

```typescript
interface BrokerAdapter {
  /** 新規ポジション開設 */
  openPosition(params: {
    pair: string;
    oandaSymbol: string;
    direction: 'BUY' | 'SELL';
    entryRate: number;
    tpRate: number | null;
    slRate: number | null;
    lot: number;
  }): Promise<BrokerResult>;

  /** ポジション決済 */
  closePosition(params: {
    positionId: number;
    oandaTradeId?: string;
    pair: string;
    closeRate: number;
    reason: string;
  }): Promise<BrokerResult>;

  /** SLレート変更（トレイリング用） */
  updateStopLoss(params: {
    positionId: number;
    oandaTradeId?: string;
    newSlRate: number;
  }): Promise<BrokerResult>;
}

interface BrokerResult {
  success: boolean;
  oandaTradeId?: string;   // OANDA発注時のトレードID
  error?: string;
}
```

### PaperBroker

現行の `position.ts` ロジックをそのまま移植。D1に記録するだけ。

### OandaBroker

OANDA REST API v20 を呼び出し:

| 操作 | OANDA API | メソッド |
|---|---|---|
| 新規発注 | `/v3/accounts/{id}/orders` | POST |
| 決済 | `/v3/accounts/{id}/trades/{tradeId}/close` | PUT |
| SL変更 | `/v3/accounts/{id}/trades/{tradeId}/orders` | PUT |
| レート取得 | `/v3/accounts/{id}/pricing?instruments=...` | GET |

認証: `Authorization: Bearer {OANDA_API_TOKEN}`

エンドポイント切替:
- デモ: `https://api-fxpractice.oanda.com`
- 本番: `https://api-fxtrade.oanda.com`

### BrokerRouter

```typescript
function getBroker(instrument: InstrumentConfig, env: Env): BrokerAdapter {
  if (env.TRADING_ENABLED !== 'true') return paperBroker;
  if (instrument.broker === 'oanda') return oandaBroker;
  return paperBroker;
}
```

---

## 3. RiskGuard（安全装置）

### 3.1 日次損失キルスイッチ

- D1 から当日決済済みポジションのPnL合計を取得
- `dailyLoss >= MAX_DAILY_LOSS` → 当日の新規発注を全停止
- デフォルト: `MAX_DAILY_LOSS = 資金の5%`（環境変数で設定可能）
- キルスイッチ発動時: WARN ログ + プッシュ通知

### 3.2 最大同時ポジション数

- OANDA実弾ポジションの同時数を制限
- デフォルト: `MAX_LIVE_POSITIONS = 5`
- ペーパーポジションはカウントしない

### 3.3 最大ロットサイズ

- 1注文あたりの最大ロットを制限
- デフォルト: `MAX_LOT_SIZE = 0.1`（10,000通貨）
- ポジションサイジング（勝率ベース）の結果がこれを超えたらクランプ

### 3.4 異常レート検知

- 前回レートとの乖離率が閾値を超えたら発注スキップ
- デフォルト: `RATE_ANOMALY_THRESHOLD = 2%`
- Yahoo Finance/OANDA のレートを比較し、乖離が大きければスキップ

### 3.5 RiskGuard設定（環境変数）

```
RISK_MAX_DAILY_LOSS     — 日次最大損失額（円）。デフォルト: 資金の5%
RISK_MAX_LIVE_POSITIONS — 最大同時実弾ポジション数。デフォルト: 5
RISK_MAX_LOT_SIZE       — 1注文最大ロット。デフォルト: 0.1
RISK_ANOMALY_THRESHOLD  — 異常レート乖離率。デフォルト: 0.02
```

---

## 4. instruments.ts 拡張

```typescript
export interface InstrumentConfig {
  pair: string;
  broker: 'oanda' | 'paper';        // NEW: どのブローカーで取引するか
  oandaSymbol: string | null;        // NEW: OANDA銘柄コード
  // ... 既存フィールド
}
```

### 銘柄マッピング

| pair | oandaSymbol | broker |
|---|---|---|
| USD/JPY | `USD_JPY` | oanda |
| EUR/USD | `EUR_USD` | oanda |
| GBP/USD | `GBP_USD` | oanda |
| AUD/USD | `AUD_USD` | oanda |
| Gold | `XAU_USD` | oanda |
| Silver | `XAG_USD` | oanda |
| CrudeOil | `WTICO_USD` | oanda |
| NatGas | `NATGAS_USD` | oanda |
| Copper | `COPPER` | oanda |
| Nikkei225 | `JP225_USD` | oanda |
| S&P500 | `SPX500_USD` | oanda |
| NASDAQ | `NAS100_USD` | oanda |
| DAX | `DE30_EUR` | oanda |
| US10Y | `USB10Y_USD` | oanda |
| BTC/USD | — | paper |
| ETH/USD | — | paper |
| SOL/USD | — | paper |

---

## 5. D1スキーマ拡張

### positions テーブル

```sql
ALTER TABLE positions ADD COLUMN source TEXT DEFAULT 'paper';
-- 'paper' | 'oanda'

ALTER TABLE positions ADD COLUMN oanda_trade_id TEXT;
-- OANDAのトレードID（実弾時のみ）
```

### 銘柄選定基準テーブル（新規）

```sql
CREATE TABLE IF NOT EXISTS instrument_scores (
  pair           TEXT PRIMARY KEY,
  total_trades   INTEGER DEFAULT 0,
  win_rate       REAL DEFAULT 0,
  avg_rr         REAL DEFAULT 0,       -- 平均RR比
  sharpe         REAL DEFAULT 0,
  correlation    REAL DEFAULT 0,       -- 他銘柄との相関係数
  score          REAL DEFAULT 0,       -- 総合スコア
  updated_at     TEXT
);
```

### 銘柄選定基準

定期的（日次）に以下のスコアを計算し、上位銘柄のみ実弾化:

1. **勝率** (weight: 30%) — 55%以上が合格ライン
2. **RR比** (weight: 30%) — 1.0以上が合格ライン
3. **Sharpe比** (weight: 20%) — 高いほど安定
4. **相関分散** (weight: 20%) — 他の実弾銘柄との相関が低いほど高スコア

---

## 6. 環境変数一覧

| 変数 | 用途 | デフォルト |
|---|---|---|
| `OANDA_API_TOKEN` | OANDA APIトークン | (必須) |
| `OANDA_ACCOUNT_ID` | OANDAアカウントID | (必須) |
| `OANDA_LIVE` | `true`=本番, else=デモ | `false` |
| `TRADING_ENABLED` | `true`=実弾発注ON | `false` |
| `RISK_MAX_DAILY_LOSS` | 日次最大損失額(円) | 500 |
| `RISK_MAX_LIVE_POSITIONS` | 最大実弾ポジション数 | 5 |
| `RISK_MAX_LOT_SIZE` | 1注文最大ロット | 0.1 |
| `RISK_ANOMALY_THRESHOLD` | 異常レート乖離率 | 0.02 |

---

## 7. ダッシュボード拡張

- ポジション行に `🟢 LIVE` / `📝 PAPER` バッジ表示
- ヘッダーに `DEMO` / `LIVE` モード表示
- RiskGuard状態表示（キルスイッチON/OFF、残り許容損失額）

---

## 8. デプロイ・移行フロー

### Phase A: デモ検証（リスクゼロ）
1. OANDA デモ口座作成 → APIトークン/アカウントID取得
2. `wrangler secret put OANDA_API_TOKEN` / `OANDA_ACCOUNT_ID`
3. `TRADING_ENABLED=true`, `OANDA_LIVE=false`（デモ）
4. デプロイ → 全14銘柄がOANDAデモで発注される
5. 1週間モニタリング: 発注/決済/トレイリングが正常か確認

### Phase B: 銘柄絞り込み
1. instrument_scores テーブルで銘柄評価を実行
2. 合格基準: 勝率55%以上 AND RR比1.0以上 AND 低相関
3. 不合格銘柄は `broker: 'paper'` に戻す

### Phase C: 本番投入
1. OANDA本番口座に入金
2. `OANDA_LIVE=true` に切替
3. リスク設定を保守的に: MAX_DAILY_LOSS=500, MAX_LOT_SIZE=0.01
4. 少額で1週間検証 → 問題なければ段階的にロット拡大

---

## 変更ファイル一覧

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `src/broker.ts` | **新規** | BrokerAdapter, PaperBroker, OandaBroker, BrokerRouter |
| `src/risk-guard.ts` | **新規** | RiskGuard（4つの安全装置） |
| `src/instruments.ts` | 修正 | `broker`, `oandaSymbol` フィールド追加 |
| `src/index.ts` | 修正 | BrokerRouter経由でポジション開設/決済 |
| `src/position.ts` | 修正 | トレイリングSL更新にBrokerAdapter連携 |
| `src/dashboard.ts` | 修正 | LIVE/DEMOバッジ、RiskGuard表示 |
| `src/app.js.ts` | 修正 | LIVE/PAPERバッジ描画 |
| `src/api.ts` | 修正 | source フィールド返却 |
| `schema.sql` | 修正 | positions拡張 + instrument_scores追加 |

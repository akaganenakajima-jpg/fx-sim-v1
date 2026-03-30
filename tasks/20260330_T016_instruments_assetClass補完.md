# T016 instruments.ts の assetClass 未定義銘柄 10件を補完

**作成日**: 2026-03-30
**優先度**: 🟡 低
**発見経緯**: E2E Cycle 10 Round 3（Agent A13.4）

---

## 背景・目的

`src/instruments.ts` で `assetClass` が未定義の銘柄が10件あり、
`src/api.ts` の `inst.assetClass ?? 'forex'` フォールバックにより
全て `assetClass: 'forex'` として `/api/status` レスポンスに返っている。

フロントエンドのカテゴリ分類・フィルタ機能で誤分類が起きる可能性がある。

## 現象

```
/api/status の instruments 配列（46件）のうち:
  assetClass: 'forex' → 19件（本来 forex でない銘柄が混入）
  assetClass: 'stock' → 27件
  assetClass: 'index' / 'commodity' / 'crypto' → 0件
```

フォールバックで 'forex' になっている可能性が高い銘柄:
- Nikkei225, S&P500, DAX, NASDAQ（→ 'index' が正しい）
- Gold, Silver, CrudeOil, NatGas, Copper（→ 'commodity' が正しい）
- BTC/USD, ETH/USD, SOL/USD（→ 'crypto' が正しい）

## 調査手順

```bash
# assetClass が未定義の銘柄を特定
grep -n "assetClass" src/instruments.ts
# 定義なしの銘柄をリストアップ
```

## 修正方針

`src/instruments.ts` の該当銘柄に `assetClass` フィールドを追加:

```typescript
// 例
{ pair: 'Nikkei225', ..., assetClass: 'index' },
{ pair: 'Gold',      ..., assetClass: 'commodity' },
{ pair: 'BTC/USD',   ..., assetClass: 'crypto' },
```

正しい分類:
| assetClass | 対象銘柄 |
|---|---|
| `'forex'`     | USD/JPY, EUR/USD, GBP/USD 等の通貨ペア |
| `'index'`     | Nikkei225, S&P500, DAX, NASDAQ, UK100 等 |
| `'commodity'` | Gold, Silver, CrudeOil, NatGas, Copper 等 |
| `'crypto'`    | BTC/USD, ETH/USD, SOL/USD |
| `'stock'`     | AAPL, AMD, AMZN 等の個別株 |

## 完了条件

- `/api/status` の instruments 配列で 'index'/'commodity'/'crypto' が正しく返ること
- tsc --noEmit が通ること

---

**ステータス**: 未着手

# T024: session matrix 新日本株9銘柄漏れ修正

## 背景・目的

2026-04-06 の市場時間制御検証（セッション）で発覚した設計欠陥。
`session.ts` の `getSessionInstrumentMultiplier` で、旧10銘柄のみ matrix に明示定義。
後から追加された新9銘柄が未定義 → fallback `?? 0.5` → TSE閉場中（london/ny/overlap）でも取引可能になっている。

## 問題確定根拠

### コード上
- `sessionMatrix[normalized] ?? 0.5`（L231）: 新9銘柄は undefined → 0.5
- `requestedLot > 0` → LOT_ZERO_SESSION でブロックされない
- decisions テーブルに記録される経路に進む

### 実績上（確定）
- 商船三井: 2026-03-30T11:30 UTC（london session）に decision=HOLD が記録済み
- 商船三井: 2026-03-30T12:26 UTC（overlap session）に decision=HOLD が記録済み
- sessionInstrMult=0.5 で requestedLot > 0 → decisions L831 到達が確定
- たまたま HOLD だったためエントリー未発生（偶然）

## 対象9銘柄

さくらインターネット / 商船三井 / 東京海上HD / 三菱商事 / トヨタ / 三菱重工 / IHI / ANYCOLOR / カバー

## 修正方針（案A: 最小修正）

変更ファイル: `src/session.ts` 1ファイルのみ

### 変更箇所1: tokyo matrix（+9行）
```typescript
'さくらインターネット': 1.0, '商船三井': 1.0, '東京海上HD': 1.0,
'三菱商事': 1.0, 'トヨタ': 1.0, '三菱重工': 1.0, 'IHI': 1.0,
'ANYCOLOR': 1.0, 'カバー': 1.0,
```

### 変更箇所2: london matrix（+9行）
```typescript
'さくらインターネット': 0, '商船三井': 0, '東京海上HD': 0,
'三菱商事': 0, 'トヨタ': 0, '三菱重工': 0, 'IHI': 0, 'ANYCOLOR': 0, 'カバー': 0,
```

### 変更箇所3: ny matrix（+9行）
同上（全て 0）

### 変更箇所4: overlap の jpStocks 配列（+9要素）
```typescript
const jpStocks = [
  // 旧10銘柄 ...
  'さくらインターネット','商船三井','東京海上HD','三菱商事','トヨタ',
  '三菱重工','IHI','ANYCOLOR','カバー',
];
```

## テスト観点

- `getSessionInstrumentMultiplier('london', 'さくらインターネット') === 0`
- `getSessionInstrumentMultiplier('ny', '商船三井') === 0`
- `getSessionInstrumentMultiplier('overlap', '三菱重工') === 0`
- `getSessionInstrumentMultiplier('tokyo', 'さくらインターネット') === 1.0`

## 成功条件

- london/ny/overlapで新9銘柄が `LOT_ZERO_SESSION` でスキップされること
- tokyoセッションで新9銘柄のdecisionが正常に記録されること

## rollback条件

- tokyo での新9銘柄 decisions が 0件になった場合（本来あってはならない）

## 将来対応（案B）

`assetClass === 'stock' && tradingHoursJST` でセッション制御を自動化。
銘柄追加のたびに matrix 更新が不要になる。実弾投入前フェーズで実施。

## 次のアクション

- [ ] feature ブランチ作成
- [ ] session.ts の4箇所修正
- [ ] テスト追加（session.test.ts または weekend.test.ts）
- [ ] デプロイ後 london/ny/overlap で商船三井・さくらの LOT_ZERO_SESSION を確認

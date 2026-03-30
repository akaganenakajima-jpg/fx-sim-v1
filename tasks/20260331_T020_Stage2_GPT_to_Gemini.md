# T020: Stage 2 ニューストリガーのGPT→Gemini Flash統一

## 背景・目的
- `news-trigger.ts` の TREND_INFLUENCE パラメーター生成に GPT-4.1-mini（OpenAI）を使用中
- Stage 1（news.ts）は既に Gemini 2.5 Flash を使用しており、モデルが分散している
- OpenAI APIキー（`OPENAI_API_KEY`）の追加管理、障害点の増加、レイテンシ増が無駄

## 方針
- `callGptForTempParams()` の呼び出し先を OpenAI → Gemini 2.5 Flash に変更
- プロンプト内容はそのまま維持（キーワードマッピング・パラメーター調整方針）
- レスポンスパースを Gemini 形式に合わせる（`candidates[0].content.parts[0].text`）

## 2段階構成は維持する理由
- Stage 1: 毎分50〜100件バッチの「フィルタ+翻訳」（全件処理）
- Stage 2: Stage 1通過後の高スコア記事を「1件だけ」深掘り（アクション判定）
- 統合するとバッチ全件にパラメーター生成が走りトークン消費が爆発する
- **ファネル構造として合理的 → 分離は維持、モデルだけ統一**

## 変更対象
- `src/news-trigger.ts`: `callGptForTempParams()` のAPI呼び出し先・レスポンスパース
- `wrangler.toml` / シークレット: OPENAI_API_KEY が不要になるか確認（他で使用していなければ削除）

## 確認事項
- OPENAI_API_KEY を使っている箇所が news-trigger.ts 以外にないか grep で確認
- Gemini Flash の `responseMimeType: 'application/json'` でJSONレスポンスを強制

## ステータス
- [x] 完了（2026-03-31）
- callGptForTempParams → callGeminiForTempParams に変更
- OpenAI API → Gemini 2.5 Flash API（responseMimeType: 'application/json'）
- index.ts: getApiKey(env) で5キーローテーション対応
- テスト全パス、デプロイ済み

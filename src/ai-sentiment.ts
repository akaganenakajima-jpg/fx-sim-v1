/**
 * Workers AI DistilBERT-SST2 によるバッチセンチメント分析
 *
 * Geminiの s軸（シグナル強度）をエッジ推論の特化モデルで置き換える。
 * - モデル: @cf/huggingface/distilbert-sst-2-int8（INT8量子化）
 * - スコア正規化: max(POSITIVE confidence, NEGATIVE confidence) * 10 → 0-10
 *   理由: s軸は方向性ではなく「確信度」=シグナル強度
 * - 並列度5のバッチ処理（Workers AI同時実行制限対策）
 * - 個別失敗はMapから除外 → 呼び出し側がGeminiフォールバック
 */

export interface SentimentResult {
  score: number;          // 0-10（シグナル強度）
  source: 'workers_ai';
}

const MODEL = '@cf/huggingface/distilbert-sst-2-int8' as const;
const BATCH_CONCURRENCY = 5;
const MAX_TEXT_LENGTH = 512;  // DistilBERT max token ≈ 512文字

/**
 * 複数テキストのセンチメントをバッチ分析する
 *
 * @param ai - Cloudflare Workers AI binding
 * @param texts - { index: 記事インデックス, text: 分析対象テキスト }
 * @returns index → SentimentResult のMap（失敗分は含まない）
 */
export async function analyzeSentimentBatch(
  ai: Ai,
  texts: Array<{ index: number; text: string }>,
): Promise<Map<number, SentimentResult>> {
  const results = new Map<number, SentimentResult>();
  if (texts.length === 0) return results;

  // 並列度5でバッチ処理
  for (let i = 0; i < texts.length; i += BATCH_CONCURRENCY) {
    const batch = texts.slice(i, i + BATCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ index, text }) => {
        const truncated = text.slice(0, MAX_TEXT_LENGTH);
        const response = await ai.run(MODEL, { text: truncated }) as
          Array<{ label: string; score: number }>;

        // DistilBERT-SST2 は [{label: "POSITIVE", score: 0.95}, {label: "NEGATIVE", score: 0.05}] を返す
        const maxConfidence = Math.max(...response.map(r => r.score));
        const normalized = Math.round(maxConfidence * 100) / 10;  // 0-10スケール

        return { index, score: normalized, source: 'workers_ai' as const };
      })
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.set(result.value.index, {
          score: result.value.score,
          source: result.value.source,
        });
      }
      // rejected は無視 → 呼び出し側でGeminiフォールバック
    }
  }

  return results;
}

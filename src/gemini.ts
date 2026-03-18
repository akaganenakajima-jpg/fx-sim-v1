// Gemini API 呼び出し・レスポンス解析

import type { MarketIndicators } from './indicators';
import type { NewsItem } from './news';
import type { RedditSignal } from './reddit';

export interface GeminiDecision {
  decision: 'BUY' | 'SELL' | 'HOLD';
  tp_rate: number | null;
  sl_rate: number | null;
  reasoning: string; // 日本語100文字以内
}

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent';

const SYSTEM_INSTRUCTION =
  `あなたはFXデイトレーダーのAIアシスタントです。` +
  `以下のデータを分析し USD/JPY の売買判断を JSON で返してください。` +
  `既にオープンポジションがある場合は原則 HOLD を返すこと。` +
  `TP/SL は現在レートから ±0.3〜1.0円 の範囲で設定すること。` +
  `必ず以下のフォーマットのみで返答してください:\n` +
  `{"decision":"BUY"|"SELL"|"HOLD","tp_rate":number|null,"sl_rate":number|null,"reasoning":"日本語100文字以内"}`;

function buildUserMessage(params: {
  rate: number;
  indicators: MarketIndicators;
  news: NewsItem[];
  redditSignal: RedditSignal;
  hasOpenPosition: boolean;
}): string {
  const { rate, indicators, news, redditSignal, hasOpenPosition } = params;

  const newsText = news
    .map((n, i) => `  ${i + 1}. ${n.title}`)
    .join('\n');

  return [
    `現在のUSD/JPY: ${rate.toFixed(3)}円`,
    `米10年債利回り: ${indicators.us10y != null ? indicators.us10y.toFixed(2) + '%' : 'N/A'}`,
    `VIX: ${indicators.vix != null ? indicators.vix.toFixed(2) : 'N/A'}`,
    `日経平均: ${indicators.nikkei != null ? indicators.nikkei.toFixed(0) : 'N/A'}`,
    `S&P500: ${indicators.sp500 != null ? indicators.sp500.toFixed(0) : 'N/A'}`,
    `Redditシグナル: ${redditSignal.keywords.length > 0 ? redditSignal.keywords.join(', ') : 'なし'}`,
    `直近ニュース（箇条書き5件）:`,
    newsText || '  (取得なし)',
    `オープンポジション: ${hasOpenPosition ? 'あり（原則HOLDを返すこと）' : 'なし'}`,
  ].join('\n');
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: Array<{ text: string }> };
  }>;
}

export async function getDecision(params: {
  rate: number;
  indicators: MarketIndicators;
  news: NewsItem[];
  redditSignal: RedditSignal;
  hasOpenPosition: boolean;
  apiKey: string;
}): Promise<GeminiDecision> {
  const { apiKey, ...rest } = params;
  const userMessage = buildUserMessage(rest);

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // system prompt を systemInstruction で分離（Gemini API 推奨構造）
      systemInstruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }],
      },
      contents: [
        { role: 'user', parts: [{ text: userMessage }] },
      ],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${body}`);
  }

  const data = await res.json<GeminiResponse>();
  const text = data.candidates[0].content.parts[0].text;
  const parsed = JSON.parse(text) as GeminiDecision;

  // decision の値を正規化
  const decision = (['BUY', 'SELL', 'HOLD'] as const).includes(
    parsed.decision as 'BUY' | 'SELL' | 'HOLD'
  )
    ? parsed.decision
    : 'HOLD';

  return {
    decision,
    tp_rate: parsed.tp_rate ?? null,
    sl_rate: parsed.sl_rate ?? null,
    reasoning: parsed.reasoning ?? '',
  };
}

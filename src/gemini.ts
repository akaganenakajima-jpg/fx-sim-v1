// Gemini API 呼び出し・レスポンス解析

import type { MarketIndicators } from './indicators';
import type { NewsItem } from './news';
import type { RedditSignal } from './reddit';
import type { InstrumentConfig } from './instruments';

export interface GeminiDecision {
  decision: 'BUY' | 'SELL' | 'HOLD';
  tp_rate: number | null;
  sl_rate: number | null;
  reasoning: string; // 日本語100文字以内
}

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent';

function buildSystemInstruction(instrument: InstrumentConfig): string {
  return (
    `あなたはトレーダーのAIアシスタントです。` +
    `以下のデータを分析し ${instrument.pair} の売買判断を JSON で返してください。` +
    `既にオープンポジションがある場合は原則 HOLD を返すこと。` +
    `TP/SL は${instrument.tpSlHint}の範囲で設定すること。` +
    `必ず以下のフォーマットのみで返答してください:\n` +
    `{"decision":"BUY"|"SELL"|"HOLD","tp_rate":number|null,"sl_rate":number|null,"reasoning":"日本語100文字以内"}`
  );
}

function buildUserMessage(params: {
  instrument: InstrumentConfig;
  rate: number;
  indicators: MarketIndicators;
  news: NewsItem[];
  redditSignal: RedditSignal;
  hasOpenPosition: boolean;
}): string {
  const { instrument, rate, indicators, news, redditSignal, hasOpenPosition } = params;

  const newsText = news
    .map((n, i) => `  ${i + 1}. ${n.title}`)
    .join('\n');

  return [
    `取引対象: ${instrument.pair}`,
    `現在値: ${rate.toFixed(instrument.pair === 'USD/JPY' ? 3 : 2)}`,
    ``,
    `【市場コンテキスト（USD/JPY相関指標）】`,
    `USD/JPY: ${instrument.pair === 'USD/JPY' ? rate.toFixed(3) : '参照値として使用'}`,
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
  instrument: InstrumentConfig;
  rate: number;
  indicators: MarketIndicators;
  news: NewsItem[];
  redditSignal: RedditSignal;
  hasOpenPosition: boolean;
  apiKey: string;
}): Promise<GeminiDecision> {
  const { apiKey, instrument, ...rest } = params;
  const userMessage = buildUserMessage({ instrument, ...rest });

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: buildSystemInstruction(instrument) }],
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

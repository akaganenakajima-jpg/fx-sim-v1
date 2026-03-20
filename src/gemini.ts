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

const AI_TIMEOUT_MS = 15_000; // AI API呼び出し15秒タイムアウト

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = AI_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function buildSystemInstruction(instrument: InstrumentConfig): string {
  return (
    `あなたはトレーダーのAIアシスタントです。` +
    `以下のデータを分析し ${instrument.pair} の売買判断を JSON で返してください。` +
    `既にオープンポジションがある場合は原則 HOLD を返すこと。` +
    `TP/SL は${instrument.tpSlHint}の範囲で設定すること。` +
    `【重要】リスクリワード比（TP距離÷SL距離）は必ず1.5以上にすること。SLは狭く、TPは広く設定せよ。確信度が低い場合はHOLDを返すこと。` +
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
  recentTrades?: Array<{ pair: string; direction: string; pnl: number; close_reason: string }>;
  allPositionDirections?: string[];
  sparkRates?: number[];
}): string {
  const { instrument, rate, indicators, news, redditSignal, hasOpenPosition, recentTrades, allPositionDirections, sparkRates } = params;

  const newsText = news
    .map((n, i) => `  ${i + 1}. ${n.title}`)
    .join('\n');

  // VIX連動TP/SL幅: VIX高→幅広、VIX低→幅狭
  const vix = indicators.vix ?? 20;
  const vixMultiplier = vix > 30 ? 1.5 : vix > 25 ? 1.2 : vix > 20 ? 1.0 : 0.8;
  const tpSlNote = `TP/SLは${instrument.tpSlHint}を基準に、現在VIX=${vix.toFixed(1)}のため幅を${vixMultiplier}倍に調整すること。リスクリワード比（TP距離÷SL距離）は必ず1.5以上を確保すること。`;

  return [
    `取引対象: ${instrument.pair}`,
    `現在値: ${rate.toFixed(instrument.pair === 'USD/JPY' || instrument.pair === 'EUR/USD' ? 3 : 2)}`,
    ``,
    `【市場コンテキスト】`,
    `米10年債利回り: ${indicators.us10y != null ? indicators.us10y.toFixed(2) + '%' : 'N/A'}`,
    `VIX: ${indicators.vix != null ? indicators.vix.toFixed(2) : 'N/A'}`,
    `日経平均: ${indicators.nikkei != null ? indicators.nikkei.toFixed(0) : 'N/A'}`,
    `S&P500: ${indicators.sp500 != null ? indicators.sp500.toFixed(0) : 'N/A'}`,
    `Redditシグナル: ${redditSignal.keywords.length > 0 ? redditSignal.keywords.join(', ') : 'なし'}`,
    `直近ニュース（箇条書き5件）:`,
    newsText || '  (取得なし)',
    `オープンポジション: ${hasOpenPosition ? 'あり（原則HOLDを返すこと）' : 'なし'}`,
    ``,
    `【TP/SL設定指示】`,
    tpSlNote,
    ...(recentTrades && recentTrades.length > 0 ? [
      ``,
      `【直近の取引結果（この銘柄）】`,
      ...recentTrades.slice(0, 5).map(t =>
        `  ${t.direction} → ${t.close_reason} PnL=${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(0)}円`
      ),
      `上記パターンを参考に、同じ失敗を繰り返さないこと。`,
    ] : []),
    ...(allPositionDirections && allPositionDirections.length > 0 ? [
      ``,
      `【現在の全ポジション方向】`,
      `  ${allPositionDirections.join(', ')}`,
      allPositionDirections.filter(d => d.includes('SELL')).length >= 5
        ? '⚠️ 全ポジションがSELLに偏っています。BUYも検討すること。'
        : allPositionDirections.filter(d => d.includes('BUY')).length >= 5
        ? '⚠️ 全ポジションがBUYに偏っています。SELLも検討すること。'
        : '',
    ] : []),
    ...(sparkRates && sparkRates.length >= 5 ? [
      ``,
      `【トレンド分析】`,
      (() => {
        const mid = sparkRates;
        const short = mid.slice(-5);
        const midFirst = mid[0]; const midLast = mid[mid.length - 1];
        const shortFirst = short[0]; const shortLast = short[short.length - 1];
        const midTrend = midLast > midFirst ? '上昇' : midLast < midFirst ? '下落' : '横ばい';
        const shortTrend = shortLast > shortFirst ? '上昇' : shortLast < shortFirst ? '下落' : '横ばい';
        const midPct = ((midLast - midFirst) / midFirst * 100).toFixed(2);
        const shortPct = ((shortLast - shortFirst) / shortFirst * 100).toFixed(2);
        return `中期トレンド（${mid.length}件）: ${midTrend}（${midPct}%）\n短期トレンド（${short.length}件）: ${shortTrend}（${shortPct}%）`;
      })(),
      `中期と短期のトレンドが一致している場合はその方向に、乖離している場合は反転リスクを考慮すること。`,
    ] : []),
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
  recentTrades?: Array<{ pair: string; direction: string; pnl: number; close_reason: string }>;
  allPositionDirections?: string[];
  sparkRates?: number[];
  apiKey: string;
}): Promise<GeminiDecision> {
  const { apiKey, instrument, ...rest } = params;
  const userMessage = buildUserMessage({ instrument, ...rest });

  const res = await fetchWithTimeout(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
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

// ── GPT-4o フォールバック ──
export async function getDecisionGPT(params: {
  instrument: InstrumentConfig;
  rate: number;
  indicators: MarketIndicators;
  news: NewsItem[];
  redditSignal: RedditSignal;
  hasOpenPosition: boolean;
  recentTrades?: Array<{ pair: string; direction: string; pnl: number; close_reason: string }>;
  allPositionDirections?: string[];
  sparkRates?: number[];
  apiKey: string;
}): Promise<GeminiDecision> {
  const { apiKey, instrument, ...rest } = params;
  const userMessage = buildUserMessage({ instrument, ...rest });
  const systemPrompt = buildSystemInstruction(instrument);

  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }

  const data = await res.json<{ choices: Array<{ message: { content: string } }> }>();
  const text = data.choices[0].message.content;
  const parsed = JSON.parse(text) as GeminiDecision;

  return {
    decision: (['BUY', 'SELL', 'HOLD'] as const).includes(parsed.decision as 'BUY' | 'SELL' | 'HOLD') ? parsed.decision : 'HOLD',
    tp_rate: parsed.tp_rate ?? null,
    sl_rate: parsed.sl_rate ?? null,
    reasoning: parsed.reasoning ?? '',
  };
}

// ── Anthropic Claude フォールバック ──
export async function getDecisionClaude(params: {
  instrument: InstrumentConfig;
  rate: number;
  indicators: MarketIndicators;
  news: NewsItem[];
  redditSignal: RedditSignal;
  hasOpenPosition: boolean;
  recentTrades?: Array<{ pair: string; direction: string; pnl: number; close_reason: string }>;
  allPositionDirections?: string[];
  sparkRates?: number[];
  apiKey: string;
}): Promise<GeminiDecision> {
  const { apiKey, instrument, ...rest } = params;
  const userMessage = buildUserMessage({ instrument, ...rest });
  const systemPrompt = buildSystemInstruction(instrument);

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  const data = await res.json<{ content: Array<{ type: string; text: string }> }>();
  const text = data.content[0].text;
  // JSON部分を抽出（Claudeはマークダウンで囲む場合がある）
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude response has no JSON');
  const parsed = JSON.parse(jsonMatch[0]) as GeminiDecision;

  return {
    decision: (['BUY', 'SELL', 'HOLD'] as const).includes(parsed.decision as 'BUY' | 'SELL' | 'HOLD') ? parsed.decision : 'HOLD',
    tp_rate: parsed.tp_rate ?? null,
    sl_rate: parsed.sl_rate ?? null,
    reasoning: parsed.reasoning ?? '',
  };
}

// ── ニュース注目フラグ分析 ──

export interface NewsAnalysisItem {
  index: number;
  attention: boolean;
  impact: string | null;
  title_ja: string | null; // 英語ニュースの日本語訳タイトル（日本語ニュースはnull）
}

export async function analyzeNews(params: {
  news: NewsItem[];
  apiKey: string;
}): Promise<NewsAnalysisItem[]> {
  const { news, apiKey } = params;
  if (news.length === 0) return [];

  const newsList = news.slice(0, 12).map((n, i) =>
    `[${i}] ${n.title}${n.description ? ' — ' + n.description.slice(0, 100) : ''}`
  ).join('\n');

  const systemPrompt =
    'あなたは金融マーケットアナリストです。以下のニュース一覧を分析し、' +
    'マーケット（為替・株式・債券・暗号資産・コモディティ）に影響がありそうなニュースに注目フラグを付けてください。' +
    '必ず以下のJSON配列のみで返答してください:\n' +
    '[{"index":0,"attention":true,"impact":"円安要因。日銀政策への影響で...","title_ja":"日本語タイトル"},{"index":1,"attention":false,"impact":null,"title_ja":null},...]\n' +
    'impactは注目ニュースのみ日本語50文字以内で市場への影響を説明。注目でなければnull。\n' +
    'title_jaは英語タイトルの場合のみ日本語訳を返す。日本語タイトルはnull。';

  const res = await fetchWithTimeout(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: newsList }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini news analysis error ${res.status}`);
  }

  const data = await res.json<GeminiResponse>();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text) as NewsAnalysisItem[];
}

const NEWS_ANALYSIS_SYSTEM_PROMPT =
  'あなたは金融マーケットアナリストです。以下のニュース一覧を分析し、' +
  'マーケット（為替・株式・債券・暗号資産・コモディティ）に影響がありそうなニュースに注目フラグを付けてください。' +
  '必ず以下のJSON配列のみで返答してください:\n' +
  '[{"index":0,"attention":true,"impact":"円安要因。日銀政策への影響で...","title_ja":"日本語タイトル"},{"index":1,"attention":false,"impact":null,"title_ja":null},...]\n' +
  'impactは注目ニュースのみ日本語50文字以内で市場への影響を説明。注目でなければnull。\n' +
  'title_jaは英語タイトルの場合のみ日本語訳を返す。日本語タイトルはnull。';

function buildNewsList(news: NewsItem[]): string {
  return news.slice(0, 12).map((n, i) =>
    `[${i}] ${n.title}${n.description ? ' — ' + n.description.slice(0, 100) : ''}`
  ).join('\n');
}

export async function analyzeNewsGPT(params: {
  news: NewsItem[];
  apiKey: string;
}): Promise<NewsAnalysisItem[]> {
  const { news, apiKey } = params;
  if (news.length === 0) return [];

  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: NEWS_ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: buildNewsList(news) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI news analysis error ${res.status}: ${body}`);
  }

  const data = await res.json<{ choices: Array<{ message: { content: string } }> }>();
  const text = data.choices[0].message.content;
  const parsed = JSON.parse(text);
  // GPTはjson_objectモードで配列を返せないことがある（ラッパーオブジェクト）
  return Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.results ?? parsed.analysis ?? []);
}

export async function analyzeNewsClaude(params: {
  news: NewsItem[];
  apiKey: string;
}): Promise<NewsAnalysisItem[]> {
  const { news, apiKey } = params;
  if (news.length === 0) return [];

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: NEWS_ANALYSIS_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: buildNewsList(news) },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic news analysis error ${res.status}: ${body}`);
  }

  const data = await res.json<{ content: Array<{ type: string; text: string }> }>();
  const text = data.content[0].text;
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Claude news analysis: no JSON array');
  return JSON.parse(jsonMatch[0]) as NewsAnalysisItem[];
}

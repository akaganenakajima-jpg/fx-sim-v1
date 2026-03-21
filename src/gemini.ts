// Gemini API 呼び出し・レスポンス解析

import type { MarketIndicators } from './indicators';
import type { NewsItem } from './news';
import type { RedditSignal } from './reddit';
import type { InstrumentConfig } from './instruments';

// ── 429 Rate Limit エラー（キー別クールダウン用）──
export class RateLimitError extends Error {
  constructor(
    public readonly apiKey: string,
    public readonly retryAfterSec: number,
    detail: string,
  ) {
    super(`429 Rate Limited (retry after ${retryAfterSec}s): ${detail.slice(0, 100)}`);
    this.name = 'RateLimitError';
  }
}

export interface GeminiDecision {
  decision: 'BUY' | 'SELL' | 'HOLD';
  tp_rate: number | null;
  sl_rate: number | null;
  reasoning: string; // 日本語100文字以内
  strategy?: string; // テスタ施策7: 手法タグ
  confidence?: number; // テスタ施策7: 確信度 0-100
}

/** プロンプトバージョン: プロンプトを変更したらこの値を更新する */
export const PROMPT_VERSION = 'v4'; // 現在のバージョン

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent';

const AI_TIMEOUT_MS = 12_000; // AI API呼び出し12秒タイムアウト
// const NEWS_ANALYSIS_TIMEOUT_MS = 12_000; // DEPRECATED_v2: analyzeNews系で使用していたが削除
const HEDGE_DELAY_MS = 4_000; // ヘッジリクエスト: Gemini開始後4秒でGPTも並行開始

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
    `\n【手法分類】"strategy"フィールドで判断手法を分類せよ: trend_follow(トレンド順張り), mean_reversion(逆張り), breakout(ブレイクアウト), news_driven(ニュース起因), range_trade(レンジ売買)` +
    `\n【確信度】"confidence"フィールドで確信度を0-100で示せ。40未満ならHOLDを推奨。` +
    `\n必ず以下のフォーマットのみで返答してください:\n` +
    `{"decision":"BUY"|"SELL"|"HOLD","tp_rate":number|null,"sl_rate":number|null,"reasoning":"日本語100文字以内","strategy":"trend_follow"|"mean_reversion"|"breakout"|"news_driven"|"range_trade","confidence":0-100}`
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
  regime?: string;
  technicalText?: string; // テスタ施策6: テクニカル環境認識テキスト
  regimeProhibitions?: string; // テスタ施策20: レジーム別禁止行動
}): string {
  const { instrument, rate, indicators, news, redditSignal, hasOpenPosition, recentTrades, allPositionDirections, sparkRates, regime } = params;

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
    `市場レジーム: ${regime ?? '不明'} (trending=トレンド, ranging=レンジ, volatile=高ボラ)`,
    `米10年債利回り: ${indicators.us10y != null ? indicators.us10y.toFixed(2) + '%' : 'N/A'}`,
    `VIX: ${indicators.vix != null ? indicators.vix.toFixed(2) : 'N/A'}`,
    `日経平均: ${indicators.nikkei != null ? indicators.nikkei.toFixed(0) : 'N/A'}`,
    `S&P500: ${indicators.sp500 != null ? indicators.sp500.toFixed(0) : 'N/A'}`,
    `Redditシグナル: ${redditSignal.keywords.length > 0 ? redditSignal.keywords.join(', ') : 'なし'}`,
    `直近ニュース（箇条書き5件）:`,
    newsText || '  (取得なし)',
    `オープンポジション: ${hasOpenPosition ? 'あり（原則HOLDを返すこと）' : 'なし'}`,
    ...(params.technicalText ? [``, params.technicalText] : []),
    ...(params.regimeProhibitions ? [params.regimeProhibitions] : []),
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
  regime?: string;
  technicalText?: string;
  regimeProhibitions?: string;
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
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      throw new RateLimitError(apiKey, retryAfter > 0 ? retryAfter : 60, body);
    }
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
  regime?: string;
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
  regime?: string;
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

// ── ヘッジリクエスト: 最速プロバイダーの結果を使う ──
// Gemini開始 → 4秒後にGPTも並行開始 → 最初に成功した方を採用
export interface HedgeResult {
  decision: GeminiDecision;
  provider: 'gemini' | 'gpt' | 'claude';
}

export async function getDecisionWithHedge(params: {
  instrument: InstrumentConfig;
  rate: number;
  indicators: MarketIndicators;
  news: NewsItem[];
  redditSignal: RedditSignal;
  hasOpenPosition: boolean;
  recentTrades?: Array<{ pair: string; direction: string; pnl: number; close_reason: string }>;
  allPositionDirections?: string[];
  sparkRates?: number[];
  regime?: string;
  technicalText?: string;
  regimeProhibitions?: string;
  geminiApiKey: string;
  openaiApiKey?: string;
  openaiApiKey2?: string;
  anthropicApiKey?: string;
  keyIndex?: number;
}): Promise<HedgeResult> {
  const { geminiApiKey, openaiApiKey, openaiApiKey2, anthropicApiKey, keyIndex, ...common } = params;

  // Geminiを即座に開始
  const geminiPromise = getDecision({ ...common, apiKey: geminiApiKey })
    .then(d => ({ decision: d, provider: 'gemini' as const }));

  // 4秒後にGPTをヘッジとして開始（Geminiがまだ返ってなければ）
  const hedgePromise = new Promise<HedgeResult>((resolve, reject) => {
    setTimeout(async () => {
      if (openaiApiKey) {
        try {
          const oaiKey = (keyIndex !== undefined && keyIndex % 2 === 0 ? openaiApiKey : openaiApiKey2) || openaiApiKey;
          const d = await getDecisionGPT({ ...common, apiKey: oaiKey });
          resolve({ decision: d, provider: 'gpt' });
        } catch (gptErr) {
          // GPTも失敗 → Claude
          if (anthropicApiKey) {
            try {
              const d = await getDecisionClaude({ ...common, apiKey: anthropicApiKey });
              resolve({ decision: d, provider: 'claude' });
            } catch { reject(new Error('All hedge providers failed')); }
          } else { reject(gptErr); }
        }
      } else if (anthropicApiKey) {
        try {
          const d = await getDecisionClaude({ ...common, apiKey: anthropicApiKey });
          resolve({ decision: d, provider: 'claude' });
        } catch (e) { reject(e); }
      } else { reject(new Error('No hedge provider')); }
    }, HEDGE_DELAY_MS);
  });

  // 最初に成功した方を採用（エラーは無視してもう一方を待つ）
  return Promise.any([geminiPromise, hedgePromise]);
}

// ── ニュース分析型定義（v2: Path B用に拡張）──

/** Path B newsStage1/newsStage2 で使用するニュース分析アイテム */
export interface NewsAnalysisItem {
  index: number;
  attention: boolean;
  impact: string;
  title_ja: string;
  affected_pairs: string[];
  link?: string;
  og_description?: string; // B2でfetch後に付与
}

/** Path B B1出力 */
export interface NewsStage1Result {
  news_analysis: NewsAnalysisItem[];
  trade_signals: Array<{
    pair: string;
    decision: 'BUY' | 'SELL';
    tp_rate: number;
    sl_rate: number;
    reasoning: string;
  }>;
}

/** Path B B2出力 */
export interface NewsStage2Result {
  corrections: Array<{
    pair: string;
    action: 'CONFIRM' | 'REVISE' | 'REVERSE';
    new_tp_rate?: number; // REVISE時のみ。省略=B1値を維持
    new_sl_rate?: number;
    reasoning: string;
  }>;
}

// ── DEPRECATED_v2: 旧ニュース分析関数（Path B実装後にコメントアウト）──
// 本番でPath Bが連続10回以上成功した段階で完全削除する

/* DEPRECATED_v2: analyzeNews() replaced by newsStage1()/newsStage2()
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
  }, NEWS_ANALYSIS_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(`Gemini news analysis error ${res.status}`);
  }

  const data = await res.json<GeminiResponse>();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text) as NewsAnalysisItem[];
}
*/

/* DEPRECATED_v2: NEWS_ANALYSIS_SYSTEM_PROMPT
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
*/

/* DEPRECATED_v2: analyzeNewsGPT() replaced by newsStage1()/newsStage2()
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
  }, NEWS_ANALYSIS_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI news analysis error ${res.status}: ${body}`);
  }

  const data = await res.json<{ choices: Array<{ message: { content: string } }> }>();
  const text = data.choices[0].message.content;
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.results ?? parsed.analysis ?? []);
}
*/

/* DEPRECATED_v2: analyzeNewsClaude() replaced by newsStage1()/newsStage2()
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
  }, NEWS_ANALYSIS_TIMEOUT_MS);

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
*/

// ── Path B: og:description フェッチ ──

/**
 * 指定URLからog:descriptionを取得する
 * - タイムアウト3秒、失敗時はnullを返す（例外を投げない）
 */
export async function fetchOgDescription(url: string, sourceName?: string): Promise<string | null> {
  void sourceName; // 将来の拡張用
  try {
    const res = await fetchWithTimeout(url, {}, 3_000);
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<meta\s+(?:property|name)=["']og:description["']\s+content=["']([^"']+)["']/i)
      ?? html.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:description["']/i);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

// ── Path B: newsStage1 ──

const STAGE1_TIMEOUT_MS = 10_000;

/**
 * B1: ニュースタイトル即断 → trade_signals 収集
 * タイムアウト10秒。失敗時は例外を投げる（呼び出し元でcatch→Path Bスキップ）
 */
export async function newsStage1(params: {
  news: NewsItem[];
  redditSignal: { hasSignal: boolean; keywords: string[]; topPosts: string[] };
  indicators: MarketIndicators;
  instruments: Array<{ pair: string; hasOpenPosition: boolean }>;
  apiKey: string;
}): Promise<NewsStage1Result> {
  const { news, redditSignal, indicators, instruments, apiKey } = params;

  const newsList = news.slice(0, 20).map((n, i) =>
    `[${i}] ${n.title}${(n as any).source ? ` (${(n as any).source})` : ''}`
  ).join('\n');

  const instrumentList = instruments.map(inst =>
    inst.hasOpenPosition ? `${inst.pair}[OP]` : inst.pair
  ).join(', ');

  const userMessage = [
    `【ニュース一覧】`,
    newsList,
    ``,
    `【市場状況】`,
    `米10年債利回り: ${indicators.us10y != null ? indicators.us10y.toFixed(2) + '%' : 'N/A'}`,
    `VIX: ${indicators.vix != null ? indicators.vix.toFixed(2) : 'N/A'}`,
    `日経平均: ${indicators.nikkei != null ? indicators.nikkei.toFixed(0) : 'N/A'}`,
    `S&P500: ${indicators.sp500 != null ? indicators.sp500.toFixed(0) : 'N/A'}`,
    `Redditシグナル: ${redditSignal.hasSignal ? redditSignal.keywords.join(', ') : 'なし'}`,
    ``,
    `【対象銘柄】（[OP]=既存ポジションあり、trade_signalsに含めない）`,
    instrumentList,
  ].join('\n');

  const systemPrompt =
    'あなたは為替FXトレーダーのAIアシスタントです。\n' +
    '以下のニュース一覧と市場状況を分析し、次の2つのことを返してください。\n' +
    '1. 各ニュースの注目度評価（news_analysis）\n' +
    '2. ニュースに基づいた売買シグナル（trade_signals）\n\n' +
    '必ず以下のJSON形式のみで返答してください:\n' +
    '{"news_analysis":[{"index":0,"attention":true,"impact":"円安要因（50文字以内）","affected_pairs":["USD/JPY"]}],' +
    '"trade_signals":[{"pair":"USD/JPY","decision":"BUY","tp_rate":150.50,"sl_rate":149.80,"reasoning":"日本語100文字以内"}]}\n\n' +
    'ルール:\n' +
    '- trade_signalsはBUYまたはSELLのみ（HOLDは含めない）\n' +
    '- [OP]マークの銘柄はtrade_signalsに含めない\n' +
    '- tp_rate/sl_rateは必ず数値で返す（nullは不可）\n' +
    '- リスクリワード比は1.5以上\n' +
    '- 確信度が低いニュースはtrade_signalsに含めない\n' +
    '- attention:falseのニュースはimpact/affected_pairsを空にする\n' +
    '- title_jaフィールドは不要（翻訳は別途処理する）';

  const res = await fetchWithTimeout(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  }, STAGE1_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      throw new RateLimitError(apiKey, retryAfter > 0 ? retryAfter : 60, body);
    }
    throw new Error(`newsStage1 API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json<GeminiResponse>();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text) as NewsStage1Result;
}

// ── Path B: newsStage2 ──

const STAGE2_TIMEOUT_MS = 8_000;

/**
 * B2: og:description付きで補正 → CONFIRM/REVISE/REVERSE
 * タイムアウト8秒。失敗時は例外を投げる（呼び出し元でcatch→B1シグナルをそのまま採用）
 */
export async function newsStage2(params: {
  stage1Result: NewsStage1Result;
  news: NewsItem[];
  apiKey: string;
}): Promise<NewsStage2Result> {
  const { stage1Result, news, apiKey } = params;

  const signalList = stage1Result.trade_signals.map(s =>
    `${s.pair}: ${s.decision} TP=${s.tp_rate} SL=${s.sl_rate} / ${s.reasoning}`
  ).join('\n');

  const attentionNews = stage1Result.news_analysis
    .filter(a => a.attention)
    .slice(0, 5)
    .map(a => {
      const item = news[a.index];
      const ogDesc = a.og_description ?? item?.description ?? '（詳細なし）';
      return `[${a.index}] ${item?.title ?? ''}\nog:description: ${ogDesc.slice(0, 300)}`;
    })
    .join('\n\n');

  const userMessage = [
    `【B1シグナル（再評価対象）】`,
    signalList || '（シグナルなし）',
    ``,
    `【注目ニュース詳細（og:description付き）】`,
    attentionNews || '（詳細取得なし）',
  ].join('\n');

  const systemPrompt =
    'あなたは為替FXトレーダーのAIアシスタントです。\n' +
    'B1（速報）の売買シグナルをog:description（詳細情報）で再評価してください。\n\n' +
    '必ず以下のJSON形式のみで返答してください:\n' +
    '{"corrections":[{"pair":"USD/JPY","action":"CONFIRM","reasoning":"詳細を確認、B1判断を維持"}]}\n\n' +
    'actionの種類:\n' +
    '- CONFIRM: B1の判断を維持（tp_rate/sl_rateはB1値をそのまま使用）\n' +
    '- REVISE: TP/SLを修正（方向は変えない）。new_tp_rate/new_sl_rateを指定（省略=B1値を維持）\n' +
    '- REVERSE: 反対方向に変更推奨（既存ポジションがあれば決済）\n' +
    'B1シグナルの全pairに対してcorrectionsを返すこと。';

  const res = await fetchWithTimeout(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  }, STAGE2_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      throw new RateLimitError(apiKey, retryAfter > 0 ? retryAfter : 60, body);
    }
    throw new Error(`newsStage2 API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json<GeminiResponse>();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text) as NewsStage2Result;
}

// ── B1/B2 ヘッジ: Gemini → GPT → Claude フォールバック ──

/** newsStage1 + GPT/Claude フォールバック */
export async function newsStage1WithHedge(params: {
  news: NewsItem[];
  redditSignal: { hasSignal: boolean; keywords: string[]; topPosts: string[] };
  indicators: MarketIndicators;
  instruments: Array<{ pair: string; hasOpenPosition: boolean }>;
  apiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
}): Promise<NewsStage1Result & { provider: string }> {
  const { openaiApiKey, anthropicApiKey, ...geminiParams } = params;

  // 1. Gemini を試行
  try {
    const result = await newsStage1(geminiParams);
    return { ...result, provider: 'gemini' };
  } catch (geminiErr) {
    console.warn(`[fx-sim] B1 Gemini failed: ${String(geminiErr).split('\n')[0].slice(0, 80)}`);

    // 2. GPT フォールバック
    if (openaiApiKey) {
      try {
        const result = await newsStage1GPT({ ...params, apiKey: openaiApiKey });
        return { ...result, provider: 'gpt' };
      } catch (gptErr) {
        console.warn(`[fx-sim] B1 GPT failed: ${String(gptErr).split('\n')[0].slice(0, 80)}`);
      }
    }

    // 3. Claude フォールバック
    if (anthropicApiKey) {
      try {
        const result = await newsStage1Claude({ ...params, apiKey: anthropicApiKey });
        return { ...result, provider: 'claude' };
      } catch (claudeErr) {
        console.warn(`[fx-sim] B1 Claude failed: ${String(claudeErr).split('\n')[0].slice(0, 80)}`);
      }
    }

    throw geminiErr; // 全プロバイダー失敗
  }
}

/** B1 GPT版: newsStage1 と同じプロンプトを GPT に送る */
async function newsStage1GPT(params: {
  news: NewsItem[];
  redditSignal: { hasSignal: boolean; keywords: string[]; topPosts: string[] };
  indicators: MarketIndicators;
  instruments: Array<{ pair: string; hasOpenPosition: boolean }>;
  apiKey: string;
}): Promise<NewsStage1Result> {
  const { news, redditSignal, indicators, instruments, apiKey } = params;

  const newsList = news.slice(0, 20).map((n, i) =>
    `[${i}] ${n.title}${(n as any).source ? ` (${(n as any).source})` : ''}`
  ).join('\n');

  const instrumentList = instruments.map(inst =>
    inst.hasOpenPosition ? `${inst.pair}[OP]` : inst.pair
  ).join(', ');

  const userMessage = [
    `【ニュース一覧】`, newsList, ``,
    `【市場状況】`,
    `米10年債利回り: ${indicators.us10y != null ? indicators.us10y.toFixed(2) + '%' : 'N/A'}`,
    `VIX: ${indicators.vix != null ? indicators.vix.toFixed(2) : 'N/A'}`,
    `日経平均: ${indicators.nikkei != null ? indicators.nikkei.toFixed(0) : 'N/A'}`,
    `S&P500: ${indicators.sp500 != null ? indicators.sp500.toFixed(0) : 'N/A'}`,
    `Redditシグナル: ${redditSignal.hasSignal ? redditSignal.keywords.join(', ') : 'なし'}`,
    ``, `【対象銘柄】（[OP]=既存ポジションあり、trade_signalsに含めない）`, instrumentList,
  ].join('\n');

  const systemPrompt =
    'あなたは為替FXトレーダーのAIアシスタントです。\n' +
    '以下のニュース一覧と市場状況を分析し、次の2つのことを返してください。\n' +
    '1. 各ニュースの注目度評価（news_analysis）\n' +
    '2. ニュースに基づいた売買シグナル（trade_signals）\n\n' +
    '必ず以下のJSON形式のみで返答してください:\n' +
    '{"news_analysis":[{"index":0,"attention":true,"impact":"円安要因（50文字以内）","affected_pairs":["USD/JPY"]}],' +
    '"trade_signals":[{"pair":"USD/JPY","decision":"BUY","tp_rate":150.50,"sl_rate":149.80,"reasoning":"日本語100文字以内"}]}\n\n' +
    'ルール:\n- trade_signalsはBUYまたはSELLのみ（HOLDは含めない）\n- [OP]マークの銘柄はtrade_signalsに含めない\n' +
    '- tp_rate/sl_rateは必ず数値で返す（nullは不可）\n- リスクリワード比は1.5以上\n- 確信度が低いニュースはtrade_signalsに含めない\n' +
    '- title_jaフィールドは不要';

  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }),
  }, STAGE1_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GPT newsStage1 error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json<{ choices: Array<{ message: { content: string } }> }>();
  const text = data.choices[0].message.content;
  const parsed = JSON.parse(text);
  // GPTはルートオブジェクトまたはネストで返す可能性がある
  return {
    news_analysis: parsed.news_analysis ?? [],
    trade_signals: parsed.trade_signals ?? [],
  };
}

/** B1 Claude版: newsStage1 と同じプロンプトを Claude に送る */
async function newsStage1Claude(params: {
  news: NewsItem[];
  redditSignal: { hasSignal: boolean; keywords: string[]; topPosts: string[] };
  indicators: MarketIndicators;
  instruments: Array<{ pair: string; hasOpenPosition: boolean }>;
  apiKey: string;
}): Promise<NewsStage1Result> {
  const { news, redditSignal, indicators, instruments, apiKey } = params;

  const newsList = news.slice(0, 20).map((n, i) =>
    `[${i}] ${n.title}${(n as any).source ? ` (${(n as any).source})` : ''}`
  ).join('\n');

  const instrumentList = instruments.map(inst =>
    inst.hasOpenPosition ? `${inst.pair}[OP]` : inst.pair
  ).join(', ');

  const userMessage = [
    `【ニュース一覧】`, newsList, ``,
    `【市場状況】`,
    `米10年債利回り: ${indicators.us10y != null ? indicators.us10y.toFixed(2) + '%' : 'N/A'}`,
    `VIX: ${indicators.vix != null ? indicators.vix.toFixed(2) : 'N/A'}`,
    `日経平均: ${indicators.nikkei != null ? indicators.nikkei.toFixed(0) : 'N/A'}`,
    `S&P500: ${indicators.sp500 != null ? indicators.sp500.toFixed(0) : 'N/A'}`,
    `Redditシグナル: ${redditSignal.hasSignal ? redditSignal.keywords.join(', ') : 'なし'}`,
    ``, `【対象銘柄】（[OP]=既存ポジションあり、trade_signalsに含めない）`, instrumentList,
  ].join('\n');

  const systemPrompt =
    'あなたは為替FXトレーダーのAIアシスタントです。\n' +
    'ニュース一覧と市場状況を分析し、news_analysisとtrade_signalsを返してください。\n' +
    '必ずJSON形式で返答:\n' +
    '{"news_analysis":[{"index":0,"attention":true,"impact":"50文字以内","affected_pairs":["USD/JPY"]}],' +
    '"trade_signals":[{"pair":"USD/JPY","decision":"BUY","tp_rate":150.50,"sl_rate":149.80,"reasoning":"100文字以内"}]}\n' +
    'title_jaフィールドは不要。';

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.3,
    }),
  }, STAGE1_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude newsStage1 error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json<{ content: Array<{ type: string; text: string }> }>();
  const text = data.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude newsStage1: no JSON object found');
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    news_analysis: parsed.news_analysis ?? [],
    trade_signals: parsed.trade_signals ?? [],
  };
}

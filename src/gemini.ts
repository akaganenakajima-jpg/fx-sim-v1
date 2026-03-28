// Gemini API 呼び出し・レスポンス解析

import type { MarketIndicators } from './indicators';
import type { NewsItem } from './news';
// import type { InstrumentConfig } from './instruments'; // Path A廃止で不使用
import { insertTokenUsage } from './db';

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
export const PROMPT_VERSION = 'v17'; // v17: SLを狭くしてRRを稼ぐ禁止追加 + sanity.tsパターン5/6でSL距離クランプ補正

/** RR定義プロンプト — 全AI共通・全プロンプトの先頭に挿入（変更禁止） */
export const RR_DEFINITION_PROMPT =
  '【絶対原則 — RR定義（全AI共通・変更禁止）】\n' +
  '本システムにおける「勝ち」の定義:\n' +
  '  勝ち = 実現RR ≥ 1.0（リスクと同等以上のリターンを獲得した取引）\n' +
  '  負け = 実現RR < 1.0（リスクに見合うリターンを得られなかった取引）\n' +
  '  実現RR = 実現利益 / 初期リスク（エントリー時のSL距離）\n' +
  '\n' +
  'あなたの唯一の目的は「RRの最大化」である。\n' +
  '- TP/SL設定時: RR ≥ 2.0 を最低基準、RR ≥ 3.0 を推奨\n' +
  '- 「pnlがプラスだから良い」という判断は禁止。RR < 1.0 のプラス取引は「負け」である\n' +
  '- 「勝ち」という表現は上記定義以外での使用を禁止する\n';

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent';

// B2専用: 高速モデル（8sタイムアウト内に収まる）
const GEMINI_FLASH_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const AI_TIMEOUT_MS = 12_000; // AI API呼び出し12秒タイムアウト
// const NEWS_ANALYSIS_TIMEOUT_MS = 12_000; // DEPRECATED_v2: analyzeNews系で使用していたが削除
/* --- DELETED Path A helpers (HEDGE_DELAY_MS / buildSystemInstruction / buildUserMessage)
   これらは getDecision/getDecisionWithHedge 専用。Ph.6 Path A廃止で不使用。 */

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = AI_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

// buildSystemInstruction: Path A廃止で削除（getDecision専用だったため）

// buildUserMessage: Path A廃止で削除（getDecision専用だったため）

interface GeminiResponse {
  candidates: Array<{
    content: { parts: Array<{ text: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}


// getDecision / getDecisionGPT / getDecisionClaude / getDecisionWithHedge は
// Ph.6 Path A廃止に伴い削除。ニュース理解専用の newsStage1WithHedge / newsStage2 を使用。

/* --- DELETED Path A functions ---
export async function getDecision(params: {
  instrument: InstrumentConfig;
  rate: number;
  indicators: MarketIndicators;
  news: NewsItem[];
  hasOpenPosition: boolean;
  recentTrades?: Array<{ pair: string; direction: string; pnl: number; close_reason: string }>;
  allPositionDirections?: string[];
  sparkRates?: number[];
  regime?: string;
  technicalText?: string;
  regimeProhibitions?: string;
  apiKey: string;
  db?: D1Database;
}): Promise<GeminiDecision> {
  const { apiKey, instrument, db, ...rest } = params;
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

  // トークン使用量記録
  if (db && data.usageMetadata) {
    void insertTokenUsage(db, 'gemini-3.1-pro-preview', 'PATH_A_GEMINI',
      data.usageMetadata.promptTokenCount ?? 0,
      data.usageMetadata.candidatesTokenCount ?? 0,
      instrument.pair);
  }

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
  hasOpenPosition: boolean;
  recentTrades?: Array<{ pair: string; direction: string; pnl: number; close_reason: string }>;
  allPositionDirections?: string[];
  sparkRates?: number[];
  regime?: string;
  db?: D1Database;
  apiKey: string;
}): Promise<GeminiDecision> {
  const { apiKey, instrument, db, ...rest } = params;
  const userMessage = buildUserMessage({ instrument, ...rest });
  const systemPrompt = buildSystemInstruction(instrument);

  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1',
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

  const data = await res.json<{
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>();
  const text = data.choices[0].message.content;
  const parsed = JSON.parse(text) as GeminiDecision;

  // トークン使用量記録
  if (db && data.usage) {
    void insertTokenUsage(db, 'gpt-4.1', 'PATH_A_GPT',
      data.usage.prompt_tokens ?? 0,
      data.usage.completion_tokens ?? 0,
      instrument.pair);
  }

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
  hasOpenPosition: boolean;
  recentTrades?: Array<{ pair: string; direction: string; pnl: number; close_reason: string }>;
  allPositionDirections?: string[];
  sparkRates?: number[];
  regime?: string;
  apiKey: string;
  db?: D1Database;
}): Promise<GeminiDecision> {
  const { apiKey, instrument, db, ...rest } = params;
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
      model: 'claude-sonnet-4-6',
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

  const data = await res.json<{
    content: Array<{ type: string; text: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>();
  const text = data.content[0].text;

  // トークン使用量記録
  if (db && data.usage) {
    void insertTokenUsage(db, 'claude-sonnet-4-6', 'PATH_A_CLAUDE',
      data.usage.input_tokens ?? 0,
      data.usage.output_tokens ?? 0,
      instrument.pair);
  }

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
  hasOpenPosition: boolean;
  recentTrades?: Array<{ pair: string; direction: string; pnl: number; close_reason: string }>;
  allPositionDirections?: string[];
  sparkRates?: number[];
  regime?: string;
  technicalText?: string;
  regimeProhibitions?: string;
  pairAvgRr?: number; // 銘柄別RR実績（>2.0でTPボーナス）
  geminiApiKey: string;
  openaiApiKey?: string;
  openaiApiKey2?: string;
  anthropicApiKey?: string;
  keyIndex?: number;
  db?: D1Database;
}): Promise<HedgeResult> {
  const { geminiApiKey, openaiApiKey, openaiApiKey2, anthropicApiKey, keyIndex, db, ...common } = params;

  // Geminiを即座に開始
  const geminiPromise = getDecision({ ...common, apiKey: geminiApiKey, db })
    .then(d => ({ decision: d, provider: 'gemini' as const }));

  // 4秒後にGPTをヘッジとして開始（Geminiがまだ返ってなければ）
  const hedgePromise = new Promise<HedgeResult>((resolve, reject) => {
    setTimeout(async () => {
      if (openaiApiKey) {
        try {
          const oaiKey = (keyIndex !== undefined && keyIndex % 2 === 0 ? openaiApiKey : openaiApiKey2) || openaiApiKey;
          const d = await getDecisionGPT({ ...common, apiKey: oaiKey, db });
          resolve({ decision: d, provider: 'gpt' });
        } catch (gptErr) {
          // GPTも失敗 → Claude
          if (anthropicApiKey) {
            try {
              const d = await getDecisionClaude({ ...common, apiKey: anthropicApiKey, db });
              resolve({ decision: d, provider: 'claude' });
            } catch { reject(new Error('All hedge providers failed')); }
          } else { reject(gptErr); }
        }
      } else if (anthropicApiKey) {
        try {
          const d = await getDecisionClaude({ ...common, apiKey: anthropicApiKey, db });
          resolve({ decision: d, provider: 'claude' });
        } catch (e) { reject(e); }
      } else { reject(new Error('No hedge provider')); }
    }, HEDGE_DELAY_MS);
  });

  // 最初に成功した方を採用（エラーは無視してもう一方を待つ）
  return Promise.any([geminiPromise, hedgePromise]);
}
--- END DELETED Path A functions --- */

// ── ニュース分析型定義（v2: Path B用に拡張）──

/** Path B newsStage1/newsStage2 で使用するニュース分析アイテム */
export interface NewsAnalysisItem {
  index: number;
  attention: boolean;
  /** 経済指標インパクト分類: S=50-300pip超, A=20-80pip, B=10-40pip, C=その他 */
  impact_level?: 'S' | 'A' | 'B' | 'C';
  impact: string;
  title_ja: string;
  affected_pairs: string[];
  link?: string;
  og_description?: string; // B2でfetch後に付与
  [key: string]: unknown; // インデックスシグネチャ（translateTitlesWithHaiku互換）
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
    RR_DEFINITION_PROMPT + '\n' +
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
  indicators: MarketIndicators;
  instruments: Array<{ pair: string; hasOpenPosition: boolean; tpSlHint?: string; correlationGroup?: string; currentRate?: number }>;
  apiKey: string;
  db?: D1Database;
  // 施策6: テクニカル環境認識テキスト（ADX/ATR/RSI/レジーム分類）
  regimeText?: string;
  // 施策20: レジーム別禁止行動（レンジ時→順張り禁止 等）
  regimeProhibitions?: string;
}): Promise<NewsStage1Result> {
  const { news, indicators, instruments, apiKey, db, regimeText, regimeProhibitions } = params;

  const newsList = news.slice(0, 20).map((n, i) =>
    `[${i}] ${n.title_ja || n.title}${(n as any).source ? ` (${(n as any).source})` : ''}`
  ).join('\n');

  const THEME_STOCK_GROUPS = ['jp_ai_dc', 'jp_defense', 'jp_entertainment'];
  const instrumentList = instruments.map(inst => {
    const base = inst.hasOpenPosition ? `${inst.pair}[OP]` : inst.pair;
    const rate = inst.currentRate != null ? `[rate=${inst.currentRate}]` : '';
    const hint = inst.tpSlHint ? `(${inst.tpSlHint})` : '';
    const tag = THEME_STOCK_GROUPS.includes(inst.correlationGroup ?? '') ? '[テーマ株・モメンタム重視]' : '';
    return `${base}${rate}${hint}${tag}`;
  }).join('\n');

  const userMessage = [
    `【ニュース一覧】`,
    newsList,
    ``,
    `【市場状況】`,
    `米10年債利回り: ${indicators.us10y != null ? indicators.us10y.toFixed(2) + '%' : 'N/A'}`,
    `VIX: ${indicators.vix != null ? indicators.vix.toFixed(2) : 'N/A'}`,
    `日経平均: ${indicators.nikkei != null ? indicators.nikkei.toFixed(0) : 'N/A'}`,
    `S&P500: ${indicators.sp500 != null ? indicators.sp500.toFixed(0) : 'N/A'}`,
    ...(indicators.fearGreed != null ? [`暗号資産Fear&Greed指数: ${indicators.fearGreed} (${indicators.fearGreedLabel ?? ''}) ※0=極度の恐怖〜100=極度の強欲`] : []),
    ...(indicators.cftcJpyNetLong != null ? [`CFTC円先物大口投機筋: ${indicators.cftcJpyNetLong > 0 ? '+' : ''}${indicators.cftcJpyNetLong.toLocaleString()}枚 (正=円買い超, 負=円売り超)`] : []),
    ``,
    // 施策6: テクニカル環境認識（ADX/ATR/RSI/レジーム）
    ...(regimeText ? [`【テクニカル環境認識（施策6）】`, regimeText, ``] : []),
    // 施策20: 現在のレジームで禁止される行動（AIへの絶対指示）
    ...(regimeProhibitions ? [`【現在の禁止行動（施策20）】`, regimeProhibitions, ``] : []),
    `【対象銘柄】（[OP]=既存ポジションあり、trade_signalsに含めない）`,
    instrumentList,
  ].join('\n');

  const systemPrompt =
    RR_DEFINITION_PROMPT + '\n' +
    'あなたはFX・株式指数・コモディティのマルチアセットトレーダーのAIアシスタントです。\n' +
    '以下のニュース一覧（日本語翻訳済み）と市場状況を分析し、次の2つのことを返してください。\n' +
    '1. 各ニュースの注目度評価（news_analysis）\n' +
    '2. ニュースに基づいた売買シグナル（trade_signals）\n\n' +
    '必ず以下のJSON形式のみで返答してください:\n' +
    '{"news_analysis":[{"index":0,"attention":true,"impact_level":"S","impact":"円安・株安要因（50文字以内）","affected_pairs":["USD/JPY","Nikkei225"]}],' +
    '"trade_signals":[{"pair":"USD/JPY","decision":"BUY","tp_rate":160.50,"sl_rate":158.00,"reasoning":"日本語100文字以内"}]}\n\n' +
    'impact_levelの定義（経済指標インパクト分類）:\n' +
    '- S: FOMC金利決定・米雇用統計・米CPI・日銀会合・地政学リスク急変。50-300pip超の値動き\n' +
    '- A: GDP・ISM・ECB/BOE金利決定・要人発言の方針転換・地政学リスク拡大。20-80pipの値動き\n' +
    '- B: ADP・PPI・小売売上高・PMI・企業決算。10-40pipの小〜中程度の値動き\n' +
    '- C: 一般ニュース・既知情報・直接インパクトが薄いもの\n' +
    '→ attention:trueはSまたはAのみ設定する\n' +
    '→ trade_signalsに含めるのはimpact_levelがSまたはAのニュースのみ（BとCのニュースでのエントリーは禁止）\n\n' +
    'TP/SL方向の絶対ルール（違反はシステムが自動拒否）:\n' +
    '- BUY: tp_rate は現在レートより【高い】価格 / sl_rate は現在レートより【低い】価格\n' +
    '- SELL: tp_rate は現在レートより【低い】価格 / sl_rate は現在レートより【高い】価格\n' +
    '- 例(BUY, rate=5.29): tp_rate=5.55(上), sl_rate=5.15(下) ← SLは必ずentryより下\n' +
    '- 例(SELL, rate=1.33): tp_rate=1.30(下), sl_rate=1.36(上) ← SLは必ずentryより上\n' +
    '- 例(USD/JPY SELL, rate=158.37): tp_rate=156.00(下), sl_rate=160.50(上) ← 大きい値でもSELLのSLは必ずentry(158.37)より上\n' +
    '- 例(Gold BUY, rate=4550): tp_rate=4650(上), sl_rate=4490(下) ← BUYのSLはentry(4550)より必ず下。Goldは現在4000-5000台(2000-3000台の旧価格は使用禁止。SL距離最低$15)\n' +
    '- 例(Gold SELL, rate=4545): tp_rate=4500(下), sl_rate=4575(上) ← SELLのSLはentry(4545)より必ず上。4500<4545<4575の順序を数値で確認\n' +
    '- 例(CrudeOil BUY, rate=89.00): tp_rate=90.40(上), sl_rate=88.40(下) ← BUYのSLはentry(89.00)より必ず下。88.40<89.00<90.40の順序を数値で確認\n' +
    '- 例(CrudeOil SELL, rate=89.00): tp_rate=87.60(下), sl_rate=89.60(上) ← SELLのSLはentry(89.00)より必ず上。87.60<89.00<89.60の順序を数値で確認\n' +
    '- 例(Silver BUY, rate=73): tp_rate=76(上), sl_rate=70(下) ← Silverは現在70-80台(20-40台の旧価格は使用禁止)\n' +
    '- 例(GBP/USD BUY, rate=1.3376): tp_rate=1.3476(上), sl_rate=1.3226(下) ← GBP/USDは現在1.28-1.40台(1.20-1.27台の旧価格は使用禁止)\n' +
    '- 例(GBP/USD SELL, rate=1.3386): tp_rate=1.3086(下), sl_rate=1.3586(上) ← SELLのSLはentry(1.3386)より必ず上。1.3086<1.3386<1.3586の順序を数値で確認\n' +
    '- 例(EUR/USD BUY, rate=1.16): tp_rate=1.17(上), sl_rate=1.15(下) ← EUR/USDは現在1.10-1.20台(1.0-1.09台の旧価格は使用禁止)\n' +
    '- 例(SOL/USD BUY, rate=92.00): tp_rate=96.00(上), sl_rate=88.00(下) ← SOL/USDは現在$85-105台($130-160台の旧価格は使用禁止。SL距離最低$2)\n' +
    '- 例(SOL/USD SELL, rate=92.00): tp_rate=88.00(下), sl_rate=96.00(上) ← SELLのSLはentry(92.00)より必ず上。88.00<92.00<96.00の順序を数値で確認\n' +
    '- 例(HK33 BUY, rate=25200): tp_rate=25500(上), sl_rate=25000(下) ← HK33は現在24000-27000台(18000-22000台の旧価格は使用禁止。SL距離最低80pt)\n' +
    '- 例(HK33 SELL, rate=25200): tp_rate=24900(下), sl_rate=25400(上) ← SELLのSLはentry(25200)より必ず上。24900<25200<25400の順序を数値で確認\n' +
    '- tp_rate/sl_rateは各銘柄の現在レートを起点にした絶対価格で返す\n\n' +
    'その他ルール:\n' +
    '- trade_signalsはBUYまたはSELLのみ（HOLDは含めない）\n' +
    '- [OP]マークの銘柄: 通常はtrade_signalsに含めない。ただしニュースが現在のポジション方向と明確に逆行し、かつ確信度が非常に高い場合のみ含めてよい（その場合reasoningの先頭に必ず"REVERSAL:"を付記すること）\n' +
    '- tp_rate/sl_rateは必ず数値で返す（nullは不可）\n' +
    '- 【RR比設定手順・必須・自動拒否回避】①SL距離を決める（最低tpSlMin以上必須・未満は即自動拒否。USD/JPYなら最低0.2円・推奨0.3〜0.8円）②RR比を計算・検証【送信前必須チェック】RR=TP距離÷SL距離を計算し2.0以上を確認してから送信（目標はRR3.0以上。有効なRR例: 2.00✅, 2.50✅, 3.00✅, 4.00✅ / 無効で即自動拒否: 0.60❌, 0.83❌, 0.88❌, 0.93❌, 0.99❌, 1.2❌, 1.4❌, 1.5❌, 1.6❌, 1.8❌, 1.9❌（RR<2.0は全て自動拒否対象）。TP距離の計算: SL=0.4円→TP最低0.8円(RR2.0)・推奨1.2円(RR3.0)、SL=0.3円→TP最低0.6円・推奨0.9円、SL=0.5円→TP最低1.0円・推奨1.5円）③絶対価格に変換【entryレートは小数点以下を含めそのまま使う・絶対に丸めない（entry=158.396を158.4にするのは禁止）】（BUY: sl=entry-SL距離【sl<entry厳守。sl≥entryは即自動拒否・距離ゼロも拒否】, tp=entry+TP距離【tp>entry厳守】 / SELL: sl=entry+SL距離【sl>entry厳守。sl≤entryは即自動拒否・距離ゼロも拒否】, tp=entry-TP距離【tp<entry厳守】）。例BUY entry=158.396→sl=158.096(=158.396-0.3), tp=159.296(=158.396+0.9)(RR=3.00✅)。例SELL entry=158.396→sl=158.696(=158.396+0.3), tp=157.496(=158.396-0.9)(RR=3.00✅)\n' +
    '- 【⚠️ SLを狭くしてRRを稼ぐのは絶対禁止】RRを2.0以上にする方法はTPを遠くすることのみ。SL距離は必ずtpSlMin以上を維持し、TP距離=SL距離×2.0以上で設定する。例: MSFT(tpSlMin=2.0)でRR2.0 → SL=entry±2.0(最低ライン), TP=entry±4.0以上。SL=entry±0.03のような極端に狭いSLは即自動拒否される（距離クランプ補正が入るが確実なエントリーのため自分で正しく設定すること）\n' +
    '- 【SL距離の厳守・自動拒否回避】SL距離は必ずtpSlMin以上tpSlMax以下でなければならない（この範囲外は値の大小を問わず例外なく即自動拒否）。USD/JPYの場合: 0.2≤SL距離≤1.2が必須。下限違反例: 0.19, 0.16, 0.08（0.2未満）/ 上限違反例: 1.21, 1.25, 1.38, 1.50, 2.00, 2.38, 2.40（1.2超はどんな値でも拒否）。安全な推奨範囲: 0.30〜0.80（迷ったら必ずこの範囲で設定すること）\n' +
    '- 【方向最終チェック・送信前必須】BUY: sl_rate < entry_rate でなければ即自動拒否（sl_rate ≥ entry_rateは全て拒否。例: entry=158.337でsl=158.5はBUYとして拒否）。SELL: sl_rate > entry_rate でなければ即自動拒否（sl_rate ≤ entry_rateは全て拒否）。送信前に必ずsl_rateとentry_rateの大小を数値で確認すること\n' +
    '- 【ニュース品質フィルタ・最重要】impact_levelがSまたはAのニュースのみtrade_signalsに含めること。BまたはCレベルのニュースはtrade_signalsに含めない（BまたはCレベルのニュースでエントリーしても期待RRが出ない）\n' +
    '- 確信度が低いニュースはtrade_signalsに含めない\n' +
    '- 【送信前絶対検証・省略禁止】各シグナルを送信する前に必ず: (1)BUYなら tp_rate > entry_rate を確認 / (2)SELLなら tp_rate < entry_rate を確認 / 条件を満たさないシグナルは送信せず削除する\n' +
    '- attention:falseのニュースはimpact/impact_level/affected_pairsを空にする\n' +
    '- affected_pairs選定: 直接影響だけでなく間接影響も含める。地政学リスク・原油高・米金利急変はNikkei225/S&P500/NASDAQ/DAXにも影響する。為替と株式指数は同じニュースで同時に動くことが多い\n' +
    '- 【テーマ株モード】[テーマ株・モメンタム重視]タグの銘柄は小型テーマ株（モメンタム型）です。判断基準: (1)ファンダメンタルズよりモメンタム（出来高変化・投資家の注目度）を最重視 (2)ニュースの「話題性」と「投資家殺到度」で方向判断 (3)乱高下を恐れず方向が明確なら積極エントリー (4)RR2.0以上を狙いSLはATR×1.0〜1.5で広めにOK';

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

  // トークン使用量記録
  if (db && data.usageMetadata) {
    void insertTokenUsage(db, 'gemini-3.1-pro-preview', 'PATH_B1_GEMINI',
      data.usageMetadata.promptTokenCount ?? 0,
      data.usageMetadata.candidatesTokenCount ?? 0);
  }

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
  db?: D1Database;
}): Promise<NewsStage2Result> {
  const { stage1Result, news, apiKey, db } = params;

  const signalList = stage1Result.trade_signals.map(s =>
    `${s.pair}: ${s.decision} TP=${s.tp_rate} SL=${s.sl_rate} / ${s.reasoning}`
  ).join('\n');

  const attentionNews = stage1Result.news_analysis
    .filter(a => a.attention)
    .slice(0, 5)
    .map(a => {
      const item = news[a.index];
      const ogDesc = a.og_description ?? item?.desc_ja ?? item?.description ?? '（詳細なし）';
      return `[${a.index}] ${(item?.title_ja || item?.title) ?? ''}\nog:description: ${ogDesc.slice(0, 300)}`;
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
    RR_DEFINITION_PROMPT + '\n' +
    'あなたは為替FXトレーダーのAIアシスタントです。\n' +
    'B1（速報）の売買シグナルをog:description（詳細情報）で再評価してください。\n\n' +
    '必ず以下のJSON形式のみで返答してください:\n' +
    '{"corrections":[{"pair":"USD/JPY","action":"CONFIRM","reasoning":"詳細を確認、B1判断を維持"}]}\n\n' +
    'actionの種類:\n' +
    '- CONFIRM: B1の判断を維持（tp_rate/sl_rateはB1値をそのまま使用）\n' +
    '- REVISE: TP/SLを修正（方向は変えない）。new_tp_rate/new_sl_rateを指定（省略=B1値を維持）\n' +
    '  → REVISE時の必須ルール: new_tp_rateは必ずB1のtp_rateよりTPを遠くする（RRを現在以上に改善すること）。SLを広げてRRを下げることは禁止。\n' +
    '  → RR改善の判断: og:descriptionで期待値が高いと判断できる場合、RR3.0以上になるようにTPを遠く設定すること\n' +
    '- REVERSE: 反対方向に変更推奨（既存ポジションがあれば決済）\n' +
    'B1シグナルの全pairに対してcorrectionsを返すこと。';

  const res = await fetchWithTimeout(`${GEMINI_FLASH_ENDPOINT}?key=${apiKey}`, {
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

  // トークン使用量記録
  if (db && data.usageMetadata) {
    void insertTokenUsage(db, 'gemini-2.5-flash', 'PATH_B2_GEMINI',
      data.usageMetadata.promptTokenCount ?? 0,
      data.usageMetadata.candidatesTokenCount ?? 0);
  }

  return JSON.parse(text) as NewsStage2Result;
}

// ── B1/B2 ヘッジ: Gemini → GPT → Claude フォールバック ──

/** newsStage1 + GPT/Claude フォールバック */
export async function newsStage1WithHedge(params: {
  news: NewsItem[];
  indicators: MarketIndicators;
  instruments: Array<{ pair: string; hasOpenPosition: boolean; tpSlHint?: string; correlationGroup?: string; currentRate?: number }>;
  apiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  db?: D1Database;
  // 施策6+20: テクニカル環境認識・禁止行動（Gemini/GPT/Claude 全プロバイダーに伝播）
  regimeText?: string;
  regimeProhibitions?: string;
}): Promise<NewsStage1Result & { provider: string }> {
  const { openaiApiKey, anthropicApiKey, db, ...geminiParams } = params;

  // 1. Gemini を試行
  try {
    const result = await newsStage1({ ...geminiParams, db });
    return { ...result, provider: 'gemini' };
  } catch (geminiErr) {
    console.warn(`[fx-sim] B1 Gemini failed: ${String(geminiErr).split('\n')[0].slice(0, 80)}`);

    // 2. GPT フォールバック
    if (openaiApiKey) {
      try {
        const result = await newsStage1GPT({ ...params, apiKey: openaiApiKey, db } as any);
        return { ...result, provider: 'gpt' };
      } catch (gptErr) {
        console.warn(`[fx-sim] B1 GPT failed: ${String(gptErr).split('\n')[0].slice(0, 80)}`);
      }
    }

    // 3. Claude フォールバック
    if (anthropicApiKey) {
      try {
        const result = await newsStage1Claude({ ...params, apiKey: anthropicApiKey, db });
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
  indicators: MarketIndicators;
  instruments: Array<{ pair: string; hasOpenPosition: boolean; tpSlHint?: string; correlationGroup?: string; currentRate?: number }>;
  apiKey: string;
  regimeText?: string;
  regimeProhibitions?: string;
}): Promise<NewsStage1Result> {
  const { news, indicators, instruments, apiKey, regimeText, regimeProhibitions } = params;

  const newsList = news.slice(0, 20).map((n, i) =>
    `[${i}] ${n.title_ja || n.title}${(n as any).source ? ` (${(n as any).source})` : ''}`
  ).join('\n');

  const THEME_STOCK_GROUPS = ['jp_ai_dc', 'jp_defense', 'jp_entertainment'];
  const instrumentList = instruments.map(inst => {
    const base = inst.hasOpenPosition ? `${inst.pair}[OP]` : inst.pair;
    const rate = inst.currentRate != null ? `[rate=${inst.currentRate}]` : '';
    const hint = inst.tpSlHint ? `(${inst.tpSlHint})` : '';
    const tag = THEME_STOCK_GROUPS.includes(inst.correlationGroup ?? '') ? '[テーマ株・モメンタム重視]' : '';
    return `${base}${rate}${hint}${tag}`;
  }).join('\n');

  const userMessage = [
    `【ニュース一覧】`, newsList, ``,
    `【市場状況】`,
    `米10年債利回り: ${indicators.us10y != null ? indicators.us10y.toFixed(2) + '%' : 'N/A'}`,
    `VIX: ${indicators.vix != null ? indicators.vix.toFixed(2) : 'N/A'}`,
    `日経平均: ${indicators.nikkei != null ? indicators.nikkei.toFixed(0) : 'N/A'}`,
    `S&P500: ${indicators.sp500 != null ? indicators.sp500.toFixed(0) : 'N/A'}`,
    ``,
    ...(regimeText ? [`【テクニカル環境認識（施策6）】`, regimeText, ``] : []),
    ...(regimeProhibitions ? [`【現在の禁止行動（施策20）】`, regimeProhibitions, ``] : []),
    `【対象銘柄】（[OP]=既存ポジションあり、trade_signalsに含めない）`, instrumentList,
  ].join('\n');

  const systemPrompt =
    RR_DEFINITION_PROMPT + '\n' +
    'あなたはFX・株式指数・コモディティのマルチアセットトレーダーのAIアシスタントです。\n' +
    '以下のニュース一覧（日本語翻訳済み）と市場状況を分析し、次の2つのことを返してください。\n' +
    '1. 各ニュースの注目度評価（news_analysis）\n' +
    '2. ニュースに基づいた売買シグナル（trade_signals）\n\n' +
    '必ず以下のJSON形式のみで返答してください:\n' +
    '{"news_analysis":[{"index":0,"attention":true,"impact_level":"S","impact":"円安・株安要因（50文字以内）","affected_pairs":["USD/JPY","Nikkei225"]}],' +
    '"trade_signals":[{"pair":"USD/JPY","decision":"BUY","tp_rate":160.50,"sl_rate":158.00,"reasoning":"日本語100文字以内"}]}\n\n' +
    'impact_levelの定義（経済指標インパクト分類）:\n' +
    '- S: FOMC金利決定・米雇用統計・米CPI・日銀会合・地政学リスク急変。50-300pip超の値動き\n' +
    '- A: GDP・ISM・ECB/BOE金利決定・要人発言の方針転換・地政学リスク拡大。20-80pipの値動き\n' +
    '- B: ADP・PPI・小売売上高・PMI・企業決算。10-40pipの小〜中程度の値動き\n' +
    '- C: 一般ニュース・既知情報・直接インパクトが薄いもの\n' +
    '→ attention:trueはSまたはAのみ設定する\n' +
    '→ trade_signalsに含めるのはimpact_levelがSまたはAのニュースのみ（BとCのニュースでのエントリーは禁止）\n\n' +
    'TP/SL方向の絶対ルール（違反はシステムが自動拒否）:\n' +
    '- BUY → tp_rate > 現在レート かつ sl_rate < 現在レート（上が利確・下が損切）\n' +
    '- SELL → tp_rate < 現在レート かつ sl_rate > 現在レート（下が利確・上が損切）\n' +
    '- 例(BUY, rate=5.29): tp_rate=5.55(上), sl_rate=5.15(下) ← SLは必ずentryより下\n' +
    '- 例(SELL, rate=1.33): tp_rate=1.30(下), sl_rate=1.36(上) ← SLは必ずentryより上\n' +
    '- 例(USD/JPY SELL, rate=158.37): tp_rate=156.00(下), sl_rate=160.50(上) ← 大きい値でもSELLのSLは必ずentry(158.37)より上\n' +
    '- 例(Gold BUY, rate=4550): tp_rate=4650(上), sl_rate=4490(下) ← BUYのSLはentry(4550)より必ず下。Goldは現在4000-5000台(2000-3000台の旧価格は使用禁止。SL距離最低$15)\n' +
    '- 例(Gold SELL, rate=4545): tp_rate=4500(下), sl_rate=4575(上) ← SELLのSLはentry(4545)より必ず上。4500<4545<4575の順序を数値で確認\n' +
    '- 例(CrudeOil BUY, rate=89.00): tp_rate=90.40(上), sl_rate=88.40(下) ← BUYのSLはentry(89.00)より必ず下。88.40<89.00<90.40の順序を数値で確認\n' +
    '- 例(CrudeOil SELL, rate=89.00): tp_rate=87.60(下), sl_rate=89.60(上) ← SELLのSLはentry(89.00)より必ず上。87.60<89.00<89.60の順序を数値で確認\n' +
    '- 例(Silver BUY, rate=73): tp_rate=76(上), sl_rate=70(下) ← Silverは現在70-80台(20-40台の旧価格は使用禁止)\n' +
    '- 例(GBP/USD BUY, rate=1.3376): tp_rate=1.3476(上), sl_rate=1.3226(下) ← GBP/USDは現在1.28-1.40台(1.20-1.27台の旧価格は使用禁止)\n' +
    '- 例(GBP/USD SELL, rate=1.3386): tp_rate=1.3086(下), sl_rate=1.3586(上) ← SELLのSLはentry(1.3386)より必ず上。1.3086<1.3386<1.3586の順序を数値で確認\n' +
    '- 例(EUR/USD BUY, rate=1.16): tp_rate=1.17(上), sl_rate=1.15(下) ← EUR/USDは現在1.10-1.20台(1.0-1.09台の旧価格は使用禁止)\n' +
    '- 例(SOL/USD BUY, rate=92.00): tp_rate=96.00(上), sl_rate=88.00(下) ← SOL/USDは現在$85-105台($130-160台の旧価格は使用禁止。SL距離最低$2)\n' +
    '- 例(SOL/USD SELL, rate=92.00): tp_rate=88.00(下), sl_rate=96.00(上) ← SELLのSLはentry(92.00)より必ず上。88.00<92.00<96.00の順序を数値で確認\n' +
    '- 例(HK33 BUY, rate=25200): tp_rate=25500(上), sl_rate=25000(下) ← HK33は現在24000-27000台(18000-22000台の旧価格は使用禁止。SL距離最低80pt)\n' +
    '- 例(HK33 SELL, rate=25200): tp_rate=24900(下), sl_rate=25400(上) ← SELLのSLはentry(25200)より必ず上。24900<25200<25400の順序を数値で確認\n' +
    '- tp_rate/sl_rateは各銘柄の現在レートを起点にした絶対価格で返す\n\n' +
    'その他ルール:\n- trade_signalsはBUYまたはSELLのみ（HOLDは含めない）\n- [OP]マークの銘柄はtrade_signalsに含めない\n' +
    '- tp_rate/sl_rateは必ず数値で返す（nullは不可）\n' +
    '- 【RR比設定手順・必須・自動拒否回避】①SL距離を決める（最低tpSlMin以上必須・未満は即自動拒否。USD/JPYなら最低0.2円・推奨0.3〜0.8円）②RR比を計算・検証【送信前必須チェック】RR=TP距離÷SL距離を計算し1.5以上を確認してから送信（有効なRR例: 1.50✅, 1.67✅, 2.00✅ / 無効で即自動拒否: 0.60❌, 0.83❌, 0.88❌, 0.93❌, 0.99❌, 1.2❌, 1.4❌（RR<1.0はTPがSLより近い致命的エラー）。TP距離の計算: SL=0.4円→TP最低0.6円・SL=0.3円→TP最低0.45円・SL=0.5円→TP最低0.75円）③絶対価格に変換【entryレートは小数点以下を含めそのまま使う・絶対に丸めない（entry=158.396を158.4にするのは禁止）】（BUY: sl=entry-SL距離【sl<entry厳守。sl≥entryは即自動拒否・距離ゼロも拒否】, tp=entry+TP距離【tp>entry厳守】 / SELL: sl=entry+SL距離【sl>entry厳守。sl≤entryは即自動拒否・距離ゼロも拒否】, tp=entry-TP距離【tp<entry厳守】）。例BUY entry=158.396→sl=158.096(=158.396-0.3), tp=158.896(=158.396+0.5)(RR=1.67✅)。例SELL entry=158.396→sl=158.696(=158.396+0.3), tp=157.896(=158.396-0.5)(RR=1.67✅)\n' +
    '- 【⚠️ SLを狭くしてRRを稼ぐのは絶対禁止】RRを2.0以上にする方法はTPを遠くすることのみ。SL距離は必ずtpSlMin以上を維持し、TP距離=SL距離×2.0以上で設定する。例: MSFT(tpSlMin=2.0)でRR2.0 → SL=entry±2.0(最低ライン), TP=entry±4.0以上。SL=entry±0.03のような極端に狭いSLは即自動拒否される（距離クランプ補正が入るが確実なエントリーのため自分で正しく設定すること）\n' +
    '- 【SL距離の厳守・自動拒否回避】SL距離は必ずtpSlMin以上tpSlMax以下でなければならない（この範囲外は値の大小を問わず例外なく即自動拒否）。USD/JPYの場合: 0.2≤SL距離≤1.2が必須。下限違反例: 0.19, 0.16, 0.08（0.2未満）/ 上限違反例: 1.21, 1.25, 1.38, 1.50, 2.00, 2.38, 2.40（1.2超はどんな値でも拒否）。安全な推奨範囲: 0.30〜0.80（迷ったら必ずこの範囲で設定すること）\n' +
    '- 【方向最終チェック・送信前必須】BUY: sl_rate < entry_rate でなければ即自動拒否（sl_rate ≥ entry_rateは全て拒否。例: entry=158.337でsl=158.5はBUYとして拒否）。SELL: sl_rate > entry_rate でなければ即自動拒否（sl_rate ≤ entry_rateは全て拒否）。送信前に必ずsl_rateとentry_rateの大小を数値で確認すること\n' +
    '- 確信度が低いニュースはtrade_signalsに含めない\n' +
    '- affected_pairs選定: 直接影響だけでなく間接影響も含める。地政学リスク・原油高・米金利急変はNikkei225/S&P500/NASDAQ/DAXにも影響する。為替と株式指数は同じニュースで同時に動くことが多い\n' +
    '- 【テーマ株モード】[テーマ株・モメンタム重視]タグの銘柄は小型テーマ株（モメンタム型）です。判断基準: (1)ファンダメンタルズよりモメンタム（出来高変化・投資家の注目度）を最重視 (2)ニュースの「話題性」と「投資家殺到度」で方向判断 (3)乱高下を恐れず方向が明確なら積極エントリー (4)RR2.0以上を狙いSLはATR×1.0〜1.5で広めにOK';

  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4.1',
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

  const data = await res.json<{
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>();
  const text = data.choices[0].message.content;
  const parsed = JSON.parse(text);

  // トークン使用量記録（newsStage1GPTはdbをparams経由で受け取る）
  if ((params as any).db && data.usage) {
    void insertTokenUsage((params as any).db, 'gpt-4.1', 'PATH_B1_GPT',
      data.usage.prompt_tokens ?? 0,
      data.usage.completion_tokens ?? 0);
  }

  // GPTはルートオブジェクトまたはネストで返す可能性がある
  return {
    news_analysis: parsed.news_analysis ?? [],
    trade_signals: parsed.trade_signals ?? [],
  };
}

/** B1 Claude版: newsStage1 と同じプロンプトを Claude に送る */
async function newsStage1Claude(params: {
  news: NewsItem[];
  indicators: MarketIndicators;
  instruments: Array<{ pair: string; hasOpenPosition: boolean; tpSlHint?: string; correlationGroup?: string; currentRate?: number }>;
  apiKey: string;
  db?: D1Database;
  regimeText?: string;
  regimeProhibitions?: string;
}): Promise<NewsStage1Result> {
  const { news, indicators, instruments, apiKey, regimeText, regimeProhibitions } = params;

  const newsList = news.slice(0, 20).map((n, i) =>
    `[${i}] ${n.title_ja || n.title}${(n as any).source ? ` (${(n as any).source})` : ''}`
  ).join('\n');

  const THEME_STOCK_GROUPS = ['jp_ai_dc', 'jp_defense', 'jp_entertainment'];
  const instrumentList = instruments.map(inst => {
    const base = inst.hasOpenPosition ? `${inst.pair}[OP]` : inst.pair;
    const rate = inst.currentRate != null ? `[rate=${inst.currentRate}]` : '';
    const hint = inst.tpSlHint ? `(${inst.tpSlHint})` : '';
    const tag = THEME_STOCK_GROUPS.includes(inst.correlationGroup ?? '') ? '[テーマ株・モメンタム重視]' : '';
    return `${base}${rate}${hint}${tag}`;
  }).join('\n');

  const userMessage = [
    `【ニュース一覧】`, newsList, ``,
    `【市場状況】`,
    `米10年債利回り: ${indicators.us10y != null ? indicators.us10y.toFixed(2) + '%' : 'N/A'}`,
    `VIX: ${indicators.vix != null ? indicators.vix.toFixed(2) : 'N/A'}`,
    `日経平均: ${indicators.nikkei != null ? indicators.nikkei.toFixed(0) : 'N/A'}`,
    `S&P500: ${indicators.sp500 != null ? indicators.sp500.toFixed(0) : 'N/A'}`,
    ``,
    ...(regimeText ? [`【テクニカル環境認識（施策6）】`, regimeText, ``] : []),
    ...(regimeProhibitions ? [`【現在の禁止行動（施策20）】`, regimeProhibitions, ``] : []),
    `【対象銘柄】（[OP]=既存ポジションあり、trade_signalsに含めない）`, instrumentList,
  ].join('\n');

  const systemPrompt =
    RR_DEFINITION_PROMPT + '\n' +
    'あなたはFX・株式指数・コモディティのマルチアセットトレーダーのAIアシスタントです。\n' +
    'ニュース一覧（日本語翻訳済み）と市場状況を分析し、news_analysisとtrade_signalsを返してください。\n' +
    '必ずJSON形式で返答:\n' +
    '{"news_analysis":[{"index":0,"attention":true,"impact":"円安・株安要因（50文字以内）","affected_pairs":["USD/JPY","Nikkei225"]}],' +
    '"trade_signals":[{"pair":"USD/JPY","decision":"BUY","tp_rate":160.50,"sl_rate":158.00,"reasoning":"100文字以内"}]}\n\n' +
    'TP/SL方向の絶対ルール（違反はシステムが自動拒否）:\n' +
    '- BUY: tp_rate は現在レートより【高い】価格 / sl_rate は現在レートより【低い】価格\n' +
    '- SELL: tp_rate は現在レートより【低い】価格 / sl_rate は現在レートより【高い】価格\n' +
    '- 例(BUY, rate=5.29): tp_rate=5.55(上), sl_rate=5.15(下) ← SLは必ずentryより下\n' +
    '- 例(SELL, rate=1.33): tp_rate=1.30(下), sl_rate=1.36(上) ← SLは必ずentryより上\n' +
    '- 例(USD/JPY SELL, rate=158.37): tp_rate=156.00(下), sl_rate=160.50(上) ← 大きい値でもSELLのSLは必ずentry(158.37)より上\n' +
    '- 例(Gold BUY, rate=4550): tp_rate=4650(上), sl_rate=4490(下) ← BUYのSLはentry(4550)より必ず下。Goldは現在4000-5000台(2000-3000台の旧価格は使用禁止。SL距離最低$15)\n' +
    '- 例(Gold SELL, rate=4545): tp_rate=4500(下), sl_rate=4575(上) ← SELLのSLはentry(4545)より必ず上。4500<4545<4575の順序を数値で確認\n' +
    '- 例(CrudeOil BUY, rate=89.00): tp_rate=90.40(上), sl_rate=88.40(下) ← BUYのSLはentry(89.00)より必ず下。88.40<89.00<90.40の順序を数値で確認\n' +
    '- 例(CrudeOil SELL, rate=89.00): tp_rate=87.60(下), sl_rate=89.60(上) ← SELLのSLはentry(89.00)より必ず上。87.60<89.00<89.60の順序を数値で確認\n' +
    '- 例(Silver BUY, rate=73): tp_rate=76(上), sl_rate=70(下) ← Silverは現在70-80台(20-40台の旧価格は使用禁止)\n' +
    '- 例(GBP/USD BUY, rate=1.3376): tp_rate=1.3476(上), sl_rate=1.3226(下) ← GBP/USDは現在1.28-1.40台(1.20-1.27台の旧価格は使用禁止)\n' +
    '- 例(GBP/USD SELL, rate=1.3386): tp_rate=1.3086(下), sl_rate=1.3586(上) ← SELLのSLはentry(1.3386)より必ず上。1.3086<1.3386<1.3586の順序を数値で確認\n' +
    '- 例(EUR/USD BUY, rate=1.16): tp_rate=1.17(上), sl_rate=1.15(下) ← EUR/USDは現在1.10-1.20台(1.0-1.09台の旧価格は使用禁止)\n' +
    '- 例(SOL/USD BUY, rate=92.00): tp_rate=96.00(上), sl_rate=88.00(下) ← SOL/USDは現在$85-105台($130-160台の旧価格は使用禁止。SL距離最低$2)\n' +
    '- 例(SOL/USD SELL, rate=92.00): tp_rate=88.00(下), sl_rate=96.00(上) ← SELLのSLはentry(92.00)より必ず上。88.00<92.00<96.00の順序を数値で確認\n' +
    '- 例(HK33 BUY, rate=25200): tp_rate=25500(上), sl_rate=25000(下) ← HK33は現在24000-27000台(18000-22000台の旧価格は使用禁止。SL距離最低80pt)\n' +
    '- 例(HK33 SELL, rate=25200): tp_rate=24900(下), sl_rate=25400(上) ← SELLのSLはentry(25200)より必ず上。24900<25200<25400の順序を数値で確認\n' +
    '- tp_rate/sl_rateは各銘柄の現在レートを起点にした絶対価格で返すこと\n' +
    '- 【RR比設定手順・必須・自動拒否回避】①SL距離を決める（最低tpSlMin以上必須・未満は即自動拒否。USD/JPYなら最低0.2円・推奨0.3〜0.8円）②RR比を計算・検証【送信前必須チェック】RR=TP距離÷SL距離を計算し1.5以上を確認してから送信（有効なRR例: 1.50✅, 1.67✅, 2.00✅ / 無効で即自動拒否: 0.60❌, 0.83❌, 0.88❌, 0.93❌, 0.99❌, 1.2❌, 1.4❌（RR<1.0はTPがSLより近い致命的エラー）。TP距離の計算: SL=0.4円→TP最低0.6円・SL=0.3円→TP最低0.45円・SL=0.5円→TP最低0.75円）③絶対価格に変換【entryレートは小数点以下を含めそのまま使う・絶対に丸めない（entry=158.396を158.4にするのは禁止）】（BUY: sl=entry-SL距離【sl<entry厳守。sl≥entryは即自動拒否・距離ゼロも拒否】, tp=entry+TP距離【tp>entry厳守】 / SELL: sl=entry+SL距離【sl>entry厳守。sl≤entryは即自動拒否・距離ゼロも拒否】, tp=entry-TP距離【tp<entry厳守】）。例BUY entry=158.396→sl=158.096(=158.396-0.3), tp=158.896(=158.396+0.5)(RR=1.67✅)。例SELL entry=158.396→sl=158.696(=158.396+0.3), tp=157.896(=158.396-0.5)(RR=1.67✅)\n' +
    '- 【⚠️ SLを狭くしてRRを稼ぐのは絶対禁止】RRを2.0以上にする方法はTPを遠くすることのみ。SL距離は必ずtpSlMin以上を維持し、TP距離=SL距離×2.0以上で設定する。例: MSFT(tpSlMin=2.0)でRR2.0 → SL=entry±2.0(最低ライン), TP=entry±4.0以上。SL=entry±0.03のような極端に狭いSLは即自動拒否される（距離クランプ補正が入るが確実なエントリーのため自分で正しく設定すること）\n' +
    '- 【SL距離の厳守・自動拒否回避】SL距離は必ずtpSlMin以上tpSlMax以下でなければならない（この範囲外は値の大小を問わず例外なく即自動拒否）。USD/JPYの場合: 0.2≤SL距離≤1.2が必須。下限違反例: 0.19, 0.16, 0.08（0.2未満）/ 上限違反例: 1.21, 1.25, 1.38, 1.50, 2.00, 2.38, 2.40（1.2超はどんな値でも拒否）。安全な推奨範囲: 0.30〜0.80（迷ったら必ずこの範囲で設定すること）\n' +
    '- 【方向最終チェック・送信前必須】BUY: sl_rate < entry_rate でなければ即自動拒否（sl_rate ≥ entry_rateは全て拒否。例: entry=158.337でsl=158.5はBUYとして拒否）。SELL: sl_rate > entry_rate でなければ即自動拒否（sl_rate ≤ entry_rateは全て拒否）。送信前に必ずsl_rateとentry_rateの大小を数値で確認すること\n' +
    '- affected_pairs選定: 直接影響だけでなく間接影響も含める。地政学リスク・原油高・米金利急変はNikkei225/S&P500/NASDAQ/DAXにも影響する。為替と株式指数は同じニュースで同時に動くことが多い\n' +
    '- 【テーマ株モード】[テーマ株・モメンタム重視]タグの銘柄は小型テーマ株（モメンタム型）です。判断基準: (1)ファンダメンタルズよりモメンタム（出来高変化・投資家の注目度）を最重視 (2)ニュースの「話題性」と「投資家殺到度」で方向判断 (3)乱高下を恐れず方向が明確なら積極エントリー (4)RR2.0以上を狙いSLはATR×1.0〜1.5で広めにOK';

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
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

  const data = await res.json<{
    content: Array<{ type: string; text: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>();
  const text = data.content[0].text;

  // トークン使用量記録
  if (params.db && data.usage) {
    void insertTokenUsage(params.db, 'claude-sonnet-4-6', 'PATH_B1_CLAUDE',
      data.usage.input_tokens ?? 0,
      data.usage.output_tokens ?? 0);
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude newsStage1: no JSON object found');
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    news_analysis: parsed.news_analysis ?? [],
    trade_signals: parsed.trade_signals ?? [],
  };
}

// 日本語・英語ニュースを複数ソースから取得
// ソース別の計測データ（レイテンシ・鮮度）も返す
// v3: JSON API ソース追加（Polygon / Finnhub / MarketAux / CryptoPanic）
//     各ソースに enabled フラグ追加（false でスキップ）

import { insertSystemLog, insertTokenUsage } from './db';
import { CRYPTO_PAIRS } from './weekend';

export interface NewsItem {
  title: string;
  description: string;
  pubDate: string;
  source: string;       // ソース名（'NHK', 'WSJ_Markets' 等）
  freshnessMin: number; // 鮮度（取得時刻 - pubDate, 分）
  url?: string;         // 記事URL（RSSの<link>タグから取得）
  title_ja?: string;    // 日本語タイトル（filterAndTranslateWithHaiku()で付与）
  desc_ja?: string;     // 日本語概要（filterAndTranslateWithHaiku()で付与）
}

export interface SourceFetchStat {
  source: string;
  url: string;
  ok: boolean;
  latencyMs: number;
  itemCount: number;
  avgFreshnessMin: number | null;
  error?: string; // Fix-B: エラー詳細（ok=false時のみ）
}

export interface FetchNewsResult {
  items: NewsItem[];
  stats: SourceFetchStat[];
}

/** ソースタイプ: rss は既存の XML 解析、それ以外は JSON API */
type SourceType = 'rss' | 'polygon' | 'finnhub' | 'marketaux' | 'cryptopanic';

interface SourceDef {
  name: string;
  url: string;
  /** ソースタイプ（省略時 = 'rss'）*/
  type?: SourceType;
  /** ON/OFFスイッチ（false で完全スキップ。精度・速報性を見ながら調整）*/
  enabled: boolean;
  /** 対象ペア（省略時 = 全ペア共通）。指定した場合はそのペアのAI分析時のみ使用 */
  pairs?: string[];
}

/** fetchNews() に渡す JSON API キー */
export interface NewsApiKeys {
  polygon?: string;
  finnhub?: string;
  marketaux?: string;
  cryptopanic?: string;
}

// 暗号資産ペア一覧: weekend.ts の CRYPTO_PAIRS を使用（Single Source of Truth）

// ─────────────────────────────────────────────────────────────────────────────
// ニュースソース設定
// enabled: true/false で ON/OFF（変更後 wrangler deploy するだけで反映）
// ─────────────────────────────────────────────────────────────────────────────
const SOURCES: SourceDef[] = [
  // ═══ RSS（全ペア共通）═══════════════════════════════════════════════════════
  { name: 'CNBC',             type: 'rss', enabled: true,  url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  { name: 'CoinDesk',         type: 'rss', enabled: true,  url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'FXStreet',         type: 'rss', enabled: true,  url: 'https://www.fxstreet.com/rss' },
  { name: 'Bloomberg',        type: 'rss', enabled: true,  url: 'https://feeds.bloomberg.com/markets/news.rss' },
  // 日本語速報（wor.jp 経由、超低レイテンシ）
  { name: 'Reuters_Markets',  type: 'rss', enabled: true,  url: 'https://assets.wor.jp/rss/rdf/reuters/markets.rdf' },
  { name: 'Reuters_World',    type: 'rss', enabled: true,  url: 'https://assets.wor.jp/rss/rdf/reuters/world.rdf' },
  { name: 'Nikkei',           type: 'rss', enabled: true,  url: 'https://assets.wor.jp/rss/rdf/nikkei/news.rdf' },
  { name: 'Minkabu_FX',       type: 'rss', enabled: true,  url: 'https://assets.wor.jp/rss/rdf/minkabufx/statement.rdf' },
  { name: 'Minkabu_Stock',    type: 'rss', enabled: true,  url: 'https://assets.wor.jp/rss/rdf/minkabufx/stock.rdf' },
  { name: 'Minkabu_Commodity',type: 'rss', enabled: true,  url: 'https://assets.wor.jp/rss/rdf/minkabufx/commodity.rdf' },
  // 暗号資産専用 RSS（BTC/ETH/SOL のみ）
  { name: 'Bitcoinist',       type: 'rss', enabled: true,  url: 'https://bitcoinist.com/feed/', pairs: CRYPTO_PAIRS },

  // ═══ JSON API（S/A Tier 新規追加）══════════════════════════════════════════
  // Polygon.io News（センチメント付き・FX/株/暗号資産網羅）— 要 POLYGON_API_KEY
  { name: 'Polygon',          type: 'polygon',    enabled: true,  url: 'https://api.polygon.io/v2/reference/news?limit=10' },
  // Finnhub FX News（FX専用カテゴリ・高レート枠）— 要 FINNHUB_API_KEY（calendar.tsと共有可）
  { name: 'Finnhub_FX',       type: 'finnhub',    enabled: true,  url: 'https://finnhub.io/api/v1/news?category=forex' },
  // Finnhub 一般ニュース（マクロ経済・中央銀行）
  { name: 'Finnhub_General',  type: 'finnhub',    enabled: true,  url: 'https://finnhub.io/api/v1/news?category=general' },
  // MarketAux（sentiment_score -1〜+1 付き・金融ニュース特化）— 要 MARKETAUX_API_KEY
  { name: 'MarketAux',        type: 'marketaux',  enabled: true,  url: 'https://api.marketaux.com/v1/news/all?language=en&filter_entities=true&limit=10' },
  // CryptoPanic（bullish/bearish 投票スコア付き・暗号資産専用）— 無料版終了のため無効化（2026-03-23）
  { name: 'CryptoPanic',      type: 'cryptopanic',enabled: false, url: 'https://cryptopanic.com/api/free/v1/posts/?currencies=BTC,ETH,SOL', pairs: CRYPTO_PAIRS },
];

/**
 * 特定ペアのAI分析用にニュースをフィルタリング
 * - pairs タグなし（全ペア共通）ソースの記事は常に含む
 * - pairs タグあり（ペア専用）ソースの記事は対象ペアのみ含む
 * @param items fetchNews() の結果
 * @param pair 対象ペア（例: 'BTC/USD'）
 */
export function getNewsForPair(items: NewsItem[], pair: string): NewsItem[] {
  // ソース名 → pairs マッピングを構築
  const pairSources = new Map<string, string[] | undefined>(
    SOURCES.map(s => [s.name, s.pairs])
  );
  return items.filter(item => {
    const sourcePairs = pairSources.get(item.source);
    // pairs 未定義 = 全ペア共通 → 含む
    if (!sourcePairs) return true;
    // pairs 定義あり → 対象ペアに含まれる場合のみ含む
    return sourcePairs.includes(pair);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON API フェッチ関数（ソースタイプ別）
// ─────────────────────────────────────────────────────────────────────────────

/** Polygon.io News API — sentimentタグをdescに埋め込んでHaiku翻訳時にも活用 */
async function fetchPolygon(src: SourceDef, apiKey: string | undefined, now: Date): Promise<NewsItem[]> {
  if (!apiKey) return [];
  try {
    const url = `${src.url}&apiKey=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json() as {
      results?: Array<{
        title: string;
        description?: string;
        published_utc: string;
        publisher?: { name: string };
        article_url: string;
        insights?: Array<{ sentiment: string; sentiment_reasoning?: string }>;
      }>;
    };
    return (data.results ?? []).slice(0, 8).map(item => {
      const sentiment = item.insights?.[0]?.sentiment;
      const reasoning = item.insights?.[0]?.sentiment_reasoning;
      const sentTag = sentiment ? ` [${sentiment.toUpperCase()}${reasoning ? ': ' + reasoning.slice(0, 60) : ''}]` : '';
      return {
        title: item.title,
        description: (item.description ?? '') + sentTag,
        pubDate: item.published_utc,
        source: src.name,
        freshnessMin: calcFreshnessMin(item.published_utc, now),
        url: item.article_url,
      };
    });
  } catch { return []; }
}

/** Finnhub News API（forex / general カテゴリ） */
async function fetchFinnhub(src: SourceDef, apiKey: string | undefined, now: Date): Promise<NewsItem[]> {
  if (!apiKey) return [];
  try {
    const url = `${src.url}&token=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json() as Array<{
      headline: string;
      summary?: string;
      datetime: number;
      source?: string;
      url?: string;
    }>;
    if (!Array.isArray(data)) return [];
    return data.slice(0, 8).map(item => {
      const pubDate = new Date(item.datetime * 1000).toISOString();
      return {
        title: item.headline,
        description: item.summary ?? '',
        pubDate,
        source: src.name,
        freshnessMin: calcFreshnessMin(pubDate, now),
        url: item.url,
      };
    });
  } catch { return []; }
}

/** MarketAux News API — sentiment_score を descに埋め込む */
async function fetchMarketAux(src: SourceDef, apiKey: string | undefined, now: Date): Promise<NewsItem[]> {
  if (!apiKey) return [];
  try {
    const url = `${src.url}&api_token=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json() as {
      data?: Array<{
        title: string;
        description?: string;
        published_at: string;
        url?: string;
        entities?: Array<{ sentiment_score?: number }>;
      }>;
    };
    return (data.data ?? []).slice(0, 8).map(item => {
      const scores = (item.entities ?? []).map(e => e.sentiment_score).filter((s): s is number => s != null);
      const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      const sentTag = avg != null ? ` [sentiment: ${avg >= 0.05 ? 'BULLISH' : avg <= -0.05 ? 'BEARISH' : 'NEUTRAL'}(${avg.toFixed(2)})]` : '';
      return {
        title: item.title,
        description: (item.description ?? '') + sentTag,
        pubDate: item.published_at,
        source: src.name,
        freshnessMin: calcFreshnessMin(item.published_at, now),
        url: item.url,
      };
    });
  } catch { return []; }
}

/** CryptoPanic API — bullish/bearish 投票スコアをタイトルに付与 */
async function fetchCryptoPanic(src: SourceDef, apiKey: string | undefined, now: Date): Promise<NewsItem[]> {
  if (!apiKey) return [];
  try {
    const url = `${src.url}&auth_token=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json() as {
      results?: Array<{
        title: string;
        published_at: string;
        url?: string;
        votes?: { positive?: number; negative?: number };
      }>;
    };
    return (data.results ?? []).slice(0, 8).map(item => {
      const pos = item.votes?.positive ?? 0;
      const neg = item.votes?.negative ?? 0;
      const voteTag = (pos + neg) > 0 ? ` [👍${pos} 👎${neg}]` : '';
      return {
        title: item.title + voteTag,
        description: '',
        pubDate: item.published_at,
        source: src.name,
        freshnessMin: calcFreshnessMin(item.published_at, now),
        url: item.url,
      };
    });
  } catch { return []; }
}

/** RSS ソースを1件フェッチしてパース（既存ロジックを関数化） */
async function fetchRssSource(src: SourceDef, now: Date): Promise<NewsItem[]> {
  const res = await fetch(src.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; FXNewsBot/1.0)',
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
    cf: { cacheTtl: 60 },
    signal: AbortSignal.timeout(6000),
  } as RequestInit);
  if (!res.ok) return [];
  const xml = await res.text();
  return parseItems(xml, src.name, now, 5);
}

function extractCdata(tag: string, xml: string): string {
  const cdataRe = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
    'i'
  );
  const plainRe = new RegExp(
    `<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    'i'
  );
  const m = cdataRe.exec(xml) ?? plainRe.exec(xml);
  return m ? m[1].trim() : '';
}

/** pubDate文字列から鮮度（分）を計算。パース失敗時は -1 */
function calcFreshnessMin(pubDate: string, now: Date): number {
  if (!pubDate) return -1;
  const pub = new Date(pubDate);
  if (isNaN(pub.getTime())) return -1;
  return Math.max(0, Math.round((now.getTime() - pub.getTime()) / 60_000));
}

function parseItems(xml: string, sourceName: string, now: Date, limit = 8): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const title = extractCdata('title', block);
    if (!title) continue;

    const pubDate = extractCdata('pubDate', block)
      || extractCdata('dc:date', block);  // RDF 1.0 用

    // <link> タグ取得（CDATA非対応のソース多いため平文パースも試みる）
    const linkRe = /<link[^>]*>([^<]+)<\/link>/i;
    const linkAlt = /<link[^>]+href=["']([^"']+)["']/i;
    const linkMatch = linkRe.exec(block) ?? linkAlt.exec(block);
    const url = linkMatch ? linkMatch[1].trim() : undefined;

    items.push({
      title,
      description: extractCdata('description', block),
      pubDate,
      source: sourceName,
      freshnessMin: calcFreshnessMin(pubDate, now),
      url,
    });
    if (items.length >= limit) break;
  }
  return items;
}

export async function fetchNews(apiKeys?: NewsApiKeys): Promise<FetchNewsResult> {
  const now = new Date();
  const stats: SourceFetchStat[] = [];
  const keys = apiKeys ?? {};

  // disabled ソースは最初からスキップ（CPU時間ゼロ）
  const enabledSources = SOURCES.filter(s => s.enabled);

  const results = await Promise.allSettled(
    enabledSources.map(async (src) => {
      const start = Date.now();
      try {
        let items: NewsItem[];
        const type = src.type ?? 'rss';

        if (type === 'rss') {
          items = await fetchRssSource(src, now);
        } else if (type === 'polygon') {
          items = await fetchPolygon(src, keys.polygon, now);
        } else if (type === 'finnhub') {
          items = await fetchFinnhub(src, keys.finnhub, now);
        } else if (type === 'marketaux') {
          items = await fetchMarketAux(src, keys.marketaux, now);
        } else if (type === 'cryptopanic') {
          items = await fetchCryptoPanic(src, keys.cryptopanic, now);
        } else {
          items = [];
        }

        const latencyMs = Date.now() - start;
        const freshValues = items.map(i => i.freshnessMin).filter(f => f >= 0);
        const avgFresh = freshValues.length > 0
          ? Math.round(freshValues.reduce((a, b) => a + b, 0) / freshValues.length)
          : null;

        stats.push({
          source: src.name, url: src.url, ok: true,
          latencyMs, itemCount: items.length, avgFreshnessMin: avgFresh,
        });
        return items;
      } catch (err) {
        stats.push({
          source: src.name, url: src.url, ok: false,
          latencyMs: Date.now() - start, itemCount: 0, avgFreshnessMin: null,
          error: String(err).slice(0, 120),
        });
        return [];
      }
    })
  );

  // 重複除去してマージ → 鮮度順ソート → 30件にカット
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      if (!seen.has(item.title)) {
        seen.add(item.title);
        merged.push(item);
      }
    }
  }
  // 鮮度順（新しい順）にソート。日付パース失敗は末尾へ
  merged.sort((a, b) => {
    if (a.freshnessMin < 0 && b.freshnessMin < 0) return 0;
    if (a.freshnessMin < 0) return 1;
    if (b.freshnessMin < 0) return 1;
    return a.freshnessMin - b.freshnessMin;
  });
  return { items: merged.slice(0, 30), stats };
}

// ---------------------------------------------------------------------------
// Haiku ニュースフィルタ（日経ノイズ除去）
// ---------------------------------------------------------------------------
// Nikkei news.rdf は「速報」フィードのためスポーツ・社会面等のノイズが混入する。
// Anthropic Claude Haiku でタイトル一覧をバッチ分類し、FX/金融に無関係な記事を除外。
// キャッシュ: タイトルハッシュが変わらなければ再分類しない（1分cronでの無駄呼び防止）。

/** タイトル一覧の簡易ハッシュ（キャッシュキー用） */
function hashTitles(titles: string[]): string {
  let h = 0;
  const s = titles.join('|');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return 'news_haiku_' + (h >>> 0).toString(36);
}

/**
 * Haiku で全ソースのニュースをFX/金融関連のみにフィルタリング
 *
 * @param items - fetchNews()の結果（全ソース混合）
 * @param geminiApiKey - Gemini API キー
 * @param db - D1（キャッシュ用）
 * @returns フィルタ済みのNewsItem[]（FX/金融無関係な記事を除去）
 */
export async function filterAllNewsWithHaiku(
  items: NewsItem[],
  geminiApiKey: string | undefined,
  db: D1Database,
): Promise<NewsItem[]> {
  // APIキーがなければフィルタなしで全通過
  if (!geminiApiKey) return items;
  if (items.length === 0) return items;

  const titles = items.map(i => i.title);
  const cacheKey = hashTitles(titles);

  // キャッシュチェック: 同じタイトル群なら前回の判定結果を再利用
  try {
    const cached = await db.prepare(
      "SELECT value FROM market_cache WHERE key = ? AND updated_at > datetime('now', '-30 minutes')"
    ).bind(cacheKey).first<{ value: string }>();

    if (cached) {
      const relevantIndices: number[] = JSON.parse(cached.value);
      const filtered = relevantIndices
        .filter(i => i >= 0 && i < items.length)
        .map(i => items[i]);
      console.log(`[news] Haiku filter: キャッシュヒット (${filtered.length}/${items.length}件通過)`);
      return filtered;
    }
  } catch { /* キャッシュ読み取り失敗は無視して再分類 */ }

  // Gemini Flash API 呼び出し: タイトル一覧をバッチで分類
  try {
    const start = Date.now();
    const prompt = `以下はニュースのタイトル一覧です。各タイトルがFX・為替・金融・経済・株式・債券・商品市場・地政学リスク・金融政策・マクロ経済に関連するか判定してください。

タイトル一覧:
${titles.map((t, i) => `${i}: ${t}`).join('\n')}

関連する記事の番号のみをJSON配列で返してください。関連しないもの（スポーツ、芸能、社会面、天気、事件等）は含めないでください。
例: [0, 2, 4]

JSON配列のみを返し、他の文字は一切含めないでください。`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }], role: 'user' }],
          generationConfig: { temperature: 0, maxOutputTokens: 256 },
          thinkingConfig: { thinkingBudget: 0 },
        }),
      }
    );

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(body read failed)');
      console.log(`[news] Gemini filter API error: ${res.status} (${latencyMs}ms) body=${errBody.slice(0, 200)} — フィルタなしで全通過`);
      return items;
    }

    const data = await res.json() as {
      candidates?: Array<{ content: { parts: Array<{ text: string; thought?: boolean }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    if (data.usageMetadata) {
      void insertTokenUsage(db, 'gemini-2.5-flash', 'NEWS_FILTER',
        data.usageMetadata.promptTokenCount ?? 0, data.usageMetadata.candidatesTokenCount ?? 0);
    }
    const allPartsFilter = data.candidates?.[0]?.content?.parts ?? [];
    const responsePartFilter = allPartsFilter.find(p => !p.thought) ?? allPartsFilter[0];
    const text = responsePartFilter?.text ?? '[]';
    const relevantIndices: number[] = JSON.parse(text);

    // キャッシュ保存
    try {
      await db.prepare(
        "INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      ).bind(cacheKey, JSON.stringify(relevantIndices)).run();
    } catch { /* キャッシュ書き込み失敗は無視 */ }

    const filtered = relevantIndices
      .filter(i => i >= 0 && i < items.length)
      .map(i => items[i]);

    const removed = items.length - filtered.length;
    console.log(`[news] Haiku filter: ${removed}件除外, ${filtered.length}/${items.length}件通過 (${latencyMs}ms)`);

    return filtered;
  } catch (e) {
    console.log(`[news] Haiku filter error: ${e} — フィルタなしで全通過`);
    return items;
  }
}

/** @deprecated filterAllNewsWithHaiku を使用してください */
export const filterNikkeiWithHaiku = filterAllNewsWithHaiku;

// ---------------------------------------------------------------------------
// Haiku フィルタ + タイトル・概要 翻訳 一括処理
// ---------------------------------------------------------------------------
// filterAllNewsWithHaiku() + translateAndCacheNews() を1回のHaiku APIコールに統合。
// - 無関係記事（スポーツ・芸能等）を除去
// - title_ja（日本語タイトル）を付与
// - desc_ja（日本語概要）を付与（descriptionがなければURL先の本文から要約）
// - latest_news キャッシュを title_ja + desc_ja 付きで更新
// キャッシュ: タイトルハッシュが同一なら30分間再利用

/**
 * descriptionが空の記事に対して、URL先の本文を取得する。
 * - 最大MAX_BODY_FETCH件まで並列フェッチ（cron 30秒制限対策）
 * - 1件あたり3秒タイムアウト + エッジキャッシュ5分
 * - HTMLタグ除去後、先頭300文字を返す
 */
const MAX_BODY_FETCH = 5;
const BODY_FETCH_TIMEOUT_MS = 3000;

async function fetchBodyForEmptyDesc(items: NewsItem[]): Promise<Map<number, string>> {
  const bodyMap = new Map<number, string>();
  const targets = items
    .map((item, i) => ({ idx: i, url: item.url, desc: item.description }))
    .filter(t => !t.desc && t.url)
    .slice(0, MAX_BODY_FETCH);

  if (targets.length === 0) return bodyMap;

  const results = await Promise.allSettled(
    targets.map(async (t) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), BODY_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(t.url!, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FXNewsBot/1.0)' },
          cf: { cacheTtl: 300 },
        } as RequestInit);
        if (!res.ok) return { idx: t.idx, body: '' };
        const html = await res.text();
        // <p>タグ内のテキストを優先抽出、なければbody全体からHTMLタグ除去
        const paragraphs = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi);
        let text: string;
        if (paragraphs && paragraphs.length > 0) {
          text = paragraphs.slice(0, 5).join(' ').replace(/<[^>]+>/g, '').trim();
        } else {
          text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                     .replace(/<style[\s\S]*?<\/style>/gi, '')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/\s+/g, ' ')
                     .trim();
        }
        return { idx: t.idx, body: text.slice(0, 300) };
      } finally {
        clearTimeout(timer);
      }
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.body) {
      bodyMap.set(r.value.idx, r.value.body);
    }
  }
  console.log(`[news] URL本文フェッチ: ${targets.length}件中${bodyMap.size}件取得`);
  return bodyMap;
}

/** Haikuによるフィルタ+翻訳の結果レコード */
interface HaikuTranslatedItem {
  index: number;
  accepted?: boolean;       // true=採用, false=不採用（旧形式は undefined）
  title_ja: string;
  desc_ja: string;
  topic?: string;           // 5語以内のトピック要約（セマンティック重複排除用）
  reject_reason?: string;   // 不採用理由（不採用時のみ）
  scores?: {                // AIによる5軸スコア（0〜10）
    r: number;              // relevance  市場有効性
    c: number;              // credibility 信憑性
    s: number;              // sentiment  センチメント強度
    b: number;              // breadth    影響範囲（銘柄数）
    n: number;              // novelty    新規性（既報焼き直しでないか）
  };
}

// ---------------------------------------------------------------------------
// 7軸スコアリング ユーティリティ
// ---------------------------------------------------------------------------

/** timeliness: freshnessMin（取得時点での経過分）から即時性スコアを算出 */
function scoreTimeliness(freshnessMin: number): number {
  if (freshnessMin < 0) return 5;   // パース失敗→中間値
  if (freshnessMin < 10) return 10;
  if (freshnessMin < 30) return 7;
  if (freshnessMin < 60) return 4;
  return 1;
}

/** uniqueness: topicとrecentTopicsの語彙重複度からユニーク性スコアを算出 */
function scoreUniqueness(topic: string | undefined, recentTopics: string[]): number {
  if (!topic || recentTopics.length === 0) return 8; // 比較対象なし→やや高め
  const aWords = new Set(topic.split(/[\s\u3000・、]+/).filter(w => w.length >= 2));
  for (const rt of recentTopics) {
    const bWords = new Set(rt.split(/[\s\u3000・、]+/).filter(w => w.length >= 2));
    const intersection = [...aWords].filter(w => bWords.has(w)).length;
    const union = new Set([...aWords, ...bWords]).size;
    if (union > 0 && intersection / union >= 0.5) return 2; // 重複記事
  }
  return 10; // ユニーク
}

/** 7軸加重合計スコアを計算（0〜10）
 * isStockSpecific=trueの場合、breadth(b)を無効化しrelevance(r)に再配分 */
function computeComposite(
  t: number, u: number, r: number, c: number,
  s: number, b: number, n: number,
  isStockSpecific = false
): number {
  if (isStockSpecific) {
    // 個別株ニュース: breadthは無関係（そのニュースが自銘柄に関係あるかが全て）
    return t * 0.20 + u * 0.15 + r * 0.35 + c * 0.15 + s * 0.10 + n * 0.05;
  }
  return (
    t * 0.20 + u * 0.15 + r * 0.30 + c * 0.15 + s * 0.10 + b * 0.05 + n * 0.05
  );
}

/** ソース名から信憑性スコアを算出 */
function scoreCredibility(source: string): number {
  const s = source.toLowerCase();
  if (/reuters|bloomberg|ap |associated press|fed |ecb |boj |mof/.test(s)) return 10;
  if (/marketaux|yahoo|cnbc|wsj|ft\.com|nikkei|barron/.test(s)) return 7;
  if (/finnhub|polygon|seeking alpha/.test(s)) return 5;
  if (/reddit|twitter|x\.com/.test(s)) return 3;
  return 6; // その他→中間
}

/**
 * Haiku で全ソースをフィルタしつつタイトル・概要を日本語化する
 *
 * @param items - fetchNews()の結果（全ソース混合）
 * @param geminiApiKey - Gemini API キー
 * @param db - D1（キャッシュ用）
 * @returns フィルタ済みの NewsItem[]（title_ja・desc_ja 付き）
 */
export async function filterAndTranslateWithHaiku(
  items: NewsItem[],
  geminiApiKey: string | undefined,
  db: D1Database,
): Promise<NewsItem[]> {
  if (!geminiApiKey || items.length === 0) return items;

  const titles = items.map(i => i.title);
  const cacheKey = hashTitles(titles);

  // キャッシュチェック
  try {
    const cached = await db.prepare(
      "SELECT value FROM market_cache WHERE key = ? AND updated_at > datetime('now', '-30 minutes')"
    ).bind(cacheKey).first<{ value: string }>();

    if (cached) {
      const results: HaikuTranslatedItem[] = JSON.parse(cached.value);

      // キャッシュヒット時も7軸スコアリングを適用する（スコアチェックをスキップしない）
      const COMPOSITE_THRESHOLD_CACHE = 6.5;
      const scoresMapCached = new Map<number, {
        timeliness: number; uniqueness: number;
        relevance: number; credibility: number;
        sentiment: number; breadth: number; novelty: number;
        composite: number;
      }>();
      const rejectMapCached = new Map<number, string>();

      // 過去トピックキャッシュ（ユニーク性スコア算出に使用）
      let recentTopicsCached: string[] = [];
      try {
        const topicCache = await db.prepare(
          "SELECT value FROM market_cache WHERE key = 'recent_topics' AND updated_at > datetime('now', '-2 hours')"
        ).first<{ value: string }>();
        if (topicCache) recentTopicsCached = JSON.parse(topicCache.value);
      } catch { /* キャッシュ読み取り失敗は無視 */ }

      for (const r of results) {
        if (r.index < 0 || r.index >= items.length) continue;
        if (r.accepted === false) {
          rejectMapCached.set(r.index, r.reject_reason ?? '除外（理由不明）');
          continue;
        }
        const item = items[r.index];
        const t = scoreTimeliness(item.freshnessMin);
        const u = scoreUniqueness(r.topic, recentTopicsCached);
        const credBase = scoreCredibility(item.source);
        const ai = r.scores ?? { r: 6, c: credBase, s: 5, b: 5, n: 6 };
        const isStockSpecific = Boolean(item.source?.includes('.T'));
        const composite = computeComposite(t, u, ai.r, ai.c, ai.s, ai.b, ai.n, isStockSpecific);
        const rounded = Math.round(composite * 10) / 10;
        scoresMapCached.set(r.index, {
          timeliness: t, uniqueness: u,
          relevance: ai.r, credibility: ai.c,
          sentiment: ai.s, breadth: ai.b, novelty: ai.n,
          composite: rounded,
        });
        if (composite < COMPOSITE_THRESHOLD_CACHE) {
          rejectMapCached.set(r.index, `スコア不足(${rounded})`);
        }
      }

      const acceptedCached = results.filter(r =>
        r.index >= 0 && r.index < items.length &&
        r.accepted !== false &&
        !rejectMapCached.has(r.index)
      );
      const filteredItems = acceptedCached
        .map(r => ({ ...items[r.index], title_ja: r.title_ja, desc_ja: r.desc_ja }));

      updateHaikuResults(items, acceptedCached, rejectMapCached, scoresMapCached, db).catch(() => {});

      const scoringRejected = [...rejectMapCached.entries()].filter(([, v]) => v.startsWith('スコア不足')).length;
      console.log(`[news] filter+translate: キャッシュヒット(スコアリング適用) ${filteredItems.length}/${items.length}件通過(うちスコア不足${scoringRejected}件)`);

      // ── キャッシュスコアリング機能不全検出 ──
      // 採用5件以上なのにスコア拒否が0件 = スコアチェックが機能していない可能性（PR#45で修正したバグの再発検出）
      if (scoringRejected === 0 && acceptedCached.length >= 5) {
        await insertSystemLog(
          db, 'WARN', 'NEWS_CACHE',
          `キャッシュスコア拒否ゼロ疑惑: ${acceptedCached.length}件全通過（スコアチェック機能確認要）`,
          JSON.stringify({ accepted: acceptedCached.length, total: items.length })
        ).catch(() => {});
      }
      await _updateLatestNewsCache(filteredItems, db);
      return filteredItems;
    }
  } catch { /* キャッシュ読み取り失敗は無視して再処理 */ }

  // descriptionが空の記事はURL先から本文を取得
  const bodyMap = await fetchBodyForEmptyDesc(items);

  // 過去トピックキャッシュ読み込み（セマンティック重複排除用）
  let recentTopics: string[] = [];
  try {
    const topicCache = await db.prepare(
      "SELECT value FROM market_cache WHERE key = 'recent_topics' AND updated_at > datetime('now', '-2 hours')"
    ).first<{ value: string }>();
    if (topicCache) {
      recentTopics = JSON.parse(topicCache.value);
    }
  } catch { /* キャッシュ読み取り失敗は無視 */ }

  // Haiku API 呼び出し: フィルタ + 翻訳 + セマンティック重複排除を1回のバッチで
  try {
    const start = Date.now();

    // 各記事のテキストを構築（description→URL本文→なし の優先順）
    const articleLines = items.map((item, i) => {
      const desc = item.description
        ? item.description.replace(/<[^>]+>/g, '').slice(0, 150)
        : bodyMap.get(i)?.slice(0, 200) || '';
      return desc
        ? `${i}: title=${item.title} | desc=${desc}`
        : `${i}: title=${item.title}`;
    }).join('\n');

    // 過去トピックセクション（あれば追加）
    const recentTopicsSection = recentTopics.length > 0
      ? `\n【配信済みトピック（過去2時間）】\n以下は既に配信済みの記事です。まったく同じ発表・声明・数値を報じている記事のみ重複として除外してください。\n同じテーマでも、異なる発言者・新たな数値・異なる角度・追加の事実が含まれる場合は重複ではありません。\n${recentTopics.map(t => `- ${t}`).join('\n')}\n`
      : '';

    const prompt = `以下のニュース記事一覧を分析してください。

【作業内容】
1. 各記事がFX・為替・金融・経済・株式・債券・商品市場・地政学リスク・金融政策・マクロ経済に関連するか判定する
2. 関連する記事のみ、タイトルと概要を日本語に翻訳する（既に日本語なら原文のまま）
3. 以下に該当する記事は除外する:
   - スポーツ・芸能・社会面・天気・事件・生活情報
   - まとめ記事（"X things to watch", "weekly roundup", "今週の振り返り"等）
   - 過去の事象を振り返る記事（"how X happened", "what went wrong"等の事後分析）
   - コラム・オピニオン・解説記事で、新しい事実を含まないもの
   - まったく同じ発表・声明・数値を別ソースが報じているだけの記事（ただし、同テーマでも異なる発言者・新たな数値・異なる角度・追加の事実が含まれる場合は採用する）
   速報性が高く、今後の相場に影響しうる新しい事実・発表・データのみを通すこと
${recentTopicsSection}
【記事一覧】
${articleLines}

【出力形式】
全記事について、採用/不採用を判定し、以下のJSON配列で返してください。

採用する記事（scoresフィールドに5軸スコアを0〜10で付与）:
  {"index":0,"accepted":true,"title_ja":"日本語タイトル","desc_ja":"日本語概要","topic":"核心10字","scores":{"r":8,"c":9,"s":7,"b":6,"n":8}}

  r=relevance(市場有効性), c=credibility(信憑性), s=sentiment(シグナル強度), b=breadth(影響銘柄数), n=novelty(新規情報度)

除外する記事:
  {"index":1,"accepted":false,"reject_reason":"スポーツ"}

reject_reasonは以下のいずれか: "無関係","まとめ記事","事後分析","オピニオン","重複","その他"

[{"index":0,"accepted":true,"title_ja":"...", ...},{"index":1,"accepted":false,"reject_reason":"無関係"},...]

JSON配列のみを返し、他の文字は一切含めないでください。`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }], role: 'user' }],
          // thinking モード無効化: ニュース分類タスクは連鎖推論不要、かつ
          // thinking=ON だと parts[0] が思考内容になり JSON 取得に失敗する
          generationConfig: { temperature: 0, maxOutputTokens: 4096 },
          thinkingConfig: { thinkingBudget: 0 },
        }),
      }
    );

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(body read failed)');
      console.log(`[news] filter+translate API error: ${res.status} (${latencyMs}ms) body=${errBody.slice(0, 200)} — フィルタなしで全通過`);
      return items;
    }

    const data = await res.json() as {
      candidates?: Array<{ content: { parts: Array<{ text: string; thought?: boolean }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    if (data.usageMetadata) {
      void insertTokenUsage(db, 'gemini-2.5-flash', 'NEWS_TRANSLATE',
        data.usageMetadata.promptTokenCount ?? 0, data.usageMetadata.candidatesTokenCount ?? 0);
    }
    // thinking モデルは parts[0] が思考内容（thought:true）、parts[1] 以降が実際の回答
    // thought フラグのないパートを優先して取得する（thinkingBudget:0 でも念のため）
    const allParts = data.candidates?.[0]?.content?.parts ?? [];
    const responsePart = allParts.find(p => !p.thought) ?? allParts[0];
    const rawText = responsePart?.text ?? '[]';
    // レスポンスに余分なテキストが混入することがあるためJSON配列部分だけ抽出
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    const results: HaikuTranslatedItem[] = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    // キャッシュ保存
    try {
      await db.prepare(
        "INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      ).bind(cacheKey, JSON.stringify(results)).run();
    } catch { /* キャッシュ書き込み失敗は無視 */ }

    // ── 7軸スコアリング ──────────────────────────────────────────
    // AIが「accepted=false」と判定した記事は無条件除外（理由保持）
    // AIが「accepted=true」の記事にさらに複合スコアでフィルタを掛ける
    const COMPOSITE_THRESHOLD = 6.5;  // 旧6.0→6.5: 採用率15-20%目標（目標採用率=15〜20%）
    const scoresMap = new Map<number, {
      timeliness: number; uniqueness: number;
      relevance: number; credibility: number;
      sentiment: number; breadth: number; novelty: number;
      composite: number;
    }>();
    const rejectMap = new Map<number, string>();

    for (const r of results) {
      if (r.index < 0 || r.index >= items.length) continue;

      // Haikuが明示的に除外 → そのまま不採用
      if (r.accepted === false) {
        rejectMap.set(r.index, r.reject_reason ?? '除外（理由不明）');
        continue;
      }

      // コード側スコア
      const item = items[r.index];
      const t = scoreTimeliness(item.freshnessMin);
      const u = scoreUniqueness(r.topic, recentTopics);
      const credBase = scoreCredibility(item.source);

      // AI側スコア（なければデフォルト値）
      const ai = r.scores ?? { r: 6, c: credBase, s: 5, b: 5, n: 6 };

      const isStockSpecific = Boolean(item.source?.includes('.T'));
      const composite = computeComposite(t, u, ai.r, ai.c, ai.s, ai.b, ai.n, isStockSpecific);
      const rounded = Math.round(composite * 10) / 10;

      scoresMap.set(r.index, {
        timeliness: t, uniqueness: u,
        relevance: ai.r, credibility: ai.c,
        sentiment: ai.s, breadth: ai.b, novelty: ai.n,
        composite: rounded,
      });

      if (composite < COMPOSITE_THRESHOLD) {
        rejectMap.set(r.index, `スコア不足(${rounded})`);
      }
    }
    // ────────────────────────────────────────────────────────────

    // composite 閾値を通過した記事のみ採用
    const acceptedResults = results.filter(r =>
      r.index >= 0 && r.index < items.length &&
      r.accepted !== false &&
      !rejectMap.has(r.index)
    );
    const filteredItems = acceptedResults
      .map(r => ({ ...items[r.index], title_ja: r.title_ja, desc_ja: r.desc_ja }));

    // news_raw に結果反映（採用/不採用フラグ＋スコア）
    // 非同期で更新（メインフローをブロックしない）
    updateHaikuResults(items, acceptedResults, rejectMap, scoresMap, db).catch(e =>
      console.warn(`[news_raw] updateHaikuResults error: ${String(e).slice(0, 100)}`)
    );

    // 過去トピックキャッシュ更新: 採用済みトピックのみ追加、最大50件に制限
    const newTopics = acceptedResults
      .map(r => r.topic)
      .filter((t): t is string => !!t);
    if (newTopics.length > 0) {
      const mergedTopics = [...new Set([...newTopics, ...recentTopics])].slice(0, 50);
      try {
        await db.prepare(
          "INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))"
        ).bind('recent_topics', JSON.stringify(mergedTopics)).run();
      } catch { /* キャッシュ書き込み失敗は無視 */ }
      console.log(`[news] recent_topics更新: ${newTopics.length}件追加, 合計${mergedTopics.length}件`);
    }

    const scoringRejected = [...rejectMap.entries()].filter(([, v]) => v.startsWith('スコア不足')).length;
    const removed = items.length - filteredItems.length;
    console.log(`[news] filter+translate: ${removed}件除外(うちスコア不足${scoringRejected}件), ${filteredItems.length}/${items.length}件通過, title_ja+desc_ja付与 (${latencyMs}ms) [過去トピック${recentTopics.length}件参照]`);

    await _updateLatestNewsCache(filteredItems, db);
    return filteredItems;
  } catch (e) {
    console.log(`[news] filter+translate error: ${e} — フィルタなしで全通過`);
    return items;
  }
}

/** latest_news キャッシュを title_ja・desc_ja 付きで更新 */
async function _updateLatestNewsCache(items: NewsItem[], db: D1Database): Promise<void> {
  try {
    await db.prepare(
      "INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind('latest_news', JSON.stringify(items.slice(0, 30))).run();
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Haiku 英語→日本語タイトル翻訳（Path B B1 後処理）
// ---------------------------------------------------------------------------
// B1（Gemini/GPT/Claude）はニュース分析に専念し、翻訳は Haiku に委任。
// 英語タイトルのみバッチ翻訳し、日本語タイトルはそのまま通す。

/** 英語文字列か判定（ASCII文字が全体の50%超） */
function isEnglishTitle(title: string): boolean {
  if (!title) return false;
  const ascii = title.replace(/[^\x20-\x7E]/g, '').length;
  return ascii / title.length > 0.5;
}

/**
 * Path B の news_analysis に title_ja を付与する（Haiku バッチ翻訳）
 *
 * @param newsAnalysis - B1の出力 news_analysis 配列
 * @param originalTitles - 元のニュースタイトル配列（indexでマッピング）
 * @param anthropicApiKey - Anthropic API キー
 * @returns title_ja が付与された news_analysis（元の配列を変更）
 */
export async function translateTitlesWithHaiku(
  newsAnalysis: Array<{ index: number; title_ja?: string; [key: string]: unknown }>,
  originalTitles: string[],
  anthropicApiKey: string | undefined,
): Promise<void> {
  if (!anthropicApiKey || newsAnalysis.length === 0) return;

  // 英語タイトルのみ抽出（翻訳対象）
  const toTranslate: Array<{ analysisIdx: number; titleIdx: number; title: string }> = [];
  for (let i = 0; i < newsAnalysis.length; i++) {
    const item = newsAnalysis[i];
    const origTitle = originalTitles[item.index] ?? '';
    if (isEnglishTitle(origTitle)) {
      toTranslate.push({ analysisIdx: i, titleIdx: item.index, title: origTitle });
    } else {
      // 日本語タイトルはそのまま設定
      item.title_ja = origTitle || null as unknown as string;
    }
  }

  if (toTranslate.length === 0) return;

  try {
    const start = Date.now();
    const prompt = `以下の英語ニュースタイトルを簡潔な日本語に翻訳してください。

${toTranslate.map((t, i) => `${i}: ${t.title}`).join('\n')}

JSON配列で返してください。各要素は翻訳後の日本語タイトル文字列です。
例: ["日銀が金利据え置き", "米国CPIが予想を上回る"]

JSON配列のみを返し、他の文字は一切含めないでください。`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      console.log(`[news] Haiku translate error: ${res.status} (${latencyMs}ms) — 英語タイトルのまま`);
      // フォールバック: 英語タイトルをそのまま title_ja に
      for (const t of toTranslate) {
        newsAnalysis[t.analysisIdx].title_ja = t.title;
      }
      return;
    }

    const data = await res.json() as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.[0]?.text ?? '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const translations: string[] = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    for (let i = 0; i < toTranslate.length; i++) {
      const translated = translations[i];
      newsAnalysis[toTranslate[i].analysisIdx].title_ja =
        translated || toTranslate[i].title; // 翻訳失敗時は元タイトル
    }

    console.log(`[news] Haiku translate: ${toTranslate.length}件翻訳完了 (${latencyMs}ms)`);
  } catch (e) {
    console.log(`[news] Haiku translate error: ${e} — 英語タイトルのまま`);
    // フォールバック
    for (const t of toTranslate) {
      newsAnalysis[t.analysisIdx].title_ja = t.title;
    }
  }
}

// ---------------------------------------------------------------------------
// news_raw ステージングテーブル操作（ETL Extract層）
// ---------------------------------------------------------------------------

/** 記事のハッシュ値を計算（source + title で一意性を担保） */
function hashArticle(source: string, title: string): string {
  let h = 0;
  const s = `${source}||${title}`;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Haiku フィルタ前の全記事を news_raw テーブルに保存する
 * 既に同じ hash が存在する場合は INSERT OR IGNORE で重複排除
 *
 * @returns 新規挿入された件数
 */
export async function saveRawNews(
  items: NewsItem[],
  db: D1Database,
): Promise<number> {
  if (items.length === 0) return 0;
  const now = new Date().toISOString();
  let inserted = 0;

  // D1 は batch で最大100ステートメント
  const batchSize = 50;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const stmts = batch.map(item =>
      db.prepare(
        `INSERT OR IGNORE INTO news_raw (hash, source, title, description, pub_date, url, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        hashArticle(item.source, item.title),
        item.source,
        item.title,
        item.description?.slice(0, 500) || null,
        item.pubDate || null,
        item.url || null,
        now,
      )
    );
    try {
      const results = await db.batch(stmts);
      inserted += results.filter(r => ((r.meta as { changes?: number }).changes ?? 0) > 0).length;
    } catch (e) {
      console.warn(`[news_raw] batch insert error: ${String(e).slice(0, 100)}`);
    }
  }

  if (inserted > 0) {
    console.log(`[news_raw] ${inserted}/${items.length}件を新規保存`);
  }
  return inserted;
}

/**
 * Haiku フィルタ結果で news_raw の採用/不採用フラグを更新する
 *
 * @param allItems    - フィルタ前の全記事
 * @param accepted    - 採用した記事（index, title_ja, desc_ja 付き）
 * @param rejectMap   - index → 不採用理由のマップ
 * @param scoresMap   - index → 7軸スコアのマップ
 */
export async function updateHaikuResults(
  allItems: NewsItem[],
  accepted: Array<{ index: number; title_ja: string; desc_ja: string }>,
  rejectMap: Map<number, string>,
  scoresMap: Map<number, {
    timeliness: number; uniqueness: number;
    relevance: number; credibility: number;
    sentiment: number; breadth: number; novelty: number;
    composite: number;
  }>,
  db: D1Database,
): Promise<void> {
  const acceptedSet = new Set(accepted.map(a => a.index));
  const stmts: D1PreparedStatement[] = [];

  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    const hash = hashArticle(item.source, item.title);
    const sc = scoresMap.get(i);
    const scoresJson = sc ? JSON.stringify(sc) : null;

    if (acceptedSet.has(i)) {
      const a = accepted.find(x => x.index === i)!;
      stmts.push(
        db.prepare(
          // haiku_accepted != -1: 一度スコア拒否された記事を後続バッチで採用に上書きしない
          `UPDATE news_raw SET haiku_accepted = 1, title_ja = ?, desc_ja = ?, scores = ?, composite_score = ? WHERE hash = ? AND haiku_accepted != -1`
        ).bind(a.title_ja, a.desc_ja, scoresJson, sc?.composite ?? null, hash)
      );
    } else {
      const reason = rejectMap.get(i) || '除外（理由不明）';
      stmts.push(
        db.prepare(
          // haiku_accepted != 1: 採用済み記事を後続バッチで上書きしない（バグ防止）
          `UPDATE news_raw SET haiku_accepted = -1, reject_reason = ?, scores = ?, composite_score = ? WHERE hash = ? AND haiku_accepted != 1`
        ).bind(reason, scoresJson, sc?.composite ?? null, hash)
      );
    }
  }

  // バッチ実行
  const batchSize = 50;
  for (let i = 0; i < stmts.length; i += batchSize) {
    try {
      await db.batch(stmts.slice(i, i + batchSize));
    } catch (e) {
      console.warn(`[news_raw] update batch error: ${String(e).slice(0, 100)}`);
    }
  }

  const acceptedCount = acceptedSet.size;
  const rejectedCount = allItems.length - acceptedCount;
  console.log(`[news_raw] Haiku結果反映: 採用${acceptedCount}件, 不採用${rejectedCount}件`);

  // ── 採用率サマリーをD1に記録（NEWS_STAT）──
  // console.logだけでは監視困難→SQLで集計・閾値超過を検出できるよう格上げ
  if (acceptedCount + rejectedCount > 0) {
    const rate = Math.round(acceptedCount / (acceptedCount + rejectedCount) * 100);
    const level = rate > 40 ? 'ERROR' : rate > 25 ? 'WARN' : 'INFO';
    await insertSystemLog(
      db, level, 'NEWS_STAT',
      `採用率 ${rate}%: ${acceptedCount}件採用 / ${acceptedCount + rejectedCount}件処理`,
      JSON.stringify({ accepted: acceptedCount, rejected: rejectedCount, rate })
    ).catch(() => {});
  }
}

/**
 * 古い news_raw レコードを削除（TTL パージ）
 * IPA db.md §5.2: レンジパーティション相当の日付ベースTTL
 */
export async function purgeOldNewsRaw(db: D1Database, daysToKeep = 7): Promise<number> {
  try {
    const result = await db.prepare(
      `DELETE FROM news_raw WHERE fetched_at < datetime('now', ? || ' days')`
    ).bind(-daysToKeep).run();
    const deleted = (result.meta as { changes?: number }).changes ?? 0;
    if (deleted > 0) {
      console.log(`[news_raw] TTLパージ: ${deleted}件削除 (${daysToKeep}日以上前)`);
    }
    return deleted;
  } catch (e) {
    console.warn(`[news_raw] purge error: ${String(e).slice(0, 100)}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 独立型ニュース翻訳（fetchMarketData直後、Path B非依存で毎分実行）
// ---------------------------------------------------------------------------
// Path BのB1が走らない間も英語タイトルを翻訳し、latest_newsキャッシュを常に最新に保つ。
// 個別タイトルをハッシュでキャッシュし、API呼び出しを最小化。

/**
 * ニュースタイトルを翻訳して latest_news キャッシュを更新する（Path B非依存）
 *
 * - 英語タイトルのみ翻訳対象
 * - 個別タイトルのキャッシュ（TTL 6時間）で重複API呼び出し防止
 * - 未翻訳が5件以上溜まったらバッチ翻訳
 */
export async function translateAndCacheNews(
  news: NewsItem[],
  anthropicApiKey: string | undefined,
  db: D1Database,
): Promise<void> {
  if (!anthropicApiKey || news.length === 0) {
    console.log(`[news] translate-cache: skip (key=${!!anthropicApiKey}, news=${news.length})`);
    return;
  }

  const titleJaMap = new Map<number, string>();
  const untranslated: Array<{ idx: number; title: string }> = [];

  for (let i = 0; i < Math.min(news.length, 30); i++) {
    const title = news[i].title;
    if (!isEnglishTitle(title)) {
      // 日本語タイトルはそのまま
      titleJaMap.set(i, title);
      continue;
    }

    // 個別キャッシュチェック（ハッシュキー）
    const hash = simpleHash(title);
    const cacheKey = `tl_${hash}`;
    try {
      const row = await db.prepare(
        "SELECT value, updated_at FROM market_cache WHERE key = ?"
      ).bind(cacheKey).first<{ value: string; updated_at: string }>();

      if (row) {
        // TTL 6時間
        const age = Date.now() - new Date(row.updated_at).getTime();
        if (age < 6 * 60 * 60 * 1000) {
          titleJaMap.set(i, row.value);
          continue;
        }
      }
    } catch { /* キャッシュ読み取り失敗は無視 */ }

    untranslated.push({ idx: i, title });
  }

  console.log(`[news] translate-cache: ${untranslated.length}件未翻訳, ${titleJaMap.size}件キャッシュHit (total ${Math.min(news.length, 30)})`);

  // 未翻訳がなければキャッシュ更新のみ
  if (untranslated.length > 0) {
    try {
      const start = Date.now();
      const prompt = `以下の英語ニュースタイトルを簡潔な日本語に翻訳してください。

${untranslated.map((t, i) => `${i}: ${t.title}`).join('\n')}

JSON配列で返してください。各要素は翻訳後の日本語タイトル文字列です。
例: ["日銀が金利据え置き", "米国CPIが予想を上回る"]

JSON配列のみを返し、他の文字は一切含めないでください。`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const latencyMs = Date.now() - start;

      if (!res.ok) {
        console.log(`[news] translate-cache error: ${res.status} (${latencyMs}ms)`);
        // フォールバック: 英語のまま
        for (const t of untranslated) {
          titleJaMap.set(t.idx, t.title);
        }
      } else {
        const data = await res.json() as {
          content: Array<{ type: string; text?: string }>;
        };
        const text = data.content?.[0]?.text ?? '[]';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        const translations: string[] = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

        // 個別キャッシュ保存 + titleJaMap更新
        for (let i = 0; i < untranslated.length; i++) {
          const translated = translations[i] || untranslated[i].title;
          titleJaMap.set(untranslated[i].idx, translated);

          // 個別タイトルキャッシュ保存
          const hash = simpleHash(untranslated[i].title);
          try {
            await db.prepare(
              "INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))"
            ).bind(`tl_${hash}`, translated).run();
          } catch { /* ignore */ }
        }

        console.log(`[news] translate-cache: ${untranslated.length}件翻訳 (${latencyMs}ms)`);
      }
    } catch (e) {
      console.log(`[news] translate-cache error: ${e}`);
      for (const t of untranslated) {
        titleJaMap.set(t.idx, t.title);
      }
    }
  }

  // latest_news キャッシュ更新（title_ja付き）
  const latestNews = news.slice(0, 30).map((n, i) => ({
    ...n,
    title_ja: titleJaMap.get(i) || n.title_ja || undefined,
  }));
  await _updateLatestNewsCache(latestNews, db);
}

/** 簡易ハッシュ（タイトルキャッシュ用） */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ─────────────────────────────────────────────────────────────────────────────
// 保有状態バイアス（composite閾値の動的制御）
// テスタ: 「どうしたら負けないで済むか」— 保有中は些細なニュースも見逃さない
// ─────────────────────────────────────────────────────────────────────────────

export interface HoldingBias {
  thresholdOverrides: Map<string, number>;   // pair → composite閾値
  attentionPairs: string[];                  // 注目優先銘柄
  maxItemsOverrides: Map<string, number>;    // pair → 最大取得件数
}

/**
 * 保有・追跡・候補状態に応じたcomposite閾値バイアスを計算
 * @param openPositionPairs 保有中のpair名リスト
 * @param trackingPairs 追跡リストのpair名リスト
 * @param candidatePairs 候補リストのpair名リスト
 */
export function buildHoldingBias(
  openPositionPairs: string[],
  trackingPairs: string[],
  candidatePairs: string[]
): HoldingBias {
  const thresholdOverrides = new Map<string, number>();
  const maxItemsOverrides = new Map<string, number>();

  for (const pair of openPositionPairs) {
    thresholdOverrides.set(pair, 4.0);  // 緩和
    maxItemsOverrides.set(pair, 10);
  }
  for (const pair of trackingPairs) {
    if (!thresholdOverrides.has(pair)) {
      thresholdOverrides.set(pair, 5.0);  // やや緩
      maxItemsOverrides.set(pair, 7);
    }
  }
  for (const pair of candidatePairs) {
    if (!thresholdOverrides.has(pair)) {
      thresholdOverrides.set(pair, 6.0);  // 通常
      maxItemsOverrides.set(pair, 5);
    }
  }

  return {
    thresholdOverrides,
    attentionPairs: [...openPositionPairs, ...trackingPairs],
    maxItemsOverrides,
  };
}

/**
 * ニュースアイテムに対する実効的なcomposite閾値を返す
 * デフォルト6.5、保有中なら緩和
 */
export function getEffectiveThreshold(
  news: { source?: string; pair?: string },
  bias: HoldingBias | null,
  defaultThreshold = 6.5
): number {
  if (!bias) return defaultThreshold;
  // pairフィールドがあればそれで検索
  if (news.pair && bias.thresholdOverrides.has(news.pair)) {
    return bias.thresholdOverrides.get(news.pair)!;
  }
  return defaultThreshold;
}

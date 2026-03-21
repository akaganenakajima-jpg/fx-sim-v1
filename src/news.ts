// 日本語・英語ニュースを複数ソースから取得
// ソース別の計測データ（レイテンシ・鮮度）も返す

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
}

export interface FetchNewsResult {
  items: NewsItem[];
  stats: SourceFetchStat[];
}

interface SourceDef {
  name: string;
  url: string;
}

const SOURCES: SourceDef[] = [
  // === 英語速報（description付き、直接使用）===
  { name: 'CNBC',      url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  { name: 'CoinDesk',  url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'FXStreet',  url: 'https://www.fxstreet.com/rss' },
  { name: 'Bloomberg', url: 'https://feeds.bloomberg.com/markets/news.rss' },
  // === 日本語速報（wor.jp経由、超低レイテンシ）===
  { name: 'Reuters_Markets',    url: 'https://assets.wor.jp/rss/rdf/reuters/markets.rdf' },
  { name: 'Reuters_World',      url: 'https://assets.wor.jp/rss/rdf/reuters/world.rdf' },
  { name: 'Nikkei',             url: 'https://assets.wor.jp/rss/rdf/nikkei/news.rdf' },
  { name: 'Minkabu_FX',         url: 'https://assets.wor.jp/rss/rdf/minkabufx/statement.rdf' },
  { name: 'Minkabu_Stock',      url: 'https://assets.wor.jp/rss/rdf/minkabufx/stock.rdf' },
  { name: 'Minkabu_Commodity',  url: 'https://assets.wor.jp/rss/rdf/minkabufx/commodity.rdf' },
  // 削除: NHK(経済少ない), Investing(9h停止多発), 2NN_Biz(7日前混在), Reuters_JP/top.rdf(Markets+Worldに分割)
];

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

export async function fetchNews(): Promise<FetchNewsResult> {
  const now = new Date();
  const stats: SourceFetchStat[] = [];

  const results = await Promise.allSettled(
    SOURCES.map(async (src) => {
      const start = Date.now();
      try {
        const res = await fetch(src.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; FXNewsBot/1.0)',
            Accept: 'application/rss+xml, application/xml, text/xml',
          },
          cf: { cacheTtl: 60 },
        } as RequestInit);
        const latencyMs = Date.now() - start;

        if (!res.ok) {
          stats.push({
            source: src.name, url: src.url, ok: false,
            latencyMs, itemCount: 0, avgFreshnessMin: null,
          });
          return [];
        }

        const xml = await res.text();
        const items = parseItems(xml, src.name, now, 5);
        const freshValues = items.map(i => i.freshnessMin).filter(f => f >= 0);
        const avgFresh = freshValues.length > 0
          ? Math.round(freshValues.reduce((a, b) => a + b, 0) / freshValues.length)
          : null;

        stats.push({
          source: src.name, url: src.url, ok: true,
          latencyMs, itemCount: items.length, avgFreshnessMin: avgFresh,
        });
        return items;
      } catch {
        stats.push({
          source: src.name, url: src.url, ok: false,
          latencyMs: Date.now() - start, itemCount: 0, avgFreshnessMin: null,
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
 * @param anthropicApiKey - Anthropic API キー
 * @param db - D1（キャッシュ用）
 * @returns フィルタ済みのNewsItem[]（FX/金融無関係な記事を除去）
 */
export async function filterAllNewsWithHaiku(
  items: NewsItem[],
  anthropicApiKey: string | undefined,
  db: D1Database,
): Promise<NewsItem[]> {
  // APIキーがなければフィルタなしで全通過
  if (!anthropicApiKey) return items;
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

  // Haiku API 呼び出し: タイトル一覧をバッチで分類
  try {
    const start = Date.now();
    const prompt = `以下はニュースのタイトル一覧です。各タイトルがFX・為替・金融・経済・株式・債券・商品市場・地政学リスク・金融政策・マクロ経済に関連するか判定してください。

タイトル一覧:
${titles.map((t, i) => `${i}: ${t}`).join('\n')}

関連する記事の番号のみをJSON配列で返してください。関連しないもの（スポーツ、芸能、社会面、天気、事件等）は含めないでください。
例: [0, 2, 4]

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
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(body read failed)');
      console.log(`[news] Haiku API error: ${res.status} (${latencyMs}ms) body=${errBody.slice(0, 200)} — フィルタなしで全通過`);
      return items;
    }

    const data = await res.json() as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.[0]?.text ?? '[]';
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
  title_ja: string;
  desc_ja: string;
}

/**
 * Haiku で全ソースをフィルタしつつタイトル・概要を日本語化する
 *
 * @param items - fetchNews()の結果（全ソース混合）
 * @param anthropicApiKey - Anthropic API キー
 * @param db - D1（キャッシュ用）
 * @returns フィルタ済みの NewsItem[]（title_ja・desc_ja 付き）
 */
export async function filterAndTranslateWithHaiku(
  items: NewsItem[],
  anthropicApiKey: string | undefined,
  db: D1Database,
): Promise<NewsItem[]> {
  if (!anthropicApiKey || items.length === 0) return items;

  const titles = items.map(i => i.title);
  const cacheKey = hashTitles(titles);

  // キャッシュチェック
  try {
    const cached = await db.prepare(
      "SELECT value FROM market_cache WHERE key = ? AND updated_at > datetime('now', '-30 minutes')"
    ).bind(cacheKey).first<{ value: string }>();

    if (cached) {
      const results: HaikuTranslatedItem[] = JSON.parse(cached.value);
      const filteredItems = results
        .filter(r => r.index >= 0 && r.index < items.length)
        .map(r => ({ ...items[r.index], title_ja: r.title_ja, desc_ja: r.desc_ja }));
      console.log(`[news] filter+translate: キャッシュヒット (${filteredItems.length}/${items.length}件通過)`);
      await _updateLatestNewsCache(filteredItems, db);
      return filteredItems;
    }
  } catch { /* キャッシュ読み取り失敗は無視して再処理 */ }

  // descriptionが空の記事はURL先から本文を取得
  const bodyMap = await fetchBodyForEmptyDesc(items);

  // Haiku API 呼び出し: フィルタ + 翻訳を1回のバッチで
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

    const prompt = `以下のニュース記事一覧を分析してください。

【作業内容】
1. 各記事がFX・為替・金融・経済・株式・債券・商品市場・地政学リスク・金融政策・マクロ経済に関連するか判定する
2. 関連する記事のみ、タイトルと概要を日本語に翻訳する（既に日本語なら原文のまま）
3. 無関係な記事（スポーツ・芸能・社会面・天気・事件・生活情報等）は出力に含めない

【記事一覧】
${articleLines}

【出力形式】
関連する記事のみを以下のJSON配列で返してください。
- title_ja: 日本語タイトル（30字以内に要約）
- desc_ja: 日本語概要（descがあれば翻訳・要約、なければ60字以内で要約）

[{"index":0,"title_ja":"日本語タイトル","desc_ja":"日本語概要"},...]

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
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(body read failed)');
      console.log(`[news] filter+translate API error: ${res.status} (${latencyMs}ms) body=${errBody.slice(0, 200)} — フィルタなしで全通過`);
      return items;
    }

    const data = await res.json() as { content: Array<{ type: string; text?: string }> };
    const rawText = data.content?.[0]?.text ?? '[]';
    // レスポンスに余分なテキストが混入することがあるためJSON配列部分だけ抽出
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    const results: HaikuTranslatedItem[] = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    // キャッシュ保存
    try {
      await db.prepare(
        "INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      ).bind(cacheKey, JSON.stringify(results)).run();
    } catch { /* キャッシュ書き込み失敗は無視 */ }

    const filteredItems = results
      .filter(r => r.index >= 0 && r.index < items.length)
      .map(r => ({ ...items[r.index], title_ja: r.title_ja, desc_ja: r.desc_ja }));

    const removed = items.length - filteredItems.length;
    console.log(`[news] filter+translate: ${removed}件除外, ${filteredItems.length}/${items.length}件通過, title_ja+desc_ja付与 (${latencyMs}ms)`);

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

// 日本語・英語ニュースを複数ソースから取得
// ソース別の計測データ（レイテンシ・鮮度）も返す

export interface NewsItem {
  title: string;
  description: string;
  pubDate: string;
  source: string;       // ソース名（'NHK', 'WSJ_Markets' 等）
  freshnessMin: number; // 鮮度（取得時刻 - pubDate, 分）
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
  // === 日本語ソース ===
  { name: 'NHK', url: 'https://www3.nhk.or.jp/rss/news/cat6.xml' },
  { name: 'Investing', url: 'https://jp.investing.com/rss/news.rss' },
  { name: 'Reuters_JP', url: 'https://assets.wor.jp/rss/rdf/reuters/top.rdf' },
  { name: '2NN_Biz', url: 'https://www.2nn.jp/rss/bizplus.rdf' },
  { name: 'GNews_FX', url: 'https://news.google.com/rss/search?q=%E7%82%BA%E6%9B%BF+%E3%83%89%E3%83%AB%E5%86%86+%E6%97%A5%E9%8A%80&hl=ja&gl=JP&ceid=JP%3Aja' },
  { name: 'GNews_Nikkei', url: 'https://news.google.com/rss/search?q=%E6%97%A5%E7%B5%8C%E5%B9%B3%E5%9D%87+%E6%A0%AA%E4%BE%A1+%E6%9D%B1%E8%A8%BC&hl=ja&gl=JP&ceid=JP%3Aja' },

  // === 英語ソース（グローバル市場） ===
  { name: 'GNews_Fed', url: 'https://news.google.com/rss/search?q=Federal+Reserve+interest+rates+Treasury+bond+yield&hl=en&gl=US&ceid=US%3Aen' },
  { name: 'GNews_Stocks', url: 'https://news.google.com/rss/search?q=S%26P500+NASDAQ+stock+market+Wall+Street&hl=en&gl=US&ceid=US%3Aen' },
  { name: 'GNews_Metals', url: 'https://news.google.com/rss/search?q=gold+silver+copper+price+metals+market&hl=en&gl=US&ceid=US%3Aen' },
  { name: 'GNews_Oil', url: 'https://news.google.com/rss/search?q=crude+oil+natural+gas+OPEC+energy+price&hl=en&gl=US&ceid=US%3Aen' },
  { name: 'GNews_Crypto', url: 'https://news.google.com/rss/search?q=bitcoin+ethereum+solana+crypto+market&hl=en&gl=US&ceid=US%3Aen' },
  { name: 'GNews_Geo', url: 'https://news.google.com/rss/search?q=geopolitics+Iran+trade+war+sanctions&hl=en&gl=US&ceid=US%3Aen' },
  { name: 'GNews_EU', url: 'https://news.google.com/rss/search?q=ECB+euro+DAX+European+markets&hl=en&gl=US&ceid=US%3Aen' },
  { name: 'GNews_GBP', url: 'https://news.google.com/rss/search?q=Bank+of+England+GBP+pound+UK+economy&hl=en&gl=US&ceid=US%3Aen' },
  { name: 'GNews_AUD', url: 'https://news.google.com/rss/search?q=Reserve+Bank+Australia+AUD+Australian+dollar&hl=en&gl=US&ceid=US%3Aen' },

  // === WSJ（米国金融専門） ===
  { name: 'WSJ_Markets', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml' },
  { name: 'WSJ_Biz', url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml' },
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
    items.push({
      title,
      description: extractCdata('description', block),
      pubDate,
      source: sourceName,
      freshnessMin: calcFreshnessMin(pubDate, now),
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

  // 重複除去してマージ（初出ソースが記録される）
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      if (!seen.has(item.title)) {
        seen.add(item.title);
        merged.push(item);
        if (merged.length >= 30) break;
      }
    }
    if (merged.length >= 30) break;
  }
  return { items: merged, stats };
}

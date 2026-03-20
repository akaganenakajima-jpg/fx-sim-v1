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
  // === 日本語速報 ===
  { name: 'NHK', url: 'https://www3.nhk.or.jp/rss/news/cat6.xml' },
  { name: 'Investing', url: 'https://jp.investing.com/rss/news.rss' },
  { name: 'Reuters_JP', url: 'https://assets.wor.jp/rss/rdf/reuters/top.rdf' },
  { name: '2NN_Biz', url: 'https://www.2nn.jp/rss/bizplus.rdf' },
  // === 英語速報 ===
  { name: 'Bloomberg', url: 'https://feeds.bloomberg.com/markets/news.rss' },
  { name: 'CNBC', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  { name: 'FXStreet', url: 'https://www.fxstreet.com/rss' },
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  // WSJ削除: RSSフィードが2025年1月で停止（更新されない）
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

// 日本語ニュースを複数ソースから取得
// 優先順: NHK経済 → Google News JP（為替）

export interface NewsItem {
  title: string;
  description: string;
  pubDate: string;
}

const SOURCES = [
  // === 日本語ソース ===
  // NHK 経済ニュース
  'https://www3.nhk.or.jp/rss/news/cat6.xml',
  // Google News JP — 為替・株
  'https://news.google.com/rss/search?q=%E7%82%BA%E6%9B%BF+%E3%83%89%E3%83%AB%E5%86%86+%E6%97%A5%E9%8A%80&hl=ja&gl=JP&ceid=JP%3Aja',

  // === 英語ソース（グローバル市場） ===
  // Google News EN — Fed, rates, markets
  'https://news.google.com/rss/search?q=Federal+Reserve+interest+rates+markets&hl=en&gl=US&ceid=US%3Aen',
  // Google News EN — Gold, oil, commodities
  'https://news.google.com/rss/search?q=gold+price+oil+commodities+market&hl=en&gl=US&ceid=US%3Aen',
  // Google News EN — Bitcoin, crypto
  'https://news.google.com/rss/search?q=bitcoin+crypto+market&hl=en&gl=US&ceid=US%3Aen',
  // Google News EN — Geopolitics, Iran, trade war
  'https://news.google.com/rss/search?q=geopolitics+Iran+trade+war+sanctions&hl=en&gl=US&ceid=US%3Aen',
  // Google News EN — Euro, ECB, European markets
  'https://news.google.com/rss/search?q=euro+ECB+european+markets+EUR+USD&hl=en&gl=US&ceid=US%3Aen',
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

function parseItems(xml: string, limit = 8): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const title = extractCdata('title', block);
    if (!title) continue;
    items.push({
      title,
      description: extractCdata('description', block),
      pubDate: extractCdata('pubDate', block),
    });
    if (items.length >= limit) break;
  }
  return items;
}

export async function fetchNews(): Promise<NewsItem[]> {
  // 全ソースから並行取得してマージ（重複除去）
  const results = await Promise.allSettled(
    SOURCES.map(async (url) => {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FXNewsBot/1.0)',
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
        cf: { cacheTtl: 60 },
      } as RequestInit);
      if (!res.ok) return [];
      const xml = await res.text();
      return parseItems(xml, 5);
    })
  );

  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      if (!seen.has(item.title)) {
        seen.add(item.title);
        merged.push(item);
        if (merged.length >= 16) break;
      }
    }
    if (merged.length >= 16) break;
  }
  return merged;
}

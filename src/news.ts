// 日本語ニュースを複数ソースから取得
// 優先順: NHK経済 → Google News JP（為替）

export interface NewsItem {
  title: string;
  description: string;
  pubDate: string;
}

const SOURCES = [
  // NHK 経済ニュース（日本語・信頼性高）
  'https://www3.nhk.or.jp/rss/news/cat6.xml',
  // Google News 日本語 — 為替・ドル円・日銀・FRB
  'https://news.google.com/rss/search?q=%E7%82%BA%E6%9B%BF+%E3%83%89%E3%83%AB%E5%86%86+%E6%97%A5%E9%8A%80&hl=ja&gl=JP&ceid=JP%3Aja',
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
  for (const url of SOURCES) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FXNewsBot/1.0)',
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
        cf: { cacheTtl: 60 },
      } as RequestInit);
      if (!res.ok) {
        console.warn(`[news] ${url} -> ${res.status}`);
        continue;
      }
      const xml = await res.text();
      const items = parseItems(xml);
      if (items.length > 0) return items;
    } catch (e) {
      console.error('[news] fetch error:', url, e);
    }
  }
  return [];
}

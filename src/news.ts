// Reuters RSS をフェッチし直近5件を返す
// RSSパースは正規表現で <title><description> を抽出（xml2js不使用）

export interface NewsItem {
  title: string;
  description: string;
  pubDate: string;
}

const RSS_URL = 'https://feeds.reuters.com/reuters/businessNews';

function extractCdata(tag: string, xml: string): string {
  // CDATA あり: <tag><![CDATA[...]]></tag>
  // CDATA なし: <tag>...</tag>
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

function parseItems(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  // <item>...</item> のブロックを抽出
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    items.push({
      title: extractCdata('title', block),
      description: extractCdata('description', block),
      pubDate: extractCdata('pubDate', block),
    });
    if (items.length >= 5) break;
  }
  return items;
}

export async function fetchNews(): Promise<NewsItem[]> {
  try {
    const res = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'fx-sim-v1/1.0' },
    });
    if (!res.ok) {
      console.error(`[news] RSS fetch failed: ${res.status}`);
      return [];
    }
    const xml = await res.text();
    return parseItems(xml);
  } catch (e) {
    console.error('[news] error:', e);
    return [];
  }
}

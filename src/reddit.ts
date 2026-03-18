// Reddit r/Forex の新着投稿を取得しキーワード検出
// 2023年以降JSON APIは403のため、RSSフィードを利用

export interface RedditSignal {
  hasSignal: boolean;
  keywords: string[];
  topPosts: string[]; // 上位3件のタイトル
}

// 2023年以降JSON APIは403。RSS endpointはより緩い制限
const REDDIT_URL = 'https://www.reddit.com/r/Forex/new/.rss';

const KEYWORDS = [
  'intervention',
  'BOJ',
  'Fed',
  'rate hike',
  'rate cut',
  '日銀',
  '介入',
  '利上げ',
  '利下げ',
  'FOMC',
  'CPI',
];

/** Atom/RSSの<title>要素を抽出 */
function extractTitles(xml: string): string[] {
  const titles: string[] = [];
  // Atom形式: <entry><title>...</title></entry>
  const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const titleMatch = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(block);
    if (titleMatch) titles.push(titleMatch[1].trim());
  }
  return titles;
}

export async function fetchRedditSignal(): Promise<RedditSignal> {
  try {
    const res = await fetch(REDDIT_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/rss+xml, application/atom+xml, text/xml, */*',
      },
    });
    if (!res.ok) {
      console.error(`[reddit] fetch failed: ${res.status}`);
      return { hasSignal: false, keywords: [], topPosts: [] };
    }

    const xml = await res.text();
    const posts = extractTitles(xml);
    const topPosts = posts.slice(0, 3);

    const foundKeywords: string[] = [];
    for (const post of posts) {
      const lower = post.toLowerCase();
      for (const kw of KEYWORDS) {
        if (lower.includes(kw.toLowerCase()) && !foundKeywords.includes(kw)) {
          foundKeywords.push(kw);
        }
      }
    }

    return {
      hasSignal: foundKeywords.length > 0,
      keywords: foundKeywords,
      topPosts,
    };
  } catch (e) {
    console.error('[reddit] error:', e);
    return { hasSignal: false, keywords: [], topPosts: [] };
  }
}

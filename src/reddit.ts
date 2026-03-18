// Reddit r/Forex の新着投稿を取得しキーワード検出

export interface RedditSignal {
  hasSignal: boolean;
  keywords: string[];
  topPosts: string[]; // 上位3件のタイトル
}

const REDDIT_URL = 'https://www.reddit.com/r/Forex/new.json';

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

interface RedditChild {
  data: { title: string };
}

interface RedditResponse {
  data: { children: RedditChild[] };
}

export async function fetchRedditSignal(): Promise<RedditSignal> {
  try {
    const res = await fetch(REDDIT_URL, {
      headers: {
        'User-Agent': 'fx-sim-v1/1.0 (by fx-sim-bot)',
      },
    });
    if (!res.ok) {
      console.error(`[reddit] fetch failed: ${res.status}`);
      return { hasSignal: false, keywords: [], topPosts: [] };
    }

    const data = await res.json<RedditResponse>();
    const posts = data.data.children.map((c) => c.data.title);
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

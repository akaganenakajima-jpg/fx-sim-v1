// Reddit r/Forex の新着投稿を取得しキーワード検出
// OAuth API（client_credentials フロー）で正規アクセス

export interface RedditSignal {
  hasSignal: boolean;
  keywords: string[];
  topPosts: string[]; // 上位3件のタイトル
}

const SUBREDDITS = ['Forex', 'wallstreetbets', 'stocks', 'CryptoCurrency'];

const KEYWORDS = [
  // 為替・中央銀行
  'intervention', 'BOJ', 'Fed', 'rate hike', 'rate cut',
  '日銀', '介入', '利上げ', '利下げ', 'FOMC', 'CPI',
  'ECB', 'BOE', 'RBA',
  // エネルギー・コモディティ
  'OPEC', 'oil price', 'crude oil', 'natural gas', 'gold price',
  'copper', 'silver',
  // 暗号資産
  'bitcoin', 'ethereum', 'solana', 'crypto crash', 'ETF approval',
  'halving', 'SEC',
  // 地政学・マクロ
  'tariff', 'sanctions', 'trade war', 'recession',
];

// トークンキャッシュ（インメモリ — Worker再起動まで有効）
let cachedToken: { token: string; expiresAt: number } | null = null;

/** OAuth client_credentials でアクセストークン取得 */
async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  // キャッシュが有効なら再利用（5分余裕を持たせる）
  if (cachedToken && Date.now() < cachedToken.expiresAt - 300_000) {
    return cachedToken.token;
  }

  const credentials = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'fx-sim-v1/1.0 (by /u/fx-sim-bot)',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`Reddit OAuth failed: ${res.status}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

/** OAuth API で subreddit の新着投稿タイトルを取得 */
async function fetchSubredditPosts(token: string, subreddit: string): Promise<string[]> {
  const res = await fetch(`https://oauth.reddit.com/r/${subreddit}/new?limit=10`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'fx-sim-v1/1.0 (by /u/fx-sim-bot)',
    },
  });

  if (!res.ok) {
    console.warn(`[reddit] /r/${subreddit} ${res.status}`);
    return [];
  }

  const data = await res.json() as {
    data: { children: Array<{ data: { title: string } }> };
  };
  return data.data.children.map(c => c.data.title);
}

export async function fetchRedditSignal(
  clientId?: string,
  clientSecret?: string,
): Promise<RedditSignal> {
  // credentials がなければスキップ（後方互換）
  if (!clientId || !clientSecret) {
    return { hasSignal: false, keywords: [], topPosts: [] };
  }

  try {
    const token = await getAccessToken(clientId, clientSecret);

    // 全 subreddit を並列取得
    const results = await Promise.allSettled(
      SUBREDDITS.map(sub => fetchSubredditPosts(token, sub)),
    );
    const allPosts: string[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') allPosts.push(...r.value);
    }

    const topPosts = allPosts.slice(0, 3);

    const foundKeywords: string[] = [];
    for (const post of allPosts) {
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
    console.warn(`[reddit] OAuth error: ${e}`);
    return { hasSignal: false, keywords: [], topPosts: [] };
  }
}

// 進化型ニューストリアージ (Evolutionary Triage System)
//
// 設計思想:
//   キュー渋滞の根本原因は「古い低優先ニュースが LIMIT 5 の枠を占有する」こと。
//   VIPレーン（キーワード一致）と選択的破棄（古い非VIP）を組み合わせて解消する。
//
//   将来の自己進化:
//   trend_keywords は market_cache に保存され、AI が定期的に更新することで
//   相場テーマの変化に自動追従できる構造になっている。
//
//   参照: ipa/sa.md §単一責任原則 — トリアージロジックを analysis-workflow から分離

// ── Worker-level キーワードキャッシュ（5分TTL）─────────────────────────────
// Cloudflare Workers の同一 isolate 内ではグローバル変数が保持される。
// isolate が再作成された場合（コールドスタート）はキャッシュミスし DB を再読み込みする。
// これは冪等かつ安全: キャッシュミスはコストがかかるだけで動作には影響しない。
let _keywordCache: {
  coreKeywords: string[];
  trendKeywords: string[];
  loadedAt: number;
} | null = null;

const KEYWORD_CACHE_TTL_MS = 5 * 60 * 1000; // 5分

// フォールバック初期値（DBが空の場合や取得失敗時に使用）
export const DEFAULT_CORE_KEYWORDS  = ['緊急','戦争','攻撃','ミサイル','介入','日銀','BOJ','FRB','FOMC','利上げ','利下げ','CPI','雇用統計'];
export const DEFAULT_TREND_KEYWORDS = ['トランプ','イラン','原油','関税','半導体'];

// 古い低優先ニュースの TTL（45分）
const STALE_THRESHOLD_MS = 45 * 60 * 1000;

// ── キーワードロード（DB + Worker-level キャッシュ）─────────────────────────

/**
 * トリアージキーワードを DB から読み込む。
 * Worker-level キャッシュ（5分TTL）があればそれを返す。
 *
 * @param db D1 データベース
 * @returns coreKeywords と trendKeywords の配列
 */
export async function loadTriageKeywords(db: D1Database): Promise<{
  coreKeywords: string[];
  trendKeywords: string[];
}> {
  // キャッシュが有効な場合は再利用（毎 cron でのDB読み込みを回避）
  if (_keywordCache && (Date.now() - _keywordCache.loadedAt) < KEYWORD_CACHE_TTL_MS) {
    return { coreKeywords: _keywordCache.coreKeywords, trendKeywords: _keywordCache.trendKeywords };
  }

  // DB から読み込み（2クエリを並列実行）
  const [coreRow, trendRow] = await Promise.allSettled([
    db.prepare("SELECT value FROM market_cache WHERE key = 'core_keywords'").first<{ value: string }>(),
    db.prepare("SELECT value FROM market_cache WHERE key = 'trend_keywords'").first<{ value: string }>(),
  ]);

  const coreKeywords = (coreRow.status === 'fulfilled' && coreRow.value?.value)
    ? coreRow.value.value.split(',').map(k => k.trim()).filter(Boolean)
    : DEFAULT_CORE_KEYWORDS;

  const trendKeywords = (trendRow.status === 'fulfilled' && trendRow.value?.value)
    ? trendRow.value.value.split(',').map(k => k.trim()).filter(Boolean)
    : DEFAULT_TREND_KEYWORDS;

  // Worker-level キャッシュに保存
  _keywordCache = { coreKeywords, trendKeywords, loadedAt: Date.now() };

  return { coreKeywords, trendKeywords };
}

// ── ニュース優先度判定 ───────────────────────────────────────────────────────

/**
 * ニュースアイテムの優先度を判定する。
 *
 * VIP 判定: title_ja（または title）が core_keywords / trend_keywords の
 * いずれか1つでも含む場合 → 'VIP'
 * それ以外 → 'NORMAL'
 *
 * @param item   ニュースアイテム（title_ja または title を持つオブジェクト）
 * @param coreKeywords  普遍キーワードリスト
 * @param trendKeywords 相場テーマキーワードリスト
 */
export function classifyNews(
  item: { title?: string; title_ja?: string },
  coreKeywords: string[],
  trendKeywords: string[],
): 'VIP' | 'NORMAL' {
  const text = (item.title_ja ?? item.title ?? '').toLowerCase();
  for (const kw of coreKeywords) {
    if (text.includes(kw.toLowerCase())) return 'VIP';
  }
  for (const kw of trendKeywords) {
    if (text.includes(kw.toLowerCase())) return 'VIP';
  }
  return 'NORMAL';
}

// ── メイントリアージ関数 ─────────────────────────────────────────────────────

/**
 * ニュースリストにトリアージを適用し、AI に渡すべきニュースを返す。
 *
 * アルゴリズム:
 *   1. 各アイテムを VIP / NORMAL に分類
 *   2. NORMAL かつ pubDate が staleThresholdMs 以上古い → 破棄（SKIPPED）
 *      VIP は時間経過に関わらず保持
 *   3. 残ったアイテムを「VIP優先 → pubDate 新しい順」でソート
 *
 * @param news            入力ニュースリスト
 * @param coreKeywords    コアキーワードリスト
 * @param trendKeywords   トレンドキーワードリスト
 * @param staleThresholdMs 古いニュースの閾値（デフォルト45分）
 * @returns items: トリアージ済みニュース / skippedCount: 破棄件数
 */
export function triageNews<T extends { title?: string; title_ja?: string; pubDate?: string }>(
  news: T[],
  coreKeywords: string[],
  trendKeywords: string[],
  staleThresholdMs = STALE_THRESHOLD_MS,
): { items: T[]; skippedCount: number } {
  const now = Date.now();
  const kept: Array<{ item: T; isVip: boolean; pubMs: number }> = [];
  let skippedCount = 0;

  for (const item of news) {
    const isVip = classifyNews(item, coreKeywords, trendKeywords) === 'VIP';

    // pubDate を ms に変換（解析失敗 → 0 = 「新鮮扱い」）
    let pubMs = 0;
    try {
      if (item.pubDate) pubMs = new Date(item.pubDate).getTime();
    } catch { /* 解析失敗は新鮮扱い（スキップしない） */ }

    if (!isVip && pubMs > 0 && (now - pubMs) > staleThresholdMs) {
      // 選択的破棄: 低優先 + 古い = AI 送信しない
      skippedCount++;
      continue;
    }

    kept.push({ item, isVip, pubMs });
  }

  // VIP 優先 → pubDate 新しい順
  kept.sort((a, b) => {
    if (b.isVip !== a.isVip) return (b.isVip ? 1 : 0) - (a.isVip ? 1 : 0);
    return b.pubMs - a.pubMs; // 同優先度: 新しい順
  });

  return { items: kept.map(e => e.item), skippedCount };
}

// ── キャッシュリセット（テスト用）───────────────────────────────────────────

/** Worker-level キャッシュを強制クリア（テスト・強制更新用） */
export function resetKeywordCache(): void {
  _keywordCache = null;
}

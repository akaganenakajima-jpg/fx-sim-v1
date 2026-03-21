// ============================================================
// strategy-tag.ts — 施策7: 手法タグ × 環境タグ
// ============================================================

/** 手法タグ: AIが判断に使った手法を分類 */
export type StrategyTag =
  | 'trend_follow'
  | 'mean_reversion'
  | 'breakout'
  | 'news_driven'
  | 'range_trade';

/** レジームタグ: 現在の市場環境 */
export type RegimeTag =
  | 'strong_trend'
  | 'weak_trend'
  | 'ranging'
  | 'volatile'
  | 'uncertain';

/** セッションタグ: 取引時間帯 */
export type SessionTag =
  | 'tokyo'
  | 'london'
  | 'ny'
  | 'early_morning'
  | 'overlap';

// ----------------------------------------------------------
// バリデーション関数（AI出力のバリデーション用）
// ----------------------------------------------------------

const VALID_STRATEGIES: ReadonlySet<string> = new Set<StrategyTag>([
  'trend_follow',
  'mean_reversion',
  'breakout',
  'news_driven',
  'range_trade',
]);

const VALID_REGIMES: ReadonlySet<string> = new Set<RegimeTag>([
  'strong_trend',
  'weak_trend',
  'ranging',
  'volatile',
  'uncertain',
]);

const VALID_SESSIONS: ReadonlySet<string> = new Set<SessionTag>([
  'tokyo',
  'london',
  'ny',
  'early_morning',
  'overlap',
]);

/** 有効な手法タグか検証 */
export function isValidStrategy(s: string): s is StrategyTag {
  return VALID_STRATEGIES.has(s);
}

/** 有効なレジームタグか検証 */
export function isValidRegime(s: string): s is RegimeTag {
  return VALID_REGIMES.has(s);
}

/** 有効なセッションタグか検証 */
export function isValidSession(s: string): s is SessionTag {
  return VALID_SESSIONS.has(s);
}

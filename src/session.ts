/**
 * セッション管理モジュール
 * - 施策11: セッション別ロット倍率
 * - 施策19: 仲値トレード判定
 * - 施策26: セッション×銘柄マトリクス
 */

/** セッションタグ型（strategy-tag.ts が存在しない場合のローカル定義） */
export type SessionTag =
  | 'early_morning'
  | 'tokyo'
  | 'london'
  | 'overlap'
  | 'ny';

/**
 * 現在のセッションを判定（UTC→JST変換）
 *
 * JST 3-7   → 'early_morning'
 * JST 8-15  → 'tokyo'
 * JST 16-20 → 'london'
 * JST 21-24 → 'overlap' (ロンドン・NY重複)
 * JST 0-2   → 'ny'
 */
export function getCurrentSession(now: Date): SessionTag {
  const jstHour = (now.getUTCHours() + 9) % 24;

  if (jstHour >= 3 && jstHour <= 7) return 'early_morning';
  if (jstHour >= 8 && jstHour <= 15) return 'tokyo';
  if (jstHour >= 16 && jstHour <= 20) return 'london';
  if (jstHour >= 21 && jstHour <= 23) return 'overlap';
  // jstHour 0-2
  return 'ny';
}

/**
 * セッション別ロット倍率（施策11）
 *
 * early_morning: 0   (取引禁止 — 流動性極低)
 * tokyo:         1.0
 * london:        1.0
 * ny:            0.8
 * overlap:       1.2 (流動性最高)
 */
export function getSessionLotMultiplier(session: SessionTag): number {
  const multipliers: Record<SessionTag, number> = {
    early_morning: 0,
    tokyo: 1.0,
    london: 1.0,
    ny: 0.8,
    overlap: 1.2,
  };
  return multipliers[session];
}

/**
 * 仲値チェック（施策19）
 *
 * 仲値（TTM）は平日 JST 9:55 に決定される。
 * JST 8:00-10:00 の平日（月〜金）に true を返す。
 * 仲値前後はドル買い需要が高まる傾向がある。
 */
export function isNakaneWindow(now: Date): boolean {
  const jstHour = (now.getUTCHours() + 9) % 24;

  // UTC+9 で日付がずれるケースを考慮
  // JST 0-14時台 → UTC前日の15-23時 or 当日0-5時
  // 簡易的に曜日判定: JST時刻で日をまたぐ場合を補正
  const jstDate = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const jstDay = jstDate.getUTCDay();

  // 土日は false (0=日, 6=土)
  if (jstDay === 0 || jstDay === 6) return false;

  // JST 8:00-10:00 (8時台, 9時台)
  return jstHour >= 8 && jstHour <= 9;
}

/**
 * セッション × 銘柄マトリクス（施策26）
 *
 * 各セッションで取引に適した銘柄の倍率を返す。
 * ◎=1.0, ○=0.8, △=0.5, ✗=0
 *
 * | 銘柄        | tokyo | london | ny   | overlap |
 * |-------------|-------|--------|------|---------|
 * | USD/JPY     | ◎1.0  | △0.5   | ○0.8 | ○0.8    |
 * | EUR/USD     | △0.5  | ◎1.0   | ○0.8 | ○0.8    |
 * | GBP/USD     | △0.5  | ◎1.0   | ○0.8 | ○0.8    |
 * | AUD/USD     | ○0.8  | △0.5   | △0.5 | ○0.8    |
 * | Nikkei225   | ◎1.0  | △0.5   | △0.5 | ○0.8    |
 * | DAX         | △0.5  | ◎1.0   | △0.5 | ○0.8    |
 * | S&P500      | △0.5  | △0.5   | ◎1.0 | ○0.8    |
 * | NASDAQ      | △0.5  | △0.5   | ◎1.0 | ○0.8    |
 * | Gold        | △0.5  | ○0.8   | ○0.8 | ○0.8    |
 * | CrudeOil    | △0.5  | ○0.8   | ◎1.0 | ○0.8    |
 * | BTC/USD     | △0.5  | △0.5   | ◎1.0 | ○0.8    |
 */
export function getSessionInstrumentMultiplier(
  session: SessionTag,
  pair: string
): number {
  // early_morning は全銘柄取引禁止
  if (session === 'early_morning') return 0;

  // overlap は全銘柄 ○0.8
  if (session === 'overlap') return 0.8;

  // 銘柄名を正規化（大文字・スラッシュ除去）
  const normalized = pair.toUpperCase().replace(/[\/\s]/g, '');

  const matrix: Record<string, Record<string, number>> = {
    tokyo: {
      USDJPY: 1.0,
      NIKKEI225: 1.0,
      N225: 1.0,
      AUDUSD: 0.8,
      GOLD: 0.5,
      XAUUSD: 0.5,
      EURUSD: 0.5,
      GBPUSD: 0.5,
      DAX: 0.5,
      SP500: 0.5,
      SPX: 0.5,
      NASDAQ: 0.5,
      NDX: 0.5,
      CRUDEOIL: 0.5,
      WTI: 0.5,
      BTCUSD: 0.5,
      HK33: 1.0,
      UK100: 0.5,
    },
    london: {
      EURUSD: 1.0,
      GBPUSD: 1.0,
      DAX: 1.0,
      GOLD: 0.8,
      XAUUSD: 0.8,
      CRUDEOIL: 0.8,
      WTI: 0.8,
      USDJPY: 0.5,
      AUDUSD: 0.5,
      NIKKEI225: 0.5,
      N225: 0.5,
      SP500: 0.5,
      SPX: 0.5,
      NASDAQ: 0.5,
      NDX: 0.5,
      BTCUSD: 0.5,
      UK100: 1.0,
      HK33: 0.5,
    },
    ny: {
      SP500: 1.0,
      SPX: 1.0,
      NASDAQ: 1.0,
      NDX: 1.0,
      CRUDEOIL: 1.0,
      WTI: 1.0,
      BTCUSD: 1.0,
      GOLD: 0.8,
      XAUUSD: 0.8,
      USDJPY: 0.8,
      EURUSD: 0.8,
      GBPUSD: 0.8,
      AUDUSD: 0.5,
      NIKKEI225: 0.5,
      N225: 0.5,
      DAX: 0.5,
      UK100: 0.5,
      HK33: 0.5,
    },
  };

  const sessionMatrix = matrix[session];
  if (!sessionMatrix) return 0.5;

  return sessionMatrix[normalized] ?? 0.5;
}

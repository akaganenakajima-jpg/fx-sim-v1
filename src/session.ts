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
 * | EUR/JPY     | ◎1.0  | ◎1.0   | △0.5 | ○0.8    |
 * | GBP/JPY     | ○0.8  | ◎1.0   | △0.5 | ○0.8    |
 * | AUD/JPY     | ◎1.0  | △0.5   | △0.5 | ○0.8    |
 * | 日本株(19)  | ◎1.0  | ✗0     | ✗0   | ✗0      |
 * | 米国株(8)   | ✗0    | △0.3   | ◎1.0 | ○0.8    |
 */
export function getSessionInstrumentMultiplier(
  session: SessionTag,
  pair: string
): number {
  // early_morning は全銘柄取引禁止
  if (session === 'early_morning') return 0;

  // 銘柄名を正規化（大文字・スラッシュ除去）— 日本語銘柄はそのまま使用
  const normalized = /^[a-zA-Z]/.test(pair)
    ? pair.toUpperCase().replace(/[\/\s]/g, '')
    : pair;

  // overlap: FX/商品=0.8、日本株=0（TSE閉場）、米国株=0.8
  if (session === 'overlap') {
    const jpStocks = [
      // 旧10銘柄
      '川崎汽船', '日本郵船', 'ソフトバンクG', 'レーザーテック', '東京エレクトロン',
      'ディスコ', 'アドバンテスト', 'ファーストリテイリング', '日本製鉄', '三菱UFJ',
      // 新9銘柄
      '商船三井', '東京海上HD', '三菱商事', 'トヨタ', 'さくらインターネット',
      '三菱重工', 'IHI', 'ANYCOLOR', 'カバー',
    ];
    if (jpStocks.includes(pair)) return 0;
    return 0.8;
  }

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
      // 円クロス: 東京主力
      EURJPY: 1.0,
      GBPJPY: 0.8,
      AUDJPY: 1.0,
      // 日本株: 東京セッション = TSE営業時間（旧10+新9銘柄）
      '川崎汽船': 1.0,
      '日本郵船': 1.0,
      'ソフトバンクG': 1.0,
      'レーザーテック': 1.0,
      '東京エレクトロン': 1.0,
      'ディスコ': 1.0,
      'アドバンテスト': 1.0,
      'ファーストリテイリング': 1.0,
      '日本製鉄': 1.0,
      '三菱UFJ': 1.0,
      '商船三井': 1.0,
      '東京海上HD': 1.0,
      '三菱商事': 1.0,
      'トヨタ': 1.0,
      'さくらインターネット': 1.0,
      '三菱重工': 1.0,
      IHI: 1.0,
      ANYCOLOR: 1.0,
      'カバー': 1.0,
      // 米国株: 東京セッションでは取引不可
      NVDA: 0, TSLA: 0, AAPL: 0, AMZN: 0, AMD: 0,
      META: 0, MSFT: 0, GOOGL: 0,
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
      // 円クロス: ロンドンでも活発
      EURJPY: 1.0,
      GBPJPY: 1.0,
      AUDJPY: 0.5,
      // 日本株: TSE閉場（旧10+新9銘柄）
      '川崎汽船': 0, '日本郵船': 0, 'ソフトバンクG': 0,
      'レーザーテック': 0, '東京エレクトロン': 0, 'ディスコ': 0,
      'アドバンテスト': 0, 'ファーストリテイリング': 0,
      '日本製鉄': 0, '三菱UFJ': 0,
      '商船三井': 0, '東京海上HD': 0, '三菱商事': 0, 'トヨタ': 0,
      'さくらインターネット': 0, '三菱重工': 0, IHI: 0, ANYCOLOR: 0, 'カバー': 0,
      // 米国株: プレマーケット（低倍率）
      NVDA: 0.3, TSLA: 0.3, AAPL: 0.3, AMZN: 0.3, AMD: 0.3,
      META: 0.3, MSFT: 0.3, GOOGL: 0.3,
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
      // 円クロス: NYは低倍率
      EURJPY: 0.5,
      GBPJPY: 0.5,
      AUDJPY: 0.5,
      // 日本株: TSE閉場（旧10+新9銘柄）
      '川崎汽船': 0, '日本郵船': 0, 'ソフトバンクG': 0,
      'レーザーテック': 0, '東京エレクトロン': 0, 'ディスコ': 0,
      'アドバンテスト': 0, 'ファーストリテイリング': 0,
      '日本製鉄': 0, '三菱UFJ': 0,
      '商船三井': 0, '東京海上HD': 0, '三菱商事': 0, 'トヨタ': 0,
      'さくらインターネット': 0, '三菱重工': 0, IHI: 0, ANYCOLOR: 0, 'カバー': 0,
      // 米国株: NYSE/NASDAQ本場
      NVDA: 1.0, TSLA: 1.0, AAPL: 1.0, AMZN: 1.0, AMD: 1.0,
      META: 1.0, MSFT: 1.0, GOOGL: 1.0,
    },
  };

  const sessionMatrix = matrix[session];
  if (!sessionMatrix) return 0.5;

  return sessionMatrix[normalized] ?? 0.5;
}

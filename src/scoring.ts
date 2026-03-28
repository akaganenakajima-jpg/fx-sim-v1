// src/scoring.ts
// テスタ式3軸スコアリングエンジン
// 設計根拠:
//   需給熱50%: テスタ「出来高が急増している」「ボラが大きい」
//   モメンタム30%: テスタ「エントリー時に株価が上がっていないといけない」
//   ファンダフィルタ20%: テスタ「どうしたら負けないで済むか」(地雷除外)

import type { D1Database } from '@cloudflare/workers-types';

export interface StockScoreInput {
  symbol: string;           // '7203.T'
  stockSymbol: string;      // '7203.T' (Yahoo Finance用)
  displayName: string;
  // 出来高データ
  vol5dAvg: number | null;   // 5日平均出来高
  vol20dAvg: number | null;  // 20日平均出来高
  vol1d: number | null;      // 当日出来高（直近）
  volYesterday: number | null;
  // 値幅データ
  highLow1d: number | null;  // 当日high-low
  highLow20dAvg: number | null; // 20日平均high-low
  // テクニカル
  rsi: number | null;
  adx: number | null;
  // 52週レンジ
  week52High: number | null;
  week52Low: number | null;
  currentPrice: number | null;
  // ニュース言及数
  newsCount3d: number;   // 過去3日の言及件数
  newsCount14d: number;  // 過去14日の言及件数
  // ファンダ
  equityRatio: number | null;
  netProfit: number | null;
  prevNetProfit: number | null;  // 前期net_profit（2期連続赤字判定用）
  forecastOpChange: number | null; // 営業利益前年比変化率
  per: number | null;
  sectorAvgPer: number | null;
  dividendYield: number | null;
  marketCap: number | null;
  nextEarningsDate: string | null;
  isThemeStock: boolean;  // correlationGroupがテーマ株グループかどうか
}

export interface StockScore {
  symbol: string;
  displayName: string;
  themeScore: number;    // 需給熱 0-100
  fundaScore: number;    // ファンダ補正 0-100
  momentumScore: number; // モメンタム 0-100
  totalScore: number;    // 重み付き合計
  fundaFail: boolean;    // trueなら強制除外
  fundaFailReason: string | null;
  daysToEarnings: number | null;  // 決算まで何日
}

/** ファンダフィルタ: 強制除外条件を判定 */
function checkFundaFail(input: StockScoreInput): { fail: boolean; reason: string | null } {
  // 債務超過
  if (input.equityRatio !== null && input.equityRatio < 0) {
    return { fail: true, reason: '債務超過（自己資本比率<0）' };
  }

  // 2期連続赤字
  if (
    input.netProfit !== null && input.netProfit < 0 &&
    input.prevNetProfit !== null && input.prevNetProfit < 0
  ) {
    return { fail: true, reason: '2期連続赤字' };
  }

  // 時価総額10億未満（百万円単位: 1000百万円 = 10億円）
  if (input.marketCap !== null && input.marketCap < 1000) {
    return { fail: true, reason: '時価総額10億円未満（上場廃止基準）' };
  }

  // 決算3日以内
  if (input.nextEarningsDate) {
    const daysUntil = Math.ceil(
      (new Date(input.nextEarningsDate).getTime() - Date.now()) / (1000 * 3600 * 24)
    );
    if (daysUntil >= 0 && daysUntil <= 3) {
      return { fail: true, reason: `決算${daysUntil}日前` };
    }
  }

  return { fail: false, reason: null };
}

/** ファンダ補正スコア計算（0-100） */
function calcFundaScore(input: StockScoreInput): number {
  let score = 50; // 基礎点

  // 業績修正方向
  if (input.forecastOpChange !== null) {
    if (input.forecastOpChange > 5) score += 20;       // 上方修正
    else if (input.forecastOpChange < -5) score -= 20;  // 下方修正
  }

  // PER割安/割高
  if (input.per !== null && input.sectorAvgPer !== null && input.sectorAvgPer > 0) {
    const perRatio = input.per / input.sectorAvgPer;
    if (perRatio < 0.8) score += 15;  // 割安（業種平均の80%未満）
    else if (perRatio > 1.3) score -= 10; // 割高（業種平均の130%超）
  }

  // 配当利回り
  if (input.dividendYield !== null) {
    if (input.dividendYield >= 3.0) score += 10;  // 高配当
    else if (input.dividendYield === 0) score -= 5; // 無配
  }

  // 自己資本比率
  if (input.equityRatio !== null) {
    if (input.equityRatio >= 50) score += 5;      // 財務健全
    else if (input.equityRatio < 20) score -= 10;  // 財務脆弱
  }

  return Math.min(100, Math.max(5, score)); // 5-100にクランプ
}

/** 需給熱スコア計算（0-100） */
function calcThemeScore(input: StockScoreInput): number {
  const scores: Array<{ score: number; weight: number }> = [];

  // 出来高変化率（5日平均/20日平均）— 重み40%
  if (input.vol5dAvg && input.vol20dAvg && input.vol20dAvg > 0) {
    const ratio = input.vol5dAvg / input.vol20dAvg;
    // ratio=1.0 → 50点、ratio=2.0 → 100点、ratio=0.5 → 0点
    const volScore = Math.min(100, Math.max(0, (ratio - 0.5) / 1.5 * 100));
    scores.push({ score: volScore, weight: 0.40 });
  } else {
    scores.push({ score: 50, weight: 0.40 }); // データなし→中間値
  }

  // 出来高加速度（昨日 vs 前々日）— 重み20%
  if (input.vol1d && input.volYesterday && input.vol20dAvg && input.vol20dAvg > 0) {
    const accelToday = input.vol1d / input.vol20dAvg;
    const accelYesterday = input.volYesterday / input.vol20dAvg;
    const accel = accelToday - accelYesterday;
    const accelScore = Math.min(100, Math.max(0, 50 + accel * 50));
    scores.push({ score: accelScore, weight: 0.20 });
  } else {
    scores.push({ score: 50, weight: 0.20 });
  }

  // 値幅変化率（当日high-low / 20日平均high-low）— 重み25%
  if (input.highLow1d !== null && input.highLow20dAvg && input.highLow20dAvg > 0) {
    const ratio = input.highLow1d / input.highLow20dAvg;
    const rangeScore = Math.min(100, Math.max(0, (ratio - 0.5) / 1.5 * 100));
    scores.push({ score: rangeScore, weight: 0.25 });
  } else {
    scores.push({ score: 50, weight: 0.25 });
  }

  // ニュース言及急増（過去3日/14日比）— 重み15%
  const newsRatio = input.newsCount14d > 0
    ? (input.newsCount3d / 3) / (input.newsCount14d / 14)
    : 1.0;
  const newsScore = Math.min(100, Math.max(0, (newsRatio - 0.5) / 2.5 * 100));
  scores.push({ score: newsScore, weight: 0.15 });

  // 加重合計
  const total = scores.reduce((sum, s) => sum + s.score * s.weight, 0);
  return Math.min(100, Math.max(0, total));
}

/** モメンタムスコア計算（0-100） */
function calcMomentumScore(input: StockScoreInput): number {
  const scores: Array<{ score: number; weight: number }> = [];

  // 方向明確度: |RSI-50|/50 — 重み40%
  if (input.rsi !== null) {
    const dirScore = Math.abs(input.rsi - 50) / 50 * 100;
    scores.push({ score: dirScore, weight: 0.40 });
  } else {
    scores.push({ score: 50, weight: 0.40 });
  }

  // トレンド強度: ADX — 重み30%
  if (input.adx !== null) {
    // ADX<20 → 0点、ADX=25 → 50点、ADX=40+ → 100点
    const adxScore = Math.min(100, Math.max(0, (input.adx - 20) / 20 * 100));
    scores.push({ score: adxScore, weight: 0.30 });
  } else {
    scores.push({ score: 50, weight: 0.30 });
  }

  // 価格位置（52週レンジ）— 重み30%
  if (input.week52High !== null && input.week52Low !== null && input.currentPrice !== null) {
    const range = input.week52High - input.week52Low;
    if (range > 0) {
      const pos = (input.currentPrice - input.week52Low) / range; // 0-1
      // 上位20%または下位20%で高スコア（方向性明確）
      const posScore = pos >= 0.8 || pos <= 0.2
        ? 100
        : Math.abs(pos - 0.5) / 0.5 * 80;
      scores.push({ score: posScore, weight: 0.30 });
    } else {
      scores.push({ score: 50, weight: 0.30 });
    }
  } else {
    scores.push({ score: 50, weight: 0.30 });
  }

  return scores.reduce((sum, s) => sum + s.score * s.weight, 0);
}

function calcDaysToEarnings(nextEarningsDate: string | null): number | null {
  if (!nextEarningsDate) return null;
  const days = Math.ceil(
    (new Date(nextEarningsDate).getTime() - Date.now()) / (1000 * 3600 * 24)
  );
  return days >= 0 ? days : null;
}

/** 総合スコアを計算 */
export function calcStockScore(input: StockScoreInput): StockScore {
  const { fail, reason } = checkFundaFail(input);

  if (fail) {
    return {
      symbol: input.symbol,
      displayName: input.displayName,
      themeScore: 0,
      fundaScore: 0,
      momentumScore: 0,
      totalScore: 0,
      fundaFail: true,
      fundaFailReason: reason,
      daysToEarnings: calcDaysToEarnings(input.nextEarningsDate),
    };
  }

  const themeScore = calcThemeScore(input);
  const fundaScore = calcFundaScore(input);
  const momentumScore = calcMomentumScore(input);
  const totalScore = themeScore * 0.50 + momentumScore * 0.30 + fundaScore * 0.20;

  return {
    symbol: input.symbol,
    displayName: input.displayName,
    themeScore: Math.round(themeScore * 10) / 10,
    fundaScore: Math.round(fundaScore * 10) / 10,
    momentumScore: Math.round(momentumScore * 10) / 10,
    totalScore: Math.round(totalScore * 10) / 10,
    fundaFail: false,
    fundaFailReason: null,
    daysToEarnings: calcDaysToEarnings(input.nextEarningsDate),
  };
}

/** スコアをD1に保存（UPSERT） */
export async function saveScores(
  db: D1Database,
  scores: StockScore[],
  scoredAt: string  // 'YYYY-MM-DD'
): Promise<void> {
  // ランクを付与（fundaFailを除く）
  const ranked = [...scores]
    .filter(s => !s.fundaFail)
    .sort((a, b) => b.totalScore - a.totalScore);

  for (let i = 0; i < ranked.length; i++) {
    const s = ranked[i];
    await db.prepare(`
      INSERT OR REPLACE INTO stock_scores
        (symbol, scored_at, theme_score, funda_score, momentum_score, total_score, rank, in_universe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      s.symbol, scoredAt,
      s.themeScore, s.fundaScore, s.momentumScore, s.totalScore,
      i + 1, 0  // in_universeはrotation.tsで更新
    ).run();
  }
}

/** ニュース言及数をカウント（news_rawテーブルから） */
export async function countNewsForSymbol(
  db: D1Database,
  displayName: string,  // 'トヨタ' or '7203' etc
  days: number
): Promise<number> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const result = await db.prepare(`
    SELECT COUNT(*) as cnt FROM news_raw
    WHERE created_at >= ?
    AND (title_ja LIKE ? OR desc_ja LIKE ?)
    AND haiku_accepted = 1
  `).bind(since, `%${displayName}%`, `%${displayName}%`)
    .first<{ cnt: number }>();
  return result?.cnt ?? 0;
}

/** 業種平均PERを取得（market_cacheから。なければデフォルト値） */
export async function getSectorAvgPer(
  db: D1Database,
  sector: string | null
): Promise<number | null> {
  if (!sector) return null;
  const key = `sector_per_${sector}`;
  const cached = await db.prepare("SELECT value FROM market_cache WHERE key = ?")
    .bind(key).first<{ value: string }>();
  if (cached) return parseFloat(cached.value) || null;
  // デフォルト値（業種平均PER参考値）
  const defaults: Record<string, number> = {
    '半導体': 30, '電機': 20, '輸送用機器': 12, '銀行': 10,
    '保険': 15, '小売': 25, '情報・通信': 28, '医薬品': 35,
    '化学': 18, '機械': 16, '鉄鋼': 10, '建設': 14,
  };
  for (const [key2, val] of Object.entries(defaults)) {
    if (sector.includes(key2)) return val;
  }
  return 20; // 全業種平均
}

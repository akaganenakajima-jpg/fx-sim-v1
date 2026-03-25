// 統計計算モジュール（T003: 統計学的評価改善）
// Wilson CI, Sharpe SE, VaR/CVaR, Kelly基準, マルコフ遷移
// ローリングリターン, 最大DD%, 期間別パフォーマンス, PnLボラティリティ

/** Wilsonスコア区間（勝率=RR≥1.0の95%信頼区間） */
export function wilsonCI(wins: number, total: number, z = 1.96): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 0 };
  const p = wins / total;
  const denom = 1 + z * z / total;
  const center = p + z * z / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
  return {
    lower: Math.max(0, (center - spread) / denom),
    upper: Math.min(1, (center + spread) / denom),
  };
}

/** Sharpe比 + 標準誤差 */
export function sharpeWithSE(pnls: number[]): { sharpe: number; se: number; significant: boolean } {
  if (pnls.length < 3) return { sharpe: 0, se: 0, significant: false };
  const n = pnls.length;
  const mean = pnls.reduce((s, v) => s + v, 0) / n;
  const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? mean / stdev : 0;
  const se = Math.sqrt((1 + sharpe * sharpe / 2) / n);
  return { sharpe, se, significant: Math.abs(sharpe) > 1.96 * se };
}

/** VaR / CVaR（ヒストリカル法） */
export function varCvar(pnls: number[], confidence = 0.95): { var95: number; cvar95: number } {
  if (pnls.length < 10) return { var95: 0, cvar95: 0 };
  const sorted = [...pnls].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * (1 - confidence));
  const var95 = sorted[idx];
  const tail = sorted.slice(0, idx + 1);
  const cvar95 = tail.length > 0 ? tail.reduce((s, v) => s + v, 0) / tail.length : var95;
  return { var95, cvar95 };
}

/** ケリー基準（最適ベット比率） */
export function kellyFraction(winRate: number, avgRR: number): number {
  if (avgRR <= 0) return 0;
  const f = winRate - (1 - winRate) / avgRR;
  return Math.max(0, Math.min(f, 0.25)); // 上限25%（フルケリーは危険）
}

/** 最大ドローダウン（資産曲線からピーク→谷の最大下落率%）
 *  時系列解析の定常性チェック: 累積リターンの非定常性を可視化 */
export function maxDrawdown(pnls: number[], initialBalance = 10000): {
  maxDD: number;       // 最大DD額
  maxDDPct: number;    // 最大DD%
  currentDD: number;   // 現在DD額
  currentDDPct: number; // 現在DD%
  recoveryRatio: number; // 回復率（現在値/ピーク）
} {
  if (pnls.length === 0) return { maxDD: 0, maxDDPct: 0, currentDD: 0, currentDDPct: 0, recoveryRatio: 1 };
  let peak = initialBalance;
  let maxDD = 0;
  let balance = initialBalance;
  for (const pnl of pnls) {
    balance += pnl;
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxDD) maxDD = dd;
  }
  const currentDD = peak - balance;
  return {
    maxDD,
    maxDDPct: peak > 0 ? (maxDD / peak) * 100 : 0,
    currentDD,
    currentDDPct: peak > 0 ? (currentDD / peak) * 100 : 0,
    recoveryRatio: peak > 0 ? balance / peak : 1,
  };
}

/** ローリングリターン（直近N件の累計PnL → ROI%）
 *  弱定常性チェック: ウィンドウ内の平均・分散が安定しているか */
export function rollingReturns(
  pnls: number[],
  windows: number[],
  initialBalance = 10000,
  /** RR≥1.0 基準の勝敗配列（pnls と同じ長さ）。省略時は pnl > 0 で判定（後方互換） */
  rrOutcomes?: boolean[],
): Record<number, { roi: number; sharpe: number; winRate: number; count: number }> {
  const result: Record<number, { roi: number; sharpe: number; winRate: number; count: number }> = {};
  for (const w of windows) {
    const slice = pnls.slice(-w);
    // RR≥1.0 基準の勝率を使用（プロジェクト統一定義）
    const outcomeSlice = rrOutcomes ? rrOutcomes.slice(-w) : null;
    if (slice.length === 0) {
      result[w] = { roi: 0, sharpe: 0, winRate: 0, count: 0 };
      continue;
    }
    const sum = slice.reduce((s, v) => s + v, 0);
    const wins = outcomeSlice
      ? outcomeSlice.filter(v => v).length
      : slice.filter(v => v > 0).length;
    const sh = sharpeWithSE(slice);
    result[w] = {
      roi: (sum / initialBalance) * 100,
      sharpe: sh.sharpe,
      winRate: slice.length > 0 ? (wins / slice.length) * 100 : 0,
      count: slice.length,
    };
  }
  return result;
}

/** PnLボラティリティ（GARCH的概念: 直近の分散クラスタリング検出）
 *  直近N件の標準偏差 vs 全体標準偏差 → ボラティリティ比 */
export function pnlVolatility(pnls: number[], recentWindow = 10): {
  overallStd: number;
  recentStd: number;
  volRatio: number;    // >1: ボラ拡大中, <1: ボラ縮小中
  isHighVol: boolean;  // 直近ボラが全体の1.5倍超
} {
  if (pnls.length < recentWindow + 3) return { overallStd: 0, recentStd: 0, volRatio: 1, isHighVol: false };
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const std = (arr: number[]) => {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
  };
  const overallStd = std(pnls);
  const recentStd = std(pnls.slice(-recentWindow));
  const volRatio = overallStd > 0 ? recentStd / overallStd : 1;
  return { overallStd, recentStd, volRatio, isHighVol: volRatio > 1.5 };
}

/** プロフィットファクター（総利益/総損失） */
export function profitFactor(pnls: number[]): number {
  const gains = pnls.filter(p => p > 0).reduce((s, v) => s + v, 0);
  const losses = Math.abs(pnls.filter(p => p < 0).reduce((s, v) => s + v, 0));
  return losses > 0 ? gains / losses : gains > 0 ? Infinity : 0;
}

/**
 * AI方向的中率 + 決定論的Brier Score
 *
 * Brier Score = (1/N) Σ (f_i - o_i)^2
 * 決定論的な BUY/SELL 判断では f_i = 1（確信度100%固定）なので
 * BS = (正解率をMissした割合) = 1 - accuracy
 * 完璧予測 BS=0、ランダム BS=0.5、最悪 BS=1.0
 *
 * @param outcomes BUY/SELL判定のoutcome配列（'WIN' | 'LOSE'）
 */
export function aiAccuracy(outcomes: Array<'WIN' | 'LOSE'>): {
  accuracy: number;        // 方向的中率（0〜1）
  brierScore: number;      // Brier Score（0=完璧, 0.5=ランダム, 1=最悪）
  n: number;               // 評価済みサンプル数
  wins: number;            // 的中数
  brierHistory: number[];  // 直近10ウィンドウのBrierスコア推移
  brierTrend: 'improving' | 'worsening' | 'stable';
} {
  const n = outcomes.length;
  if (n === 0) return { accuracy: 0, brierScore: 0.5, n: 0, wins: 0, brierHistory: [], brierTrend: 'stable' };
  const wins = outcomes.filter(o => o === 'WIN').length;
  const accuracy = wins / n;
  const brierScore = 1 - accuracy;

  // 直近10ウィンドウ（各5件）のBrierスコア推移
  const windowSize = 5;
  const brierHistory: number[] = [];
  for (let i = windowSize; i <= n; i += Math.max(1, Math.floor(n / 10))) {
    const slice = outcomes.slice(Math.max(0, i - windowSize), i);
    const w = slice.filter(o => o === 'WIN').length;
    brierHistory.push(1 - w / slice.length);
    if (brierHistory.length >= 10) break;
  }

  // トレンド判定（最初の半分 vs 後半の半分）
  let brierTrend: 'improving' | 'worsening' | 'stable' = 'stable';
  if (brierHistory.length >= 4) {
    const half = Math.floor(brierHistory.length / 2);
    const early = brierHistory.slice(0, half).reduce((s, v) => s + v, 0) / half;
    const late = brierHistory.slice(half).reduce((s, v) => s + v, 0) / (brierHistory.length - half);
    if (late < early - 0.05) brierTrend = 'improving';
    else if (late > early + 0.05) brierTrend = 'worsening';
  }

  return { accuracy, brierScore, n, wins, brierHistory, brierTrend };
}

/** ROIブートストラップ95%信頼区間
 *  分布非依存の方法でROIの不確実性を定量化。
 *  B回リサンプリング → パーセンタイル法で [2.5%, 97.5%] を取得。
 *  n < 10 の場合は区間を返さない（データ不足）。
 */
export function bootstrapROI(
  pnls: number[],
  initialBalance = 10000,
  B = 1000,
): { roi: number; ciLower: number; ciUpper: number; n: number } {
  const n = pnls.length;
  const roi = n > 0 ? (pnls.reduce((s, v) => s + v, 0) / initialBalance) * 100 : 0;
  if (n < 10) return { roi, ciLower: roi, ciUpper: roi, n };

  const bootstrapROIs: number[] = [];
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += pnls[Math.floor(Math.random() * n)];
    }
    bootstrapROIs.push((sum / initialBalance) * 100);
  }
  bootstrapROIs.sort((a, c) => a - c);
  const lo = Math.floor(B * 0.025);
  const hi = Math.floor(B * 0.975);
  return { roi, ciLower: bootstrapROIs[lo], ciUpper: bootstrapROIs[hi], n };
}

/** 標準正規分布のCDF（Abramowitz & Stegun近似 §26.2.17） */
function normalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422820 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z > 0 ? 1 - p : p;
}

/** Mann-Whitney U検定（AI戦略 vs ランダム戦略の中央値比較）
 *  帰無仮説: 両群のPnL中央値に差がない
 *  タイ補正付き正規近似（n≥10推奨）
 */
export function mannWhitneyU(
  aiPnls: number[],
  randomPnls: number[],
): { u: number; z: number; pValue: number; significant: boolean } {
  const m = aiPnls.length;
  const n = randomPnls.length;
  if (m < 10 || n < 10) return { u: 0, z: 0, pValue: 1, significant: false };

  const combined = [
    ...aiPnls.map(v => ({ v, isAi: true })),
    ...randomPnls.map(v => ({ v, isAi: false })),
  ].sort((a, b) => a.v - b.v);

  // タイ補正付き順位付け
  let i = 0;
  const ranks: number[] = new Array(combined.length);
  let tieCorrSum = 0;
  while (i < combined.length) {
    let j = i;
    while (j < combined.length && combined[j].v === combined[i].v) j++;
    const avgRank = (i + j + 1) / 2; // 1-indexed
    for (let k = i; k < j; k++) ranks[k] = avgRank;
    const t = j - i;
    tieCorrSum += t * t * t - t;
    i = j;
  }

  let R1 = 0;
  for (let k = 0; k < combined.length; k++) {
    if (combined[k].isAi) R1 += ranks[k];
  }

  const u1 = R1 - m * (m + 1) / 2; // AI群のU統計量
  const u2 = m * n - u1;
  const u = Math.min(u1, u2);
  const N = m + n;
  const meanU = m * n / 2;
  const varU = (m * n / (N * (N - 1))) * ((N * N * N - N - tieCorrSum) / 12);
  const z = varU > 0 ? (u1 - meanU) / Math.sqrt(varU) : 0;
  const pValue = 2 * normalCDF(-Math.abs(z)); // 両側p値
  return { u, z, pValue, significant: pValue < 0.05 };
}

/** ランダムベースライン比較（モンテカルロ + Mann-Whitney U）
 *  AI戦略PnLがランダム（シャッフル）より有意に優れているか検定する
 */
export function randomBaselineComparison(
  aiPnls: number[],
  B = 500,
): {
  mwu: { u: number; z: number; pValue: number; significant: boolean };
  randomMean: number;
  aiMean: number;
  beatRate: number;  // AIがランダムを上回った確率（ブートストラップ）
} {
  const n = aiPnls.length;
  if (n < 10) return {
    mwu: { u: 0, z: 0, pValue: 1, significant: false },
    randomMean: 0, aiMean: 0, beatRate: 0,
  };

  // ランダム戦略: 同一PnL分布からB回リサンプリング
  const randomPnls: number[] = [];
  for (let b = 0; b < B; b++) {
    randomPnls.push(aiPnls[Math.floor(Math.random() * n)]);
  }

  const mwu = mannWhitneyU(aiPnls, randomPnls);
  const aiMean = aiPnls.reduce((s, v) => s + v, 0) / n;
  const randomMean = randomPnls.reduce((s, v) => s + v, 0) / B;

  // ビートレート: ブートストラップ200回でAI合計 > ランダム合計の割合
  let beatCount = 0;
  for (let b = 0; b < 200; b++) {
    let aiSum = 0;
    let randSum = 0;
    for (let k = 0; k < n; k++) {
      aiSum += aiPnls[Math.floor(Math.random() * n)];
      randSum += randomPnls[Math.floor(Math.random() * B)];
    }
    if (aiSum > randSum) beatCount++;
  }
  return { mwu, randomMean, aiMean, beatRate: beatCount / 200 };
}

/** ピアソン相関係数（補助関数） */
function pearsonR(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const sa = a.slice(0, n);
  const sb = b.slice(0, n);
  const meanA = sa.reduce((s, v) => s + v, 0) / n;
  const meanB = sb.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = sa[i] - meanA;
    const db = sb[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

/** 銘柄間PnL相関行列（過集中リスク検出用）
 *  |r| > 0.7: 高相関 → 同方向リスクの集中に注意
 */
export function pairCorrelation(
  pnlByPair: Record<string, number[]>,
  minN = 5,
): Array<{ pair1: string; pair2: string; r: number; n: number }> {
  const pairs = Object.keys(pnlByPair);
  const result: Array<{ pair1: string; pair2: string; r: number; n: number }> = [];
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const a = pnlByPair[pairs[i]];
      const b = pnlByPair[pairs[j]];
      const n = Math.min(a.length, b.length);
      if (n < minN) continue;
      result.push({ pair1: pairs[i], pair2: pairs[j], r: pearsonR(a, b), n });
    }
  }
  return result.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}

/** Bonferroni補正（保守的・第一種過誤を厳密制御）
 *  各p値をm（検定数）倍 → 多重検定での偽陽性を防ぐ
 */
export function bonferroniCorrection(
  pValues: number[],
  alpha = 0.05,
): { corrected: number[]; rejected: boolean[] } {
  const m = pValues.length;
  const corrected = pValues.map(p => Math.min(p * m, 1));
  return { corrected, rejected: corrected.map(p => p < alpha) };
}

/** Benjamini-Hochberg FDR補正（検出力維持・偽発見率制御）
 *  保守的なBonferroniより多くの有意差を検出できる
 */
export function fdrCorrection(
  pValues: number[],
  alpha = 0.05,
): { corrected: number[]; rejected: boolean[] } {
  const m = pValues.length;
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let maxRejected = -1;
  for (let k = 0; k < m; k++) {
    if (indexed[k].p <= ((k + 1) / m) * alpha) maxRejected = k;
  }
  const corrected = new Array<number>(m);
  for (let k = 0; k < m; k++) {
    corrected[indexed[k].i] = Math.min(indexed[k].p * m / (k + 1), 1);
  }
  const rejected = new Array<boolean>(m).fill(false);
  for (let k = 0; k <= maxRejected; k++) rejected[indexed[k].i] = true;
  return { corrected, rejected };
}

/** 対数リターン（連続複利ベース）
 *  FXの小幅変動では算術リターンと近似等価だが、歪度・尖度の計算に理論的に正しい
 */
export function logReturn(entry: number, close: number): number {
  if (entry <= 0 || close <= 0) return 0;
  return Math.log(close / entry) * 100; // %表示
}

/** 対数リターン系列の分布統計
 *  歪度: 正 = 大勝ち稀、負 = 大負け稀
 *  尖度: >3 = テールリスク大（ファットテール）
 */
export function logReturnStats(logReturns: number[]): {
  mean: number;
  stdev: number;
  skewness: number;
  kurtosis: number;
} {
  const n = logReturns.length;
  if (n < 4) return { mean: 0, stdev: 0, skewness: 0, kurtosis: 0 };
  const mean = logReturns.reduce((s, v) => s + v, 0) / n;
  const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return { mean, stdev: 0, skewness: 0, kurtosis: 0 };
  const skewness = logReturns.reduce((s, v) => s + ((v - mean) / stdev) ** 3, 0) / n;
  const kurtosis = logReturns.reduce((s, v) => s + ((v - mean) / stdev) ** 4, 0) / n;
  return { mean, stdev, skewness, kurtosis };
}

/** SL損切りパターン分析（条件別SL率）
 *  入力: ポジション+決定のJOINデータ
 *  出力: VIX水準×時間帯×銘柄カテゴリ別のSL率
 */
export interface SLPattern {
  vixBucket: 'low' | 'mid' | 'high' | 'unknown';   // <15 / 15-25 / >25
  session: 'tokyo' | 'london' | 'ny' | 'other';    // JST 時間帯
  pairCategory: 'fx' | 'equity' | 'crypto' | 'commodity' | 'bond';
  slCount: number;
  totalCount: number;
  slRate: number;  // SL率
}

export function slPatternAnalysis(
  rows: Array<{
    close_reason: string;
    closed_at: string;
    vix: number | null;
    pair: string;
  }>
): SLPattern[] {
  const buckets = new Map<string, { sl: number; total: number }>();

  for (const row of rows) {
    const vixBucket: SLPattern['vixBucket'] =
      row.vix == null ? 'unknown' :
      row.vix < 15 ? 'low' :
      row.vix < 25 ? 'mid' : 'high';

    const hour = (new Date(row.closed_at).getUTCHours() + 9) % 24;
    const session: SLPattern['session'] =
      hour >= 8 && hour < 15 ? 'tokyo' :
      hour >= 15 && hour < 22 ? 'london' :
      (hour >= 22 || hour < 7) ? 'ny' : 'other';

    const pair = row.pair;
    const pairCategory: SLPattern['pairCategory'] =
      ['USD/JPY','EUR/USD','GBP/USD','AUD/USD'].includes(pair) ? 'fx' :
      ['Nikkei225','S&P500','DAX','NASDAQ'].includes(pair) ? 'equity' :
      ['BTC/USD','ETH/USD','SOL/USD'].includes(pair) ? 'crypto' :
      ['Gold','Silver','Copper','CrudeOil','NatGas'].includes(pair) ? 'commodity' : 'bond';

    const key = `${vixBucket}|${session}|${pairCategory}`;
    const bucket = buckets.get(key) ?? { sl: 0, total: 0 };
    bucket.total++;
    if (row.close_reason === 'SL') bucket.sl++;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .map(([key, v]) => {
      const [vixBucket, session, pairCategory] = key.split('|') as [SLPattern['vixBucket'], SLPattern['session'], SLPattern['pairCategory']];
      return { vixBucket, session, pairCategory, slCount: v.sl, totalCount: v.total, slRate: v.total > 0 ? v.sl / v.total : 0 };
    })
    .filter(p => p.totalCount >= 3)  // サンプル数が少ないパターンは除外
    .sort((a, b) => b.slRate - a.slRate);
}

/** 検出力分析: 勝率(RR≥1.0)の差を統計的に検出するのに必要なサンプル数
 *  Cohen の方法: n = (z_α + z_β)^2 / (2 * arcsin(√p1) - 2 * arcsin(√p0))^2
 *  簡略化: p0=0.5（ランダム）、p1=目標勝率（例: 0.55）、α=0.05、β=0.2
 */
export function powerAnalysis(
  currentN: number,
  currentWins: number,
  targetWinRate = 0.55,
  baselineWinRate = 0.5,
  alpha = 0.05,
  power = 0.8,
): {
  requiredN: number;   // 必要サンプル数
  currentN: number;    // 現在のサンプル数
  currentWinRate: number;
  progressPct: number; // 達成率%
  isAdequate: boolean; // 十分なサンプルか
} {
  void alpha; void power; // 使用パラメータ（将来の拡張用）
  // arcsin 変換（アーキサイン変換）
  const arcsin = (p: number) => Math.asin(Math.sqrt(Math.max(0, Math.min(1, p))));
  const zAlpha = 1.645; // 片側 α=0.05
  const zBeta  = 0.842; // 検出力 80%
  const h = 2 * arcsin(Math.sqrt(targetWinRate)) - 2 * arcsin(Math.sqrt(baselineWinRate));
  const requiredN = h !== 0 ? Math.ceil((zAlpha + zBeta) ** 2 / h ** 2) : 9999;
  const currentWinRate = currentN > 0 ? currentWins / currentN : 0;
  return {
    requiredN,
    currentN,
    currentWinRate,
    progressPct: Math.min(100, (currentN / requiredN) * 100),
    isAdequate: currentN >= requiredN,
  };
}

/** マルコフ遷移行列（WIN/LOSE） */
export function markovTransition(outcomes: boolean[]): {
  ww: number; wl: number; lw: number; ll: number;
  streakProb3: number;
} {
  if (outcomes.length < 2) return { ww: 0, wl: 0, lw: 0, ll: 0, streakProb3: 0 };
  let ww = 0, wl = 0, lw = 0, ll = 0;
  for (let i = 1; i < outcomes.length; i++) {
    const prev = outcomes[i - 1];
    const curr = outcomes[i];
    if (prev && curr) ww++;
    else if (prev && !curr) wl++;
    else if (!prev && curr) lw++;
    else ll++;
  }
  const wTotal = ww + wl || 1;
  const lTotal = lw + ll || 1;
  const pLL = ll / lTotal;
  const streakProb3 = pLL * pLL; // 3連敗 ≈ P(L→L)^2
  return {
    ww: ww / wTotal, wl: wl / wTotal,
    lw: lw / lTotal, ll: pLL,
    streakProb3,
  };
}

/** EWMA（指数加重移動平均）ボラティリティ推定
 *  σ²_t = λ·σ²_{t-1} + (1-λ)·r²_{t-1}
 *  λ=0.94: RiskMetrics 標準値（長期依存度）
 *  O(n) 計算でCPU制限違反なし
 *
 *  注: 真のGARCH(1,1)より単純だが、Cloudflare Workers制約内で安定動作
 */
export function ewmaVolatility(
  logReturns: number[],
  lambda = 0.94,
): {
  sigma2: number;        // 現在の分散推定値
  sigmaAnnualized: number; // 年率換算ボラ%（1分足 → ×√525600）
  forecastSigma2: number; // 1期先予測分散
  isHighVol: boolean;    // 全体平均の1.5倍超
} {
  if (logReturns.length < 5) {
    return { sigma2: 0, sigmaAnnualized: 0, forecastSigma2: 0, isHighVol: false };
  }
  // 初期分散: 最初の5件の標本分散
  const init = logReturns.slice(0, 5);
  const initMean = init.reduce((s, v) => s + v, 0) / 5;
  let sigma2 = init.reduce((s, v) => s + (v - initMean) ** 2, 0) / 4;

  for (let i = 1; i < logReturns.length; i++) {
    sigma2 = lambda * sigma2 + (1 - lambda) * logReturns[i - 1] ** 2;
  }
  const forecastSigma2 = lambda * sigma2 + (1 - lambda) * (logReturns[logReturns.length - 1] ** 2);

  // 全体分散と比較して高ボラ判定
  const overallVar = logReturns.reduce((s, v) => s + v ** 2, 0) / logReturns.length;
  const isHighVol = overallVar > 0 ? sigma2 / overallVar > 1.5 : false;

  // 年率換算（1分足 × 525600分/年）
  const sigmaAnnualized = Math.sqrt(sigma2 * 525600) * 100;

  return { sigma2, sigmaAnnualized, forecastSigma2, isHighVol };
}

/** Engle-Granger 共和分検定（2変量）
 *  Step 1: y = a + b*x の OLS 回帰
 *  Step 2: 残差に ADF 検定（簡易版: 定常性の判定）
 *  注意: n < 200 の場合は信頼性なし（false 強制返却）
 */
export function engleGrangerCointegration(
  x: number[],
  y: number[],
): { residualADF: number; cointegrated: boolean; sampleN: number } {
  const n = Math.min(x.length, y.length);
  if (n < 200) return { residualADF: 0, cointegrated: false, sampleN: n };

  const xs = x.slice(0, n);
  const ys = y.slice(0, n);

  // OLS: b = Cov(x,y)/Var(x), a = mean(y) - b*mean(x)
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let covXY = 0, varX = 0;
  for (let i = 0; i < n; i++) {
    covXY += (xs[i] - mx) * (ys[i] - my);
    varX  += (xs[i] - mx) ** 2;
  }
  const b = varX > 0 ? covXY / varX : 0;
  const a = my - b * mx;

  // 残差
  const residuals = xs.map((xi, i) => ys[i] - (a + b * xi));

  // 簡易 ADF: Δe_t = γ * e_{t-1} + ε_t の OLS → γ が負に有意なら定常
  const deltaE = residuals.slice(1).map((v, i) => v - residuals[i]);
  const lagE   = residuals.slice(0, -1);
  const mLag   = lagE.reduce((s, v) => s + v, 0) / lagE.length;
  let covDE_lagE = 0, varLag = 0;
  for (let i = 0; i < deltaE.length; i++) {
    covDE_lagE += deltaE[i] * (lagE[i] - mLag);
    varLag     += (lagE[i] - mLag) ** 2;
  }
  const gamma = varLag > 0 ? covDE_lagE / varLag : 0;
  const residualADF = gamma; // 負で大きいほど定常（共和分あり）

  // ADF 臨界値（n≥200、5%有意水準）: 約 -2.86
  const cointegrated = gamma < -2.86;
  return { residualADF, cointegrated, sampleN: n };
}

/** 階層ベイズ勝率推定（勝ち=RR≥1.0）（Beta-Binomial 共役更新）
 *  プール推定を事前分布として使い、銘柄固有勝率を補正
 *  コールドスタート（データ少）の銘柄をプール平均に引き寄せる
 *
 *  更新式: α_i = α_prior + wins_i, β_i = β_prior + losses_i
 *  事後平均: α_i / (α_i + β_i)
 */
export function hierarchicalWinRate(
  pairData: Array<{ pair: string; wins: number; total: number }>,
): Array<{ pair: string; rawRate: number; bayesRate: number; n: number }> {
  if (pairData.length === 0) return [];

  const totalWins   = pairData.reduce((s, d) => s + d.wins, 0);
  const totalTrades = pairData.reduce((s, d) => s + d.total, 0);
  if (totalTrades === 0) return [];

  // ハイパーパラメータ（プール推定からの事前分布）
  const pooledRate = totalWins / totalTrades;
  // precision = 10: プールへの引き戻し強度（大きいほどプールに近づく）
  const precision = 10;
  const alphaPrior = pooledRate * precision;
  const betaPrior  = (1 - pooledRate) * precision;

  return pairData.map(d => {
    const alphaPost = alphaPrior + d.wins;
    const betaPost  = betaPrior  + (d.total - d.wins);
    const bayesRate = alphaPost / (alphaPost + betaPost);
    const rawRate   = d.total > 0 ? d.wins / d.total : pooledRate;
    return { pair: d.pair, rawRate, bayesRate, n: d.total };
  }).sort((a, b) => b.bayesRate - a.bayesRate);
}

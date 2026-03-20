// 統計計算モジュール（T003: 統計学的評価改善）
// Wilson CI, Sharpe SE, VaR/CVaR, Kelly基準, マルコフ遷移
// ローリングリターン, 最大DD%, 期間別パフォーマンス, PnLボラティリティ

/** Wilsonスコア区間（勝率の95%信頼区間） */
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
  initialBalance = 10000
): Record<number, { roi: number; sharpe: number; winRate: number; count: number }> {
  const result: Record<number, { roi: number; sharpe: number; winRate: number; count: number }> = {};
  for (const w of windows) {
    const slice = pnls.slice(-w);
    if (slice.length === 0) {
      result[w] = { roi: 0, sharpe: 0, winRate: 0, count: 0 };
      continue;
    }
    const sum = slice.reduce((s, v) => s + v, 0);
    const wins = slice.filter(v => v > 0).length;
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
  accuracy: number;       // 方向的中率（0〜1）
  brierScore: number;     // Brier Score（0=完璧, 0.5=ランダム, 1=最悪）
  n: number;              // 評価済みサンプル数
  wins: number;           // 的中数
} {
  const n = outcomes.length;
  if (n === 0) return { accuracy: 0, brierScore: 0.5, n: 0, wins: 0 };
  const wins = outcomes.filter(o => o === 'WIN').length;
  const accuracy = wins / n;
  const brierScore = 1 - accuracy; // 決定論的予測（f=1固定）のBrier Score
  return { accuracy, brierScore, n, wins };
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

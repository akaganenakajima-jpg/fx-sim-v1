// 1次元カルマンフィルタによる価格トレンド推定
// 状態: [level, trend]（レベルとトレンドの2成分）

export interface KalmanState {
  level: number;    // 推定レベル
  trend: number;    // 推定トレンド（正=上昇、負=下降）
  regime: 'trending' | 'ranging' | 'volatile';  // 市場レジーム
}

/**
 * Local Linear Trend カルマンフィルタ
 * 状態方程式: [level_t, trend_t] = F * [level_{t-1}, trend_{t-1}] + noise
 * 観測方程式: rate_t = level_t + obs_noise
 *
 * @param rates 価格系列（時系列順）
 * @param q     プロセスノイズ（大きいほど追従が速い）
 * @param r     観測ノイズ（大きいほど平滑化が強い）
 */
export function kalmanFilter(
  rates: number[],
  q = 0.001,
  r = 0.1,
): KalmanState {
  if (rates.length < 3) {
    return { level: rates[rates.length - 1] ?? 0, trend: 0, regime: 'ranging' };
  }

  let level = rates[0];
  let trend = 0;
  let P = [[1, 0], [0, 1]]; // 誤差共分散行列

  const F = [[1, 1], [0, 1]]; // 状態遷移行列
  const Q = [[q, 0], [0, q]]; // プロセスノイズ共分散
  const H = [1, 0];           // 観測行列

  for (let i = 1; i < rates.length; i++) {
    // 予測ステップ
    const predLevel = F[0][0] * level + F[0][1] * trend;
    const predTrend = F[1][0] * level + F[1][1] * trend;

    // 予測誤差共分散（簡略: 対角近似）
    const P00 = P[0][0] + P[0][1] + P[1][0] + P[1][1] + Q[0][0];
    const P11 = P[1][1] + Q[1][1];
    P = [[P00, P[0][1] + P[1][1]], [P[1][0] + P[1][1], P11]];

    // カルマンゲイン
    const S = H[0] * P[0][0] * H[0] + r;
    const K0 = S > 0 ? P[0][0] / S : 0;
    const K1 = S > 0 ? P[1][0] / S : 0;

    // 更新ステップ
    const innovation = rates[i] - predLevel;
    level = predLevel + K0 * innovation;
    trend = predTrend + K1 * innovation;

    P = [
      [P[0][0] * (1 - K0), P[0][1]],
      [P[1][0] * (1 - K1), P[1][1]],
    ];
  }

  // レジーム判定
  const absRateChange = Math.abs(rates[rates.length - 1] - rates[0]) / rates[0];
  const regime: KalmanState['regime'] =
    Math.abs(trend) > 0.001 ? 'trending' :
    absRateChange > 0.02 ? 'volatile' : 'ranging';

  return { level, trend, regime };
}

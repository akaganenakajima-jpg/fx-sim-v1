// Beta分布サンプリングによるトンプソン・サンプリング
// 探索(exploration) vs 活用(exploitation) のバランスを自動調整

/**
 * Beta(α, β) 分布からのサンプリング（Marsaglia-Tsang Gamma法）
 * α=1, β=1 が初期状態（一様事前分布）
 * WIN → α++、LOSE → β++ で事後分布を更新
 */
export function sampleBeta(alpha: number, beta: number): number {
  // Marsaglia-Tsang の GD アルゴリズムで Gamma(shape,1) サンプリング
  const sampleGamma = (shape: number): number => {
    if (shape < 1) {
      return sampleGamma(1 + shape) * Math.random() ** (1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x: number, v: number;
      do {
        // Box-Muller の代わりに CLT 近似（Cloudflare Workers はMath.random()のみ）
        x = (Math.random() + Math.random() + Math.random() +
             Math.random() + Math.random() + Math.random() - 3) / Math.sqrt(3);
        v = (1 + c * x) ** 3;
      } while (v <= 0);
      const u = Math.random();
      if (u < 1 - 0.0331 * (x ** 4)) return d * v;
      if (Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v;
    }
  };

  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

/** 銘柄のトンプソンスコアを計算
 *  DB の instrument_scores から alpha/beta を読んでサンプリング
 */
export async function getThompsonScore(
  db: D1Database,
  pair: string,
): Promise<number> {
  const row = await db.prepare(
    'SELECT thompson_alpha, thompson_beta FROM instrument_scores WHERE pair = ?'
  ).bind(pair).first<{ thompson_alpha: number; thompson_beta: number }>();
  const alpha = row?.thompson_alpha ?? 1;
  const beta  = row?.thompson_beta  ?? 1;
  return sampleBeta(alpha, beta);
}

/** ポジションクローズ後に thompson パラメータを更新
 *  WIN → alpha++、LOSE → beta++
 */
export async function updateThompsonParams(
  db: D1Database,
  pair: string,
  isWin: boolean,
): Promise<void> {
  await db.prepare(
    isWin
      ? 'UPDATE instrument_scores SET thompson_alpha = thompson_alpha + 1 WHERE pair = ?'
      : 'UPDATE instrument_scores SET thompson_beta  = thompson_beta  + 1 WHERE pair = ?'
  ).bind(pair).run();
}

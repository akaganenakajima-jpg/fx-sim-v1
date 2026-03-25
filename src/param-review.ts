// AIパラメーターレビューモジュール（Ph.4）
// 一定トレード数ごとにAIが instrument_params を調整しRR2.0以上を維持する
//
// 設計根拠:
//   kelly-rl.md §3: OGD逐次更新 — 取引結果でパラメーターを逐次最適化
//   kelly-rl.md §5.3: 統計的有意性 — シャープ比1.0で1500件必要だが
//                     実務的に30件以上で方向性を判断し小幅調整（±20%）
//   fx-strategy.md §2.2: 目標RR ≥ 2.0 → 勝率40%でもEV=+0.20

import { insertSystemLog } from './db';
import { RR_DEFINITION_PROMPT } from './gemini';
import type { InstrumentParamsRow } from './logic-indicators';

const REVIEW_PROMPT_VERSION = 'PARAM_REVIEW_v1';

// ─── レビュートリガー判定 ─────────────────────────────────────────────────

interface ReviewCandidate {
  pair: string;
  trades_since_review: number;
  review_trade_count: number;
  last_reviewed_at: string | null;
  param_version: number;
  totalHistoricalTrades: number;
}

/**
 * レビューが必要な銘柄を1件選んで返す。
 * 優先順位: trades_since_review が最も多い銘柄
 * トリガー条件:
 *   1. trades_since_review >= review_trade_count（トレード数ベース）
 *   2. last_reviewed_at IS NULL かつ totalHistoricalTrades >= 10（初回ブートストラップ）
 *   3. last_reviewed_at が 7日以上前かつ totalHistoricalTrades >= 10（時間ベース）
 */
export async function findPairNeedingReview(
  db: D1Database,
): Promise<ReviewCandidate | null> {
  const rows = await db
    .prepare(`SELECT * FROM instrument_params ORDER BY trades_since_review DESC`)
    .all<InstrumentParamsRow & { trades_since_review: number; review_trade_count: number; last_reviewed_at: string | null; param_version: number }>();

  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  for (const row of rows.results ?? []) {
    // 取引履歴件数を取得
    const countRow = await db
      .prepare(`SELECT COUNT(*) as cnt FROM positions WHERE pair = ? AND status = 'CLOSED' AND pnl IS NOT NULL`)
      .bind(row.pair)
      .first<{ cnt: number }>();
    const total = countRow?.cnt ?? 0;

    const isFirstReview = row.last_reviewed_at === null && total >= 10;
    const isCountTriggered = row.trades_since_review >= row.review_trade_count;
    const isTimeTriggered = row.last_reviewed_at !== null
      && (now - new Date(row.last_reviewed_at).getTime()) >= sevenDaysMs
      && total >= 10;

    if (isFirstReview || isCountTriggered || isTimeTriggered) {
      return { ...row, totalHistoricalTrades: total };
    }
  }
  return null;
}

// ─── 取引実績集計 ─────────────────────────────────────────────────────────

interface TradeStats {
  winRate: number;
  actualRr: number;
  profitFactor: number;
  maxLossStreak: number;
  totalTrades: number;
  recentTrades: Array<{ direction: string; pnl: number; close_reason: string; entry_rate: number }>;
}

async function calcTradeStats(db: D1Database, pair: string): Promise<TradeStats> {
  // 直近50件の決済済みポジション
  const trades = await db
    .prepare(
      `SELECT direction, pnl, close_reason, entry_rate, close_rate
       FROM positions
       WHERE pair = ? AND status = 'CLOSED' AND pnl IS NOT NULL
       ORDER BY closed_at DESC LIMIT 50`
    )
    .bind(pair)
    .all<{ direction: string; pnl: number; close_reason: string; entry_rate: number; close_rate: number }>();

  const rows = trades.results ?? [];
  if (rows.length === 0) {
    return { winRate: 0, actualRr: 0, profitFactor: 0, maxLossStreak: 0, totalTrades: 0, recentTrades: [] };
  }

  const wins  = rows.filter(r => r.pnl > 0);
  const losses = rows.filter(r => r.pnl <= 0);

  const winRate = wins.length / rows.length;
  const avgWin  = wins.length > 0 ? wins.reduce((s, r) => s + r.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, r) => s + r.pnl, 0) / losses.length) : 1;
  const actualRr = avgLoss > 0 ? avgWin / avgLoss : 0;
  const profitFactor = losses.length > 0
    ? wins.reduce((s, r) => s + r.pnl, 0) / Math.abs(losses.reduce((s, r) => s + r.pnl, 0))
    : wins.length > 0 ? 99 : 0;

  // 最大連敗
  let maxStreak = 0, streak = 0;
  for (const r of rows) {
    if (r.pnl <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); }
    else streak = 0;
  }

  return {
    winRate,
    actualRr,
    profitFactor,
    maxLossStreak: maxStreak,
    totalTrades: rows.length,
    recentTrades: rows.slice(0, 10).map(r => ({
      direction: r.direction,
      pnl: r.pnl,
      close_reason: r.close_reason,
      entry_rate: r.entry_rate,
    })),
  };
}

// ─── AIレビュープロンプト生成 ──────────────────────────────────────────────

function buildReviewPrompt(
  pair: string,
  params: InstrumentParamsRow,
  stats: TradeStats,
): string {
  const currentRr = (params.atr_tp_multiplier / params.atr_sl_multiplier).toFixed(2);
  const erThreshold = (params.adx_min / 60).toFixed(3);

  const recentTradeText = stats.recentTrades.map((t, i) =>
    `  ${i + 1}. ${t.direction} ${t.close_reason} PnL=${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(0)}円`
  ).join('\n');

  return [
    `あなたはアルゴリズムトレーディングのパラメーター最適化アナリストです。`,
    `${RR_DEFINITION_PROMPT}\n以下の実績データを分析し、RR_DEFINITION_PROMPT を踏まえ、RRの改善・最大化のためのパラメーター調整をJSONで返してください。`,
    ``,
    `【対象銘柄】${pair}`,
    `【現在パラメーター（基本）】`,
    `  RSI売られすぎ閾値: ${params.rsi_oversold}（RSI<この値でBUYシグナル）`,
    `  RSI買われすぎ閾値: ${params.rsi_overbought}（RSI>この値でSELLシグナル）`,
    `  ADX最低値: ${params.adx_min}（ER閾値=${erThreshold}に相当）`,
    `  ATR TP倍率: ${params.atr_tp_multiplier} / SL倍率: ${params.atr_sl_multiplier}`,
    `  現在パラメーターRR: ${currentRr}`,
    ``,
    `【現在パラメーター（拡張: VIX/マクロ/戦略）】`,
    `  vix_tp_scale: ${params.vix_tp_scale}（VIX>vix_max×0.7時のTP幅倍率、1.0=通常、<1.0=縮小）`,
    `  vix_sl_scale: ${params.vix_sl_scale}（VIX>vix_max×0.7時のSL幅倍率）`,
    `  strategy_primary: ${params.strategy_primary}（'mean_reversion'|'trend_follow'）`,
    `  min_signal_strength: ${params.min_signal_strength}（エントリー最低シグナル強度0〜1、RSI偏差+ER平均）`,
    `  macro_sl_scale: ${params.macro_sl_scale}（VIX>vix_max×0.5時のSL幅追加倍率）`,
    ``,
    `【現在パラメーター（エントリースコアリング重み）】`,
    `  w_rsi: ${params.w_rsi}（RSI偏差の重み）`,
    `  w_er: ${params.w_er}（ER/トレンド強度の重み）`,
    `  w_mtf: ${params.w_mtf}（マルチタイムフレーム整合性の重み）`,
    `  w_sr: ${params.w_sr}（サポレジ近接度の重み）`,
    `  w_pa: ${params.w_pa}（プライスアクションの重み）`,
    `  entry_score_min: ${params.entry_score_min}（エントリー最低スコア）`,
    `  min_rr_ratio: ${params.min_rr_ratio}（最小RR比）`,
    ``,
    `【現在パラメーター（ポジション管理 / セッション / レビュー設定）】`,
    `  max_hold_minutes: ${params.max_hold_minutes}（最大保有時間、分）`,
    `  cooldown_after_sl: ${params.cooldown_after_sl}（SL後クールダウン、分）`,
    `  consecutive_loss_shrink: ${params.consecutive_loss_shrink}（N連敗でロット50%縮小）`,
    `  daily_max_entries: ${params.daily_max_entries}（1日最大エントリー回数）`,
    `  trailing_activation_atr: ${params.trailing_activation_atr}（トレイリング開始ATR倍）`,
    `  trailing_distance_atr: ${params.trailing_distance_atr}（トレイリング追従ATR倍）`,
    `  tp1_ratio: ${params.tp1_ratio}（TP1分割決済比率、0.3〜0.7）`,
    `  session_start_utc: ${params.session_start_utc}（取引開始UTC時）`,
    `  session_end_utc: ${params.session_end_utc}（取引終了UTC時）`,
    `  review_min_trades: ${params.review_min_trades}（レビュー最低サンプル数）`,
    ``,
    `【現在パラメーター（基本テクニカル期間）】`,
    `  rsi_period: ${params.rsi_period}（RSI計算期間、10〜30）`,
    `  adx_period: ${params.adx_period}（ER計算期間、10〜30）`,
    `  atr_period: ${params.atr_period}（ATR計算期間、10〜30）`,
    ``,
    `【現在パラメーター（環境フィルター）】`,
    `  vix_max: ${params.vix_max}（VIX上限。超過で全スキップ、20〜60）`,
    `  require_trend_align: ${params.require_trend_align}（0=不要、1=上位足トレンド一致必須）`,
    `  regime_allow: ${params.regime_allow}（許可レジーム。'trending,ranging' / 'trending' / 'ranging' / 'trending,ranging,volatile'）`,
    ``,
    `【現在パラメーター（エントリー精度 / 環境検出）】`,
    `  bb_period: ${params.bb_period}（ボリンジャーバンド期間）`,
    `  bb_squeeze_threshold: ${params.bb_squeeze_threshold}（スクイーズ判定閾値）`,
    `  w_bb: ${params.w_bb}（BBスコアリング重み）`,
    `  w_div: ${params.w_div}（ダイバージェンススコアリング重み）`,
    `  divergence_lookback: ${params.divergence_lookback}（ダイバージェンス比較期間）`,
    `  min_confirm_signals: ${params.min_confirm_signals}（最低確認シグナル数）`,
    `  er_upper_limit: ${params.er_upper_limit}（mean_reversion時のER上限）`,
    ``,
    `【直近${stats.totalTrades}件の実績】`,
    `  勝率: ${(stats.winRate * 100).toFixed(1)}%`,
    `  実績RR（平均利益÷平均損失）: ${stats.actualRr.toFixed(2)}`,
    `  Profit Factor: ${stats.profitFactor.toFixed(2)}`,
    `  最大連敗: ${stats.maxLossStreak}`,
    ``,
    `【直近取引詳細（最大10件）】`,
    recentTradeText || '  (取引データなし)',
    ``,
    `【改善指針】`,
    `  - 実績RR < 2.0 → TPを広げる（atr_tp_multiplier増加）またはSLを狭める（atr_sl_multiplier減少）`,
    `  - 勝率 < 35% → RSI閾値を厳格化（oversoldを下げる / overboughtを上げる）`,
    `  - 連敗多発 → ADX閾値を上げてトレンド弱い場面をフィルター`,
    `  - VIX警戒時に損失多発 → vix_tp_scale/vix_sl_scaleを縮小（例: 0.8）`,
    `  - マクロストレス時に大損失 → macro_sl_scaleを縮小（例: 0.85）でSLを狭める`,
    `  - シグナル精度が低い → min_signal_strengthを引き上げる（例: 0.15〜0.25）`,
    `  - trend_followに変えたい → strategy_primaryを'trend_follow'に変更`,
    `  - 重みの最適化: 合計は1.0前後が望ましい。0にすると無視、0.5以上は最重要`,
    `  - mean_reversion戦略ではw_erを高め（ERが低い方が良い）`,
    `  - trend_follow戦略ではw_mtfを高め（上位足トレンド一致が重要）`,
    `  - RR比不足でスキップ多発 → min_rr_ratioを下げるかTP/SL倍率を調整`,
    `  - 指標期間の調整: 短い(10)=感度高・ダマシ多い、長い(20-30)=安定。標準14。大きく変える根拠がなければ維持推奨`,
    `  - VIX警戒時にスキップしすぎ → vix_maxを引き上げ。スキップ不足で損失多発 → vix_maxを引き下げ`,
    `  - トレンド反転で損失多い → require_trend_align=1でフィルター強化`,
    `  - レンジ相場で損失多い → regime_allowからrangingを除外`,
    ``,
    `【制約（必ず守ること）】`,
    `  - 各パラメーターの変更幅: 現在値の±20%以内`,
    `  - atr_tp_multiplier / atr_sl_multiplier ≥ 2.0 を維持`,
    `  - adx_min: 15〜35の範囲`,
    `  - rsi_oversold: 25〜45の範囲`,
    `  - rsi_overbought: 55〜75の範囲`,
    `  - atr_tp_multiplier: 2.0〜6.0の範囲`,
    `  - atr_sl_multiplier: 0.8〜3.0の範囲`,
    `  - vix_tp_scale: 0.5〜1.5の範囲`,
    `  - vix_sl_scale: 0.5〜1.5の範囲`,
    `  - macro_sl_scale: 0.5〜1.5の範囲`,
    `  - min_signal_strength: 0.0〜0.5の範囲`,
    `  - strategy_primary: 'mean_reversion' または 'trend_follow' のみ`,
    `  - w_rsi, w_er, w_mtf, w_sr, w_pa: 各0.0〜1.0の範囲`,
    `  - entry_score_min: 0.0〜1.0の範囲`,
    `  - min_rr_ratio: 1.0〜5.0の範囲`,
    `  - max_hold_minutes: 30〜1440の範囲`,
    `  - cooldown_after_sl: 0〜60の範囲`,
    `  - consecutive_loss_shrink: 0〜10の範囲（0=無効）`,
    `  - daily_max_entries: 1〜20の範囲`,
    `  - trailing_activation_atr: 0.5〜5.0の範囲`,
    `  - trailing_distance_atr: 0.3〜3.0の範囲`,
    `  - tp1_ratio: 0.2〜0.8の範囲`,
    `  - session_start_utc: 0〜23の範囲`,
    `  - session_end_utc: 1〜24の範囲`,
    `  - review_min_trades: 20〜200の範囲`,
    `  - bb_period: 10〜50の範囲`,
    `  - bb_squeeze_threshold: 0.1〜0.8の範囲`,
    `  - w_bb: 0.0〜1.0の範囲`,
    `  - w_div: 0.0〜1.0の範囲`,
    `  - divergence_lookback: 5〜30の範囲`,
    `  - min_confirm_signals: 0〜5の範囲`,
    `  - er_upper_limit: 0.5〜1.0の範囲`,
    `  - rsi_period: 10〜30の範囲（整数）`,
    `  - adx_period: 10〜30の範囲（整数）`,
    `  - atr_period: 10〜30の範囲（整数）`,
    `  - vix_max: 20〜60の範囲`,
    `  - require_trend_align: 0または1のみ`,
    `  - regime_allow: 'trending','ranging','volatile'の組み合わせ（カンマ区切り、最低1つ）`,
    ``,
    `以下のJSONのみで回答してください（説明文不要）:`,
    `{"pair":"${pair}","rsi_oversold":number,"rsi_overbought":number,"adx_min":number,"atr_tp_multiplier":number,"atr_sl_multiplier":number,"vix_tp_scale":number,"vix_sl_scale":number,"strategy_primary":"mean_reversion","min_signal_strength":number,"macro_sl_scale":number,"w_rsi":number,"w_er":number,"w_mtf":number,"w_sr":number,"w_pa":number,"w_bb":number,"w_div":number,"entry_score_min":number,"min_rr_ratio":number,"max_hold_minutes":number,"cooldown_after_sl":number,"consecutive_loss_shrink":number,"daily_max_entries":number,"trailing_activation_atr":number,"trailing_distance_atr":number,"tp1_ratio":number,"session_start_utc":number,"session_end_utc":number,"review_min_trades":number,"bb_period":number,"bb_squeeze_threshold":number,"divergence_lookback":number,"min_confirm_signals":number,"er_upper_limit":number,"rsi_period":14,"adx_period":14,"atr_period":14,"vix_max":35,"require_trend_align":0,"regime_allow":"trending,ranging","reason":"調整理由200文字以内","expected_rr":number}`,
  ].join('\n');
}

// ─── AIレスポンスバリデーション ────────────────────────────────────────────

interface ReviewResult {
  pair: string;
  rsi_oversold: number;
  rsi_overbought: number;
  adx_min: number;
  atr_tp_multiplier: number;
  atr_sl_multiplier: number;
  // Ph.6: 拡張ロジックパラメーター
  vix_tp_scale:        number;
  vix_sl_scale:        number;
  strategy_primary:    string;
  min_signal_strength: number;
  macro_sl_scale:      number;
  // Ph.7: エントリースコアリング重み
  w_rsi:           number;
  w_er:            number;
  w_mtf:           number;
  w_sr:            number;
  w_pa:            number;
  entry_score_min: number;
  min_rr_ratio:    number;
  // Ph.8: 金融理論ベース10パラメーター
  max_hold_minutes:        number;
  cooldown_after_sl:       number;
  consecutive_loss_shrink: number;
  daily_max_entries:       number;
  trailing_activation_atr: number;
  trailing_distance_atr:   number;
  tp1_ratio:               number;
  session_start_utc:       number;
  session_end_utc:         number;
  review_min_trades:       number;
  // Ph.9: エントリー精度パラメーター
  bb_period:              number;
  bb_squeeze_threshold:   number;
  w_bb:                   number;
  w_div:                  number;
  divergence_lookback:    number;
  min_confirm_signals:    number;
  er_upper_limit:         number;
  // Ph.10: 基本テクニカル期間 + 環境フィルター
  rsi_period:          number;
  adx_period:          number;
  atr_period:          number;
  vix_max:             number;
  require_trend_align: number;
  regime_allow:        string;
  reason: string;
  expected_rr: number;
}

function validateRegimeAllow(raw: string, current: string): string {
  const valid = ['trending', 'ranging', 'volatile'];
  const parts = raw.split(',').map(s => s.trim()).filter(s => valid.includes(s));
  return parts.length > 0 ? parts.join(',') : current;
}

function validateAndClamp(raw: ReviewResult, current: InstrumentParamsRow): ReviewResult {
  const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));
  const within20 = (val: number, base: number) => {
    const lo = base * 0.8, hi = base * 1.2;
    return clamp(val, lo, hi);
  };

  const tp  = clamp(within20(raw.atr_tp_multiplier,  current.atr_tp_multiplier),  2.0, 6.0);
  const sl  = clamp(within20(raw.atr_sl_multiplier,  current.atr_sl_multiplier),  0.8, 3.0);
  // RR不変条件: tp/sl >= 2.0
  const finalTp = tp / sl >= 2.0 ? tp : sl * 2.0;

  // strategy_primary は許可値のみ受け付ける
  const validStrategies = ['mean_reversion', 'trend_follow'];
  const strategyPrimary = validStrategies.includes(raw.strategy_primary)
    ? raw.strategy_primary
    : current.strategy_primary;

  return {
    pair: current.pair,
    rsi_oversold:        clamp(within20(raw.rsi_oversold,  current.rsi_oversold),  25, 45),
    rsi_overbought:      clamp(within20(raw.rsi_overbought, current.rsi_overbought), 55, 75),
    adx_min:             clamp(within20(raw.adx_min,        current.adx_min),        15, 35),
    atr_tp_multiplier:   parseFloat(finalTp.toFixed(2)),
    atr_sl_multiplier:   parseFloat(sl.toFixed(2)),
    // Ph.6: 拡張パラメーター（±20%クランプ + 絶対範囲クランプ）
    vix_tp_scale:        parseFloat(clamp(within20(raw.vix_tp_scale   ?? current.vix_tp_scale,   current.vix_tp_scale),   0.5, 1.5).toFixed(2)),
    vix_sl_scale:        parseFloat(clamp(within20(raw.vix_sl_scale   ?? current.vix_sl_scale,   current.vix_sl_scale),   0.5, 1.5).toFixed(2)),
    strategy_primary:    strategyPrimary,
    min_signal_strength: parseFloat(clamp(within20(raw.min_signal_strength ?? current.min_signal_strength, Math.max(0.01, current.min_signal_strength)), 0.0, 0.5).toFixed(3)),
    macro_sl_scale:      parseFloat(clamp(within20(raw.macro_sl_scale ?? current.macro_sl_scale, current.macro_sl_scale), 0.5, 1.5).toFixed(2)),
    // Ph.7: エントリースコアリング重み（±20%クランプ + 絶対範囲クランプ）
    w_rsi:           parseFloat(clamp(raw.w_rsi   ?? current.w_rsi,   0, 1).toFixed(2)),
    w_er:            parseFloat(clamp(raw.w_er    ?? current.w_er,    0, 1).toFixed(2)),
    w_mtf:           parseFloat(clamp(raw.w_mtf   ?? current.w_mtf,   0, 1).toFixed(2)),
    w_sr:            parseFloat(clamp(raw.w_sr    ?? current.w_sr,    0, 1).toFixed(2)),
    w_pa:            parseFloat(clamp(raw.w_pa    ?? current.w_pa,    0, 1).toFixed(2)),
    entry_score_min: parseFloat(clamp(raw.entry_score_min ?? current.entry_score_min, 0, 1).toFixed(2)),
    min_rr_ratio:    parseFloat(clamp(raw.min_rr_ratio    ?? current.min_rr_ratio,    1.0, 5.0).toFixed(2)),
    // Ph.8: 金融理論ベース10パラメーター
    max_hold_minutes:        clamp(raw.max_hold_minutes        ?? current.max_hold_minutes,        30, 1440),
    cooldown_after_sl:       clamp(raw.cooldown_after_sl       ?? current.cooldown_after_sl,        0,   60),
    consecutive_loss_shrink: clamp(raw.consecutive_loss_shrink ?? current.consecutive_loss_shrink,   0,   10),
    daily_max_entries:       clamp(raw.daily_max_entries       ?? current.daily_max_entries,          1,   20),
    trailing_activation_atr: parseFloat(clamp(raw.trailing_activation_atr ?? current.trailing_activation_atr, 0.5, 5.0).toFixed(2)),
    trailing_distance_atr:   parseFloat(clamp(raw.trailing_distance_atr   ?? current.trailing_distance_atr,   0.3, 3.0).toFixed(2)),
    tp1_ratio:               parseFloat(clamp(raw.tp1_ratio               ?? current.tp1_ratio,               0.2, 0.8).toFixed(2)),
    session_start_utc:       clamp(raw.session_start_utc       ?? current.session_start_utc,         0,   23),
    session_end_utc:         clamp(raw.session_end_utc         ?? current.session_end_utc,           1,   24),
    review_min_trades:       clamp(raw.review_min_trades       ?? current.review_min_trades,         20, 200),
    // Ph.9: エントリー精度パラメーター
    bb_period:              clamp(raw.bb_period              ?? current.bb_period,              10,   50),
    bb_squeeze_threshold:   parseFloat(clamp(raw.bb_squeeze_threshold ?? current.bb_squeeze_threshold, 0.1, 0.8).toFixed(2)),
    w_bb:                   parseFloat(clamp(raw.w_bb                ?? current.w_bb,                  0,   1).toFixed(2)),
    w_div:                  parseFloat(clamp(raw.w_div               ?? current.w_div,                 0,   1).toFixed(2)),
    divergence_lookback:    clamp(raw.divergence_lookback    ?? current.divergence_lookback,     5,   30),
    min_confirm_signals:    clamp(raw.min_confirm_signals    ?? current.min_confirm_signals,     0,    5),
    er_upper_limit:         parseFloat(clamp(raw.er_upper_limit      ?? current.er_upper_limit,        0.5, 1.0).toFixed(2)),
    // Ph.10: 基本テクニカル期間 + 環境フィルター
    rsi_period:          Math.round(clamp(within20(raw.rsi_period ?? current.rsi_period, current.rsi_period), 10, 30)),
    adx_period:          Math.round(clamp(within20(raw.adx_period ?? current.adx_period, current.adx_period), 10, 30)),
    atr_period:          Math.round(clamp(within20(raw.atr_period ?? current.atr_period, current.atr_period), 10, 30)),
    vix_max:             parseFloat(clamp(within20(raw.vix_max ?? current.vix_max, current.vix_max), 20, 60).toFixed(1)),
    require_trend_align: raw.require_trend_align === 1 ? 1 : 0,
    regime_allow:        validateRegimeAllow(raw.regime_allow ?? current.regime_allow, current.regime_allow),
    reason:              (raw.reason ?? '').slice(0, 200),
    expected_rr:         raw.expected_rr ?? (finalTp / sl),
  };
}

// ─── Gemini APIコール ──────────────────────────────────────────────────────

async function callGeminiForReview(
  prompt: string,
  apiKey: string,
): Promise<{ result: ReviewResult | null; errorCode?: number }> {
  const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent';
  try {
    const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { result: null, errorCode: res.status };
    const data = await res.json() as { candidates?: Array<{ content: { parts: Array<{ text: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { result: null };
    return { result: JSON.parse(text) as ReviewResult };
  } catch {
    return { result: null };
  }
}

// ─── GPT-4.1-mini フォールバック ──────────────────────────────────────────

async function callGptForReview(
  prompt: string,
  apiKey: string,
): Promise<ReviewResult | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message: { content: string } }> };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return null;
    return JSON.parse(text) as ReviewResult;
  } catch {
    return null;
  }
}

// ─── DBパラメーター更新 ────────────────────────────────────────────────────

async function applyReviewResult(
  db: D1Database,
  result: ReviewResult,
  current: InstrumentParamsRow,
  stats: TradeStats,
  reviewedBy: string,
): Promise<void> {
  const now = new Date().toISOString();
  const prevJson = JSON.stringify({
    rsi_oversold:        current.rsi_oversold,
    rsi_overbought:      current.rsi_overbought,
    adx_min:             current.adx_min,
    atr_tp_multiplier:   current.atr_tp_multiplier,
    atr_sl_multiplier:   current.atr_sl_multiplier,
    // Ph.6: 拡張パラメーター
    vix_tp_scale:        current.vix_tp_scale,
    vix_sl_scale:        current.vix_sl_scale,
    strategy_primary:    current.strategy_primary,
    min_signal_strength: current.min_signal_strength,
    macro_sl_scale:      current.macro_sl_scale,
    // Ph.7: エントリースコアリング重み
    w_rsi:           current.w_rsi,
    w_er:            current.w_er,
    w_mtf:           current.w_mtf,
    w_sr:            current.w_sr,
    w_pa:            current.w_pa,
    entry_score_min: current.entry_score_min,
    min_rr_ratio:    current.min_rr_ratio,
    // Ph.8: 金融理論ベース10パラメーター
    max_hold_minutes:        current.max_hold_minutes,
    cooldown_after_sl:       current.cooldown_after_sl,
    consecutive_loss_shrink: current.consecutive_loss_shrink,
    daily_max_entries:       current.daily_max_entries,
    trailing_activation_atr: current.trailing_activation_atr,
    trailing_distance_atr:   current.trailing_distance_atr,
    tp1_ratio:               current.tp1_ratio,
    session_start_utc:       current.session_start_utc,
    session_end_utc:         current.session_end_utc,
    review_min_trades:       current.review_min_trades,
    // Ph.9: エントリー精度パラメーター
    bb_period:              current.bb_period,
    bb_squeeze_threshold:   current.bb_squeeze_threshold,
    w_bb:                   current.w_bb,
    w_div:                  current.w_div,
    divergence_lookback:    current.divergence_lookback,
    min_confirm_signals:    current.min_confirm_signals,
    er_upper_limit:         current.er_upper_limit,
    // Ph.10: 基本テクニカル期間 + 環境フィルター
    rsi_period:          current.rsi_period,
    adx_period:          current.adx_period,
    atr_period:          current.atr_period,
    vix_max:             current.vix_max,
    require_trend_align: current.require_trend_align,
    regime_allow:        current.regime_allow,
  });

  // instrument_params 更新（拡張5カラム + Ph.7 スコアリング7カラム + Ph.8 10カラム + Ph.9 7カラムを含む）
  await db
    .prepare(
      `UPDATE instrument_params
       SET rsi_oversold          = ?,
           rsi_overbought        = ?,
           adx_min               = ?,
           atr_tp_multiplier     = ?,
           atr_sl_multiplier     = ?,
           vix_tp_scale          = ?,
           vix_sl_scale          = ?,
           strategy_primary      = ?,
           min_signal_strength   = ?,
           macro_sl_scale        = ?,
           w_rsi                 = ?,
           w_er                  = ?,
           w_mtf                 = ?,
           w_sr                  = ?,
           w_pa                  = ?,
           entry_score_min       = ?,
           min_rr_ratio          = ?,
           max_hold_minutes      = ?,
           cooldown_after_sl     = ?,
           consecutive_loss_shrink = ?,
           daily_max_entries     = ?,
           trailing_activation_atr = ?,
           trailing_distance_atr = ?,
           tp1_ratio             = ?,
           session_start_utc     = ?,
           session_end_utc       = ?,
           review_min_trades     = ?,
           bb_period             = ?,
           bb_squeeze_threshold  = ?,
           w_bb                  = ?,
           w_div                 = ?,
           divergence_lookback   = ?,
           min_confirm_signals   = ?,
           er_upper_limit        = ?,
           rsi_period            = ?,
           adx_period            = ?,
           atr_period            = ?,
           vix_max               = ?,
           require_trend_align   = ?,
           regime_allow          = ?,
           trades_since_review   = 0,
           param_version         = param_version + 1,
           reviewed_by           = ?,
           last_reviewed_at      = ?,
           prev_params_json      = ?,
           updated_at            = ?
       WHERE pair = ?`
    )
    .bind(
      result.rsi_oversold,
      result.rsi_overbought,
      result.adx_min,
      result.atr_tp_multiplier,
      result.atr_sl_multiplier,
      result.vix_tp_scale,
      result.vix_sl_scale,
      result.strategy_primary,
      result.min_signal_strength,
      result.macro_sl_scale,
      result.w_rsi,
      result.w_er,
      result.w_mtf,
      result.w_sr,
      result.w_pa,
      result.entry_score_min,
      result.min_rr_ratio,
      result.max_hold_minutes,
      result.cooldown_after_sl,
      result.consecutive_loss_shrink,
      result.daily_max_entries,
      result.trailing_activation_atr,
      result.trailing_distance_atr,
      result.tp1_ratio,
      result.session_start_utc,
      result.session_end_utc,
      result.review_min_trades,
      result.bb_period,
      result.bb_squeeze_threshold,
      result.w_bb,
      result.w_div,
      result.divergence_lookback,
      result.min_confirm_signals,
      result.er_upper_limit,
      result.rsi_period,
      result.adx_period,
      result.atr_period,
      result.vix_max,
      result.require_trend_align,
      result.regime_allow,
      reviewedBy,
      now,
      prevJson,
      now,
      result.pair,
    )
    .run();

  const newJson = JSON.stringify({
    rsi_oversold:        result.rsi_oversold,
    rsi_overbought:      result.rsi_overbought,
    adx_min:             result.adx_min,
    atr_tp_multiplier:   result.atr_tp_multiplier,
    atr_sl_multiplier:   result.atr_sl_multiplier,
    // Ph.6: 拡張パラメーター
    vix_tp_scale:        result.vix_tp_scale,
    vix_sl_scale:        result.vix_sl_scale,
    strategy_primary:    result.strategy_primary,
    min_signal_strength: result.min_signal_strength,
    macro_sl_scale:      result.macro_sl_scale,
    // Ph.7: エントリースコアリング重み
    w_rsi:           result.w_rsi,
    w_er:            result.w_er,
    w_mtf:           result.w_mtf,
    w_sr:            result.w_sr,
    w_pa:            result.w_pa,
    entry_score_min: result.entry_score_min,
    min_rr_ratio:    result.min_rr_ratio,
    // Ph.8: 金融理論ベース10パラメーター
    max_hold_minutes:        result.max_hold_minutes,
    cooldown_after_sl:       result.cooldown_after_sl,
    consecutive_loss_shrink: result.consecutive_loss_shrink,
    daily_max_entries:       result.daily_max_entries,
    trailing_activation_atr: result.trailing_activation_atr,
    trailing_distance_atr:   result.trailing_distance_atr,
    tp1_ratio:               result.tp1_ratio,
    session_start_utc:       result.session_start_utc,
    session_end_utc:         result.session_end_utc,
    review_min_trades:       result.review_min_trades,
    // Ph.9: エントリー精度パラメーター
    bb_period:              result.bb_period,
    bb_squeeze_threshold:   result.bb_squeeze_threshold,
    w_bb:                   result.w_bb,
    w_div:                  result.w_div,
    divergence_lookback:    result.divergence_lookback,
    min_confirm_signals:    result.min_confirm_signals,
    er_upper_limit:         result.er_upper_limit,
    // Ph.10: 基本テクニカル期間 + 環境フィルター
    rsi_period:          result.rsi_period,
    adx_period:          result.adx_period,
    atr_period:          result.atr_period,
    vix_max:             result.vix_max,
    require_trend_align: result.require_trend_align,
    regime_allow:        result.regime_allow,
  });

  // param_review_log に記録
  await db
    .prepare(
      `INSERT INTO param_review_log
         (pair, param_version, old_params, new_params, reason,
          trades_eval, win_rate, actual_rr, profit_factor, reviewed_by, created_at)
       VALUES (?, (SELECT param_version FROM instrument_params WHERE pair = ?),
               ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      result.pair,
      result.pair,
      prevJson,
      newJson,
      result.reason,
      stats.totalTrades,
      stats.winRate,
      stats.actualRr,
      stats.profitFactor,
      reviewedBy,
      now,
    )
    .run();
}

// ─── メイン: パラメーターレビュー実行 ────────────────────────────────────

export async function runParamReview(
  db: D1Database,
  geminiApiKey: string,
  openaiApiKey?: string,
): Promise<{ reviewed: boolean; pair?: string; summary?: string }> {
  // レビューが必要な銘柄を1件取得（cron 1回に1銘柄ずつ処理）
  const candidate = await findPairNeedingReview(db);
  if (!candidate) return { reviewed: false };

  const { pair } = candidate;

  // パラメーター読み込み
  const paramsRow = await db
    .prepare(`SELECT * FROM instrument_params WHERE pair = ?`)
    .bind(pair)
    .first<InstrumentParamsRow>();
  if (!paramsRow) return { reviewed: false };

  // 取引実績集計
  const stats = await calcTradeStats(db, pair);
  if (stats.totalTrades < 10) return { reviewed: false };

  // AIレビュープロンプト生成・呼び出し（Gemini → GPT フォールバック）
  const prompt = buildReviewPrompt(pair, paramsRow, stats);
  const geminiResponse = await callGeminiForReview(prompt, geminiApiKey);

  let rawResult: ReviewResult | null = geminiResponse.result;
  let reviewedBy = REVIEW_PROMPT_VERSION;

  if (!rawResult) {
    await insertSystemLog(db, 'WARN', 'PARAM_REVIEW',
      `Geminiレビュー失敗: ${pair}`,
      `errorCode=${geminiResponse.errorCode ?? 'timeout/parse'} → GPTフォールバック試行`);

    if (openaiApiKey) {
      rawResult = await callGptForReview(prompt, openaiApiKey);
      if (rawResult) {
        reviewedBy = `${REVIEW_PROMPT_VERSION}_GPT`;
      }
    }
  }

  if (!rawResult) {
    await insertSystemLog(db, 'WARN', 'PARAM_REVIEW',
      `AIレビュー全失敗: ${pair}`, 'Gemini/GPT両方応答なし');
    return { reviewed: false };
  }

  // バリデーション・クランプ
  const validated = validateAndClamp(rawResult, paramsRow);

  // DB更新
  await applyReviewResult(db, validated, paramsRow, stats, reviewedBy);

  const summary = `RR ${(paramsRow.atr_tp_multiplier / paramsRow.atr_sl_multiplier).toFixed(2)}→${(validated.atr_tp_multiplier / validated.atr_sl_multiplier).toFixed(2)} | ${validated.reason.slice(0, 80)}`;

  await insertSystemLog(db, 'INFO', 'PARAM_REVIEW',
    `パラメーター更新: ${pair} (v${candidate.param_version}→${candidate.param_version + 1})`,
    JSON.stringify({
      trades: stats.totalTrades,
      winRate: (stats.winRate * 100).toFixed(1) + '%',
      actualRr: stats.actualRr.toFixed(2),
      pf: stats.profitFactor.toFixed(2),
      changes: {
        rsi_oversold:        `${paramsRow.rsi_oversold}→${validated.rsi_oversold}`,
        rsi_overbought:      `${paramsRow.rsi_overbought}→${validated.rsi_overbought}`,
        adx_min:             `${paramsRow.adx_min}→${validated.adx_min}`,
        atr_tp_multiplier:   `${paramsRow.atr_tp_multiplier}→${validated.atr_tp_multiplier}`,
        atr_sl_multiplier:   `${paramsRow.atr_sl_multiplier}→${validated.atr_sl_multiplier}`,
        vix_tp_scale:        `${paramsRow.vix_tp_scale}→${validated.vix_tp_scale}`,
        vix_sl_scale:        `${paramsRow.vix_sl_scale}→${validated.vix_sl_scale}`,
        strategy_primary:    `${paramsRow.strategy_primary}→${validated.strategy_primary}`,
        min_signal_strength: `${paramsRow.min_signal_strength}→${validated.min_signal_strength}`,
        macro_sl_scale:      `${paramsRow.macro_sl_scale}→${validated.macro_sl_scale}`,
        w_rsi:               `${paramsRow.w_rsi}→${validated.w_rsi}`,
        w_er:                `${paramsRow.w_er}→${validated.w_er}`,
        w_mtf:               `${paramsRow.w_mtf}→${validated.w_mtf}`,
        w_sr:                `${paramsRow.w_sr}→${validated.w_sr}`,
        w_pa:                `${paramsRow.w_pa}→${validated.w_pa}`,
        entry_score_min:     `${paramsRow.entry_score_min}→${validated.entry_score_min}`,
        min_rr_ratio:        `${paramsRow.min_rr_ratio}→${validated.min_rr_ratio}`,
        max_hold_minutes:    `${paramsRow.max_hold_minutes}→${validated.max_hold_minutes}`,
        cooldown_after_sl:   `${paramsRow.cooldown_after_sl}→${validated.cooldown_after_sl}`,
        consecutive_loss_shrink: `${paramsRow.consecutive_loss_shrink}→${validated.consecutive_loss_shrink}`,
        daily_max_entries:   `${paramsRow.daily_max_entries}→${validated.daily_max_entries}`,
        tp1_ratio:           `${paramsRow.tp1_ratio}→${validated.tp1_ratio}`,
        session_start_utc:   `${paramsRow.session_start_utc}→${validated.session_start_utc}`,
        session_end_utc:     `${paramsRow.session_end_utc}→${validated.session_end_utc}`,
        review_min_trades:   `${paramsRow.review_min_trades}→${validated.review_min_trades}`,
        bb_period:           `${paramsRow.bb_period}→${validated.bb_period}`,
        bb_squeeze_threshold:`${paramsRow.bb_squeeze_threshold}→${validated.bb_squeeze_threshold}`,
        w_bb:                `${paramsRow.w_bb}→${validated.w_bb}`,
        w_div:               `${paramsRow.w_div}→${validated.w_div}`,
        divergence_lookback: `${paramsRow.divergence_lookback}→${validated.divergence_lookback}`,
        min_confirm_signals: `${paramsRow.min_confirm_signals}→${validated.min_confirm_signals}`,
        er_upper_limit:      `${paramsRow.er_upper_limit}→${validated.er_upper_limit}`,
        rsi_period:          `${paramsRow.rsi_period}→${validated.rsi_period}`,
        adx_period:          `${paramsRow.adx_period}→${validated.adx_period}`,
        atr_period:          `${paramsRow.atr_period}→${validated.atr_period}`,
        vix_max:             `${paramsRow.vix_max}→${validated.vix_max}`,
        require_trend_align: `${paramsRow.require_trend_align}→${validated.require_trend_align}`,
        regime_allow:        `${paramsRow.regime_allow}→${validated.regime_allow}`,
      },
      reason: validated.reason,
    }));

  return { reviewed: true, pair, summary };
}

// AIパラメーターレビューモジュール（Ph.4）
// 一定トレード数ごとにAIが instrument_params を調整しRR2.0以上を維持する
//
// 設計根拠:
//   kelly-rl.md §3: OGD逐次更新 — 取引結果でパラメーターを逐次最適化
//   kelly-rl.md §5.3: 統計的有意性 — シャープ比1.0で1500件必要だが
//                     実務的に30件以上で方向性を判断し小幅調整（±20%）
//   fx-strategy.md §2.2: 目標RR ≥ 2.0 → 勝率40%でもEV=+0.20

import { insertSystemLog, getCacheValue, setCacheValue } from './db';
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
 * 除外条件:
 *   - excludedPairs に含まれる銘柄（Tier D等、取引頻度が低く最適化コスト対効果が低い）
 *   - 直近のレビュー失敗後クールダウン中の銘柄（market_cache: param_review_cd:{pair}）
 */
export async function findPairNeedingReview(
  db: D1Database,
  excludedPairs?: string[],
): Promise<ReviewCandidate | null> {
  const rows = await db
    .prepare(`SELECT * FROM instrument_params ORDER BY trades_since_review DESC`)
    .all<InstrumentParamsRow & { trades_since_review: number; review_trade_count: number; last_reviewed_at: string | null; param_version: number }>();

  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  for (const row of rows.results ?? []) {
    // Tier D等の除外銘柄はスキップ（最適化コスト対効果が低い）
    if (excludedPairs?.includes(row.pair)) continue;

    // DB永続クールダウンチェック（429等AI失敗後4h再試行しない）
    const cdVal = await getCacheValue(db, `param_review_cd:${row.pair}`);
    if (cdVal && new Date(cdVal).getTime() > now) continue;

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
  // 直近20件の決済済みポジション（CPU予算削減: Workers 15s制限対応）
  const trades = await db
    .prepare(
      `SELECT direction, pnl, close_reason, entry_rate, close_rate, realized_rr
       FROM positions
       WHERE pair = ? AND status = 'CLOSED' AND pnl IS NOT NULL
       ORDER BY closed_at DESC LIMIT 20`
    )
    .bind(pair)
    .all<{ direction: string; pnl: number; close_reason: string; entry_rate: number; close_rate: number; realized_rr: number | null }>();

  const rows = trades.results ?? [];
  if (rows.length === 0) {
    return { winRate: 0, actualRr: 0, profitFactor: 0, maxLossStreak: 0, totalTrades: 0, recentTrades: [] };
  }

  // RR≥1.0 = 勝ち（プロジェクト統一定義）
  const wins  = rows.filter(r => (r.realized_rr ?? 0) >= 1.0);
  const losses = rows.filter(r => (r.realized_rr ?? 0) < 1.0);

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
    if ((r.realized_rr ?? 0) < 1.0) { streak++; maxStreak = Math.max(maxStreak, streak); }
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

  const recentTradeText = stats.recentTrades.map((t, i) =>
    `  ${i + 1}. ${t.direction} ${t.close_reason} PnL=${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(0)}円`
  ).join('\n');

  // 調整対象9項目のみ提示（それ以外はシステム側で現在値を維持）
  return [
    `あなたはアルゴリズムトレーディングのパラメーター最適化アナリストです。`,
    `${RR_DEFINITION_PROMPT}`,
    `以下の実績を分析し、RR最大化のためにパラメーター調整案をJSONで返してください。`,
    ``,
    `【対象銘柄】${pair}`,
    ``,
    `【調整対象パラメーター（9項目のみ回答）】`,
    `  atr_tp_multiplier: ${params.atr_tp_multiplier}（ATR TP倍率、2.0〜6.0）`,
    `  atr_sl_multiplier: ${params.atr_sl_multiplier}（ATR SL倍率、0.8〜3.0）`,
    `  現在RR比: ${currentRr}`,
    `  rsi_oversold: ${params.rsi_oversold}（RSI<この値でBUYシグナル、25〜45）`,
    `  rsi_overbought: ${params.rsi_overbought}（RSI>この値でSELLシグナル、55〜75）`,
    `  adx_min: ${params.adx_min}（ADX最低値、15〜35）`,
    `  min_signal_strength: ${params.min_signal_strength}（エントリー最低シグナル強度、0.0〜0.5）`,
    `  entry_score_min: ${params.entry_score_min}（エントリー最低スコア、0.0〜1.0）`,
    `  vix_tp_scale: ${params.vix_tp_scale}（VIX警戒時TP幅倍率、0.5〜1.5）`,
    `  vix_sl_scale: ${params.vix_sl_scale}（VIX警戒時SL幅倍率、0.5〜1.5）`,
    ``,
    `【直近${stats.totalTrades}件の実績】`,
    `  勝率(RR≥1.0): ${(stats.winRate * 100).toFixed(1)}%`,
    `  実績RR: ${stats.actualRr.toFixed(2)}`,
    `  Profit Factor: ${stats.profitFactor.toFixed(2)}`,
    `  最大連敗: ${stats.maxLossStreak}`,
    ``,
    `【直近取引（最大10件）】`,
    recentTradeText || '  (取引データなし)',
    ``,
    `【改善指針】`,
    `  - 実績RR < 2.0 → atr_tp_multiplier増加 or atr_sl_multiplier減少`,
    `  - 勝率 < 35% → rsi_oversold引き下げ / rsi_overbought引き上げ`,
    `  - 連敗多発 → adx_min引き上げ（弱トレンドをフィルター）`,
    `  - VIX警戒時に損失多発 → vix_tp_scale/vix_sl_scaleを0.8〜0.9に縮小`,
    `  - シグナル精度低下 → min_signal_strengthを0.1〜0.2に引き上げ`,
    ``,
    `【制約】`,
    `  - 各値は現在値の±20%以内かつ上記範囲内`,
    `  - atr_tp_multiplier / atr_sl_multiplier ≥ 2.0 を維持`,
    ``,
    `以下のJSONのみで回答（説明文不要）:`,
    `{"pair":"${pair}","atr_tp_multiplier":number,"atr_sl_multiplier":number,"rsi_oversold":number,"rsi_overbought":number,"adx_min":number,"min_signal_strength":number,"entry_score_min":number,"vix_tp_scale":number,"vix_sl_scale":number,"reason":"調整理由100文字以内","expected_rr":number}`,
  ].join('\n');
}

// ─── AIレスポンスバリデーション ────────────────────────────────────────────

// AIが返却する調整対象9項目のみ（その他パラメーターはシステム側で現在値を維持）
interface ReviewResult {
  pair: string;
  atr_tp_multiplier:   number;
  atr_sl_multiplier:   number;
  rsi_oversold:        number;
  rsi_overbought:      number;
  adx_min:             number;
  min_signal_strength: number;
  entry_score_min:     number;
  vix_tp_scale:        number;
  vix_sl_scale:        number;
  reason:      string;
  expected_rr: number;
}


// validateAndClampはAIが返却した9項目のみクランプし、
// それ以外のパラメーターはすべて current（現在値）をそのまま引き継ぐ
function validateAndClamp(raw: ReviewResult, current: InstrumentParamsRow): ReviewResult {
  const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));
  const within20 = (val: number, base: number) => clamp(val, base * 0.8, base * 1.2);

  const tp = clamp(within20(raw.atr_tp_multiplier ?? current.atr_tp_multiplier, current.atr_tp_multiplier), 2.0, 6.0);
  const sl = clamp(within20(raw.atr_sl_multiplier ?? current.atr_sl_multiplier, current.atr_sl_multiplier), 0.8, 3.0);
  // RR不変条件: tp/sl >= 2.0
  const finalTp = tp / sl >= 2.0 ? tp : sl * 2.0;

  return {
    pair: current.pair,
    // ─ AI調整対象9項目（クランプ）
    atr_tp_multiplier:   parseFloat(finalTp.toFixed(2)),
    atr_sl_multiplier:   parseFloat(sl.toFixed(2)),
    rsi_oversold:        clamp(within20(raw.rsi_oversold  ?? current.rsi_oversold,  current.rsi_oversold),  25, 45),
    rsi_overbought:      clamp(within20(raw.rsi_overbought ?? current.rsi_overbought, current.rsi_overbought), 55, 75),
    adx_min:             clamp(within20(raw.adx_min        ?? current.adx_min,        current.adx_min),        15, 35),
    min_signal_strength: parseFloat(clamp(within20(raw.min_signal_strength ?? current.min_signal_strength, Math.max(0.01, current.min_signal_strength)), 0.0, 0.5).toFixed(3)),
    entry_score_min:     parseFloat(clamp(raw.entry_score_min ?? current.entry_score_min, 0, 1).toFixed(2)),
    vix_tp_scale:        parseFloat(clamp(within20(raw.vix_tp_scale ?? current.vix_tp_scale, current.vix_tp_scale), 0.5, 1.5).toFixed(2)),
    vix_sl_scale:        parseFloat(clamp(within20(raw.vix_sl_scale ?? current.vix_sl_scale, current.vix_sl_scale), 0.5, 1.5).toFixed(2)),
    reason:      (raw.reason ?? '').slice(0, 200),
    expected_rr: raw.expected_rr ?? (finalTp / sl),
  };
}

// applyReviewResult が必要とする全フィールドをフラットに返すビルダー
// validateAndClamp の結果（9項目）+ currentの残りフィールドをマージする
function buildFullParams(
  validated: ReviewResult,
  current: InstrumentParamsRow,
): InstrumentParamsRow & ReviewResult {
  return {
    ...current,
    ...validated,
  };
}

// ─── Gemini APIコール ──────────────────────────────────────────────────────

async function callGeminiForReview(
  prompt: string,
  apiKey: string,
): Promise<{ result: ReviewResult | null; errorCode?: number }> {
  const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  try {
    const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(12000),
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
      signal: AbortSignal.timeout(10000),
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

type FullReviewResult = InstrumentParamsRow & ReviewResult;

async function applyReviewResult(
  db: D1Database,
  result: FullReviewResult,
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
  excludedPairs?: string[],
): Promise<{ reviewed: boolean; pair?: string; summary?: string }> {
  // レビューが必要な銘柄を1件取得（cron 1回に1銘柄ずつ処理）
  const candidate = await findPairNeedingReview(db, excludedPairs);
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
    // DB永続クールダウンを設定（24時間後まで再試行しない）
    // Worker再起動後もD1に保存されているため429ループを防止できる
    const retryAfter = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await setCacheValue(db, `param_review_cd:${pair}`, retryAfter);
    await insertSystemLog(db, 'WARN', 'PARAM_REVIEW',
      `AIレビュー全失敗: ${pair}`, `Gemini/GPT両方応答なし → 24h CDセット(${retryAfter}まで)`);
    return { reviewed: false };
  }

  // バリデーション・クランプ
  const validated = validateAndClamp(rawResult, paramsRow);

  // validated(9項目) + current(残り全フィールド) をマージしてDB更新
  const fullResult = buildFullParams(validated, paramsRow);
  await applyReviewResult(db, fullResult, paramsRow, stats, reviewedBy);

  const summary = `RR ${(paramsRow.atr_tp_multiplier / paramsRow.atr_sl_multiplier).toFixed(2)}→${(fullResult.atr_tp_multiplier / fullResult.atr_sl_multiplier).toFixed(2)} | ${fullResult.reason.slice(0, 80)}`;

  await insertSystemLog(db, 'INFO', 'PARAM_REVIEW',
    `パラメーター更新: ${pair} (v${candidate.param_version}→${candidate.param_version + 1})`,
    JSON.stringify({
      trades: stats.totalTrades,
      winRate: (stats.winRate * 100).toFixed(1) + '%',
      actualRr: stats.actualRr.toFixed(2),
      pf: stats.profitFactor.toFixed(2),
      changes: {
        atr_tp_multiplier:   `${paramsRow.atr_tp_multiplier}→${fullResult.atr_tp_multiplier}`,
        atr_sl_multiplier:   `${paramsRow.atr_sl_multiplier}→${fullResult.atr_sl_multiplier}`,
        rsi_oversold:        `${paramsRow.rsi_oversold}→${fullResult.rsi_oversold}`,
        rsi_overbought:      `${paramsRow.rsi_overbought}→${fullResult.rsi_overbought}`,
        adx_min:             `${paramsRow.adx_min}→${fullResult.adx_min}`,
        min_signal_strength: `${paramsRow.min_signal_strength}→${fullResult.min_signal_strength}`,
        entry_score_min:     `${paramsRow.entry_score_min}→${fullResult.entry_score_min}`,
        vix_tp_scale:        `${paramsRow.vix_tp_scale}→${fullResult.vix_tp_scale}`,
        vix_sl_scale:        `${paramsRow.vix_sl_scale}→${fullResult.vix_sl_scale}`,
      },
      reason: fullResult.reason,
    }));

  return { reviewed: true, pair, summary };
}

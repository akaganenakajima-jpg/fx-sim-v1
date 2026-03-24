// AIパラメーターレビューモジュール（Ph.4）
// 一定トレード数ごとにAIが instrument_params を調整しRR2.0以上を維持する
//
// 設計根拠:
//   kelly-rl.md §3: OGD逐次更新 — 取引結果でパラメーターを逐次最適化
//   kelly-rl.md §5.3: 統計的有意性 — シャープ比1.0で1500件必要だが
//                     実務的に30件以上で方向性を判断し小幅調整（±20%）
//   fx-strategy.md §2.2: 目標RR ≥ 2.0 → 勝率40%でもEV=+0.20

import { insertSystemLog } from './db';
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
    `以下の実績データを分析し、RR2.0以上を達成するためのパラメーター調整をJSONで返してください。`,
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
    ``,
    `以下のJSONのみで回答してください（説明文不要）:`,
    `{"pair":"${pair}","rsi_oversold":number,"rsi_overbought":number,"adx_min":number,"atr_tp_multiplier":number,"atr_sl_multiplier":number,"vix_tp_scale":number,"vix_sl_scale":number,"strategy_primary":"mean_reversion","min_signal_strength":number,"macro_sl_scale":number,"reason":"調整理由200文字以内","expected_rr":number}`,
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
  reason: string;
  expected_rr: number;
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
  });

  // instrument_params 更新（拡張5カラムを含む）
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
      },
      reason: validated.reason,
    }));

  return { reviewed: true, pair, summary };
}

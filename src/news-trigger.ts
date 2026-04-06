// ニューストリガーモジュール（Ph.5）
// 高スコアニュースを検出し2種のアクションを起動する:
//   EMERGENCY     → PATH_B強制発火（market_cacheにフラグをセット）
//   TREND_INFLUENCE → Gemini Flashが期限付き臨時パラメーターを生成（news_temp_params）
//
// 設計根拠:
//   fx-strategy.md §2.1: ニュース駆動相場ではロジックパラメーターが無効化される
//   fx-strategy.md §2.3: 緊急局面でのAI完全裁量エントリーが期待値を最大化
//   stats/ts.md §2: イベントスタディ — 突発ニュース後の価格インパクトは60〜120分で収束

import { insertSystemLog, setCacheValue } from './db';
import {
  NEWS_SCORE_EMERGENCY,
  NEWS_SCORE_TREND,
  NEWS_TRIGGER_EMERGENCY_RELEVANCE,
  NEWS_TRIGGER_EMERGENCY_SENTIMENT,
  NEWS_TRIGGER_TREND_RELEVANCE,
  NEWS_TRIGGER_TREND_SENTIMENT,
} from './constants';

// ─── 緊急判定キーワード ────────────────────────────────────────────────────
// これらが含まれかつスコアが高い場合はEMERGENCYとして扱う
const EMERGENCY_KEYWORDS = [
  '介入', 'intervention', 'emergency rate', '緊急利上げ', '緊急利下げ',
  'FOMC緊急', '日銀緊急', 'BOJ emergency', 'circuit breaker', 'halt',
  'flash crash', '急騰', '急落', 'black swan',
];

// ─── 型定義 ──────────────────────────────────────────────────────────────────

export interface TempParamEntry {
  pair:               string;
  rsi_oversold?:      number;
  rsi_overbought?:    number;
  adx_min?:           number;
  atr_tp_multiplier?: number;
  atr_sl_multiplier?: number;
  vix_max?:           number;
  /** 期間限定実験用: entry_score_min の一時上書き。nullなら通常値を使用 */
  entry_score_min?:   number;
}

export interface NewsTriggerResult {
  triggerType:     'EMERGENCY' | 'TREND_INFLUENCE' | 'NONE';
  newsTitle?:      string;
  newsScore?:      number;
  affectedPairs?:  string[];
  emergencyForced: boolean; // PATH_B強制発火フラグをセットしたか
}

// ─── 緊急度判定 ────────────────────────────────────────────────────────────

function isEmergency(title: string, scores: { relevance: number; sentiment: number; composite: number }): boolean {
  const hasKeyword = EMERGENCY_KEYWORDS.some(kw =>
    title.toLowerCase().includes(kw.toLowerCase())
  );
  // スコア条件: relevance≥NEWS_TRIGGER_EMERGENCY_RELEVANCE(0-10) かつ sentiment≥NEWS_TRIGGER_EMERGENCY_SENTIMENT(0-10)
  // キーワード条件: キーワード一致 かつ composite≥NEWS_SCORE_EMERGENCY(0-100)
  return (
    (scores.relevance >= NEWS_TRIGGER_EMERGENCY_RELEVANCE && scores.sentiment >= NEWS_TRIGGER_EMERGENCY_SENTIMENT)
    || (hasKeyword && scores.composite >= NEWS_SCORE_EMERGENCY)
  );
}

function isTrendInfluence(scores: { relevance: number; sentiment: number; composite: number }): boolean {
  // relevance/sentiment は AI が 0-10 で返す個別軸スコア
  // composite は 0-100 スケール（news.ts で *10 変換済み）
  return (
    scores.relevance >= NEWS_TRIGGER_TREND_RELEVANCE
    && scores.sentiment >= NEWS_TRIGGER_TREND_SENTIMENT
    && scores.composite >= NEWS_SCORE_TREND
  );
}

// ─── 直近未処理ニュースの取得 ─────────────────────────────────────────────

interface NewsRawRow {
  id:              number;
  hash:            string;
  title_ja:        string | null;
  title:           string;
  composite_score: number | null;
  scores:          string | null;  // JSON
  fetched_at:      string;
}

// market_cache キー: 最後にトリガー処理したnews_raw.id
const LAST_TRIGGER_NEWS_ID_KEY = 'last_trigger_news_id';

/**
 * 前回処理以降の採用ニュースから最高スコア記事を1件取得して分類する。
 * 処理済みidをキャッシュに記録してスキップを確実にする。
 */
async function fetchLatestTriggerCandidate(
  db: D1Database,
): Promise<{ row: NewsRawRow; parsedScores: { relevance: number; sentiment: number; composite: number } } | null> {
  const lastIdRaw = await db
    .prepare(`SELECT value FROM market_cache WHERE key = ?`)
    .bind(LAST_TRIGGER_NEWS_ID_KEY)
    .first<{ value: string }>();
  const lastId = lastIdRaw ? parseInt(lastIdRaw.value) : 0;

  // 前回処理以降の採用記事（composite_score >= NEWS_SCORE_TREND = 70 以上を対象）
  const rows = await db
    .prepare(
      `SELECT id, hash, title_ja, title, composite_score, scores, fetched_at
       FROM news_raw
       WHERE filter_accepted = 1
         AND id > ?
         AND composite_score >= ${NEWS_SCORE_TREND}
       ORDER BY composite_score DESC
       LIMIT 1`
    )
    .bind(lastId)
    .all<NewsRawRow>();

  const row = rows.results?.[0];
  if (!row || !row.scores) return null;

  let parsed: { relevance?: number; sentiment?: number; composite?: number } = {};
  try { parsed = JSON.parse(row.scores); } catch { return null; }

  const relevance  = parsed.relevance  ?? 0;
  const sentiment  = parsed.sentiment  ?? 0;
  const composite  = parsed.composite  ?? row.composite_score ?? 0;

  return { row, parsedScores: { relevance, sentiment, composite } };
}

// ─── 緊急: PATH_B 強制発火フラグをセット ──────────────────────────────────

const EMERGENCY_FORCE_KEY = 'news_emergency_force';

export async function setEmergencyForceFlag(db: D1Database): Promise<void> {
  await setCacheValue(db, EMERGENCY_FORCE_KEY, Date.now().toString());
}

export async function consumeEmergencyForceFlag(db: D1Database): Promise<boolean> {
  const raw = await db
    .prepare(`SELECT value FROM market_cache WHERE key = ?`)
    .bind(EMERGENCY_FORCE_KEY)
    .first<{ value: string }>();
  if (!raw) return false;

  // フラグを消費（再発火防止）
  await db
    .prepare(`DELETE FROM market_cache WHERE key = ?`)
    .bind(EMERGENCY_FORCE_KEY)
    .run();

  // フラグが10分以内なら有効
  const flagAge = Date.now() - parseInt(raw.value);
  return flagAge < 10 * 60 * 1000;
}

// ─── トレンド: Gemini Flashによる臨時パラメーター生成 ────────────────────

async function callGeminiForTempParams(
  newsTitle: string,
  newsScore: number,
  geminiApiKey: string,
): Promise<{ pairs: TempParamEntry[]; reason: string; expiresInHours: number } | null> {
  const prompt = [
    `あなたはFXロジックトレーディングのパラメーターアナリストです。`,
    `以下のニュースが発生しました。このニュースが影響する通貨ペア・商品の`,
    `ロジックパラメーターを一時的に調整する必要があるか判断し、必要な場合は`,
    `臨時パラメーターをJSONで返してください。`,
    ``,
    `【ニュースタイトル】${newsTitle}`,
    `【スコア】${newsScore.toFixed(1)}/10`,
    ``,
    `【判断基準（キーワードベース自動マッピング）】`,
    `タイトルに以下のキーワードが含まれる場合、対応するpairを必ず含めること:`,
    `- USD/JPY・ドル円・円安・円高・介入・BOJ・日銀・円 → pair="USD/JPY"`,
    `- 原油・石油・CrudeOil・WTI・OPEC・タンカー → pair="CrudeOil"`,
    `- 金（ゴールド）・Gold → pair="Gold"`,
    `- 日経・Nikkei・東証・TOPIX → pair="Nikkei225"`,
    `- EUR/USD・ユーロ・Euro → pair="EUR/USD"`,
    `- GBP/USD・ポンド・Pound・Sterling → pair="GBP/USD"`,
    `- AUD・豪ドル・RBA → pair="AUD/USD"`,
    `- 銀・Silver → pair="Silver"`,
    `- S&P500・ダウ → pair="S&P500"`,
    `- NASDAQ・ナスダック → pair="NASDAQ"`,
    `- 天然ガス・NatGas → pair="NatGas"`,
    `- 銅・Copper → pair="Copper"`,
    `- 債券・長期金利・米国債・国債 → pair="USD/JPY"（金利はドル円に最も直結）`,
    `- インフレ・CPI・FOMC・FRB・Fed → pair="USD/JPY"（米金融政策はドル円に影響）`,
    `- 上記キーワードが全くない場合のみ pairs=[] で返すこと`,
    ``,
    `【パラメーター調整方針】`,
    `- ボラティリティ上昇が予想される → atr_tp_multiplierを大きく（最大1.5倍）、adx_minを下げる`,
    `- 方向性が明確 → rsi_oversold/overboughtを緩め（閾値を広げる方向）`,
    `- NULLにした項目は通常値を使用（変更しない）`,
    `- atr_tp_multiplier / atr_sl_multiplier は必ず >= 2.0`,
    `- 有効期間: 通常1〜4時間（expiresInHours）、大イベントなら最大8時間`,
    ``,
    `以下のJSONのみで回答してください:`,
    `{"pairs":[{"pair":"USD/JPY","rsi_oversold":30,"rsi_overbought":70,"adx_min":20,"atr_tp_multiplier":4.0,"atr_sl_multiplier":1.5,"vix_max":50}],`,
    ` "reason":"調整理由150文字以内","expiresInHours":2}`,
    `pairsが空の場合: {"pairs":[],"reason":"影響軽微","expiresInHours":0}`,
  ].join('\n');

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2,
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok) {
      console.warn(`[news-trigger] Gemini Flash HTTP error: ${res.status} ${res.statusText}`);
      return null;
    }
    const data = await res.json() as {
      candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.warn(`[news-trigger] Gemini Flash empty response`);
      return null;
    }
    return JSON.parse(text) as { pairs: TempParamEntry[]; reason: string; expiresInHours: number };
  } catch (e) {
    console.warn(`[news-trigger] Gemini Flash call failed: ${String(e).slice(0, 100)}`);
    return null;
  }
}

// ─── 臨時パラメーターをDBに保存 ──────────────────────────────────────────

async function saveTempParams(
  db: D1Database,
  entries: TempParamEntry[],
  reason: string,
  expiresInHours: number,
  newsTitle: string,
  newsScore: number,
): Promise<string[]> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000).toISOString();
  const appliedPairs: string[] = [];

  for (const e of entries) {
    await db
      .prepare(
        `INSERT INTO news_temp_params
           (pair, event_type, rsi_oversold, rsi_overbought, adx_min,
            atr_tp_multiplier, atr_sl_multiplier, vix_max,
            reason, news_title, news_score, expires_at, applied_by, created_at)
         VALUES (?, 'TREND_INFLUENCE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AI_NEWS_v1', ?)`
      )
      .bind(
        e.pair,
        e.rsi_oversold       ?? null,
        e.rsi_overbought     ?? null,
        e.adx_min            ?? null,
        e.atr_tp_multiplier  ?? null,
        e.atr_sl_multiplier  ?? null,
        e.vix_max            ?? null,
        reason,
        newsTitle,
        newsScore,
        expiresAt,
        now.toISOString(),
      )
      .run();
    appliedPairs.push(e.pair);
  }
  return appliedPairs;
}

// ─── 有効な臨時パラメーター取得（logic-trading から呼ぶ） ─────────────────

export interface ActiveTempParams {
  rsi_oversold?:      number;
  rsi_overbought?:    number;
  adx_min?:           number;
  atr_tp_multiplier?: number;
  atr_sl_multiplier?: number;
  vix_max?:           number;
  /** v243: 期間限定スコア実験用。nullなら instrument_params の通常値を使用 */
  entry_score_min?:   number;
  reason:             string;
  expires_at:         string;
}

/**
 * 有効期限内の臨時パラメーターを取得する。
 * 複数ある場合は最新を優先（AIが複数回設定した場合）。
 */
export async function getActiveTempParams(
  db: D1Database,
  pair: string,
  now: Date,
): Promise<ActiveTempParams | null> {
  const row = await db
    .prepare(
      `SELECT * FROM news_temp_params
       WHERE pair = ? AND expires_at > ?
       ORDER BY id DESC LIMIT 1`
    )
    .bind(pair, now.toISOString())
    .first<{
      rsi_oversold: number | null;
      rsi_overbought: number | null;
      adx_min: number | null;
      atr_tp_multiplier: number | null;
      atr_sl_multiplier: number | null;
      vix_max: number | null;
      entry_score_min: number | null;  // v243: 期間限定実験用
      reason: string;
      expires_at: string;
    }>();

  if (!row) return null;
  return {
    rsi_oversold:      row.rsi_oversold      ?? undefined,
    rsi_overbought:    row.rsi_overbought     ?? undefined,
    adx_min:           row.adx_min            ?? undefined,
    atr_tp_multiplier: row.atr_tp_multiplier  ?? undefined,
    atr_sl_multiplier: row.atr_sl_multiplier  ?? undefined,
    vix_max:           row.vix_max            ?? undefined,
    entry_score_min:   row.entry_score_min    ?? undefined,  // v243
    reason:            row.reason,
    expires_at:        row.expires_at,
  };
}

// ─── メイン: ニュートリガー判定・実行 ────────────────────────────────────

/**
 * 新着採用ニュースを検査し、緊急/トレンドに応じたアクションを起動する。
 * - EMERGENCY: PATH_B強制発火フラグをmarket_cacheにセット
 * - TREND: Gemini Flashで臨時パラメーター生成 → news_temp_paramsに保存
 * cron 1回につき1記事のみ処理（負荷抑制）
 */
export async function runNewsTrigger(
  db: D1Database,
  geminiApiKey?: string,
): Promise<NewsTriggerResult> {
  const candidate = await fetchLatestTriggerCandidate(db);

  if (!candidate) {
    return { triggerType: 'NONE', emergencyForced: false };
  }

  const { row, parsedScores } = candidate;
  const title = row.title_ja ?? row.title;

  // 処理済みidを更新（次回重複処理を防止）
  await db
    .prepare(`INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)`)
    .bind(LAST_TRIGGER_NEWS_ID_KEY, row.id.toString(), new Date().toISOString())
    .run();

  // 緊急判定 → PATH_B強制発火
  if (isEmergency(title, parsedScores)) {
    await setEmergencyForceFlag(db);

    await db
      .prepare(
        `INSERT INTO news_trigger_log (trigger_type, news_title, news_score, relevance, sentiment, affected_pairs, detail, created_at)
         VALUES ('EMERGENCY', ?, ?, ?, ?, NULL, 'PATH_B強制発火フラグセット', ?)`
      )
      .bind(title, parsedScores.composite, parsedScores.relevance, parsedScores.sentiment, new Date().toISOString())
      .run();

    await insertSystemLog(db, 'INFO', 'NEWS_TRIGGER',
      `緊急ニュース検出 → PATH_B強制発火: ${title.slice(0, 60)}`,
      `score=${parsedScores.composite} relevance=${parsedScores.relevance} sentiment=${parsedScores.sentiment}`);

    return {
      triggerType: 'EMERGENCY',
      newsTitle: title,
      newsScore: parsedScores.composite || undefined,
      emergencyForced: true,
    };
  }

  // トレンド影響判定 → 臨時パラメーター
  if (isTrendInfluence(parsedScores)) {
    if (!geminiApiKey) {
      await insertSystemLog(db, 'WARN', 'NEWS_TRIGGER',
        `トレンドニュース検出だがAPIキーなしでスキップ: ${title.slice(0, 60)}`, '');
      return { triggerType: 'TREND_INFLUENCE', newsTitle: title, emergencyForced: false };
    }

    const geminiResult = await callGeminiForTempParams(title, parsedScores.composite, geminiApiKey);

    if (!geminiResult) {
      // Gemini Flash呼び出し失敗（APIエラー・タイムアウト）
      await db
        .prepare(
          `INSERT INTO news_trigger_log (trigger_type, news_title, news_score, relevance, sentiment, affected_pairs, detail, created_at)
           VALUES ('TREND_INFLUENCE', ?, ?, ?, ?, NULL, 'Gemini Flash呼び出し失敗', ?)`
        )
        .bind(title, parsedScores.composite, parsedScores.relevance, parsedScores.sentiment, new Date().toISOString())
        .run();
      await insertSystemLog(db, 'WARN', 'NEWS_TRIGGER',
        `Gemini Flash呼び出し失敗でTREND_INFLUENCEスキップ: ${title.slice(0, 60)}`,
        `score=${parsedScores.composite}`);
      return { triggerType: 'TREND_INFLUENCE', newsTitle: title, emergencyForced: false, affectedPairs: [] };
    }

    if (geminiResult.pairs.length === 0) {
      // AIが「影響軽微・変更不要」と判断した場合
      await db
        .prepare(
          `INSERT INTO news_trigger_log (trigger_type, news_title, news_score, relevance, sentiment, affected_pairs, detail, created_at)
           VALUES ('TREND_INFLUENCE', ?, ?, ?, ?, NULL, '影響軽微・パラメーター変更なし', ?)`
        )
        .bind(title, parsedScores.composite, parsedScores.relevance, parsedScores.sentiment, new Date().toISOString())
        .run();
      return { triggerType: 'TREND_INFLUENCE', newsTitle: title, emergencyForced: false, affectedPairs: [] };
    }

    const appliedPairs = await saveTempParams(
      db,
      geminiResult.pairs,
      geminiResult.reason,
      geminiResult.expiresInHours,
      title,
      parsedScores.composite,
    );

    await db
      .prepare(
        `INSERT INTO news_trigger_log (trigger_type, news_title, news_score, relevance, sentiment, affected_pairs, detail, created_at)
         VALUES ('TREND_INFLUENCE', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        title,
        parsedScores.composite,
        parsedScores.relevance,
        parsedScores.sentiment,
        appliedPairs.join(','),
        geminiResult.reason,
        new Date().toISOString(),
      )
      .run();

    await insertSystemLog(db, 'INFO', 'NEWS_TRIGGER',
      `トレンドニュース → 臨時パラメーター設定: ${appliedPairs.join(',')}`,
      `${geminiResult.reason.slice(0, 100)} expires=${geminiResult.expiresInHours}h`);

    return {
      triggerType: 'TREND_INFLUENCE',
      newsTitle: title,
      newsScore: parsedScores.composite || undefined,
      affectedPairs: appliedPairs,
      emergencyForced: false,
    };
  }

  return { triggerType: 'NONE', emergencyForced: false };
}

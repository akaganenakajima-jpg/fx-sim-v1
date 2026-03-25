// ニューストリガーモジュール（Ph.5）
// 高スコアニュースを検出し2種のアクションを起動する:
//   EMERGENCY     → PATH_B強制発火（market_cacheにフラグをセット）
//   TREND_INFLUENCE → AIが期限付き臨時パラメーターを生成（news_temp_params）
//
// 設計根拠:
//   fx-strategy.md §2.1: ニュース駆動相場ではロジックパラメーターが無効化される
//   fx-strategy.md §2.3: 緊急局面でのAI完全裁量エントリーが期待値を最大化
//   stats/ts.md §2: イベントスタディ — 突発ニュース後の価格インパクトは60〜120分で収束

import { insertSystemLog, setCacheValue } from './db';

// ─── 緊急関連キーワード ────────────────────────────────────────────────────
// スコアが TREND 帯（7.0-8.9）でもこれらが含まれれば EMERGENCY に昇格
// ただし composite_score >= 8.0 が条件（7.x では昇格しない）
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
}

export interface NewsTriggerResult {
  triggerType:     'EMERGENCY' | 'TREND_INFLUENCE' | 'NONE';
  newsTitle?:      string;
  newsScore?:      number;
  affectedPairs?:  string[];
  emergencyForced: boolean; // PATH_B強制発火フラグをセットしたか
}

// ─── 緊急度判定 ────────────────────────────────────────────────────────────
// 仕様: EMERGENCY = composite ≥ 9.0 (= 90/100)
//        例外: キーワード該当 かつ composite ≥ 8.0 → EMERGENCY に昇格
//       TREND_INFLUENCE = composite 7.0〜8.9 (= 70-89/100)

function isEmergency(title: string, scores: { relevance: number; sentiment: number; composite: number }): boolean {
  // 基本基準: composite ≥ 9.0
  if (scores.composite >= 9.0) return true;
  // キーワード昇格: 介入・flash crash等 かつ composite ≥ 8.0
  if (scores.composite >= 8.0) {
    const hasKeyword = EMERGENCY_KEYWORDS.some(kw =>
      title.toLowerCase().includes(kw.toLowerCase())
    );
    if (hasKeyword) return true;
  }
  return false;
}

function isTrendInfluence(scores: { relevance: number; sentiment: number; composite: number }): boolean {
  return scores.composite >= 7.0 && scores.composite < 9.0;
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
 * 前回処理以降の採用ニュースで composite_score >= 7.0 の全件を取得する。
 * スコア降順で最大5件処理（負荷と網羅性のバランス）。
 * 処理済みidの最大値をキャッシュに記録してスキップを確実にする。
 */
async function fetchTriggerCandidates(
  db: D1Database,
): Promise<Array<{ row: NewsRawRow; parsedScores: { relevance: number; sentiment: number; composite: number } }>> {
  const lastIdRaw = await db
    .prepare(`SELECT value FROM market_cache WHERE key = ?`)
    .bind(LAST_TRIGGER_NEWS_ID_KEY)
    .first<{ value: string }>();
  const lastId = lastIdRaw ? parseInt(lastIdRaw.value) : 0;

  // 前回処理以降の採用記事（composite_score >= 7.0 以上を対象、最大5件）
  const rows = await db
    .prepare(
      `SELECT id, hash, title_ja, title, composite_score, scores, fetched_at
       FROM news_raw
       WHERE haiku_accepted = 1
         AND id > ?
         AND composite_score >= 7.0
       ORDER BY composite_score DESC
       LIMIT 5`
    )
    .bind(lastId)
    .all<NewsRawRow>();

  const candidates: Array<{ row: NewsRawRow; parsedScores: { relevance: number; sentiment: number; composite: number } }> = [];

  for (const row of rows.results ?? []) {
    if (!row.scores) continue;
    let parsed: { relevance?: number; sentiment?: number; composite?: number } = {};
    try { parsed = JSON.parse(row.scores); } catch { continue; }

    candidates.push({
      row,
      parsedScores: {
        relevance: parsed.relevance ?? 0,
        sentiment: parsed.sentiment ?? 0,
        composite: parsed.composite ?? row.composite_score ?? 0,
      },
    });
  }

  return candidates;
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

// ─── トレンド: GPTによる臨時パラメーター生成 ─────────────────────────────

async function callGptForTempParams(
  newsTitle: string,
  newsScore: number,
  openaiApiKey: string,
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
    `【判断基準】`,
    `- ドル円に大きく影響するなら pair=USD/JPY を含める`,
    `- 株価インデックスに影響するなら Nikkei225, S&P500, DAX 等を含める`,
    `- コモディティに影響するなら Gold, CrudeOil 等を含める`,
    `- 影響が不明・軽微な場合は pairs=[] で返すこと`,
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
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message: { content: string } }> };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return null;
    return JSON.parse(text) as { pairs: TempParamEntry[]; reason: string; expiresInHours: number };
  } catch {
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
    reason:            row.reason,
    expires_at:        row.expires_at,
  };
}

// ─── メイン: ニュートリガー判定・実行 ────────────────────────────────────

/**
 * 新着採用ニュースを検査し、緊急/トレンドに応じたアクションを起動する。
 * - EMERGENCY (composite ≥ 9.0): PATH_B強制発火フラグをmarket_cacheにセット
 * - TREND_INFLUENCE (composite 7.0-8.9): GPTで臨時パラメーター生成 → news_temp_paramsに保存
 * cron 1回につき最大5記事を処理（漏れ防止）。最も重要な結果を返す。
 */
export async function runNewsTrigger(
  db: D1Database,
  openaiApiKey?: string,
): Promise<NewsTriggerResult> {
  const candidates = await fetchTriggerCandidates(db);

  if (candidates.length === 0) {
    return { triggerType: 'NONE', emergencyForced: false };
  }

  // 処理済みidの最大値を記録（全候補分スキップ）
  const maxId = Math.max(...candidates.map(c => c.row.id));
  await db
    .prepare(`INSERT OR REPLACE INTO market_cache (key, value, updated_at) VALUES (?, ?, ?)`)
    .bind(LAST_TRIGGER_NEWS_ID_KEY, maxId.toString(), new Date().toISOString())
    .run();

  let bestResult: NewsTriggerResult = { triggerType: 'NONE', emergencyForced: false };

  for (const { row, parsedScores } of candidates) {
    const title = row.title_ja ?? row.title;

    // 緊急判定 → PATH_B強制発火
    if (isEmergency(title, parsedScores)) {
      await setEmergencyForceFlag(db);

      await db
        .prepare(
          `INSERT INTO news_trigger_log (trigger_type, news_title, news_score, affected_pairs, detail, created_at)
           VALUES ('EMERGENCY', ?, ?, NULL, 'PATH_B強制発火フラグセット', ?)`
        )
        .bind(title, row.composite_score, new Date().toISOString())
        .run();

      await insertSystemLog(db, 'INFO', 'NEWS_TRIGGER',
        `緊急ニュース検出 → PATH_B強制発火: ${title.slice(0, 60)}`,
        `score=${row.composite_score} relevance=${parsedScores.relevance} sentiment=${parsedScores.sentiment}`);

      // EMERGENCYは最優先
      bestResult = {
        triggerType: 'EMERGENCY',
        newsTitle: title,
        newsScore: row.composite_score ?? undefined,
        emergencyForced: true,
      };
      continue;
    }

    // トレンド影響判定 → 臨時パラメーター
    if (isTrendInfluence(parsedScores)) {
      if (!openaiApiKey) {
        await insertSystemLog(db, 'WARN', 'NEWS_TRIGGER',
          `トレンドニュース検出だがAPIキーなしでスキップ: ${title.slice(0, 60)}`, '');
        if (bestResult.triggerType === 'NONE') {
          bestResult = { triggerType: 'TREND_INFLUENCE', newsTitle: title, emergencyForced: false };
        }
        continue;
      }

      const gptResult = await callGptForTempParams(title, row.composite_score ?? 7.5, openaiApiKey);

      if (!gptResult || gptResult.pairs.length === 0) {
        // パラメーター変更不要と判断された場合もログに記録
        await db
          .prepare(
            `INSERT INTO news_trigger_log (trigger_type, news_title, news_score, affected_pairs, detail, created_at)
             VALUES ('TREND_INFLUENCE', ?, ?, NULL, '影響軽微・パラメーター変更なし', ?)`
          )
          .bind(title, row.composite_score, new Date().toISOString())
          .run();

        if (bestResult.triggerType === 'NONE') {
          bestResult = { triggerType: 'TREND_INFLUENCE', newsTitle: title, emergencyForced: false, affectedPairs: [] };
        }
        continue;
      }

      const appliedPairs = await saveTempParams(
        db, gptResult.pairs, gptResult.reason, gptResult.expiresInHours,
        title, row.composite_score ?? 7.5,
      );

      await db
        .prepare(
          `INSERT INTO news_trigger_log (trigger_type, news_title, news_score, affected_pairs, detail, created_at)
           VALUES ('TREND_INFLUENCE', ?, ?, ?, ?, ?)`
        )
        .bind(title, row.composite_score, appliedPairs.join(','), gptResult.reason, new Date().toISOString())
        .run();

      await insertSystemLog(db, 'INFO', 'NEWS_TRIGGER',
        `トレンドニュース → 臨時パラメーター設定: ${appliedPairs.join(',')}`,
        `${gptResult.reason.slice(0, 100)} expires=${gptResult.expiresInHours}h`);

      if (bestResult.triggerType !== 'EMERGENCY') {
        bestResult = {
          triggerType: 'TREND_INFLUENCE',
          newsTitle: title,
          newsScore: row.composite_score ?? undefined,
          affectedPairs: appliedPairs,
          emergencyForced: false,
        };
      }
    }
  }

  return bestResult;
}

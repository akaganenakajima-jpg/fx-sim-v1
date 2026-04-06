// analysis-workflow.ts — 5分ごと実行（Path B・Breakout・SPRT・ParamReview・AutoApproval）

import { type Env, getApiKey, getAllApiKeys, markKeyCooldown } from '../env';
import { getUSDJPY } from '../rate';
import { getMarketIndicators } from '../indicators';
import {
  fetchOgDescription,
  newsStage1WithHedge,
  newsStage2,
  getAdaptiveB2Timeout,
  RateLimitError,
  type NewsAnalysisItem,
  type NewsStage1Result,
} from '../gemini';
import { openPosition, calcRealizedRR } from '../position';
import {
  insertSystemLog,
  getCacheValue,
  setCacheValue,
  closePosition,
  getRunId,
} from '../db';
import { INSTRUMENTS } from '../instruments';
import { checkTpSlSanity } from '../sanity';
import { getWebhookUrl, sendNotification } from '../notify';
import { detectBreakout } from '../breakout';
import { determineRegime, formatRegimeForPrompt, getRegimeProhibitions } from '../regime';
import { getWeekendStatus, getTradeableInstruments } from '../weekend';
import { runParamReview } from '../param-review';
import { evaluateRecoveryIfNeeded, getDrawdownLevel, checkInstrumentDailyLoss } from '../risk-manager';
import { runNewsTrigger, consumeEmergencyForceFlag } from '../news-trigger';
import { logReturn } from '../stats';
import { buildPricesMap, buildWeekendContext } from './core-workflow';

// ── サーキットブレーカー（3段階: CLOSED → OPEN → HALF_OPEN）──
// 連続失敗時にAI呼び出しを一時停止し、無意味なリトライによる障害悪化を防止
interface CircuitBreakerState {
  state: 'CLOSED' | 'HALF_OPEN' | 'OPEN';
  failCount: number;
  openUntil: number;
}

const circuitBreaker: CircuitBreakerState = {
  state: 'CLOSED',
  failCount: 0,
  openUntil: 0,
};

const CB_FAIL_THRESHOLD = 3;        // 連続3回失敗で OPEN
const CB_OPEN_DURATION_MS = 60_000; // OPEN → 1分後に HALF_OPEN

/** AI呼び出し成功時 → CLOSED にリセット */
function cbRecordSuccess(): void {
  if (circuitBreaker.state !== 'CLOSED') {
    console.log(`[fx-sim] Circuit breaker: ${circuitBreaker.state} → CLOSED（復旧）`);
  }
  circuitBreaker.state = 'CLOSED';
  circuitBreaker.failCount = 0;
}

/** AI呼び出し失敗時 → 閾値超過で OPEN */
function cbRecordFailure(): void {
  circuitBreaker.failCount++;
  if (circuitBreaker.failCount >= CB_FAIL_THRESHOLD) {
    circuitBreaker.state = 'OPEN';
    circuitBreaker.openUntil = Date.now() + CB_OPEN_DURATION_MS;
    console.log(`[fx-sim] Circuit breaker: → OPEN（${CB_OPEN_DURATION_MS / 1000}s間 AI停止, 連続${circuitBreaker.failCount}回失敗）`);
  }
}

const PREV_NEWS_HASH_KEY = 'prev_news_hash';

/**
 * ニュースハッシュ: 上位5件のみ・正規化・ソートで順序変動に鈍感化
 * 旧: 全タイトル join → 1件変更で即発火（高感度すぎ）
 * 新: 上位5件 sort → 重要ニュースの入れ替えのみ検知
 */
function newsHash(items: Array<{ title: string }>): string {
  return items
    .slice(0, 5)
    .map(n => n.title.toLowerCase().trim())
    .sort()
    .join('|');
}

interface SharedNewsStore {
  items: any[];
  hash: string;
  hasChanged: boolean;
}

interface PathDecision {
  pair: string;
  decision: 'BUY' | 'SELL' | 'HOLD';
  tp_rate: number | null;
  sl_rate: number | null;
  reasoning: string;
  rate: number;
  source: 'PATH_A' | 'PATH_B' | 'PATH_C';
  news_analysis?: NewsAnalysisItem[];
}

interface PathBResult {
  decisions: PathDecision[];  // BUY/SELLのみ
  reversals: string[];        // REVERSE対象のpair一覧
  newsAnalysis: NewsAnalysisItem[];
}

/**
 * runAnalysis 専用のリアルタイムデータ取得。
 *
 * ニュース系 API（Gemini 翻訳含む）は runCore が毎分呼ぶため再呼び出しはしない。
 * - ニュース  : analysis_news キャッシュ（runCore が書いた最新記事、最大 ~1 分前）
 * - 価格/指標 : getMarketIndicators（内部 DB キャッシュ → 追加 API コールなし）
 *               + getUSDJPY（Frankfurter、無料・制限なし）
 * - 週末文脈  : 個別キャッシュキーから buildWeekendContext で再構築
 *
 * ⚠️ core_shared_data への依存を完全に排除することで、
 *    runCore との Race Condition（最大 4m59s のデータ遅延）を解消する。
 */
async function fetchAnalysisData(env: Env, now: Date): Promise<{
  news: any[];
  indicators: Awaited<ReturnType<typeof getMarketIndicators>>;
  prices: Map<string, number | null>;
  weekendContext: string;
  cryptoOnlyMode: boolean;
  fetchAnalysisMs: number;
}> {
  const t0 = Date.now();
  const weekendStatus = getWeekendStatus(now);

  // ① ニュース（analysis_news キャッシュから読出し — ニュース API 再呼び出しなし）
  const analysisNewsRaw = await getCacheValue(env.DB, 'analysis_news');
  const news: any[] = analysisNewsRaw
    ? (() => { try { return JSON.parse(analysisNewsRaw); } catch { return []; } })()
    : [];

  // ② 価格 / 指標（Twelve Data は内部 DB キャッシュを持つ。runCore 直後なら API コールゼロ）
  const [indicatorsResult, frankfurterResult] = await Promise.allSettled([
    getMarketIndicators(env.TWELVE_DATA_API_KEY, env.DB),
    getUSDJPY(),
  ]);
  const indicators = indicatorsResult.status === 'fulfilled'
    ? indicatorsResult.value
    : { vix: null, us10y: null, nikkei: null, sp500: null, usdjpy: null, btcusd: null, gold: null, eurusd: null, ethusd: null, crudeoil: null, natgas: null, copper: null, silver: null, gbpusd: null, audusd: null, solusd: null, dax: null, nasdaq: null, uk100: null, hk33: null, eurjpy: null, gbpjpy: null, audjpy: null, kawasaki_kisen: null, nippon_yusen: null, softbank_g: null, lasertec: null, tokyo_electron: null, disco: null, advantest: null, fast_retailing: null, nippon_steel: null, mufg: null, mitsui_osk: null, tokio_marine: null, mitsubishi_corp: null, toyota: null, sakura_internet: null, mhi: null, ihi: null, anycolor: null, cover_corp: null, nvda: null, tsla: null, aapl: null, amzn: null, amd: null, meta: null, msft: null, googl: null, fearGreed: null, fearGreedLabel: null, cftcJpyNetLong: null };
  const frankfurterRate = frankfurterResult.status === 'fulfilled' ? frankfurterResult.value : null;

  if (indicatorsResult.status === 'rejected') {
    console.warn(`[fx-sim] fetchAnalysisData: indicators取得失敗 (DB キャッシュを使用): ${String(indicatorsResult.reason).slice(0, 80)}`);
  }

  // ③ 価格 Map 構築（prev_rate_* フォールバック込み）
  const { prices, fallbackPairs } = await buildPricesMap(indicators, frankfurterRate, env.DB);
  if (fallbackPairs.length >= 3) {
    console.warn(`[fx-sim] fetchAnalysisData: ${fallbackPairs.length}銘柄フォールバック使用`);
  }

  // ④ 週末コンテキスト（個別キャッシュから再構築 — runCore 依存なし）
  const weekendContext = await buildWeekendContext(env.DB, weekendStatus);

  return {
    news,
    indicators,
    prices,
    weekendContext,
    cryptoOnlyMode: weekendStatus.marketClosed,
    fetchAnalysisMs: Date.now() - t0,
  };
}

// ── Path B: ニュースドリブン 2段階AI判定 ──

/**
 * Path B: ニュース駆動の売買シグナル生成
 *
 * B1（タイトル即断）→ og:description取得 → B2（補正）の2段階で売買シグナルを生成。
 * ニュースハッシュが変化したとき（新記事が届いたとき）に起動する。
 *
 * ⚠️ 週末制約（IPA §横断的関心事 / CLAUDE.md §週末市場クローズ制約）:
 *   取引対象銘柄は内部で getTradeableInstruments() を経由して決定する。
 *   週末クローズ中（marketClosed=true）は自動的に CRYPTO_PAIRS のみが対象になる。
 *   この関数を改修するときは getTradeableInstruments() の呼び出しを削除しないこと。
 */
async function runPathB(
  env: Env,
  sharedNewsStore: SharedNewsStore,
  indicators: Awaited<ReturnType<typeof getMarketIndicators>>,
  openPairs: Set<string>,
  apiKeys: string[],
  hedgeKeys?: { openaiApiKey?: string; anthropicApiKey?: string },
  regimeContext?: { text: string; prohibitions: string },
  prices?: Map<string, number | null>,
): Promise<PathBResult> {
  const apiKey = apiKeys[0]; // B2やその他で使うデフォルトキー
  const news = sharedNewsStore.items;
  if (news.length === 0) return { decisions: [], reversals: [], newsAnalysis: [] };

  // 失敗クールダウンチェック（2分）
  const failedAtRaw = await getCacheValue(env.DB, 'news_analysis_failed_at');
  const failedAt = failedAtRaw ? parseInt(failedAtRaw) : 0;
  if ((Date.now() - failedAt) < 2 * 60 * 1000) {
    console.log('[fx-sim] Path B: クールダウン中のためスキップ');
    return { decisions: [], reversals: [], newsAnalysis: [] };
  }

  // T09: 方向別平均RR集計（直近30件/銘柄）
  const biasRows = await env.DB
    .prepare(
      `SELECT pair, direction, AVG(realized_rr) AS avgRR
       FROM positions
       WHERE status = 'CLOSED' AND realized_rr IS NOT NULL
       GROUP BY pair, direction`
    )
    .all<{ pair: string; direction: string; avgRR: number }>();
  const biasMap = new Map<string, { buyAvgRR: number; sellAvgRR: number }>();
  for (const row of biasRows.results ?? []) {
    const existing = biasMap.get(row.pair) ?? { buyAvgRR: 0, sellAvgRR: 0 };
    if (row.direction === 'BUY') existing.buyAvgRR = row.avgRR;
    else if (row.direction === 'SELL') existing.sellAvgRR = row.avgRR;
    biasMap.set(row.pair, existing);
  }

  // 週末クローズ制約: getTradeableInstruments() 経由で対象銘柄を絞る（CLAUDE.md §週末市場クローズ制約）
  const weekendStatusForFilter = getWeekendStatus(new Date());
  const activeInstruments = getTradeableInstruments(INSTRUMENTS, weekendStatusForFilter);
  if (weekendStatusForFilter.marketClosed) {
    console.log(`[fx-sim] Path B: 暗号資産のみモード (${activeInstruments.length}銘柄)`);
  }

  const instrumentList = activeInstruments.map(i => ({
    pair: i.pair,
    hasOpenPosition: openPairs.has(i.pair),
    tpSlHint: i.tpSlHint,
    correlationGroup: i.correlationGroup,
    currentRate: prices?.get(i.pair) ?? undefined,
    directionBias: biasMap.get(i.pair) ?? undefined,
  }));

  // T10: 実績フィードバック — 直近30件の勝率・平均RR・連敗数・低パフォ銘柄
  let performanceSummary: { winRate: number; avgRR: number; recentStreak: number; worstPairs: string[] } | undefined;
  try {
    const recent30 = await env.DB
      .prepare(
        `SELECT pair, realized_rr FROM positions
         WHERE status = 'CLOSED' AND realized_rr IS NOT NULL
         ORDER BY id DESC LIMIT 30`
      )
      .all<{ pair: string; realized_rr: number }>();
    const rows = recent30.results ?? [];
    if (rows.length >= 10) {
      const wins = rows.filter(r => r.realized_rr >= 1.0).length;
      const winRate = wins / rows.length;
      const avgRR = rows.reduce((s, r) => s + r.realized_rr, 0) / rows.length;
      // 連敗数（最新から連続でRR<1.0の数、負の値）
      let streak = 0;
      for (const r of rows) {
        if (r.realized_rr < 1.0) streak--;
        else break;
      }
      // 低パフォーマンス銘柄（勝率30%未満 かつ 10件以上）
      const pairStats = new Map<string, { wins: number; total: number }>();
      for (const r of rows) {
        const s = pairStats.get(r.pair) ?? { wins: 0, total: 0 };
        s.total++;
        if (r.realized_rr >= 1.0) s.wins++;
        pairStats.set(r.pair, s);
      }
      const worstPairs = [...pairStats.entries()]
        .filter(([, s]) => s.total >= 5 && s.wins / s.total < 0.3)
        .map(([pair]) => pair);
      performanceSummary = { winRate, avgRR, recentStreak: streak, worstPairs };
    }
  } catch { /* 集計失敗は無視 */ }

  // B1: タイトル即断（タイムアウト10秒）— キャッシュ付き
  const B1_CACHE_KEY = 'path_b_b1_cache';
  const B1_CACHE_TTL_MS = 5 * 60 * 1000; // 5分TTL
  // stage1 は b1CacheHit=true 分岐 or API成功分岐で必ず代入される。
  // API失敗時は throw するため、ここ以降で未代入のまま使われることはない。
  let stage1!: NewsStage1Result;
  let b1Ms = 0, b2Ms = 0;
  let b1CacheHit = false;

  // B1キャッシュチェック: 同一ハッシュ＋TTL内なら再利用（Gemini呼び出し節約）
  const cachedB1Raw = await getCacheValue(env.DB, B1_CACHE_KEY);
  if (cachedB1Raw) {
    try {
      const cached = JSON.parse(cachedB1Raw) as { hash: string; at: number; result: NewsStage1Result };
      if (cached.hash === sharedNewsStore.hash && (Date.now() - cached.at) < B1_CACHE_TTL_MS) {
        stage1 = cached.result;
        b1CacheHit = true;
        console.log('[fx-sim] Path B B1: キャッシュヒット（Gemini呼び出しスキップ）');
      }
    } catch { /* キャッシュ破損は無視 */ }
  }

  // 最適化: B1 API呼び出しと og:description 先行取得を並列実行
  // B1完了前でもニュースURLからog:descriptionを先行取得しておく（上位5件推定）
  const ogPreFetchPromise = Promise.allSettled(
    news.slice(0, 5).map(async (item, index) => {
      const og = await fetchOgDescription((item as any).link ?? '', (item as any).source ?? '');
      return { index, og };
    })
  );

  if (!b1CacheHit) {
    try {
      const tB1 = Date.now();
      const b1Result = await newsStage1WithHedge({
        news, indicators, instruments: instrumentList,
        apiKey, // 1本目（既存互換）
        geminiApiKeys: apiKeys, // 全Geminiキー（複数本リトライ用）
        openaiApiKey: hedgeKeys?.openaiApiKey,
        anthropicApiKey: hedgeKeys?.anthropicApiKey,
        db: env.DB,
        // 施策6+20: テクニカル環境認識・禁止行動をAIプロンプトに注入
        regimeText: regimeContext?.text,
        regimeProhibitions: regimeContext?.prohibitions,
        // T10: 実績フィードバック
        performanceSummary,
      });
      stage1 = b1Result;
      if (b1Result.provider !== 'gemini') {
        console.log(`[fx-sim] Path B B1: ${b1Result.provider}ヘッジ成功`);
      }
      b1Ms = Date.now() - tB1;
      cbRecordSuccess(); // B1成功 → サーキットブレーカー復旧
      console.log(`[fx-sim] Path B B1: ${stage1.news_analysis.filter((a: NewsAnalysisItem) => a.attention).length}件注目, ${stage1.trade_signals.length}件シグナル (${b1Ms}ms)`);

      // B1結果をキャッシュ保存
      void setCacheValue(env.DB, B1_CACHE_KEY, JSON.stringify({
        hash: sharedNewsStore.hash,
        at: Date.now(),
        result: stage1,
      })).catch(() => {});
    } catch (e) {
      if (e instanceof RateLimitError) {
        markKeyCooldown(e.apiKey, e.retryAfterSec);
      }
      cbRecordFailure();
      await setCacheValue(env.DB, 'news_analysis_failed_at', String(Date.now()));
      await insertSystemLog(env.DB, 'WARN', 'PATH_B', 'B1失敗→2分クールダウン', String(e).split('\n')[0].slice(0, 120));
      throw e;
    }
  }

  // B1成功後: filterAndTranslateNewsで付与済みのtitle_jaを転写（APIコール不要）
  for (const item of stage1.news_analysis) {
    const src = news[item.index];
    item.title_ja = src?.title_ja ?? src?.title ?? '';
  }

  // og:description: 先行取得結果を回収し、attentionニュースに付与
  const ogPreResults = await ogPreFetchPromise;
  const ogMap = new Map<number, string>();
  for (const r of ogPreResults) {
    if (r.status === 'fulfilled' && r.value.og) {
      ogMap.set(r.value.index, r.value.og);
    }
  }
  // attention上位5件にog:descriptionを付与（先行取得でカバーできなかった分は追加取得）
  const attentionItems = stage1.news_analysis.filter((a: NewsAnalysisItem) => a.attention).slice(0, 5);
  const ogMissing = attentionItems.filter(a => !ogMap.has(a.index));
  if (ogMissing.length > 0) {
    const extraOg = await Promise.allSettled(
      ogMissing.map(async (a: NewsAnalysisItem) => {
        const item = news[a.index];
        if (!item) return { index: a.index, og: null };
        const og = await fetchOgDescription((item as any).link ?? '', (item as any).source ?? '');
        return { index: a.index, og };
      })
    );
    for (const r of extraOg) {
      if (r.status === 'fulfilled' && r.value.og) ogMap.set(r.value.index, r.value.og);
    }
  }
  for (const a of attentionItems) {
    const og = ogMap.get(a.index);
    if (og) a.og_description = og;
  }

  // 週末クローズガード: B1キャッシュヒット時でも取引可能銘柄のみにフィルタ
  // ⚠️ CLAUDE.md §週末市場クローズ制約: B1キャッシュは平日生成シグナルを含む可能性がある。
  //    再利用時に instrumentList（getTradeableInstruments()適用済み）で再フィルタして
  //    週末クローズ中に非クリプトペアがエントリーされるのを防ぐ。
  //    参考: 2026-03-29 Nikkei225 日曜エントリー（B1キャッシュ週末ガード欠落）の再発防止。
  const tradeablePairSet = new Set(instrumentList.map(i => i.pair));
  const filteredSignals = stage1.trade_signals.filter(s => tradeablePairSet.has(s.pair));
  if (b1CacheHit && filteredSignals.length < stage1.trade_signals.length) {
    const blocked = stage1.trade_signals.filter(s => !tradeablePairSet.has(s.pair)).map(s => s.pair);
    console.log(`[fx-sim] Path B: B1キャッシュ週末ガード — ${blocked.join(',')} をブロック`);
    await insertSystemLog(env.DB, 'INFO', 'PATH_B',
      `B1キャッシュ週末ガード: ${blocked.join(',')} をフィルタ（週末クローズ中）`,
    ).catch(() => {});
  }

  // 過剰検出ガード: 10件超は先頭5件のみ採用
  let signals = filteredSignals;
  if (signals.length > 10) {
    signals = signals.slice(0, 5);
    console.log(`[fx-sim] Path B: 過剰検出ガード (${filteredSignals.length}件→5件)`);
  }

  if (signals.length === 0) {
    // B3: market_cache保存（非同期、売買をブロックしない）
    void (async () => {
      try {
        await setCacheValue(env.DB, 'news_analysis_failed_at', '0');
      } catch {}
    })();

    // ── B1全スキップ「詰み」検出 ──
    // OPポジション多数 + シグナル0件 = [OP]スキップで全銘柄HOLDになった可能性
    // （PR#46で修正したREVERSAL不能状態の再発を検出するため）
    if (openPairs.size >= 8) {
      const attentionCount = stage1.news_analysis.filter((a: NewsAnalysisItem) => a.attention).length;
      await insertSystemLog(
        env.DB, 'WARN', 'PATH_B',
        `B1シグナル0件（詰み疑惑）: ${openPairs.size}銘柄OPENで[OP]全スキップの可能性`,
        JSON.stringify({ opCount: openPairs.size, attention: attentionCount })
      ).catch(() => {});
    }

    return { decisions: [], reversals: [], newsAnalysis: stage1.news_analysis };
  }

  // B2: og:desc付きで補正（タイムアウト8秒）+ サーキットブレーカー
  let b2Corrections: { pair: string; action: 'CONFIRM' | 'REVISE' | 'REVERSE'; new_tp_rate?: number; new_sl_rate?: number; reasoning: string }[] = [];

  // サーキットブレーカー: 連続5回失敗→30分クールダウン
  const B2_CB_THRESHOLD = 5;
  const B2_CB_COOLDOWN_MS = 30 * 60 * 1000; // 30分
  // 最適化: 2つのキャッシュ値を並列取得
  const [b2PrevFailsRaw, b2CbUntil] = await Promise.all([
    getCacheValue(env.DB, 'b2_consecutive_fails').catch(() => '0'),
    getCacheValue(env.DB, 'b2_circuit_breaker_until').catch(() => null),
  ]);
  const b2PrevFails = parseInt(b2PrevFailsRaw ?? '0');
  const b2CbActive = b2CbUntil ? new Date(b2CbUntil) > new Date() : false;

  if (b2CbActive) {
    // サーキットブレーカー発動中 → B2スキップ、B1シグナルをそのまま採用
    console.log(`[fx-sim] Path B B2: サーキットブレーカー発動中 (until ${b2CbUntil}) → B1採用`);
  } else {
    try {
      // T013: 適応的タイムアウトを取得（直近10回のP90+2s、5-15s範囲）
      const adaptiveTimeout = await getAdaptiveB2Timeout(env.DB);
      const tB2 = Date.now();

      let stage2result;
      try {
        stage2result = await newsStage2({ stage1Result: stage1, news, apiKey, db: env.DB, timeoutMs: adaptiveTimeout });
      } catch (firstErr) {
        // AbortError（タイムアウト）の場合のみ 1 回リトライ（1.5倍タイムアウト）
        const errName = (firstErr as Error)?.name;
        if (errName === 'AbortError') {
          console.warn(`[fx-sim] Path B B2: AbortError (${adaptiveTimeout}ms) → リトライ (${Math.round(adaptiveTimeout * 1.5)}ms)`);
          await new Promise(r => setTimeout(r, 500)); // 0.5s 待機
          stage2result = await newsStage2({ stage1Result: stage1, news, apiKey, db: env.DB, timeoutMs: Math.min(15_000, Math.round(adaptiveTimeout * 1.5)) });
        } else {
          throw firstErr;
        }
      }

      b2Ms = Date.now() - tB2;
      b2Corrections = stage2result.corrections;
      console.log(`[fx-sim] Path B B2: ${b2Corrections.filter(c => c.action === 'CONFIRM').length}件CONFIRM, ${b2Corrections.filter(c => c.action === 'REVISE').length}件REVISE, ${b2Corrections.filter(c => c.action === 'REVERSE').length}件REVERSE (${b2Ms}ms, timeout=${adaptiveTimeout}ms)`);
      // B2成功 → 連続失敗カウンター・サーキットブレーカーをリセット
      await setCacheValue(env.DB, 'b2_consecutive_fails', '0').catch(() => {});
      await setCacheValue(env.DB, 'b2_circuit_breaker_until', '').catch(() => {});
    } catch (e) {
      // B2タイムアウト/失敗 → B1シグナルをそのまま採用
      console.warn(`[fx-sim] Path B B2 failed/timeout → B1採用: ${String(e).split('\n')[0].slice(0, 80)}`);
      await insertSystemLog(env.DB, 'WARN', 'PATH_B', 'B2失敗→B1シグナルそのまま採用', String(e).split('\n')[0].slice(0, 120));

      // ── B2連続失敗カウンター + サーキットブレーカー ──
      const newFails = b2PrevFails + 1;
      await setCacheValue(env.DB, 'b2_consecutive_fails', String(newFails)).catch(() => {});

      // 5回連続失敗 → サーキットブレーカー発動（30分クールダウン）
      if (newFails >= B2_CB_THRESHOLD && !b2CbActive) {
        const cbUntil = new Date(Date.now() + B2_CB_COOLDOWN_MS).toISOString();
        await setCacheValue(env.DB, 'b2_circuit_breaker_until', cbUntil).catch(() => {});
        // CB発火時にカウンターをリセット → 解除後は5回失敗で再発動するサイクルに戻す
        await setCacheValue(env.DB, 'b2_consecutive_fails', '0').catch(() => {});
        await insertSystemLog(
          env.DB, 'ERROR', 'B2_OUTAGE',
          `B2 ${newFails}回連続失敗 → サーキットブレーカー発動 (until ${cbUntil})`,
          JSON.stringify({ consecutiveFails: newFails, cooldownMin: 30, lastError: String(e).split('\n')[0].slice(0, 100) })
        ).catch(() => {});
      } else if (newFails % 10 === 0) {
        await insertSystemLog(
          env.DB, 'ERROR', 'B2_OUTAGE',
          `B2 ${newFails}回連続失敗 — APIレート制限またはキー問題の可能性`,
          JSON.stringify({ consecutiveFails: newFails, lastError: String(e).split('\n')[0].slice(0, 100) })
        ).catch(() => {});
      }
    }
  }

  // B2補正適用
  const decisions: PathDecision[] = [];
  const reversals: string[] = [];

  for (const signal of signals) {
    const correction = b2Corrections.find(c => c.pair === signal.pair);
    const action = correction?.action ?? 'CONFIRM';

    if (action === 'REVERSE') {
      reversals.push(signal.pair);
      continue; // B2 REVERSE: 既存ポジションをクローズ、同サイクル再オープン禁止
    }

    // B1 REVERSAL: reasoningが"REVERSAL:"で始まる場合、既存ポジションをクローズ→新規エントリー
    // B2が429で失敗しているときでも逆行ニュースに反応できるフォールバック
    if (signal.reasoning?.startsWith('REVERSAL:')) {
      // reversalsリストに追加してクローズ後、同シグナルをdecisionsにも追加（再オープン）
      reversals.push(signal.pair);
      decisions.push({
        pair: signal.pair,
        decision: signal.decision,
        tp_rate: signal.tp_rate,
        sl_rate: signal.sl_rate,
        reasoning: signal.reasoning + ' [B1_REVERSAL]',
        rate: 0,
        source: 'PATH_B',
        news_analysis: stage1.news_analysis,
      });
      continue;
    }

    let tp = signal.tp_rate;
    let sl = signal.sl_rate;
    if (action === 'REVISE') {
      if (correction?.new_tp_rate != null) tp = correction.new_tp_rate;
      if (correction?.new_sl_rate != null) sl = correction.new_sl_rate;
    }

    decisions.push({
      pair: signal.pair,
      decision: signal.decision,
      tp_rate: tp,
      sl_rate: sl,
      reasoning: `${signal.reasoning}${action === 'REVISE' ? ` [B2:REVISE]` : ''}`,
      rate: 0, // 呼び出し元でprices.get(pair)で補完
      source: 'PATH_B',
      news_analysis: stage1.news_analysis,
    });
  }

  // B3: market_cache保存（非同期、売買をブロックしない）
  void (async () => {
    try {
      await setCacheValue(env.DB, 'news_analysis_failed_at', '0');
      await insertSystemLog(env.DB, 'INFO', 'PATH_B', `Path B完了: ${decisions.length}件決定, ${reversals.length}件REVERSE`, JSON.stringify({ b1Ms, b2Ms, signals: decisions.map(d => `${d.pair}:${d.decision}`) }));
    } catch {}
  })();

  return { decisions, reversals, newsAnalysis: stage1.news_analysis };
}

// ── runAnalysis: 5分ごと実行（Path B・Breakout・SPRT・ParamReview・AutoApproval）──
export async function runAnalysis(env: Env): Promise<void> {
  const now = new Date();
  const cronStart = Date.now();
  // runId は scheduled ハンドラーで withRunId() により注入済み
  const runId = getRunId() ?? '?';
  console.log(`[fx-sim] analysis start ${now.toISOString()} runId=${runId}`);

  try {
    // リアルタイムデータ取得（core_shared_data への依存を廃止）
    // - ニュース : analysis_news キャッシュ（runCore が毎分更新、最大 ~1 分前のデータ）
    // - 価格/指標: getMarketIndicators（内部 DB キャッシュ）+ getUSDJPY（Frankfurter）
    //             → runCore 直後に呼ぶため追加 API コールはほぼゼロ
    // - 週末文脈: 個別キャッシュキーから独立再構築（buildWeekendContext）
    const tFetch = Date.now();
    const {
      news,
      indicators,
      prices,
      weekendContext,
      fetchAnalysisMs,
    } = await fetchAnalysisData(env, now);
    const fetchMs = fetchAnalysisMs; // タイミングログ用（旧 coreData.fetchMs に相当）
    await insertSystemLog(env.DB, 'INFO', 'FLOW', 'ANALYSIS_FETCH完了', JSON.stringify({
      ms: fetchMs, news: news.length,
      prices: [...prices.values()].filter(v => v != null).length,
      tFetch: Date.now() - tFetch,
    }));

    // 2.8 ニューストリガー（緊急→PATH_B強制）
    try {
      const triggerResult = await runNewsTrigger(env.DB, getApiKey(env));
      if (triggerResult.triggerType !== 'NONE') {
        console.log(`[fx-sim] NEWS_TRIGGER: ${triggerResult.triggerType} title=${triggerResult.newsTitle?.slice(0, 50)}`);
      }
    } catch (e) {
      console.warn(`[fx-sim] runNewsTrigger error: ${String(e).slice(0, 80)}`);
    }

    // 3. 共有ニュースストア構築 + Path B 実行（計測開始）
    // 最適化: prevNewsHash / lastPathBAt / openPairs / emergencyForce を並列取得
    const t2 = Date.now();
    const currentNewsHash = newsHash(news);
    const [prevNewsHashRaw, allOpenRawForPathB, lastPathBRaw, emergencyForce] = await Promise.all([
      getCacheValue(env.DB, PREV_NEWS_HASH_KEY),
      env.DB.prepare(`SELECT pair FROM positions WHERE status = 'OPEN'`).all<{ pair: string }>(),
      getCacheValue(env.DB, 'last_path_b_at'),
      consumeEmergencyForceFlag(env.DB),
    ]);
    const hasChanged = currentNewsHash !== (prevNewsHashRaw ?? '');
    await setCacheValue(env.DB, PREV_NEWS_HASH_KEY, currentNewsHash);

    const sharedNewsStore: SharedNewsStore = { items: news, hash: currentNewsHash, hasChanged };
    const openPairsForPathB = new Set((allOpenRawForPathB.results ?? []).map(p => p.pair));

    // news_summary: JSON形式で保存（titleのみ、切り詰めなし）
    const newsSummary = news.length > 0
      ? JSON.stringify(news.slice(0, 5).map((n) => ({
          title: n.title,
        })))
      : null;

    let pathBResult: PathBResult = { decisions: [], reversals: [], newsAnalysis: [] };
    let pathBMs = 0; // Path B 実行時間（AI呼び出し含む）

    // Path B 最小間隔チェック（5分）— 需要削減で429を構造的に防止
    // 緊急ニューストリガーがあれば間隔を無視して強制発火
    const PATH_B_MIN_INTERVAL_MS = 5 * 60 * 1000;
    const lastPathBAt = lastPathBRaw ? parseInt(lastPathBRaw) : 0;
    const pathBIntervalOk = emergencyForce || (Date.now() - lastPathBAt) >= PATH_B_MIN_INTERVAL_MS;

    if (emergencyForce) {
      await insertSystemLog(env.DB, 'INFO', 'PATH_B', 'PATH_B強制発火（緊急ニューストリガー）', '');
    }

    // Path B はニュースハッシュ変化かつ最小間隔OKの場合のみ実行
    const shouldRunPathB = sharedNewsStore.hasChanged && pathBIntervalOk;

    // 施策17: ブレイクアウト検知（ログ記録）
    // candles.tsのキャッシュにcandles[]が含まれている場合のみ動作
    // 最適化: 51銘柄の直列getCacheValueを1回のバッチクエリに統合
    {
      const breakoutTargets = INSTRUMENTS.filter(i =>
        !openPairsForPathB.has(i.pair) && prices.get(i.pair) != null
      );
      if (breakoutTargets.length > 0) {
        const candleKeys = breakoutTargets.map(i =>
          `candle_${(i as any).oandaSymbol ?? i.pair.replace('/', '_')}_H1`
        );
        const placeholders = candleKeys.map(() => '?').join(',');
        const rows = await env.DB.prepare(
          `SELECT key, value FROM market_cache WHERE key IN (${placeholders})`
        ).bind(...candleKeys).all<{ key: string; value: string }>();
        const candleCache = new Map((rows.results ?? []).map(r => [r.key, r.value]));

        for (let idx = 0; idx < breakoutTargets.length; idx++) {
          const instr = breakoutTargets[idx];
          const currentRate = prices.get(instr.pair)!;
          const cacheRaw = candleCache.get(candleKeys[idx]);
          if (!cacheRaw) continue;
          try {
            const cached = JSON.parse(cacheRaw) as { indicators?: Record<string, unknown>; candles?: unknown[] };
            if (!cached.candles || cached.candles.length < 20 || !cached.indicators) continue;
            const bk = detectBreakout(cached.candles as any, cached.indicators as any, currentRate);
            if (bk.detected && bk.genuine && bk.confidence >= 70) {
              console.log(`[fx-sim] BREAKOUT ${instr.pair} ${bk.type} conf=${bk.confidence}%`);
              void insertSystemLog(env.DB, 'INFO', 'BREAKOUT',
                `ブレイクアウト検知: ${instr.pair} ${bk.type} conf=${bk.confidence}%`,
                JSON.stringify({ rangeHigh: bk.rangeHigh, rangeLow: bk.rangeLow, rate: currentRate })
              ).catch(() => {});
            }
          } catch { /* キャッシュ破損無視 */ }
        }
      }
    }

    if (sharedNewsStore.hasChanged && !pathBIntervalOk) {
      const elapsedSec = Math.round((Date.now() - lastPathBAt) / 1000);
      console.log(`[fx-sim] Path B: 最小間隔未達（${elapsedSec}s < 300s）→スキップ`);
    }

    // ── Path B 後処理関数（REVERSE + ポジション開設 + decisions INSERT + キャッシュ更新）──
    // 直列/並列どちらでも同じ後処理を使う（DRY原則: ap.md §ソフトウェア設計）
    const applyPathBResults = async (result: PathBResult): Promise<Set<string>> => {
      const handledPairs = new Set([
        ...result.decisions.map(d => d.pair),
        ...result.reversals,
      ]);

      // REVERSE: 既存ポジションをクローズ
      if (result.reversals.length > 0) {
        for (const pair of result.reversals) {
          const rate = prices.get(pair);
          if (rate == null) continue;
          try {
            const openPos = await env.DB.prepare(
              `SELECT id, direction, entry_rate, sl_rate FROM positions WHERE pair = ? AND status = 'OPEN' LIMIT 1`
            ).bind(pair).first<{ id: number; direction: string; entry_rate: number; sl_rate: number | null }>();
            if (openPos) {
              const revInstr = INSTRUMENTS.find(i => i.pair === pair);
              const multiplier = revInstr?.pnlMultiplier ?? 100;
              const pnl = openPos.direction === 'BUY'
                ? (rate - openPos.entry_rate) * multiplier
                : (openPos.entry_rate - rate) * multiplier;
              const lr = logReturn(openPos.entry_rate, rate);
              const realizedRR = openPos.sl_rate != null
                ? calcRealizedRR(openPos.direction, openPos.entry_rate, rate, openPos.sl_rate)
                : undefined;
              await closePosition(env.DB, openPos.id, rate, 'B2_REVERSE', pnl, lr, realizedRR);
              await insertSystemLog(env.DB, 'INFO', 'PATH_B', `B2_REVERSE クローズ: ${pair} @ ${rate}`);
            }
          } catch (e) {
            console.warn(`[fx-sim] Path B REVERSE close failed (${pair}): ${String(e).slice(0, 80)}`);
          }
        }
      }

      // BUY/SELL: ポジション開設
      if (result.decisions.length > 0) {
        // DD STOPチェック: dd_stopped=true の場合は PATH_B 経由のエントリーも停止
        // （B2 CB 発動→B1フォールバックでも DD STOP をバイパスしないための保護）
        const ddCheckForPathB = await getDrawdownLevel(env.DB);
        if (ddCheckForPathB.level === 'STOP') {
          await insertSystemLog(env.DB, 'WARN', 'RISK',
            'DD STOP: PATH_Bエントリー全銘柄スキップ',
            `DD=${ddCheckForPathB.ddPct.toFixed(1)}% decisions=${result.decisions.length}件`);
          return handledPairs;
        }
        let pathBNewEntries = 0; // W005: このtickの新規開設数
        const PATH_B_OPEN_LIMIT = 10; // W005: 全体OPEN上限
        for (const dec of result.decisions) {
          if (dec.decision === 'HOLD') continue;
          const currentRate = prices.get(dec.pair);
          if (currentRate == null || currentRate <= 0) continue; // レート0は取得失敗扱い
          if (openPairsForPathB.has(dec.pair)) continue;
          // W005: OPEN上限ハードブロック（初期OPEN + このtick新規合計が上限以上なら停止）
          if (openPairsForPathB.size + pathBNewEntries >= PATH_B_OPEN_LIMIT) {
            await insertSystemLog(env.DB, 'WARN', 'RISK',
              `PATH_B OPEN上限ブロック: ${dec.pair}`,
              `OPEN=${openPairsForPathB.size + pathBNewEntries}/${PATH_B_OPEN_LIMIT}`
            ).catch(() => {});
            continue;
          }
          // 銘柄別日次損失上限チェック（テスタ流: シナリオ崩壊銘柄はやらない）
          const instDailyB = await checkInstrumentDailyLoss(env.DB, dec.pair, new Date());
          if (instDailyB.paused) {
            await insertSystemLog(env.DB, 'INFO', 'RISK',
              `PATH_B 銘柄日次Cap超過スキップ: ${dec.pair}`,
              `dailyPnl=${instDailyB.dailyPnl.toFixed(0)}円`);
            continue;
          }
          try {
            const instrument = INSTRUMENTS.find(i => i.pair === dec.pair);
            if (!instrument) continue;
            const sanity = checkTpSlSanity({
              direction: dec.decision as 'BUY' | 'SELL',
              rate: currentRate,
              tp: dec.tp_rate,
              sl: dec.sl_rate,
              instrument,
            });
            if (!sanity.valid) {
              await insertSystemLog(env.DB, 'WARN', 'SANITY', `Path B TP/SL異常値拒否: ${dec.pair}`, sanity.reason ?? undefined);
              continue;
            }
            const finalTp = sanity.correctedTp ?? dec.tp_rate;
            const finalSl = sanity.correctedSl ?? dec.sl_rate;
            if (sanity.correctedTp != null || sanity.correctedSl != null) {
              console.log(`[fx-sim] Path B TP/SL補正: ${dec.pair} TP ${dec.tp_rate}→${finalTp} SL ${dec.sl_rate}→${finalSl}`);
            }
            const pathBInstr = INSTRUMENTS.find(i => i.pair === dec.pair);
            await openPosition(env.DB, dec.pair, dec.decision as 'BUY' | 'SELL', currentRate, finalTp, finalSl, 'paper', null, getWebhookUrl(env),
              { pnlMultiplier: pathBInstr?.pnlMultiplier, trigger: 'NEWS' });
            pathBNewEntries++; // W005: 成功したらカウント増加
            await insertSystemLog(env.DB, 'INFO', 'PATH_B', `ポジション開設: ${dec.pair} ${dec.decision} @ ${currentRate}`, JSON.stringify({ tp: finalTp, sl: finalSl }));
          } catch (e) {
            console.warn(`[fx-sim] Path B openPosition failed (${dec.pair}): ${String(e).slice(0, 80)}`);
          }
        }
      }

      // decisions テーブルに記録
      if (result.decisions.length > 0) {
        const stmt = env.DB.prepare(
          `INSERT INTO decisions (pair, rate, decision, tp_rate, sl_rate, reasoning, news_summary, vix, us10y, nikkei, sp500, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        await env.DB.batch(result.decisions.map(d => {
          const relevantNews = (d.news_analysis ?? result.newsAnalysis)
            .filter(a => a.attention && a.affected_pairs.includes(d.pair))
            .slice(0, 5)
            .map(a => ({ title: a.title_ja || news[a.index]?.title_ja || (news[a.index]?.title ?? ''), title_ja: a.title_ja, impact: a.impact }));
          const summaryItems = relevantNews.length > 0
            ? relevantNews
            : (d.news_analysis ?? result.newsAnalysis)
                .filter(a => a.attention).slice(0, 3)
                .map(a => ({ title: a.title_ja || news[a.index]?.title_ja || (news[a.index]?.title ?? ''), title_ja: a.title_ja, impact: a.impact }));
          const pathBNewsSummary = summaryItems.length > 0 ? JSON.stringify(summaryItems) : newsSummary;
          return stmt.bind(
            d.pair, prices.get(d.pair) ?? d.rate, d.decision, d.tp_rate, d.sl_rate,
            `[PATH_B] ${d.reasoning}`, pathBNewsSummary,
            indicators.vix, indicators.us10y, indicators.nikkei, indicators.sp500,
            now.toISOString()
          );
        }));
      }

      // news_analysis + latest_news キャッシュ更新
      if (result.newsAnalysis.length > 0) {
        const enriched = result.newsAnalysis.map(a => {
          // 同バッチのtrade_decisionsから該当ペアの判断を紐付け
          const pairedDecisions = (result.decisions ?? [])
            .filter(d => (a.affected_pairs ?? []).includes(d.pair))
            .map(d => ({ pair: d.pair, decision: d.decision, reasoning: d.reasoning?.replace(/^\[PATH_B\] /, '').slice(0, 60) ?? null }));
          // hold_reason: 注目ニュースで行動しなかった理由（機会損失の可視化）
          let hold_reason: string | null = null;
          if (a.attention && pairedDecisions.length === 0) {
            const hasOpenPos = (a.affected_pairs ?? []).some((p: string) => openPairsForPathB.has(p));
            hold_reason = hasOpenPos ? '既存ポジションあり' : 'AI判断: 様子見';
          }
          return {
            ...a,
            title: news[a.index]?.title_ja || (news[a.index]?.title ?? null),
            pubDate: news[a.index]?.pubDate ?? null,
            description: news[a.index]?.desc_ja || (news[a.index]?.description ?? null),
            source: (news[a.index] as any)?.source ?? null,
            trade_decisions: pairedDecisions.length > 0 ? pairedDecisions : null,
            hold_reason,
          };
        });

        // ── 過去24時間ローリングウィンドウ蓄積（上書きではなくマージ）──
        const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
        const existingAnalysisRaw = await getCacheValue(env.DB, 'news_analysis');
        const existingAnalysis: any[] = existingAnalysisRaw
          ? (() => { try { return JSON.parse(existingAnalysisRaw); } catch { return []; } })()
          : [];
        const existingIn24h = existingAnalysis.filter((e: any) => {
          const d = e.pubDate || e.analyzed_at || '';
          return d ? new Date(d).getTime() >= cutoff24h : false;
        });
        const newTitles = new Set(enriched.map((e: any) => e.title));
        const preserved = existingIn24h.filter((e: any) => !newTitles.has(e.title));
        const mergedAnalysis = [...enriched, ...preserved].slice(0, 80);
        await setCacheValue(env.DB, 'news_analysis', JSON.stringify(mergedAnalysis));

        // latest_news も過去24時間蓄積
        const existingLatestRaw = await getCacheValue(env.DB, 'latest_news');
        const existingLatest: any[] = existingLatestRaw
          ? (() => { try { return JSON.parse(existingLatestRaw); } catch { return []; } })()
          : [];
        const newLatestTitles = new Set(news.slice(0, 30).map((n: any) => n.title));
        const preservedLatest = existingLatest.filter((n: any) => {
          const d = n.pubDate || '';
          return d ? new Date(d).getTime() >= cutoff24h && !newLatestTitles.has(n.title) : false;
        });
        const mergedLatest = [
          ...news.slice(0, 30).map(n => ({ ...n, title_ja: n.title_ja || null })),
          ...preservedLatest,
        ].slice(0, 100);
        await setCacheValue(env.DB, 'latest_news', JSON.stringify(mergedLatest));
      }

      // 機会損失トラッキング: attention=true だがシグナルなしのペアを HOLD 記録
      const attentionPairs = new Set<string>();
      for (const a of result.newsAnalysis) {
        if (a.attention) {
          for (const p of (a.affected_pairs ?? [])) attentionPairs.add(p);
        }
      }
      const holdPairs = [...attentionPairs].filter(p => !handledPairs.has(p));
      if (holdPairs.length > 0) {
        try {
          const holdStmt = env.DB.prepare(
            `INSERT INTO decisions (pair, rate, decision, tp_rate, sl_rate, reasoning, news_summary, vix, us10y, nikkei, sp500, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          );
          await env.DB.batch(holdPairs.map(pair => {
            const reason = openPairsForPathB.has(pair)
              ? '既存ポジションあり（機会損失候補）'
              : 'ニュース注目・シグナルなし（機会損失候補）';
            return holdStmt.bind(
              pair, prices.get(pair) ?? 0, 'HOLD', null, null,
              `[PATH_B_HOLD] ${reason}`, newsSummary,
              indicators.vix, indicators.us10y, indicators.nikkei, indicators.sp500,
              now.toISOString()
            );
          }));
        } catch (e) {
          console.warn(`[fx-sim] Path B HOLD記録失敗: ${String(e).slice(0, 80)}`);
        }
      }

      return handledPairs;
    };

    // ── Path B（ニュースドリブン AI）のみ実行 ─────────────────────────────
    // Path A（AI常時監視）は Ph.6 にて廃止。ロジック判断はRunLogicDecisionsで実施済み。
    let newsMs: number;

    // 絶対タイムリミットガード: cronStart から45秒超過でPathBをスキップ
    // Workers wall-clock 60秒制限への二重防衛（一次: newsStage1 slice(0,5)）
    const ANALYSIS_HARD_LIMIT_MS = 45_000;
    const elapsedBeforePathB = Date.now() - cronStart;
    if (elapsedBeforePathB > ANALYSIS_HARD_LIMIT_MS) {
      console.warn(`[fx-sim] analysis: 経過${Math.round(elapsedBeforePathB / 1000)}s > 45s → PathBスキップ（タイムリミットガード）`);
      await insertSystemLog(env.DB, 'WARN', 'CRON', 'PathBスキップ（45秒タイムリミットガード）',
        JSON.stringify({ elapsedMs: elapsedBeforePathB }));
    } else if (shouldRunPathB) {
      // ═══════════════════════════════════════════════════════════════
      // Path B: ニュースハッシュ変化時のみ実行（緊急/トレンドニュース専用AI）
      // ═══════════════════════════════════════════════════════════════
      try {
        // 施策6+20: USD/JPYのH1キャッシュからレジーム計算（失敗時は無視）
        let regimeContext: { text: string; prohibitions: string } | undefined;
        try {
          const cacheRaw = await getCacheValue(env.DB, 'candle_USD_JPY_H1');
          if (cacheRaw) {
            const cached = JSON.parse(cacheRaw) as { indicators?: Record<string, unknown> };
            if (cached.indicators) {
              const regimeResult = determineRegime(cached.indicators as any);
              regimeContext = {
                text: formatRegimeForPrompt(regimeResult, cached.indicators as any),
                prohibitions: getRegimeProhibitions(regimeResult.regime),
              };
            }
          }
        } catch { /* regime計算失敗は従来動作を維持 */ }

        // 施策A/B/C: Phase -2/-1 のとき weekendContext を regimeText に追記
        if (weekendContext && regimeContext) {
          regimeContext = {
            text: regimeContext.text + '\n\n' + weekendContext,
            prohibitions: regimeContext.prohibitions,
          };
        } else if (weekendContext && !regimeContext) {
          regimeContext = { text: weekendContext, prohibitions: '' };
        }

        const tPathB = Date.now();
        pathBResult = await runPathB(env, sharedNewsStore, indicators, openPairsForPathB, getAllApiKeys(env), {
          openaiApiKey: env.OPENAI_API_KEY,
          anthropicApiKey: env.ANTHROPIC_API_KEY,
        }, regimeContext, prices);
        pathBMs = Date.now() - tPathB;
        await setCacheValue(env.DB, 'last_path_b_at', String(Date.now()));
        console.log(`[fx-sim] Path B: ${pathBResult.decisions.length}件シグナル, ${pathBResult.reversals.length}件REVERSE (${pathBMs}ms)`);
      } catch (e) {
        if (e instanceof RateLimitError) {
          markKeyCooldown(e.apiKey, e.retryAfterSec);
        }
        cbRecordFailure();
        console.warn(`[fx-sim] Path B failed: ${String(e).split('\n')[0].slice(0, 80)}`);
        await insertSystemLog(env.DB, 'WARN', 'PATH_B', 'Path B実行失敗', String(e).split('\n')[0].slice(0, 120));
      }
    }

    await insertSystemLog(env.DB, 'INFO', 'FLOW', 'PATH_B完了', JSON.stringify({
      ms: Date.now() - t2, hasChanged: sharedNewsStore.hasChanged,
      signals: pathBResult.decisions.length, reversals: pathBResult.reversals.length,
    }));

    // Path B 後処理（ポジション開設・decisions記録）
    // AbortError等でPath Bが失敗してもpathBResultは空配列で安全に通過する。
    // applyPathBResults自体の例外（DB書き込み失敗等）で後段処理が止まらないよう保護する。
    try {
      await applyPathBResults(pathBResult);
    } catch (e) {
      console.warn(`[fx-sim] applyPathBResults failed: ${String(e).split('\n')[0].slice(0, 80)}`);
      await insertSystemLog(env.DB, 'WARN', 'PATH_B', 'Path B後処理失敗（DB書き込み等）', String(e).split('\n')[0].slice(0, 120)).catch(() => {});
    }

    newsMs = Date.now() - t2;

    const totalMs = Date.now() - cronStart;
    console.log(`[fx-sim] analysis timings: news=${newsMs}ms pathB=${pathBMs}ms total=${totalMs}ms`);

    // T014: SPRT 評価（DB専用で軽量 ~5ms）
    try {
      await evaluateRecoveryIfNeeded(env.DB);
    } catch (e) {
      console.warn(`[fx-sim] evaluateRecoveryIfNeeded error: ${String(e).slice(0, 80)}`);
    }

    // パラメーターレビュー（1銘柄のみ、時間予算内で実行）
    let paramReviewMs = 0;
    if (totalMs <= 25000) {
      try {
        const tParam = Date.now();
        const tierDPairs = INSTRUMENTS.filter(i => i.tier === 'D').map(i => i.pair);
        const reviewResult = await runParamReview(env.DB, getApiKey(env), env.OPENAI_API_KEY, tierDPairs);
        paramReviewMs = Date.now() - tParam;
        if (reviewResult.reviewed) {
          console.log(`[fx-sim] PARAM_REVIEW: ${reviewResult.pair} updated — ${reviewResult.summary}`);
        }
      } catch (e) {
        console.warn(`[fx-sim] runParamReview error: ${String(e).slice(0, 100)}`);
      }
    }

    // AutoApproval（毎時0分台のみ）
    if (now.getUTCMinutes() < 5) {
      try {
        const { processAutoApproval: autoApprove } = await import('../rotation');
        await autoApprove(env.DB);
      } catch (e) {
        console.warn(`[fx-sim] autoApprove error: ${String(e).slice(0, 80)}`);
      }
    }

    // 実行時間計測
    const grandTotal = totalMs + paramReviewMs;
    // tpSlMs は runCore 側の処理のため runAnalysis では計測しない（除外）
    const timingsWithParam = { fetchMs, newsMs, pathBMs, paramReviewMs, grandTotalMs: grandTotal };
    await setCacheValue(env.DB, 'cron_phase_timings', JSON.stringify(timingsWithParam));
    if (grandTotal > 60000) {
      await insertSystemLog(env.DB, 'WARN', 'CRON',
        `analysis実行時間超過: ${grandTotal}ms`,
        JSON.stringify(timingsWithParam));
    }

    console.log(`[fx-sim] analysis done in ${grandTotal}ms`);

  } catch (e) {
    console.error('[fx-sim] analysis unhandled error:', e);
    await sendNotification(
      getWebhookUrl(env),
      `🔴 [fx-sim] analysis エラー: ${String(e).slice(0, 500)}`,
    );
    try {
      await insertSystemLog(env.DB, 'ERROR', 'CRON', 'analysis 予期しないエラー', String(e).slice(0, 2000));
    } catch {}
  }
}

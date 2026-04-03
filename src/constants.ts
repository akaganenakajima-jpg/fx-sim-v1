/**
 * プロジェクト全体共有定数 — Single Source of Truth
 *
 * 参照パターン: src/weekend.ts の CRYPTO_PAIRS と同じエクスポート形式
 * バックエンド: import { X } from './constants' で直接使用
 * フロントエンド: app.js.ts のテンプレートリテラルに ${X} でビルド時注入
 *   （dashboard.ts の CSS_VERSION と全く同じパターン）
 *
 * ⚠️ 以下はここに入れない:
 *   - Era 分割日付（2026-03-25T00:00:00Z 等）→ 歴史的事実、api.ts に残す
 *   - DB クエリ LIMIT 値（30, 50）→ SQL パフォーマンスチューニング値
 *   - greenWords 配列・formatRate() 銘柄名 → 別 PR で対応
 *   - RR_BADGE_BLUE = 1.0 → CLAUDE.md §勝率の公式定義により変更禁止
 */

// ─── 資金管理 ─────────────────────────────────────────────────────────────────
/**
 * シミュレーション初期資本（円）
 * ROI・ドローダウン・エクイティカーブ・リスク管理の全計算基準
 * 変更時は D1 の risk_state.hwm（ハイウォーターマーク）も確認すること
 */
export const INITIAL_CAPITAL = 10_000;

// ─── ドローダウン段階閾値（テスタ理論準拠） ─────────────────────────────────────
/**
 * テスタ氏のDD管理実績:
 *   デイトレ時代: max DD −10%（all-time HWM比）
 *   中長期移行後: max DD −20%（all-time HWM比）
 *   出典: https://x.com/tesuta001/status/1731166226410537088
 *
 * WARNING(10%) = テスタのデイトレ上限。ここを超えると本格的な警戒ライン
 * STOP(20%)    = テスタのスイング上限。ここで完全停止
 */
export const DD_CAUTION  =  7;  // Half Kelly
export const DD_WARNING  = 10;  // Quarter Kelly — テスタ デイトレ上限
export const DD_HALT     = 15;  // Micro Kelly
export const DD_STOP     = 20;  // 完全停止 — テスタ スイング上限

/**
 * 銘柄別日次損失上限（テスタ流「シナリオ崩壊銘柄はやらない」の自動化）
 * 1銘柄が1日にこれ以上負けたら、その日はその銘柄をスキップする
 * UTC 00:00 で自動リセット（SQL の WHERE closed_at >= todayStart で実現）
 */
export const INSTRUMENT_DAILY_LOSS_CAP = 100;  // ¥100/銘柄/日

// ─── 勝率表示閾値 ──────────────────────────────────────────────────────────────
/**
 * 勝率グリーン表示の閾値（% 単位の整数）
 * 根拠: avgRR 2.0 の場合、勝率35% で EV = 0.35×2.0 - 0.65 = +0.05（EV 正）
 * ⚠️ CLAUDE.md §勝率の公式定義（RR≥1.0 基準）と整合して設定すること
 */
export const WIN_RATE_GREEN_THRESHOLD = 35;   // % 単位（整数）

/** 勝率マトリクス「緑濃」閾値（小数単位） */
export const WIN_RATE_MATRIX_HIGH = 0.40;

/** 勝率マトリクス「緑薄」閾値（小数単位）— WIN_RATE_GREEN_THRESHOLD / 100 と対応 */
export const WIN_RATE_MATRIX_LOW  = 0.35;

// ─── RR バッジ色分け ──────────────────────────────────────────────────────────
/** RR バッジ緑（優良）閾値: リスク1に対しリターン2以上 */
export const RR_BADGE_GREEN = 2.0;

/**
 * RR バッジ青（合格）閾値
 * ⚠️ CLAUDE.md §勝率の公式定義により 1.0 変更禁止
 * （勝ち = 実現RR ≥ 1.0 の定義と連動）
 */
export const RR_BADGE_BLUE  = 1.0;

// ─── ニューススコア閾値 ────────────────────────────────────────────────────────
/**
 * EMERGENCY バッジ閾値（PATH_B 強制発火・緊急バナー表示）
 * composite_score は 0〜100 スケール（AI返却値0〜10 を *10 して保存）
 * @see src/news-trigger.ts
 */
export const NEWS_SCORE_EMERGENCY = 90;

/**
 * TREND_INFLUENCE バッジ閾値（影響銘柄のパラメーター一時調整）
 * composite_score は 0〜100 スケール
 * @see src/news-trigger.ts
 */
export const NEWS_SCORE_TREND = 70;

/**
 * EMERGENCY 判定: 個別軸スコア最小値（AIが 0〜10 で返す値）
 * composite_score とは独立したスケール（*10 変換なし）
 * @see src/news-trigger.ts
 */
export const NEWS_TRIGGER_EMERGENCY_RELEVANCE = 9;   // 市場有効性
export const NEWS_TRIGGER_EMERGENCY_SENTIMENT = 8;   // シグナル強度

/**
 * TREND_INFLUENCE 判定: 個別軸スコア最小値（AIが 0〜10 で返す値）
 * @see src/news-trigger.ts
 */
export const NEWS_TRIGGER_TREND_RELEVANCE = 7;       // 市場有効性
export const NEWS_TRIGGER_TREND_SENTIMENT = 7;       // シグナル強度

// ─── VIX ヒートマップ ─────────────────────────────────────────────────────────
/** VIX 効果ヒートマップ: 警告オレンジ表示閾値（高影響） */
export const VIX_EFFECT_HIGH = 0.65;

/** VIX 効果ヒートマップ: 薄いオレンジ表示閾値（中影響） */
export const VIX_EFFECT_LOW  = 0.40;

// ─── UI 表示件数 ──────────────────────────────────────────────────────────────
/** PC サイドパネルのニュース表示上限件数 */
export const UI_NEWS_PANEL_LIMIT  = 10;

/** エラーバナーで検査するシステムログ件数 */
export const UI_ERROR_CHECK_COUNT = 5;

// ─── アニメーション・タイミング ───────────────────────────────────────────────
/** PnL カウントアップアニメーション時間（ms） */
export const ANIMATION_DURATION_MS = 800;

/** スクロールディープリンク後のハイライト解除遅延（ms） */
export const SCROLL_DELAY_MS = 150;

// ─── ポーリング間隔 ───────────────────────────────────────────────────────────
/** ローテーションデータ更新間隔（ms） */
export const ROTATION_POLL_MS = 60_000;

/** パラメーターデータ更新間隔（ms） */
export const PARAMS_POLL_MS = 60_000;

// ─── 緊急バナー TTL ───────────────────────────────────────────────────────────
/** 緊急ニュースバナーの表示有効期間（ms）= 10 分 */
export const EMERGENCY_BANNER_TTL_MS = 10 * 60 * 1_000;

// ─── 統計信頼度境界 ───────────────────────────────────────────────────────────
/** 戦略信頼度 'trusted'（十分なサンプル数）の最低取引件数 */
export const RELIABILITY_TRUSTED = 200;

/** 戦略信頼度 'tentative'（参考サンプル数）の最低取引件数 */
export const RELIABILITY_TENTATIVE = 50;

// ─── ポジション・リスク管理ハードコード排除 ─────────────────────────────────
/** 全体の最大オープンポジション数 */
export const MAX_OPEN_POSITIONS = 10;
/** TP後の逆張り禁止期間（分） */
export const TP_COOLDOWN_MIN = 60;
/** 相関グループのSL後クールダウン（ミリ秒） */
export const CORRELATION_GROUP_COOLDOWN_MS = 30 * 60 * 1000;
/** 1トレードあたりの最大リスク（残高に対する割合） */
export const MAX_RISK_PER_TRADE_PCT = 0.01;
/** Kelly基準を適用する最低取引回数 */
export const MIN_TRADES_FOR_KELLY = 20;

// ─── ロジック・インジケーター判定ハードコード排除 ─────────────────────────────
/** Volatileレジーム判定: VIX閾値 */
export const REGIME_VOLATILE_VIX = 30;
/** Volatileレジーム判定: ATRが平均の何倍を超えたか */
export const REGIME_VOLATILE_ATR_MULT = 2.5;
/** サポレジ近接度スコアのルックバック期間（ローソク足本数） */
export const SR_LOOKBACK_PERIOD = 20;
/** プライスアクション判定のルックバック期間（ローソク足本数） */
export const PA_LOOKBACK_PERIOD = 3;

// ─── システム監視ハードコード排除 ──────────────────────────────────────────
/** 市場開始想定時刻（UTC時） */
export const MARKET_START_HOUR_UTC = 3;
/** 日次シグナル発火目標件数 */
export const DAILY_SIGNAL_TARGET = 100;

// ─── ニュース評価重み ───────────────────────────────────────────────────
/** ニュース7軸スコア重み（通常）[t, u, r, c, s, b, n] */
export const NEWS_WEIGHTS_DEFAULT = { t: 0.20, u: 0.15, r: 0.30, c: 0.15, s: 0.10, b: 0.05, n: 0.05 };
/** ニュース7軸スコア重み（個別株用: breadthをrに再配分） */
export const NEWS_WEIGHTS_STOCK   = { t: 0.20, u: 0.15, r: 0.35, c: 0.15, s: 0.10, b: 0.00, n: 0.05 };

// ─── CSS バージョン ───────────────────────────────────────────────────────────
/**
 * style.css のキャッシュバスティングバージョン番号
 * デプロイ時に CSS を変更した場合はここをインクリメントする
 * @see src/dashboard.ts（このファイルを import して使用）
 */
export const CSS_VERSION = 17;

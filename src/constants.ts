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
 * @see src/news-trigger.ts
 */
export const NEWS_SCORE_EMERGENCY = 90;

/**
 * TREND_INFLUENCE バッジ閾値（影響銘柄のパラメーター一時調整）
 * @see src/news-trigger.ts
 */
export const NEWS_SCORE_TREND = 70;

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

// ─── CSS バージョン ───────────────────────────────────────────────────────────
/**
 * style.css のキャッシュバスティングバージョン番号
 * デプロイ時に CSS を変更した場合はここをインクリメントする
 * @see src/dashboard.ts（このファイルを import して使用）
 */
export const CSS_VERSION = 17;

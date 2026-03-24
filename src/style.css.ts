// Apple HIG ダークテーマ CSS（+ ライトモード対応）
// iPhone「株価」アプリ風ウォッチリスト / SF Pro / 8pt grid / 44pt touch targets

export const CSS = `
/* ─── Design Tokens ─── */
:root {
  --bg:               #000000;
  --bg-elevated:      #1C1C1E;
  --bg-secondary:     #2C2C2E;
  --bg-tertiary:      #3A3A3C;
  --separator:        #38383A;
  --label:            #FFFFFF;
  --label-secondary:  #8E8E93;
  --green:            #30D158;
  --red:              #FF453A;
  --orange:           #FF9F0A;
  --blue:             #0A84FF;
  --teal:             #5AC8FA;
  --purple:           #BF5AF2;
  --label-tertiary:   rgba(235,235,245,0.3);
  --label-quaternary: rgba(235,235,245,0.18);
  --radius:           16px;
  --radius-sm:        10px;
  /* PC responsive */
  --sidebar-bg:       var(--bg);
  --sidebar-width:    clamp(56px, 3.5vw, 72px);
  --panel-bg:         var(--bg-elevated);
  --panel-width:      clamp(300px, 18vw, 420px);
  --panel-border:     var(--separator);
  --container-max:    clamp(1200px, 85vw, 2200px);
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg:               #F2F2F7;
    --bg-elevated:      #FFFFFF;
    --bg-secondary:     #E5E5EA;
    --bg-tertiary:      #D1D1D6;
    --separator:        #C6C6C8;
    --label:            #000000;
    --label-secondary:  #8A8A8E;
    --label-tertiary:   rgba(60,60,67,0.3);
    --label-quaternary: rgba(60,60,67,0.18);
    --green:            #34C759;
    --red:              #FF3B30;
    --orange:           #FF9500;
    --blue:             #007AFF;
    --teal:             #32ADE6;
    --purple:           #AF52DE;
  }
}
:root[data-theme="light"] {
  --bg:               #F2F2F7;
  --bg-elevated:      #FFFFFF;
  --bg-secondary:     #E5E5EA;
  --bg-tertiary:      #D1D1D6;
  --separator:        #C6C6C8;
  --label:            #000000;
  --label-secondary:  #8A8A8E;
  --label-tertiary:   rgba(60,60,67,0.3);
  --label-quaternary: rgba(60,60,67,0.18);
  --green:            #34C759;
  --red:              #FF3B30;
  --orange:           #FF9500;
  --blue:             #007AFF;
  --teal:             #32ADE6;
  --purple:           #AF52DE;
}

/* ─── Reset ─── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html {
  background: var(--bg);
  height: 100%;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  background: var(--bg);
  color: var(--label);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  padding-right:  env(safe-area-inset-right);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left:   env(safe-area-inset-left);
  min-height: 100dvh;
  -webkit-overflow-scrolling: touch;
}
body.drawer-open,
body.sheet-open {
  overflow: hidden !important;
  touch-action: none;
}

#app { min-height: 100dvh; }

/* ─── Header ─── */
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: calc(env(safe-area-inset-top) + 12px) 20px 12px;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  background: rgba(28,28,30,0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(84,84,88,0.3);
  -webkit-user-select: none;
  user-select: none;
}
.header-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.6px;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.header-time {
  font-size: 12px;
  color: var(--label-secondary);
  font-variant-numeric: tabular-nums;
}
.refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -8px -8px -8px 0;
  background: none;
  border: none;
  color: var(--blue);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  border-radius: 50%;
  transition: opacity 0.15s ease;
}
.refresh-btn:active {
  opacity: 0.5;
}
.refresh-btn.spinning svg {
  animation: spin 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

/* ─── Content ─── */
.content {
  padding: calc(env(safe-area-inset-top) + 74px) 16px 48px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-x: hidden;
}
body, #app {
  overflow-x: hidden;
}

/* ─── Card ─── */
.card {
  background: var(--bg-elevated);
  border-radius: var(--radius);
  padding: 16px;
}

/* ─── パラメータータブ切り替えボタン ─── */
.params-tab-btn {
  background: var(--fill-secondary);
  border: none;
  border-radius: 7px;
  color: var(--label-secondary);
  font-size: 12px;
  font-weight: 500;
  padding: 5px 12px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s, color 0.15s;
}
.params-tab-btn.active {
  background: #007aff;
  color: #fff;
  font-weight: 600;
}

/* ─── Hero PnL ─── */
.card-hero { padding: 16px; }
.hero-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--label-secondary);
  letter-spacing: 0.2px;
  margin-bottom: 8px;
}
.hero-pnl {
  font-size: 44px;
  font-weight: 700;
  letter-spacing: -2px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  margin-bottom: 4px;
  transition: color 0.3s ease;
}
.hero-sub {
  display: flex;
  align-items: stretch;
  padding-top: 12px;
  border-top: 1px solid var(--separator);
}
.hero-sub-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.hero-sub-label {
  font-size: 11px;
  color: var(--label-secondary);
}
.hero-sub-value {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.3px;
  white-space: nowrap;
  transition: color 0.3s ease;
}
.hero-divider {
  width: 1px;
  background: var(--separator);
  flex-shrink: 0;
}

/* ─── Watchlist（株価アプリ風） ─── */
.card-watchlist { padding: 0; }
.card-watchlist .section-title { padding: 8px 16px 4px; }
.watchlist {
  margin-top: 8px;
}
.watchlist-skeleton {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 16px 16px;
}

/* 各銘柄行 */
.watch-row {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  min-height: 56px;
  border-bottom: 1px solid var(--separator);
  gap: 12px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: opacity 0.15s ease;
}
.watch-row:active { opacity: 0.6; }
.watch-row:last-child { border-bottom: none; }

/* 左: 銘柄名 + サブ情報 */
.watch-left {
  flex: 1;
  min-width: 0;
}
.watch-pair {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.watch-sub {
  font-size: 12px;
  color: var(--label-secondary);
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.watch-direction {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 2px 6px;
  border-radius: 6px;
}
.watch-direction-buy  { background: rgba(48,209,88,0.18);  color: var(--green); }
.watch-direction-sell { background: rgba(255,69,58,0.18);   color: var(--red);   }
.watch-direction-hold { background: var(--bg-secondary);    color: var(--label-secondary); }

/* 右: 現在値 + PnLバッジ */
.watch-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}
.watch-price {
  font-size: 17px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.3px;
}
.watch-pnl-badge {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 4px 8px;
  border-radius: 6px;
  letter-spacing: -0.3px;
}
.watch-pnl-pos { background: var(--green); color: #000; }
.watch-pnl-neg { background: rgba(255,69,58,0.18); color: var(--red); }
.watch-pnl-neu { background: var(--bg-secondary); color: var(--label-secondary); }

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .watch-pnl-pos { color: #000; }
  :root:not([data-theme="dark"]) .watch-pnl-neg { background: rgba(255,59,48,0.12); color: var(--red); }
  :root:not([data-theme="dark"]) .watch-direction-buy  { background: rgba(52,199,89,0.15); }
  :root:not([data-theme="dark"]) .watch-direction-sell { background: rgba(255,59,48,0.12); }
}

/* ─── Section header ─── */
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.section-title {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.2px;
}

/* ─── Badge ─── */
.badge {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 3px 10px;
  border-radius: 100px;
  text-transform: uppercase;
}
.badge-buy  { background: rgba(48,209,88,0.18);  color: var(--green); }
.badge-sell { background: rgba(255,69,58,0.18);   color: var(--red);   }
.badge-hold { background: var(--bg-secondary);    color: var(--label-secondary); }

/* ─── AI Rich Card ─── */
.ai-rich-card {
  margin: 0 16px;
  padding: 12px 14px;
  background: var(--bg-secondary);
  border-radius: 12px;
  border: 1px solid var(--separator);
}
.ai-rich-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.ai-rich-card .ai-badge { font-size: 11px; padding: 3px 8px; flex-shrink: 0; }
.ai-rich-pair { font-size: 14px; font-weight: 600; color: var(--label); }
.ai-rich-rate { font-size: 13px; color: var(--label-secondary); font-variant-numeric: tabular-nums; }
.ai-rich-time { font-size: 11px; color: var(--label-tertiary); margin-left: auto; flex-shrink: 0; }
.ai-rich-reasoning {
  font-size: 13px;
  line-height: 1.5;
  color: var(--label-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.ai-rich-reasoning.expanded {
  display: block;
  -webkit-line-clamp: unset;
  overflow: visible;
}
.ai-rich-status {
  font-size: 11px;
  color: var(--label-tertiary);
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--separator);
}
/* AI判断タブ用（従来スタイル維持） */
.card-ai {
  border: 1px solid rgba(10,132,255,0.25);
  position: relative;
  overflow: hidden;
}
.card-ai::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg,
    rgba(10,132,255,0.06) 0%,
    rgba(191,90,242,0.04) 50%,
    rgba(48,209,88,0.05) 100%);
  pointer-events: none;
}
.ai-time { font-size: 12px; color: var(--label-secondary); }
.ai-body {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  position: relative;
}
.ai-badge { font-size: 12px; padding: 4px 12px; flex-shrink: 0; }
.ai-reasoning {
  font-size: 13px;
  color: var(--label-secondary);
  line-height: 1.5;
  flex: 1;
}
.ai-status {
  font-size: 11px;
  color: var(--label-tertiary);
  margin-top: 4px;
}

/* ─── List header row ─── */
.list-header-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 16px 4px 8px;
}
.list-header {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.3px;
}
.link-btn {
  background: none;
  border: none;
  color: var(--blue);
  font-size: 15px;
  padding: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  min-height: 44px;
  display: flex;
  align-items: center;
}

/* ─── Decisions ─── */
.decisions-list { display: flex; flex-direction: column; gap: 4px; }
.decision-row {
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.decision-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.decision-pair {
  font-size: 12px;
  color: var(--blue);
  font-weight: 600;
  letter-spacing: 0.2px;
}
.decision-rate {
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.3px;
}
.decision-time { font-size: 12px; color: var(--label-secondary); }
.decision-meta { font-size: 12px; color: var(--label-secondary); font-variant-numeric: tabular-nums; }
.decision-reasoning {
  font-size: 13px;
  color: var(--label-secondary);
  line-height: 1.45;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* ─── PnL colors ─── */
.positive { color: var(--green); }
.negative { color: var(--red);   }
.neutral  { color: var(--label); }
.secondary-text { color: var(--label-secondary); font-size: 15px; }

/* ─── System footer ─── */
.system-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 20px 16px 8px;
  font-size: 12px;
  color: var(--label-secondary);
}
.sys-item { display: flex; align-items: center; gap: 4px; }
.sys-sep { width: 3px; height: 3px; background: var(--label-secondary); border-radius: 50%; opacity: 0.4; }
.sys-muted { opacity: 0.7; }

/* ─── Status dot ─── */
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  background: var(--green);
  border-radius: 50%;
  flex-shrink: 0;
  animation: pulse 2.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1;    transform: scale(1); }
  50%       { opacity: 0.4; transform: scale(0.85); }
}

/* ─── Skeleton ─── */
.skeleton-line {
  display: inline-block;
  background: linear-gradient(
    90deg, var(--bg-secondary) 25%, var(--bg-tertiary) 50%, var(--bg-secondary) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.6s ease-in-out infinite;
  border-radius: 6px;
  vertical-align: middle;
}
@keyframes shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* ─── パラメーター管理 UX心理学アニメーション（Ph.5 UI） ─── */
@keyframes urgent-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.55; }
}
@keyframes upgraded-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(48, 209, 88, 0); }
  50%       { box-shadow: 0 0 8px 2px rgba(48, 209, 88, 0.55); }
}
@keyframes emergency-flash {
  0%, 100% { background-color: var(--red); }
  50%       { background-color: #ff6b60; }
}

/* ─── パラメーターカード（Progressive Disclosure） ─── */
.param-card {
  border-radius: 12px;
  background: var(--bg-secondary);
  margin-bottom: 8px;
  overflow: hidden;
}
.param-card-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  min-height: 44px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}
.param-card-summary:active { opacity: 0.7; }
.param-chevron {
  font-size: 11px;
  color: var(--label-tertiary);
  transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
  flex-shrink: 0;
}
.param-card-detail {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease-out;
}
.param-card-detail.expanded {
  max-height: 300px;
}
.param-detail-inner {
  padding: 0 14px 12px;
  border-top: 1px solid var(--separator);
  margin-top: 0;
}
.param-grid-6 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding-top: 10px;
}
.param-grid-cell { text-align: center; }
.param-grid-cell .cell-label {
  font-size: 10px;
  color: var(--label-tertiary);
  margin-bottom: 2px;
}
.param-grid-cell .cell-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--label-primary);
}
.param-last-review {
  margin-top: 8px;
  font-size: 11px;
  color: var(--label-tertiary);
  text-align: center;
}

/* ─── 進捗バー（Goal Gradient） ─── */
.param-progress-track {
  height: 5px;
  background: var(--bg-tertiary);
  border-radius: 3px;
  margin: 4px 14px 6px;
  overflow: hidden;
}
.param-progress-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.5s cubic-bezier(0.22, 1, 0.36, 1);
}
.param-progress-fill.progress-normal  { background: var(--blue); }
.param-progress-fill.progress-warning { background: var(--orange); }
.param-progress-fill.progress-urgent  {
  background: var(--red);
  animation: urgent-pulse 1.2s ease-in-out infinite;
}

/* ─── カテゴリアコーディオン ─── */
.param-category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 4px 6px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  min-height: 44px;
}
.param-category-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--label-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.param-category-chevron {
  font-size: 11px;
  color: var(--label-tertiary);
  transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}
.param-category-header.collapsed .param-category-chevron {
  transform: rotate(-90deg);
}
.param-category-body {
  max-height: 9999px;
  overflow: hidden;
  transition: max-height 0.35s ease-out;
}
.param-category-body.collapsed {
  max-height: 0;
}

/* ─── バッジ（Variable Reward） ─── */
.badge-version {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--bg-tertiary);
  color: var(--label-secondary);
  vertical-align: middle;
}
.badge-upgraded {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(48, 209, 88, 0.15);
  color: var(--green);
  vertical-align: middle;
  animation: upgraded-glow 2s ease-in-out infinite;
}

/* ─── AI判断理由ブロック（Peak-End則） ─── */
.param-reason-block {
  background: rgba(0, 122, 255, 0.08);
  border-left: 3px solid var(--blue);
  border-radius: 0 8px 8px 0;
  padding: 8px 10px;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--label-primary);
  line-height: 1.5;
}
.param-reason-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--blue);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 4px;
}

/* ─── 緊急ニュースバナー（10分以内EMERGENCY） ─── */
.emergency-news-banner {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--red);
  border-radius: 10px;
  margin-bottom: 12px;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  opacity: 0;
  transition: opacity 0.4s ease;
}
.emergency-news-banner.visible {
  display: flex;
  opacity: 1;
  animation: emergency-flash 1.5s ease-in-out infinite;
}
.emergency-news-banner.fading {
  opacity: 0;
}

/* ─── Reduced motion（アクセシビリティ） ─── */
@media (prefers-reduced-motion: reduce) {
  .skeleton-line, .status-dot, .refresh-btn.spinning svg { animation: none; }
  .param-progress-fill.progress-urgent { animation: none; }
  .badge-upgraded { animation: none; }
  .emergency-news-banner.visible { animation: none; }
  .param-card-detail { transition: none; }
  .param-category-body { transition: none; }
}

/* ─── PnLバッジ 変化フラッシュ（Variable Reward） ─── */
@keyframes pnl-flash {
  0%   { filter: brightness(1); }
  30%  { filter: brightness(2.2) saturate(1.5); }
  100% { filter: brightness(1); }
}
.watch-pnl-badge.changed {
  animation: pnl-flash 0.45s ease-out;
}

/* ─── TP/SL プログレスバー（Goal Gradient） ─── */
.sheet-progress-wrap {
  margin: 4px 0 2px;
}
.sheet-progress-label {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--label-secondary);
  margin-bottom: 5px;
}
.sheet-progress-track {
  height: 6px;
  background: var(--bg-tertiary);
  border-radius: 3px;
  position: relative;
  overflow: visible;
}
.sheet-progress-sl {
  position: absolute;
  top: 0; left: 0;
  height: 100%;
  background: var(--red);
  border-radius: 3px 0 0 3px;
  opacity: 0.5;
  transition: width 0.4s ease;
}
.sheet-progress-tp {
  position: absolute;
  top: 0; right: 0;
  height: 100%;
  background: var(--green);
  border-radius: 0 3px 3px 0;
  opacity: 0.6;
  transition: width 0.4s ease;
}
.sheet-progress-cursor {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--label);
  border: 2px solid var(--bg-elevated);
  box-shadow: 0 0 4px rgba(0,0,0,0.5);
  transition: left 0.4s ease;
}
.sheet-distance-row {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  gap: 8px;
}
.sheet-distance-item {
  flex: 1;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sheet-distance-label {
  font-size: 10px;
  color: var(--label-secondary);
  font-weight: 600;
  letter-spacing: 0.5px;
}
.sheet-distance-value {
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.3px;
}

/* ─── 判定履歴 HOLD ディム（Cognitive Load） ─── */
.decision-row-hold {
  opacity: 0.45;
}
.decision-row-hold .decision-rate {
  font-size: 14px;
}
.decision-row-tappable {
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.decision-row-tappable:active {
  background: rgba(255,255,255,0.05);
  border-radius: 8px;
}

/* ─── Log Tab ─── */
.log-section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--label-tertiary);
  letter-spacing: 0.8px;
  text-transform: uppercase;
  padding: 0 4px 8px;
  margin-top: 8px;
}
.log-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--separator);
  font-size: 12px;
  line-height: 1.5;
}
.log-row:last-child { border-bottom: none; }
.log-level {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.4px;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.log-level-info  { background: rgba(48,209,88,0.15);  color: #30D158; }
.log-level-warn  { background: rgba(255,159,10,0.15); color: #FF9F0A; }
.log-level-error { background: rgba(255,69,58,0.15);  color: #FF453A; }
.log-time {
  font-size: 11px;
  color: var(--label-tertiary);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.log-msg { color: var(--label); flex: 1; word-break: break-all; }
.log-detail { font-size: 11px; color: var(--label-secondary); margin-top: 2px; word-break: break-all; }
.stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 4px;
}
.stat-cell {
  background: var(--bg-tertiary);
  border-radius: var(--radius);
  padding: 12px;
}
.stat-cell-label {
  font-size: 11px;
  color: var(--label-secondary);
  margin-bottom: 4px;
}
.stat-cell-value {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.5px;
  color: var(--label);
}
.stat-cell-unit {
  font-size: 11px;
  color: var(--label-secondary);
  margin-left: 2px;
}

/* ─── News Drawer ─── */
.news-drawer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(49px + env(safe-area-inset-bottom));
  max-height: calc(100dvh - 49px - env(safe-area-inset-bottom) - env(safe-area-inset-top) - 120px);
  overflow: hidden;
  z-index: 15;
  background: var(--bg-elevated);
  border-top: 1px solid var(--separator);
  -webkit-backdrop-filter: blur(24px) saturate(1.8);
  backdrop-filter: blur(24px) saturate(1.8);
  border-radius: 14px 14px 0 0;
  border-top: 1px solid rgba(255,255,255,0.10);
  transform: translateY(calc(100% - 68px));
  transition: transform 0.42s cubic-bezier(0.34, 1.56, 0.64, 1);
  will-change: transform;
  touch-action: pan-y;
  display: none;
  flex-direction: column;
}
.news-drawer.visible { display: flex; }
.news-drawer.expanded {
  transform: translateY(0);
  bottom: 0;
  height: calc(100dvh - env(safe-area-inset-top) - 120px);
}
.news-drawer.expanded .news-drawer-body {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  flex: 1;
  min-height: 0;
  touch-action: pan-y;
}

.news-drawer-handle {
  width: 36px;
  height: 4px;
  background: rgba(255,255,255,0.28);
  border-radius: 2px;
  margin: 8px auto 0;
}
.news-drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  min-height: 44px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: none;
}
.news-drawer-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--label);
}
.news-drawer-chevron {
  font-size: 18px;
  color: var(--label-secondary);
  transition: transform 0.3s ease;
  display: inline-block;
  line-height: 1;
  transform: rotate(-90deg);
}
.news-drawer.expanded .news-drawer-chevron {
  transform: rotate(90deg);
}
.news-drawer-body {
  overflow: hidden;
  padding: 0 0 8px;
}
.news-item {
  padding: 12px 16px;
  min-height: 44px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  border-bottom: 1px solid var(--separator);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.news-item:last-child { border-bottom: none; }
.news-item:active { background: rgba(255,255,255,0.06); }
.news-attention { background: rgba(255,149,0,0.08); }
.news-flag {
  display: inline-block;
  margin-right: 5px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.4px;
  color: var(--orange);
  background: rgba(255,149,0,0.15);
  padding: 1px 5px;
  border-radius: 4px;
  vertical-align: middle;
}
.news-item-title {
  font-size: 13px;
  color: var(--label);
  line-height: 1.45;
  margin-bottom: 4px;
}
.news-item-date {
  font-size: 11px;
  color: var(--label-tertiary);
  font-variant-numeric: tabular-nums;
}

/* ─── Tab Bar ─── */
.tab-bar {
  display: flex;
  align-items: stretch;
  justify-content: space-around;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: calc(64px + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  background: rgba(28,28,30,0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-top: 1px solid rgba(84,84,88,0.3);
  z-index: 20;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .tab-bar {
    background: rgba(242, 242, 247, 0.92);
    border-top: 1px solid rgba(0, 0, 0, 0.10);
  }
}
:root[data-theme="light"] .tab-bar {
  background: rgba(242, 242, 247, 0.92);
  border-top: 1px solid rgba(0, 0, 0, 0.10);
}
:root[data-theme="light"] .header {
  background: rgba(242,242,247,0.92);
}
.tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 56px;
  padding: 8px 0 4px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  color: var(--label-secondary);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.3px;
  transition: color 0.15s ease, opacity 0.15s ease;
  -webkit-user-select: none;
  user-select: none;
  /* iOS Safari button reset */
  -webkit-appearance: none;
  appearance: none;
  background: none;
  border: none;
  margin: 0;
  outline: none;
}
.tab-item { position: relative; }
.tab-item.active { color: var(--blue); }
.tab-badge {
  position: absolute;
  top: 2px;
  right: 50%;
  transform: translateX(14px);
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--red);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  pointer-events: none;
}
.tab-item.active svg { filter: drop-shadow(0 0 4px rgba(10,132,255,0.45)); }
.tab-item:active { opacity: 0.6; }
.tab-item svg { flex-shrink: 0; }
/* ドロワー/シート展開時はタブバーを隠す */
body.drawer-open .tab-bar,
body.sheet-open .tab-bar {
  transform: translateY(100%);
  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.tab-bar {
  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}

/* ─── Tab Panels ─── */
.tab-panel { display: none; }
.tab-panel.active { display: flex; flex-direction: column; }
.content { padding-bottom: calc(64px + env(safe-area-inset-bottom) + 24px); }

/* ポートフォリオタブはスクロールなし・固定高さレイアウト */
#tab-portfolio {
  height: calc(100vh - 49px - env(safe-area-inset-bottom));
  height: calc(100svh - 49px - env(safe-area-inset-bottom));
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 12px;
  transform-origin: 50% 0%;
  will-change: transform, opacity;
  border-radius: 0;
}
#tab-portfolio.news-visible {
  padding-bottom: 80px;
}

/* ─── ティッカーバー（ニュース展開時の横スクロール） ─── */
.compact-summary {
  display: none;
  overflow: hidden;
  pointer-events: none;
  flex-shrink: 0;
}
#tab-portfolio.drawer-expanded .compact-summary.marquee-active {
  display: block;
}
.ticker-scroll {
  display: inline-flex;
  gap: 24px;
  padding: 6px 0 4px;
  white-space: nowrap;
}
.compact-summary.marquee-active .ticker-scroll {
  animation: ticker-marquee 44s linear infinite;
}
@keyframes ticker-marquee {
  0%   { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}
.ticker-item {
  flex-shrink: 0;
  min-width: 100px;
  text-align: center;
}
.ticker-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--label-secondary);
  margin-bottom: 2px;
  white-space: nowrap;
}
.ticker-mid {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.ticker-price {
  font-size: 15px;
  font-weight: 600;
  color: var(--label);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ticker-spark { display: flex; align-items: center; }
.ticker-change {
  font-size: 11px;
  font-weight: 500;
  color: var(--label-secondary);
  font-variant-numeric: tabular-nums;
  margin-top: 1px;
}
.ticker-change.positive { color: var(--green); }
.ticker-change.negative { color: var(--red); }

/* ドロワー展開時の状態 */
#tab-portfolio.drawer-expanded .compact-summary {
  pointer-events: auto;
}
#tab-portfolio.drawer-expanded .card {
  pointer-events: none;
}
#tab-portfolio.drawer-expanded {
  border-radius: 14px;
  overflow: hidden;
  touch-action: none;
}

/* ─── Bottom Sheet ─── */
.sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 30;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
}
.sheet-backdrop.visible {
  opacity: 1;
  pointer-events: auto;
}
.sheet {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-elevated);
  border-radius: 20px 20px 0 0;
  z-index: 40;
  transform: translateY(100%);
  transition: transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
  padding-bottom: env(safe-area-inset-bottom);
  min-height: 55dvh;
  max-height: 65dvh;
  overflow-y: auto;
}
.sheet.open { transform: translateY(0); }
.sheet-handle {
  width: 36px;
  height: 4px;
  background: var(--bg-tertiary);
  border-radius: 3px;
  margin: 12px auto 0;
}
.sheet-title {
  font-size: 17px;
  font-weight: 600;
  padding: 16px 20px 8px;
  letter-spacing: -0.2px;
}
.sheet-body {
  padding: 8px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.sheet-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.sheet-label {
  font-size: 15px;
  color: var(--label-secondary);
}
.sheet-value {
  font-size: 17px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.3px;
}

/* ─── TP Banner（Peak-End Rule 祝福） ─── */
/* ─── TP/SL バナー（iOS PWA scroll-jump 防止） ───
   外側 = inset:0 全画面透明オーバーレイ（サイズ不変 → WebKit が reflow しない）
   内側 = .tp-banner-inner のみアニメーション                                    */
.tp-banner {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 50;
}
.tp-banner-inner {
  position: absolute;
  top: calc(env(safe-area-inset-top) + 56px);
  left: 16px;
  right: 16px;
  background: var(--green);
  color: #000;
  border-radius: var(--radius);
  padding: 16px;
  font-size: 15px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 8px;
  transform: translateY(-16px);
  opacity: 0;
  pointer-events: none;
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease;
  overflow: hidden;
}
.tp-banner.show .tp-banner-inner {
  transform: translateY(0);
  opacity: 1;
  pointer-events: auto;
}
.tp-banner-inner::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.25) 50%, transparent 100%);
  background-size: 200% 100%;
  animation: tp-shimmer 1.2s ease-in-out 3;
}
@keyframes tp-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.tp-banner-icon { font-size: 22px; flex-shrink: 0; }
.tp-banner-text { flex: 1; }
.tp-banner-title { font-size: 16px; font-weight: 800; }
.tp-banner-sub   { font-size: 15px; opacity: 1; font-weight: 700; }

/* SLバナー（金継ぎ） */
.tp-banner.sl-banner .tp-banner-inner {
  background: linear-gradient(135deg, #2C2C2E 0%, #3A3A3C 50%, #2C2C2E 100%);
  color: var(--label);
}
.tp-banner.sl-banner .tp-banner-inner::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg,
    transparent 30%,
    rgba(212,175,55,0.35) 50%,
    transparent 70%);
  background-size: 200% 100%;
  animation: kintsugi-shine 2.5s ease-in-out 2;
}
@keyframes kintsugi-shine {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* ─── Sparkline ─── */
.sparkline {
  display: block;
  flex-shrink: 0;
}

/* ─── Stats タブ ─── */
.stats-section { padding: 0 0 16px; }

/* Section header (Apple HIG: clean text hierarchy, no decoration) */
.stats-sec-header {
  padding: 24px 0 8px;
}
.stats-sec-title {
  font-size: 13px;  /* HIG: Footnote — uppercase label style */
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--label-secondary);
}

/* Metric grid card (HIG: 8pt grid, 12px radius, solid bg) */
.metric-card {
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 12px;
  transition: transform 0.1s cubic-bezier(0, 0, 0.58, 1);
}
.metric-card:active {
  transform: scale(0.98);
}
.metric-label {
  font-size: 11px;
  color: var(--label-secondary);
  letter-spacing: 0.2px;
}
.metric-value {
  font-size: 15px;
  font-weight: 700;
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}
.metric-sub {
  font-size: 11px;
  color: var(--label-tertiary);
  margin-top: 2px;
}
.metric-grid-3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
  margin-bottom: 16px;
}
.metric-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 16px;
}

/* Risk card accent (Loss Aversion: subtle left accent) */
.metric-card--danger {
  border-left: 2px solid var(--red);
}
.metric-card--warn {
  border-left: 2px solid var(--orange, #ff9500);
}
.metric-card--ok {
  border-left: 2px solid var(--green);
}

/* Pair performance cards */
.stats-pair-card {
  background: var(--bg-elevated);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 6px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: transform 0.1s cubic-bezier(0, 0, 0.58, 1), background 0.2s cubic-bezier(0, 0, 0.58, 1);
}
.stats-pair-card:active {
  transform: scale(0.97);
  background: var(--bg-secondary);
}
.stats-pair-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;  /* H4: 8ptグリッド */
}
.stats-pair-name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.2px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stats-pnl {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  text-align: right;
}
.stats-bar-track {
  height: 8px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 8px;
}
.stats-bar-fill {
  height: 100%;
  background: var(--green);
  border-radius: 3px;
  min-width: 3px;
  transition: width 0.5s cubic-bezier(0.25, 0.1, 0.25, 1);  /* HIG: --ease-default */
}
.stats-bar-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--label-secondary);
}

/* Fold toggle (Apple HIG: text link style, 44pt touch target) */
.stats-fold-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 44px;
  padding: 12px 16px;
  font-size: 15px;  /* HIG: Subheadline */
  font-weight: 400;
  color: var(--blue);
  background: transparent;
  border: none;
  border-radius: 0;
  cursor: pointer;
  margin: 0;
  -webkit-tap-highlight-color: transparent;
}
.stats-fold-btn:active {
  opacity: 0.5;
}

/* Trade history row (HIG: 44pt row height, 8pt grid) */
.trade-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;  /* H4: 8ptグリッド (12=8+4) */
  min-height: 44px;  /* H1: 44ptタッチターゲット */
  border-bottom: 1px solid var(--separator);
}
.trade-row:last-child { border-bottom: none; }
.trade-label {
  font-size: 15px;  /* H2: Subheadline (14pxはHIGスケール外) */
  font-weight: 600;
}
.trade-meta {
  font-size: 11px;
  color: var(--label-secondary);
  margin-top: 2px;
}
.trade-pnl {
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* Score row */
.score-row {
  display: flex;
  align-items: center;
  gap: 8px;  /* H4: 8ptグリッド */
  padding: 12px 0;  /* H4: 8ptグリッド */
  min-height: 44px;  /* H1: 44ptタッチターゲット */
  border-bottom: 1px solid var(--separator);
}
.score-row:last-child { border-bottom: none; }
.score-rank {
  font-size: 11px;
  font-weight: 700;
  color: var(--label-tertiary);
  width: 18px;
  text-align: right;
  flex-shrink: 0;
}
.score-body {
  flex: 1;
  min-width: 0;
}
.score-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
}
.score-name {
  font-size: 13px;
  font-weight: 600;
}
.score-val {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.score-bar {
  height: 4px;
  background: var(--bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
}
.score-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.5s ease;
}
.score-details {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--label-secondary);
}

/* Untraded label */
.untraded-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--label-tertiary);
  letter-spacing: 0.8px;
  text-transform: uppercase;
  padding: 12px 4px 4px;
}

/* ─── Watch row tap ─── */
.watch-row {
  transition: transform 0.12s ease, background 0.12s ease;
  cursor: pointer;
}
.watch-row:active {
  transform: scale(0.97);
  background: var(--bg-secondary);
}

/* ─── Mode Badge (LIVE/DEMO) ─── */
.mode-badge {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 2px 8px;
  border-radius: 6px;
  vertical-align: middle;
  margin-left: 6px;
}
.mode-live {
  background: rgba(255,69,58,0.18);
  color: var(--red);
}
.mode-demo {
  background: rgba(255,159,10,0.18);
  color: var(--orange);
}

/* ─── Source Badge (LIVE/PAPER on watch row) ─── */
.watch-source-badge {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 1px 5px;
  border-radius: 4px;
}
.watch-source-live {
  background: rgba(255,69,58,0.15);
  color: var(--red);
}
.watch-source-paper {
  background: rgba(142,142,147,0.15);
  color: var(--label-secondary);
}

/* ─── RiskGuard Status ─── */
.risk-status-card {
  background: var(--bg-elevated);
  border-radius: var(--radius);
  padding: 12px 16px;
  margin-bottom: 8px;
  border: 1px solid var(--separator);
}
.risk-status-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--label-tertiary);
  letter-spacing: 0.8px;
  text-transform: uppercase;
  margin-bottom: 8px;
}
.risk-status-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.risk-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.risk-label {
  font-size: 13px;
  color: var(--label-secondary);
}
.risk-value {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--label);
}

/* ═══════════════════════════════════════════════════
   PC Responsive — Mobile-first breakpoints
   ═══════════════════════════════════════════════════ */

/* PC要素: モバイルではデフォルト非表示 */
.pc-sidebar { display: none; }
.pc-tabbar { display: none; }
.pc-panel { display: none; }
.panel-content { display: none; }
.panel-content.active { display: block; }
.watch-table { display: none; }
.watchlist-columns { display: block; }

/* ═══ Tablet (769px+) ═══ */
@media (min-width: 769px) {
  .compact-summary, #ticker-scroll { display: none !important; }
  .tab-bar { display: none !important; }

  .pc-tabbar {
    display: flex !important;
    position: sticky;
    top: 0;
    z-index: 50;
    height: 44px;
    background: var(--bg);
    border-bottom: 1px solid var(--separator);
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 0 16px;
  }

  .pc-tabbar-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    color: var(--label-secondary);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    border: none;
    background: none;
  }

  .pc-tabbar-item:hover { background: var(--bg-secondary); }

  .pc-tabbar-item.active {
    color: var(--blue);
    background: var(--bg-secondary);
  }

  .pc-tabbar-item svg { width: 16px; height: 16px; }

  .content {
    max-width: 960px;
    margin: 0 auto;
    padding-bottom: 24px;
  }

  .watch-table {
    display: table !important;
    width: 100%;
    border-collapse: collapse;
  }

  .watch-table th {
    text-align: left;
    font-size: 11px;
    color: var(--label-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 8px;
    border-bottom: 1px solid var(--separator);
    font-weight: 500;
  }

  .watch-table td {
    padding: clamp(8px, 1vw, 12px);
    border-bottom: 1px solid var(--separator);
    font-size: clamp(0.875rem, 0.8vw + 4px, 1rem);
    vertical-align: middle;
  }

  .watch-table tr { cursor: pointer; transition: background 0.15s ease; }
  .watch-table tr:hover { background: var(--bg-secondary); }
  .watch-table .pair-name { font-weight: 600; color: var(--label); }

  .watch-table .dir-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
  }

  .watch-table .dir-buy { background: rgba(48,209,88,0.12); color: var(--green); }
  .watch-table .dir-sell { background: rgba(255,69,58,0.12); color: var(--red); }
  .watch-table .sparkline-cell svg { width: clamp(60px, 4vw, 100px); height: 20px; }
  .watch-table .pnl-pos { color: var(--green); font-weight: 600; }
  .watch-table .pnl-neg { color: var(--red); font-weight: 400; opacity: 0.85; }

  .hero-value, #hero-pnl { font-size: clamp(2.625rem, 3vw, 4rem) !important; }
  .card { padding: clamp(1rem, 1.2vw, 2rem); }
  .section-title, .card-title { font-size: clamp(0.938rem, 1vw, 1.125rem); }
}

/* ═══ Desktop (1280px+) ═══ */
@media (min-width: 1280px) {
  .pc-tabbar { display: none !important; }

  .stats-section {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .stats-section > div:not(.stats-pair-card) {
    grid-column: 1 / -1;
  }

  #equity-chart { height: clamp(180px, 16vw, 320px) !important; }

  .stat-grid { max-width: 800px; }

  .log-row:hover { background: var(--bg-secondary); }

  .pc-sidebar {
    display: flex !important;
    flex-direction: column;
    align-items: center;
    width: var(--sidebar-width);
    min-width: 56px;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--separator);
    padding-top: 12px;
    flex-shrink: 0;
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 60;
  }

  .sidebar-logo {
    font-size: 16px;
    font-weight: 700;
    color: var(--blue);
    margin-bottom: 20px;
    letter-spacing: -0.5px;
  }

  .sidebar-tab {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    margin-bottom: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    position: relative;
    border: none;
    background: none;
    color: var(--label-secondary);
  }

  .sidebar-tab svg {
    width: 20px;
    height: 20px;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.6;
  }

  .sidebar-tab span { font-size: 9px; margin-top: 2px; color: inherit; }
  .sidebar-tab:hover { background: var(--bg-secondary); }

  .sidebar-tab.active {
    color: var(--blue);
    background: rgba(10,132,255,0.12);
  }

  .sidebar-tab.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 3px;
    background: var(--blue);
    border-radius: 0 2px 2px 0;
  }

  .sidebar-spacer { flex: 1; }
  .sidebar-bottom { margin-bottom: 12px; }

  .content {
    max-width: none;
    margin-left: var(--sidebar-width);
    padding: 20px clamp(24px, 2vw, 48px);
  }

  .watch-table { max-width: 1200px; }

  .header {
    position: sticky;
    top: 0;
    margin-left: var(--sidebar-width);
    z-index: 40;
  }

  .tp-banner { margin-left: var(--sidebar-width); }
}

/* ═══ FHD+ (1920px+) ═══ */
@media (min-width: 1920px) {
  #news-drawer { display: none !important; }
  #news-drawer-handle { display: none !important; }

  .pc-panel {
    display: flex !important;
    flex-direction: column;
    width: var(--panel-width);
    min-width: 300px;
    background: var(--panel-bg);
    border-left: 1px solid var(--panel-border);
    flex-shrink: 0;
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    overflow-y: auto;
    overflow-x: hidden;
    z-index: 50;
  }

  .panel-header {
    padding: 16px;
    font-size: 13px;
    font-weight: 600;
    color: var(--label-secondary);
    border-bottom: 1px solid var(--separator);
    position: sticky;
    top: 0;
    background: var(--panel-bg);
    z-index: 1;
  }

  .panel-section {
    padding: 12px 16px;
    border-bottom: 1px solid var(--separator);
  }

  .panel-section .label {
    font-size: 11px;
    color: var(--label-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }

  .panel-section .value {
    font-size: 16px;
    font-weight: 600;
    color: var(--label);
  }

  .panel-news-item {
    padding: 10px 16px;
    border-bottom: 1px solid var(--separator);
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .panel-news-item:hover { background: var(--bg-secondary); }
  .panel-news-title {
    font-size: 12px;
    color: var(--label);
    line-height: 1.4;
    margin-bottom: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .panel-news-meta { font-size: 11px; color: var(--label-tertiary); }

  .panel-news-attention {
    border-left: 2px solid var(--orange);
    padding-left: 14px;
  }

  .panel-content { display: none; }
  .panel-content.active { display: block; }

  .content {
    margin-right: var(--panel-width);
    max-width: var(--container-max);
  }

  .header { margin-right: var(--panel-width); }
  .tp-banner { margin-left: var(--sidebar-width); margin-right: var(--panel-width); }

  /* パネルコンテンツ切替 */
  .panel-content { display: none; }
  .panel-content.active { display: block; }
}

/* ═══ Ultra-wide (2560px+) ═══ */
@media (min-width: 2560px) {
  .watchlist-columns {
    display: grid !important;
    grid-template-columns: 1fr 1fr;
    gap: 0 24px;
  }
}

/* ─── 市場状態サマリーバー ─── */
.market-state-bar {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0;
  background: var(--bg-elevated);
  border-radius: var(--radius);
  border: 1px solid rgba(255,255,255,0.05);
  margin: 0 16px 8px;
  overflow: hidden;
}
.market-state-cell {
  padding: 12px 8px;
  text-align: center;
  border-right: 1px solid rgba(84,84,88,0.2);
}
.market-state-cell:last-child { border-right: none; }
.market-state-label {
  font-size: 11px;
  color: var(--label-secondary);
  margin-bottom: 4px;
}
.market-state-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--label);
}

/* ─── AI期待銘柄ランキング ─── */
.ai-ranking-header {
  padding: 8px 16px 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--label-secondary);
}
.ai-ranking-list {
  background: var(--bg-elevated);
  border-radius: var(--radius);
  border: 1px solid rgba(255,255,255,0.05);
  margin: 0 16px;
  overflow: hidden;
}
.ai-ranking-list--inline {
  margin: 0;
  border-radius: 0;
}
.ai-ranking-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  min-height: 44px;
  border-bottom: 1px solid rgba(84,84,88,0.15);
  transition: background 0.15s;
}
.ai-ranking-row:last-child { border-bottom: none; }
.ai-ranking-row:active { background: rgba(255,255,255,0.12); }
.ai-ranking-medal {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(255,255,255,0.08);
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--label-secondary);
}
.ai-ranking-medal--1 { background: rgba(255,204,0,0.18); color: #FFCC00; }
.ai-ranking-medal--2 { background: rgba(174,174,178,0.18); color: #AEAEB2; }
.ai-ranking-medal--3 { background: rgba(188,96,0,0.18); color: #BC6000; }
.ai-ranking-name {
  flex: 1;
  font-size: 15px;
  font-weight: 500;
}
.ai-ranking-bar {
  width: 80px;
  height: 4px;
  background: rgba(255,255,255,0.08);
  border-radius: 2px;
  overflow: hidden;
  flex-shrink: 0;
}
.ai-ranking-bar-fill {
  height: 100%;
  background: var(--green);
  border-radius: 2px;
}
.ai-ranking-pct {
  font-size: 14px;
  font-weight: 600;
  color: var(--green);
  width: 44px;
  text-align: right;
  flex-shrink: 0;
}

/* ─── 統計的有意性プログレスバー（ヒーロー内） ─── */
.power-progress-wrap {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(84,84,88,0.2);
}
.power-progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.power-progress-label {
  font-size: 11px;
  color: var(--label-secondary);
}
.power-progress-pct {
  font-size: 11px;
  font-weight: 600;
  color: var(--orange);
}
.power-progress-track {
  height: 6px;
  background: rgba(255,255,255,0.08);
  border-radius: 3px;
  position: relative;
  overflow: visible;
}
.power-progress-fill {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--orange), var(--green));
  position: relative;
  transition: width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.power-progress-dot {
  position: absolute;
  right: -5px;
  top: 50%;
  transform: translateY(-50%);
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--bg-elevated);
  border: 2px solid var(--green);
  box-shadow: 0 0 6px rgba(48,209,88,0.5);
}
.power-progress-sub {
  font-size: 10px;
  color: var(--label-secondary);
  margin-top: 4px;
}

/* ─── レジームバッジ ─── */
.regime-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 6px;
  letter-spacing: 0.02em;
}
.regime-badge--volatile {
  background: rgba(255,69,58,0.15);
  color: var(--red);
}
.regime-badge--ranging {
  background: rgba(255,159,10,0.15);
  color: var(--orange);
}
.regime-badge--trending {
  background: rgba(10,132,255,0.15);
  color: var(--blue);
}

/* ─── 統計タブ ナラティブ構造 ─── */
.stats-narrative-section {
  margin: 0 16px 12px;
}
.stats-narrative-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0 8px;
}
.stats-narrative-question {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--label);
}
.stats-verdict {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 8px;
  flex-shrink: 0;
}
.stats-verdict--yes {
  background: rgba(48,209,88,0.15);
  color: var(--green);
}
.stats-verdict--no {
  background: rgba(255,69,58,0.15);
  color: var(--red);
}
.stats-verdict--warn {
  background: rgba(255,159,10,0.15);
  color: var(--orange);
}
.stats-card {
  background: var(--bg-elevated);
  border-radius: var(--radius);
  border: 1px solid rgba(255,255,255,0.05);
  padding: 16px;
  margin-bottom: 8px;
}
.stats-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 24px;
}
.stats-metric-label {
  font-size: 11px;
  color: var(--label-secondary);
  margin-bottom: 2px;
}
.stats-metric-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
}
.stats-metric-sub {
  font-size: 11px;
  color: var(--label-secondary);
  margin-top: 2px;
}
.ci-bar-wrap {
  background: var(--bg-elevated);
  border-radius: var(--radius);
  border: 1px solid rgba(255,255,255,0.05);
  padding: 12px 16px;
  margin-bottom: 8px;
}
.ci-bar-header {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--label-secondary);
  margin-bottom: 8px;
}
.ci-bar-track {
  height: 6px;
  background: rgba(255,255,255,0.08);
  border-radius: 3px;
  position: relative;
  overflow: hidden;
}
.ci-bar-fill {
  position: absolute;
  height: 100%;
  background: var(--blue);
  border-radius: 3px;
}
.ci-bar-marker {
  position: absolute;
  top: -4px;
  width: 2px;
  height: 14px;
  background: rgba(255,255,255,0.4);
  border-radius: 1px;
}
.ci-bar-labels {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--label-secondary);
  margin-top: 4px;
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .header {
    background: rgba(242,242,247,0.92);
  }
  :root:not([data-theme="dark"]) .market-state-bar,
  :root:not([data-theme="dark"]) .ai-ranking-list,
  :root:not([data-theme="dark"]) .stats-card,
  :root:not([data-theme="dark"]) .ci-bar-wrap {
    border-color: rgba(0,0,0,0.06);
  }
}

/* ── AI判断タブ リニューアル ── */

/* KPIグリッド */
.ai-kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
.kpi-card { position: relative; overflow: hidden; background: var(--bg-elevated); border-radius: 14px; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
.kpi-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: rgba(255,255,255,0.1); }
.kpi-val { font-size: 22px; font-weight: 700; line-height: 1.2; color: var(--label); }
.kpi-val.green { color: var(--green); }
.kpi-val.red   { color: var(--red); }
.kpi-sub { font-size: 11px; color: var(--label-tertiary); line-height: 1.4; }
.kpi-label { font-size: 11px; color: var(--label-secondary); margin-bottom: 2px; }
.kpi-latest-body { display: flex; align-items: center; gap: 8px; margin-top: 4px; }

/* トリガーカウントグリッド */
.trigger-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
.trigger-cell { border-radius: 12px; padding: 8px 12px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.trigger-cell.news { background: rgba(90,200,250,0.08); border: 1px solid rgba(90,200,250,0.2); }
.trigger-cell.rate { background: rgba(255,159,10,0.08);  border: 1px solid rgba(255,159,10,0.2); }
.trigger-cell.cron { background: rgba(174,174,178,0.08); border: 1px solid rgba(174,174,178,0.2); }
.trigger-count { font-size: 20px; font-weight: 700; }
.trigger-cell.news .trigger-count { color: var(--teal); }
.trigger-cell.rate .trigger-count { color: var(--orange); }
.trigger-cell.cron .trigger-count { color: var(--label-tertiary); }
.trigger-label { font-size: 11px; color: var(--label-secondary); text-align: center; }

/* タイムラインセクション */
.ai-sec-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.ai-sec-title { font-size: 15px; font-weight: 600; color: var(--label); }
.ai-sec-filter { font-size: 12px; color: var(--blue); padding: 8px 4px; margin: -8px -4px; }

/* タイムラインカード */
.tl-list { display: flex; flex-direction: column; gap: 8px; }
.tl-card { position: relative; background: var(--bg-elevated); border-radius: 14px; overflow: hidden; cursor: pointer; transition: opacity 0.1s ease; }
.tl-card:active { opacity: 0.75; }
.tl-accent { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; }
.tl-accent.open   { background: var(--blue); }
.tl-accent.tp     { background: var(--green); }
.tl-accent.sl     { background: var(--red); }
.tl-accent.closed { background: var(--label-tertiary); }
.tl-inner { padding: 12px 12px 12px 16px; }
.tl-row1 { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.tl-row2 { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.tl-row3 { display: flex; align-items: center; justify-content: space-between; }
.tl-left { display: flex; align-items: center; gap: 6px; }
.tl-pair { font-size: 13px; font-weight: 600; color: var(--label); }
.tl-rate { font-size: 13px; color: var(--label-secondary); }
.tl-meta { display: flex; align-items: center; gap: 6px; }
.tl-time { font-size: 11px; color: var(--label-tertiary); }
.tl-chevron { font-size: 12px; color: var(--label-tertiary); transition: transform 0.25s ease; }
.tl-card.expanded .tl-chevron { transform: rotate(90deg); }
.dir-badge { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 6px; letter-spacing: 0.02em; }
.dir-badge.buy  { background: rgba(48,209,88,0.18); color: var(--green); }
.dir-badge.sell { background: rgba(255,69,58,0.18);  color: var(--red); }
.tl-chip { font-size: 11px; padding: 2px 7px; border-radius: 6px; white-space: nowrap; }
.tl-chip.news { background: rgba(90,200,250,0.12); color: var(--teal);   border: 1px solid rgba(90,200,250,0.28); }
.tl-chip.rate { background: rgba(255,159,10,0.12);  color: var(--orange); border: 1px solid rgba(255,159,10,0.28); }
.tl-chip.cron { background: rgba(174,174,178,0.08); color: var(--label-tertiary); border: 1px solid rgba(174,174,178,0.2); }
.tl-reasoning-chip { font-size: 11px; color: var(--label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.tl-result { display: flex; align-items: center; gap: 4px; }
.result-dot { width: 7px; height: 7px; border-radius: 50%; }
.result-dot.open   { background: var(--blue); }
.result-dot.tp     { background: var(--green); }
.result-dot.sl     { background: var(--red); }
.result-dot.closed { background: var(--label-tertiary); }
.tl-result-text { font-size: 11px; }
.tl-result-text.open   { color: var(--blue); }
.tl-result-text.tp     { color: var(--green); }
.tl-result-text.sl     { color: var(--red); }
.tl-result-text.closed { color: var(--label-tertiary); }

/* 詳細パネル */
.detail-panel { max-height: 0; overflow: hidden; opacity: 0; transition: max-height 0.3s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease, padding 0.3s cubic-bezier(0.4,0,0.2,1); border-top: 0px solid var(--separator); }
.detail-panel.open { max-height: 800px; opacity: 1; padding: 14px 16px 16px 15px; border-top: 1px solid var(--separator); }

/* セクション共通 */
.detail-section-label { font-size: 10px; font-weight: 600; color: var(--label-tertiary); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px; }

/* TP/SL ゲージセクション */
.detail-tpsl-section { margin-bottom: 16px; }
.detail-tpsl-gauge { margin-bottom: 6px; }
.tpsl-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--bg-tertiary); }
.tpsl-sl-zone { background: linear-gradient(90deg, var(--red), rgba(255,69,58,0.4)); border-radius: 3px 0 0 3px; }
.tpsl-tp-zone { background: linear-gradient(90deg, rgba(48,209,88,0.4), var(--green)); border-radius: 0 3px 3px 0; }
.tpsl-entry-mark { width: 2px; background: var(--label); flex-shrink: 0; position: relative; z-index: 1; }
.tpsl-labels { display: flex; justify-content: space-between; margin-top: 4px; }
.tpsl-label { font-size: 11px; font-weight: 500; }
.tpsl-label.sl { color: var(--red); }
.tpsl-label.entry { color: var(--label-secondary); font-size: 10px; }
.tpsl-label.tp { color: var(--green); }
.tpsl-meta { display: flex; align-items: center; gap: 12px; }
.tpsl-rr { font-size: 12px; font-weight: 700; color: var(--label); background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 6px; }
.tpsl-pips { font-size: 11px; color: var(--label-tertiary); }

/* AI判断理由セクション */
.detail-reason-section { margin-bottom: 16px; }
.detail-reason-body { font-size: 13px; line-height: 1.7; color: var(--label); padding: 10px 12px; background: rgba(255,255,255,0.04); border-radius: 10px; border-left: 3px solid var(--blue); }

/* 市場コンテキストセクション */
.detail-context-section { margin-bottom: 12px; }
.detail-indicator-bar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.detail-ind { display: flex; flex-direction: column; align-items: center; background: rgba(255,255,255,0.05); border-radius: 8px; padding: 6px 10px; min-width: 56px; }
.detail-ind-label { font-size: 9px; color: var(--label-tertiary); margin-bottom: 2px; letter-spacing: 0.04em; }
.detail-ind-val { font-size: 13px; font-weight: 600; color: var(--label); }
.detail-ind-val.warn { color: var(--orange); }

/* ニュース一覧 */
.detail-news-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.detail-news-item { display: flex; align-items: flex-start; gap: 8px; }
.detail-news-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--label-tertiary); margin-top: 5px; flex-shrink: 0; }
.detail-news-dot.high { background: var(--red); }
.detail-news-dot.med { background: var(--orange); }
.detail-news-title { font-size: 12px; color: var(--label-secondary); line-height: 1.5; }

/* Path B ニュース（判断根拠）— 強調表示 */
.detail-news-list.pathb .detail-news-item { padding: 6px 0; }
.detail-news-list.pathb .detail-news-title { font-size: 13px; color: var(--label); font-weight: 500; }
.detail-news-impact { font-size: 11px; color: var(--label-secondary); margin-left: 14px; margin-top: 2px; line-height: 1.5; }

/* Path A ニュース（参考情報）— 控えめ表示 */
.detail-news-ref { margin-top: 8px; padding: 8px 10px; background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px dashed rgba(255,255,255,0.08); }
.detail-news-ref-label { font-size: 10px; color: var(--label-tertiary); display: block; margin-bottom: 6px; }
.detail-news-ref-item { font-size: 11px; color: var(--label-tertiary); line-height: 1.5; padding: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }


/* フッター */
.detail-footer { display: flex; align-items: center; justify-content: space-between; padding-top: 10px; border-top: 1px solid var(--separator); }
.detail-footer-left { display: flex; align-items: center; gap: 8px; }
.detail-footer-time { font-size: 11px; color: var(--label-tertiary); }

/* 旧互換（未使用だが安全に残す） */
.detail-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.detail-chip { font-size: 11px; padding: 2px 7px; border-radius: 6px; background: rgba(255,255,255,0.06); color: var(--label-secondary); }

/* HOLDセパレーター */
.hold-sep { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.hold-sep-line { flex: 1; height: 1px; background: var(--separator); }
.hold-sep-label { font-size: 11px; color: var(--label-tertiary); white-space: nowrap; }

/* ─── 因果サマリー（Task 3-C） ─── */
.causal-summary {
  padding: 12px 16px;
  margin: 8px 0;
  border-radius: 12px;
  background: var(--card-bg, #1C1C1E);
}
.causal-narrative {
  font-size: 14px;
  line-height: 1.5;
  color: var(--secondary, #8E8E93);
  margin-bottom: 10px;
}
.causal-drivers {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
@media (max-width: 767px) {
  .causal-drivers { flex-direction: column; }
}
.driver-card {
  flex: 1;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg, #000);
  border-left: 3px solid transparent;
}
.driver-profit { border-left-color: var(--green, #30D158); }
.driver-loss { border-left-color: var(--red, #FF453A); }
.driver-label {
  font-size: 11px;
  color: var(--secondary, #8E8E93);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 2px;
}
.driver-pair { font-size: 15px; font-weight: 600; }
.driver-pnl { font-size: 18px; font-weight: 700; margin: 2px 0; }
.driver-pnl.positive { color: var(--green, #30D158); }
.driver-pnl.negative { color: var(--red, #FF453A); }
.driver-reason { font-size: 12px; color: var(--secondary, #8E8E93); }
.causal-factors {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.factor-badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}
.factor-high { background: rgba(255,69,58,0.2); color: #FF453A; }
.factor-medium { background: rgba(255,159,10,0.2); color: #FF9F0A; }
.factor-low { background: rgba(142,142,147,0.2); color: #8E8E93; }

/* ─── 警報バナー（Task 4-C） ─── */
.alert-banner-container {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  z-index: 9999;
  pointer-events: none;
}
.alert-banner {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  text-align: center;
  pointer-events: auto;
}
.alert-red { background: #FF453A; color: #fff; }
.alert-orange { background: #FF9F0A; color: #fff; }
.alert-yellow { background: #FFD60A; color: #1C1C1E; }

/* ─── ヒートマップ（Task 6） ─── */
.causal-heatmap {
  margin-top: 10px;
}
.heatmap-grid {
  display: grid;
  gap: 1px;
  font-size: 11px;
  border-radius: 6px;
  overflow: hidden;
}
.hm-header {
  padding: 4px 6px;
  font-weight: 600;
  font-size: 10px;
  color: var(--label-secondary, #8E8E93);
  text-align: center;
  background: var(--bg-elevated, #1C1C1E);
}
.hm-header:first-child { text-align: left; }
.hm-pair {
  padding: 4px 6px;
  font-weight: 500;
  font-size: 11px;
  background: var(--bg, #000);
  white-space: nowrap;
}
.hm-cell {
  padding: 4px 6px;
  text-align: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--label, #fff);
}

/* ─── ディープリンク フラッシュ（Task 7） ─── */
.highlight-flash {
  animation: flash-bg 0.8s ease-out;
}
@keyframes flash-bg {
  0% { background-color: rgba(0,122,255,0.15); }
  100% { background-color: transparent; }
}
.factor-badge { cursor: pointer; }
.driver-card { cursor: pointer; }
`;

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
  --purple:           #BF5AF2;
  --label-tertiary:   rgba(235,235,245,0.3);
  --label-quaternary: rgba(235,235,245,0.18);
  --radius:           12px;
  --radius-sm:        8px;
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
  background: var(--bg);
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
  padding: calc(env(safe-area-inset-top) + 58px) 16px 48px;
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

/* ─── Hero PnL ─── */
.card-hero { padding: 16px 16px 12px; }
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
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.3px;
}
.hero-divider {
  width: 1px;
  background: var(--separator);
  flex-shrink: 0;
}

/* ─── Watchlist（株価アプリ風） ─── */
.card-watchlist { padding: 12px 0 0; }
.card-watchlist .section-title { padding: 0 16px; }
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

/* ─── Reduced motion ─── */
@media (prefers-reduced-motion: reduce) {
  .skeleton-line, .status-dot, .refresh-btn.spinning svg { animation: none; }
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
  touch-action: none;
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
.news-flag { margin-right: 4px; font-size: 12px; }
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
  height: calc(56px + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  background: rgba(18, 18, 20, 0.80);
  -webkit-backdrop-filter: blur(20px) saturate(1.8);
  backdrop-filter: blur(20px) saturate(1.8);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  z-index: 20;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .tab-bar {
    background: rgba(242, 242, 247, 0.80);
    border-top: 1px solid rgba(0, 0, 0, 0.10);
  }
}
:root[data-theme="light"] .tab-bar {
  background: rgba(242, 242, 247, 0.80);
  border-top: 1px solid rgba(0, 0, 0, 0.10);
}
.tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 48px;
  padding: 6px 0 2px;
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
  padding: 0;
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
.content { padding-bottom: calc(56px + env(safe-area-inset-bottom) + 24px); }

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
  max-height: 80dvh;
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
.tp-banner {
  position: fixed;
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
  z-index: 50;
  transform: translateY(-20px);
  opacity: 0;
  pointer-events: none;
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease;
  overflow: hidden;
}
.tp-banner.show {
  transform: translateY(0);
  opacity: 1;
  pointer-events: auto;
}
.tp-banner::before {
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
.sl-banner {
  background: linear-gradient(135deg, #2C2C2E 0%, #3A3A3C 50%, #2C2C2E 100%);
  color: var(--label);
  position: relative;
  overflow: hidden;
}
.sl-banner::after {
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
.stats-pair-card {
  background: var(--bg-elevated);
  border-radius: var(--radius);
  padding: 16px;
  margin-bottom: 8px;
}
.stats-pair-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.stats-pair-name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.2px;
}
.stats-pnl {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
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
  transition: width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.stats-bar-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--label-secondary);
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
`;

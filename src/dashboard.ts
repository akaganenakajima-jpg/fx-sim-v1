// GET / — ダッシュボード HTML（3タブ構造）

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
  <meta name="theme-color" content="#F2F2F7" media="(prefers-color-scheme: light)">
  <title>FX Sim</title>
  <link rel="stylesheet" href="/style.css?v=13">
</head>
<body>
  <div id="alert-banner-container" class="alert-banner-container"></div>
  <div id="app">

    <!-- PC: 左サイドバー -->
    <nav class="pc-sidebar" aria-label="メインナビゲーション">
      <div class="sidebar-logo">FX</div>
      <button class="sidebar-tab active" data-tab="tab-portfolio" aria-label="ダッシュボード">
        <svg viewBox="0 0 24 24"><path d="M3 9l9-6 9 6v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z"/><path d="M9 22V12h6v10"/></svg>
        <span>ダッシュボード</span>
      </button>
      <button class="sidebar-tab" data-tab="tab-stats" aria-label="統計">
        <svg viewBox="0 0 24 24"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
        <span>統計</span>
      </button>
      <button class="sidebar-tab" data-tab="tab-ai" aria-label="AI・ニュース">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M8 14h8a4 4 0 0 1 4 4v2H4v-2a4 4 0 0 1 4-4z"/></svg>
        <span>AI・ニュース</span>
      </button>
      <button class="sidebar-tab" data-tab="tab-strategy" aria-label="戦略">
        <svg viewBox="0 0 24 24"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        <span>戦略</span>
      </button>
      <button class="sidebar-tab" data-tab="tab-log" aria-label="システム">
        <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>
        <span>システム</span>
      </button>
      <div class="sidebar-spacer"></div>
      <button class="sidebar-tab sidebar-bottom" id="sidebar-settings" aria-label="設定">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>設定</span>
      </button>
    </nav>

    <!-- PC: タブレット用水平タブバー -->
    <nav class="pc-tabbar" aria-label="タブナビゲーション">
      <button class="pc-tabbar-item active" data-tab="tab-portfolio">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 9l9-6 9 6v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z"/><path d="M9 22V12h6v10"/></svg>
        ダッシュボード
      </button>
      <button class="pc-tabbar-item" data-tab="tab-stats">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
        統計
      </button>
      <button class="pc-tabbar-item" data-tab="tab-ai">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M8 14h8a4 4 0 0 1 4 4v2H4v-2a4 4 0 0 1 4-4z"/></svg>
        AI・ニュース
      </button>
      <button class="pc-tabbar-item" data-tab="tab-strategy">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        戦略
      </button>
      <button class="pc-tabbar-item" data-tab="tab-log">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>
        システム
      </button>
    </nav>

    <!-- ヘッダー -->
    <header class="header" role="banner">
      <h1 class="header-title">FX Sim <span id="mode-badge" class="mode-badge" style="display:none"></span></h1>
      <div class="header-right">
        <span id="last-updated" class="header-time" aria-live="polite">—</span>
        <button id="theme-btn" class="refresh-btn" aria-label="テーマ切替" title="テーマ切替">
          <svg id="theme-icon-sun" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <circle cx="9" cy="9" r="3.5" stroke="currentColor" stroke-width="1.6"/>
            <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          <svg id="theme-icon-moon" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" style="display:none">
            <path d="M15.1 10.4A6.5 6.5 0 0 1 7.6 2.9 6.5 6.5 0 1 0 15.1 10.4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          </svg>
        </button>
        <button id="refresh-btn" class="refresh-btn" aria-label="今すぐ更新" title="更新">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M9 2.5A6.5 6.5 0 1 1 3.5 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            <path d="M3.5 4.5V8H7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- TP/SL バナー（全画面透明オーバーレイ + 内側アニメーション） -->
    <div id="tp-banner" class="tp-banner" role="alert" aria-live="assertive">
      <div class="tp-banner-inner">
        <div class="tp-banner-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="9.5" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 11l3 3 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div class="tp-banner-text">
          <div class="tp-banner-title" id="tp-banner-title">利確成功</div>
          <div class="tp-banner-sub"   id="tp-banner-sub">—</div>
        </div>
      </div>
    </div>

    <!-- ─── ポートフォリオ タブ ─── -->
    <main id="tab-portfolio" class="content tab-panel active" role="main">

      <!-- ニュース展開時コンパクトサマリー -->
      <!-- ニュース展開時ティッカーバー（横スクロール） -->
      <div id="compact-summary" class="compact-summary" aria-hidden="true">
        <div id="ticker-scroll" class="ticker-scroll"></div>
      </div>

      <!-- PnL HERO -->
      <section class="card card-hero" aria-label="損益サマリー">
        <div class="hero-label">資産残高</div>
        <div id="hero-pnl" class="hero-pnl neutral" aria-live="polite">
          <span class="skeleton-line" style="width:140px;height:52px"></span>
        </div>
        <div class="hero-sub">
          <span class="hero-sub-item">
            <span class="hero-sub-label">損益</span>
            <span id="today-pnl" class="hero-sub-value neutral">—</span>
          </span>
          <span class="hero-divider"></span>
          <span class="hero-sub-item">
            <span class="hero-sub-label">含み</span>
            <span id="unrealized-pnl" class="hero-sub-value neutral">—</span>
          </span>
          <span class="hero-divider"></span>
          <span class="hero-sub-item">
            <span class="hero-sub-label">ROI</span>
            <span id="roi-value" class="hero-sub-value">—</span>
          </span>
          <span class="hero-divider"></span>
          <span class="hero-sub-item">
            <span class="hero-sub-label">勝率</span>
            <span id="win-rate" class="hero-sub-value">—</span>
          </span>
          <span class="hero-divider"></span>
          <span class="hero-sub-item">
            <span class="hero-sub-label">取引</span>
            <span id="total-trades" class="hero-sub-value">—</span>
          </span>
        </div>
        <div class="power-progress-wrap" id="power-progress-wrap">
          <div class="power-progress-header">
            <span class="power-progress-label">統計的有意性まで</span>
            <span class="power-progress-pct" id="power-progress-pct">—</span>
          </div>
          <div class="power-progress-track">
            <div class="power-progress-fill" id="power-progress-fill" style="width:0%">
              <div class="power-progress-dot"></div>
            </div>
          </div>
          <div class="power-progress-sub" id="power-progress-sub"></div>
        </div>
      </section>

      <!-- 因果サマリー -->
      <section id="causal-summary" class="causal-summary" style="display:none">
        <div id="causal-narrative" class="causal-narrative"></div>
        <div class="causal-drivers">
          <div id="causal-profit-top" class="driver-card driver-profit"></div>
          <div id="causal-loss-top" class="driver-card driver-loss"></div>
        </div>
        <div id="causal-factors" class="causal-factors"></div>
        <div id="causal-heatmap" class="causal-heatmap"></div>
      </section>

      <!-- 市場状態サマリーバー -->
      <div id="market-state-bar" class="market-state-bar" style="display:none"></div>

      <!-- 銘柄ウォッチリスト -->
      <section class="card card-watchlist" aria-label="銘柄一覧">
        <div class="section-title" style="margin-bottom:4px">保有中</div>
        <div id="watchlist" class="watchlist" role="list">
          <div class="watchlist-skeleton">
            <span class="skeleton-line" style="width:100%;height:64px;border-radius:8px"></span>
            <span class="skeleton-line" style="width:100%;height:64px;border-radius:8px"></span>
            <span class="skeleton-line" style="width:100%;height:64px;border-radius:8px"></span>
            <span class="skeleton-line" style="width:100%;height:64px;border-radius:8px"></span>
          </div>
        </div>
      </section>

    </main>

    <!-- ─── AI判断 タブ ─── -->
    <div id="tab-ai" class="content tab-panel" role="region" aria-label="AI判断">

      <div class="scroll" style="padding: 16px 16px 24px">

        <!-- KPIグリッド (2×2) -->
        <div class="ai-kpi-grid" role="group" aria-label="今日のサマリー">
          <!-- 今日の判断 -->
          <div class="kpi-card">
            <div class="kpi-label">今日の判断</div>
            <div class="kpi-val" id="ai-kpi-today-val">—</div>
            <div class="kpi-sub" id="ai-kpi-today-sub">BUY — · SELL —</div>
          </div>
          <!-- AI的中率 -->
          <div class="kpi-card">
            <div class="kpi-label">AI的中率</div>
            <div class="kpi-val" style="color:var(--orange)" id="ai-kpi-acc-val">—</div>
            <div class="kpi-sub" id="ai-kpi-acc-sub">n=— · Brier —</div>
          </div>
          <!-- 今日の損益 -->
          <div class="kpi-card">
            <div class="kpi-label">今日の損益</div>
            <div class="kpi-val" id="ai-kpi-pnl-val">—</div>
            <div class="kpi-sub" id="ai-kpi-pnl-sub">— 勝 — 敗</div>
          </div>
          <!-- 最新判断 -->
          <div class="kpi-card">
            <div class="kpi-label">最新判断</div>
            <div class="kpi-latest-body">
              <span class="dir-badge" id="ai-kpi-latest-badge">—</span>
              <span class="kpi-sub" id="ai-kpi-latest-pair">—</span>
            </div>
            <div class="kpi-sub" id="ai-kpi-latest-time">—</div>
          </div>
        </div>

        <!-- トリガーカウントグリッド (3列) -->
        <div class="trigger-grid" role="group" aria-label="今日のトリガー内訳">
          <div class="trigger-cell news">
            <div class="trigger-count" id="ai-trigger-news">—</div>
            <div class="trigger-label">ニュース起動</div>
          </div>
          <div class="trigger-cell rate">
            <div class="trigger-count" id="ai-trigger-rate">—</div>
            <div class="trigger-label">レート変動</div>
          </div>
          <div class="trigger-cell cron">
            <div class="trigger-count" id="ai-trigger-cron">—</div>
            <div class="trigger-label">定期 30m</div>
          </div>
        </div>

        <!-- タイムラインセクション -->
        <div class="ai-sec-header">
          <span class="ai-sec-title">判断タイムライン</span>
          <span class="ai-sec-filter" aria-label="BUY/SELLのみ表示中">BUY/SELL のみ ›</span>
        </div>

        <!-- タイムラインリスト（JSが書き込む） -->
        <div id="ai-timeline-list" class="tl-list" role="list"></div>

        <!-- HOLDセパレーター（静的） -->
        <div class="hold-sep" aria-hidden="true">
          <div class="hold-sep-line"></div>
          <div class="hold-sep-label">HOLD · 統計タブで確認</div>
          <div class="hold-sep-line"></div>
        </div>

      </div>
    </div>

    <!-- ─── 統計 タブ ─── -->
    <div id="tab-stats" class="content tab-panel" role="region" aria-label="統計">

      <!-- 資産推移グラフ -->
      <div class="card" style="padding:16px 16px 12px">
        <div class="section-title" style="margin-bottom:12px">資産推移</div>
        <div id="equity-chart" style="height:180px;position:relative"></div>
      </div>

      <!-- パフォーマンスサマリー -->
      <!-- 統計ナラティブ（JSが書き込む） -->
      <div id="stats-narrative"></div>

      <div id="stats-pairs" class="stats-section"></div>

      <!-- システムフッター -->
      <footer class="system-footer" role="contentinfo">
        <span class="sys-item"><span class="status-dot" aria-hidden="true"></span>稼働中</span>
        <span class="sys-sep"></span>
        <span class="sys-item sys-muted">最終実行 <span id="last-run">—</span></span>
        <span class="sys-sep"></span>
        <span class="sys-item sys-muted"><span id="total-runs">—</span> 回</span>
      </footer>

    </div>

    <!-- ─── ログ タブ ─── -->
    <div id="tab-log" class="content tab-panel" role="region" aria-label="ログ">
      <div id="risk-status" style="display:none"></div>
      <div id="log-stats-grid" class="stat-grid"></div>
      <div class="card" style="margin-top:4px">
        <div id="log-list"></div>
      </div>
    </div>

    <!-- ─── 戦略 タブ ─── -->
    <div id="tab-strategy" class="content tab-panel" role="region" aria-label="戦略">
      <div class="stat-grid" id="strategy-tiers"></div>
      <div class="card" style="margin-top:8px">
        <h3 style="font-size:13px;font-weight:600;margin:0 0 8px;color:var(--text)">手法 × 環境 マトリクス</h3>
        <div id="strategy-matrix"></div>
      </div>

      <!-- ─── パラメーター管理セクション ─── -->
      <div class="card" style="margin-top:8px">
        <!-- 緊急ニュースバナー（EMERGENCY検出10分以内に表示） -->
        <div id="emergency-news-banner" class="emergency-news-banner" role="alert" aria-live="assertive">
          <span>⚡</span>
          <span class="emergency-news-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h3 style="font-size:13px;font-weight:600;margin:0;color:var(--text)">ロジックパラメーター</h3>
          <div style="display:flex;gap:6px">
            <button id="params-tab-current" class="params-tab-btn active" onclick="showParamsTab('current')">現在値</button>
            <button id="params-tab-history" class="params-tab-btn" onclick="showParamsTab('history')">変更履歴</button>
          </div>
        </div>
        <div id="params-loading" style="color:var(--label-secondary);font-size:12px;padding:8px 0">読み込み中…</div>
        <!-- 現在のパラメーター一覧 -->
        <div id="params-current" style="display:block">
          <div id="params-table-wrap" style="overflow-x:auto;-webkit-overflow-scrolling:touch"></div>
        </div>
        <!-- 変更履歴 -->
        <div id="params-history" style="display:none">
          <div id="params-history-list"></div>
        </div>
      </div>
    </div>

    <!-- ─── タブバー ─── -->
    <nav class="tab-bar" role="tablist" aria-label="メインナビゲーション">
      <button class="tab-item active" role="tab" aria-selected="true"  data-tab="tab-portfolio" aria-controls="tab-portfolio">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 9l9-6 9 6v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M9 22V12h6v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        ダッシュボード
      </button>
      <button class="tab-item" role="tab" aria-selected="false" data-tab="tab-stats" aria-controls="tab-stats">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M18 20V10M12 20V4M6 20v-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        統計
      </button>
      <button class="tab-item" role="tab" aria-selected="false" data-tab="tab-ai" aria-controls="tab-ai">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2a4 4 0 0 1 4 4c0 1.5-.8 2.8-2 3.5V11h3a3 3 0 0 1 3 3v1.5a2.5 2.5 0 0 1-2.5 2.5H17v2a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-2h-.5A2.5 2.5 0 0 1 4 15.5V14a3 3 0 0 1 3-3h3V9.5A4 4 0 0 1 12 2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <circle cx="9.5" cy="15" r="1" fill="currentColor"/>
          <circle cx="14.5" cy="15" r="1" fill="currentColor"/>
        </svg>
        AI・ニュース
      </button>
      <button class="tab-item" role="tab" aria-selected="false" data-tab="tab-strategy" aria-controls="tab-strategy">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        </svg>
        戦略
      </button>
      <button class="tab-item" role="tab" aria-selected="false" data-tab="tab-log" aria-controls="tab-log">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M14 2v6h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M8 13h8M8 17h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
        システム
      </button>
    </nav>

    <!-- ─── ニュースドロワー ─── -->
    <div id="news-drawer" class="news-drawer" aria-label="ニュース">
      <div id="news-drawer-handle" class="news-drawer-handle" aria-hidden="true"></div>
      <div class="news-drawer-header">
        <span class="news-drawer-title">ビジネスニュース</span>
      </div>
      <div id="news-drawer-body" class="news-drawer-body"></div>
    </div>

    <!-- PC: 右サイドパネル -->
    <aside class="pc-panel" id="pc-panel" aria-label="サイドパネル">
      <div class="panel-content active" data-panel="tab-portfolio">
        <div class="panel-section">
          <div class="label">マーケット概況</div>
          <div id="panel-market" style="display:flex;gap:16px;margin-top:6px"></div>
        </div>
        <div class="panel-header">📰 ニュース</div>
        <div id="panel-news"></div>
      </div>
      <div class="panel-content" data-panel="tab-ai">
        <div class="panel-header">📋 判定履歴</div>
        <div id="panel-decisions"></div>
      </div>
      <div class="panel-content" data-panel="tab-stats">
        <div class="panel-header">📊 銘柄詳細</div>
        <div id="panel-stats-detail">
          <p style="padding:16px;color:var(--label-secondary);font-size:13px">銘柄をクリックして詳細を表示</p>
        </div>
      </div>
      <div class="panel-content" data-panel="tab-log">
        <div class="panel-header">🛡️ RiskGuard</div>
        <div id="panel-riskguard"></div>
      </div>
      <div class="panel-content" data-panel="tab-strategy">
        <div class="panel-header">🔬 最新レビュー</div>
        <div id="panel-params-review"></div>
      </div>
    </aside>

    <!-- ─── ボトムシート（ポジション詳細） ─── -->
    <div id="sheet-backdrop" class="sheet-backdrop" role="presentation"></div>
    <div id="sheet" class="sheet" role="dialog" aria-modal="true" aria-label="ポジション詳細">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-title" id="sheet-title">—</div>
      <div class="sheet-body" id="sheet-body"></div>
    </div>

  </div>
  <script src="/app.js?v=13"></script>
</body>
</html>`;
}

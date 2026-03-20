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
  <link rel="stylesheet" href="/style.css?v=9">
</head>
<body>
  <div id="app">

    <!-- PC: 左サイドバー -->
    <nav class="pc-sidebar" aria-label="メインナビゲーション">
      <div class="sidebar-logo">FX</div>
      <button class="sidebar-tab active" data-tab="tab-portfolio" aria-label="資産">
        <svg viewBox="0 0 24 24"><path d="M3 9l9-6 9 6v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z"/><path d="M9 22V12h6v10"/></svg>
        <span>資産</span>
      </button>
      <button class="sidebar-tab" data-tab="tab-ai" aria-label="AI判断">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M8 14h8a4 4 0 0 1 4 4v2H4v-2a4 4 0 0 1 4-4z"/></svg>
        <span>AI</span>
      </button>
      <button class="sidebar-tab" data-tab="tab-stats" aria-label="統計">
        <svg viewBox="0 0 24 24"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
        <span>統計</span>
      </button>
      <button class="sidebar-tab" data-tab="tab-log" aria-label="ログ">
        <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>
        <span>ログ</span>
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
        資産
      </button>
      <button class="pc-tabbar-item" data-tab="tab-ai">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M8 14h8a4 4 0 0 1 4 4v2H4v-2a4 4 0 0 1 4-4z"/></svg>
        AI判断
      </button>
      <button class="pc-tabbar-item" data-tab="tab-stats">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
        統計
      </button>
      <button class="pc-tabbar-item" data-tab="tab-log">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>
        ログ
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

    <!-- TP/SL バナー -->
    <div id="tp-banner" class="tp-banner" role="alert" aria-live="assertive">
      <div class="tp-banner-icon">🎯</div>
      <div class="tp-banner-text">
        <div class="tp-banner-title" id="tp-banner-title">利確成功</div>
        <div class="tp-banner-sub"   id="tp-banner-sub">—</div>
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
      </section>

      <!-- AI最新判断（リッチカード） -->
      <div class="ai-rich-card" id="ai-card">
        <div class="ai-rich-top">
          <span id="ai-badge" class="badge badge-hold ai-badge">—</span>
          <span id="ai-pair" class="ai-rich-pair">—</span>
          <span id="ai-rate" class="ai-rich-rate">—</span>
          <span id="ai-time" class="ai-rich-time">—</span>
        </div>
        <div id="ai-reasoning" class="ai-rich-reasoning">読み込み中…</div>
        <div id="ai-status" class="ai-rich-status">—</div>
      </div>

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
    <div id="tab-ai" class="content tab-panel" role="region" aria-label="AI判断履歴">

      <!-- AI詳細（最新） -->
      <section class="card card-ai" aria-label="AI最新判断詳細" aria-live="polite">
        <div class="section-header">
          <span class="section-title">最新判断</span>
          <span id="ai-time2" class="ai-time">—</span>
        </div>
        <div class="ai-body" style="margin-bottom:12px">
          <span id="ai-badge2" class="badge badge-hold ai-badge">HOLD</span>
          <div id="ai-reasoning2" class="ai-reasoning secondary-text">読み込み中…</div>
        </div>
      </section>

      <!-- 判定履歴 -->
      <div class="list-header-row">
        <span class="list-header">判定履歴</span>
        <button id="toggle-history" class="link-btn" aria-expanded="false">すべて見る</button>
      </div>
      <div id="decisions-list" class="decisions-list" role="list"></div>

    </div>

    <!-- ─── 統計 タブ ─── -->
    <div id="tab-stats" class="content tab-panel" role="region" aria-label="統計">

      <!-- 資産推移グラフ -->
      <div class="card" style="padding:16px 16px 12px">
        <div class="section-title" style="margin-bottom:12px">資産推移</div>
        <div id="equity-chart" style="height:180px;position:relative"></div>
      </div>

      <!-- パフォーマンスサマリー -->
      <div class="card" style="padding:12px 16px">
        <div id="perf-summary"></div>
      </div>

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

    <!-- ─── タブバー ─── -->
    <nav class="tab-bar" role="tablist" aria-label="メインナビゲーション">
      <button class="tab-item active" role="tab" aria-selected="true"  data-tab="tab-portfolio" aria-controls="tab-portfolio">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 9l9-6 9 6v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M9 22V12h6v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        資産
      </button>
      <button class="tab-item" role="tab" aria-selected="false" data-tab="tab-ai" aria-controls="tab-ai">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2a4 4 0 0 1 4 4c0 1.5-.8 2.8-2 3.5V11h3a3 3 0 0 1 3 3v1.5a2.5 2.5 0 0 1-2.5 2.5H17v2a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-2h-.5A2.5 2.5 0 0 1 4 15.5V14a3 3 0 0 1 3-3h3V9.5A4 4 0 0 1 12 2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <circle cx="9.5" cy="15" r="1" fill="currentColor"/>
          <circle cx="14.5" cy="15" r="1" fill="currentColor"/>
        </svg>
        AI判断
      </button>
      <button class="tab-item" role="tab" aria-selected="false" data-tab="tab-stats" aria-controls="tab-stats">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M18 20V10M12 20V4M6 20v-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        統計
      </button>
      <button class="tab-item" role="tab" aria-selected="false" data-tab="tab-log" aria-controls="tab-log">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M14 2v6h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M8 13h8M8 17h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
        ログ
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
    </aside>

    <!-- ─── ボトムシート（ポジション詳細） ─── -->
    <div id="sheet-backdrop" class="sheet-backdrop" role="presentation"></div>
    <div id="sheet" class="sheet" role="dialog" aria-modal="true" aria-label="ポジション詳細">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-title" id="sheet-title">—</div>
      <div class="sheet-body" id="sheet-body"></div>
    </div>

  </div>
  <script src="/app.js?v=9"></script>
</body>
</html>`;
}

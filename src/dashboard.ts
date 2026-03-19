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
  <link rel="stylesheet" href="/style.css?v=5">
</head>
<body>
  <div id="app">

    <!-- ヘッダー -->
    <header class="header" role="banner">
      <h1 class="header-title">FX Sim</h1>
      <div class="header-right">
        <span id="last-updated" class="header-time" aria-live="polite">—</span>
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

      <!-- 銘柄ウォッチリスト -->
      <!-- AI最新判断（インライン） -->
      <div class="ai-inline" id="ai-card">
        <span id="ai-badge" class="badge badge-hold ai-badge">—</span>
        <span id="ai-reasoning" class="ai-inline-text">読み込み中…</span>
        <span id="ai-time" class="ai-inline-time">—</span>
        <div id="ai-status" class="ai-inline-status">—</div>
      </div>

      <!-- 銘柄ウォッチリスト -->
      <section class="card card-watchlist" aria-label="銘柄一覧">
        <div class="section-title" style="margin-bottom:4px">ポジション</div>
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

      <div class="list-header-row" style="padding-top:8px">
        <span class="list-header">銘柄別成績</span>
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
      <div id="log-stats-grid" class="stat-grid"></div>
      <div class="card" style="margin-top:4px">
        <div id="log-list"></div>
      </div>
    </div>

    <!-- ─── タブバー ─── -->
    <nav class="tab-bar" role="tablist" aria-label="メインナビゲーション">
      <button class="tab-item active" role="tab" aria-selected="true"  data-tab="tab-portfolio" aria-controls="tab-portfolio">
        <svg width="20" height="20" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <rect x="3" y="11" width="4" height="8" rx="1.5" fill="currentColor"/>
          <rect x="9" y="7"  width="4" height="12" rx="1.5" fill="currentColor"/>
          <rect x="15" y="3" width="4" height="16" rx="1.5" fill="currentColor"/>
        </svg>
        資産
      </button>
      <button class="tab-item" role="tab" aria-selected="false" data-tab="tab-ai" aria-controls="tab-ai">
        <svg width="20" height="20" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <path d="M11 3v2M11 17v2M3 11h2M17 11h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M5.5 5.5l1.5 1.5M15 15l1.5 1.5M15 5.5l-1.5 1.5M5.5 16.5l1.5-1.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          <circle cx="11" cy="11" r="2.5" fill="currentColor"/>
        </svg>
        AI判断
      </button>
      <button class="tab-item" role="tab" aria-selected="false" data-tab="tab-stats" aria-controls="tab-stats">
        <svg width="20" height="20" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <path d="M3 19 L7 13 L11 15 L15 9 L19 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="7"  cy="13" r="2" fill="currentColor"/>
          <circle cx="11" cy="15" r="2" fill="currentColor"/>
          <circle cx="15" cy="9"  r="2" fill="currentColor"/>
        </svg>
        統計
      </button>
      <button class="tab-item" role="tab" aria-selected="false" data-tab="tab-log" aria-controls="tab-log">
        <svg width="20" height="20" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <rect x="3" y="3" width="16" height="16" rx="3" stroke="currentColor" stroke-width="1.8"/>
          <path d="M7 8h8M7 11h8M7 14h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
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

    <!-- ─── ボトムシート（ポジション詳細） ─── -->
    <div id="sheet-backdrop" class="sheet-backdrop" role="presentation"></div>
    <div id="sheet" class="sheet" role="dialog" aria-modal="true" aria-label="ポジション詳細">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-title" id="sheet-title">—</div>
      <div class="sheet-body" id="sheet-body"></div>
    </div>

  </div>
  <script src="/app.js?v=5"></script>
</body>
</html>`;
}

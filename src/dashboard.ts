// GET / — ダッシュボード HTML（v7 Liquid Glass 6タブ構造）

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="FX Sim">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
  <meta name="theme-color" content="#F2F2F7" media="(prefers-color-scheme: light)">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <title>FX Sim</title>
  <link rel="stylesheet" href="/style.css?v=15">
</head>
<body>

<!-- ═══ Glass sticky header ═══ -->
<header class="sbar">
  <div class="sbar-left"><div class="dot ok" id="health-dot"></div><span class="sbar-status" id="sbar-status">正常稼働</span></div>
  <span class="sbar-time" id="sbar-time">--:--</span>
</header>

<!-- ═══ 緊急バナー ═══ -->
<div class="emergency-bar" id="emergency-bar" style="display:none"></div>

<!-- ═══ TP/SL 決済バナー（Peak-End Rule） ═══ -->
<div class="tp-banner" id="tp-banner">
  <div class="tp-banner-inner">
    <div class="tp-banner-icon" id="tp-banner-icon"></div>
    <div class="tp-banner-text">
      <div class="tp-banner-title" id="tp-banner-title"></div>
      <div class="tp-banner-sub" id="tp-banner-sub"></div>
    </div>
  </div>
</div>

<!-- ═══════════ TAB 1: 今 (tab-portfolio) ═══════════ -->
<div class="tab-panel active" id="tab-portfolio">

  <!-- PnL ヒーロー -->
  <section class="hero">
    <div class="pnl" id="pnl-today">--</div>
    <div class="pnl-sub" id="pnl-sub">今日の損益</div>
  </section>

  <!-- 5メトリクスストリップ -->
  <div class="metrics" id="metrics-strip">
    <div class="m"><div class="m-val" id="m-balance">--</div><div class="m-lbl">残高</div></div>
    <div class="m"><div class="m-val" id="m-roi">--</div><div class="m-lbl">ROI</div></div>
    <div class="m"><div class="m-val" id="m-avgrr" style="color:var(--green)">--</div><div class="m-lbl">平均RR</div></div>
    <div class="m"><div class="m-val" id="m-winrate">--</div><div class="m-lbl">勝率(RR≥1.0)</div></div>
    <div class="m"><div class="m-val" id="m-pf">--</div><div class="m-lbl">PF</div></div>
    <div class="m"><div class="m-val" id="m-trades">--</div><div class="m-lbl">取引</div></div>
  </div>

  <!-- 有意性バー -->
  <div class="sig">
    <div class="sig-track"><div class="sig-fill" id="sig-fill" style="width:0%"></div></div>
    <span class="sig-lbl" id="sig-label">有意性 --%</span>
  </div>

  <!-- ストーリーカード -->
  <div class="story" id="story-card" style="display:none">
    <div class="story-text" id="story-text"></div>
    <div class="drivers" id="causal-drivers"></div>
    <div class="chips" id="causal-chips"></div>
  </div>

  <!-- ヒートマップ -->
  <div class="hm" id="causal-heatmap" style="display:none">
    <div class="hm-g" id="heatmap-grid"></div>
  </div>

  <!-- 保有ポジション -->
  <div class="sec" id="positions-header">保有中</div>
  <div class="positions" id="positions-list"></div>

  <!-- 市場指標バー -->
  <div class="sec">市場</div>
  <div class="mkt-bar" id="market-bar"></div>

  <!-- 待機銘柄グリッド -->
  <div class="sec" id="wait-header">待機</div>
  <div class="wait-grid" id="wait-grid"></div>

  <!-- アクティビティフィード -->
  <div class="sec">アクティビティ</div>
  <div id="ai-timeline"></div>

  <!-- クロスリンク -->
  <div style="padding:16px;text-align:center">
    <span class="cross-link" onclick="switchTab('tab-stats')">→ 学びタブで変更の効果を確認</span>
  </div>

</div>

<!-- ═══════════ TAB 2: ニュース (tab-news) ═══════════ -->
<div class="tab-panel" id="tab-news">

  <!-- ニュースKPI -->
  <div class="sec">ニュース概況</div>
  <div class="kpi-grid" id="news-kpi" style="margin:0 16px 8px;grid-template-columns:repeat(4,1fr)">
    <div class="kpi"><div class="kpi-val" id="nk-total">--</div><div class="kpi-lbl">取得件数</div></div>
    <div class="kpi"><div class="kpi-val" style="color:var(--blue)" id="nk-analyzed">--</div><div class="kpi-lbl">AI分析済</div></div>
    <div class="kpi"><div class="kpi-val" style="color:var(--green)" id="nk-triggered">--</div><div class="kpi-lbl">取引発動</div></div>
    <div class="kpi"><div class="kpi-val" style="color:var(--red)" id="nk-emergency">--</div><div class="kpi-lbl">緊急</div></div>
  </div>

  <!-- 取引に影響したニュース -->
  <div class="sec">取引に影響したニュース</div>
  <div class="news-feed" id="news-feed-impacted"></div>

  <!-- 分析済み・影響なし -->
  <div class="sec">分析済み · 影響なし</div>
  <div class="news-feed" id="news-feed-analyzed"></div>

  <!-- 未分析ニュースリスト -->
  <div class="sec" id="news-unanalyzed-header">未分析ニュース</div>
  <div id="news-feed-unanalyzed" style="margin:0 16px"></div>

  <!-- ソース別統計 -->
  <div class="sec">ソース別</div>
  <div id="news-sources" style="margin:0 16px 16px"></div>

  <!-- クロスリンク -->
  <div style="padding:16px;text-align:center">
    <span class="cross-link" onclick="switchTab('tab-portfolio')">→ HOMEタブでポジション確認</span>
    <span class="cross-link" style="margin-left:16px" onclick="switchTab('tab-ai')">→ AIタブで判定確認</span>
  </div>

</div>

<!-- ═══════════ TAB 3: 学び (tab-stats) ═══════════ -->
<div class="tab-panel" id="tab-stats">

  <!-- KPI 6つ -->
  <div class="sec">全体パフォーマンス</div>
  <div class="kpi-grid" id="stats-kpi">
    <div class="kpi" style="border:1px solid rgba(48,209,88,0.2)"><div class="kpi-val" id="sk-rr" style="color:var(--green)">--</div><div class="kpi-lbl">平均RR</div></div>
    <div class="kpi"><div class="kpi-val" id="sk-winrate">--</div><div class="kpi-lbl">勝率(RR≥1.0)</div></div>
    <div class="kpi"><div class="kpi-val" id="sk-pf">--</div><div class="kpi-lbl">PF</div></div>
    <div class="kpi"><div class="kpi-val" id="sk-sharpe">--</div><div class="kpi-lbl">シャープ</div></div>
    <div class="kpi"><div class="kpi-val" id="sk-maxdd">--</div><div class="kpi-lbl">最大DD</div></div>
    <div class="kpi"><div class="kpi-val" id="sk-total">--</div><div class="kpi-lbl">総取引</div></div>
  </div>

  <!-- RR帯別内訳 -->
  <div style="margin:8px 16px 0;background:var(--surface);border-radius:var(--rs);padding:12px" id="rr-breakdown-card">
    <div style="font-size:11px;color:var(--tertiary);margin-bottom:8px;font-weight:600">RR帯別内訳</div>
    <div id="rr-breakdown"></div>
  </div>

  <!-- エクイティカーブ -->
  <div style="margin:8px 16px 0;background:var(--surface);border-radius:var(--rs);padding:12px">
    <div style="font-size:11px;color:var(--tertiary);margin-bottom:8px;font-weight:600">エクイティカーブ</div>
    <div id="equity-chart" style="height:60px;position:relative">
      <svg viewBox="0 0 320 60" style="width:100%;height:100%"></svg>
    </div>
  </div>

  <!-- 手法×環境マトリクス -->
  <div class="sec">手法 × 環境マトリクス</div>
  <div class="matrix-grid" id="strategy-matrix"></div>

  <!-- 結論 -->
  <div class="sec">全体の結論</div>
  <div class="verdict-strip" id="stats-verdict">
    <div class="verdict-box"><div class="verdict-num" id="sv-worked">--</div><div class="verdict-lbl">効いた変更</div></div>
    <div class="verdict-box"><div class="verdict-num" id="sv-didnt">--</div><div class="verdict-lbl">効かなかった</div></div>
    <div class="verdict-box"><div class="verdict-num" id="sv-pending">--</div><div class="verdict-lbl">判定中</div></div>
  </div>

  <!-- 銘柄別 Before/After カード -->
  <div class="sec">銘柄別: 変更と結果</div>
  <div id="evo-cards"></div>

  <!-- クロスリンク -->
  <div style="padding:16px;text-align:center">
    <span class="cross-link" onclick="switchTab('tab-ai')">→ AIタブで全判断の正解率を確認</span>
  </div>

  <!-- 取引履歴 -->
  <div class="sec" style="display:flex;align-items:center;justify-content:space-between;padding-right:16px">
    <span>取引履歴</span>
    <div id="th-sort-toggle" style="display:flex;gap:4px">
      <button class="th-sort-btn th-sort-active" data-sort="closed" onclick="setThSort('closed')">決済順</button>
      <button class="th-sort-btn" data-sort="entry" onclick="setThSort('entry')">エントリー順</button>
    </div>
  </div>
  <div id="trade-history" style="padding:0 16px 16px"></div>

</div>

<!-- ═══════════ TAB 4: AI (tab-ai) ═══════════ -->
<div class="tab-panel" id="tab-ai">

  <!-- ヒーロー正解率 -->
  <div class="ai-score" id="ai-score">
    <div class="ai-score-num" id="ai-score-num">--%</div>
    <div class="ai-score-label">AIの正解率</div>
    <div class="ai-score-sub" id="ai-score-sub">--</div>
  </div>

  <!-- ニュース分析/Param Review別の内訳 -->
  <div class="ai-breakdown" id="ai-breakdown">
    <div class="ai-brk"><div class="ai-brk-type">ニュース分析</div><div class="ai-brk-val" id="ai-brk-news-val">--</div><div class="ai-brk-sub" id="ai-brk-news-sub">--</div></div>
    <div class="ai-brk"><div class="ai-brk-type">Param Review</div><div class="ai-brk-val" id="ai-brk-pr-val">--</div><div class="ai-brk-sub" id="ai-brk-pr-sub">--</div></div>
  </div>

  <!-- Brierスコアスパークライン -->
  <div class="brier-row" id="ai-brier">
    <span class="brier-label">Brierスコア</span>
    <svg width="80" height="20" viewBox="0 0 80 20" class="spark-mini" id="ai-brier-spark"></svg>
    <span class="brier-val" id="ai-brier-val">--</span>
    <span style="font-size:11px;color:var(--tertiary)" id="ai-brier-trend"></span>
  </div>

  <!-- 正解/不正解/判定中 カウント -->
  <div class="verdict-strip" id="ai-verdict-strip">
    <div class="verdict-box"><div class="verdict-num" id="ai-v-correct">--</div><div class="verdict-lbl">正解</div></div>
    <div class="verdict-box"><div class="verdict-num" id="ai-v-wrong">--</div><div class="verdict-lbl">不正解</div></div>
    <div class="verdict-box"><div class="verdict-num" id="ai-v-pending">--</div><div class="verdict-lbl">判定中</div></div>
  </div>

  <!-- PARAM REVIEW セクション -->
  <div class="sec" id="ai-pr-section">Param Review</div>
  <div id="ai-pr-cards"></div>

  <!-- ニュース分析セクション -->
  <div class="sec" id="ai-news-section">ニュース分析</div>
  <div id="ai-news-cards"></div>

  <!-- クロスリンク -->
  <div style="padding:16px;text-align:center">
    <span class="cross-link" onclick="switchTab('tab-stats')">→ 学びタブで全体の効果を確認</span>
  </div>

</div>

<!-- ═══════════ TAB 5: 戦略 (tab-strategy) ═══════════ -->
<div class="tab-panel" id="tab-strategy">

  <!-- ティア分類 -->
  <div class="sec">各銘柄の進化</div>

  <!-- 各銘柄ジャーニーカード -->
  <div id="journey-cards"></div>

  <!-- クロスリンク -->
  <div style="padding:16px;text-align:center">
    <span class="cross-link" onclick="switchTab('tab-ai')">→ AIタブで判断の正確性を確認</span>
  </div>

</div>

<!-- ═══════════ TAB 6: 系統 (tab-log) ═══════════ -->
<div class="tab-panel" id="tab-log">

  <!-- ヘルスヒーロー -->
  <div class="health-hero" id="health-hero">
    <div class="health-icon">
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
        <circle cx="32" cy="32" r="28" fill="rgba(48,209,88,0.15)" stroke="#30D158" stroke-width="2"/>
        <path d="M20 32l8 8 16-16" stroke="#30D158" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="health-text" id="health-text" style="color:var(--green)">全システム正常</div>
    <div class="health-sub" id="health-sub">--</div>
  </div>

  <!-- DD段階バー -->
  <div class="sec">ドローダウン段階</div>
  <div class="dd-bar" id="dd-bar">
    <div class="dd-seg" style="width:40%;background:var(--green)" title="NORMAL"></div>
    <div class="dd-seg" style="width:20%;background:var(--orange);opacity:0.3" title="CAUTION"></div>
    <div class="dd-seg" style="width:15%;background:var(--orange);opacity:0.15" title="WARNING"></div>
    <div class="dd-seg" style="width:15%;background:var(--red);opacity:0.1" title="HALT"></div>
    <div class="dd-seg" style="width:10%;background:var(--red);opacity:0.05" title="STOP"></div>
  </div>
  <div style="margin:0 16px 8px;font-size:11px;color:var(--tertiary)" id="dd-labels">
    <span id="dd-current" style="color:var(--green);font-weight:600;display:block;margin-bottom:2px">--</span>
    <div style="display:flex;justify-content:space-between"><span>NORMAL</span><span>CAUTION</span><span>WARN</span><span>HALT</span><span>STOP</span></div>
  </div>

  <!-- 稼働率/エラー率 -->
  <div style="display:flex;gap:4px;margin:0 16px 8px" id="sys-uptime-grid">
    <div style="flex:1;padding:12px 8px;background:var(--surface);border-radius:var(--rs);text-align:center">
      <div style="font-size:18px;font-weight:700" id="sys-uptime">--</div>
      <div style="font-size:11px;color:var(--tertiary);margin-top:2px">稼働率 24h</div>
    </div>
    <div style="flex:1;padding:12px 8px;background:var(--surface);border-radius:var(--rs);text-align:center">
      <div style="font-size:18px;font-weight:700" id="sys-error-rate">--</div>
      <div style="font-size:11px;color:var(--tertiary);margin-top:2px">エラー率 24h</div>
    </div>
  </div>

  <!-- ヘルスチェック6項目 -->
  <div class="sec">ヘルスチェック（タップで詳細）</div>
  <div class="health-checks" id="health-checks"></div>

  <!-- 直近ログ（異常のみ） -->
  <div class="sec">直近ログ（異常のみ）</div>
  <div class="log-section" id="log-list" style="margin:0 16px"></div>

  <!-- 全ログ表示（折りたたみ） -->
  <div style="text-align:center;padding:24px 0">
    <button style="font-size:12px;color:var(--tertiary);cursor:pointer;background:none;border:none;padding:8px 16px;min-height:44px" onclick="var el=document.getElementById('all-logs');el.style.display=el.style.display==='none'?'block':'none'">全ログを表示 ▼</button>
  </div>
  <div id="all-logs" style="display:none;margin:0 16px"></div>

  <div style="padding:16px;text-align:center;font-size:12px;color:var(--tertiary)" id="sys-next-review"></div>

</div>

<!-- ═══ Floating Liquid Glass タブバー ═══ -->
<nav class="tabs" id="main-tabs">
  <div class="tab on" data-tab="tab-portfolio" onclick="switchTab('tab-portfolio')">
    <svg class="tab-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-8 9 8"/><path d="M5 10v9a1 1 0 001 1h3v-5h6v5h3a1 1 0 001-1v-9"/></svg>
    <span class="tab-t">HOME</span>
  </div>
  <div class="tab" data-tab="tab-news" onclick="switchTab('tab-news')">
    <svg class="tab-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h4"/><path d="M7 12h10"/><path d="M7 16h10"/></svg>
    <span class="tab-t">ニュース</span>
  </div>
  <div class="tab" data-tab="tab-stats" onclick="switchTab('tab-stats')">
    <svg class="tab-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20l5-8 4 4 5-9 4 5"/></svg>
    <span class="tab-t">学び</span>
  </div>
  <div class="tab" data-tab="tab-ai" onclick="switchTab('tab-ai')">
    <svg class="tab-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>
    <span class="tab-t">AI</span>
  </div>
  <div class="tab" data-tab="tab-strategy" onclick="switchTab('tab-strategy')">
    <svg class="tab-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h4m4 0h8M4 16h8m4 0h4"/><circle cx="10" cy="8" r="2"/><circle cx="14" cy="16" r="2"/></svg>
    <span class="tab-t">戦略</span>
  </div>
  <div class="tab" data-tab="tab-log" onclick="switchTab('tab-log')">
    <svg class="tab-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2m-9-11h2m18 0h2m-4.2-6.8l-1.4 1.4M6.6 17.4l-1.4 1.4m0-12.8l1.4 1.4m10.8 10.8l1.4 1.4"/></svg>
    <span class="tab-t">系統</span>
  </div>
</nav>

<!-- ═══ ボトムシート ═══ -->
<div id="sheet-overlay" class="sheet-backdrop" role="presentation"></div>
<div id="bottom-sheet" class="sheet" role="dialog" aria-modal="true" aria-label="詳細">
  <div class="sheet-handle" aria-hidden="true"></div>
  <div class="sheet-title" id="sheet-title">--</div>
  <div class="sheet-body" id="sheet-body"></div>
</div>

<!-- ═══ ニュースドロワー ═══ -->
<div id="news-drawer" class="news-drawer" aria-label="ニュース">
  <div id="news-drawer-handle" class="news-drawer-handle" aria-hidden="true"></div>
  <div class="news-drawer-header">
    <span class="news-drawer-title">ビジネスニュース</span>
  </div>
  <div id="news-drawer-body" class="news-drawer-body"></div>
</div>

<script src="/app.js?v=15"></script>
</body>
</html>`;
}

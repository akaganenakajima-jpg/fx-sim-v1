// ダッシュボード フロントエンド JS
// v7 Liquid Glass 6タブ構造 — render関数群

export const JS = `
(function () {
  'use strict';

  var lastData = null;
  var lastRecentCloseIds = [];
  var sheetPos = null;
  var lastPnlMap = {};

  var CATEGORY_ORDER = ['為替', '株式指数', '暗号資産', 'コモディティ', '債券'];

  var INSTRUMENTS = [
    { pair: 'USD/JPY',   label: 'USD / JPY', unit: '円', multiplier: 100,   category: '為替',       broker: 'oanda' },
    { pair: 'EUR/USD',   label: 'EUR / USD', unit: '円', multiplier: 10000, category: '為替',       broker: 'oanda' },
    { pair: 'GBP/USD',   label: 'GBP / USD', unit: '円', multiplier: 10000, category: '為替',       broker: 'oanda' },
    { pair: 'AUD/USD',   label: 'AUD / USD', unit: '円', multiplier: 10000, category: '為替',       broker: 'oanda' },
    { pair: 'S&P500',    label: 'S&P 500',   unit: '円', multiplier: 10,    category: '株式指数',   broker: 'oanda' },
    { pair: 'NASDAQ',    label: 'NASDAQ',    unit: '円', multiplier: 1,     category: '株式指数',   broker: 'oanda' },
    { pair: 'Nikkei225', label: '日経225',    unit: '円', multiplier: 1,     category: '株式指数',   broker: 'oanda' },
    { pair: 'DAX',       label: 'DAX',       unit: '円', multiplier: 1,     category: '株式指数',   broker: 'oanda' },
    { pair: 'BTC/USD',   label: 'BTC',       unit: '円', multiplier: 1,     category: '暗号資産',   broker: 'paper' },
    { pair: 'ETH/USD',   label: 'ETH',       unit: '円', multiplier: 1,     category: '暗号資産',   broker: 'paper' },
    { pair: 'SOL/USD',   label: 'SOL',       unit: '円', multiplier: 10,    category: '暗号資産',   broker: 'paper' },
    { pair: 'Gold',      label: 'Gold',      unit: '円', multiplier: 10,    category: 'コモディティ', broker: 'oanda' },
    { pair: 'Silver',    label: 'Silver',    unit: '円', multiplier: 100,   category: 'コモディティ', broker: 'oanda' },
    { pair: 'Copper',    label: '銅',        unit: '円', multiplier: 1000,  category: 'コモディティ', broker: 'oanda' },
    { pair: 'CrudeOil',  label: '原油',      unit: '円', multiplier: 100,   category: 'コモディティ', broker: 'oanda' },
    { pair: 'NatGas',    label: '天然ガス',   unit: '円', multiplier: 1000,  category: 'コモディティ', broker: 'oanda' },
    { pair: 'US10Y',     label: '米10年債',   unit: '円', multiplier: 5000,  category: '債券',       broker: 'oanda' },
  ].sort(function(a, b) {
    return CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
  });

  var INITIAL_CAPITAL = 10000;

  // ══════════════════════════════════════════
  // ユーティリティ
  // ══════════════════════════════════════════

  function el(id) { return document.getElementById(id); }

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmt(n, dec) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(dec != null ? dec : 2);
  }

  function fmtYen(amount) {
    if (amount == null || isNaN(amount)) return '—';
    return '¥' + Math.round(amount).toLocaleString('ja-JP');
  }

  function fmtYenCompact(amount) {
    if (amount == null || isNaN(amount)) return '—';
    var abs = Math.abs(Math.round(amount));
    var sign = amount >= 0 ? '+' : '-';
    if (abs >= 100000000) return sign + '¥' + (abs / 100000000).toFixed(1) + '億';
    if (abs >= 10000)     return sign + '¥' + (abs / 10000).toFixed(1) + '万';
    return sign + '¥' + abs.toLocaleString('ja-JP');
  }

  function fmtPnl(pnl, unit) {
    if (pnl == null || isNaN(pnl)) return { text: '—', cls: 'neu' };
    var sign = pnl > 0 ? '+' : pnl < 0 ? '-' : '';
    var text = unit === '円'
      ? sign + '¥' + Math.abs(Math.round(pnl)).toLocaleString('ja-JP')
      : sign + Number(pnl).toFixed(1) + (unit ? ' ' + unit : '');
    return { text: text, cls: pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'neu' };
  }

  function fmtPct(n) {
    if (n == null || isNaN(n)) return '—';
    return (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%';
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtTimeAgo(dateStr) {
    if (!dateStr) return '—';
    var diff = Date.now() - new Date(dateStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1)   return 'たった今';
    if (mins < 60)  return mins + '分前';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24)   return hrs + 'h前';
    return fmtTime(dateStr);
  }

  function fmtPrice(pair, rate) {
    if (rate == null) return '—';
    if (pair === 'USD/JPY' || pair === 'EUR/USD' || pair === 'GBP/USD' || pair === 'AUD/USD') return Number(rate).toFixed(3);
    if (pair === 'US10Y')   return Number(rate).toFixed(2) + '%';
    if (pair === 'BTC/USD' || pair === 'ETH/USD') return '$' + Number(rate).toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (pair === 'SOL/USD' || pair === 'Silver') return '$' + Number(rate).toFixed(2);
    if (pair === 'Gold')    return '$' + Number(rate).toLocaleString('en-US', { maximumFractionDigits: 1 });
    if (pair === 'CrudeOil' || pair === 'NatGas' || pair === 'Copper') return '$' + Number(rate).toFixed(2);
    return Number(rate).toLocaleString('ja-JP', { maximumFractionDigits: 0 });
  }

  function isToday(dateStr) {
    if (!dateStr) return false;
    return dateStr.slice(0, 10) === new Date().toISOString().slice(0, 10);
  }

  function fmtReasoning(text) {
    if (!text) return '—';
    if (text.indexOf('スキップ:') === 0) {
      if (text.indexOf('変化なし') !== -1) return '待機中 — 変化なし';
      if (text.indexOf('スキップ時間帯') !== -1) return '待機中 — 重要指標時間帯';
      return '待機中 — ' + text.replace(/^スキップ:\\s*/, '').split('(')[0].trim();
    }
    if (text.indexOf('Geminiエラー') === 0) return 'AI判断エラー — 次回再試行';
    return text;
  }

  function inferTrigger(d) {
    var r = (d.reasoning || '');
    if (r.indexOf('[PATH_B]') !== -1) return 'news';
    if (r.indexOf('[RATE]')   !== -1) return 'rate';
    if (r.indexOf('[CRON]')   !== -1) return 'cron';
    var rl = r.toLowerCase();
    if (rl.indexOf('レート') !== -1 || rl.indexOf('変動') !== -1) return 'rate';
    return 'cron';
  }

  function triggerLabel(type) {
    if (type === 'news') return 'ニュース起動';
    if (type === 'rate') return 'レート変動';
    return '定期 30m';
  }

  function getCurrentRate(pair) {
    if (!lastData) return null;
    if (pair === 'USD/JPY') return lastData.rate;
    var pts = lastData.sparklines && lastData.sparklines[pair];
    if (pts && pts.length > 0) return pts[pts.length - 1].rate;
    var ld = lastData.latestDecision;
    if (ld) {
      if (pair === 'Nikkei225') return ld.nikkei;
      if (pair === 'S&P500')    return ld.sp500;
      if (pair === 'US10Y')     return ld.us10y;
    }
    return null;
  }

  function findInstr(pair) {
    for (var i = 0; i < INSTRUMENTS.length; i++) {
      if (INSTRUMENTS[i].pair === pair) return INSTRUMENTS[i];
    }
    return null;
  }

  // ══════════════════════════════════════════
  // スパークライン
  // ══════════════════════════════════════════

  function drawSparkline(points, color, width, height) {
    if (!points || points.length < 2) return '';
    var rates = points.map(function(p) { return p.rate; });
    var min = Math.min.apply(null, rates);
    var max = Math.max.apply(null, rates);
    var range = max - min || 1;
    var pad = 2;
    var w = width  || 60;
    var h = height || 28;
    var step = (w - pad * 2) / (rates.length - 1);
    var pts = rates.map(function(r, i) {
      var x = pad + i * step;
      var y = h - pad - ((r - min) / range) * (h - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return '<svg class="sparkline" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
      '<polyline points="' + pts + '" fill="none" stroke="' + escHtml(color) + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  }

  // ══════════════════════════════════════════
  // PnL カウントアップアニメーション
  // ══════════════════════════════════════════

  function animateVal(elem, toVal, formatter) {
    if (!elem || isNaN(toVal)) return;
    var fromVal = parseFloat(elem.dataset.animVal) || 0;
    var isFirst = !elem.dataset.animVal;
    elem.dataset.animVal = toVal;
    if (fromVal === toVal && !isFirst) return;
    if (fromVal === toVal) { elem.textContent = formatter(toVal); return; }
    var duration = 800;
    var start = null;
    function step(ts) {
      if (!start) start = ts;
      var progress = Math.min((ts - start) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      var current = fromVal + (toVal - fromVal) * ease;
      elem.textContent = formatter(current);
      if (progress < 1) requestAnimationFrame(step);
      else elem.textContent = formatter(toVal);
    }
    requestAnimationFrame(step);
  }

  // ══════════════════════════════════════════
  // タブ切替
  // ══════════════════════════════════════════

  window.switchTab = switchTab;
  function switchTab(tabId, scrollTo) {
    var panels = document.querySelectorAll('.tab-panel');
    for (var i = 0; i < panels.length; i++) panels[i].classList.remove('active');
    var target = document.getElementById(tabId);
    if (target) target.classList.add('active');

    var tabs = document.querySelectorAll('.tabs .tab');
    for (var j = 0; j < tabs.length; j++) {
      tabs[j].classList.remove('on');
      var t = tabs[j].querySelector('.tab-t');
      if (t) t.style.color = '';
    }
    var activeTab = document.querySelector('.tab[data-tab="' + tabId + '"]');
    if (activeTab) {
      activeTab.classList.add('on');
      var at = activeTab.querySelector('.tab-t');
      if (at) at.style.color = 'var(--blue)';
    }

    // ニュースドロワー: 今タブのみ表示
    var drawer = document.getElementById('news-drawer');
    if (drawer) drawer.style.display = (tabId === 'tab-portfolio') ? '' : 'none';

    window.scrollTo(0, 0);

    // チャート再描画（表示後にサイズ取得が必要）
    if (tabId === 'tab-stats' && lastData) {
      requestAnimationFrame(function() { renderEquityChart(lastData); });
    }

    // ディープリンク
    if (scrollTo) {
      setTimeout(function() {
        var scrollEl = document.getElementById(scrollTo);
        if (scrollEl) {
          scrollEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          scrollEl.classList.add('highlight-flash');
          setTimeout(function() { scrollEl.classList.remove('highlight-flash'); }, 800);
        }
      }, 150);
    }
  }

  // ══════════════════════════════════════════
  // render() — メインルーター
  // ══════════════════════════════════════════

  function render(data) {
    lastData = data;
    renderHeader(data);
    renderAlertBanner(data);
    renderHero(data);
    renderStory(data);
    renderNewsFeedNow(data);
    renderPositions(data);
    renderMarket(data);
    renderWaiting(data);
    renderNewsTab(data);
    renderStatsTab(data);
    renderAiTab(data);
    renderStrategyTab(data);
    renderSystemTab(data);
    detectAndShowBanner(data);
    // ニュースドロワー
    var newsForDrawer = (data.acceptedNews || []).length > 0
      ? (data.acceptedNews || []).map(function(n) {
          return { title: n.title_ja, title_ja: n.title_ja, description: n.desc_ja, desc_ja: n.desc_ja, pubDate: n.fetched_at, source: n.source, url: n.url || null };
        })
      : (data.latestNews || []);
    if (window._renderNews) window._renderNews(newsForDrawer, data.newsAnalysis || []);
  }

  // ══════════════════════════════════════════
  // renderHeader
  // ══════════════════════════════════════════

  function renderHeader(data) {
    var dot = el('health-dot');
    var statusText = el('sbar-status');
    var timeEl = el('sbar-time');

    var rs = data.riskStatus;
    if (dot) {
      dot.className = 'dot ' + (rs && rs.killSwitchActive ? 'danger' : 'ok');
    }
    if (statusText) {
      statusText.textContent = (rs && rs.killSwitchActive) ? 'DD STOP' : '正常稼働';
    }
    if (timeEl) {
      timeEl.textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    }
  }

  // ══════════════════════════════════════════
  // renderAlertBanner
  // ══════════════════════════════════════════

  function renderAlertBanner(data) {
    var container = el('emergency-bar');
    if (!container) return;
    var alerts = [];

    if (data.riskStatus && data.riskStatus.killSwitchActive) {
      alerts.push({ cls: 'alert-red', text: '\\u26A0\\uFE0F DD STOP — 日次損失上限超過。新規エントリー停止中' });
    } else if (data.riskStatus && data.riskStatus.maxDailyLoss > 0 &&
               data.riskStatus.todayLoss / data.riskStatus.maxDailyLoss > 0.8) {
      var pct = Math.round(data.riskStatus.todayLoss / data.riskStatus.maxDailyLoss * 100);
      alerts.push({ cls: 'alert-orange', text: '\\u26A1 DD注意 — 日次損失が上限の' + pct + '%に到達' });
    }

    if (data.newsAnalysis) {
      var now = Date.now();
      var tenMin = 10 * 60 * 1000;
      for (var ni = 0; ni < data.newsAnalysis.length; ni++) {
        var n = data.newsAnalysis[ni];
        if (n.attention && n.analyzed_at) {
          var diff = now - new Date(n.analyzed_at).getTime();
          if (diff < tenMin) {
            alerts.push({ cls: 'alert-red', text: '\\uD83D\\uDD34 緊急ニュース: ' + (n.title_ja || n.title || '速報') });
          }
        }
      }
    }

    if (data.systemLogs) {
      var recentErrors = data.systemLogs.slice(0, 5).filter(function(l) { return l.level === 'ERROR'; });
      if (recentErrors.length > 0) {
        alerts.push({ cls: 'alert-orange', text: '\\uD83D\\uDD27 システムエラー検出: ' + (recentErrors[0].message || '') });
      }
    }

    if (alerts.length === 0) { container.style.display = 'none'; return; }
    container.style.display = '';
    container.innerHTML = alerts.map(function(a) {
      return '<div class="' + a.cls + '" style="padding:8px 16px;font-size:12px;font-weight:600">' + escHtml(a.text) + '</div>';
    }).join('');
  }

  // ══════════════════════════════════════════
  // renderHero — PnLヒーロー + メトリクスストリップ + 有意性バー
  // ══════════════════════════════════════════

  function renderHero(data) {
    var perf = data.performance;
    if (!perf) return;

    // PnL today
    var pnlEl = el('pnl-today');
    if (pnlEl) {
      var todayPnl = perf.todayPnl || 0;
      var sign = todayPnl >= 0 ? '+' : '';
      pnlEl.textContent = sign + fmtYen(todayPnl).replace('¥', '¥');
      pnlEl.className = 'pnl ' + (todayPnl > 0 ? 'pos' : todayPnl < 0 ? 'neg' : '');
    }

    var subEl = el('pnl-sub');
    if (subEl) subEl.textContent = '今日の損益';

    // メトリクスストリップ
    var totalPnl = perf.totalPnl || 0;
    var capital = INITIAL_CAPITAL + totalPnl;
    var roiPct = (totalPnl / INITIAL_CAPITAL) * 100;

    var balEl = el('m-balance');
    if (balEl) balEl.textContent = fmtYen(capital);

    var roiEl = el('m-roi');
    if (roiEl) roiEl.textContent = fmtPct(roiPct);

    var wrEl = el('m-winrate');
    if (wrEl) wrEl.textContent = (perf.winRate != null ? perf.winRate.toFixed(1) + '%' : '—');

    var pfEl = el('m-pf');
    if (pfEl) {
      var st = data.statistics;
      pfEl.textContent = (st && st.profitFactor != null) ? st.profitFactor.toFixed(2) : '—';
    }

    var tradesEl = el('m-trades');
    if (tradesEl) tradesEl.textContent = (perf.totalClosed != null ? perf.totalClosed + '件' : '—');

    // 有意性バー
    var sigFill = el('sig-fill');
    var sigLabel = el('sig-label');
    var st = data.statistics;
    if (sigFill && st && st.powerAnalysis) {
      var pa = st.powerAnalysis;
      var pct = Math.max(0, Math.min(Math.round(pa.progressPct), 100));
      sigFill.style.width = pct + '%';
      if (pa.isAdequate) sigFill.style.background = 'var(--green)';
      if (sigLabel) sigLabel.textContent = '有意性 ' + pct + '%';
    }
  }

  // ══════════════════════════════════════════
  // renderStory — 因果サマリー
  // ══════════════════════════════════════════

  function renderStory(data) {
    var card = el('story-card');
    if (!card) return;
    var cs = data.causalSummary;
    if (!cs) { card.style.display = 'none'; return; }
    card.style.display = '';

    var textEl = el('story-text');
    if (textEl) textEl.innerHTML = cs.narrative || '';

    // ドライバーカード（モックアップ: .drivers > .drv 構造）
    var driversEl = el('causal-drivers');
    if (driversEl && cs.drivers) {
      var html = '';
      if (cs.drivers.profitTop) {
        var p = cs.drivers.profitTop;
        html += '<div class="drv" onclick="switchTab(\\'' + 'tab-stats\\', \\'perf-' + (p.pair || '').replace(/[\\/\\s]/g, '-') + '\\')">' +
          '<div class="drv-tag profit">利益TOP</div><div class="drv-pair">' + escHtml(p.pair) + '</div>' +
          '<div class="drv-pnl" style="color:var(--green)">+' + Math.round(p.pnl) + '</div>' +
          '<div class="drv-reason">' + escHtml(p.reason || '') + '</div></div>';
      }
      if (cs.drivers.lossTop) {
        var l = cs.drivers.lossTop;
        html += '<div class="drv" onclick="switchTab(\\'' + 'tab-stats\\', \\'perf-' + (l.pair || '').replace(/[\\/\\s]/g, '-') + '\\')">' +
          '<div class="drv-tag loss">損失TOP</div><div class="drv-pair">' + escHtml(l.pair) + '</div>' +
          '<div class="drv-pnl" style="color:var(--red)">' + Math.round(l.pnl) + '</div>' +
          '<div class="drv-reason">' + escHtml(l.reason || '') + '</div></div>';
      }
      driversEl.innerHTML = html;
    }

    // 要因バッジ（モックアップ: .chips > .chip.w / .chip.i 構造）
    var chipsEl = el('causal-chips');
    if (chipsEl && cs.drivers && cs.drivers.factors) {
      chipsEl.innerHTML = cs.drivers.factors.map(function(f) {
        var cls = f.severity === 'high' ? 'w' : f.severity === 'medium' ? 'w' : 'i';
        return '<span class="chip ' + cls + '">' + escHtml(f.label) + '</span>';
      }).join('');
    }

    // ヒートマップ
    renderHeatmap(cs.heatmap);
  }

  function renderHeatmap(heatmapData) {
    var hmEl = el('causal-heatmap');
    if (!hmEl) return;
    if (!heatmapData || heatmapData.length === 0) { hmEl.style.display = 'none'; return; }
    hmEl.style.display = '';
    var gridEl = el('heatmap-grid');
    if (!gridEl) return;

    var cols = ['銘柄', 'PnL', 'VIX', 'PR', 'ニュース'];
    var keys = ['pnl_closed', 'vix_effect', 'param_changed', 'news_impact'];
    var html = '';
    for (var h = 0; h < cols.length; h++) html += '<div class="hm-h">' + cols[h] + '</div>';
    var limit = Math.min(heatmapData.length, 8);
    for (var i = 0; i < limit; i++) {
      var row = heatmapData[i];
      html += '<div class="hm-p">' + escHtml(row.pair) + '</div>';
      for (var k = 0; k < keys.length; k++) {
        var val = (row.factors && row.factors[keys[k]]) || 0;
        var bg = hmColor(val, keys[k]);
        html += '<div class="hm-c" style="background:' + bg + '">' + hmLabel(val, keys[k]) + '</div>';
      }
    }
    gridEl.innerHTML = html;
  }

  function hmColor(val, key) {
    if (key === 'pnl_closed') {
      if (val > 0) return 'rgba(48,209,88,' + Math.min(Math.abs(val) / 500, 0.6) + ')';
      if (val < 0) return 'rgba(255,69,58,' + Math.min(Math.abs(val) / 500, 0.6) + ')';
    }
    if (key === 'vix_effect' && val > 0) return 'rgba(255,159,10,' + Math.min(val, 0.6) + ')';
    if (key === 'param_changed' && val > 0) return 'rgba(10,132,255,0.3)';
    if (key === 'news_impact' && val > 0) return 'rgba(255,69,58,' + Math.min(val / 100 * 0.6, 0.6) + ')';
    return 'transparent';
  }

  function hmLabel(val, key) {
    if (key === 'pnl_closed' && val !== 0) return (val > 0 ? '+' : '') + Math.round(val);
    if (key === 'vix_effect' && val > 0) return val.toFixed(1);
    if (key === 'param_changed' && val > 0) return '\\u2713';
    if (key === 'news_impact' && val > 0) return Math.round(val);
    return '\\u2014';
  }

  // ══════════════════════════════════════════
  // renderNewsFeedNow — ニュース速報（今タブ）
  // ══════════════════════════════════════════

  function renderNewsFeedNow(data) {
    var feedEl = el('news-feed-now');
    if (!feedEl) return;
    var items = (data.newsAnalysis || []).filter(function(n) { return n.attention; }).slice(0, 3);
    if (items.length === 0) { feedEl.innerHTML = '<div style="padding:16px;text-align:center;font-size:12px;color:var(--tertiary)">速報なし</div>'; return; }

    feedEl.innerHTML = items.map(function(n) {
      var score = n.impact ? parseInt(n.impact) : 0;
      if (isNaN(score)) score = 0;
      var badgeCls = score >= 90 ? 'nf-badge-emergency' : score >= 70 ? 'nf-badge-trend' : 'nf-badge-info';
      var badgeText = score >= 90 ? '緊急' : score >= 70 ? 'トレンド' : '情報';
      var borderCls = score >= 90 ? 'nf-emergency' : score >= 70 ? 'nf-trend' : '';
      var headline = n.title_ja || n.title || '';
      var aiText = n.desc_ja || n.title_ja || n.title || '';

      return '<div class="nf-item ' + borderCls + '" onclick="switchTab(\\'tab-news\\')">' +
        '<div class="nf-header"><span class="nf-badge ' + badgeCls + '">' + badgeText + ' · score ' + score + '</span>' +
        '<span class="nf-time">' + fmtTimeAgo(n.analyzed_at || '') + '</span></div>' +
        '<div class="nf-headline">' + escHtml(headline) + '</div>' +
        '<div class="nf-ai"><span class="nf-ai-label">AI判断</span><span class="nf-ai-text">' + escHtml(aiText) + '</span></div>' +
        '</div>';
    }).join('');
  }

  // ══════════════════════════════════════════
  // renderPositions — 保有ポジション
  // ══════════════════════════════════════════

  function renderPositions(data) {
    var listEl = el('positions-list');
    if (!listEl) return;
    var opens = data.openPositions || [];
    if (opens.length === 0) {
      listEl.innerHTML = '<div style="padding:16px;text-align:center;font-size:13px;color:var(--tertiary)">ポジションなし</div>';
      return;
    }

    // ヘッダー更新（保有件数・含み損益）
    var headerEl = el('positions-header');
    if (headerEl) {
      var totalUnrealized = 0;
      for (var u = 0; u < opens.length; u++) {
        var ui = findInstr(opens[u].pair);
        var ucr = getCurrentRate(opens[u].pair);
        if (ui && ucr != null) {
          totalUnrealized += opens[u].direction === 'BUY'
            ? (ucr - opens[u].entry_rate) * ui.multiplier * (opens[u].lot || 1)
            : (opens[u].entry_rate - ucr) * ui.multiplier * (opens[u].lot || 1);
        }
      }
      var unrealColor = totalUnrealized >= 0 ? 'var(--green)' : 'var(--red)';
      var unrealSign = totalUnrealized >= 0 ? '+' : '';
      headerEl.innerHTML = '保有中 · ' + opens.length + '件 · 含み <span style="color:' + unrealColor + '">' + unrealSign + fmtYen(totalUnrealized) + '</span>';
    }

    listEl.innerHTML = opens.map(function(pos) {
      var instr = findInstr(pos.pair);
      var cr = getCurrentRate(pos.pair);
      var unrealized = 0;
      if (instr && cr != null) {
        unrealized = pos.direction === 'BUY'
          ? (cr - pos.entry_rate) * instr.multiplier * (pos.lot || 1)
          : (pos.entry_rate - cr) * instr.multiplier * (pos.lot || 1);
      }
      var pnlF = fmtPnl(unrealized, instr ? instr.unit : '');
      var winLose = unrealized >= 0 ? 'win' : 'lose';
      var pnlCls = unrealized > 0 ? 'pos' : unrealized < 0 ? 'neg' : '';
      var dirCls = pos.direction === 'BUY' ? 'b' : 's';
      var dirLetter = pos.direction === 'BUY' ? 'B' : 'S';

      // 保有時間
      var holdTime = '';
      var holdHrs = 0;
      if (pos.entry_at) {
        var holdMs = Date.now() - new Date(pos.entry_at).getTime();
        holdHrs = Math.floor(holdMs / 3600000);
        holdTime = holdHrs < 1 ? Math.floor(holdMs / 60000) + '分' : holdHrs + 'h';
      }
      var timeWarnCls = holdHrs >= 8 ? ' time-warn' : '';

      // RR
      var rrText = '';
      if (pos.tp_rate != null && pos.sl_rate != null && pos.entry_rate) {
        var tpDist = Math.abs(pos.tp_rate - pos.entry_rate);
        var slDist = Math.abs(pos.sl_rate - pos.entry_rate);
        if (slDist > 0) rrText = 'RR' + (tpDist / slDist).toFixed(1);
      }

      // スパークライン
      var sparkPts = data.sparklines && data.sparklines[pos.pair];
      var sparkColor = unrealized >= 0 ? '#30D158' : '#FF453A';
      var sparkSvg = drawSparkline(sparkPts, sparkColor, 48, 16);

      return '<div class="pos ' + winLose + '" onclick="openSheet(\\'' + escHtml(pos.pair) + '\\')">' +
        '<div class="pos-dir ' + dirCls + '">' + dirLetter + '</div>' +
        '<div class="pos-body">' +
          '<div class="pos-top"><span class="pos-pair">' + escHtml(instr ? instr.label : pos.pair) + '</span>' +
          '<span class="pos-pnl ' + pnlCls + '">' + pnlF.text + '</span></div>' +
          '<div class="pos-bot"><span class="pos-meta">' +
            fmtPrice(pos.pair, pos.entry_rate) + '\\u2192' + fmtPrice(pos.pair, cr) +
            ' · <span class="' + timeWarnCls.trim() + '">' + holdTime + '</span>' +
            (rrText ? ' · ' + rrText : '') +
          '</span>' + sparkSvg + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ══════════════════════════════════════════
  // renderMarket — 市場指標バー
  // ══════════════════════════════════════════

  function renderMarket(data) {
    var bar = el('market-bar');
    if (!bar) return;
    var ld = data.latestDecision;
    var items = [];
    if (ld) {
      if (ld.vix != null)   items.push({ label: 'VIX', value: fmt(ld.vix, 1), color: ld.vix > 20 ? 'var(--orange)' : '', delta: '' });
      if (ld.us10y != null) items.push({ label: 'US10Y', value: fmt(ld.us10y, 2) + '%', color: '', delta: '' });
    }
    if (ld) {
      if (ld.nikkei != null) items.push({ label: '日経', value: Number(ld.nikkei).toLocaleString('ja-JP', { maximumFractionDigits: 0 }), color: '', delta: '' });
      if (ld.sp500 != null)  items.push({ label: 'S&P', value: Number(ld.sp500).toLocaleString('en-US', { maximumFractionDigits: 0 }), color: '', delta: '' });
    }
    if (items.length === 0) { bar.innerHTML = ''; return; }
    bar.innerHTML = items.map(function(it) {
      return '<div class="mkt"><div class="mkt-v"' + (it.color ? ' style="color:' + it.color + '"' : '') + '>' + it.value + '</div>' +
        '<div class="mkt-l">' + it.label + '</div>' +
        (it.delta ? '<div class="mkt-d ' + (it.delta.indexOf('-') === 0 ? 'dn' : 'up') + '">' + it.delta + '</div>' : '') +
      '</div>';
    }).join('');
  }

  // ══════════════════════════════════════════
  // renderWaiting — 待機銘柄
  // ══════════════════════════════════════════

  function renderWaiting(data) {
    var grid = el('wait-grid');
    if (!grid) return;
    var posMap = {};
    (data.openPositions || []).forEach(function(p) { posMap[p.pair] = true; });
    var waitItems = INSTRUMENTS.filter(function(i) { return !posMap[i.pair]; });
    if (waitItems.length === 0) { grid.innerHTML = ''; return; }

    // 待機ヘッダー更新
    var waitHeader = el('wait-header');
    if (waitHeader) waitHeader.textContent = '待機 · ' + waitItems.length + '銘柄';

    grid.innerHTML = waitItems.map(function(instr) {
      var rate = getCurrentRate(instr.pair);
      return '<div class="wt">' +
        '<div class="wt-pair">' + escHtml(instr.label) + '</div>' +
        '<div class="wt-price">' + fmtPrice(instr.pair, rate) + '</div>' +
      '</div>';
    }).join('');
  }

  // ══════════════════════════════════════════
  // renderNewsTab — ニュースタブ全体
  // ══════════════════════════════════════════

  function renderNewsTab(data) {
    var analysis = data.newsAnalysis || [];
    var accepted = data.acceptedNews || [];
    var latest = data.latestNews || [];

    // KPI
    var totalCount = latest.length + accepted.length;
    var analyzedCount = analysis.length;
    var triggeredCount = analysis.filter(function(n) { return n.attention; }).length;
    // 緊急: attentionかつaffected_pairsが複数、またはattentionが最高優先度のニュース
    var emergencyCount = analysis.filter(function(n) {
      return n.attention && n.affected_pairs && n.affected_pairs.length >= 2;
    }).length;

    var nkTotal = el('nk-total'); if (nkTotal) nkTotal.textContent = String(totalCount || '—');
    var nkAnalyzed = el('nk-analyzed'); if (nkAnalyzed) nkAnalyzed.textContent = String(analyzedCount || '—');
    var nkTriggered = el('nk-triggered'); if (nkTriggered) nkTriggered.textContent = String(triggeredCount || '—');
    var nkEmergency = el('nk-emergency'); if (nkEmergency) nkEmergency.textContent = String(emergencyCount || '—');

    // 取引に影響したニュース
    var impacted = el('news-feed-impacted');
    if (impacted) {
      var impactedItems = analysis.filter(function(n) { return n.attention; });
      impacted.innerHTML = impactedItems.length > 0
        ? impactedItems.map(function(n) { return newsCard(n, true); }).join('')
        : '<div style="padding:16px;font-size:12px;color:var(--tertiary)">なし</div>';
    }

    // 分析済み・影響なし
    var analyzed = el('news-feed-analyzed');
    if (analyzed) {
      var noImpact = analysis.filter(function(n) { return !n.attention; });
      analyzed.innerHTML = noImpact.length > 0
        ? noImpact.slice(0, 10).map(function(n) { return newsCard(n, false); }).join('')
        : '<div style="padding:16px;font-size:12px;color:var(--tertiary)">なし</div>';
    }

    // 未分析
    var unanalyzed = el('news-feed-unanalyzed');
    var unHeader = el('news-unanalyzed-header');
    if (unanalyzed) {
      var analyzedTitles = {};
      analysis.forEach(function(a) { if (a.title) analyzedTitles[a.title] = true; });
      var unItems = latest.filter(function(n) { return !analyzedTitles[n.title]; });
      if (unHeader) unHeader.textContent = '未分析ニュース · ' + unItems.length + '件';
      if (unItems.length > 0) {
        var shown = unItems.slice(0, 5);
        var rest = unItems.length - shown.length;
        unanalyzed.innerHTML = shown.map(function(n) {
          return '<div style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px">' +
            '<span style="color:var(--tertiary);font-size:11px;margin-right:8px">' + fmtTimeAgo(n.pubDate || '') + '</span>' +
            escHtml(n.title_ja || n.title) + '</div>';
        }).join('') +
        (rest > 0 ? '<div style="padding:12px 0;font-size:12px;color:var(--tertiary);text-align:center">他' + rest + '件...</div>' : '');
      } else {
        unanalyzed.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--tertiary)">なし</div>';
      }
    }

    // ソース別統計
    var sourcesEl = el('news-sources');
    if (sourcesEl) {
      var sourceMap = {};
      var allNews = (latest || []).concat(accepted || []);
      allNews.forEach(function(n) {
        var src = n.source || 'その他';
        sourceMap[src] = (sourceMap[src] || 0) + 1;
      });
      var sourceKeys = Object.keys(sourceMap).sort(function(a, b) { return sourceMap[b] - sourceMap[a]; });
      if (sourceKeys.length > 0) {
        sourcesEl.innerHTML = sourceKeys.map(function(s, i) {
          var border = i < sourceKeys.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.04);' : '';
          return '<div style="display:flex;justify-content:space-between;padding:8px 0;' + border + 'font-size:13px"><span>' + escHtml(s) + '</span><span style="color:var(--secondary)">' + sourceMap[s] + '件</span></div>';
        }).join('');
      } else {
        sourcesEl.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--tertiary)">データなし</div>';
      }
    }
  }

  function newsCard(n, highlight) {
    // attention=trueなら緊急/トレンド扱い、falseなら情報
    var isAttention = !!n.attention;
    var isEmergency = isAttention && n.affected_pairs && n.affected_pairs.length >= 2;
    var badgeCls = isEmergency ? 'nf-badge-emergency' : isAttention ? 'nf-badge-trend' : 'nf-badge-info';
    var badgeText = isEmergency ? '緊急' : isAttention ? 'トレンド' : '情報';
    var borderCls = isEmergency ? 'nf-emergency' : isAttention ? 'nf-trend' : 'nf-info';
    // impactフィールドはAI判断テキスト（数値スコアではない）
    var impactText = typeof n.impact === 'string' ? n.impact : '';
    var aiText = n.desc_ja || n.description || impactText || '';
    var whyHtml = '';
    if (n.why_chain && n.why_chain.length > 0) {
      whyHtml = '<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.04)">' +
        '<div style="font-size:11px;color:var(--tertiary);margin-bottom:4px">Why\\u00d75</div>' +
        '<div style="font-size:12px;color:var(--secondary);line-height:1.6;padding-left:8px;border-left:2px solid var(--tertiary)">' +
        n.why_chain.map(function(w, i) { return '\\u2460\\u2461\\u2462\\u2463\\u2464'.charAt(i) + ' ' + escHtml(w); }).join('<br>') +
        '</div></div>';
    }
    var pairsHtml = '';
    if (n.affected_pairs && n.affected_pairs.length > 0) {
      pairsHtml = '<div class="nf-action"><span style="font-size:12px;color:var(--tertiary)">\\u2192</span>' +
        '<span class="nf-action-text">影響銘柄: <b>' + n.affected_pairs.join(', ') + '</b></span></div>';
    }
    var crossHtml = '';
    if (isAttention) {
      crossHtml = '<div style="margin-top:8px"><span class="cross-link" onclick="switchTab(\\\'tab-portfolio\\\')">\\u2192 今タブでポジション確認</span></div>';
    }
    return '<div class="nf-item ' + borderCls + '">' +
      '<div class="nf-header"><span class="nf-badge ' + badgeCls + '">' + badgeText + '</span><span class="nf-time">' + fmtTimeAgo(n.analyzed_at || n.pubDate || '') + '</span></div>' +
      '<div class="nf-headline">' + escHtml(n.title_ja || n.title || '') + '</div>' +
      (aiText ? '<div class="nf-ai"><span class="nf-ai-label">AI判断</span><span class="nf-ai-text">' + escHtml(aiText) + '</span></div>' : '') +
      pairsHtml + whyHtml + crossHtml +
    '</div>';
  }

  // ══════════════════════════════════════════
  // renderStatsTab — 学びタブ
  // ══════════════════════════════════════════

  function renderStatsTab(data) {
    var st = data.statistics;
    var perf = data.performance || {};

    // KPI 6つ
    var skWr = el('sk-winrate'); if (skWr) skWr.textContent = perf.winRate != null ? perf.winRate.toFixed(1) + '%' : '—';
    var skPf = el('sk-pf'); if (skPf) skPf.textContent = st && st.profitFactor != null ? st.profitFactor.toFixed(2) : '—';
    var skSh = el('sk-sharpe'); if (skSh) skSh.textContent = st && st.sharpe != null ? st.sharpe.toFixed(2) : '—';
    var skDd = el('sk-maxdd');
    if (skDd) {
      var dd = st && st.drawdown;
      skDd.textContent = dd ? '-' + dd.maxDDPct.toFixed(1) + '%' : '—';
    }
    var skRr = el('sk-rr');
    if (skRr) {
      var avgRR = st && st.avgRR;
      skRr.textContent = avgRR != null ? avgRR.toFixed(2) : '—';
    }
    var skTotal = el('sk-total'); if (skTotal) skTotal.textContent = perf.totalClosed != null ? String(perf.totalClosed) : '—';

    // エクイティカーブ
    renderEquityChart(data);

    // 手法×環境マトリクス
    renderStrategyMatrix(data);

    // 結論ストリップ
    renderStatsVerdict(data);

    // 銘柄別 evoカード
    renderEvoCards(data);
  }

  function renderEquityChart(data) {
    var chartEl = el('equity-chart');
    if (!chartEl) return;
    var svg = chartEl.querySelector('svg');
    if (!svg) return;

    var closes = (data.recentCloses || []).slice().reverse();
    if (closes.length < 2) {
      svg.innerHTML = '<text x="160" y="35" text-anchor="middle" font-size="12" fill="var(--tertiary)">データ蓄積中...</text>';
      return;
    }
    var cumPnl = [];
    var sum = INITIAL_CAPITAL;
    for (var i = 0; i < closes.length; i++) {
      sum += (closes[i].pnl || 0);
      cumPnl.push(sum);
    }
    var min = Math.min.apply(null, cumPnl);
    var max = Math.max.apply(null, cumPnl);
    var range = max - min || 1;
    var w = 320, h = 60, pad = 4;
    var step = (w - pad * 2) / (cumPnl.length - 1);
    var pts = cumPnl.map(function(v, i) {
      var x = pad + i * step;
      var y = h - pad - ((v - min) / range) * (h - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var color = cumPnl[cumPnl.length - 1] >= INITIAL_CAPITAL ? 'var(--green)' : 'var(--red)';

    // パラメーター変更マーカー（縦破線 + ラベル）
    var markerHtml = '';
    var ph = data.paramHistory || [];
    // 最古のcloseのタイムスタンプを基準点として時系列マッピング
    var closeTimes = closes.map(function(c) { return new Date(c.closed_at || c.entry_at || 0).getTime(); });
    var tMin = closeTimes[0] || 0;
    var tMax = closeTimes[closeTimes.length - 1] || 1;
    var tRange = tMax - tMin || 1;
    var markerColors = ['#0A84FF', '#BF5AF2', '#FF9F0A', '#30D158'];
    var usedX = {};
    ph.slice(0, 4).forEach(function(ph_item, mi) {
      var t = new Date(ph_item.created_at || ph_item.time || 0).getTime();
      if (!t) return;
      var ratio = Math.max(0, Math.min(1, (t - tMin) / tRange));
      var mx = Math.round(pad + ratio * (w - pad * 2));
      if (usedX[mx]) mx = mx + 8; // 重複回避
      usedX[mx] = true;
      var col = markerColors[mi % markerColors.length];
      var label = mi === 0 ? 'v2開始' : 'PR#' + (mi + 1);
      markerHtml += '<line x1="' + mx + '" y1="0" x2="' + mx + '" y2="' + h + '" stroke="' + col + '" stroke-width="1" stroke-dasharray="3"/>';
      markerHtml += '<text x="' + (mx + 2) + '" y="10" fill="' + col + '" font-size="8">' + label + '</text>';
    });

    svg.innerHTML = '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' + markerHtml;
  }

  function renderStrategyMatrix(data) {
    var matrixEl = el('strategy-matrix');
    if (!matrixEl) return;
    var sm = data.strategyMap;
    if (!sm || !sm.strategyStats || sm.strategyStats.length === 0) {
      matrixEl.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--tertiary)">データ蓄積中...</div>';
      return;
    }
    // Build matrix: strategy x regime
    var strategies = [];
    var regimes = [];
    var cellMap = {};
    sm.strategyStats.forEach(function(s) {
      var strat = s.strategy || '—';
      var reg = s.regime || '—';
      if (strategies.indexOf(strat) === -1) strategies.push(strat);
      if (regimes.indexOf(reg) === -1) regimes.push(reg);
      cellMap[strat + '|' + reg] = s;
    });
    if (regimes.length === 0) regimes = ['低VIX', '中VIX', '高VIX'];
    var html = '<div class="matrix-h"></div>';
    regimes.forEach(function(r) { html += '<div class="matrix-h">' + escHtml(r) + '</div>'; });
    strategies.forEach(function(strat) {
      html += '<div class="matrix-p">' + escHtml(strat) + '</div>';
      regimes.forEach(function(reg) {
        var cell = cellMap[strat + '|' + reg];
        if (cell) {
          var wr = (cell.winRate * 100).toFixed(0);
          var bgColor = cell.winRate >= 0.55 ? 'rgba(48,209,88,0.25)' : cell.winRate >= 0.50 ? 'rgba(48,209,88,0.15)' : 'rgba(255,69,58,0.2)';
          var prefix = cell.winRate >= 0.50 ? '+' : '';
          html += '<div class="matrix-c" style="background:' + bgColor + '">' + prefix + wr + '%</div>';
        } else {
          html += '<div class="matrix-c">—</div>';
        }
      });
    });
    matrixEl.innerHTML = html;
  }

  function renderStatsVerdict(data) {
    var ph = data.paramHistory || [];
    var worked = 0, didnt = 0, pending = 0;
    ph.forEach(function(h) {
      var v = h.verdict || h.result;
      if (v === 'worked' || v === 'improved') worked++;
      else if (v === 'worsened' || v === 'didnt') didnt++;
      else pending++;
    });
    var svWorked = el('sv-worked');
    var svDidnt = el('sv-didnt');
    var svPending = el('sv-pending');
    if (svWorked) { svWorked.textContent = worked > 0 ? String(worked) : '—'; svWorked.style.color = 'var(--green)'; }
    if (svDidnt) { svDidnt.textContent = didnt > 0 ? String(didnt) : '—'; svDidnt.style.color = 'var(--red)'; }
    if (svPending) { svPending.textContent = pending > 0 ? String(pending) : '—'; svPending.style.color = 'var(--tertiary)'; }
  }

  function renderEvoCards(data) {
    var container = el('evo-cards');
    if (!container) return;
    var byPair = data.performanceByPair || {};
    var ph = data.paramHistory || [];
    var traded = INSTRUMENTS.filter(function(i) { var p = byPair[i.pair]; return p && p.total > 0; });
    if (traded.length === 0) {
      container.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--tertiary)">データ蓄積中...</div>';
      return;
    }
    container.innerHTML = traded.map(function(instr) {
      var p = byPair[instr.pair];
      var wr = p.total > 0 ? (p.wins / p.total * 100).toFixed(0) : '—';
      var pairChanges = ph.filter(function(h) { return h.pair === instr.pair; });
      var pairId = instr.pair.replace(/[\\/\\s]/g, '-');

      // verdict
      var verdictCls = 'unchanged';
      var verdictText = '検証中';
      if (p.totalPnl > 0) { verdictCls = 'worked'; verdictText = '改善中'; }
      else if (p.totalPnl < 0) { verdictCls = 'didnt'; verdictText = '悪化'; }

      // mini sparkline from sparklines data
      var chartHtml = '';
      var sp = data.sparklines && data.sparklines[instr.pair];
      if (sp && sp.length > 2) {
        var rates = sp.map(function(pt) { return pt.rate; });
        var mn = Math.min.apply(null, rates);
        var mx = Math.max.apply(null, rates);
        var rng = mx - mn || 1;
        var pts = rates.map(function(r, i) {
          var x = (i / (rates.length - 1) * 300).toFixed(1);
          var y = (48 - ((r - mn) / rng) * 44).toFixed(1);
          return x + ',' + y;
        }).join(' ');
        var sColor = p.totalPnl >= 0 ? '#30D158' : '#FF453A';
        // v2マーカー: pairChangesの最初の変更をsparkline上に縦線で表示
        var evoMarkerHtml = '';
        if (pairChanges.length > 0 && sp.length > 2) {
          // sparklineは最新データなので先頭が最古。最初のParam Review時刻をsparklineの時間軸にマッピング
          var firstChange = pairChanges[pairChanges.length - 1]; // 最古の変更
          var spTimes = sp.map(function(pt) { return new Date(pt.ts || pt.created_at || 0).getTime(); });
          var spTMin = spTimes[0] || 0;
          var spTMax = spTimes[spTimes.length - 1] || 1;
          var spTRange = spTMax - spTMin || 1;
          var chTime = new Date(firstChange.created_at || firstChange.time || 0).getTime();
          if (chTime && spTMin && chTime > spTMin && chTime < spTMax) {
            var chRatio = (chTime - spTMin) / spTRange;
            var chX = Math.round(chRatio * 300);
            evoMarkerHtml = '<line x1="' + chX + '" y1="0" x2="' + chX + '" y2="48" stroke="#0A84FF" stroke-width="1" stroke-dasharray="3"/>' +
              '<text x="' + (chX + 2) + '" y="10" fill="#0A84FF" font-size="8">v2</text>';
          }
        }
        chartHtml = '<div class="evo-chart"><svg viewBox="0 0 300 48"><polyline points="' + pts + '" fill="none" stroke="' + sColor + '" stroke-width="1.5" stroke-linecap="round"/>' + evoMarkerHtml + '</svg></div>';
      }

      // changes
      var changesHtml = '';
      if (pairChanges.length > 0) {
        changesHtml = '<div class="evo-changes">' + pairChanges.map(function(c) {
          var dotCls = c.verdict === 'worked' || c.verdict === 'improved' ? 'improved' : c.verdict === 'worsened' || c.verdict === 'didnt' ? 'worsened' : 'neutral';
          var resCls = dotCls === 'improved' ? 'worked' : dotCls === 'worsened' ? 'didnt' : 'unchanged';
          var whyHtml = '';
          if (c.why_chain && c.why_chain.length > 0) {
            var uid = 'why-evo-' + pairId + '-' + Math.random().toString(36).slice(2, 6);
            whyHtml = '<div class="why-toggle" onclick="var t=document.getElementById(\\'' + uid + '\\');t.classList.toggle(\\'open\\')">\\u25b6 ' + (dotCls === 'improved' ? 'なぜ効いた？' : dotCls === 'worsened' ? 'なぜ効かなかった？' : '根拠') + '</div>' +
              '<div class="why-tree" id="' + uid + '">' + buildWhyTree(c.why_chain) + '</div>';
          }
          return '<div class="evo-change"><div class="evo-dot ' + dotCls + '"></div><div style="flex:1">' +
            '<div class="evo-text">' + escHtml(c.description || c.change || '') + '</div>' +
            '<div class="evo-result ' + resCls + '">' + escHtml(c.result_text || '') + '</div>' +
            whyHtml +
            '<span class="cross-link" onclick="switchTab(\\\'tab-strategy\\\')">\\u2192 戦略で詳細</span>' +
            '<span class="cross-link" style="margin-left:12px" onclick="switchTab(\\\'tab-ai\\\')">\\u2192 AIタブで判断を確認</span>' +
          '</div></div>';
        }).join('') + '</div>';
      } else {
        changesHtml = '<div class="evo-changes"><div class="evo-change"><div class="evo-dot neutral"></div><div style="flex:1">' +
          '<div class="evo-text">勝率 ' + wr + '% \\u00b7 ' + p.wins + '勝' + (p.total - p.wins) + '敗\\uff08計' + p.total + '\\uff09</div>' +
          '<div class="evo-result unchanged">パラメーター変更なし</div>' +
        '</div></div></div>';
      }

      return '<div class="evo-card" id="evo-' + pairId + '">' +
        '<div class="evo-header">' +
          '<span class="evo-pair">' + escHtml(instr.label) + '</span>' +
          '<span class="evo-verdict ' + verdictCls + '">' + verdictText + '</span>' +
        '</div>' +
        chartHtml + changesHtml +
      '</div>';
    }).join('');
  }

  function buildWhyTree(chain) {
    if (!chain || chain.length === 0) return '';
    return chain.map(function(w, i) {
      var depth = w.depth || i;
      return '<div class="why-node">' +
        '<div class="why-q">Why' + (i + 1) + ': ' + escHtml(w.question || w.q || '') + '</div>' +
        '<div class="why-a">' + escHtml(w.answer || w.a || '') + '</div>' +
        (w.evidence ? '<div class="why-evidence">裏付: ' + escHtml(w.evidence) + '</div>' : '') +
      '</div>';
    }).join('');
  }

  // ══════════════════════════════════════════
  // renderAiTab
  // ══════════════════════════════════════════

  function renderAiTab(data) {
    var st = data.statistics || {};
    var acc = st.aiAccuracy;

    // ヒーロー正解率
    var scoreNum = el('ai-score-num');
    if (scoreNum) {
      scoreNum.textContent = acc ? (acc.accuracy * 100).toFixed(0) + '%' : '—%';
      scoreNum.style.color = acc && acc.accuracy >= 0.6 ? 'var(--green)' : acc && acc.accuracy >= 0.5 ? 'var(--orange)' : 'var(--red)';
    }
    var scoreSub = el('ai-score-sub');
    if (scoreSub) scoreSub.textContent = acc ? '直近' + acc.n + '件のAI行動のうち、' + (acc.correct || 0) + '件が正しかった' : '—';

    // ニュース分析/Param Review内訳
    var newsVal = el('ai-brk-news-val');
    var newsSub = el('ai-brk-news-sub');
    var prVal = el('ai-brk-pr-val');
    var prSub = el('ai-brk-pr-sub');
    if (acc && acc.newsAccuracy != null) {
      if (newsVal) { newsVal.textContent = (acc.newsAccuracy * 100).toFixed(0) + '%'; newsVal.style.color = acc.newsAccuracy >= 0.6 ? 'var(--green)' : 'var(--orange)'; }
      if (newsSub) newsSub.textContent = (acc.newsN || 0) + '件中' + (acc.newsCorrect || 0) + '件正解';
    } else {
      if (newsVal) newsVal.textContent = '—';
      if (newsSub) newsSub.textContent = '—';
    }
    if (acc && acc.prAccuracy != null) {
      if (prVal) { prVal.textContent = (acc.prAccuracy * 100).toFixed(0) + '%'; prVal.style.color = acc.prAccuracy >= 0.6 ? 'var(--green)' : 'var(--orange)'; }
      if (prSub) prSub.textContent = (acc.prN || 0) + '件中' + (acc.prCorrect || 0) + '件正解';
    } else {
      if (prVal) prVal.textContent = '—';
      if (prSub) prSub.textContent = '—';
    }

    // Brierスパークライン
    var brierVal = el('ai-brier-val');
    var brierTrend = el('ai-brier-trend');
    if (brierVal) {
      brierVal.textContent = acc ? acc.brierScore.toFixed(2) : '—';
      if (acc) brierVal.style.color = acc.brierScore < 0.25 ? 'var(--green)' : 'var(--orange)';
    }
    if (brierTrend && acc) {
      brierTrend.textContent = acc.brierTrend === 'improving' ? '\\u2193改善中' : acc.brierTrend === 'worsening' ? '\\u2191悪化' : '';
    }
    // Brier sparkline SVG
    var brierSpark = el('ai-brier-spark');
    if (brierSpark && acc && acc.brierHistory && acc.brierHistory.length > 2) {
      var bh = acc.brierHistory;
      var bMin = Math.min.apply(null, bh);
      var bMax = Math.max.apply(null, bh);
      var bRng = bMax - bMin || 1;
      var bPts = bh.map(function(v, i) {
        var x = (i / (bh.length - 1) * 80).toFixed(1);
        var y = (20 - ((v - bMin) / bRng) * 16 - 2).toFixed(1);
        return x + ',' + y;
      }).join(' ');
      brierSpark.innerHTML = '<polyline points="' + bPts + '" fill="none" stroke="var(--green)" stroke-width="1.2" stroke-linecap="round"/>';
    }

    // 正解/不正解/判定中
    var vCorrect = el('ai-v-correct');
    if (vCorrect) { vCorrect.textContent = acc ? String(acc.correct || 0) : '—'; vCorrect.style.color = 'var(--green)'; }
    var vWrong = el('ai-v-wrong');
    if (vWrong) { vWrong.textContent = acc ? String(acc.wrong || 0) : '—'; vWrong.style.color = 'var(--red)'; }
    var vPending = el('ai-v-pending');
    if (vPending) { vPending.textContent = acc ? String(acc.pending || 0) : '—'; vPending.style.color = 'var(--blue)'; }

    // PARAM REVIEW カード
    renderAiPrCards(data);

    // ニュース分析カード
    renderAiNewsCards(data);

    // AI判断タイムライン (hidden if verdict cards suffice)
    renderAiTimeline(data);
  }

  function verdictCard(item) {
    var v = item.verdict || 'pending';
    var cardCls = v === 'correct' ? 'correct' : v === 'wrong' ? 'wrong' : 'pending';
    var verdictText = v === 'correct' ? '正解' : v === 'wrong' ? '不正解' : '判定中';
    var outcomeCls = v === 'correct' ? 'worked' : v === 'wrong' ? 'didnt' : '';
    var outcomeStyle = v === 'pending' ? ' style="color:var(--blue)"' : '';

    var whyHtml = '';
    if (item.why_chain && item.why_chain.length > 0) {
      var uid = 'why-ai-' + Math.random().toString(36).slice(2, 8);
      whyHtml = '<div class="why-toggle" onclick="var t=document.getElementById(\\'' + uid + '\\');t.classList.toggle(\\'open\\')">\\u25b6 Why\\u00d75 根拠チェーン</div>' +
        '<div class="why-tree" id="' + uid + '">' + buildWhyTree(item.why_chain) + '</div>';
    }

    var crossHtml = '';
    if (item.crossLink) {
      crossHtml = '<span class="cross-link" onclick="switchTab(\\\'' + escHtml(item.crossLink.tab || 'tab-stats') + '\\\')">' + escHtml(item.crossLink.text || '\\u2192 詳細') + '</span>';
    }

    return '<div class="verdict-card ' + cardCls + '">' +
      '<div class="vc-header"><span class="vc-action">' + escHtml(item.action || '') + '</span><span class="vc-verdict ' + cardCls + '">' + verdictText + '</span></div>' +
      '<div class="vc-reason">' + escHtml(item.reason || '') + '</div>' +
      (item.outcome ? '<div class="vc-outcome ' + outcomeCls + '"' + outcomeStyle + '>\\u2192 ' + escHtml(item.outcome) + '</div>' : '') +
      whyHtml +
      '<div class="vc-time">' + fmtTimeAgo(item.time || '') + '</div>' +
      crossHtml +
    '</div>';
  }

  function renderAiPrCards(data) {
    var container = el('ai-pr-cards');
    if (!container) return;
    var ph = data.paramHistory || [];
    if (ph.length === 0) {
      container.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--tertiary)">データ蓄積中...</div>';
      return;
    }
    container.innerHTML = ph.map(function(h) {
      var v = h.verdict === 'worked' || h.verdict === 'improved' ? 'correct' : h.verdict === 'worsened' || h.verdict === 'didnt' ? 'wrong' : 'pending';
      return verdictCard({
        action: (h.pair || '') + ' Param Review',
        verdict: v,
        reason: h.description || h.change || '',
        outcome: h.result_text || '',
        time: h.created_at || h.time || '',
        why_chain: h.why_chain || null,
        crossLink: { tab: 'tab-stats', text: '\\u2192 学びで効果を確認' }
      });
    }).join('');
  }

  function renderAiNewsCards(data) {
    var container = el('ai-news-cards');
    if (!container) return;
    var analysis = data.newsAnalysis || [];
    var items = analysis.filter(function(n) { return n.attention; });
    if (items.length === 0) {
      container.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--tertiary)">分析データなし</div>';
      return;
    }
    container.innerHTML = items.slice(0, 5).map(function(n) {
      var v = n.verdict || 'pending';
      return verdictCard({
        action: 'ニュース',
        verdict: v,
        reason: escHtml(n.title_ja || n.title || ''),
        outcome: n.desc_ja || n.description || n.impact || n.outcome_text || '',
        time: n.analyzed_at || n.pubDate || '',
        why_chain: n.why_chain || null,
        crossLink: { tab: 'tab-portfolio', text: '\\u2192 今タブで進行確認' }
      });
    }).join('');
  }

  function renderAiTimeline(data) {
    var container = el('ai-timeline');
    if (!container) return;
    // Timeline is now secondary; verdict cards above are primary
    container.innerHTML = '';
  }

  // ══════════════════════════════════════════
  // renderStrategyTab — 戦略タブ（銘柄ジャーニー）
  // ══════════════════════════════════════════

  function renderStrategyTab(data) {
    var container = el('journey-cards');
    if (!container) return;
    var byPair = data.performanceByPair || {};
    var ph = data.paramHistory || [];
    var traded = INSTRUMENTS.filter(function(i) { var p = byPair[i.pair]; return p && p.total > 0; });

    if (traded.length === 0) {
      container.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--tertiary)">データ蓄積中...</div>';
      return;
    }

    container.innerHTML = traded.map(function(instr) {
      var p = byPair[instr.pair] || { total: 0, wins: 0, totalPnl: 0 };
      var pairId = instr.pair.replace(/[\\/\\s]/g, '-').toLowerCase();
      var pairChanges = ph.filter(function(h) { return h.pair === instr.pair; });
      var currentVersion = pairChanges.length > 0 ? 'v' + (pairChanges.length + 1) : 'v1';
      var wr = p.total > 0 ? (p.wins / p.total * 100).toFixed(0) : '—';
      var pnlF = fmtPnl(p.totalPnl, instr.unit);

      // Summary text
      var summaryText = pairChanges.length > 0
        ? pairChanges[0].summary || ('AIレビューを' + pairChanges.length + '回実施。勝率 ' + wr + '%。')
        : '初期設定で運用中。取引 ' + p.total + '件。';

      // Score breakdown (from params data if available)
      var scoreHtml = '';
      if (paramsData && paramsData.instruments) {
        var pConf = null;
        for (var pi = 0; pi < paramsData.instruments.length; pi++) {
          if (paramsData.instruments[pi].pair === instr.pair) { pConf = paramsData.instruments[pi]; break; }
        }
        if (pConf && pConf.weights) {
          var w = pConf.weights;
          var scoreItems = [
            { label: 'RSI', weight: w.rsi || 0.35, value: pConf.rsiScore || 0 },
            { label: 'ER', weight: w.er || 0.25, value: pConf.erScore || 0 },
            { label: 'MTF', weight: w.mtf || 0.20, value: pConf.mtfScore || 0 },
            { label: 'S/R', weight: w.sr || 0.10, value: pConf.srScore || 0 },
            { label: 'PA', weight: w.pa || 0.10, value: pConf.paScore || 0 },
            { label: 'BB', weight: w.bb || 0.10, value: pConf.bbScore || 0 }
          ];
          var totalScore = 0;
          var scoreRowsHtml = scoreItems.map(function(si) {
            var pct = Math.round(si.value * 100);
            var contrib = si.weight * si.value;
            totalScore += contrib;
            var fillColor = pct < 30 ? 'var(--red)' : pct < 50 ? 'var(--orange)' : 'var(--green)';
            return '<div class="score-row"><span class="score-label">' + si.label + '</span>' +
              '<div class="score-bar"><div class="score-fill" style="width:' + pct + '%;background:' + fillColor + '"></div></div>' +
              '<span class="score-val">' + si.weight.toFixed(2) + ' \\u00d7 ' + si.value.toFixed(2) + ' = ' + contrib.toFixed(3) + '</span></div>';
          }).join('');
          var totalColor = totalScore >= 0.5 ? 'var(--green)' : totalScore >= 0.3 ? 'var(--orange)' : 'var(--red)';
          var threshold = pConf.entryThreshold || 0.30;
          var threshText = totalScore >= threshold ? 'OK' : 'ギリギリ';
          scoreHtml = '<div style="margin-bottom:12px;padding:8px 12px;background:var(--bg);border-radius:var(--rs)">' +
            '<div style="font-size:11px;color:var(--tertiary);font-weight:600;margin-bottom:8px">現在のエントリースコア内訳</div>' +
            scoreRowsHtml +
            '<div class="score-total">Total: <span style="color:' + totalColor + '">' + totalScore.toFixed(3) + '</span> <span style="font-size:11px;color:var(--secondary)">(閾値 ' + threshold.toFixed(2) + ' ' + threshText + ')</span></div>' +
          '</div>';
        }
      }

      // Timeline steps
      var timelineHtml = '';
      if (pairChanges.length > 0) {
        var steps = pairChanges.map(function(c, idx) {
          var stepCls = idx === 0 ? 'current' : (c.verdict === 'worked' || c.verdict === 'improved' ? 'good' : c.verdict === 'worsened' || c.verdict === 'didnt' ? 'bad' : 'good');
          var ver = 'v' + (pairChanges.length - idx + 1);
          if (idx === 0) ver = currentVersion + '\\uff08現在\\uff09';
          var resCls = c.verdict === 'worked' || c.verdict === 'improved' ? 'worked' : c.verdict === 'worsened' || c.verdict === 'didnt' ? 'didnt' : '';
          return '<div class="jc-step ' + stepCls + '">' +
            '<div class="jc-step-header"><span class="jc-step-ver">' + ver + '</span><span class="jc-step-time">' + fmtTimeAgo(c.created_at || c.time || '') + '</span></div>' +
            '<div class="jc-step-desc">' + escHtml(c.description || c.change || '') + '</div>' +
            (c.result_text ? '<div class="jc-step-result ' + resCls + '">' + escHtml(c.result_text) + '</div>' : '') +
          '</div>';
        });
        // Add v1 initial step
        steps.push('<div class="jc-step good"><div class="jc-step-header"><span class="jc-step-ver">v1\\uff08初期\\uff09</span></div><div class="jc-step-desc">デフォルト設定</div></div>');
        timelineHtml = '<div class="jc-timeline">' + steps.join('') + '</div>';
      }

      // Params toggle
      var paramsHtml = '';
      if (paramsData && paramsData.instruments) {
        var pc = null;
        for (var pj = 0; pj < paramsData.instruments.length; pj++) {
          if (paramsData.instruments[pj].pair === instr.pair) { pc = paramsData.instruments[pj]; break; }
        }
        if (pc) {
          var uid = 'jcp-' + pairId;
          var rows = [];
          if (pc.rsiOversold != null) rows.push('<div class="jc-param-row"><span>RSI 売/買</span><span class="val">' + pc.rsiOversold + ' / ' + pc.rsiOverbought + '</span></div>');
          if (pc.adxMin != null) rows.push('<div class="jc-param-row"><span>ADX最小</span><span class="val">' + pc.adxMin + '</span></div>');
          if (pc.atrTpMultiplier != null) rows.push('<div class="jc-param-row"><span>TP倍率</span><span class="val">' + pc.atrTpMultiplier + '</span></div>');
          if (pc.atrSlMultiplier != null) rows.push('<div class="jc-param-row"><span>SL倍率</span><span class="val">' + pc.atrSlMultiplier + '</span></div>');
          if (pc.strategy) rows.push('<div class="jc-param-row"><span>戦略</span><span class="val">' + escHtml(pc.strategy) + '</span></div>');
          if (pc.maxHoldingMinutes) rows.push('<div class="jc-param-row"><span>最大保有</span><span class="val">' + pc.maxHoldingMinutes + '分</span></div>');
          if (pc.cooldownMinutes) rows.push('<div class="jc-param-row"><span>クールダウン</span><span class="val">' + pc.cooldownMinutes + '分</span></div>');
          if (rows.length > 0) {
            paramsHtml = '<div class="jc-params-toggle" onclick="var t=document.getElementById(\\'' + uid + '\\');t.classList.toggle(\\'open\\')">\\u25b6 パラメーター全量</div>' +
              '<div class="jc-params" id="' + uid + '">' + rows.join('') + '</div>';
          }
        }
      }

      return '<div class="journey-card" id="jc-' + pairId + '">' +
        '<div class="jc-header"><span class="jc-pair">' + escHtml(instr.label) + '</span><span class="jc-ver">現在 ' + currentVersion + '</span></div>' +
        '<div class="jc-summary">' + escHtml(summaryText) + '</div>' +
        scoreHtml + timelineHtml + paramsHtml +
        '<span class="cross-link" onclick="switchTab(\\\'tab-stats\\\')">\\u2192 学びで成果確認</span>' +
      '</div>';
    }).join('');
  }

  // ══════════════════════════════════════════
  // renderSystemTab — 系統タブ
  // ══════════════════════════════════════════

  function renderSystemTab(data) {
    // ヘルスヒーロー
    var healthText = el('health-text');
    var healthSub = el('health-sub');
    var heroEl = el('health-hero');
    var logs = data.systemLogs || [];
    var errCount = logs.filter(function(l) { return l.level === 'ERROR'; }).length;
    var isOk = errCount === 0;

    if (healthText) {
      if (isOk) {
        healthText.textContent = '全システム正常';
        healthText.style.color = 'var(--green)';
      } else {
        healthText.textContent = 'エラー検出: ' + errCount + '件';
        healthText.style.color = 'var(--red)';
      }
    }
    // Update SVG color in health hero
    if (heroEl) {
      var svgCircle = heroEl.querySelector('circle');
      var svgPath = heroEl.querySelector('path');
      if (svgCircle) {
        svgCircle.setAttribute('fill', isOk ? 'rgba(48,209,88,0.15)' : 'rgba(255,69,58,0.15)');
        svgCircle.setAttribute('stroke', isOk ? '#30D158' : '#FF453A');
      }
      if (svgPath) {
        svgPath.setAttribute('stroke', isOk ? '#30D158' : '#FF453A');
      }
    }
    if (healthSub) {
      var ss = data.systemStatus;
      healthSub.textContent = ss
        ? '最終チェック: ' + new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) + ' \\u00b7 稼働 ' + (ss.totalRuns || 0).toLocaleString('ja-JP') + '回'
        : '—';
    }

    // DD段階バー
    var ddCurrent = el('dd-current');
    if (ddCurrent) {
      var rs = data.riskStatus;
      if (rs) {
        var ddPct = rs.maxDailyLoss > 0 ? (Math.abs(rs.todayLoss || 0) / rs.maxDailyLoss * 100) : 0;
        ddCurrent.textContent = '\\u25b2 現在 ' + ddPct.toFixed(1) + '%';
        ddCurrent.style.color = ddPct > 8 ? 'var(--red)' : ddPct > 5 ? 'var(--orange)' : 'var(--green)';
        ddCurrent.style.fontWeight = '600';
      } else {
        ddCurrent.textContent = '—';
      }
    }

    // 稼働率/エラー率
    var uptimeEl = el('sys-uptime');
    var errRateEl = el('sys-error-rate');
    if (uptimeEl) {
      var totalRuns = data.systemStatus ? data.systemStatus.totalRuns : 0;
      var errRate = totalRuns > 0 ? (errCount / Math.max(logs.length, 1) * 100) : 0;
      var uptime = 100 - errRate;
      uptimeEl.textContent = totalRuns > 0 ? uptime.toFixed(2) + '%' : '—';
      uptimeEl.style.color = uptime >= 99 ? 'var(--green)' : uptime >= 95 ? 'var(--orange)' : 'var(--red)';
    }
    if (errRateEl) {
      var eRate = errCount > 0 ? (errCount / Math.max(logs.length, 1) * 100) : 0;
      errRateEl.textContent = eRate.toFixed(2) + '%';
      errRateEl.style.color = eRate < 1 ? 'var(--green)' : eRate < 5 ? 'var(--orange)' : 'var(--red)';
    }

    // ヘルスチェック6項目
    renderHealthChecks(data);

    // ログリスト
    renderLogList(data);
  }

  function renderHealthChecks(data) {
    var container = el('health-checks');
    if (!container) return;
    var ss = data.systemStatus || {};
    var rs = data.riskStatus || {};
    var ddPct = rs.maxDailyLoss > 0 ? (Math.abs(rs.todayLoss || 0) / rs.maxDailyLoss * 100).toFixed(1) : '0';
    var ddStage = parseFloat(ddPct) > 8 ? 'WARNING' : parseFloat(ddPct) > 5 ? 'CAUTION' : 'NORMAL';

    var checks = [
      {
        name: 'Cron 実行',
        ok: ss.totalRuns > 0,
        value: ss.lastRunDuration ? (ss.lastRunDuration / 1000).toFixed(1) + 's \\u00b7 正常' : '—',
        expand: ss.runBreakdown ? '内訳: ' + ss.runBreakdown : null
      },
      {
        name: 'RiskGuard',
        ok: rs != null && !rs.killSwitchActive,
        value: 'DD ' + ddPct + '% \\u00b7 ' + ddStage,
        expand: null
      },
      {
        name: 'レート取得',
        ok: data.rate != null,
        value: data.rate != null ? INSTRUMENTS.length + '/' + INSTRUMENTS.length + ' 銘柄' : 'エラー',
        expand: null
      },
      {
        name: 'AI API',
        ok: data.recentDecisions && data.recentDecisions.length > 0,
        value: '応答正常',
        expand: ss.aiCalls24h ? '24hコール: ' + ss.aiCalls24h + '回' : null
      },
      {
        name: 'D1 DB',
        ok: true,
        value: ss.dbSize ? ss.dbSize : '正常',
        expand: ss.dbDetails || null
      },
      {
        name: 'ニュース',
        ok: data.latestNews && data.latestNews.length > 0,
        value: (data.latestNews || []).length > 0 ? '取得中' : 'エラー',
        expand: null
      }
    ];
    container.innerHTML = checks.map(function(c) {
      var valCls = c.ok ? 'ok' : 'error';
      var expandHtml = c.expand ? '<div class="hc-expand"><div class="hc-detail"><span class="hc-detail-label">' + escHtml(c.expand) + '</span></div></div>' : '<div class="hc-expand"></div>';
      return '<div class="hc" onclick="var exp=this.querySelector(\\'.hc-expand\\');if(exp)exp.classList.toggle(\\'open\\')">' +
        '<div class="hc-row"><div class="hc-left"><span class="hc-label">' + escHtml(c.name) + '</span></div>' +
        '<div class="hc-value ' + valCls + '">' + c.value + '</div></div>' +
        expandHtml +
      '</div>';
    }).join('');
  }

  function renderLogList(data) {
    var logList = el('log-list');
    if (!logList) return;
    var logs = data.systemLogs || [];
    var abnormal = logs.filter(function(l) { return l.level === 'ERROR' || l.level === 'WARN'; });
    if (abnormal.length === 0) {
      logList.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--tertiary)">異常なし</div>';
    } else {
      logList.innerHTML = abnormal.slice(0, 20).map(function(l) {
        var lvlCls = l.level === 'ERROR' ? 'error' : 'warn';
        var crossHtml = l.relatedPair ? '<span class="cross-link" onclick="switchTab(\\\'tab-portfolio\\\')">\\u2192 関連ポジション</span>' : '';
        return '<div class="log-item">' +
          '<div class="log-header"><span class="log-level ' + lvlCls + '">' + l.level + '</span>' +
          '<span class="log-cat">' + escHtml(l.category || '') + '</span>' +
          '<span class="log-time">' + fmtTimeAgo(l.created_at) + '</span></div>' +
          '<div class="log-msg">' + escHtml(l.message || '') + '</div>' +
          crossHtml +
        '</div>';
      }).join('');
    }

    // 全ログ
    var allLogs = el('all-logs');
    if (allLogs) {
      allLogs.innerHTML = logs.slice(0, 50).map(function(l) {
        var lvlCls = l.level === 'ERROR' ? 'error' : l.level === 'WARN' ? 'warn' : 'info';
        return '<div class="log-item">' +
          '<div class="log-header"><span class="log-level ' + lvlCls + '">' + l.level + '</span>' +
          '<span class="log-cat">' + escHtml(l.category || '') + '</span>' +
          '<span class="log-time">' + fmtTimeAgo(l.created_at) + '</span></div>' +
          '<div class="log-msg">' + escHtml(l.message || '') + '</div></div>';
      }).join('');
    }

    // 次回レビュー
    var reviewEl = el('sys-next-review');
    if (reviewEl) {
      var nextReview = data.systemStatus && data.systemStatus.nextReview;
      if (nextReview) {
        reviewEl.textContent = '次回レビュー: ' + fmtTime(nextReview);
      }
    }
  }

  // ══════════════════════════════════════════
  // TP/SLバナー検出
  // ══════════════════════════════════════════

  function detectAndShowBanner(data) {
    if (!data.recentCloses || data.recentCloses.length === 0) return;
    var newIds = data.recentCloses.map(function(p) { return p.id; });
    if (lastRecentCloseIds.length === 0) { lastRecentCloseIds = newIds; return; }
    var prevSet = {};
    lastRecentCloseIds.forEach(function(id) { prevSet[id] = true; });
    var fresh = data.recentCloses.filter(function(p) { return !prevSet[p.id]; });
    lastRecentCloseIds = newIds;
    if (fresh.length === 0) return;
    // TODO: TP/SL バナー表示（v7 HTMLに対応するバナー要素があれば実装）
  }

  // ══════════════════════════════════════════
  // ボトムシート
  // ══════════════════════════════════════════

  var savedScrollY = 0;

  function lockScroll() {
    document.body.classList.add('sheet-open');
    if (document.body.style.position === 'fixed') return;
    savedScrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = '-' + savedScrollY + 'px';
    document.body.style.width = '100%';
  }

  function row(label, value) {
    return '<div class="sheet-row"><span class="sheet-label">' + escHtml(label) + '</span><span class="sheet-value">' + value + '</span></div>';
  }

  window.openSheet = function(pair) {
    if (!lastData) return;
    var instr = findInstr(pair);
    var pos = null;
    var opens = lastData.openPositions || [];
    for (var i = 0; i < opens.length; i++) {
      if (opens[i].pair === pair) { pos = opens[i]; break; }
    }

    var sheet = el('bottom-sheet');
    var overlay = el('sheet-overlay');
    var title = el('sheet-title');
    var body = el('sheet-body');
    if (!sheet || !body) return;

    var cr = getCurrentRate(pair);

    if (!pos) {
      // HOLD
      title.textContent = (instr ? instr.label : pair) + ' — 待機中';
      body.innerHTML = row('ステータス', '<span style="color:var(--tertiary);font-weight:600">HOLD</span>') +
        (cr != null ? row('現在値', fmtPrice(pair, cr)) : '');
    } else {
      // ポジション詳細
      var unrealized = 0;
      if (instr && cr != null) {
        unrealized = pos.direction === 'BUY'
          ? (cr - pos.entry_rate) * instr.multiplier * (pos.lot || 1)
          : (pos.entry_rate - cr) * instr.multiplier * (pos.lot || 1);
      }
      var pnlF = fmtPnl(unrealized, instr ? instr.unit : '');
      var pnlColor = unrealized > 0 ? 'var(--green)' : unrealized < 0 ? 'var(--red)' : '';

      title.textContent = (instr ? instr.label : pair) + ' ポジション詳細';
      body.innerHTML =
        row('方向', '<span style="color:' + (pos.direction === 'BUY' ? 'var(--green)' : 'var(--red)') + ';font-weight:700">' + (pos.direction === 'BUY' ? '買い' : '空売り') + '</span>') +
        (cr != null ? row('現在値', fmtPrice(pair, cr)) : '') +
        row('含み損益', '<span style="color:' + pnlColor + ';font-weight:700">' + pnlF.text + '</span>') +
        row('エントリー', fmtPrice(pair, pos.entry_rate)) +
        row('エントリー日時', fmtTime(pos.entry_at)) +
        (pos.tp_rate != null ? row('TP', fmtPrice(pair, pos.tp_rate)) : '') +
        (pos.sl_rate != null ? row('SL', fmtPrice(pair, pos.sl_rate)) : '');

      // トレーサビリティ
      var tc = lastData.tradeContext && lastData.tradeContext[pair];
      if (tc) {
        body.innerHTML += '<div class="trace-section"><div class="trace-title">なぜオープンした？</div>' +
          '<div class="trace-reasoning">' + escHtml(tc.entryReasoning || '—') + '</div></div>';
        if (tc.currentParams) {
          var cp = tc.currentParams;
          body.innerHTML += '<div class="trace-section"><div class="trace-title">現在のパラメーター v' + cp.paramVersion + '</div>' +
            '<div class="trace-params">' +
              'RSI ' + cp.rsiOversold + '/' + cp.rsiOverbought +
              ' · ATR TP=' + cp.atrTpMultiplier + ' SL=' + cp.atrSlMultiplier +
            '</div></div>';
        }
      }
    }

    // AI判断
    var decisions = (lastData.recentDecisions || []).filter(function(d) { return d.pair === pair; });
    if (decisions.length > 0) {
      body.innerHTML += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--separator)">' +
        '<div style="font-size:12px;font-weight:600;margin-bottom:6px">AI判断根拠</div>' +
        decisions.slice(0, 3).map(function(d) {
          return '<div style="padding:6px 0;border-bottom:1px solid var(--separator)">' +
            '<span class="dir-badge ' + (d.decision === 'BUY' ? 'buy' : d.decision === 'SELL' ? 'sell' : 'hold') + '" style="font-size:10px">' + d.decision + '</span>' +
            '<span style="font-size:11px;color:var(--tertiary);margin-left:6px">' + fmtTimeAgo(d.created_at) + '</span>' +
            '<div style="font-size:12px;margin-top:2px">' + escHtml(d.reasoning || '') + '</div></div>';
        }).join('') + '</div>';
    }

    lockScroll();
    sheet.classList.add('open');
    if (overlay) overlay.classList.add('visible');
  };

  function closeSheet() {
    var sheet = el('bottom-sheet');
    if (sheet) {
      sheet.style.transition = '';
      sheet.style.transform = '';
      sheet.classList.remove('open');
    }
    var overlay = el('sheet-overlay');
    if (overlay) overlay.classList.remove('visible');
    document.body.classList.remove('sheet-open');
    if (!document.body.classList.contains('drawer-open')) {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, savedScrollY);
    }
  }

  var overlayEl = el('sheet-overlay');
  if (overlayEl) overlayEl.addEventListener('click', function(e) { e.stopPropagation(); closeSheet(); });

  // シートスワイプで閉じる
  (function() {
    var sheet = el('bottom-sheet');
    if (!sheet) return;
    var startY = 0, currentY = 0, dragging = false;
    sheet.addEventListener('touchstart', function(e) { startY = e.touches[0].clientY; dragging = true; sheet.style.transition = 'none'; }, { passive: true });
    sheet.addEventListener('touchmove', function(e) {
      if (!dragging) return;
      var dy = e.touches[0].clientY - startY;
      if (dy < 0) { currentY = 0; return; }
      currentY = dy;
      sheet.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: true });
    sheet.addEventListener('touchend', function() {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      if (currentY > 100) closeSheet();
      else sheet.style.transform = '';
      currentY = 0;
    });
  })();

  // ══════════════════════════════════════════
  // ニュースドロワー
  // ══════════════════════════════════════════

  (function() {
    var drawer = el('news-drawer');
    if (!drawer) return;
    var isExpanded = false;
    var PEEK_H = 68;
    var startY = 0, startTranslate = 0, dragging = false;

    function expand() {
      isExpanded = true;
      drawer.style.transition = '';
      drawer.style.transform = '';
      drawer.classList.add('expanded');
      document.body.classList.add('drawer-open');
      if (document.body.style.position !== 'fixed') {
        savedScrollY = window.scrollY;
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.top = '0px';
        document.body.style.width = '100%';
      }
    }

    function collapse() {
      isExpanded = false;
      drawer.style.transition = '';
      drawer.style.transform = '';
      drawer.classList.remove('expanded');
      document.body.classList.remove('drawer-open');
      if (!document.body.classList.contains('sheet-open')) {
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.width = '';
        window.scrollTo(0, savedScrollY);
      }
    }

    var header = drawer.querySelector('.news-drawer-header');
    if (header) header.addEventListener('click', function() { if (isExpanded) collapse(); else expand(); });

    drawer.addEventListener('touchstart', function(e) {
      var bodyEl = el('news-drawer-body');
      if (isExpanded && bodyEl && bodyEl.contains(e.target)) return;
      startY = e.touches[0].clientY;
      startTranslate = isExpanded ? 0 : (drawer.offsetHeight - PEEK_H);
      dragging = true;
      drawer.style.transition = 'none';
    }, { passive: true });

    drawer.addEventListener('touchmove', function(e) {
      if (!dragging) return;
      e.preventDefault();
      var dy = e.touches[0].clientY - startY;
      var newY = startTranslate + dy;
      var maxY = drawer.offsetHeight - PEEK_H;
      newY = Math.max(0, Math.min(newY, maxY));
      drawer.style.transform = 'translateY(' + newY + 'px)';
    }, { passive: false });

    drawer.addEventListener('touchend', function(e) {
      if (!dragging) return;
      dragging = false;
      var dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dy) < 8) { drawer.style.transition = ''; drawer.style.transform = ''; return; }
      drawer.style.transition = '';
      if (dy < -60) expand();
      else if (dy > 60) collapse();
      else if (isExpanded) expand(); else collapse();
    });

    document.addEventListener('click', function(e) {
      if (!isExpanded) return;
      if (drawer.contains(e.target)) return;
      var sheetEl = el('bottom-sheet');
      if (sheetEl && sheetEl.contains(e.target)) return;
      if (sheetEl && sheetEl.classList.contains('open')) return;
      collapse();
    });

    // ニュースデータ描画
    var newsData = [];
    var newsAnalysisData = [];
    var drawerBody = el('news-drawer-body');
    window._renderNews = function(news, analysis) {
      var tab = el('tab-portfolio');
      if (!news || news.length === 0) {
        drawer.classList.remove('visible');
        if (tab) tab.classList.remove('news-visible');
        return;
      }
      newsData = news;
      newsAnalysisData = analysis || [];
      drawer.classList.add('visible');
      if (tab) tab.classList.add('news-visible');
      var analysisByTitle = {};
      for (var i = 0; i < newsAnalysisData.length; i++) {
        if (newsAnalysisData[i].title) analysisByTitle[newsAnalysisData[i].title] = newsAnalysisData[i];
      }
      drawerBody.innerHTML = news.map(function(item, idx) {
        var title = typeof item === 'string' ? item : item.title;
        var a = analysisByTitle[title] || null;
        var flag = (a && a.attention) ? '<span class="news-flag">注目</span>' : '';
        var dateStr = '';
        if (item.pubDate) {
          try { dateStr = new Date(item.pubDate).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch(e) {}
        }
        return '<div class="news-item' + (a && a.attention ? ' news-attention' : '') + '" data-news-idx="' + idx + '">' +
          '<div class="news-item-title">' + flag + escHtml(a && a.title_ja ? a.title_ja : title) + '</div>' +
          (dateStr ? '<div class="news-item-date">' + dateStr + '</div>' : '') +
        '</div>';
      }).join('');
    };

    // ニュースタップ → 詳細シート
    if (drawerBody) drawerBody.addEventListener('click', function(e) {
      var rowEl = e.target.closest ? e.target.closest('[data-news-idx]') : null;
      if (!rowEl) return;
      var item = newsData[parseInt(rowEl.dataset.newsIdx, 10)];
      if (!item || typeof item === 'string') return;
      var sheetTitle = el('sheet-title');
      var sheetBody = el('sheet-body');
      if (sheetTitle) sheetTitle.textContent = 'ニュース詳細';
      if (sheetBody) {
        sheetBody.innerHTML = '<div style="font-size:15px;font-weight:600;margin-bottom:8px">' + escHtml(item.title_ja || item.title) + '</div>' +
          (item.description ? '<div style="font-size:13px;color:var(--tertiary)">' + escHtml(item.desc_ja || item.description) + '</div>' : '');
      }
      lockScroll();
      var sheetEl = el('bottom-sheet');
      if (sheetEl) sheetEl.classList.add('open');
      var ov = el('sheet-overlay');
      if (ov) ov.classList.add('visible');
    });
  })();

  // ══════════════════════════════════════════
  // テーマ切替
  // ══════════════════════════════════════════

  (function() {
    var savedTheme = localStorage.getItem('fx-theme');
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
    // テーマボタンがあれば
    document.addEventListener('click', function(e) {
      if (e.target && e.target.id === 'theme-btn') {
        var current = document.documentElement.getAttribute('data-theme');
        var next = current === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('fx-theme', next);
      }
    });
  })();

  // ══════════════════════════════════════════
  // 通知許可
  // ══════════════════════════════════════════

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // ══════════════════════════════════════════
  // refresh + polling
  // ══════════════════════════════════════════

  function refresh() {
    fetch('/api/status')
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        render(data);
      })
      .catch(function(err) {
        console.error('[FX Sim] refresh error:', err);
      });
  }

  refresh();
  setInterval(refresh, 30000);

  // ══════════════════════════════════════════
  // パラメーター管理（戦略タブ遅延ロード）
  // ══════════════════════════════════════════

  var paramsData = null;

  function loadParams() {
    fetch('/api/params')
      .then(function(r) { return r.json(); })
      .then(function(d) { paramsData = d; })
      .catch(function() {});
  }

  document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-tab="tab-strategy"]');
    if (btn && !paramsData) loadParams();
  });

  setInterval(function() { if (paramsData) loadParams(); }, 60000);

  // ═══ Pull-to-Refresh ═══
  (function() {
    var startY = 0;
    var pulling = false;
    var pullIndicator = null;
    var threshold = 80;

    function createIndicator() {
      var el = document.createElement('div');
      el.id = 'pull-indicator';
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;height:0;display:flex;align-items:center;justify-content:center;z-index:200;overflow:hidden;transition:height 0.2s ease;background:transparent;';
      el.innerHTML = '<div style="width:24px;height:24px;border:2px solid var(--tertiary);border-top-color:var(--blue);border-radius:50%;"></div>';
      document.body.insertBefore(el, document.body.firstChild);
      return el;
    }

    document.addEventListener('touchstart', function(e) {
      if (window.scrollY <= 0) {
        startY = e.touches[0].clientY;
        pulling = true;
        if (!pullIndicator) pullIndicator = createIndicator();
      }
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
      if (!pulling) return;
      var dy = e.touches[0].clientY - startY;
      if (dy > 0 && window.scrollY <= 0) {
        var h = Math.min(dy * 0.5, threshold);
        if (pullIndicator) {
          pullIndicator.style.height = h + 'px';
          var spinner = pullIndicator.querySelector('div');
          if (spinner) {
            var rotation = (dy / threshold) * 360;
            spinner.style.transform = 'rotate(' + rotation + 'deg)';
            spinner.style.borderTopColor = dy > threshold ? 'var(--green)' : 'var(--blue)';
          }
        }
      }
    }, { passive: true });

    document.addEventListener('touchend', function() {
      if (!pulling) return;
      pulling = false;
      var h = pullIndicator ? parseInt(pullIndicator.style.height) : 0;
      if (h >= threshold * 0.8) {
        if (pullIndicator) {
          var spinner = pullIndicator.querySelector('div');
          if (spinner) spinner.style.animation = 'spin 0.6s linear infinite';
        }
        refresh();
        setTimeout(function() {
          if (pullIndicator) pullIndicator.style.height = '0';
          setTimeout(function() {
            if (pullIndicator) {
              var spinner = pullIndicator.querySelector('div');
              if (spinner) spinner.style.animation = '';
            }
          }, 200);
        }, 800);
      } else {
        if (pullIndicator) pullIndicator.style.height = '0';
      }
    }, { passive: true });
  })();

})();
`;

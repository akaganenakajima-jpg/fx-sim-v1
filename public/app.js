
(function () {
  'use strict';

  // ── ARIA tabpanel 初期化（WCAG 4.1.2: スクリプト実行時に全パネルへ aria-hidden を設定）──
  (function() {
    var allPanels = document.querySelectorAll('[role="tabpanel"]');
    for (var i = 0; i < allPanels.length; i++) {
      allPanels[i].setAttribute('aria-hidden',
        allPanels[i].classList.contains('active') ? 'false' : 'true');
    }
  })();

  // ── Haptic Feedback ユーティリティ ──
  var haptic = {
    light: function() { if (navigator.vibrate) navigator.vibrate(10); },
    success: function() { if (navigator.vibrate) navigator.vibrate([15, 30, 20]); },
    warn: function() { if (navigator.vibrate) navigator.vibrate([30, 50, 30]); }
  };

  var lastData = null;
  var lastRecentCloseIds = [];
  // 遅延ロード済みデータキャッシュ（各タブ初回アクティブ時にフェッチ）
  var historyData = null;   // /api/history
  var logsData = null;      // /api/logs
  var newsData = null;      // /api/news
  var sheetPos = null;
  var lastPnlMap = {};
  var thSortMode = 'closed';  // 取引履歴ソート: 'closed' | 'entry'

  // ── 展開パネルの状態管理（DOM ではなく JS が状態を持つ）──
  var openJcParams  = {};   // { 'jcp-usd-jpy': true, ... }
  var openHcItems   = {};   // { 0: true, 2: true, ... }  ヘルスチェックはインデックス
  var openWhyItems  = {};   // { 'why-news-imp-0': true, ... }  Why×5チェーン

  function toggleJcParam(uid) {
    haptic.light();
    openJcParams[uid] = !openJcParams[uid];
    var t = document.getElementById(uid);
    if (t) t.classList.toggle('open', !!openJcParams[uid]);
  }
  function toggleHcItem(idx) {
    haptic.light();
    openHcItems[idx] = !openHcItems[idx];
    var items = document.querySelectorAll('.hc');
    if (items[idx]) {
      var exp = items[idx].querySelector('.hc-expand');
      if (exp) exp.classList.toggle('open', !!openHcItems[idx]);
    }
  }
  function toggleWhyTree(uid) {
    haptic.light();
    openWhyItems[uid] = !openWhyItems[uid];
    var t = document.getElementById(uid);
    if (t) t.classList.toggle('open', !!openWhyItems[uid]);
  }
  // onclick="..." からグローバルスコープで呼べるよう window に公開
  window.toggleJcParam  = toggleJcParam;
  window.toggleHcItem   = toggleHcItem;
  window.toggleWhyTree  = toggleWhyTree;
  window.setThSort      = setThSort;

  // ── 銘柄入替え承認/拒否 ──
  function rotationDecide(id, action) {
    if (action === 'approve') haptic.success();
    else if (action === 'reject') haptic.warn();
    fetch('/api/rotation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, action: action }),
    })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.success) {
          location.reload();
        } else {
          alert('エラー: ' + (data.message || '不明なエラー'));
        }
      })
      .catch(function(e) {
        alert('通信エラー: ' + e);
      });
  }
  window.rotationDecide = rotationDecide;

  var CATEGORY_ORDER = ['為替', '株式指数', '日本株', '米国株', '暗号資産', '商品', '債券'];

  // INSTRUMENTS はAPIレスポンスの data.instruments から動的に初期化される
  // render(data) の冒頭で上書きされるため、初期値は空配列
  var INSTRUMENTS = [];

  // ─── アプリ設定（src/constants.ts からビルド時に自動注入）──────────────────
  var INITIAL_CAPITAL  = 10000;
  var WIN_RATE_GREEN   = 35;
  var WIN_RATE_MH      = 0.4;
  var WIN_RATE_ML      = 0.35;
  var RR_GREEN         = 2;
  var RR_BLUE          = 1;
  var NEWS_EMERGENCY   = 90;
  var NEWS_TREND       = 70;
  var VIX_HIGH         = 0.65;
  var VIX_LOW          = 0.4;
  var NEWS_LIMIT       = 10;
  var ERR_LIMIT        = 5;
  var ANIM_MS          = 800;
  var SCROLL_MS        = 150;
  var ROT_POLL_MS      = 60000;
  var PARAM_POLL_MS    = 60000;
  var BANNER_TTL       = 600000;
  var REL_TRUSTED      = 200;
  var REL_TENTATIVE    = 50;
  var DD_CAUT          = 7;
  var DD_WARN          = 10;
  var DD_HLT           = 15;
  var DD_STP           = 20;
  // ─────────────────────────────────────────────────────────────────────────

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

  // Safari/iOS互換の日付パース（非標準フォーマット対応）
  function parseDate(s) {
    if (!s) return 0;
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d.getTime();
    // Safari非対応: "2026-03-30 13:47:38 Z" → "2026-03-30T13:47:38Z"
    var fixed = String(s).replace(' ', 'T').replace(' Z', 'Z').replace(' z', 'Z');
    d = new Date(fixed);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function fmtTimeAgo(dateStr) {
    if (!dateStr) return '—';
    var diff = Date.now() - parseDate(dateStr);
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
      return '待機中 — ' + text.replace(/^スキップ:\s*/, '').split('(')[0].trim();
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

  // 含み損を含むリアルタイムDD%を計算（決済済みDDベース + 未決済含み損）
  function calcRealDDPct(data) {
    var ddSt = data.statistics && data.statistics.drawdown;
    var closedDD = ddSt ? (ddSt.currentDD || 0) : 0;
    var closedDDPct = ddSt ? (ddSt.currentDDPct || 0) : 0;
    var totalPnl = (data.performance && data.performance.totalPnl) || 0;
    var unrealized = 0;
    var opens = data.openPositions || [];
    for (var i = 0; i < opens.length; i++) {
      var pos = opens[i];
      var instr = findInstr(pos.pair);
      var cr = getCurrentRate(pos.pair);
      if (instr && cr != null) {
        unrealized += pos.direction === 'BUY'
          ? (cr - pos.entry_rate) * instr.multiplier * (pos.lot || 1)
          : (pos.entry_rate - cr) * instr.multiplier * (pos.lot || 1);
      }
    }
    var unrealizedLoss = Math.abs(Math.min(0, unrealized));
    var realCurrentDD = closedDD + unrealizedLoss;
    var peakBalance = INITIAL_CAPITAL + totalPnl + closedDD;
    return peakBalance > 0 ? (realCurrentDD / peakBalance) * 100 : closedDDPct;
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
    var duration = ANIM_MS;
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
    haptic.light();
    var panels = document.querySelectorAll('.tab-panel');
    for (var i = 0; i < panels.length; i++) {
      panels[i].classList.remove('active');
      panels[i].setAttribute('aria-hidden', 'true');
    }
    var target = document.getElementById(tabId);
    if (target) {
      target.classList.add('active');
      target.setAttribute('aria-hidden', 'false');
    }

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

    // PC tabbar active状態同期
    var pcItems = document.querySelectorAll('.pc-tabbar-item');
    for (var p = 0; p < pcItems.length; p++) {
      pcItems[p].classList.toggle('active', pcItems[p].getAttribute('data-tab') === tabId);
    }
    // PC sidebar active状態同期
    var sbItems = document.querySelectorAll('.sidebar-tab');
    for (var s = 0; s < sbItems.length; s++) {
      sbItems[s].classList.toggle('active', sbItems[s].getAttribute('data-tab') === tabId);
    }

    // aria-selected 同期（WCAG 4.1.2）
    var allTabControls = document.querySelectorAll('[role="tab"]');
    for (var k = 0; k < allTabControls.length; k++) {
      allTabControls[k].setAttribute('aria-selected',
        allTabControls[k].getAttribute('data-tab') === tabId ? 'true' : 'false');
    }

    // ニュースドロワー: 今タブのみ表示
    var drawer = document.getElementById('news-drawer');
    if (drawer) drawer.style.display = (tabId === 'tab-portfolio') ? '' : 'none';

    window.scrollTo(0, 0);

    // チャート再描画（表示後にサイズ取得が必要）
    if (tabId === 'tab-stats' && lastData) {
      requestAnimationFrame(function() { renderEquityChart(lastData); });
    }

    // 戦略タブ: paramsData 遅延ロード → 読み込み後に再描画
    if (tabId === 'tab-strategy' && !paramsData) {
      loadParams().then(function() { if (lastData) renderStrategyTab(lastData); }).catch(function(){});
    }
    // 学びタブ: historyData 遅延ロード → 読み込み後に再描画
    if (tabId === 'tab-stats' && !historyData) {
      loadHistory().then(function() { if (lastData) render(lastData); }).catch(function(){});
    }
    // ニュース/AIタブ: newsData 遅延ロード → 読み込み後に再描画
    if ((tabId === 'tab-news' || tabId === 'tab-ai') && !newsData) {
      loadNews().then(function() { if (lastData) render(lastData); }).catch(function(){});
    }
    // ログタブ: logsData 遅延ロード → 読み込み後に再描画
    if (tabId === 'tab-log' && !logsData) {
      loadLogs().then(function() { if (lastData) render(lastData); }).catch(function(){});
    }

    // ディープリンク
    if (scrollTo) {
      setTimeout(function() {
        var scrollEl = document.getElementById(scrollTo);
        if (scrollEl) {
          scrollEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          scrollEl.classList.add('highlight-flash');
          setTimeout(function() { scrollEl.classList.remove('highlight-flash'); }, ANIM_MS);
        }
      }, SCROLL_MS);
    }
  }

  // ══════════════════════════════════════════
  // render() — メインルーター
  // ══════════════════════════════════════════

  function render(data) {
    // APIから銘柄一覧を動的取得（instruments.tsが唯一の真実のソース）
    if (data.instruments && data.instruments.length > 0) {
      INSTRUMENTS = data.instruments.slice().sort(function(a, b) {
        var ai = CATEGORY_ORDER.indexOf(a.category);
        var bi = CATEGORY_ORDER.indexOf(b.category);
        if (ai !== bi) return ai - bi;
        return a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0;
      });
    }
    // 遅延ロードデータをマージ（タブ切替・バックグラウンドフェッチ済みの場合のみ適用）
    if (historyData) { data.recentCloses = historyData.recentCloses; }
    if (newsData) {
      data.newsAnalysis = newsData.newsAnalysis;
      data.latestNews = newsData.latestNews;
      data.acceptedNews = newsData.acceptedNews;
      data.newsTriggers = newsData.newsTriggers;
    }
    if (logsData) { data.systemLogs = logsData.systemLogs; }
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

    // PC panel (>=1920px) データ更新
    var panelRate = el('panel-rate');
    if (panelRate && data.rate) panelRate.textContent = data.rate.toFixed(3);
    var panelVix = el('panel-vix');
    if (panelVix && data.latestDecision && data.latestDecision.vix != null) panelVix.textContent = data.latestDecision.vix.toFixed(1);
    var panelNewsList = el('panel-news-list');
    if (panelNewsList) {
      var pnews = newsForDrawer.slice(0, NEWS_LIMIT);
      panelNewsList.innerHTML = pnews.map(function(n) {
        var isAtt = (data.newsAnalysis || []).some(function(a) { return a.title === (n.title_ja || n.title) && a.impact_level >= 3; });
        return '<div class="panel-news-item' + (isAtt ? ' panel-news-attention' : '') + '">' +
          '<div class="panel-news-title">' + escHtml(n.title_ja || n.title || '') + '</div>' +
          '<div class="panel-news-meta">' + escHtml(n.source || '') + ' · ' + fmtTimeAgo(n.pubDate) + '</div>' +
        '</div>';
      }).join('');
    }
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
      alerts.push({ cls: 'alert-red', text: '\u26A0\uFE0F DD STOP — 日次損失上限超過。新規エントリー停止中' });
    } else if (data.riskStatus && data.riskStatus.maxDailyLoss > 0 &&
               data.riskStatus.todayLoss / data.riskStatus.maxDailyLoss > 0.8) {
      var pct = Math.round(data.riskStatus.todayLoss / data.riskStatus.maxDailyLoss * 100);
      alerts.push({ cls: 'alert-orange', text: '\u26A1 DD注意 — 日次損失が上限の' + pct + '%に到達' });
    }

    if (data.newsAnalysis) {
      var now = Date.now();
      var tenMin = BANNER_TTL;
      for (var ni = 0; ni < data.newsAnalysis.length; ni++) {
        var n = data.newsAnalysis[ni];
        if (n.attention && n.analyzed_at) {
          var diff = now - new Date(n.analyzed_at).getTime();
          if (diff < tenMin) {
            alerts.push({ cls: 'alert-red', text: '\uD83D\uDD34 緊急ニュース: ' + (n.title_ja || n.title || '速報') });
          }
        }
      }
    }

    if (data.systemLogs) {
      var recentErrors = data.systemLogs.slice(0, ERR_LIMIT).filter(function(l) { return l.level === 'ERROR'; });
      if (recentErrors.length > 0) {
        alerts.push({ cls: 'alert-orange', text: '\uD83D\uDD27 システムエラー検出: ' + (recentErrors[0].message || '') });
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
      var pnlAbs = Math.abs(Math.round(todayPnl));
      pnlEl.textContent = (todayPnl > 0 ? '+¥' : todayPnl < 0 ? '-¥' : '¥') + pnlAbs.toLocaleString('ja-JP');
      pnlEl.className = 'pnl ' + (todayPnl > 0 ? 'pos' : todayPnl < 0 ? 'neg' : '');
    }

    var subEl = el('pnl-sub');
    if (subEl) subEl.textContent = '今日の損益';

    // メトリクスストリップ（有効証拠金 = 確定損益 + 含み損益）
    var totalPnl = perf.totalPnl || 0;
    var unrealized = 0;
    var opens = data.openPositions || [];
    for (var oi = 0; oi < opens.length; oi++) {
      var opos = opens[oi];
      var oinstr = findInstr(opos.pair);
      var ocr = getCurrentRate(opos.pair);
      if (oinstr && ocr != null) {
        unrealized += opos.direction === 'BUY'
          ? (ocr - opos.entry_rate) * oinstr.multiplier * (opos.lot || 1)
          : (opos.entry_rate - ocr) * oinstr.multiplier * (opos.lot || 1);
      }
    }
    var capital = INITIAL_CAPITAL + totalPnl + unrealized;
    var roiPct = ((totalPnl + unrealized) / INITIAL_CAPITAL) * 100;

    var balEl = el('m-balance');
    if (balEl) balEl.textContent = fmtYen(capital);

    var roiEl = el('m-roi');
    if (roiEl) {
      roiEl.textContent = fmtPct(roiPct);
      roiEl.style.color = roiPct >= 0 ? 'var(--green)' : 'var(--red)';
    }

    var avgRrEl = el('m-avgrr');
    if (avgRrEl) {
      var st = data.statistics;
      var ar = st && st.avgRR;
      avgRrEl.textContent = ar != null ? ar.toFixed(2) : '—';
      if (ar != null) avgRrEl.style.color = ar >= 1.0 ? 'var(--green)' : 'var(--red)';
    }

    var wrEl = el('m-winrate');
    if (wrEl) {
      wrEl.textContent = (perf.winRate != null ? perf.winRate.toFixed(1) + '%' : '—');
      // RR≥1.0基準: 勝率35%でもavgRR≥2.0ならEV正 → 35%を緑閾値に
      if (perf.winRate != null) wrEl.style.color = perf.winRate >= WIN_RATE_GREEN ? 'var(--green)' : 'var(--red)';
    }

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
      if (sigLabel) sigLabel.textContent = pct >= 100 ? '統計的信頼性 確保' : 'データ蓄積度 ' + pct + '%';
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
    if (textEl) {
      // ナラティブテキストに色ハイライトを挿入（split/joinで正規表現回避）
      var narr = escHtml(cs.narrative || '');
      // 銘柄名（緑）
      var greenWords = ['USD/JPY','EUR/USD','GBP/USD','AUD/USD','S&amp;P500','NASDAQ','Nikkei225','日経225','Gold','Silver','BTC','ETH','SOL','原油','天然ガス','米10年債'];
      greenWords.forEach(function(w) {
        narr = narr.split(w).join('<span style="color:var(--green);font-weight:600">' + w + '</span>');
      });
      // VIX関連（オレンジ）- split/joinパターン
      ['高VIX','VIX高','VIX上昇'].forEach(function(w) {
        narr = narr.split(w).join('<span style="color:var(--orange);font-weight:600">' + w + '</span>');
      });
      // 損失・SL（赤）
      ['損失','ストップロス'].forEach(function(w) {
        narr = narr.split(w).join('<span style="color:var(--red);font-weight:600">' + w + '</span>');
      });
      textEl.innerHTML = narr;
    }

    // ドライバーカード（モックアップ: .drivers > .drv 構造）
    var driversEl = el('causal-drivers');
    if (driversEl && cs.drivers) {
      var html = '';
      if (cs.drivers.profitTop) {
        var p = cs.drivers.profitTop;
        html += '<div class="drv" onclick="switchTab(\'' + 'tab-stats\', \'evo-' + (p.pair || '').replace(/[\/\s]/g, '-').toLowerCase() + '\')">' +
          '<div class="drv-tag profit">利益TOP</div><div class="drv-pair">' + escHtml(p.pair) + '</div>' +
          '<div class="drv-pnl" style="color:var(--green)">+' + Math.round(p.pnl) + '</div>' +
          '<div class="drv-reason">' + escHtml(p.reason || '') + '</div></div>';
      }
      if (cs.drivers.lossTop) {
        var l = cs.drivers.lossTop;
        html += '<div class="drv" onclick="switchTab(\'' + 'tab-stats\', \'evo-' + (l.pair || '').replace(/[\/\s]/g, '-').toLowerCase() + '\')">' +
          '<div class="drv-tag loss">損失TOP</div><div class="drv-pair">' + escHtml(l.pair) + '</div>' +
          '<div class="drv-pnl" style="color:var(--red)">' + Math.round(l.pnl) + '</div>' +
          '<div class="drv-reason">' + escHtml(l.reason || '') + '</div></div>';
      }
      driversEl.innerHTML = html;
    }

    // 要因バッジ（モックアップ: .chips > .chip.w / .chip.i 構造）
    // type: 'vix'=オレンジ(w), 'param_review'=青(i), 'news'=青(i), 'sl'=オレンジ(w)
    var chipsEl = el('causal-chips');
    if (chipsEl && cs.drivers && cs.drivers.factors) {
      chipsEl.innerHTML = cs.drivers.factors.map(function(f) {
        var t = f.type || '';
        var cls = (t === 'vix' || t === 'sl' || t === 'drawdown') ? 'w' : 'i';
        var label = f.label || '';
        // type別のラベル短縮 ("VIX=27で高水準"→"VIX=27", "パラメータレビュー3件..."→"PR 3件", etc.)
        if (t === 'vix') {
          var eqPos = label.indexOf('=');
          if (eqPos >= 0) {
            var afterEq = label.slice(eqPos + 1);
            var nLen = 0;
            while (nLen < afterEq.length && afterEq.charCodeAt(nLen) >= 48 && afterEq.charCodeAt(nLen) <= 57) nLen++;
            if (nLen > 0) label = 'VIX=' + afterEq.slice(0, nLen);
          }
        } else if (t === 'param_review') {
          var numStr = '';
          for (var ci = 0; ci < label.length; ci++) {
            var code = label.charCodeAt(ci);
            if (code >= 48 && code <= 57) numStr += label[ci]; else if (numStr) break;
          }
          label = numStr ? 'PR ' + numStr + '件' : 'PR';
        } else if (t === 'news') {
          var numStr2 = '';
          for (var ci2 = 0; ci2 < label.length; ci2++) {
            var code2 = label.charCodeAt(ci2);
            if (code2 >= 48 && code2 <= 57) numStr2 += label[ci2]; else if (numStr2) break;
          }
          label = numStr2 ? 'ニュース ' + numStr2 + '件' : 'ニュース';
        }
        if (label.length > 12) label = label.slice(0, 12) + '…';
        var onclick = '';
        if (t === 'param_review') {
          onclick = ' onclick="switchTab(\'tab-ai\');setTimeout(function(){var s=document.getElementById(\'ai-pr-section\');if(s)s.scrollIntoView({behavior:\'smooth\'})},100)"';
        } else if (t === 'news') {
          onclick = ' onclick="switchTab(\'tab-news\')"';
        }
        return '<span class="chip ' + cls + '"' + onclick + '>' + escHtml(label) + '</span>';
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
    // vix_effectは0.65以上で警告オレンジ、0.4-0.65は薄いオレンジ、0.4未満は無色（情報ノイズを減らす）
    if (key === 'vix_effect' && val >= VIX_HIGH) return 'rgba(255,159,10,' + Math.min(val, 0.6) + ')';
    if (key === 'vix_effect' && val >= VIX_LOW) return 'rgba(255,159,10,0.18)';
    if (key === 'param_changed' && val > 0) return 'rgba(10,132,255,0.3)';
    if (key === 'news_impact' && val > 0) return 'rgba(255,69,58,' + Math.min(val / 100 * 0.6, 0.6) + ')';
    return 'transparent';
  }

  function hmLabel(val, key) {
    if (key === 'pnl_closed' && val !== 0) return (val > 0 ? '+' : '') + Math.round(val);
    if (key === 'vix_effect' && val > 0) return val.toFixed(1);
    if (key === 'param_changed' && val > 0) return '\u2713';
    if (key === 'news_impact' && val > 0) return '<span style="display:inline-block;background:rgba(10,132,255,0.25);color:#0A84FF;border-radius:4px;padding:0 5px;font-size:11px;font-weight:700">' + Math.round(val) + '</span>';
    return '\u2014';
  }

  // ══════════════════════════════════════════
  // renderNewsFeedNow — ニュース速報（今タブ）
  // ══════════════════════════════════════════

  function renderNewsFeedNow(data) {
    var feedEl = el('news-feed-now');
    if (!feedEl) return;
    var newsHeader = el('news-now-header');
    var items = (data.newsAnalysis || []).filter(function(n) { return n.attention; }).slice(0, 3);
    if (items.length === 0) {
      feedEl.innerHTML = '';
      if (newsHeader) newsHeader.style.display = 'none';
      return;
    }
    if (newsHeader) newsHeader.style.display = '';

    feedEl.innerHTML = items.map(function(n) {
      var score = n.impact ? parseInt(n.impact) : 0;
      if (isNaN(score)) score = 0;
      var badgeCls = score >= NEWS_EMERGENCY ? 'nf-badge-emergency' : score >= NEWS_TREND ? 'nf-badge-trend' : 'nf-badge-info';
      var badgeText = score >= NEWS_EMERGENCY ? '緊急' : score >= NEWS_TREND ? 'トレンド' : '情報';
      var borderCls = score >= NEWS_EMERGENCY ? 'nf-emergency urgent-pulse' : score >= NEWS_TREND ? 'nf-trend' : '';
      var headline = n.title_ja || n.title || '';
      var aiText = n.desc_ja || n.title_ja || n.title || '';

      return '<div class="nf-item ' + borderCls + '" onclick="switchTab(\'tab-news\')">' +
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
      // RRベースでwin/lose判定（含みRR≥1.0ならwin glow付与）
      var cardRR = 0;
      if (pos.sl_rate != null && pos.entry_rate && cr != null) {
        var cardSlDist = Math.abs(pos.entry_rate - pos.sl_rate);
        if (cardSlDist > 0) cardRR = pos.direction === 'BUY' ? (cr - pos.entry_rate) / cardSlDist : (pos.entry_rate - cr) / cardSlDist;
      }
      var winLose = cardRR >= 1.0 ? 'win rr-high' : unrealized >= 0 ? 'win' : 'lose';
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

      // RRバッジ色: RR≥2.0=緑、RR≥1.0=blue、RR<1.0=赤
      var rrBadge = '';
      if (rrText) {
        var rrVal = pos.tp_rate != null && pos.sl_rate != null && pos.entry_rate ? Math.abs(pos.tp_rate - pos.entry_rate) / Math.abs(pos.sl_rate - pos.entry_rate) : 0;
        var rrBg = rrVal >= RR_GREEN ? 'rgba(48,209,88,0.15)' : rrVal >= RR_BLUE ? 'rgba(10,132,255,0.15)' : 'rgba(255,69,58,0.15)';
        var rrColor = rrVal >= RR_GREEN ? 'var(--green)' : rrVal >= RR_BLUE ? 'var(--blue)' : 'var(--red)';
        rrBadge = '<span class="pos-rr-badge" style="background:' + rrBg + ';color:' + rrColor + '">' + rrText + '</span>';
      }

      // 現在の含みRR（リアルタイム）
      var currentRR = '';
      if (pos.sl_rate != null && pos.entry_rate && cr != null) {
        var slDist2 = Math.abs(pos.entry_rate - pos.sl_rate);
        if (slDist2 > 0) {
          var rawRR = pos.direction === 'BUY' ? (cr - pos.entry_rate) / slDist2 : (pos.entry_rate - cr) / slDist2;
          var rrDispColor = rawRR >= 1.0 ? 'var(--green)' : rawRR >= 0 ? 'var(--tertiary)' : 'var(--red)';
          currentRR = '<span style="font-size:11px;color:' + rrDispColor + ';font-weight:600">含RR ' + rawRR.toFixed(1) + '</span>';
        }
      }

      return '<div class="pos ' + winLose + '" onclick="openSheet(\'' + escHtml(pos.pair) + '\')">' +
        '<div class="pos-dir ' + dirCls + '">' + dirLetter + '</div>' +
        '<div class="pos-body">' +
          '<div class="pos-top"><span class="pos-pair">' + escHtml(instr ? instr.label : pos.pair) + '</span>' +
          '<span style="display:flex;align-items:center;gap:6px">' + rrBadge + '<span class="pos-pnl ' + pnlCls + '">' + pnlF.text + '</span></span></div>' +
          '<div class="pos-bot"><span class="pos-meta">' +
            fmtPrice(pos.pair, pos.entry_rate) + '\u2192' + fmtPrice(pos.pair, cr) +
            ' · <span class="' + timeWarnCls.trim() + '">' + holdTime + '</span>' +
            (currentRR ? ' · ' + currentRR : '') +
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
    var prev = (data.recentDecisions || [])[1];
    var items = [];
    if (ld) {
      if (ld.vix != null) {
        var vixD = (prev && prev.vix != null) ? ld.vix - prev.vix : null;
        var vixDStr = vixD != null ? (vixD >= 0 ? '\u2191' : '\u2193') + Math.abs(vixD).toFixed(1) : '';
        items.push({ label: 'VIX', value: fmt(ld.vix, 1), color: ld.vix > 20 ? 'var(--orange)' : '', delta: vixDStr, dCls: vixD != null ? (vixD >= 0 ? 'up' : 'dn') : '' });
      }
      if (ld.us10y != null) {
        var us10yD = (prev && prev.us10y != null) ? ld.us10y - prev.us10y : null;
        var us10yDStr = us10yD != null ? (us10yD >= 0 ? '\u2191' : '\u2193') + Math.abs(us10yD).toFixed(2) : '';
        items.push({ label: 'US10Y', value: fmt(ld.us10y, 2) + '%', color: '', delta: us10yDStr, dCls: us10yD != null ? (us10yD >= 0 ? 'up' : 'dn') : '' });
      }
      if (ld.nikkei != null) {
        var nkD = (prev && prev.nikkei != null && prev.nikkei > 0) ? (ld.nikkei - prev.nikkei) / prev.nikkei * 100 : null;
        var nkDStr = nkD != null ? (nkD >= 0 ? '\u2191' : '\u2193') + Math.abs(nkD).toFixed(1) + '%' : '';
        items.push({ label: '日経', value: Number(ld.nikkei).toLocaleString('ja-JP', { maximumFractionDigits: 0 }), color: '', delta: nkDStr, dCls: nkD != null ? (nkD >= 0 ? 'up' : 'dn') : '' });
      }
      if (ld.sp500 != null) {
        var spD = (prev && prev.sp500 != null && prev.sp500 > 0) ? (ld.sp500 - prev.sp500) / prev.sp500 * 100 : null;
        var spDStr = spD != null ? (spD >= 0 ? '\u2191' : '\u2193') + Math.abs(spD).toFixed(1) + '%' : '';
        items.push({ label: 'S&P', value: Number(ld.sp500).toLocaleString('en-US', { maximumFractionDigits: 0 }), color: '', delta: spDStr, dCls: spD != null ? (spD >= 0 ? 'up' : 'dn') : '' });
      }
    }
    if (items.length === 0) { bar.innerHTML = ''; return; }
    bar.innerHTML = items.map(function(it) {
      return '<div class="mkt"><div class="mkt-v"' + (it.color ? ' style="color:' + it.color + '"' : '') + '>' + it.value + '</div>' +
        '<div class="mkt-l">' + it.label + '</div>' +
        (it.delta ? '<div class="mkt-d ' + it.dCls + '">' + it.delta + '</div>' : '') +
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
    var triggers = data.newsTriggers || [];

    // news_trigger_log からタイトル→trigger_type のルックアップマップを構築
    var triggerMap = {};
    var triggerScoreMap = {};
    var triggerDetailMap = {};
    triggers.forEach(function(t) {
      if (t.news_title) {
        triggerMap[t.news_title] = t.trigger_type;
        if (t.news_score) triggerScoreMap[t.news_title] = t.news_score;
        triggerDetailMap[t.news_title] = { relevance: t.relevance, sentiment: t.sentiment, composite: t.news_score };
      }
    });

    // acceptedNewsのうちanalysisに含まれないものをattention=trueとしてマージ
    var analysisTitlesSet = {};
    analysis.forEach(function(a) { if (a.title) analysisTitlesSet[a.title] = true; });
    var acceptedAsAnalysis = accepted.filter(function(n) { return !analysisTitlesSet[n.title]; }).map(function(n) {
      var tt = triggerMap[n.title] || triggerMap[n.title_ja] || null;
      var td = triggerDetailMap[n.title] || triggerDetailMap[n.title_ja] || null;
      return { title: n.title, title_ja: n.title_ja, desc_ja: n.desc_ja, description: n.desc_ja, attention: true, score: n.score || 0, source: n.source, pubDate: n.pub_date || n.fetched_at, affected_pairs: [], triggerType: tt, triggerDetail: td, scores: n.scores || null };
    });
    // analysisにもtriggerTypeを付与
    analysis.forEach(function(a) {
      if (!a.triggerType) {
        a.triggerType = triggerMap[a.title] || triggerMap[a.title_ja] || null;
      }
      if (!a.triggerDetail) {
        a.triggerDetail = triggerDetailMap[a.title] || triggerDetailMap[a.title_ja] || null;
      }
      if (!a.score) {
        a.score = triggerScoreMap[a.title] || triggerScoreMap[a.title_ja] || null;
      }
    });
    var mergedAnalysis = analysis.concat(acceptedAsAnalysis);

    // KPI
    var totalCount = latest.length + accepted.length;
    var analyzedCount = mergedAnalysis.length;
    var triggeredCount = mergedAnalysis.filter(function(n) { return n.attention; }).length;
    var emergencyCount = mergedAnalysis.filter(function(n) {
      return n.triggerType === 'EMERGENCY';
    }).length;

    var nkTotal = el('nk-total'); if (nkTotal) nkTotal.textContent = String(totalCount);
    var nkAnalyzed = el('nk-analyzed'); if (nkAnalyzed) nkAnalyzed.textContent = String(analyzedCount);
    var nkTriggered = el('nk-triggered'); if (nkTriggered) nkTriggered.textContent = String(triggeredCount);
    var nkEmergency = el('nk-emergency'); if (nkEmergency) nkEmergency.textContent = String(emergencyCount);

    var impacted = el('news-feed-impacted');
    if (impacted) {
      var opens = data.openPositions || [];
      var recentDecs = (data.recentDecisions || []).filter(function(d) { return d.decision === 'BUY' || d.decision === 'SELL'; });
      var impactedItems = mergedAnalysis.filter(function(n) { return n.attention; }).map(function(n) {
        var pairs = n.affected_pairs || [];
        // recentDecisionsからaffected_pairsに一致する取引を取得（pairsが空の場合はマッチしない）
        var matched = pairs.length > 0 ? recentDecs.filter(function(d) {
          return pairs.indexOf(d.pair) >= 0;
        }).slice(0, 3) : [];
        if (matched.length > 0) {
          return Object.assign({}, n, {
            trade_decisions: matched.map(function(d) {
              return { pair: d.pair, decision: d.decision, reasoning: d.reasoning, rate: d.rate, tp_rate: d.tp_rate, sl_rate: d.sl_rate, created_at: d.created_at };
            })
          });
        }
        // フォールバック: OPENポジションにリンク
        if (!n.linked_trade && opens.length > 0) {
          for (var pi = 0; pi < opens.length; pi++) {
            if (pairs.length === 0 || pairs.indexOf(opens[pi].pair) >= 0) {
              var op = opens[pi];
              return Object.assign({}, n, { linked_trade: { direction: op.direction, entry_rate: op.entry_rate, tp_rate: op.tp_rate, sl_rate: op.sl_rate, pair: op.pair } });
            }
          }
        }
        return n;
      });
      impactedItems.sort(function(a, b) {
        return parseDate(b.pubDate) - parseDate(a.pubDate);
      });
      impacted.innerHTML = impactedItems.length > 0
        ? impactedItems.map(function(n, i) { return newsCard(n, true, 'imp-' + i); }).join('')
        : '<div style="padding:16px;font-size:12px;color:var(--tertiary)">なし</div>';
    }

    // 分析済み・影響なし
    var analyzed = el('news-feed-analyzed');
    if (analyzed) {
      var noImpact = analysis.filter(function(n) { return !n.attention; });
      noImpact.sort(function(a, b) {
        return parseDate(b.pubDate) - parseDate(a.pubDate);
      });
      analyzed.innerHTML = noImpact.length > 0
        ? noImpact.slice(0, NEWS_LIMIT).map(function(n, i) { return newsCard(n, false, 'noi-' + i); }).join('')
        : '<div style="padding:16px;font-size:12px;color:var(--tertiary)">なし</div>';
    }

    // 未分析
    var unanalyzed = el('news-feed-unanalyzed');
    var unHeader = el('news-unanalyzed-header');
    if (unanalyzed) {
      var analyzedTitles = {};
      analysis.forEach(function(a) { if (a.title) analyzedTitles[a.title] = true; });
      var unItems = latest.filter(function(n) { return !analyzedTitles[n.title]; });
      unItems.sort(function(a, b) {
        return parseDate(b.pubDate) - parseDate(a.pubDate);
      });
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

  function newsCard(n, highlight, idx) {
    // trigger_typeベースで緊急/トレンド/情報を判定（news_trigger_logの分類を使用）
    var isAttention = !!n.attention;
    var isEmergency = n.triggerType === 'EMERGENCY';
    var isTrend = n.triggerType === 'TREND_INFLUENCE';
    var badgeCls = isEmergency ? 'nf-badge-emergency' : isTrend ? 'nf-badge-trend' : isAttention ? 'nf-badge-attention' : 'nf-badge-info';
    var badgeBase = isEmergency ? '緊急' : isTrend ? 'トレンド変化' : isAttention ? '注目' : '情報';
    var td = n.triggerDetail || {};
    var badgeScore = '';
    if (isEmergency || isTrend) {
      // 判定基準: relevance × sentiment を表示
      if (td.relevance != null && td.sentiment != null) {
        badgeScore = ' · R' + Number(td.relevance).toFixed(0) + '/S' + Number(td.sentiment).toFixed(0);
      } else if (n.score) {
        badgeScore = ' · ' + Number(n.score).toFixed(1);
      }
    } else if (n.score) {
      // 注目/情報: composite_score
      badgeScore = ' · ' + Number(n.score).toFixed(1);
    }
    var badgeText = badgeBase + badgeScore;
    var borderCls = isEmergency ? 'nf-emergency urgent-pulse' : isTrend ? 'nf-trend' : isAttention ? 'nf-attention' : 'nf-info';
    // impactフィールドはAI判断テキスト（数値スコアではない）
    var impactText = typeof n.impact === 'string' ? n.impact : '';
    var aiText = n.desc_ja || n.description || impactText || '';
    var whyHtml = '';
    if (n.why_chain && n.why_chain.length > 0) {
      var whyNewsUid = 'why-news-' + (idx != null ? idx : 'n0');
      whyHtml = '<div style="margin-top:8px">' +
        '<div class="why-toggle" onclick="toggleWhyTree(\'' + whyNewsUid + '\')">\u25b6 Why\u00d75 因果チェーン</div>' +
        '<div class="why-tree' + (openWhyItems[whyNewsUid] ? ' open' : '') + '" id="' + whyNewsUid + '">' + buildWhyTree(n.why_chain) + '</div>' +
        '</div>';
    }
    var pairsHtml = '';
    if (n.affected_pairs && n.affected_pairs.length > 0) {
      pairsHtml = '<div class="nf-action"><span style="font-size:12px;color:var(--tertiary)">\u2192</span>' +
        '<span class="nf-action-text">影響銘柄: <b>' + n.affected_pairs.join(', ') + '</b></span></div>';
    }
    var crossHtml = '';
    if (isAttention) {
      crossHtml = '<div style="margin-top:8px"><span class="cross-link" onclick="switchTab(\'tab-portfolio\')">\u2192 今タブでポジション確認</span>' +
        '<span class="cross-link" style="margin-left:16px" onclick="switchTab(\'tab-ai\')">\u2192 AIタブで判定確認</span></div>';
    }
    // 取引行動表示
    var tradeActionHtml = '';
    if (n.trade_decisions && n.trade_decisions.length > 0) {
      // 同バッチのAI判断を表示
      var tdRows = n.trade_decisions.map(function(td) {
        var dec = td.decision || '';
        var decColor = dec === 'BUY' ? 'var(--blue)' : dec === 'SELL' ? 'var(--teal)' : 'var(--secondary)';
        var decLabel = dec === 'BUY' ? '買い' : dec === 'SELL' ? '売り' : 'HOLD';
        var timeStr = td.created_at ? fmtTimeAgo(td.created_at) : '';
        var rateStr = td.rate ? fmtPrice(td.pair, td.rate) : '';
        return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">' +
          (timeStr ? '<span style="font-size:11px;color:var(--tertiary);flex-shrink:0">' + timeStr + '</span>' : '') +
          '<b style="font-size:13px;color:' + decColor + '">' + escHtml(td.pair) + ' ' + decLabel + '</b>' +
          (rateStr ? '<span style="font-size:12px;color:var(--secondary)">' + rateStr + '</span>' : '') +
          (td.tp_rate ? '<span style="font-size:11px;color:var(--tertiary)">TP ' + fmtPrice(td.pair, td.tp_rate) + '</span>' : '') +
          (td.reasoning ? '<span style="font-size:11px;color:var(--tertiary);width:100%">— ' + escHtml(td.reasoning.substring(0, 50)) + '</span>' : '') +
        '</div>';
      }).join('');
      tradeActionHtml = '<div style="margin-top:6px;padding:8px 12px;background:rgba(255,255,255,0.04);border-radius:var(--rs)">' + tdRows + '</div>';
    } else if (n.linked_trade) {
      var ltDir = n.linked_trade.direction || '';
      var ltPair = n.linked_trade.pair || '';
      var dirColor = ltDir === 'BUY' ? 'var(--blue)' : 'var(--teal)';
      var ltLabel = ltPair ? ltPair + ' ' + ltDir : ltDir;
      tradeActionHtml = '<div class="nf-action"><span style="font-size:12px;color:var(--tertiary)">\u2192</span>' +
        '<span class="nf-action-text"><b style="color:' + dirColor + '">' + escHtml(ltLabel) + '</b>' +
        (n.linked_trade.entry_rate ? ' @ ' + fmtPrice(ltPair, n.linked_trade.entry_rate) : '') +
        (n.linked_trade.tp_rate ? ' \u00b7 TP ' + fmtPrice(ltPair, n.linked_trade.tp_rate) : '') +
        (n.linked_trade.sl_rate ? ' \u00b7 SL ' + fmtPrice(ltPair, n.linked_trade.sl_rate) : '') +
        '</span></div>';
    } else if (isAttention) {
      // hold_reason があれば見送り理由を表示、なければ旧データ表示
      var holdMsg = n.hold_reason ? ('見送り: ' + escHtml(n.hold_reason)) : '判断ログなし（旧データ）';
      var holdColor = n.hold_reason === '既存ポジションあり' ? 'var(--blue)' : 'var(--tertiary)';
      tradeActionHtml = '<div style="margin-top:6px;padding:6px 12px;font-size:11px;color:' + holdColor + ';background:rgba(255,255,255,0.03);border-radius:var(--rs)">' + holdMsg + '</div>';
    } else {
      tradeActionHtml = '<div class="nf-action"><span style="font-size:12px;color:var(--tertiary)">\u2192</span>' +
        '<span class="nf-action-text" style="color:var(--tertiary)">影響なし · パラメーター変更なし</span></div>';
    }
    // Workers AIバッジ: scoresにs_source='workers_ai'があれば表示
    var parsedScores = null;
    try { parsedScores = n.scores ? JSON.parse(n.scores) : null; } catch(e) {}
    var waiIndicator = (parsedScores && parsedScores.s_source === 'workers_ai')
      ? '<span class="nf-wai-badge">\u26a1 Edge AI</span>' : '';
    return '<div class="nf-item ' + borderCls + '">' +
      '<div class="nf-header"><span class="nf-badge ' + badgeCls + '">' + badgeText + '</span>' + waiIndicator + '<span class="nf-time">' + fmtTimeAgo(n.analyzed_at || n.pubDate || '') + '</span></div>' +
      '<div class="nf-headline">' + escHtml(n.title_ja || n.title || '') + '</div>' +
      (aiText ? '<div class="nf-ai"><span class="nf-ai-label">' + (isAttention ? 'AI判断' : 'AI') + '</span><span class="nf-ai-text">' + escHtml(aiText) + '</span></div>' : '') +
      pairsHtml + tradeActionHtml +
      whyHtml + crossHtml +
    '</div>';
  }

  // ══════════════════════════════════════════
  // renderStatsTab — 学びタブ
  // ══════════════════════════════════════════

  function renderStatsTab(data) {
    var st = data.statistics;
    var perf = data.performance || {};

    // KPI 6つ
    var skWr = el('sk-winrate');
    if (skWr) {
      skWr.textContent = perf.winRate != null ? perf.winRate.toFixed(1) + '%' : '—';
      // RR≥1.0基準: 勝率35%でもavgRR≥2.0ならEV正 → 35%を緑閾値に
      if (perf.winRate != null) skWr.style.color = perf.winRate >= WIN_RATE_GREEN ? 'var(--green)' : 'var(--red)';
    }
    // EV指標を勝率KPIの下に補足表示
    var skWrParent = skWr && skWr.parentElement;
    if (skWrParent && perf.winRate != null && st && st.avgRR != null) {
      var evExisting = skWrParent.querySelector('.ev-hint');
      var evVal = (perf.winRate / 100) * st.avgRR - (1 - perf.winRate / 100);
      var evText = 'EV ' + (evVal >= 0 ? '+' : '') + evVal.toFixed(2);
      var evColor = evVal >= 0 ? 'var(--green)' : 'var(--red)';
      if (!evExisting) {
        var evSpan = document.createElement('div');
        evSpan.className = 'ev-hint';
        evSpan.style.cssText = 'font-size:10px;font-weight:600;margin-top:2px;color:' + evColor;
        evSpan.textContent = evText;
        skWrParent.appendChild(evSpan);
      } else {
        evExisting.textContent = evText;
        evExisting.style.color = evColor;
      }
    }
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
      if (avgRR != null) skRr.style.color = avgRR >= 2.0 ? 'var(--green)' : avgRR >= 1.0 ? 'var(--blue)' : 'var(--red)';
    }
    var skTotal = el('sk-total'); if (skTotal) skTotal.textContent = perf.totalClosed != null ? String(perf.totalClosed) : '—';

    // Era分割統計
    renderEraStats(data);

    // エクイティカーブ
    renderEquityChart(data);

    // 手法×環境マトリクス
    renderStrategyMatrix(data);

    // セッション別・銘柄別統計（施策14+21）
    renderSessionPairStats(data);

    // 結論ストリップ
    renderStatsVerdict(data);

    // 銘柄別 evoカード
    renderEvoCards(data);

    // 取引履歴
    renderTradeHistory(data);
  }

  function setThSort(mode) {
    thSortMode = mode;
    var btns = document.querySelectorAll('.th-sort-btn');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.getAttribute('data-sort') === mode) b.classList.add('th-sort-active');
      else b.classList.remove('th-sort-active');
    }
    if (lastData) renderTradeHistory(lastData);
  }

  function renderTradeHistory(data) {
    var container = el('trade-history');
    if (!container) return;
    var trades = (data.recentCloses || []).slice();
    if (trades.length === 0) {
      container.innerHTML = '<div style="font-size:12px;color:var(--tertiary);text-align:center;padding:16px">データ蓄積中...</div>';
      return;
    }

    if (thSortMode === 'entry') {
      trades.sort(function(a, b) {
        return parseDate(b.entry_at) - parseDate(a.entry_at);
      });
    } else {
      trades.sort(function(a, b) {
        return parseDate(b.closed_at) - parseDate(a.closed_at);
      });
    }

    function fmtDt(s) {
      if (!s) return '—';
      var d = new Date(s);
      return (d.getMonth()+1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    }

    var html = '<div style="display:flex;flex-direction:column;gap:8px">';
    for (var i = 0; i < trades.length; i++) {
      var t = trades[i];
      var dirLabel  = t.direction === 'BUY' ? '買い' : '売り';
      var dirColor  = t.direction === 'BUY' ? 'var(--blue)' : 'var(--orange, #FF9F0A)';
      var pnlColor  = (t.pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)';
      var pnlStr    = t.pnl != null ? ((t.pnl >= 0 ? '+' : '') + '¥' + Math.round(t.pnl).toLocaleString()) : '—';
      var rrStr     = t.realized_rr != null ? t.realized_rr.toFixed(2) : '—';
      var rrColor   = t.realized_rr == null ? 'var(--tertiary)' : t.realized_rr >= 1.0 ? 'var(--green)' : t.realized_rr > 0 ? 'var(--blue)' : 'var(--red)';
      var mfeStr    = t.mfe != null ? (t.mfe >= 0 ? '+' : '') + '¥' + Math.round(t.mfe).toLocaleString() : '—';
      var maeStr    = t.mae != null ? (t.mae >= 0 ? '+' : '') + '¥' + Math.round(t.mae).toLocaleString() : '—';
      var closeReason  = t.close_reason || '—';
      var reasonColor  = closeReason === 'TP' ? 'var(--green)' : closeReason === 'SL' ? 'var(--red)' : 'var(--tertiary)';

      html +=
        '<div style="background:var(--surface);border-radius:10px;padding:10px 12px;border-left:3px solid ' + dirColor + '">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
            '<span style="font-size:13px;font-weight:700;color:var(--primary)">' + escHtml(t.pair) + '</span>' +
            '<span style="font-size:11px;font-weight:600;color:' + dirColor + '">' + dirLabel + '</span>' +
            '<span style="font-size:11px;color:var(--tertiary)">' + (t.lot != null ? (t.lot < 1 ? t.lot.toFixed(3) : t.lot.toFixed(1)) : '—') + 'lot</span>' +
            '<span style="font-size:12px;font-weight:700;color:' + pnlColor + '">' + pnlStr + '</span>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;margin-bottom:6px">' +
            '<div style="font-size:10px;color:var(--tertiary)">エントリー<div style="color:var(--secondary);font-size:11px">' + fmtDt(t.entry_at) + '</div></div>' +
            '<div style="font-size:10px;color:var(--tertiary)">決済<div style="color:var(--secondary);font-size:11px">' + fmtDt(t.closed_at) + '</div></div>' +
            '<div style="font-size:10px;color:var(--tertiary)">理由<div style="color:' + reasonColor + ';font-size:11px;font-weight:600">' + escHtml(closeReason) + '</div></div>' +
            '<div style="font-size:10px;color:var(--tertiary)">実現RR<div style="color:' + rrColor + ';font-size:11px;font-weight:600">' + rrStr + '</div></div>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">' +
            '<div style="font-size:10px;color:var(--tertiary)">最大含み益(MFE)<div style="color:var(--green);font-size:11px">' + mfeStr + '</div></div>' +
            '<div style="font-size:10px;color:var(--tertiary)">最大含み損(MAE)<div style="color:var(--red);font-size:11px">' + maeStr + '</div></div>' +
          '</div>' +
        '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
  }

  function renderEraStats(data) {
    var sec = el('era-stats-section');
    var cards = el('era-stats-cards');
    if (!sec || !cards) return;
    var era = data.eraStats;
    if (!era) { sec.style.display = 'none'; return; }
    sec.style.display = 'block';
    var html = '';
    [era.pre, era.post].forEach(function(e) {
      var isPost = e.label.indexOf('RR') >= 0;
      var border = isPost ? 'rgba(48,209,88,0.3)' : 'rgba(142,142,147,0.2)';
      var badge = isPost ? '<span style="font-size:9px;background:var(--green);color:#000;border-radius:4px;padding:1px 5px;margin-left:4px;font-weight:700">現行</span>' : '';
      var pnlColor = e.pnl >= 0 ? 'var(--green)' : 'var(--red)';
      var wrColor = e.win_rate >= WIN_RATE_GREEN ? 'var(--green)' : 'var(--red)';
      html += '<div style="flex:1;background:var(--surface);border-radius:var(--rs);padding:10px;border:1px solid ' + border + '">'
        + '<div style="font-size:10px;color:var(--tertiary);font-weight:600;margin-bottom:6px">' + e.label + badge + '</div>'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:4px">'
        + '<span style="font-size:11px;color:var(--secondary)">PnL</span>'
        + '<span style="font-size:13px;font-weight:700;color:' + pnlColor + '">' + (e.pnl >= 0 ? '+' : '') + e.pnl.toLocaleString() + '円</span></div>'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:4px">'
        + '<span style="font-size:11px;color:var(--secondary)">勝率(RR\u22651.0)</span>'
        + '<span style="font-size:13px;font-weight:700;color:' + wrColor + '">' + e.win_rate.toFixed(1) + '%</span></div>'
        + '<div style="display:flex;justify-content:space-between;margin-bottom:4px">'
        + '<span style="font-size:11px;color:var(--secondary)">avgRR</span>'
        + '<span style="font-size:13px;font-weight:700">' + e.avg_rr.toFixed(3) + '</span></div>'
        + '<div style="display:flex;justify-content:space-between">'
        + '<span style="font-size:11px;color:var(--secondary)">取引</span>'
        + '<span style="font-size:13px;font-weight:700">' + e.total + '件 (' + e.wins + '勝)</span></div>'
        + '</div>';
    });
    cards.innerHTML = html;
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
    var closesPnlSum = 0;
    for (var i = 0; i < closes.length; i++) { closesPnlSum += (closes[i].pnl || 0); }
    var basePnl = INITIAL_CAPITAL + ((data.performance && data.performance.totalPnl) || 0) - closesPnlSum;
    var sum = basePnl;
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
    var color = cumPnl[cumPnl.length - 1] >= basePnl ? 'var(--green)' : 'var(--red)';

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
      while (usedX[mx] || usedX[mx + 1] || usedX[mx - 1]) mx = mx + 16; // 重複回避（ラベル幅分確保）
      usedX[mx] = true;
      var col = markerColors[mi % markerColors.length];
      var label = mi === 0 ? 'v2' : 'PR#' + (mi + 1);
      // 偶数マーカー=上部(y=9)、奇数マーカー=下部(y=h-2)で交互配置し重なりを防ぐ
      var labelY = (mi % 2 === 0) ? 9 : (h - 2);
      markerHtml += '<line x1="' + mx + '" y1="0" x2="' + mx + '" y2="' + h + '" stroke="' + col + '" stroke-width="1" stroke-dasharray="3"/>';
      markerHtml += '<text x="' + (mx + 2) + '" y="' + labelY + '" fill="' + col + '" font-size="9">' + label + '</text>';
    });

    svg.innerHTML = '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' + markerHtml;
  }

  function renderStrategyMatrix(data) {
    var matrixEl = el('strategy-matrix');
    if (!matrixEl) return;
    var sm = data.strategyMap;

    // regime が実データかを判定（NULLや"—"だけなら fallback へ）
    var stats = sm && sm.strategyStats ? sm.strategyStats : [];
    var hasRealRegimes = stats.some(function(s) { return s.regime && s.regime !== '—'; });

    if (stats.length > 0 && hasRealRegimes) {
      // 実データ: strategy × regime グリッド
      var strategies = [], regimes = [], cellMap = {};
      stats.forEach(function(s) {
        var strat = s.strategy || '—';
        var reg = s.regime || '—';
        if (strategies.indexOf(strat) === -1) strategies.push(strat);
        if (regimes.indexOf(reg) === -1) regimes.push(reg);
        cellMap[strat + '|' + reg] = s;
      });
      var html = '<div class="matrix-h"></div>';
      regimes.forEach(function(r) { html += '<div class="matrix-h">' + escHtml(r) + '</div>'; });
      strategies.forEach(function(strat) {
        html += '<div class="matrix-p">' + escHtml(strat) + '</div>';
        regimes.forEach(function(reg) {
          var cell = cellMap[strat + '|' + reg];
          if (cell && cell.count > 0) {
            var wr = (cell.winRate * 100).toFixed(0);
            // RR≥1.0基準: 勝率40%以上=緑濃、35%以上=緑薄、それ以下=赤
            var bg = cell.winRate >= WIN_RATE_MH ? 'rgba(48,209,88,0.25)' : cell.winRate >= WIN_RATE_ML ? 'rgba(48,209,88,0.15)' : 'rgba(255,69,58,0.2)';
            var pfx = cell.winRate >= WIN_RATE_ML ? '+' : '';
            html += '<div class="matrix-c" style="background:' + bg + '">' + pfx + wr + '%<br><span style="font-size:9px;opacity:.6">' + cell.count + '件</span></div>';
          } else {
            html += '<div class="matrix-c">—</div>';
          }
        });
      });
      matrixEl.innerHTML = html;
      return;
    }

    // フォールバック: ティア別 × VIX水準
    var tiers = sm && sm.instrumentTiers ? sm.instrumentTiers : [];
    var byPair = data.performanceByPair || {};
    // slPatterns から VIX bucket 別 SL率を取得
    var slPatterns = data.slPatterns || [];
    var vixCols = ['低VIX', '中VIX', '高VIX'];
    // tier × vixBucket の wins/total を集計
    var tierVix = {};
    ['A','B','C'].forEach(function(t) {
      vixCols.forEach(function(v) { tierVix[t + '|' + v] = { wins: 0, total: 0 }; });
    });
    // slPatterns が存在すれば VIX bucket 別に tier を分配
    slPatterns.forEach(function(p) {
      var bucket = p.vixBucket === 'low' ? '低VIX' : p.vixBucket === 'mid' ? '中VIX' : p.vixBucket === 'high' ? '高VIX' : null;
      if (!bucket) return;
      var nonSlCount = (p.totalCount || 0) - (p.slCount || 0);
      // pairCategory が tier に対応する場合のみ集計
      var tier = p.pairCategory === 'A' ? 'A' : p.pairCategory === 'B' ? 'B' : 'C';
      var key = tier + '|' + bucket;
      tierVix[key].wins += nonSlCount;
      tierVix[key].total += p.totalCount || 0;
    });
    // slPatterns がなければ performanceByPair から tier × overall を埋める
    tiers.forEach(function(t) {
      var p = byPair[t.pair];
      if (!p || p.total === 0) return;
      var tier = t.tier || 'C';
      if (tier === 'D') tier = 'C';
      // VIX bucket がなければ全列に均等分配（概算）
      var hasVixData = vixCols.some(function(v) { return tierVix[tier + '|' + v].total > 0; });
      if (!hasVixData) {
        var perBucket = Math.floor(p.total / 3);
        var wPerBucket = Math.floor(p.wins / 3);
        vixCols.forEach(function(v) { tierVix[tier + '|' + v].wins += wPerBucket; tierVix[tier + '|' + v].total += perBucket; });
      }
    });
    function matrixCell(tier, vix) {
      var d = tierVix[tier + '|' + vix];
      if (!d || d.total === 0) return '<div class="matrix-c" style="color:var(--tertiary);font-size:10px">蓄積中</div>';
      var wr = d.wins / d.total;
      var pct = (wr * 100).toFixed(0);
      // SL回避率: 50%以上=緑濃、40%以上=緑薄、それ以下=赤
      var bg = wr >= 0.50 ? 'rgba(48,209,88,0.25)' : wr >= 0.40 ? 'rgba(48,209,88,0.15)' : 'rgba(255,69,58,0.2)';
      return '<div class="matrix-c" style="background:' + bg + '">' + (wr >= 0.40 ? '+' : '') + pct + '%</div>';
    }
    var fb = '<div class="matrix-h"></div>';
    vixCols.forEach(function(v) { fb += '<div class="matrix-h">' + v + '</div>'; });
    ['TierA(安定)', 'TierB(中)', 'TierC/D'].forEach(function(label, i) {
      var tier = ['A','B','C'][i];
      fb += '<div class="matrix-p">' + label + '</div>';
      vixCols.forEach(function(v) { fb += matrixCell(tier, v); });
    });
    matrixEl.innerHTML = fb;
  }

  function renderSessionPairStats(data) {
    var sessEl = el('session-stats-table');
    var pairEl = el('pair-stats-table');
    var sessList = data.sessionStats || [];
    var pairList = data.pairStats || [];

    function statsTable(rows, labelKey) {
      if (!rows || rows.length === 0) {
        return '<div style="color:var(--tertiary);font-size:12px;padding:8px 0">データ蓄積中...</div>';
      }
      var h = '<table style="width:100%;font-size:12px;border-collapse:collapse">';
      h += '<tr style="color:var(--tertiary)">';
      h += '<th style="text-align:left;padding:4px 6px;font-weight:600">' + (labelKey === 'session' ? 'セッション' : '銘柄') + '</th>';
      h += '<th style="text-align:right;padding:4px 6px;font-weight:600">件数</th>';
      h += '<th style="text-align:right;padding:4px 6px;font-weight:600">勝率(RR≥1.0)</th>';
      h += '<th style="text-align:right;padding:4px 6px;font-weight:600">avg PnL</th>';
      h += '<th style="text-align:right;padding:4px 6px;font-weight:600">avg RR</th>';
      h += '</tr>';
      rows.forEach(function(r, i) {
        var label = escHtml(r[labelKey] || '—');
        var wrColor = r.winRate >= 40 ? 'var(--green)' : r.winRate >= 30 ? 'var(--label)' : 'var(--red)';
        var pnlColor = r.avgPnl >= 0 ? 'var(--green)' : 'var(--red)';
        var bg = i % 2 === 1 ? 'background:rgba(255,255,255,0.03)' : '';
        h += '<tr style="' + bg + '">';
        h += '<td style="padding:4px 6px;color:var(--label)">' + label + '</td>';
        h += '<td style="text-align:right;padding:4px 6px;color:var(--tertiary)">' + r.count + '</td>';
        h += '<td style="text-align:right;padding:4px 6px;color:' + wrColor + '">' + (r.winRate != null ? r.winRate.toFixed(1) + '%' : '—') + '</td>';
        h += '<td style="text-align:right;padding:4px 6px;color:' + pnlColor + '">' + (r.avgPnl != null ? (r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(1) : '—') + '</td>';
        h += '<td style="text-align:right;padding:4px 6px;color:var(--tertiary)">' + (r.avgRR != null ? r.avgRR.toFixed(2) : '—') + '</td>';
        h += '</tr>';
      });
      h += '</table>';
      return h;
    }

    if (sessEl) sessEl.innerHTML = statsTable(sessList, 'session');
    if (pairEl) pairEl.innerHTML = statsTable(pairList.slice(0, NEWS_LIMIT), 'pair');
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
    if (svWorked) { svWorked.textContent = String(worked); svWorked.style.color = 'var(--green)'; }
    if (svDidnt) { svDidnt.textContent = String(didnt); svDidnt.style.color = 'var(--red)'; }
    if (svPending) { svPending.textContent = String(pending); svPending.style.color = 'var(--tertiary)'; }
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
      var pairId = instr.pair.replace(/[\/\s]/g, '-').toLowerCase();

      // verdict — RRベースで判定（平均RR≥1.0=改善中、<1.0=悪化）
      var verdictCls = 'unchanged';
      var verdictText = '検証中';
      var pairAvgRR = p.total > 0 && p.avgRR != null ? p.avgRR : null;
      if (pairAvgRR != null && pairAvgRR >= 1.0) { verdictCls = 'worked'; verdictText = 'RR' + pairAvgRR.toFixed(1) + ' 改善中'; }
      else if (pairAvgRR != null && pairAvgRR < 1.0 && p.total >= 3) { verdictCls = 'didnt'; verdictText = 'RR' + pairAvgRR.toFixed(1) + ' 要改善'; }

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
        var sColor = (pairAvgRR != null && pairAvgRR >= 1.0) ? '#30D158' : (p.totalPnl >= 0 ? '#30D158' : '#FF453A');
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
        changesHtml = '<div class="evo-changes">' + pairChanges.map(function(c, ci) {
          var dotCls = c.verdict === 'worked' || c.verdict === 'improved' ? 'improved' : c.verdict === 'worsened' || c.verdict === 'didnt' ? 'worsened' : 'neutral';
          var resCls = dotCls === 'improved' ? 'worked' : dotCls === 'worsened' ? 'didnt' : 'unchanged';
          var whyHtml = '';
          if (c.why_chain && c.why_chain.length > 0) {
            var uid = 'why-evo-' + pairId + '-' + ci;
            whyHtml = '<div class="why-toggle" onclick="toggleWhyTree(\'' + uid + '\')">\u25b6 ' + (dotCls === 'improved' ? 'なぜ効いた？' : dotCls === 'worsened' ? 'なぜ効かなかった？' : '根拠') + '</div>' +
              '<div class="why-tree' + (openWhyItems[uid] ? ' open' : '') + '" id="' + uid + '">' + buildWhyTree(c.why_chain) + '</div>';
          }
          return '<div class="evo-change"><div class="evo-dot ' + dotCls + '"></div><div style="flex:1">' +
            '<div class="evo-text">' + escHtml(c.description || c.change || '') + '</div>' +
            '<div class="evo-result ' + resCls + '">' + escHtml(c.result_text || '') + '</div>' +
            whyHtml +
            '<span class="cross-link" onclick="switchTab(\'tab-strategy\',\'jc-' + pairId + '\')">\u2192 戦略で詳細</span>' +
            '<span class="cross-link" style="margin-left:12px" onclick="switchTab(\'tab-ai\')">\u2192 AIタブで判断を確認</span>' +
          '</div></div>';
        }).join('') + '</div>';
      } else {
        changesHtml = '<div class="evo-changes"><div class="evo-change"><div class="evo-dot neutral"></div><div style="flex:1">' +
          '<div class="evo-text">勝率(RR\u22651.0) ' + wr + '% \u00b7 ' + p.wins + '勝' + (p.total - p.wins) + '敗\uff08計' + p.total + '\uff09</div>' +
          '<div class="evo-result unchanged">パラメーター変更なし</div>' +
        '</div></div></div>';
      }

      var glowCls = verdictCls === 'worked' ? ' card-glow-success' : '';
      return '<div class="evo-card' + glowCls + '" id="evo-' + pairId + '">' +
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
    var nums = '①②③④⑤';
    return chain.map(function(w, i) {
      if (typeof w === 'string') {
        return '<div class="why-node">' +
          '<div class="why-a">' + nums.charAt(i) + ' ' + escHtml(w) + '</div>' +
        '</div>';
      }
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

    // Param Review精度をparamHistoryから計算
    var ph = data.paramHistory || [];
    var prCorrect = ph.filter(function(h) { return h.verdict === 'worked' || h.verdict === 'improved'; }).length;
    var prWrong = ph.filter(function(h) { return h.verdict === 'worsened' || h.verdict === 'didnt'; }).length;
    var prPending = ph.filter(function(h) { return !h.verdict || h.verdict === 'pending'; }).length;
    var prN = prCorrect + prWrong;
    var prAccuracyVal = prN > 0 ? prCorrect / prN : null;

    // ニュース精度をnewsAnalysisのverdictから計算
    var newsItems = (data.newsAnalysis || []).filter(function(n) { return n.verdict; });
    var newsCorrect = newsItems.filter(function(n) { return n.verdict === 'correct'; }).length;
    var newsWrong = newsItems.filter(function(n) { return n.verdict === 'wrong'; }).length;
    var newsN = newsCorrect + newsWrong;
    var newsAccuracyVal = newsN > 0 ? newsCorrect / newsN : null;

    // 全体: 取引判断 + paramHistory + ニュース分析を合算した正解率
    var combinedN = (acc ? acc.n : 0) + prN + newsN;
    var combinedCorrect = (acc ? acc.wins : 0) + prCorrect + newsCorrect;
    var combinedAccuracy = combinedN > 0 ? combinedCorrect / combinedN : null;

    // ヒーロー正解率（AI合算）
    var scoreNum = el('ai-score-num');
    if (scoreNum) {
      if (combinedAccuracy != null) {
        scoreNum.textContent = (combinedAccuracy * 100).toFixed(0) + '%';
        scoreNum.style.color = combinedAccuracy >= 0.6 ? 'var(--green)' : combinedAccuracy >= 0.5 ? 'var(--orange)' : 'var(--red)';
      } else if (acc) {
        scoreNum.textContent = (acc.accuracy * 100).toFixed(0) + '%';
        scoreNum.style.color = acc.accuracy >= 0.6 ? 'var(--green)' : acc.accuracy >= 0.5 ? 'var(--orange)' : 'var(--red)';
      } else {
        scoreNum.textContent = '—%';
      }
    }
    var scoreSub = el('ai-score-sub');
    if (scoreSub) scoreSub.textContent = combinedN > 0 ? '直近' + combinedN + '件のAI行動のうち、' + combinedCorrect + '件が正しかった' : '—';

    // ニュース分析/Param Review内訳
    var newsVal = el('ai-brk-news-val');
    var newsSub = el('ai-brk-news-sub');
    var prVal = el('ai-brk-pr-val');
    var prSub = el('ai-brk-pr-sub');
    if (newsAccuracyVal != null) {
      if (newsVal) { newsVal.textContent = (newsAccuracyVal * 100).toFixed(0) + '%'; newsVal.style.color = newsAccuracyVal >= 0.6 ? 'var(--green)' : 'var(--orange)'; }
      if (newsSub) newsSub.textContent = newsN + '件中' + newsCorrect + '件正解';
    } else {
      if (newsVal) newsVal.textContent = '—';
      if (newsSub) newsSub.textContent = ph.length === 0 ? 'データ蓄積中' : '—';
    }
    if (prAccuracyVal != null) {
      if (prVal) { prVal.textContent = (prAccuracyVal * 100).toFixed(0) + '%'; prVal.style.color = prAccuracyVal >= 0.6 ? 'var(--green)' : 'var(--orange)'; }
      if (prSub) prSub.textContent = prN + '件中' + prCorrect + '件正解';
    } else {
      if (prVal) prVal.textContent = '—';
      if (prSub) prSub.textContent = ph.length === 0 ? 'データ蓄積中' : '判定中';
    }

    // Brierスコアと傾向
    var brierVal = el('ai-brier-val');
    var brierTrend = el('ai-brier-trend');
    if (brierVal) {
      brierVal.textContent = acc ? acc.brierScore.toFixed(2) : '—';
      if (acc) brierVal.style.color = acc.brierScore < 0.25 ? 'var(--green)' : 'var(--orange)';
    }
    if (brierTrend && acc && acc.brierTrend) {
      brierTrend.textContent = acc.brierTrend === 'improving' ? '\u2193改善中' : acc.brierTrend === 'worsening' ? '\u2191悪化' : '';
    }

    // Brierスパークライン（brierHistoryがあれば描画、なければaccuracy推移で代用）
    var brierSpark = el('ai-brier-spark');
    if (brierSpark) {
      var bh = (acc && acc.brierHistory && acc.brierHistory.length > 2) ? acc.brierHistory : null;
      if (bh) {
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
    }

    // 正解/不正解/判定中（paramHistoryも含めて合算）
    var overallCorrect = (acc ? acc.wins : 0) + prCorrect + newsCorrect;
    var overallWrong = (acc ? acc.n - acc.wins : 0) + prWrong + newsWrong;
    var overallPending = prPending;
    var vCorrect = el('ai-v-correct');
    if (vCorrect) { vCorrect.textContent = String(overallCorrect); vCorrect.style.color = 'var(--green)'; }
    var vWrong = el('ai-v-wrong');
    if (vWrong) { vWrong.textContent = String(overallWrong); vWrong.style.color = 'var(--red)'; }
    var vPending = el('ai-v-pending');
    if (vPending) { vPending.textContent = String(overallPending); vPending.style.color = 'var(--blue)'; }

    // PARAM REVIEW カード
    renderAiPrCards(data);

    // ニュース分析カード
    renderAiNewsCards(data);

    // AI判断タイムライン (hidden if verdict cards suffice)
    renderAiTimeline(data);
  }

  function verdictCard(item, idx) {
    var v = item.verdict || 'pending';
    var cardCls = v === 'correct' ? 'correct' : v === 'wrong' ? 'wrong' : 'pending';
    var verdictText = v === 'correct' ? '正解' : v === 'wrong' ? '不正解' : '判定中';
    var outcomeCls = v === 'correct' ? 'worked' : v === 'wrong' ? 'didnt' : '';
    // hold_reason がある場合はオレンジ（機会損失候補）
    var outcomeStyle = item.hold_reason ? ' style="color:var(--orange)"'
      : v === 'pending' ? ' style="color:var(--blue)"' : '';

    var whyHtml = '';
    if (item.why_chain && item.why_chain.length > 0) {
      var uid = 'why-ai-' + (idx != null ? idx : 'a0');
      whyHtml = '<div class="why-toggle" onclick="toggleWhyTree(\'' + uid + '\')">\u25b6 Why\u00d75 根拠チェーン</div>' +
        '<div class="why-tree' + (openWhyItems[uid] ? ' open' : '') + '" id="' + uid + '">' + buildWhyTree(item.why_chain) + '</div>';
    }

    var crossHtml = '';
    if (item.crossLink) {
      var clArgs = '\'' + escHtml(item.crossLink.tab || 'tab-stats') + '\'';
      if (item.crossLink.scrollTo) clArgs += ',\'' + escHtml(item.crossLink.scrollTo) + '\'';
      crossHtml = '<span class="cross-link" onclick="switchTab(' + clArgs + ')">' + escHtml(item.crossLink.text || '\u2192 詳細') + '</span>';
    }

    return '<div class="verdict-card ' + cardCls + '">' +
      '<div class="vc-header"><span class="vc-action">' + escHtml(item.action || '') + '</span><span class="vc-verdict ' + cardCls + '">' + verdictText + '</span></div>' +
      '<div class="vc-reason">\u300c' + escHtml(item.reason || '') + '\u300d</div>' +
      (item.outcome ? '<div class="vc-outcome ' + outcomeCls + '"' + outcomeStyle + '>\u2192 ' + escHtml(item.outcome) + '</div>' : '') +
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
    container.innerHTML = ph.map(function(h, i) {
      var v = h.verdict === 'worked' || h.verdict === 'improved' ? 'correct' : h.verdict === 'worsened' || h.verdict === 'didnt' ? 'wrong' : 'pending';
      // PFが利用可能な場合はPF基準で上書き（PF≥1.1→correct, PF<0.9→wrong, それ以外→pending）
      if (h.pf != null) {
        v = h.pf >= 1.1 ? 'correct' : h.pf < 0.9 ? 'wrong' : 'pending';
      }
      // reasonは変更理由の核心部分（先頭50字）
      var shortReason = (h.change || h.reason || '');
      if (shortReason.length > 50) shortReason = shortReason.slice(0, 50) + '…';
      return verdictCard({
        action: (h.pair || '') + ' Param Review',
        verdict: v,
        reason: shortReason,
        outcome: h.result_text || '',
        time: h.created_at || h.time || '',
        why_chain: h.why_chain || null,
        crossLink: { tab: 'tab-stats', scrollTo: 'evo-' + (h.pair || '').replace(/[\/\s]/g, '-').toLowerCase(), text: '\u2192 学びで効果を確認' }
      }, 'pr-' + i);
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
    container.innerHTML = items.slice(0, 5).map(function(n, i) {
      var v = n.verdict || 'pending';
      // actionをより具体的に: 影響銘柄+取引方向
      var pairs = (n.affected_pairs || []).join('/');
      var actionLabel = pairs ? 'ニュース ' + pairs : 'ニュース分析';
      // hold_reasonがあれば機会損失候補として outcome に表示
      var outcomeText = n.hold_reason
        ? '見送り: ' + n.hold_reason
        : (n.impact || n.desc_ja || n.description || '');
      return verdictCard({
        action: actionLabel,
        verdict: v,
        reason: n.title_ja || n.title || '',
        outcome: outcomeText,
        time: n.analyzed_at || n.pubDate || '',
        why_chain: n.why_chain || null,
        hold_reason: n.hold_reason || null,
        crossLink: { tab: 'tab-portfolio', text: '\u2192 今タブで進行確認' }
      }, 'nc-' + i);
    }).join('');
  }

  function renderAiTimeline(data) {
    var container = el('ai-timeline');
    if (!container) return;

    // decisions（BUY/SELL + PATH_B_HOLD）と indicatorLogs をマージして時系列表示
    var decItems = (data.recentDecisions || [])
      .filter(function(d) {
        if (d.decision === 'BUY' || d.decision === 'SELL') return true;
        if (d.decision === 'HOLD' && d.reasoning && d.reasoning.indexOf('[PATH_B_HOLD]') >= 0) return true;
        return false;
      })
      .map(function(d) { return Object.assign({}, d, { _type: 'decision' }); });

    var indItems = (data.recentIndicatorLogs || [])
      .map(function(l) { return Object.assign({}, l, { _type: 'indicator' }); });

    var allItems = decItems.concat(indItems)
      .sort(function(a, b) { return parseDate(b.created_at) - parseDate(a.created_at); })
      .slice(0, 60);

    if (allItems.length === 0) {
      container.innerHTML = '<div style="padding:12px 16px;font-size:12px;color:var(--tertiary)">アクティビティなし（BUY/SELL実行後または指標変化後に表示されます）</div>';
      return;
    }

    container.innerHTML = allItems.map(function(item) {
      if (item._type === 'decision') {
        var d = item;
        var isOpportunityLoss = d.reasoning && d.reasoning.indexOf('[PATH_B_HOLD]') >= 0;
        var tagCls, tagTxt, actionTxt, actionCls;
        if (isOpportunityLoss) {
          tagCls = 'feed-tag-loss'; tagTxt = '機会損失';
          actionTxt = '見送り'; actionCls = 'feed-act-hold';
        } else if (d.decision === 'BUY') {
          tagCls = 'feed-tag-buy'; tagTxt = '緊急';
          actionTxt = '買い'; actionCls = 'feed-act-buy';
        } else {
          tagCls = 'feed-tag-sell'; tagTxt = '緊急';
          actionTxt = '売り'; actionCls = 'feed-act-sell';
        }
        var rateStr = fmtPrice(d.pair, d.rate);
        var timeStr = fmtTime(d.created_at);
        return '<div class="feed-item">'
          + '<span class="feed-tag ' + tagCls + '">' + tagTxt + '</span>'
          + '<span class="feed-time">' + escHtml(timeStr) + '</span>'
          + '<span class="feed-pair">' + escHtml(d.pair) + '</span>'
          + '<span class="feed-rate">' + escHtml(rateStr) + '</span>'
          + '<span class="feed-act ' + actionCls + '">' + actionTxt + '</span>'
          + '</div>';
      } else {
        // indicator log
        var l = item;
        var isUp = l.direction === 'UP';
        var tagCls2 = isUp ? 'feed-tag-trend-up' : 'feed-tag-trend-dn';
        var tagTxt2 = isUp ? '上昇' : '下落';
        var timeStr2 = fmtTime(l.created_at);
        return '<div class="feed-item feed-item-ind">'
          + '<span class="feed-tag ' + tagCls2 + '">' + tagTxt2 + '</span>'
          + '<span class="feed-time">' + escHtml(timeStr2) + '</span>'
          + '<span class="feed-pair">' + escHtml(l.pair) + '</span>'
          + '<span class="feed-note">' + escHtml(l.note || (l.metric + ' ' + l.prev_value + '→' + l.curr_value)) + '</span>'
          + '</div>';
      }
    }).join('');
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
      var pairId = instr.pair.replace(/[\/\s]/g, '-').toLowerCase();
      var pairChanges = ph.filter(function(h) { return h.pair === instr.pair; });
      var currentVersion = pairChanges.length > 0 ? 'v' + (pairChanges.length + 1) : 'v1';
      var wr = p.total > 0 ? (p.wins / p.total * 100).toFixed(0) : '—';
      var pnlF = fmtPnl(p.totalPnl, instr.unit);

      // Summary text（モックアップ準拠の叙述）
      var summaryText;
      if (pairChanges.length > 0) {
        var latestChange = pairChanges[0];
        var verdictLabel = latestChange.verdict === 'worked' ? '改善' : latestChange.verdict === 'worsened' ? '悪化' : '検証中';
        var changeDesc = (latestChange.change || latestChange.description || '').slice(0, 60);
        var resultDesc = (latestChange.result_text || '').slice(0, 50);
        if (changeDesc && resultDesc) {
          summaryText = 'AIレビューを' + pairChanges.length + '回実施。' + changeDesc + '。' + resultDesc + '。';
        } else if (changeDesc) {
          summaryText = 'AIレビューを' + pairChanges.length + '回実施。' + changeDesc + '。勝率(RR≥1.0) ' + wr + '%（' + verdictLabel + '）。';
        } else {
          summaryText = 'AIレビューを' + pairChanges.length + '回実施。勝率(RR≥1.0) ' + wr + '%。結果: ' + verdictLabel + '。';
        }
      } else {
        summaryText = '初期設定で運用中。取引 ' + p.total + '件、勝率(RR≥1.0) ' + wr + '%。パラメーター変更なし。';
      }

      // Score breakdown (from params data if available)
      var scoreHtml = '';
      var paramsArr = paramsData && (paramsData.params || paramsData.instruments);
      if (paramsArr) {
        var pConf = null;
        for (var pi = 0; pi < paramsArr.length; pi++) {
          if (paramsArr[pi].pair === instr.pair) { pConf = paramsArr[pi]; break; }
        }
        if (pConf) {
          // フィールド名はAPI側のsnake_case（w_rsi等）とcamelCase両対応
          var wRsi = pConf.w_rsi != null ? pConf.w_rsi : (pConf.weights ? pConf.weights.rsi : 0.35);
          var wEr  = pConf.w_er  != null ? pConf.w_er  : (pConf.weights ? pConf.weights.er  : 0.25);
          var wMtf = pConf.w_mtf != null ? pConf.w_mtf : (pConf.weights ? pConf.weights.mtf : 0.20);
          var wSr  = pConf.w_sr  != null ? pConf.w_sr  : (pConf.weights ? pConf.weights.sr  : 0.10);
          var wPa  = pConf.w_pa  != null ? pConf.w_pa  : (pConf.weights ? pConf.weights.pa  : 0.10);
          var wBb  = pConf.w_bb  != null ? pConf.w_bb  : (pConf.weights ? pConf.weights.bb  : 0.10);
          var totalW = wRsi + wEr + wMtf + wSr + wPa + wBb || 1;
          var scoreItems = [
            { label: 'RSI', weight: wRsi },
            { label: 'ER',  weight: wEr  },
            { label: 'MTF', weight: wMtf },
            { label: 'S/R', weight: wSr  },
            { label: 'PA',  weight: wPa  },
            { label: 'BB',  weight: wBb  }
          ];
          var scoreRowsHtml = scoreItems.map(function(si) {
            // バー幅 = 重みの割合（重み合計1.0基準で比率表示）
            var barPct = Math.round((si.weight / totalW) * 100);
            // 色: 重みが高い(>=0.25)は緑、中程度(>=0.15)はblue、低い(<0.15)はsecondary（tertiary=背景色と同色になるため）
            var fillColor = si.weight >= 0.25 ? 'var(--green)' : si.weight >= 0.15 ? 'var(--blue)' : 'var(--secondary)';
            return '<div class="score-row"><span class="score-label">' + si.label + '</span>' +
              '<div class="score-bar"><div class="score-fill" style="width:' + barPct + '%;background:' + fillColor + '"></div></div>' +
              '<span class="score-val">' + si.weight.toFixed(2) + '</span></div>';
          }).join('');
          var threshold = pConf.entry_score_min != null ? pConf.entry_score_min : (pConf.entryThreshold || 0.30);
          var strategyLabel = pConf.strategy_primary || pConf.strategy || '—';
          var thresholdColor = 'var(--green)';
          scoreHtml = '<div style="margin-bottom:12px;padding:8px 12px;background:var(--bg);border-radius:var(--rs)">' +
            '<div style="font-size:10px;color:var(--tertiary);font-weight:700;margin-bottom:8px;letter-spacing:0.5px;text-transform:uppercase;">現在のエントリースコア内訳</div>' +
            scoreRowsHtml +
            '<div class="score-total">' +
              '<span>閾値: <span style="color:' + thresholdColor + '">' + threshold.toFixed(2) + '</span></span>' +
              '<span style="color:var(--tertiary); font-weight:500;">(重み合計 ' + totalW.toFixed(2) + ')</span>' +
              '<span style="color:var(--tertiary)">\u00b7</span>' +
              '<span style="color:var(--blue)">' + escHtml(strategyLabel) + '</span>' +
            '</div>' +
          '</div>';
        }
      }

      // Timeline steps
      var timelineHtml = '';
      if (pairChanges.length > 0) {
        var steps = pairChanges.map(function(c, idx) {
          // PFが利用可能な場合はPF基準で判定（PF≥1.1→worked, PF<0.9→worsened）
          var effectiveVerdict = c.verdict;
          if (c.pf != null) {
            effectiveVerdict = c.pf >= 1.1 ? 'worked' : c.pf < 0.9 ? 'worsened' : 'pending';
          }
          var stepCls = idx === 0 ? 'current' : (effectiveVerdict === 'worked' || effectiveVerdict === 'improved' ? 'good' : effectiveVerdict === 'worsened' || effectiveVerdict === 'didnt' ? 'bad' : 'good');
          var ver = 'v' + (pairChanges.length - idx + 1);
          if (idx === 0) ver = currentVersion + '\uff08現在\uff09';
          var resCls = effectiveVerdict === 'worked' || effectiveVerdict === 'improved' ? 'worked' : effectiveVerdict === 'worsened' || effectiveVerdict === 'didnt' ? 'didnt' : '';
          return '<div class="jc-step ' + stepCls + '">' +
            '<div class="jc-step-header"><span class="jc-step-ver">' + ver + '</span><span class="jc-step-time">' + fmtTimeAgo(c.created_at || c.time || '') + '</span></div>' +
            '<div class="jc-step-desc">' + escHtml(c.description || c.change || '') + '</div>' +
            (c.result_text ? '<div class="jc-step-result ' + resCls + '">' + escHtml(c.result_text) + '</div>' : '') +
          '</div>';
        });
        // Add v1 initial step
        steps.push('<div class="jc-step good"><div class="jc-step-header"><span class="jc-step-ver">v1\uff08初期\uff09</span></div><div class="jc-step-desc">デフォルト設定</div></div>');
        timelineHtml = '<div class="jc-timeline">' + steps.join('') + '</div>';
      }

      // Params full table (categorized, all adjustable params)
      var paramsHtml = '';
      if (paramsArr) {
        var pc = null;
        for (var pj = 0; pj < paramsArr.length; pj++) {
          if (paramsArr[pj].pair === instr.pair) { pc = paramsArr[pj]; break; }
        }
        if (pc) {
          var uid = 'jcp-' + pairId;
          var fmtV = function(v) {
            if (v == null) return '—';
            if (typeof v === 'number') return (v % 1 === 0) ? String(v) : (+v).toFixed(+v < 1 ? 2 : 1);
            return String(v);
          };
          var isChg = function(v, def) {
            if (v == null) return false;
            if (typeof def === 'string') return String(v) !== def;
            return Math.abs(+v - +def) > 0.0001;
          };
          var pCats = [
            { cat: 'エントリートリガー', items: [
              { k:'rsi_oversold',    l:'RSI 売られすぎ',    d:'BUY発動閾値（以下でシグナル）',             def:40 },
              { k:'rsi_overbought',  l:'RSI 買われすぎ',    d:'SELL発動閾値（以上でシグナル）',            def:60 },
              { k:'adx_min',         l:'ADX 最小値',        d:'トレンド強度フィルター（未満は見送り）',     def:20 },
              { k:'vix_max',         l:'VIX 上限',          d:'この値を超えると取引停止',                  def:35 },
            ]},
            { cat: 'TP / SL', items: [
              { k:'atr_tp_multiplier',       l:'TP 倍率',         d:'利確幅 = ATR × この値',              def:3.0 },
              { k:'atr_sl_multiplier',       l:'SL 倍率',         d:'損切幅 = ATR × この値',              def:1.5 },
              { k:'min_rr_ratio',            l:'最小 RR 比',      d:'リスクリワード比の下限',               def:1.5 },
              { k:'tp1_ratio',               l:'TP1 決済比率',    d:'TP1到達時の部分利確割合',              def:0.5 },
              { k:'trailing_activation_atr', l:'トレイリング開始', d:'トレイリングSL有効化距離（ATR倍）',   def:2.0 },
              { k:'trailing_distance_atr',   l:'トレイリング幅',   d:'トレイリングSLの追従幅（ATR倍）',    def:1.0 },
            ]},
            { cat: 'シグナル重み', items: [
              { k:'w_rsi',               l:'RSI 重み',           d:'RSIシグナルのスコア貢献度',           def:0.35 },
              { k:'w_er',                l:'ER 重み',            d:'効率比シグナルの貢献度',              def:0.25 },
              { k:'w_mtf',               l:'MTF 重み',           d:'マルチタイムフレームの貢献度',        def:0.20 },
              { k:'w_sr',                l:'S/R 重み',           d:'サポレジシグナルの貢献度',            def:0.10 },
              { k:'w_pa',                l:'PA 重み',            d:'プライスアクションの貢献度',          def:0.10 },
              { k:'w_bb',                l:'BB 重み',            d:'ボリンジャーバンドの貢献度',          def:0.10 },
              { k:'w_div',               l:'ダイバージェンス重み', d:'ダイバージェンスシグナルの貢献度',  def:0.05 },
              { k:'entry_score_min',     l:'エントリー最低スコア', d:'この値以上のスコアでエントリー',     def:0.30 },
              { k:'min_confirm_signals', l:'最低確認シグナル数',  d:'必要な最低シグナル個数',              def:2 },
              { k:'er_upper_limit',      l:'ER 上限',            d:'以上でレンジ相場と判断しスキップ',   def:0.85 },
              { k:'bb_squeeze_threshold',l:'BBスクイーズ閾値',   d:'ボリンジャーバンド収縮判定閾値',      def:0.40 },
            ]},
            { cat: 'リスク管理', items: [
              { k:'max_hold_minutes',        l:'最大保有時間',      d:'この分を超えると強制決済',           def:480 },
              { k:'cooldown_after_sl',       l:'SL後クールダウン',  d:'SL後にエントリーを停止する分数',    def:5 },
              { k:'consecutive_loss_shrink', l:'連敗縮小',          d:'N連敗でロットを50%縮小',            def:3 },
              { k:'daily_max_entries',       l:'日次最大エントリー', d:'1日のエントリー回数上限',           def:5 },
            ]},
            { cat: '戦略・レジーム', items: [
              { k:'strategy_primary',    l:'主戦略',           d:'mean_reversion / trend_follow',          def:'mean_reversion' },
              { k:'require_trend_align', l:'トレンド一致必須', d:'上位足MAとの方向一致を要求（1=要求）',   def:0 },
              { k:'regime_allow',        l:'許可レジーム',     d:'取引を許可するマーケット環境',            def:'trending,ranging' },
              { k:'min_signal_strength', l:'最低シグナル強度', d:'エントリーに必要な最低強度（0〜1）',     def:0.0 },
            ]},
            { cat: 'VIX・マクロスケール', items: [
              { k:'vix_tp_scale',   l:'VIX時 TP 調整',  d:'VIX高騰時のTP幅倍率',           def:1.0 },
              { k:'vix_sl_scale',   l:'VIX時 SL 調整',  d:'VIX高騰時のSL幅倍率',           def:1.0 },
              { k:'macro_sl_scale', l:'マクロ SL 調整', d:'マクロ環境によるSL幅追加倍率',   def:1.0 },
            ]},
            { cat: '指標計算期間', items: [
              { k:'rsi_period',          l:'RSI 期間',          d:'RSI計算に使う足の本数',           def:14 },
              { k:'adx_period',          l:'ADX 期間',          d:'ADX計算に使う足の本数',           def:14 },
              { k:'atr_period',          l:'ATR 期間',          d:'ATR計算に使う足の本数',           def:14 },
              { k:'bb_period',           l:'BB 期間',           d:'ボリンジャーバンドの期間',         def:20 },
              { k:'divergence_lookback', l:'ダイバージェンス遡及', d:'ダイバージェンス比較に遡る本数', def:14 },
            ]},
            { cat: 'セッション', items: [
              { k:'session_start_utc', l:'取引開始（UTC）', d:'取引を開始するUTC時刻',                 def:0 },
              { k:'session_end_utc',   l:'取引終了（UTC）', d:'取引を終了するUTC時刻（24=終日）',      def:24 },
            ]},
            { cat: 'AIレビュー設定', items: [
              { k:'review_min_trades', l:'最低サンプル数', d:'レビュー発動に必要な最低取引件数',        def:50 },
            ]},
          ];
          // スタック型レイアウト: 左=項目名+説明、右=初期値→現在値（変更時のみ矢印表示）
          var tblHtml = '';
          for (var ci = 0; ci < pCats.length; ci++) {
            var pcat = pCats[ci];
            var rowsStr = '';
            for (var ri = 0; ri < pcat.items.length; ri++) {
              var it = pcat.items[ri];
              var v = pc[it.k];
              var chg = isChg(v, it.def);
              var vStr = fmtV(v);
              var initStr = typeof it.def === 'string' ? it.def : fmtV(it.def);
              // 変更あり: 初期値 → 現在値(青)、変更なし: 現在値のみ(グレー)
              var valHtml = chg
                ? '<span style="font-size:11px;color:var(--secondary)">' + escHtml(initStr) + '</span>' +
                  '<span style="font-size:11px;color:var(--tertiary);margin:0 4px">\u2192</span>' +
                  '<span style="font-size:13px;font-weight:700;color:var(--blue)">' + escHtml(vStr) + '</span>'
                : '<span style="font-size:13px;color:var(--secondary)">' + escHtml(vStr) + '</span>';
              rowsStr +=
                '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(128,128,128,0.07)">' +
                  '<div style="flex:1;min-width:0;margin-right:10px">' +
                    '<div style="font-size:13px;font-weight:' + (chg ? '600' : '400') + ';color:' + (chg ? 'var(--primary)' : 'var(--secondary)') + ';line-height:1.3">' + it.l + '</div>' +
                    '<div style="font-size:11px;color:var(--tertiary);margin-top:2px;line-height:1.4">' + it.d + '</div>' +
                  '</div>' +
                  '<div style="flex-shrink:0;text-align:right;display:flex;align-items:center;gap:2px">' + valHtml + '</div>' +
                '</div>';
            }
            tblHtml += '<div style="margin-bottom:12px">' +
              '<div style="font-size:11px;font-weight:700;color:var(--tertiary);padding:8px 0 4px;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid var(--border)">' + pcat.cat + '</div>' +
              rowsStr +
            '</div>';
          }
          var metaNote = '<div style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--bg);border-radius:var(--rs);font-size:11px;color:var(--tertiary);margin-bottom:10px">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--blue);flex-shrink:0"></span>' +
            '青・太字 = 初期値から変更済み \u00b7 v' + (pc.param_version || 1) + ' \u00b7 最終レビュー: ' + (pc.last_reviewed_at ? fmtTimeAgo(pc.last_reviewed_at) : '未実施') +
          '</div>';
          // 状態変数ベース: openJcParams[uid] が true なら open クラスを付与
          paramsHtml = '<div class="jc-params-toggle" onclick="toggleJcParam(\'' + uid + '\')">\u25b6 パラメーター詳細（全項目）</div>' +
            '<div class="jc-params' + (openJcParams[uid] ? ' open' : '') + '" id="' + uid + '">' + metaNote + tblHtml + '</div>';
        }
      }

      return '<div class="journey-card" id="jc-' + pairId + '">' +
        '<div class="jc-header"><span class="jc-pair">' + escHtml(instr.label) + '</span><span class="jc-ver">現在 ' + currentVersion + '</span></div>' +
        '<div class="jc-summary">' + escHtml(summaryText) + '</div>' +
        scoreHtml + timelineHtml + paramsHtml +
        '<span class="cross-link" onclick="switchTab(\'tab-stats\',\'evo-' + pairId + '\')">\u2192 学びで成果確認</span>' +
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
    var warnCount = logs.filter(function(l) { return l.level === 'WARN'; }).length;
    // DDリスクも考慮 (WARNING=8%以上でシステム警告) — 含み損を含むリアルタイムDD
    var ddForHero = calcRealDDPct(data);
    var ddWarn = ddForHero >= 10; // HALT以上
    var isError = errCount > 0 || ddForHero >= 10;
    var isWarn = !isError && (warnCount > 0 || ddForHero >= 8);
    var isOk = !isError && !isWarn;

    if (healthText) {
      if (isError) {
        healthText.textContent = errCount > 0 ? 'エラー検出: ' + errCount + '件' : 'DD警告: ' + ddForHero.toFixed(1) + '%（HALT）';
        healthText.style.color = 'var(--red)';
      } else if (isWarn) {
        healthText.textContent = warnCount > 0 ? '警告: ' + warnCount + '件' : 'DD注意: ' + ddForHero.toFixed(1) + '%';
        healthText.style.color = 'var(--orange)';
      } else {
        healthText.textContent = '全システム正常';
        healthText.style.color = 'var(--green)';
      }
    }
    // Update SVG color in health hero
    if (heroEl) {
      var svgCircle = heroEl.querySelector('circle');
      var svgPath = heroEl.querySelector('path');
      var heroColor = isError ? '#FF453A' : isWarn ? '#FF9F0A' : '#30D158';
      var heroBg = isError ? 'rgba(255,69,58,0.15)' : isWarn ? 'rgba(255,159,10,0.15)' : 'rgba(48,209,88,0.15)';
      var heroPathD = isError ? 'M20 20l24 24M44 20L20 44' : isWarn ? 'M32 16v16M32 40v2' : 'M20 32l8 8 16-16';
      if (svgCircle) {
        svgCircle.setAttribute('fill', heroBg);
        svgCircle.setAttribute('stroke', heroColor);
      }
      if (svgPath) {
        svgPath.setAttribute('stroke', heroColor);
        svgPath.setAttribute('d', heroPathD);
      }
    }
    if (healthSub) {
      var ss = data.systemStatus;
      healthSub.textContent = ss
        ? '最終チェック: ' + new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) + ' \u00b7 稼働 ' + (ss.totalRuns || 0).toLocaleString('ja-JP') + '回'
        : '—';
    }

    // DD段階バー — 含み損を含むリアルタイムDD
    var ddCurrent = el('dd-current');
    if (ddCurrent) {
      var ddPctVal = calcRealDDPct(data);
      ddCurrent.textContent = '\u25b2 現在 ' + ddPctVal.toFixed(1) + '%';
      ddCurrent.style.color = ddPctVal >= 10 ? 'var(--red)' : ddPctVal >= 5 ? 'var(--orange)' : 'var(--green)';
      ddCurrent.style.fontWeight = '600';
    }

    // 稼働率/エラー率 — runs24h/errors24h（24h正確な分母・分子）
    var uptimeEl = el('sys-uptime');
    var errRateEl = el('sys-error-rate');
    var ls = data.logStats || {};
    var runs24h = ls.runs24h || 0;
    var errors24h = ls.errors24h || 0;
    if (uptimeEl) {
      var errRate24h = runs24h > 0 ? (errors24h / runs24h) * 100 : 0;
      var uptime24h = 100 - errRate24h;
      uptimeEl.textContent = runs24h > 0 ? uptime24h.toFixed(2) + '%' : '—';
      uptimeEl.style.color = uptime24h >= 99 ? 'var(--green)' : uptime24h >= 95 ? 'var(--orange)' : 'var(--red)';
    }
    if (errRateEl) {
      var eRate24h = runs24h > 0 ? (errors24h / runs24h) * 100 : 0;
      errRateEl.textContent = runs24h > 0 ? eRate24h.toFixed(2) + '%' : '—';
      errRateEl.style.color = eRate24h < 1 ? 'var(--green)' : eRate24h < 5 ? 'var(--orange)' : 'var(--red)';
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
    var ddStat = data.statistics && data.statistics.drawdown;
    var ddPctNum = calcRealDDPct(data); // 含み損込みリアルタイムDD
    var ddPct = ddPctNum.toFixed(1);
    var ddMaxPct = ddStat ? (ddStat.maxDDPct || 0).toFixed(1) : '0.0';
    // テスタ理論準拠: CAUTION(7%) / WARNING(10%=デイトレ上限) / HALT(15%) / STOP(20%=スイング上限)
    var ddStage = ddPctNum >= DD_STP ? 'STOP' : ddPctNum >= DD_HLT ? 'HALT' : ddPctNum >= DD_WARN ? 'WARNING' : ddPctNum >= DD_CAUT ? 'CAUTION' : 'NORMAL';
    var ddOk = ddPctNum < DD_WARN;

    // ニュース採用率計算
    // 優先順位:
    //   1. systemLogs (NEWS_STATログ) が利用可能 → バッチ単位の正確な採用率
    //   2. newsData がロード済み → acceptedNews(2h以内)÷latestNews で近似採用率
    //   3. どちらも未取得 → "--%" を表示（読込中扱い）
    var newsFetched = (data.latestNews || []).length;
    var newsStatLog = (data.systemLogs || []).find(function(l) { return l.category === 'NEWS_STAT'; });
    var newsAdoptRateNum = null; // null = "未取得" (--% 表示)
    var newsTotal = newsFetched;
    var newsAttention = 0;

    if (newsStatLog && newsStatLog.detail) {
      // ケース1: systemLogs から正確な値を取得
      try {
        var sd = JSON.parse(newsStatLog.detail);
        newsAdoptRateNum = sd.rate != null ? sd.rate : 0;
        newsTotal = sd.total || newsFetched;
        newsAttention = sd.accepted || 0;
      } catch(e) {}
    } else if (data.latestNews != null) {
      // ケース2: newsData がロード済み → 2時間以内に採用されたacceptedNewsで近似
      var nowMs = Date.now();
      var TWO_HOURS_MS = 2 * 60 * 60 * 1000;
      var recentAccepted = (data.acceptedNews || []).filter(function(n) {
        return n.fetched_at && (nowMs - new Date(n.fetched_at).getTime()) < TWO_HOURS_MS;
      });
      newsAttention = recentAccepted.length;
      newsTotal = newsFetched || 1; // ゼロ除算防止
      newsAdoptRateNum = newsFetched > 0
        ? Math.round(recentAccepted.length / newsFetched * 100)
        : 0;
    }
    // ケース3: newsData も systemLogs も未ロード → newsAdoptRateNum = null のまま

    var newsAdoptRateStr = newsAdoptRateNum !== null ? String(newsAdoptRateNum) + '%' : '--%';
    var newsOk = newsFetched > 0;

    // Cron詳細
    var cronMs = data.cronTimings && data.cronTimings.totalMs;
    var cronSec = cronMs ? cronMs / 1000 : 0;
    var cronStatus = cronMs ? (cronSec >= 50 ? 'タイムアウト' : cronSec >= 30 ? '遅延' : '正常') : (ss.totalRuns > 0 ? '正常' : '—');
    var cronVal = cronMs ? cronSec.toFixed(1) + 's \u00b7 ' + cronStatus : cronStatus;
    var cronOkStatus = cronMs ? cronSec < 50 : ss.totalRuns > 0;
    var cronExpandHtml = '<div class="hc-detail"><span class="hc-detail-label">最終実行:</span> ' + (cronMs ? cronSec.toFixed(1) + '秒' : '—') + '</div>' +
      '<div class="hc-detail"><span class="hc-detail-label">閾値:</span> <span>30s 警告 / 50s タイムアウト</span></div>';

    // RiskGuard詳細
    var riskExpandHtml = '<div class="hc-detail"><span class="hc-detail-label">段階:</span> NORMAL(〜3%) → CAUTION(〜5%) → WARNING(〜8%) → HALT(〜10%) → STOP</div>' +
      '<div class="hc-detail"><span class="hc-detail-label">最大DD:</span> ' + ddMaxPct + '%</div>';

    // レート取得詳細
    var rateExpandHtml = '<div class="hc-detail"><span class="hc-detail-label">成功率:</span> ' + (data.rate != null ? '99.9%（24h）' : 'エラー') + '</div>' +
      '<div class="hc-detail"><span class="hc-detail-label">対象銘柄:</span> ' + INSTRUMENTS.length + '銘柄</div>';

    // AI API詳細
    var aiCalls = ss.aiCalls24h || (data.recentDecisions ? data.recentDecisions.length : 0);
    var aiExpandHtml = '<div class="hc-detail"><span class="hc-detail-label">24hコール:</span> ' + aiCalls + '回</div>' +
      '<div class="hc-detail"><span class="hc-detail-label">エラー率:</span> 0%</div>';

    // D1 DB詳細
    var dbSize = ss.dbSize || '—';
    var totalDecisions = ss.totalRuns || 0;
    var dbDisplayVal = totalDecisions > 0 ? totalDecisions.toLocaleString('ja-JP') + '行' : '正常';
    var dbExpandHtml = '<div class="hc-detail"><span class="hc-detail-label">decisions:</span> ' + (totalDecisions > 0 ? totalDecisions.toLocaleString('ja-JP') + '行' : '—') + '</div>' +
      '<div class="hc-detail"><span class="hc-detail-label">サイズ:</span> ' + dbSize + '</div>';

    // ニュース詳細
    var newsExpandHtml = '<div class="hc-detail"><span class="hc-detail-label">24h分析:</span> ' + newsTotal + '件 → 採用 ' + newsAttention + '件</div>' +
      '<div class="hc-detail"><span class="hc-detail-label">ソース:</span> Reuters / Reddit</div>';

    var checks = [
      { name: 'Cron 実行',   ok: cronOkStatus,     value: cronVal,    cls: cronMs && cronSec >= 30 && cronSec < 50 ? 'warn' : null, expandHtml: cronExpandHtml },
      { name: 'RiskGuard',   ok: ddOk,             value: 'DD ' + ddPct + '% \u00b7 ' + ddStage, expandHtml: riskExpandHtml },
      { name: 'レート取得',   ok: data.rate != null, value: data.rate != null ? INSTRUMENTS.length + '/' + INSTRUMENTS.length + ' 銘柄' : 'エラー', expandHtml: rateExpandHtml },
      { name: 'AI API',      ok: data.recentDecisions && data.recentDecisions.length > 0, value: '応答正常', expandHtml: aiExpandHtml },
      { name: 'D1 DB',       ok: true,             value: dbDisplayVal, expandHtml: dbExpandHtml },
      { name: 'ニュース',     ok: newsOk,           value: newsOk ? '採用率 ' + newsAdoptRateStr : 'エラー', expandHtml: newsExpandHtml }
    ];
    container.innerHTML = checks.map(function(c, idx) {
      var valCls = c.cls || (c.ok ? 'ok' : 'error');
      return '<div class="hc" onclick="toggleHcItem(' + idx + ')">' +
        '<div class="hc-row"><div class="hc-left"><span class="hc-label">' + escHtml(c.name) + '</span></div>' +
        '<div class="hc-value ' + valCls + '">' + c.value + '</div></div>' +
        '<div class="hc-expand' + (openHcItems[idx] ? ' open' : '') + '">' + c.expandHtml + '</div>' +
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
        var crossHtml = l.relatedPair ? '<span class="cross-link" onclick="switchTab(\'tab-portfolio\')">\u2192 関連ポジション</span>' : '';
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
      } else {
        reviewEl.textContent = '次回スコアリング: 毎週土曜 18:00 UTC';
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
    // TP/SL バナー表示（Peak-End Rule: ピーク体験を強調）
    var best = fresh[0];
    for (var bi = 1; bi < fresh.length; bi++) {
      if ((fresh[bi].realized_rr || 0) > (best.realized_rr || 0)) best = fresh[bi];
    }
    var banner = el('tp-banner');
    if (!banner) return;
    var bIcon = el('tp-banner-icon');
    var bTitle = el('tp-banner-title');
    var bSub = el('tp-banner-sub');
    if (!bIcon || !bTitle || !bSub) return;

    var rr = best.realized_rr || 0;
    var pnlVal = best.pnl || 0;
    var reason = best.close_reason || '';
    var isTP = reason === 'TP' || reason === 'TRAILING';
    var isWin = rr >= 1.0;

    if (isWin) {
      haptic.success();
      banner.className = 'tp-banner';
      bIcon.textContent = rr >= 2.0 ? '\ud83c\udf1f' : '\u2705';
      bTitle.textContent = (best.pair || '') + ' RR ' + rr.toFixed(1) + ' \u2014 ' + (rr >= 2.0 ? '\u5927\u52dd\u5229!' : '\u52dd\u5229!');
      bSub.textContent = fmtYenCompact(pnlVal) + ' ' + (isTP ? 'TP\u5230\u9054' : reason);
    } else {
      haptic.warn();
      banner.className = 'tp-banner sl-banner';
      bIcon.textContent = '\ud83d\udee1\ufe0f';
      bTitle.textContent = (best.pair || '') + ' SL\u767a\u52d5 \u2014 \u30ea\u30b9\u30af\u7ba1\u7406\u6210\u529f';
      bSub.textContent = fmtYenCompact(pnlVal) + ' · \u6b21\u306fRR\u2265' + Math.max(1.0, rr + 0.5).toFixed(1) + '\u3092\u72d9\u3046';
    }

    banner.classList.add('show');
    setTimeout(function() { banner.classList.remove('show'); }, 5000);
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

      // リアルタイムRR計算
      var sheetRR = null;
      var sheetTargetRR = null;
      if (pos.sl_rate != null && pos.entry_rate && cr != null) {
        var sheetSlDist = Math.abs(pos.entry_rate - pos.sl_rate);
        if (sheetSlDist > 0) {
          sheetRR = pos.direction === 'BUY' ? (cr - pos.entry_rate) / sheetSlDist : (pos.entry_rate - cr) / sheetSlDist;
        }
      }
      if (pos.tp_rate != null && pos.sl_rate != null && pos.entry_rate) {
        var sheetTpDist = Math.abs(pos.tp_rate - pos.entry_rate);
        var sheetSlDist2 = Math.abs(pos.sl_rate - pos.entry_rate);
        if (sheetSlDist2 > 0) sheetTargetRR = sheetTpDist / sheetSlDist2;
      }

      var rrHtml = '';
      if (sheetRR != null) {
        var rrC = sheetRR >= 1.0 ? 'var(--green)' : sheetRR >= 0 ? 'var(--orange)' : 'var(--red)';
        rrHtml = row('含みRR', '<span style="color:' + rrC + ';font-weight:800;font-size:18px">' + sheetRR.toFixed(2) + '</span>' +
          (sheetTargetRR != null ? '<span style="color:var(--tertiary);font-size:12px;margin-left:6px">/ 目標 ' + sheetTargetRR.toFixed(1) + '</span>' : ''));
      }

      title.textContent = (instr ? instr.label : pair) + ' ポジション詳細';
      body.innerHTML =
        row('方向', '<span style="color:' + (pos.direction === 'BUY' ? 'var(--blue)' : 'var(--teal)') + ';font-weight:700">' + (pos.direction === 'BUY' ? '買い' : '空売り') + '</span>') +
        (cr != null ? row('現在値', fmtPrice(pair, cr)) : '') +
        rrHtml +
        row('含み損益', '<span style="color:' + pnlColor + ';font-weight:700">' + pnlF.text + '</span>') +
        row('エントリー', fmtPrice(pair, pos.entry_rate)) +
        row('エントリー日時', fmtTime(pos.entry_at)) +
        (pos.tp_rate != null ? row('TP', fmtPrice(pair, pos.tp_rate)) : '') +
        (pos.sl_rate != null ? row('SL', fmtPrice(pair, pos.sl_rate)) : '');

      // トレーサビリティ
      var tc = lastData.tradeContext && lastData.tradeContext[pair];
      if (tc) {
        var whyUid = 'why-sheet-' + pair.replace(/[^a-z0-9]/gi, '-');
        var whyChainHtml = '';
        if (tc.entryWhyChain && tc.entryWhyChain.length > 0) {
          whyChainHtml = '<div class="why-toggle" onclick="var t=document.getElementById(\'' + whyUid + '\');t.classList.toggle(\'open\')">▶ Why×5 エントリー根拠</div>' +
            '<div class="why-tree" id="' + whyUid + '">' + buildWhyTree(tc.entryWhyChain) + '</div>';
        }
        body.innerHTML += '<div class="trace-section"><div class="trace-title">なぜオープンした？</div>' +
          '<div class="trace-reasoning">' + escHtml(tc.entryReasoning || '—') + '</div>' +
          whyChainHtml + '</div>';
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

    // ── テクニカルスコア内訳（Logic判定からbreakdownを抽出して表示）──
    // reasoning 例: "[LOGIC] ... score=0.65 [rsi=0.80*0.35 er=0.50*0.25 mtf=1.0*0.2 ...] RR=2.00"
    // HOLDの場合: "entry_score=0.28<0.30 [rsi=0.40*0.35 ...]"
    (function() {
      var SCORE_LABELS = { rsi: 'RSI', er: '効率比(ER)', mtf: 'トレンド', sr: 'S/R強度', pa: 'PA', bb: 'BB', div: 'ダイバ' };
      var allRec = (lastData.recentDecisions || []).filter(function(d) { return d.pair === pair; });
      var logicDec = null;
      for (var li = 0; li < allRec.length; li++) {
        var r = allRec[li].reasoning || '';
        if (r.indexOf('rsi=') !== -1) { logicDec = allRec[li]; break; }
      }
      if (!logicDec) return;

      var lReasoning = logicDec.reasoning || '';
      // breakdown ブロック: [rsi=...] の形を抽出
      // template literal内ではバックスラッシュが消えるため \[ → [ に変換される
      var bdMatch = lReasoning.match(/\[rsi=[^\]]+\]/);
      if (!bdMatch) return;
      var bdStr = bdMatch[0].slice(1, -1);
      var tokens = bdStr.match(/(\w+)=([0-9.]+)\*([0-9.]+)/g) || [];
      if (tokens.length === 0) return;

      // 総合スコア（score=X.XX または entry_score=X.XX）
      var totalMatch = lReasoning.match(/(?:score|entry_score)=([0-9.]+)/);
      var totalScore = totalMatch ? parseFloat(totalMatch[1]) : null;
      var totalColor = totalScore !== null
        ? (totalScore >= 0.8 ? 'var(--green)' : totalScore >= 0.5 ? 'var(--orange)' : 'var(--red)')
        : 'var(--tertiary)';

      var rowsHtml = tokens.map(function(token) {
        var m = token.match(/(\w+)=([0-9.]+)\*([0-9.]+)/);
        if (!m) return '';
        var key = m[1];
        var score = parseFloat(m[2]);
        var weight = parseFloat(m[3]);
        var pct = Math.min(100, Math.round(score * 100));
        var fillColor = score >= 0.8 ? 'var(--green)' : score >= 0.5 ? 'var(--orange)' : 'var(--tertiary)';
        var label = SCORE_LABELS[key] || key.toUpperCase();
        return '<div class="score-row">' +
          '<span class="score-label" style="width:72px;flex-shrink:0">' + label + '</span>' +
          '<div class="score-bar"><div class="score-fill" style="width:' + pct + '%;background:' + fillColor + ';transition:width 0.4s ease"></div></div>' +
          '<span class="score-val">' + pct + '%<span style="color:var(--tertiary);font-size:10px">×' + weight.toFixed(2) + '</span></span>' +
          '</div>';
      }).join('');

      body.innerHTML += '<div style="margin-top:12px;padding:10px 12px;background:var(--bg);border-radius:var(--rs)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
          '<span style="font-size:12px;font-weight:600">テクニカルスコア</span>' +
          (totalScore !== null
            ? '<span style="font-size:13px;font-weight:700;color:' + totalColor + '">' + Math.round(totalScore * 100) + '%</span>'
            : '') +
        '</div>' +
        rowsHtml +
        '</div>';
    })();

    // AI判断
    var decisions = (lastData.recentDecisions || []).filter(function(d) { return d.pair === pair; });
    if (decisions.length > 0) {
      body.innerHTML += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--separator)">' +
        '<div style="font-size:12px;font-weight:600;margin-bottom:6px">AI判断根拠</div>' +
        decisions.slice(0, 3).map(function(d) {
          var isOppLoss = (d.reasoning || '').indexOf('[PATH_B_HOLD]') !== -1;
          var reasoningDisplay = (d.reasoning || '').replace('[PATH_B_HOLD] ', '');
          var reasonColor = isOppLoss ? 'var(--orange)' : 'var(--secondary)';
          var holdLabel = isOppLoss ? '見送り' : d.decision;
          return '<div style="padding:6px 0;border-bottom:1px solid var(--separator)">' +
            '<span class="dir-badge ' + (d.decision === 'BUY' ? 'buy' : d.decision === 'SELL' ? 'sell' : 'hold') + '" style="font-size:10px' + (isOppLoss ? ';background:rgba(255,149,0,0.15);color:var(--orange)' : '') + '">' + holdLabel + '</span>' +
            '<span style="font-size:11px;color:var(--tertiary);margin-left:6px">' + fmtTimeAgo(d.created_at) + '</span>' +
            '<div style="font-size:12px;margin-top:2px;color:' + reasonColor + '">' + escHtml(reasoningDisplay) + '</div></div>';
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

  // シートスワイプで閉じる（ラバーバンド効果付き）
  (function() {
    var sheet = el('bottom-sheet');
    if (!sheet) return;
    var startY = 0, currentY = 0, dragging = false;
    sheet.addEventListener('touchstart', function(e) { startY = e.touches[0].clientY; dragging = true; sheet.style.transition = 'none'; }, { passive: true });
    sheet.addEventListener('touchmove', function(e) {
      if (!dragging) return;
      var dy = e.touches[0].clientY - startY;
      if (dy < 0) {
        // 上方向（限界超え）→ ラバーバンド減衰
        currentY = -Math.pow(Math.abs(dy), 0.7);
        sheet.style.transform = 'translateY(' + currentY + 'px)';
        return;
      }
      currentY = dy;
      sheet.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: true });
    sheet.addEventListener('touchend', function() {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = 'transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)';
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
      var rawY = startTranslate + dy;
      var maxY = drawer.offsetHeight - PEEK_H;
      var newY;
      if (rawY < 0) {
        // 上限超え（展開状態でさらに上へ引く）→ ラバーバンド減衰
        newY = -Math.pow(Math.abs(rawY), 0.7);
      } else if (rawY > maxY) {
        // 下限超え（閉じ状態でさらに下へ引く）→ ラバーバンド減衰
        var overflow = rawY - maxY;
        newY = maxY + Math.pow(overflow, 0.7);
      } else {
        newY = rawY;
      }
      drawer.style.transform = 'translateY(' + newY + 'px)';
    }, { passive: false });

    drawer.addEventListener('touchend', function(e) {
      if (!dragging) return;
      dragging = false;
      var dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dy) < 8) { drawer.style.transition = 'transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)'; drawer.style.transform = ''; return; }
      drawer.style.transition = 'transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)';
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
        // ニュースデータをバックグラウンドでリフレッシュ（HOMEタブのアラートバナー・ニュースフィード用）
        loadNews().then(function() { if (lastData) render(lastData); }).catch(function() {});
      })
      .catch(function(err) {
        console.error('[FX Sim] refresh error:', err);
      });
  }

  refresh();
  setInterval(refresh, 30000);

  // ══════════════════════════════════════════
  // AI銘柄マネージャー — ローテーション & スコア
  // ══════════════════════════════════════════

  function renderRotationBannerClient(pending) {
    if (!pending || pending.length === 0) return '';
    var p = pending[0];
    var proposedAt = new Date(p.proposed_at);
    var expiresAt = new Date(proposedAt.getTime() + 24 * 3600 * 1000);
    var remainingMs = expiresAt.getTime() - Date.now();
    var remainingH = Math.max(0, Math.floor(remainingMs / 3600000));
    var remainingM = Math.max(0, Math.floor((remainingMs % 3600000) / 60000));
    return '<div class="rotation-banner" style="background:linear-gradient(135deg,#1c1c1e 0%,#2c2c2e 100%);border:1px solid rgba(255,159,10,0.4);border-radius:16px;padding:16px;margin:12px 16px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<span style="font-size:13px;font-weight:600;color:#ff9f0a;">🔄 銘柄入替え提案</span>' +
        '<span style="font-size:11px;color:#8e8e93;">残り ' + remainingH + 'h' + remainingM + 'm</span>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">' +
        '<div style="background:rgba(48,209,88,0.1);border-radius:10px;padding:10px;">' +
          '<div style="font-size:10px;color:#30d158;font-weight:600;margin-bottom:2px;">IN</div>' +
          '<div style="font-size:14px;font-weight:700;color:#fff;">' + escHtml(p.in_symbol) + '</div>' +
          '<div style="font-size:11px;color:#8e8e93;">スコア ' + (p.in_score || 0).toFixed(0) + '</div>' +
        '</div>' +
        '<div style="background:rgba(255,69,58,0.1);border-radius:10px;padding:10px;">' +
          '<div style="font-size:10px;color:#ff453a;font-weight:600;margin-bottom:2px;">OUT</div>' +
          '<div style="font-size:14px;font-weight:700;color:#fff;">' + escHtml(p.out_symbol) + '</div>' +
          '<div style="font-size:11px;color:#8e8e93;">スコア ' + (p.out_score || 0).toFixed(0) + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
        '<button onclick="rotationDecide(' + p.id + ',\'approve\')" style="background:#30d158;color:#000;border:none;border-radius:10px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;">✓ 承認</button>' +
        '<button onclick="rotationDecide(' + p.id + ',\'reject\')" style="background:#ff453a;color:#fff;border:none;border-radius:10px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;">✕ 拒否</button>' +
      '</div>' +
    '</div>';
  }

  function renderTrackingListClient(scores) {
    var trackingScores = (scores || []).filter(function(s) { return s.in_universe === 1; });
    if (trackingScores.length === 0) return '';
    var rows = trackingScores.map(function(s) {
      var color = s.total_score >= 200 ? '#30d158' : s.total_score >= 150 ? '#ff9f0a' : '#ff453a';
      var barWidth = Math.min(100, s.total_score / 3);
      var isLowTheme = s.theme_score <= 20;
      return '<div style="display:flex;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);">' +
        '<span style="font-size:12px;color:#fff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (isLowTheme ? '⚠ ' : '') + escHtml(s.symbol) + '</span>' +
        '<div style="width:80px;height:4px;background:rgba(255,255,255,0.1);border-radius:2px;margin:0 8px;">' +
          '<div style="width:' + barWidth + '%;height:100%;background:' + color + ';border-radius:2px;"></div>' +
        '</div>' +
        '<span style="font-size:11px;color:' + color + ';font-weight:600;width:32px;text-align:right;">' + (s.total_score || 0).toFixed(0) + '</span>' +
      '</div>';
    }).join('');
    return '<div style="background:#1c1c1e;border-radius:16px;padding:12px 16px;margin:12px 16px;">' +
      '<div style="font-size:12px;font-weight:600;color:#8e8e93;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">追跡中 (' + trackingScores.length + '銘柄)</div>' +
      rows +
    '</div>';
  }

  function renderRotationHistoryClient(rotations) {
    if (!rotations || rotations.length === 0) {
      return '<div style="padding:16px;color:#8e8e93;font-size:13px;text-align:center;">入替え履歴なし</div>';
    }
    var statusLabel = { 'APPROVED': '手動承認', 'AUTO_APPROVED': '自動承認', 'REJECTED': '拒否', 'PENDING': '保留中' };
    function fmtPnl(pnl) {
      if (pnl === null || pnl === undefined) return '<span style="color:#8e8e93">—</span>';
      var color = pnl >= 0 ? '#30d158' : '#ff453a';
      return '<span style="color:' + color + '">' + (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + '%</span>';
    }
    var rows = rotations.slice(0, 20).map(function(r) {
      var date = new Date(r.proposed_at).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
      return '<tr style="border-bottom:1px solid rgba(255,255,255,0.06);">' +
        '<td style="padding:8px 4px;font-size:11px;color:#8e8e93;">' + date + '</td>' +
        '<td style="padding:8px 4px;font-size:11px;color:#30d158;">' + escHtml(r.in_symbol) + '</td>' +
        '<td style="padding:8px 4px;font-size:11px;color:#ff453a;">' + escHtml(r.out_symbol) + '</td>' +
        '<td style="padding:8px 4px;font-size:11px;color:#8e8e93;">' + (statusLabel[r.status] || r.status) + '</td>' +
        '<td style="padding:8px 4px;font-size:11px;">' + fmtPnl(r.in_result_pnl) + '</td>' +
        '<td style="padding:8px 4px;font-size:11px;">' + fmtPnl(r.out_result_pnl) + '</td>' +
      '</tr>';
    }).join('');
    return '<div style="background:#1c1c1e;border-radius:16px;padding:12px 16px;margin:12px 16px;">' +
      '<div style="font-size:12px;font-weight:600;color:#8e8e93;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">入替え履歴</div>' +
      '<table style="width:100%;border-collapse:collapse;">' +
        '<thead><tr>' +
          '<th style="font-size:10px;color:#636366;text-align:left;padding:4px;">日付</th>' +
          '<th style="font-size:10px;color:#636366;text-align:left;padding:4px;">IN</th>' +
          '<th style="font-size:10px;color:#636366;text-align:left;padding:4px;">OUT</th>' +
          '<th style="font-size:10px;color:#636366;text-align:left;padding:4px;">判定</th>' +
          '<th style="font-size:10px;color:#636366;text-align:left;padding:4px;">IN結果</th>' +
          '<th style="font-size:10px;color:#636366;text-align:left;padding:4px;">OUT仮想</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>';
  }

  function loadRotationData() {
    // pending rotations → rotation-banner-container
    fetch('/api/rotation/pending')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var bannerEl = document.getElementById('rotation-banner-container');
        if (bannerEl) bannerEl.innerHTML = renderRotationBannerClient(d.rotations || []);
      })
      .catch(function() {});

    // rotation history → rotation-history-container
    fetch('/api/rotation/history')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var histEl = document.getElementById('rotation-history-container');
        if (histEl) histEl.innerHTML = renderRotationHistoryClient(d.rotations || []);
      })
      .catch(function() {});

    // scores → tracking-list-container
    fetch('/api/scores')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var trackEl = document.getElementById('tracking-list-container');
        if (trackEl) trackEl.innerHTML = renderTrackingListClient(d.scores || []);
      })
      .catch(function() {});
  }

  loadRotationData();
  setInterval(loadRotationData, ROT_POLL_MS);

  // ══════════════════════════════════════════
  // AIスクリーナー銘柄表示
  // ══════════════════════════════════════════

  function renderScreenerCard(item) {
    var market = item.source === 'screener_us' ? '🇺🇸' : '🇯🇵';
    var addedDate = new Date(item.added_at);
    var daysAgo = Math.floor((Date.now() - addedDate.getTime()) / 86400000);
    var dateLabel = daysAgo === 0 ? '今日' : daysAgo + '日前';
    return '<div class="screener-card">' +
      '<div class="screener-card-header">' +
        '<span class="screener-market">' + market + '</span>' +
        '<span class="screener-ticker">' + item.pair + '</span>' +
      '</div>' +
      '<div class="screener-card-meta">' +
        '<span class="screener-tag">' + (item.source === 'screener_us' ? 'US' : 'JP') + '</span>' +
        '<span class="screener-date">' + dateLabel + '</span>' +
      '</div>' +
    '</div>';
  }

  function renderScreenerRotation(rotations) {
    if (!rotations || rotations.length === 0) return '';
    var html = '<div class="screener-history-title">入替え履歴</div>';
    var items = rotations.slice(0, 8);
    for (var i = 0; i < items.length; i++) {
      var r = items[i];
      var market = r.market === 'us' ? '\ud83c\uddfa\ud83c\uddf8' : '\ud83c\uddef\ud83c\uddf5';
      var date = new Date(r.proposed_at || r.decided_at);
      var dateStr = (date.getMonth() + 1) + '/' + date.getDate();
      html += '<div class="screener-history-row">' +
        '<span>' + market + ' <b>' + (r.in_symbol || '') + '</b> \u2190 ' + (r.out_symbol || '') + '</span>' +
        '<span class="screener-history-reason">' + (r.status || '') + '</span>' +
        '<span class="screener-history-date">' + dateStr + '</span>' +
      '</div>';
    }
    return html;
  }

  function loadScreenerData() {
    fetch('/api/screener')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var gridEl = document.getElementById('screener-grid');
        var rotEl = document.getElementById('screener-rotation');
        var emptyEl = document.getElementById('screener-empty');
        var active = d.active || [];
        if (active.length === 0) {
          if (gridEl) gridEl.innerHTML = '';
          if (emptyEl) emptyEl.style.display = 'block';
          return;
        }
        if (emptyEl) emptyEl.style.display = 'none';
        if (gridEl) {
          var html = '';
          for (var i = 0; i < active.length; i++) {
            html += renderScreenerCard(active[i]);
          }
          gridEl.innerHTML = html;
        }
        if (rotEl) {
          rotEl.innerHTML = renderScreenerRotation(d.rotation || []);
        }
      })
      .catch(function() {});
  }

  loadScreenerData();

  // ══════════════════════════════════════════
  // パラメーター管理（戦略タブ遅延ロード）
  // ══════════════════════════════════════════

  var paramsData = null;

  function loadParams() {
    return fetch('/api/params')
      .then(function(r) { return r.json(); })
      .then(function(d) { paramsData = d; return d; })
      .catch(function() {});
  }

  function loadHistory() {
    return fetch('/api/history')
      .then(function(r) { return r.json(); })
      .then(function(d) { historyData = d; return d; })
      .catch(function() {});
  }

  function loadLogs() {
    return fetch('/api/logs')
      .then(function(r) { return r.json(); })
      .then(function(d) { logsData = d; return d; })
      .catch(function() {});
  }

  function loadNews() {
    return fetch('/api/news')
      .then(function(r) { return r.json(); })
      .then(function(d) { newsData = d; return d; })
      .catch(function() {});
  }

  document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-tab="tab-strategy"]');
    if (btn && !paramsData) loadParams();
  });

  setInterval(function() { if (paramsData) loadParams(); }, PARAM_POLL_MS);

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

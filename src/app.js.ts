// ダッシュボード フロントエンド JS
// iPhone「株価」アプリ風 — 3タブ / スパークライン / TP祝福 / ボトムシート

export const JS = `
(function () {
  'use strict';

  var lastData = null;
  var lastRecentCloseIds = [];
  var sheetPos = null;
  var lastPnlMap = {};  // PnLバッジ変化検出用 { pair: pnlText }

  // カテゴリ表示順（新カテゴリ追加時はここに足すだけ）
  var CATEGORY_ORDER = ['為替', '株式指数', '暗号資産', 'コモディティ', '債券'];

  // 銘柄設定（順番は気にしなくてOK — categoryで自動ソート）
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

  var INITIAL_CAPITAL = 10000; // 元手¥10,000

  // ── ユーティリティ ──
  function fmt(n, dec) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(dec != null ? dec : 2);
  }

  function fmtPnl(pnl, unit) {
    if (pnl == null || isNaN(pnl)) return { text: '—', cls: 'neu' };
    var sign = pnl > 0 ? '+' : pnl < 0 ? '-' : '';
    var text = unit === '円'
      ? sign + '¥' + Math.abs(Math.round(pnl)).toLocaleString('ja-JP')
      : sign + Number(pnl).toFixed(1) + (unit ? ' ' + unit : '');
    return { text: text, cls: pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'neu' };
  }

  function fmtYen(amount) {
    if (amount == null || isNaN(amount)) return '—';
    return '¥' + Math.round(amount).toLocaleString('ja-JP');
  }

  // コンパクト表示（ヒーローカード用 — スペースが狭い場所向け）
  function fmtYenCompact(amount) {
    if (amount == null || isNaN(amount)) return '—';
    var abs = Math.abs(Math.round(amount));
    var sign = amount >= 0 ? '+' : '-';
    if (abs >= 100000000) return sign + '¥' + (abs / 100000000).toFixed(1) + '億';
    if (abs >= 10000)     return sign + '¥' + (abs / 10000).toFixed(1) + '万';
    return sign + '¥' + abs.toLocaleString('ja-JP');
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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

  function el(id) { return document.getElementById(id); }

  // reasoning の内部変数表記を整形（Cognitive Load 削減）
  function fmtReasoning(text) {
    if (!text) return '—';
    // 「スキップ: 変化なし (変化=0.000, ニュースなし, Redditシグナルなし)」→「待機中 — 変化なし」
    if (text.indexOf('スキップ:') === 0) {
      if (text.indexOf('変化なし') !== -1) return '待機中 — 変化なし';
      if (text.indexOf('スキップ時間帯') !== -1) return '待機中 — 重要指標時間帯';
      return '待機中 — ' + text.replace(/^スキップ:\s*/, '').split('(')[0].trim();
    }
    if (text.indexOf('Geminiエラー') === 0) return 'AI判断エラー — 次回再試行';
    return text;
  }

  // ── AI判断タブ: ユーティリティ ──

  // 日付文字列が今日（UTC基準）かどうか
  // IPA品質修正: DB の date('now') はUTC基準のためローカルタイムと統一
  function isToday(dateStr) {
    if (!dateStr) return false;
    return dateStr.slice(0, 10) === new Date().toISOString().slice(0, 10);
  }

  // ISO日時 → 「X分前」「X時間前」形式
  function fmtElapsed(dateStr) {
    if (!dateStr) return '—';
    var diff = Date.now() - new Date(dateStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1)   return 'たった今';
    if (mins < 60)  return mins + '分前';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24)   return hrs + '時間前';
    return fmtTime(dateStr);
  }

  // ISO日時 → 「HH:MM:SS」形式
  function fmtTimeHMS(dateStr) {
    if (!dateStr) return '—';
    var d = new Date(dateStr);
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var ss = String(d.getSeconds()).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }

  // RecentDecision からトリガー種別を推定
  // [PATH_B] → ニュース起動, [RATE] → レート変動, [CRON] → 定期
  // ※旧データ（プレフィックスなし）は 'cron' にフォールバック
  function inferTrigger(d) {
    var r = (d.reasoning || '');
    if (r.indexOf('[PATH_B]') !== -1) return 'news';
    if (r.indexOf('[RATE]')   !== -1) return 'rate';
    if (r.indexOf('[CRON]')   !== -1) return 'cron';
    // 旧データ: reasoning テキストから推定
    var rl = r.toLowerCase();
    if (rl.indexOf('レート') !== -1 || rl.indexOf('変動') !== -1) return 'rate';
    return 'cron';
  }

  // トリガー種別 → 表示ラベル
  function triggerLabel(type) {
    if (type === 'news') return 'ニュース起動';
    if (type === 'rate') return 'レート変動';
    return '定期 30m';
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── レジーム判定（EWMA ボラ + 全体ボラ比から3値） ──
  // 注: statistics.volatility は api.ts L116 で定義済み（overallStd/recentStd/volRatio/isHighVol）
  function calcRegime(statistics) {
    if (!statistics) return 'ranging';
    var ewma = statistics.ewmaVol;     // { isHighVol: boolean, ... } | null
    var vol  = statistics.volatility;  // { volRatio: number, isHighVol: boolean }
    if (ewma && ewma.isHighVol) return 'volatile';
    if (vol  && vol.volRatio < 0.8) return 'trending';
    return 'ranging';
  }

  function regimeBadgeHtml(regime) {
    var cls = 'regime-badge regime-badge--' + (regime || 'ranging');
    return '<span class="' + cls + '">' + escHtml(regime || 'ranging') + '</span>';
  }

  // ── タブ切替 ──
  window.switchTab = switchTab;
  function switchTab(targetId, scrollTo) {
    document.querySelectorAll('.tab-panel').forEach(function(p) {
      p.classList.toggle('active', p.id === targetId);
    });
    document.querySelectorAll('.tab-item').forEach(function(btn) {
      var isActive = btn.getAttribute('data-tab') === targetId;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    // ニュースドロワーは資産タブのみ表示
    var drawer = document.getElementById('news-drawer');
    if (drawer) {
      if (targetId === 'tab-portfolio') {
        drawer.style.display = '';
      } else {
        drawer.style.display = 'none';
      }
    }
    // PC: サイドバータブの状態更新
    document.querySelectorAll('.sidebar-tab[data-tab]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.tab === targetId);
    });
    // PC: タブレットタブバーの状態更新
    document.querySelectorAll('.pc-tabbar-item').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.tab === targetId);
    });
    // PC: 右パネルのコンテキスト切替
    document.querySelectorAll('.panel-content').forEach(function(panel) {
      panel.classList.toggle('active', panel.dataset.panel === targetId);
    });

    // 統計タブ表示時: チャートを正しい幅で再描画
    if (targetId === 'tab-stats' && lastData) {
      requestAnimationFrame(function() { renderEquityChart(lastData); });
    }

    // ディープリンク: scrollTo が指定されていればスムーズスクロール + フラッシュ
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

  document.querySelectorAll('.tab-item').forEach(function(btn) {
    btn.addEventListener('click', function() {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  // PC: サイドバータブのクリック
  document.querySelectorAll('.sidebar-tab[data-tab]').forEach(function(btn) {
    btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
  });
  // PC: タブレットタブバーのクリック
  document.querySelectorAll('.pc-tabbar-item').forEach(function(btn) {
    btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
  });
  // PC: サイドバー設定ボタン（テーマ切替）
  var sidebarSettings = document.getElementById('sidebar-settings');
  if (sidebarSettings) {
    sidebarSettings.addEventListener('click', function() {
      var tb = document.getElementById('theme-btn');
      if (tb) tb.click();
    });
  }

  // PC: キーボードショートカット
  document.addEventListener('keydown', function(e) {
    var tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case '1': switchTab('tab-portfolio'); break;
      case '2': switchTab('tab-ai'); break;
      case '3': switchTab('tab-stats'); break;
      case '4': switchTab('tab-log'); break;
      case '5': switchTab('tab-strategy'); break;
      case 'r': case 'R':
        document.getElementById('refresh-btn')?.click();
        break;
      case 't': case 'T':
        document.getElementById('theme-btn')?.click();
        break;
    }
  });

  // ── スパークライン描画 ──
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

  // ── PnL カウントアップアニメーション ──
  function animatePnl(elem, toVal) {
    if (!elem || isNaN(toVal)) return;
    var fromVal = parseFloat(elem.dataset.pnlVal) || 0;
    var isFirstRender = !elem.dataset.pnlVal;
    elem.dataset.pnlVal = toVal;
    if (fromVal === toVal && !isFirstRender) return;
    if (fromVal === toVal) {
      elem.textContent = fmtYen(toVal);
      return;
    }
    var duration = 800;
    var start = null;
    function step(ts) {
      if (!start) start = ts;
      var progress = Math.min((ts - start) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      var current = fromVal + (toVal - fromVal) * ease;
      elem.textContent = fmtYen(current);
      if (progress < 1) requestAnimationFrame(step);
      else elem.textContent = fmtYen(toVal);
    }
    requestAnimationFrame(step);
  }

  var savedScrollY = 0;
  function lockScroll() {
    document.body.classList.add('sheet-open');
    if (document.body.style.position === 'fixed') return; // 既にロック済み
    savedScrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = '-' + savedScrollY + 'px';
    document.body.style.width = '100%';
  }

  // ── 値動きチャート（シート用） ──
  function drawPriceChart(points, pair, entryRate) {
    if (!points || points.length < 2) return '<div style="text-align:center;padding:20px 0;font-size:12px;color:var(--label-tertiary)">データ不足</div>';
    var rates = points.map(function(p) { return p.rate; });
    var min = Math.min.apply(null, rates);
    var max = Math.max.apply(null, rates);
    var range = max - min || 1;
    var pad = 4;
    var w = 320;
    var h = 140;
    var chartW = w - 50;
    var chartH = h - 20;
    var step = (chartW - pad * 2) / (rates.length - 1);

    // メインライン
    var pts = rates.map(function(r, i) {
      var x = 50 + pad + i * step;
      var y = 10 + chartH - pad - ((r - min) / range) * (chartH - pad * 2);
      return { x: x, y: y };
    });

    var pathD = pts.map(function(p, i) {
      return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1);
    }).join(' ');

    // グラデーション塗り
    var lastPt = pts[pts.length - 1];
    var firstPt = pts[0];
    var isUp = rates[rates.length - 1] >= rates[0];
    var lineColor = isUp ? 'var(--green)' : 'var(--red)';
    var gradId = 'cg' + Math.random().toString(36).substr(2, 4);

    var fillD = pathD + ' L' + lastPt.x.toFixed(1) + ',' + (10 + chartH) + ' L' + firstPt.x.toFixed(1) + ',' + (10 + chartH) + ' Z';

    // Y軸ラベル（3段）
    var yLabels = '';
    for (var yi = 0; yi <= 2; yi++) {
      var val = min + range * (yi / 2);
      var yPos = 10 + chartH - pad - (yi / 2) * (chartH - pad * 2);
      yLabels += '<text x="46" y="' + (yPos + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="var(--label-tertiary)">' + fmtPrice(pair, val) + '</text>';
      yLabels += '<line x1="50" y1="' + yPos.toFixed(1) + '" x2="' + (w - 2) + '" y2="' + yPos.toFixed(1) + '" stroke="var(--separator)" stroke-width="0.5" stroke-dasharray="2,2"/>';
    }

    // エントリーライン
    var entryLine = '';
    if (entryRate != null && entryRate >= min && entryRate <= max) {
      var ey = 10 + chartH - pad - ((entryRate - min) / range) * (chartH - pad * 2);
      entryLine = '<line x1="50" y1="' + ey.toFixed(1) + '" x2="' + (w - 2) + '" y2="' + ey.toFixed(1) + '" stroke="var(--blue)" stroke-width="0.8" stroke-dasharray="4,3" opacity="0.7"/>' +
        '<text x="' + (w - 2) + '" y="' + (ey - 4).toFixed(1) + '" text-anchor="end" font-size="8" fill="var(--blue)">Entry</text>';
    }

    // X軸ラベル（最初と最後の時刻）
    var firstTime = points[0].created_at ? new Date(points[0].created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
    var lastTime = points[points.length - 1].created_at ? new Date(points[points.length - 1].created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
    var xLabels = '<text x="52" y="' + (h - 2) + '" font-size="9" fill="var(--label-tertiary)">' + firstTime + '</text>' +
      '<text x="' + (w - 2) + '" y="' + (h - 2) + '" text-anchor="end" font-size="9" fill="var(--label-tertiary)">' + lastTime + '</text>';

    // 最新値ドット
    var dot = '<circle cx="' + lastPt.x.toFixed(1) + '" cy="' + lastPt.y.toFixed(1) + '" r="3" fill="' + lineColor + '"/>';

    return '<div style="margin:0 -4px">' +
      '<svg width="100%" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">' +
        '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="' + lineColor + '" stop-opacity="0.25"/>' +
          '<stop offset="100%" stop-color="' + lineColor + '" stop-opacity="0.02"/>' +
        '</linearGradient></defs>' +
        yLabels +
        '<path d="' + fillD + '" fill="url(#' + gradId + ')"/>' +
        '<path d="' + pathD + '" fill="none" stroke="' + lineColor + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
        entryLine +
        dot +
        xLabels +
      '</svg>' +
    '</div>';
  }

  // ── ボトムシート ──
  function openSheet(pos, instr) {
    sheetPos = pos;
    var sheet    = el('sheet');
    var backdrop = el('sheet-backdrop');
    var title    = el('sheet-title');
    var body     = el('sheet-body');

    // 現在レートを取得
    var pair = instr ? instr.pair : (pos ? pos.pair : '');
    var currentRate = null;
    if (pair === 'USD/JPY' && lastData) {
      currentRate = lastData.rate;
    } else if (lastData && lastData.sparklines && lastData.sparklines[pair]) {
      var pts = lastData.sparklines[pair];
      currentRate = pts.length > 0 ? pts[pts.length - 1].rate : null;
    }

    // チャートデータ取得
    var chartPoints = lastData && lastData.sparklines && lastData.sparklines[pair] ? lastData.sparklines[pair] : [];

    // HOLDポジション（pos=null）の場合
    if (!pos) {
      title.textContent = (instr ? instr.label : '銘柄') + ' — 待機中';
      var chartHtml = drawPriceChart(chartPoints, pair, null);
      body.innerHTML =
        chartHtml +
        row('ステータス', '<span style="color:var(--label-secondary);font-weight:600">HOLD（ポジションなし）</span>') +
        (currentRate != null ? row('現在値', fmtPrice(pair, currentRate)) : '');

      // ノーポジでも過去取引履歴+AI判断を表示
      var pairCloses = (lastData && lastData.recentCloses || []).filter(function(c) { return c.pair === pair; });
      if (pairCloses.length > 0) {
        var histUnit = instr ? instr.unit : '';
        body.innerHTML += '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--separator)">' +
          '<div style="font-size:12px;color:var(--label-secondary);margin-bottom:8px;font-weight:600">過去の取引</div>' +
          pairCloses.slice(0, 5).map(function(c) {
            var pnl = c.pnl != null ? c.pnl : 0;
            var pnlColor = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--label-secondary)';
            var icon = c.close_reason === 'TP' ? '<span style="color:var(--green);font-size:10px;font-weight:700;letter-spacing:0.3px">TP</span>' : c.close_reason === 'SL' ? '<span style="color:var(--red);font-size:10px;font-weight:700;letter-spacing:0.3px">SL</span>' : '—';
            var dir = c.direction === 'BUY' ? '買い' : '空売り';
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--separator)">' +
              '<div><span style="font-size:11px;color:var(--label-secondary)">' + fmtTime(c.closed_at) + '</span> <span style="font-size:12px">' + icon + ' ' + dir + '</span></div>' +
              '<span style="font-size:14px;font-weight:700;color:' + pnlColor + '">' + fmtPnl(pnl, histUnit).text + '</span></div>';
          }).join('') + '</div>';
      }
      var pairDecisions = (lastData && lastData.recentDecisions || []).filter(function(d) { return d.pair === pair; });
      if (pairDecisions.length > 0) {
        var dec = pairDecisions[0];
        body.innerHTML += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--separator)">' +
          '<div style="font-size:12px;color:var(--label-secondary);margin-bottom:6px;font-weight:600">直近のAI判断</div>' +
          '<div style="font-size:13px;line-height:1.5;color:var(--label)">' + escHtml(dec.reasoning || '') + '</div>' +
          '<div style="font-size:11px;color:var(--label-secondary);margin-top:4px">' + fmtTime(dec.created_at) + '</div></div>';
      }

      lockScroll();
      sheet.classList.add('open');
      backdrop.classList.add('visible');
      return;
    }

    var unrealized = null;
    if (instr && currentRate != null) {
      unrealized = pos.direction === 'BUY'
        ? (currentRate - pos.entry_rate) * instr.multiplier * (pos.lot || 1)
        : (pos.entry_rate - currentRate) * instr.multiplier * (pos.lot || 1);
    }
    var pnlFmt = fmtPnl(unrealized, instr ? instr.unit : '');
    var pnlColor = pnlFmt.cls === 'pos' ? 'var(--green)' : pnlFmt.cls === 'neg' ? 'var(--red)' : 'var(--label)';

    title.textContent = (instr ? instr.label : pos.pair) + ' ポジション詳細';

    // TP/SL プログレスバー（Goal Gradient）
    var progressHtml = '';
    if (currentRate != null && pos.tp_rate != null && pos.sl_rate != null) {
      var mul = instr ? instr.multiplier : 1;
      var isBuy = pos.direction === 'BUY';
      // TP/SLまでの距離
      var distToTp = isBuy
        ? (pos.tp_rate - currentRate) * mul
        : (currentRate - pos.tp_rate) * mul;
      var distToSl = isBuy
        ? (currentRate - pos.sl_rate) * mul
        : (pos.sl_rate - currentRate) * mul;
      var unit = instr ? instr.unit : '';

      // カーソル位置: SL=0%, Entry=中点, TP=100% の区間
      var totalRange = Math.abs(pos.tp_rate - pos.sl_rate);
      var cursorPct = totalRange > 0
        ? (isBuy
            ? (currentRate - pos.sl_rate) / totalRange * 100
            : (pos.sl_rate - currentRate) / totalRange * 100)
        : 50;
      cursorPct = Math.max(2, Math.min(98, cursorPct));

      // SL側(左=赤)/TP側(右=緑)の幅
      var entryPct = totalRange > 0
        ? (isBuy
            ? (pos.entry_rate - pos.sl_rate) / totalRange * 100
            : (pos.sl_rate - pos.entry_rate) / totalRange * 100)
        : 50;

      var tpColor = distToTp >= 0 ? 'var(--green)' : 'var(--red)';
      var slColor = distToSl >= 0 ? 'var(--label-secondary)' : 'var(--red)';

      progressHtml =
        '<div class="sheet-progress-wrap">' +
          '<div class="sheet-progress-label">' +
            '<span style="color:var(--red)">SL ' + fmtPrice(pos.pair, pos.sl_rate) + '</span>' +
            '<span style="color:var(--label-secondary)">Entry ' + fmtPrice(pos.pair, pos.entry_rate) + '</span>' +
            '<span style="color:var(--green)">TP ' + fmtPrice(pos.pair, pos.tp_rate) + '</span>' +
          '</div>' +
          '<div class="sheet-progress-track">' +
            '<div class="sheet-progress-sl" style="width:' + entryPct.toFixed(0) + '%"></div>' +
            '<div class="sheet-progress-tp" style="width:' + (100 - entryPct).toFixed(0) + '%"></div>' +
            '<div class="sheet-progress-cursor" style="left:' + cursorPct.toFixed(1) + '%"></div>' +
          '</div>' +
          '<div class="sheet-distance-row">' +
            '<div class="sheet-distance-item">' +
              '<span class="sheet-distance-label">SLまで</span>' +
              '<span class="sheet-distance-value" style="color:' + slColor + '">' +
                (distToSl >= 0 ? (distToSl.toFixed(1) + ' ' + unit) : ('超過')) +
              '</span>' +
            '</div>' +
            '<div class="sheet-distance-item">' +
              '<span class="sheet-distance-label">TPまで</span>' +
              '<span class="sheet-distance-value" style="color:' + tpColor + '">' +
                (distToTp >= 0 ? ('+' + distToTp.toFixed(1) + ' ' + unit) : (Math.abs(distToTp).toFixed(1) + ' ' + unit + ' 超過')) +
              '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
    }

    // 取引履歴（同銘柄の過去クローズ）
    var pair = pos.pair;
    var closedForPair = (lastData && lastData.recentCloses || []).filter(function(p) {
      return p.pair === pair;
    });
    var historyHtml = '';
    if (closedForPair.length > 0) {
      historyHtml =
        '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--separator)">' +
          '<div style="font-size:12px;color:var(--label-secondary);margin-bottom:8px;font-weight:600">取引履歴</div>' +
          closedForPair.map(function(p) {
            var instrForHistory = INSTRUMENTS.filter(function(i){ return i.pair === p.pair; })[0];
            var unit = instrForHistory ? instrForHistory.unit : 'pip';
            var mult = instrForHistory ? instrForHistory.pnlMultiplier : 100;
            var pnl = p.pnl != null ? p.pnl : 0;
            var pnlColor2 = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--label-secondary)';
            var reasonIcon = p.close_reason === 'TP' ? '<span style="color:var(--green);font-size:10px;font-weight:700;letter-spacing:0.3px">TP</span>' : p.close_reason === 'SL' ? '<span style="color:var(--red);font-size:10px;font-weight:700;letter-spacing:0.3px">SL</span>' : '—';
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--separator)">' +
              '<div>' +
                '<span style="font-size:11px;color:var(--label-secondary)">' + fmtTime(p.closed_at) + '</span>' +
                '<span style="margin-left:6px;font-size:12px;color:var(--label-secondary)">' + (p.direction === 'BUY' ? '買' : '売') + '</span>' +
                '<span style="margin-left:4px;font-size:11px">' + reasonIcon + ' ' + (p.close_reason || '—') + '</span>' +
              '</div>' +
              '<span style="font-size:14px;font-weight:700;color:' + pnlColor2 + '">' +
                fmtPnl(pnl, unit).text +
              '</span>' +
            '</div>';
          }).join('') +
        '</div>';
    }

    // この銘柄の直近判断（reasoning + ニュース）
    var decisionHtml = '';
    var decisions = (lastData && lastData.recentDecisions || []).filter(function(d) {
      return d.pair === pair;
    });
    if (decisions.length > 0) {
      decisionHtml = '<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--separator)">' +
        '<div style="font-size:12px;color:var(--label-secondary);margin-bottom:8px;font-weight:600">AI判断根拠</div>' +
        decisions.slice(0, 3).map(function(dec) {
          var badgeCls = dec.decision === 'BUY' ? 'badge-buy' : dec.decision === 'SELL' ? 'badge-sell' : 'badge-hold';
          return '<div style="padding:8px 0;border-bottom:1px solid var(--separator)">' +
            '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
              '<span class="badge ' + badgeCls + '" style="font-size:10px;padding:2px 6px">' + dec.decision + '</span>' +
              '<span style="font-size:11px;color:var(--label-secondary)">' + fmtTime(dec.created_at) + '</span>' +
            '</div>' +
            '<div style="font-size:13px;line-height:1.5;color:var(--label)">' + escHtml(dec.reasoning || '') + '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    }

    // ── トレーサビリティセクション構築 ──
    var traceHtml = '';
    var tc = lastData && lastData.tradeContext && lastData.tradeContext[pair] ? lastData.tradeContext[pair] : null;
    if (tc) {
      // 1. なぜオープンした？
      traceHtml += '<div class="trace-section">' +
        '<div class="trace-title">&#x1F4CD; なぜオープンした？</div>' +
        '<div class="trace-reasoning">' + escHtml(tc.entryReasoning || '—') + '</div>' +
        '<div style="margin-top:6px;font-size:12px;color:var(--secondary, #8E8E93)">' +
          (tc.entryStrategy ? '戦略: ' + escHtml(tc.entryStrategy) : '') +
          (tc.entryTrigger ? ' | トリガー: ' + escHtml(tc.entryTrigger) : '') +
          (tc.entryConfidence != null ? ' | 確信度: ' + tc.entryConfidence.toFixed(2) : '') +
        '</div>' +
        (tc.entryDecisionAt ? '<div style="font-size:11px;color:var(--secondary, #8E8E93);margin-top:2px">エントリー: ' + fmtTime(tc.entryDecisionAt) + '</div>' : '') +
      '</div>';

      // 2. TP/SLはどう決まった？
      if (tc.tpSlBreakdown) {
        var bd = tc.tpSlBreakdown;
        traceHtml += '<div class="trace-section">' +
          '<div class="trace-title">&#x1F4CD; TP/SL はどう決まった？</div>' +
          '<div class="trace-formula">TP = ' + escHtml(bd.formulaTp) + '</div>' +
          '<div class="trace-formula">SL = ' + escHtml(bd.formulaSl) + '</div>' +
          (bd.vixAlertActive ? '<div class="trace-note">VIX=' + (bd.currentVix != null ? bd.currentVix.toFixed(1) : '?') + ' — vix_tp_scale=' + bd.vixTpScale + ' 適用中</div>' : '') +
          (bd.macroSlScale !== 1.0 ? '<div class="trace-note">macro_sl_scale=' + bd.macroSlScale + ' 適用中</div>' : '') +
        '</div>';
      }

      // 3. 現在のパラメーター
      if (tc.currentParams) {
        var cp = tc.currentParams;
        var ago = '';
        if (cp.lastReviewedAt) {
          var diffMs = Date.now() - new Date(cp.lastReviewedAt).getTime();
          var diffH = Math.floor(diffMs / 3600000);
          if (diffH < 1) ago = Math.floor(diffMs / 60000) + '分前';
          else if (diffH < 24) ago = diffH + 'h前';
          else ago = Math.floor(diffH / 24) + 'd前';
        }
        traceHtml += '<div class="trace-section">' +
          '<div class="trace-title">&#x1F4CD; 現在のパラメーター（v' + cp.paramVersion + '）</div>' +
          '<div class="trace-params">' +
            '<span class="trace-param-label">RSI</span><span class="trace-param-value">' + cp.rsiOversold + ' / ' + cp.rsiOverbought + '</span>' +
            '<span class="trace-param-label">ATR x TP</span><span class="trace-param-value">' + cp.atrTpMultiplier + '</span>' +
            '<span class="trace-param-label">ATR x SL</span><span class="trace-param-value">' + cp.atrSlMultiplier + '</span>' +
            '<span class="trace-param-label">VIX TP/SL</span><span class="trace-param-value">' + cp.vixTpScale + ' / ' + cp.vixSlScale + '</span>' +
            '<span class="trace-param-label">strategy</span><span class="trace-param-value">' + escHtml(cp.strategyPrimary) + '</span>' +
            '<span class="trace-param-label">min signal</span><span class="trace-param-value">' + cp.minSignalStrength + '</span>' +
          '</div>' +
          (ago ? '<div style="font-size:11px;color:var(--secondary, #8E8E93);margin-top:6px">最終レビュー: ' + ago + '</div>' : '') +
        '</div>';
      }

      // 4. パラメーター変更履歴
      if (tc.paramHistory && tc.paramHistory.length > 0) {
        var histItems = tc.paramHistory.map(function(h) {
          var hAgo = '';
          var hDiffMs = Date.now() - new Date(h.changedAt).getTime();
          var hDiffH = Math.floor(hDiffMs / 3600000);
          if (hDiffH < 1) hAgo = Math.floor(hDiffMs / 60000) + '分前';
          else if (hDiffH < 24) hAgo = hDiffH + 'h前';
          else hAgo = Math.floor(hDiffH / 24) + 'd前';
          return '<div class="trace-history-item">' +
            '<span class="trace-history-version">v' + h.version + '</span>' +
            ' <span style="color:var(--secondary, #8E8E93);font-size:11px">(' + hAgo + ')</span>' +
            (h.winRate != null ? ' <span style="font-size:11px;color:var(--secondary, #8E8E93)">WR=' + (h.winRate * 100).toFixed(0) + '%</span>' : '') +
            (h.rr != null ? ' <span style="font-size:11px;color:var(--secondary, #8E8E93)">RR=' + h.rr.toFixed(1) + '</span>' : '') +
            '<div class="trace-history-reason">' + escHtml(h.reason) + '</div>' +
          '</div>';
        }).join('');
        traceHtml += '<div class="trace-section">' +
          '<div class="trace-title">&#x1F4CD; パラメーター変更履歴</div>' +
          histItems +
        '</div>';
      }
    }

    // 取引規模の計算
    var mul = instr ? instr.multiplier : 1;
    var unitLabel = '';
    if (instr) {
      if (instr.pair === 'USD/JPY') unitLabel = '¥' + mul + ' / 1円';
      else if (instr.pair === 'US10Y') unitLabel = '¥' + (mul / 100) + ' / 1bp';
      else unitLabel = '¥' + mul + ' / 1pt';
    }
    var notional = 0;
    if (currentRate != null && instr) {
      if (instr.pair === 'USD/JPY') notional = mul * currentRate;
      else if (instr.pair === 'US10Y') notional = mul * 1;
      else notional = mul * currentRate;
    }
    var leverage = notional > 0 ? (notional / INITIAL_CAPITAL) : 0;

    var posChartHtml = drawPriceChart(chartPoints, pair, pos.entry_rate);

    body.innerHTML =
      posChartHtml +
      row('方向', '<span style="color:' + (pos.direction === 'BUY' ? 'var(--green)' : 'var(--red)') + ';font-weight:700">' + (pos.direction === 'BUY' ? '買い' : '空売り') + '</span>') +
      progressHtml +
      (currentRate != null ? row('現在値', fmtPrice(pos.pair, currentRate)) : '') +
      row('含み損益', '<span style="color:' + pnlColor + ';font-weight:700">' + pnlFmt.text + '</span>') +
      row('取引規模', unitLabel) +
      (notional > 0 ? row('想定元本', fmtYen(notional) + ' <span style="font-size:11px;color:var(--label-secondary)">(' + leverage.toFixed(1) + '倍)</span>') : '') +
      row('エントリー日時', fmtTime(pos.entry_at)) +
      traceHtml +
      decisionHtml +
      historyHtml;

    lockScroll();
    sheet.classList.add('open');
    backdrop.classList.add('visible');
  }

  function row(label, value) {
    return '<div class="sheet-row"><span class="sheet-label">' + escHtml(label) + '</span>' +
      '<span class="sheet-value">' + value + '</span></div>';
  }

  function closeSheet() {
    var sheet = el('sheet');
    sheet.style.transition = '';
    sheet.style.transform = '';
    sheet.classList.remove('open');
    el('sheet-backdrop').classList.remove('visible');
    document.body.classList.remove('sheet-open');
    // ドロワーが開いている場合はスクロールロックを維持
    if (!document.body.classList.contains('drawer-open')) {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, savedScrollY);
    }
  }

  el('sheet-backdrop').addEventListener('click', function(e) {
    e.stopPropagation();
    closeSheet();
  });

  // ── ニュースドロワー ──
  (function() {
    var drawer = el('news-drawer');
    if (!drawer) return;
    var isExpanded = false;
    var startY = 0;
    var startTranslate = 0;
    var dragging = false;
    var PEEK_H = 68; // 折り畳み時の見せる高さ(px)

    function getTranslate() {
      var match = drawer.style.transform.match(/translateY\(([^)]+)\)/);
      if (match) return parseFloat(match[1]);
      return isExpanded ? 0 : 9999;
    }

    var content = el('tab-portfolio');
    // コンテンツはease-out（バウンスなし）、ドロワー自体はCSSのスプリングを使用
    var EASE_OUT = 'transform 0.46s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.38s cubic-bezier(0.22, 1, 0.36, 1), border-radius 0.46s cubic-bezier(0.22, 1, 0.36, 1)';

    // カード群のみ暗転（ティッカーバーは除外）
    var cards = content ? content.querySelectorAll('.card') : [];

    function applyContentProgress(progress) {
      // progress: 0 = 折り畳み, 1 = 展開
      if (!content) return;
      var scale = 1 - progress * 0.06;
      content.style.transform = 'scale(' + scale + ')';
      // opacityはカード群だけに適用（ティッカーバーは暗転させない）
      var opac = 1 - progress * 0.22;
      for (var i = 0; i < cards.length; i++) {
        cards[i].style.opacity = opac;
      }
    }

    var compactEl = el('compact-summary');

    var savedContentScrollTop = 0;
    function expand() {
      isExpanded = true;
      drawer.style.transition = '';
      drawer.style.transform = '';
      drawer.classList.add('expanded');
      document.body.classList.add('drawer-open');
      if (content) {
        // まずoverflow:hiddenで慣性スクロールを停止してからscrollTopを保存・リセット
        content.classList.add('drawer-expanded');
        savedContentScrollTop = content.scrollTop;
        content.scrollTop = 0;
        content.style.transition = EASE_OUT;
        applyContentProgress(1);
      }
      // 背景スクロールロック
      if (document.body.style.position !== 'fixed') {
        savedScrollY = window.scrollY;
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.top = '0px';
        document.body.style.width = '100%';
      } else {
        document.body.style.top = '0px';
      }
      if (compactEl) compactEl.classList.add('marquee-active');
    }
    function collapse() {
      isExpanded = false;
      drawer.style.transition = '';
      drawer.style.transform = '';
      drawer.classList.remove('expanded');
      document.body.classList.remove('drawer-open');
      // シートが開いていなければスクロールロック解除
      if (!document.body.classList.contains('sheet-open')) {
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.width = '';
        window.scrollTo(0, savedScrollY);
      }
      // コンテンツのスクロール位置を復元
      if (content) content.scrollTop = savedContentScrollTop;
      if (content) {
        content.style.transition = EASE_OUT;
        content.classList.remove('drawer-expanded');
        content.style.transform = '';
        for (var i = 0; i < cards.length; i++) {
          cards[i].style.transition = EASE_OUT;
          cards[i].style.opacity = '';
        }
      }
      if (compactEl) compactEl.classList.remove('marquee-active');
    }

    // ハンドル/ヘッダータップで開閉トグル
    var header = drawer.querySelector('.news-drawer-header');
    header.addEventListener('click', function() {
      if (isExpanded) collapse(); else expand();
    });

    // ドラッグ操作（ヘッダー/ハンドル起点のみ。ボディタッチはスクロール優先）
    drawer.addEventListener('touchstart', function(e) {
      var bodyEl = el('news-drawer-body');
      if (isExpanded && bodyEl && bodyEl.contains(e.target)) return;
      startY = e.touches[0].clientY;
      startTranslate = isExpanded ? 0 : (drawer.offsetHeight - PEEK_H);
      dragging = true;
      drawer.style.transition = 'none';
      if (content) content.style.transition = 'none';
    }, { passive: true });

    drawer.addEventListener('touchmove', function(e) {
      if (!dragging) return;
      e.preventDefault();
      var dy = e.touches[0].clientY - startY;
      var newY = startTranslate + dy;
      var maxY = drawer.offsetHeight - PEEK_H;
      newY = Math.max(0, Math.min(newY, maxY));
      drawer.style.transform = 'translateY(' + newY + 'px)';
      // 上段コンテンツの連動アニメーション（ドラッグ中はtransformのみ、クラス変更はスナップ時のみ）
      var progress = 1 - newY / maxY;
      applyContentProgress(progress);
    }, { passive: false });

    drawer.addEventListener('touchend', function(e) {
      if (!dragging) return;
      dragging = false;
      var dy = e.changedTouches[0].clientY - startY;
      var absDy = Math.abs(dy);
      // タップ（ほぼ移動なし）の場合はスナップを発火しない → ぴくつき防止
      if (absDy < 8) {
        drawer.style.transition = '';
        drawer.style.transform = '';
        return;
      }
      drawer.style.transition = '';
      if (dy < -60) expand();
      else if (dy > 60) collapse();
      else if (isExpanded) expand(); else collapse();
    });

    // 外側タップで折り畳み（シートが開いている間は無効）
    document.addEventListener('click', function(e) {
      if (!isExpanded) return;
      if (drawer.contains(e.target)) return;
      // ボトムシートやbackdropがクリックされた場合はドロワーを閉じない
      var sheet = el('sheet');
      var backdrop = el('sheet-backdrop');
      if ((sheet && sheet.contains(e.target)) || (backdrop && backdrop.contains(e.target))) return;
      if (sheet && sheet.classList.contains('open')) return;
      collapse();
    });

    // ニュースデータを描画
    var newsData = [];
    var newsAnalysisData = [];
    var body = el('news-drawer-body');
    window._renderNews = function(news, analysis) {
      var tab  = el('tab-portfolio');
      if (!news || news.length === 0) {
        drawer.classList.remove('visible');
        if (tab) tab.classList.remove('news-visible');
        return;
      }
      newsData = news;
      newsAnalysisData = analysis || [];
      drawer.classList.add('visible');
      if (tab) tab.classList.add('news-visible');
      // 分析データをtitleでマップ化（indexズレ防止）
      var analysisByTitle = {};
      newsAnalysisData.forEach(function(a) { if (a.title) analysisByTitle[a.title] = a; });
      body.innerHTML = news.map(function(item, i) {
        var dateStr = '';
        if (item.pubDate) {
          try { dateStr = new Date(item.pubDate).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch(e) { dateStr = item.pubDate; }
        }
        var title = typeof item === 'string' ? item : item.title;
        var a = analysisByTitle[title] || null;
        var flag = (a && a.attention) ? '<span class="news-flag">注目</span>' : '';
        return '<div class="news-item' + (a && a.attention ? ' news-attention' : '') + '" data-news-idx="' + i + '">' +
          '<div class="news-item-title">' + flag + escHtml(a && a.title_ja ? a.title_ja : (typeof item === 'string' ? item : item.title)) + '</div>' +
          (dateStr ? '<div class="news-item-date">' + dateStr + '</div>' : '') +
        '</div>';
      }).join('');
    };

    // ニュースタップで詳細シート
    body.addEventListener('click', function(e) {
      var row = e.target.closest('[data-news-idx]');
      if (!row) return;
      var item = newsData[parseInt(row.dataset.newsIdx, 10)];
      if (!item || typeof item === 'string') return;
      el('sheet-title').textContent = 'ニュース詳細';
      var dateStr = '';
      if (item.pubDate) {
        try { dateStr = new Date(item.pubDate).toLocaleString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch(e) { dateStr = item.pubDate; }
      }
      // 分析データからインパクトコメント取得（titleベースマッチング）
      var itemTitle = typeof item === 'string' ? item : item.title;
      var analysisByTitle2 = {};
      newsAnalysisData.forEach(function(a) { if (a.title) analysisByTitle2[a.title] = a; });
      var ana = analysisByTitle2[itemTitle] || null;
      var impactHtml = '';
      if (ana && ana.attention && ana.impact) {
        impactHtml = '<div style="background:rgba(255,149,0,0.1);border-left:3px solid #FF9500;padding:10px 12px;border-radius:8px;margin-bottom:12px">' +
          '<div style="font-size:11px;font-weight:600;color:#FF9500;margin-bottom:4px">AI マーケットインパクト</div>' +
          '<div style="font-size:13px;line-height:1.5;color:var(--label)">' + escHtml(ana.impact) + '</div>' +
        '</div>';
      }
      var sourceHtml = item.source
        ? '<span style="font-size:11px;font-weight:600;color:var(--blue);background:rgba(10,132,255,0.1);padding:2px 8px;border-radius:4px;margin-left:8px">' + escHtml(item.source) + '</span>'
        : '';
      var urlHtml = item.url
        ? '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--separator)">' +
            '<a href="' + escHtml(item.url) + '" target="_blank" rel="noopener noreferrer" ' +
            'style="font-size:12px;color:var(--blue);text-decoration:underline;word-break:break-all;line-height:1.4">' +
            escHtml(item.url) + '</a>' +
          '</div>'
        : '';
      el('sheet-body').innerHTML =
        '<div style="display:flex;align-items:center;margin-bottom:8px">' +
          (dateStr ? '<span style="font-size:12px;color:var(--label-secondary)">' + dateStr + '</span>' : '') +
          sourceHtml +
        '</div>' +
        '<div style="font-size:15px;font-weight:600;line-height:1.5;margin-bottom:12px">' + escHtml(item.title_ja || item.title) + '</div>' +
        impactHtml +
        ((item.desc_ja || item.description) ? '<div style="font-size:13px;color:var(--label-secondary);line-height:1.6">' + escHtml(item.desc_ja || item.description) + '</div>' : '') +
        urlHtml;
      lockScroll();
      el('sheet').classList.add('open');
      el('sheet-backdrop').classList.add('visible');
    });
  })();

  // ── スワイプで閉じる ──
  (function() {
    var sheet = el('sheet');
    var startY = 0;
    var currentY = 0;
    var dragging = false;

    sheet.addEventListener('touchstart', function(e) {
      startY = e.touches[0].clientY;
      dragging = true;
      sheet.style.transition = 'none';
    }, { passive: true });

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
      if (currentY > 100) {
        closeSheet();
      } else {
        sheet.style.transform = '';
      }
      currentY = 0;
    });
  })();

  // ── TP/SL バナー ──
  function detectAndShowBanner(newData) {
    if (!newData.recentCloses || newData.recentCloses.length === 0) return;
    var newIds = newData.recentCloses.map(function(p) { return p.id; });

    // 初回ロード時は表示しない（lastRecentCloseIds が空）
    if (lastRecentCloseIds.length === 0) {
      lastRecentCloseIds = newIds;
      return;
    }

    // 新しいIDを検出
    var prevSet = {};
    lastRecentCloseIds.forEach(function(id) { prevSet[id] = true; });
    var fresh = newData.recentCloses.filter(function(p) { return !prevSet[p.id]; });
    lastRecentCloseIds = newIds;

    if (fresh.length === 0) return;

    // 直近1件を表示
    var pos = fresh[0];
    var isTP = pos.close_reason === 'TP';
    var isSL = pos.close_reason === 'SL';
    var pnlFmt = fmtPnl(pos.pnl, '');

    var banner = el('tp-banner');
    var bannerInner = banner.querySelector('.tp-banner-inner');
    var bannerTitle = el('tp-banner-title');
    var bannerSub   = el('tp-banner-sub');
    var bannerIcon  = banner.querySelector('.tp-banner-icon');
    if (!bannerInner) return;

    var SVG_CHECK = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="9.5" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 11l3 3 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var SVG_CROSS = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="9.5" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 7.5l7 7M14.5 7.5l-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    if (isTP) {
      banner.classList.remove('sl-banner');
      bannerIcon.innerHTML = SVG_CHECK;
      bannerTitle.textContent = '利確！TP到達';
    } else if (isSL) {
      banner.classList.add('sl-banner');
      bannerIcon.innerHTML = SVG_CROSS;
      bannerTitle.textContent = '損切り — 金継ぎ';
    } else {
      banner.classList.remove('sl-banner');
      bannerIcon.innerHTML = SVG_CHECK;
      bannerTitle.textContent = '決済完了';
    }

    bannerSub.textContent = (pos.pair || '') + '  ' + pnlFmt.text;
    banner.classList.add('show');

    // haptic（対応端末のみ）
    if (isTP && navigator.vibrate) navigator.vibrate([80, 40, 80]);
    if (isSL && navigator.vibrate) navigator.vibrate([200]);

    // プッシュ通知
    if ('Notification' in window && Notification.permission === 'granted') {
      var notifLabel = isTP ? '利確' : isSL ? '損切り' : '決済';
      new Notification('FX Sim ' + notifLabel, {
        body: (pos.pair || '') + '  ' + pnlFmt.text,
        tag: 'fxsim-trade-' + pos.id,
      });
    }

    setTimeout(function() { banner.classList.remove('show'); }, 4000);
    bannerInner.addEventListener('click', function() { banner.classList.remove('show'); }, { once: true });
  }

  // ── 時刻フォーマット（パネル用） ──
  function fmtTimeShort(isoStr) {
    if (!isoStr) return '';
    var d = new Date(isoStr);
    var now = new Date();
    var diffMs = now - d;
    var diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'たった今';
    if (diffMin < 60) return diffMin + '分前';
    var diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return diffH + '時間前';
    return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
  }

  // ── PC右パネル描画 ──
  function renderPanel(data) {
    if (window.innerWidth < 1920) return;

    // マーケット概況
    var marketEl = document.getElementById('panel-market');
    if (marketEl && data.latestDecision) {
      var ind = data.latestDecision;
      var items = [
        { label: 'VIX', value: ind.vix != null ? Number(ind.vix).toFixed(1) : 'N/A', color: ind.vix > 20 ? 'var(--orange)' : 'var(--label)' },
        { label: 'US10Y', value: ind.us10y != null ? Number(ind.us10y).toFixed(2) + '%' : 'N/A', color: 'var(--label)' },
        { label: 'USD/JPY', value: data.rate != null ? Number(data.rate).toFixed(2) : 'N/A', color: 'var(--label)' }
      ];
      marketEl.innerHTML = items.map(function(i) {
        return '<div><div style="font-size:10px;color:var(--label-secondary)">' + i.label + '</div><div style="font-size:14px;font-weight:600;color:' + i.color + '">' + i.value + '</div></div>';
      }).join('');
    }

    // ニュースフィード
    var newsEl = document.getElementById('panel-news');
    if (newsEl) {
      var panelNews = (data.acceptedNews || []).length > 0
        ? (data.acceptedNews || []).map(function(n) {
            return { title: n.title_ja, source: n.source, pubDate: n.fetched_at };
          })
        : (data.latestNews || []).map(function(n) {
            return { title: n.title_ja || n.title, source: n.source || 'Reuters', pubDate: n.pubDate };
          });
      newsEl.innerHTML = panelNews.slice(0, 6).map(function(n) {
        return '<div class="panel-news-item">'
          + '<div class="panel-news-title">' + escHtml(n.title) + '</div>'
          + '<div class="panel-news-meta">' + escHtml(n.source || '') + ' • ' + fmtTimeShort(n.pubDate) + '</div></div>';
      }).join('');
    }

    // 判定履歴（AI判断パネル）
    var decisionsEl = document.getElementById('panel-decisions');
    if (decisionsEl && data.recentDecisions) {
      decisionsEl.innerHTML = data.recentDecisions.slice(0, 10).map(function(d) {
        var color = d.decision === 'BUY' ? 'var(--green)' : d.decision === 'SELL' ? 'var(--red)' : 'var(--label-secondary)';
        return '<div style="display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--separator)">'
          + '<span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;color:' + color + '">' + d.decision + '</span>'
          + '<span style="font-size:12px;color:var(--label)">' + (d.pair || 'USD/JPY') + '</span>'
          + '<span style="font-size:11px;color:var(--label-secondary);margin-left:auto">' + fmtTimeShort(d.created_at) + '</span>'
          + '</div>';
      }).join('');
    }

    // RiskGuard（ログパネル）
    var riskEl = document.getElementById('panel-riskguard');
    if (riskEl) {
      var logStats = data.logStats || {};
      var logs = data.systemLogs || [];
      var errCount = logs.filter(function(l) { return l.level === 'ERROR'; }).length;
      var warnCount = logs.filter(function(l) { return l.level === 'WARN'; }).length;
      var statItems = [
        { label: '総実行', value: data.systemStatus ? data.systemStatus.totalRuns : 0 },
        { label: 'AI呼出', value: logStats.geminiCalls || 0 },
        { label: 'エラー', value: errCount, color: errCount > 0 ? 'var(--red)' : 'var(--green)' },
        { label: '警告', value: warnCount, color: warnCount > 5 ? 'var(--orange)' : 'var(--label)' }
      ];
      riskEl.innerHTML = '<div style="padding:16px">' + statItems.map(function(s) {
        return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--separator)">'
          + '<span style="font-size:12px;color:var(--label-secondary)">' + s.label + '</span>'
          + '<span style="font-size:13px;font-weight:600;color:' + (s.color || 'var(--label)') + '">' + s.value + '</span></div>';
      }).join('') + '</div>';
    }
  }

  // ── ウォッチリスト描画 ──
  function renderWatchlist(data) {
    var container = el('watchlist');
    if (!container) return;

    var posMap = {};
    (data.openPositions || []).forEach(function(p) { posMap[p.pair] = p; });

    var rateMap = {};
    rateMap['USD/JPY'] = data.rate;
    var ld = data.latestDecision;

    // PC: テーブル表示（769px以上）
    if (window.innerWidth >= 769) {
      if (ld) {
        rateMap['Nikkei225'] = ld.nikkei;
        rateMap['S&P500']    = ld.sp500;
        rateMap['US10Y']     = ld.us10y;
      }
      var sparks = data.sparklines || {};
      INSTRUMENTS.forEach(function(instr) {
        if (!rateMap[instr.pair]) {
          var pts = sparks[instr.pair];
          if (pts && pts.length > 0) rateMap[instr.pair] = pts[pts.length - 1].rate;
        }
      });

      var positions = INSTRUMENTS.filter(function(i) { return posMap[i.pair]; });
      var holdItems = INSTRUMENTS.filter(function(i) { return !posMap[i.pair]; });
      var html = '<div class="watchlist-columns">';

      // 保有ポジション テーブル
      html += '<div><div class="section-title" style="margin-bottom:8px">保有ポジション</div>';
      html += '<table class="watch-table"><thead><tr>'
        + '<th>銘柄</th><th>方向</th><th>エントリー</th><th>現在値</th><th>推移</th><th style="text-align:right">損益</th>'
        + '</tr></thead><tbody>';
      if (positions.length === 0) {
        html += '<tr><td colspan="6" style="text-align:center;color:var(--label-secondary);padding:16px">ポジションなし</td></tr>';
      }
      positions.forEach(function(instr) {
        var pos = posMap[instr.pair];
        var currentPrice = rateMap[instr.pair] || pos.entry_rate;
        var pnl = pos.direction === 'BUY'
          ? (currentPrice - pos.entry_rate) * (pos.lot || 1) * (instr.multiplier || 100)
          : (pos.entry_rate - currentPrice) * (pos.lot || 1) * (instr.multiplier || 100);
        var sparkPoints = sparks[instr.pair];
        var sparkColor = pnl >= 0 ? 'var(--green)' : 'var(--red)';
        var sparkSvg = drawSparkline(sparkPoints, sparkColor, 60, 20);
        html += '<tr class="watch-table-row" data-pair="' + escHtml(instr.pair) + '">'
          + '<td class="pair-name">' + escHtml(instr.label || instr.pair) + '</td>'
          + '<td><span class="dir-badge dir-' + pos.direction.toLowerCase() + '">' + pos.direction + '</span></td>'
          + '<td style="color:var(--label-secondary)">' + fmtPrice(instr.pair, pos.entry_rate) + '</td>'
          + '<td>' + fmtPrice(instr.pair, currentPrice) + '</td>'
          + '<td class="sparkline-cell">' + sparkSvg + '</td>'
          + '<td style="text-align:right" class="' + (pnl >= 0 ? 'pnl-pos' : 'pnl-neg') + '">' + fmtYen(Math.round(pnl)) + '</td>'
          + '</tr>';
      });
      html += '</tbody></table></div>';

      // 待機銘柄テーブル
      if (holdItems.length > 0) {
        html += '<div><div class="section-title" style="margin-bottom:8px">待機銘柄</div>';
        html += '<table class="watch-table"><thead><tr>'
          + '<th>銘柄</th><th>カテゴリ</th><th>現在値</th>'
          + '</tr></thead><tbody>';
        holdItems.forEach(function(instr) {
          var rate = rateMap[instr.pair];
          html += '<tr>'
            + '<td class="pair-name">' + escHtml(instr.label || instr.pair) + '</td>'
            + '<td style="color:var(--label-secondary);font-size:12px">' + (instr.category || '') + '</td>'
            + '<td>' + (rate ? fmtPrice(instr.pair, rate) : '-') + '</td>'
            + '</tr>';
        });
        html += '</tbody></table></div>';
      }

      html += '</div>';
      container.innerHTML = html;

      // テーブル行クリック → ボトムシート
      container.querySelectorAll('.watch-table-row').forEach(function(rowEl) {
        rowEl.addEventListener('click', function() {
          var pair = rowEl.getAttribute('data-pair');
          var pos = posMap[pair];
          var instr = INSTRUMENTS.filter(function(i) { return i.pair === pair; })[0];
          openSheet(pos || null, instr);
        });
      });
      return; // テーブル表示で終了
    }
    if (ld) {
      rateMap['Nikkei225'] = ld.nikkei;
      rateMap['S&P500']    = ld.sp500;
      rateMap['US10Y']     = ld.us10y;
    }
    // スパークラインから最新レートを補完（新銘柄用）
    var sparks = data.sparklines || {};
    INSTRUMENTS.forEach(function(instr) {
      if (!rateMap[instr.pair]) {
        var pts = sparks[instr.pair];
        if (pts && pts.length > 0) rateMap[instr.pair] = pts[pts.length - 1].rate;
      }
    });

    // 銘柄を「保有中」「待機中」にセクション分離（Cognitive Load 軽減）
    var activeInstr = [];
    var holdInstr = [];
    INSTRUMENTS.forEach(function(instr) {
      if (posMap[instr.pair]) { activeInstr.push(instr); }
      else { holdInstr.push(instr); }
    });

    function buildRow(instr) {
      var pos         = posMap[instr.pair];
      var currentRate = rateMap[instr.pair];

      var unrealized = null;
      if (pos && currentRate != null) {
        unrealized = pos.direction === 'BUY'
          ? (currentRate - pos.entry_rate) * instr.multiplier * (pos.lot || 1)
          : (pos.entry_rate - currentRate) * instr.multiplier * (pos.lot || 1);
      }
      var pnlFmt = fmtPnl(unrealized, instr.unit);

      var dirClass = pos ? 'watch-direction-' + pos.direction.toLowerCase() : 'watch-direction-hold';
      var dirText  = pos ? (pos.direction === 'BUY' ? '買い' : '空売り') : 'HOLD';
      var subText  = pos ? 'Entry ' + fmtPrice(instr.pair, pos.entry_rate) : '—';
      // LIVE/PAPERソースバッジ（保有中のみ表示）
      var sourceBadge = '';
      if (pos && pos.source === 'oanda') {
        sourceBadge = '<span class="watch-source-badge watch-source-live">LIVE</span>';
      } else if (pos && data.tradingMode !== 'paper') {
        sourceBadge = '<span class="watch-source-badge watch-source-paper">PAPER</span>';
      }
      var badgeCls = 'watch-pnl-' + pnlFmt.cls;

      // スパークライン
      var sparkPoints = data.sparklines && data.sparklines[instr.pair];
      var sparkColor = (currentRate != null && sparkPoints && sparkPoints.length >= 2)
        ? (sparkPoints[sparkPoints.length-1].rate >= sparkPoints[0].rate ? 'var(--green)' : 'var(--red)')
        : 'var(--label-secondary)';
      var sparkSvg = drawSparkline(sparkPoints, sparkColor, 60, 28);

      return '<div class="watch-row" role="listitem" data-pair="' + escHtml(instr.pair) + '">' +
        '<div class="watch-left">' +
          '<div class="watch-pair">' + escHtml(instr.label) + '</div>' +
          '<div class="watch-sub">' +
            '<span class="watch-direction ' + dirClass + '">' + dirText + '</span>' +
            sourceBadge +
            '<span>' + subText + '</span>' +
          '</div>' +
        '</div>' +
        (sparkSvg ? '<div style="display:flex;align-items:center;margin:0 8px">' + sparkSvg + '</div>' : '') +
        '<div class="watch-right">' +
          '<div class="watch-price">' + fmtPrice(instr.pair, currentRate) + '</div>' +
          '<div class="watch-pnl-badge ' + badgeCls + '">' + pnlFmt.text + '</div>' +
        '</div>' +
      '</div>';
    }

    var html = activeInstr.map(buildRow).join('');
    if (holdInstr.length > 0) {
      html += '<div class="watch-section-divider" style="font-size:11px;font-weight:600;color:var(--label-tertiary);letter-spacing:0.8px;text-transform:uppercase;padding:12px 16px 4px">待機中</div>';
      html += holdInstr.map(buildRow).join('');
    }

    container.innerHTML = html;

    // PnLバッジ 変化フラッシュ（Variable Reward）
    container.querySelectorAll('.watch-row').forEach(function(rowEl) {
      var pair = rowEl.getAttribute('data-pair');
      var badge = rowEl.querySelector('.watch-pnl-badge');
      if (!badge) return;
      var newText = badge.textContent;
      if (lastPnlMap[pair] !== undefined && lastPnlMap[pair] !== newText) {
        badge.classList.remove('changed');
        void badge.offsetWidth; // reflow でアニメーション再起動
        badge.classList.add('changed');
      }
      lastPnlMap[pair] = newText;
    });

    // ウォッチリスト行タップ → ボトムシート
    container.querySelectorAll('.watch-row').forEach(function(rowEl) {
      rowEl.addEventListener('click', function() {
        var pair = rowEl.getAttribute('data-pair');
        var pos  = posMap[pair];
        var instr = INSTRUMENTS.filter(function(i) { return i.pair === pair; })[0];
        openSheet(pos || null, instr);
      });
    });
  }

  // ── 市場状態サマリーバー（ヒーロー下の帯） ──
  function renderMarketStateBar(data) {
    var bar = el('market-state-bar');
    if (!bar) return;
    var st = data.statistics;
    var regime = calcRegime(st);
    var ewma = st && st.ewmaVol;
    var volLabel = ewma ? (ewma.isHighVol ? '高め' : '普通') : '—';
    var volColor = !ewma ? 'var(--label-secondary)' : ewma.isHighVol ? 'var(--orange)' : 'var(--green)';
    var regimeColor = regime === 'volatile' ? 'var(--red)'
                    : regime === 'trending' ? 'var(--blue)'
                    : 'var(--orange)';
    var sysStatus = data.systemStatus;
    var totalRuns = (sysStatus && sysStatus.totalRuns) || 0;
    var aiConf = st && st.aiAccuracy ? (st.aiAccuracy.accuracy * 100).toFixed(0) + '%' : '—';

    bar.style.display = '';
    bar.innerHTML =
      '<div class="market-state-cell">' +
        '<div class="market-state-label">EWMAボラ</div>' +
        '<div class="market-state-value" style="color:' + volColor + '">' + volLabel + '</div>' +
      '</div>' +
      '<div class="market-state-cell">' +
        '<div class="market-state-label">主流レジーム</div>' +
        '<div class="market-state-value" style="color:' + regimeColor + '">' + regime + '</div>' +
      '</div>' +
      '<div class="market-state-cell">' +
        '<div class="market-state-label">AI信頼度</div>' +
        '<div class="market-state-value">' + aiConf + '</div>' +
      '</div>' +
      '<div class="market-state-cell">' +
        '<div class="market-state-label">稼働</div>' +
        '<div class="market-state-value">' + totalRuns.toLocaleString('ja-JP') + '回</div>' +
      '</div>';
  }

  // ── 統計的有意性プログレスバー（ヒーロー内） ──
  function renderPowerProgress(data) {
    var wrap   = el('power-progress-wrap');
    var fillEl = el('power-progress-fill');
    var pctEl  = el('power-progress-pct');
    var subEl  = el('power-progress-sub');
    if (!wrap || !fillEl) return;

    var pa = data.statistics && data.statistics.powerAnalysis;
    if (!pa) { wrap.style.display = 'none'; return; }

    wrap.style.display = '';
    var pct = Math.max(0, Math.min(Math.round(pa.progressPct), 100));
    fillEl.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '% 達成';
    if (subEl) subEl.textContent = pa.currentN.toLocaleString('ja-JP') + ' / ' + pa.requiredN.toLocaleString('ja-JP') + ' 件';

    if (pa.isAdequate) {
      fillEl.style.background = 'var(--green)';
      if (pctEl) { pctEl.textContent = '✓ 達成'; pctEl.style.color = 'var(--green)'; }
    }
  }

  // ── 統計タブ ナラティブサマリー（問い→答え形式） ──
  function renderPerfSummary(data) {
    var target = el('stats-narrative');
    if (!target) return;
    var st = data.statistics;
    if (!st) {
      target.innerHTML = '<div style="text-align:center;padding:40px 16px;color:var(--label-secondary);font-size:13px">統計データ蓄積中...</div>';
      return;
    }

    // null ガード（データ不足時のクラッシュ防止）
    var wrCI = st.winRateCI;
    var roiCI = st.roiCI;
    if (!wrCI || !wrCI.lower) {
      target.innerHTML = '<div style="text-align:center;padding:40px 16px;color:var(--label-secondary);font-size:13px">統計データ蓄積中...</div>';
      return;
    }
    var baseline = st.randomBaseline;
    var aiAcc = st.aiAccuracy;
    var wrLo = (wrCI.lower * 100).toFixed(1);
    var wrHi = (wrCI.upper * 100).toFixed(1);
    var wrPct = roiCI ? (roiCI.roi >= 0 ? '+' : '') + roiCI.roi.toFixed(1) + '%' : '—';
    var roiLo = roiCI ? (roiCI.ciLower >= 0 ? '+' : '') + roiCI.ciLower.toFixed(1) + '%' : '—';
    var roiHi = roiCI ? (roiCI.ciUpper >= 0 ? '+' : '') + roiCI.ciUpper.toFixed(1) + '%' : '—';
    var beatRate = (baseline && baseline.beatRate != null) ? (baseline.beatRate * 100 >= 50 ? '+' : '') + (baseline.beatRate * 100 - 50).toFixed(1) + '%' : '—';
    var pValue   = baseline ? 'p=' + baseline.mwu.pValue.toFixed(3) + (baseline.mwu.significant ? ' 有意' : '') : '—';
    var brierStr = aiAcc ? aiAcc.brierScore.toFixed(2) : '—';
    var accPct   = aiAcc ? (aiAcc.accuracy * 100).toFixed(1) + '%' : '—';

    var winVerdict = wrCI.lower > 0.5 && (roiCI && roiCI.ciLower > 0);
    var verdictCls = winVerdict ? 'yes' : 'warn';
    var verdictTxt = winVerdict ? '✓ YES' : '△ 様子見';

    var sharpe = st.sharpe || 0;
    var dd = st.drawdown || { maxDDPct: 0, currentDDPct: 0, recoveryRatio: 1 };
    var var95 = st.var95 != null ? Math.round(st.var95) : 0;
    var kelly = st.kellyFraction != null ? (st.kellyFraction * 100).toFixed(1) : '—';
    var sharpeColor = sharpe >= 1 ? 'var(--green)' : sharpe >= 0.5 ? 'var(--label)' : 'var(--red)';
    var ddColor = dd.maxDDPct > 15 ? 'var(--red)' : dd.maxDDPct > 8 ? 'var(--orange)' : 'var(--label)';
    var riskVerdict = sharpe >= 0.5 && dd.maxDDPct < 20;
    var riskVerdictCls = riskVerdict ? 'yes' : 'warn';
    var riskVerdictTxt = riskVerdict ? '✓ YES' : '△ 要注意';

    var hierRates = st.hierarchicalWinRates || [];
    var topPairs = hierRates
      .filter(function(r) { return r.n >= 3; })
      .sort(function(a, b) { return b.bayesRate - a.bayesRate; })
      .slice(0, 3);
    var medals = [
      '<span class="ai-ranking-medal ai-ranking-medal--1">1</span>',
      '<span class="ai-ranking-medal ai-ranking-medal--2">2</span>',
      '<span class="ai-ranking-medal ai-ranking-medal--3">3</span>'
    ];
    var pairsVerdict = topPairs.length >= 2 ? 'yes' : 'warn';
    var pairsVerdictTxt = topPairs.length >= 2 ? '✓ 明確' : '△ 不明瞭';

    // CI バー計算
    var ciMin = Math.min(wrCI.lower * 100 - 2, 47);
    var ciMax = Math.max(wrCI.upper * 100 + 2, 53);
    var ciRange = ciMax - ciMin || 1;
    var lineAt50 = ((50 - ciMin) / ciRange * 100).toFixed(1);
    var fillLeft  = Math.max(0, Math.min(((wrCI.lower * 100 - ciMin) / ciRange * 100), 100)).toFixed(1);
    var fillWidth = Math.max(0, Math.min((((wrCI.upper - wrCI.lower) * 100) / ciRange * 100), 100 - parseFloat(fillLeft))).toFixed(1);
    var above50 = wrCI.lower * 100 > 50 ? '50% 超え確認' : '50% 超え未確認';
    var above50Color = wrCI.lower * 100 > 50 ? 'var(--green)' : 'var(--label-secondary)';

    target.innerHTML =
      // ① 勝てているか
      '<div class="stats-narrative-section">' +
        '<div class="stats-narrative-header">' +
          '<div class="stats-narrative-question">' +
            'このAIは統計的に勝てているか？' +
          '</div>' +
          '<span class="stats-verdict stats-verdict--' + verdictCls + '">' + verdictTxt + '</span>' +
        '</div>' +
        '<div class="stats-card">' +
          '<div class="stats-grid-2">' +
            '<div>' +
              '<div class="stats-metric-label">勝率 95% CI</div>' +
              '<div class="stats-metric-value" style="color:' + (wrCI.lower * 100 >= 50 ? 'var(--green)' : wrCI.lower * 100 >= 45 ? 'var(--label)' : 'var(--red)') + '">' + (wrCI.lower * 100).toFixed(1) + '%</div>' +
              '<div class="stats-metric-sub">[' + wrLo + '% – ' + wrHi + '%]</div>' +
            '</div>' +
            '<div>' +
              '<div class="stats-metric-label">ROI 95% CI</div>' +
              '<div class="stats-metric-value" style="color:' + (roiCI && roiCI.roi >= 0 ? 'var(--green)' : 'var(--red)') + '">' + wrPct + '</div>' +
              '<div class="stats-metric-sub">[' + roiLo + ' – ' + roiHi + ']</div>' +
            '</div>' +
            '<div>' +
              '<div class="stats-metric-label">AI精度</div>' +
              '<div class="stats-metric-value">' + accPct + '</div>' +
              '<div class="stats-metric-sub">Brier ' + brierStr + '</div>' +
            '</div>' +
            '<div>' +
              '<div class="stats-metric-label">vs ランダム</div>' +
              '<div class="stats-metric-value" style="color:' + (baseline && baseline.beatRate != null && baseline.beatRate * 100 >= 50 ? 'var(--green)' : 'var(--red)') + '">' + beatRate + '</div>' +
              '<div class="stats-metric-sub">' + pValue + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ci-bar-wrap">' +
          '<div class="ci-bar-header">' +
            '<span>勝率信頼区間</span>' +
            '<span style="color:' + above50Color + ';font-weight:600">' + above50 + '</span>' +
          '</div>' +
          '<div class="ci-bar-track">' +
            '<div class="ci-bar-fill" style="left:' + fillLeft + '%;width:' + fillWidth + '%"></div>' +
            '<div class="ci-bar-marker" style="left:' + lineAt50 + '%"></div>' +
          '</div>' +
          '<div class="ci-bar-labels">' +
            '<span>' + ciMin.toFixed(1) + '%</span>' +
            '<span>50% ライン</span>' +
            '<span>' + ciMax.toFixed(1) + '%</span>' +
          '</div>' +
        '</div>' +
      '</div>' +

      // ② リスクに見合ったリターンか
      '<div class="stats-narrative-section">' +
        '<div class="stats-narrative-header">' +
          '<div class="stats-narrative-question">' +
            'リスクに見合ったリターンか？' +
          '</div>' +
          '<span class="stats-verdict stats-verdict--' + riskVerdictCls + '">' + riskVerdictTxt + '</span>' +
        '</div>' +
        '<div class="stats-card">' +
          '<div class="stats-grid-2">' +
            '<div>' +
              '<div class="stats-metric-label">Sharpe比</div>' +
              '<div class="stats-metric-value" style="color:' + sharpeColor + '">' + sharpe.toFixed(2) + '</div>' +
              '<div class="stats-metric-sub">±' + (st.sharpeSE != null ? st.sharpeSE.toFixed(2) : '—') + (st.sharpeSignificant ? ' (有意)' : '') + '</div>' +
            '</div>' +
            '<div>' +
              '<div class="stats-metric-label">最大DD</div>' +
              '<div class="stats-metric-value" style="color:' + ddColor + '">-' + dd.maxDDPct.toFixed(1) + '%</div>' +
              '<div class="stats-metric-sub">許容範囲内</div>' +
            '</div>' +
            '<div>' +
              '<div class="stats-metric-label">VaR 95%</div>' +
              '<div class="stats-metric-value">-' + Math.abs(var95).toLocaleString('ja-JP') + '</div>' +
              '<div class="stats-metric-sub">pip/トレード</div>' +
            '</div>' +
            '<div>' +
              '<div class="stats-metric-label">Kelly推奨</div>' +
              '<div class="stats-metric-value">' + kelly + '%</div>' +
              '<div class="stats-metric-sub">ベットサイズ</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      // ③ どの銘柄が得意か
      '<div class="stats-narrative-section">' +
        '<div class="stats-narrative-header">' +
          '<div class="stats-narrative-question">' +
            'どの銘柄が得意か？' +
          '</div>' +
          '<span class="stats-verdict stats-verdict--' + pairsVerdict + '">' + pairsVerdictTxt + '</span>' +
        '</div>' +
        (topPairs.length > 0 ?
          '<div class="ai-ranking-list ai-ranking-list--inline">' +
          topPairs.map(function(r, i) {
            var inst = INSTRUMENTS.find(function(x) { return x.pair === r.pair; });
            var label = inst ? inst.label : r.pair;
            var pct = (r.bayesRate * 100).toFixed(1);
            var barW = Math.round(r.bayesRate * 100);
            return '<div class="ai-ranking-row">' +
              medals[i] +
              '<span class="ai-ranking-name">' + escHtml(label) + '</span>' +
              '<div class="ai-ranking-bar"><div class="ai-ranking-bar-fill" style="width:' + barW + '%"></div></div>' +
              '<span class="ai-ranking-pct">' + pct + '%</span>' +
              '<span style="font-size:11px;color:var(--label-secondary);margin-left:4px">n=' + r.n + '</span>' +
            '</div>';
          }).join('') +
          '</div>'
          : '<div style="padding:16px;font-size:13px;color:var(--label-secondary)">データ蓄積中</div>'
        ) +
      '</div>';
  }

  // ── 資産推移グラフ描画 ──
  // Apple HIG: 11pt最小フォント、8ptグリッド、十分な余白
  // UX心理学: Peak-End（最終値強調）、Goal Gradient（目標ライン）、認知負荷軽減（ラベル統一）
  function renderEquityChart(data) {
    var chart = el('equity-chart');
    if (!chart) return;
    var closes = (data.recentCloses || []).slice().reverse();
    if (closes.length < 2) {
      chart.innerHTML = '<div style="text-align:center;color:var(--label-secondary);font-size:13px;padding:60px 0">取引データ蓄積中...</div>';
      return;
    }
    // 資産推移を計算
    var totalPnl = data.performance.totalPnl || 0;
    var closePnlSum = 0;
    closes.forEach(function(c) { closePnlSum += (c.pnl || 0); });
    var missingPnl = totalPnl - closePnlSum;
    var equity = [INITIAL_CAPITAL + missingPnl];
    var cumPnl = 0;
    closes.forEach(function(c) {
      cumPnl += (c.pnl || 0);
      equity.push(INITIAL_CAPITAL + missingPnl + cumPnl);
    });

    var font = '-apple-system,system-ui,sans-serif';
    var w = chart.clientWidth || chart.offsetWidth || 300;
    var h = 180;

    var min = Math.min.apply(null, equity);
    var max = Math.max.apply(null, equity);
    var dataRange = max - min || 1;

    // Nice axis: 綺麗な数値の目盛りを生成（500, 1000, 2000, 5000刻み等）
    var yTicks = 4;
    var rawStep = dataRange / yTicks;
    var mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    var niceStep = rawStep <= mag * 1.5 ? mag
                 : rawStep <= mag * 3   ? mag * 2
                 : rawStep <= mag * 7   ? mag * 5
                 : mag * 10;
    var niceMin = Math.floor(min / niceStep) * niceStep;
    var niceMax = Math.ceil(max / niceStep) * niceStep;
    yTicks = Math.round((niceMax - niceMin) / niceStep);
    // 目盛り数が多すぎたら間引く（最大5本）
    if (yTicks > 5) { niceStep *= 2; niceMax = niceMin + Math.ceil((max - niceMin) / niceStep) * niceStep; yTicks = Math.round((niceMax - niceMin) / niceStep); }
    var niceRange = niceMax - niceMin || 1;

    // Y軸ラベルフォーマット — 全ラベルがユニークになることを保証
    function fmtYLabel(v) {
      // 万単位表示の場合、niceStepに応じた精度で表示
      if (v >= 10000 && niceStep >= 1000) return '¥' + (v / 10000).toFixed(v % 10000 === 0 ? 0 : 1) + '万';
      // niceStep < 1000 or 1万未満 → 千円単位でカンマ区切り
      return '¥' + Math.round(v).toLocaleString();
    }

    var maxLabelLen = 0;
    for (var ti = 0; ti <= yTicks; ti++) {
      var lbl = fmtYLabel(niceMin + niceStep * ti);
      if (lbl.length > maxLabelLen) maxLabelLen = lbl.length;
    }
    var padL = Math.max(56, maxLabelLen * 8 + 12);
    var padR = 8;
    var padT = 28; // 最終値ラベル用余白（上に十分なスペース）
    var padB = 28; // X軸ラベル用余白
    var chartW = w - padL - padR;
    var chartH = h - padT - padB;

    // データ→座標変換
    var step = equity.length > 1 ? chartW / (equity.length - 1) : 0;
    var pts = equity.map(function(v, i) {
      var x = padL + i * step;
      var y = padT + chartH - ((v - niceMin) / niceRange) * chartH;
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    var lastVal = equity[equity.length - 1];
    var color = lastVal >= INITIAL_CAPITAL ? 'var(--green)' : 'var(--red)';
    var gridColor = 'var(--label-quaternary, rgba(128,128,128,0.15))';

    // Y軸グリッド + ラベル（HIG 11pt最小）
    var yGridLines = '';
    var yLabels = '';
    for (var yi = 0; yi <= yTicks; yi++) {
      var yVal = niceMin + niceStep * yi;
      var yPos = padT + chartH - (chartH * yi / yTicks);
      // 上下端はボーダーと重なるので線は省略、ラベルは表示
      if (yi > 0 && yi < yTicks) {
        yGridLines += '<line x1="' + padL + '" y1="' + yPos.toFixed(1) + '" x2="' + (w - padR) + '" y2="' + yPos.toFixed(1) + '" stroke="' + gridColor + '" stroke-width="0.5"/>';
      }
      yLabels += '<text x="' + (padL - 8) + '" y="' + (yPos + 4).toFixed(1) + '" text-anchor="end" fill="var(--label-secondary)" font-size="11" font-family="' + font + '">' + fmtYLabel(yVal) + '</text>';
    }

    // X軸ラベル: 両端 + 中間1本（シンプルに保つ）
    var totalTrades = equity.length - 1;
    var xLabels = '';
    xLabels += '<text x="' + padL + '" y="' + (h - 8) + '" text-anchor="start" fill="var(--label-tertiary)" font-size="11" font-family="' + font + '">開始</text>';
    if (totalTrades > 6) {
      var midIdx = Math.round(totalTrades / 2);
      var midX = padL + midIdx * step;
      xLabels += '<text x="' + midX.toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" fill="var(--label-tertiary)" font-size="11" font-family="' + font + '">' + midIdx + '件</text>';
    }
    xLabels += '<text x="' + (w - padR) + '" y="' + (h - 8) + '" text-anchor="end" fill="var(--label-tertiary)" font-size="11" font-family="' + font + '">' + totalTrades + '件</text>';

    // 元本ライン
    var capitalY = padT + chartH - ((INITIAL_CAPITAL - niceMin) / niceRange) * chartH;
    var capitalLine = '';
    if (INITIAL_CAPITAL >= niceMin && INITIAL_CAPITAL <= niceMax) {
      capitalLine =
        '<line x1="' + padL + '" y1="' + capitalY.toFixed(1) + '" x2="' + (w - padR) + '" y2="' + capitalY.toFixed(1) + '" stroke="var(--label-tertiary)" stroke-width="1" stroke-dasharray="4,4" opacity="0.4"/>' +
        '<text x="' + (padL + 6) + '" y="' + (capitalY - 6).toFixed(1) + '" fill="var(--label-tertiary)" font-size="11" font-family="' + font + '">元本</text>';
    }

    // 目標ライン（Goal Gradient）
    var goalLine = '';
    var GOAL = 15000;
    if (GOAL >= niceMin && GOAL <= niceMax) {
      var goalY = padT + chartH - ((GOAL - niceMin) / niceRange) * chartH;
      goalLine =
        '<line x1="' + padL + '" y1="' + goalY.toFixed(1) + '" x2="' + (w - padR) + '" y2="' + goalY.toFixed(1) + '" stroke="var(--blue)" stroke-width="1" stroke-dasharray="5,4" opacity="0.5"/>' +
        '<text x="' + (w - padR - 6) + '" y="' + (goalY - 6).toFixed(1) + '" text-anchor="end" fill="var(--blue)" font-size="11" font-weight="600" font-family="' + font + '" opacity="0.7">目標 ¥1.5万</text>';
    }

    // グラデーション塗りつぶし
    var fillPts = pts.join(' ') + ' ' + (w - padR) + ',' + (padT + chartH) + ' ' + padL + ',' + (padT + chartH);

    // 最終値ドット座標
    var lastPt = pts[pts.length - 1].split(',');
    var lastX = parseFloat(lastPt[0]);
    var lastY = parseFloat(lastPt[1]);
    // 最終値ラベル: ドットの上14px、上端に近すぎたら下に
    var labelY = lastY - 14;
    if (labelY < padT - 6) labelY = lastY + 18;
    // 常に右寄せ（最終値は右端なので）
    var labelAnchor = 'end';

    chart.innerHTML =
      '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="display:block;overflow:visible;max-width:100%">' +
        '<defs><linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.18"/>' +
          '<stop offset="100%" stop-color="' + color + '" stop-opacity="0.01"/>' +
        '</linearGradient></defs>' +
        // チャートエリア境界線（角丸）
        '<rect x="' + padL + '" y="' + padT + '" width="' + chartW + '" height="' + chartH + '" fill="none" stroke="' + gridColor + '" stroke-width="0.5" rx="4"/>' +
        yGridLines + yLabels + xLabels +
        capitalLine + goalLine +
        // 塗りつぶし + ライン
        '<polygon points="' + fillPts + '" fill="url(#eqGrad)"/>' +
        '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
        // 最終値ドット（Peak-End強調: 大きめドット + 光彩）
        '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="6" fill="' + color + '" opacity="0.15"/>' +
        '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="3.5" fill="' + color + '"/>' +
        // 最終値ラベル（HIG 13pt、ウェイト600）
        '<text x="' + lastX.toFixed(1) + '" y="' + labelY.toFixed(1) + '" text-anchor="' + labelAnchor + '" fill="' + color + '" font-size="13" font-weight="600" font-family="' + font + '">' + fmtYen(lastVal) + '</text>' +
      '</svg>';

    // レスポンシブ: コンテナリサイズ時に再描画
    if (!chart._resizeOb) {
      chart._resizeOb = new ResizeObserver(function() {
        if (chart._resizeTimer) clearTimeout(chart._resizeTimer);
        chart._resizeTimer = setTimeout(function() { renderEquityChart(data); }, 150);
      });
      chart._resizeOb.observe(chart);
    }
  }

  // ── 統計タブ描画 ──
  // UX心理学: Serial Position（重要データ先頭）、Progressive Disclosure（段階的開示）、
  // Loss Aversion（リスク可視化）、Aesthetic-Usability（統一された美しいレイアウト）
  function renderStats(data) {
    renderEquityChart(data);
    renderPerfSummary(data);
    var container = el('stats-pairs');
    if (!container) return;
    var byPair = data.performanceByPair || {};

    // ── セクションヘッダー生成（Apple HIG: テキスト階層のみ、装飾最小限） ──
    function secHeader(icon, bgColor, title) {
      return '<div class="stats-sec-header">' +
        '<span class="stats-sec-title">' + title + '</span>' +
      '</div>';
    }

    // ── 1. 期間別パフォーマンス（Serial Position: 最重要を最初に） ──
    var advStatsHtml = '';
    var st = data.statistics;
    if (st) {
      var roll = st.rolling || {};
      var r7 = roll[7] || { roi: 0, count: 0, winRate: 0 };
      var r14 = roll[14] || { roi: 0, count: 0, winRate: 0 };
      var r30 = roll[30] || { roi: 0, count: 0, winRate: 0 };
      var fmtRoi = function(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; };
      var roiColor = function(v) { return v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--label)'; };
      // トレンド矢印（Variable Reward: 変化を視覚的に）
      var trendArrow = function(v) { return v > 0 ? '↑' : v < 0 ? '↓' : '→'; };

      advStatsHtml += secHeader('📈', 'var(--blue)', '期間別パフォーマンス') +
        '<div class="metric-grid-3">' +
          '<div class="metric-card" style="text-align:center">' +
            '<div class="metric-label">直近7件</div>' +
            '<div class="metric-value" style="color:' + roiColor(r7.roi) + '">' + trendArrow(r7.roi) + ' ' + fmtRoi(r7.roi) + '</div>' +
            '<div class="metric-sub">勝率 ' + r7.winRate.toFixed(0) + '%</div>' +
          '</div>' +
          '<div class="metric-card" style="text-align:center">' +
            '<div class="metric-label">直近14件</div>' +
            '<div class="metric-value" style="color:' + roiColor(r14.roi) + '">' + trendArrow(r14.roi) + ' ' + fmtRoi(r14.roi) + '</div>' +
            '<div class="metric-sub">勝率 ' + r14.winRate.toFixed(0) + '%</div>' +
          '</div>' +
          '<div class="metric-card" style="text-align:center">' +
            '<div class="metric-label">直近30件</div>' +
            '<div class="metric-value" style="color:' + roiColor(r30.roi) + '">' + trendArrow(r30.roi) + ' ' + fmtRoi(r30.roi) + '</div>' +
            '<div class="metric-sub">勝率 ' + r30.winRate.toFixed(0) + '%</div>' +
          '</div>' +
        '</div>';

      // ── 2. リスク指標（Loss Aversion: 危険度を色で直感的に） ──
      var dd = st.drawdown || { maxDDPct: 0, currentDDPct: 0, recoveryRatio: 1 };
      var ddAccent = dd.currentDDPct > 5 ? 'danger' : dd.currentDDPct > 2 ? 'warn' : 'ok';
      var ddColor = dd.currentDDPct > 5 ? 'var(--red)' : dd.currentDDPct > 2 ? 'var(--orange,#ff9500)' : 'var(--label)';
      var vol = st.volatility || { volRatio: 1, isHighVol: false };
      var volLabel = vol.volRatio > 1.5 ? '高' : vol.volRatio > 0.8 ? '中' : '低';
      var volColor = vol.isHighVol ? 'var(--red)' : 'var(--label)';
      var volAccent = vol.isHighVol ? 'danger' : vol.volRatio > 0.8 ? 'warn' : 'ok';
      var var95 = Math.round(st.var95).toLocaleString();
      var cvar95 = Math.round(st.cvar95).toLocaleString();

      advStatsHtml += secHeader('🛡️', 'var(--orange, #ff9500)', 'リスク指標') +
        '<div class="metric-grid-2">' +
          '<div class="metric-card metric-card--danger">' +
            '<div class="metric-label">最大DD</div>' +
            '<div class="metric-value" style="color:var(--red)">' + dd.maxDDPct.toFixed(1) + '%</div>' +
          '</div>' +
          '<div class="metric-card metric-card--' + ddAccent + '">' +
            '<div class="metric-label">現在DD</div>' +
            '<div class="metric-value" style="color:' + ddColor + '">' + dd.currentDDPct.toFixed(1) + '%</div>' +
          '</div>' +
          '<div class="metric-card metric-card--danger">' +
            '<div class="metric-label">VaR / CVaR (95%)</div>' +
            '<div class="metric-value" style="color:var(--red)">\u00a5' + var95 + ' / \u00a5' + cvar95 + '</div>' +
          '</div>' +
          '<div class="metric-card metric-card--' + volAccent + '">' +
            '<div class="metric-label">\u30dc\u30e9\u30c6\u30a3\u30ea\u30c6\u30a3</div>' +
            '<div class="metric-value" style="color:' + volColor + '">' + volLabel + ' <span style="font-size:11px;font-weight:400;color:var(--label-secondary)">\u00d7' + vol.volRatio.toFixed(2) + '</span></div>' +
          '</div>' +
        '</div>';

      // ── 3. 統計的信頼性 ──
      var wrLo = (st.winRateCI.lower * 100).toFixed(1);
      var wrHi = (st.winRateCI.upper * 100).toFixed(1);
      var sharpeFmt = st.sharpe.toFixed(3);
      var sharpeSig = st.sharpeSignificant;
      var kellyPct = (st.kellyFraction * 100).toFixed(1);
      var streakPct = (st.markov.streakProb3 * 100).toFixed(1);
      var roiCI = st.roiCI;
      var roiColor = roiCI && roiCI.roi >= 0 ? 'var(--green)' : 'var(--red)';
      var aiAcc = st.aiAccuracy;
      var aiColor = aiAcc ? (aiAcc.accuracy >= 0.55 ? 'var(--green)' : aiAcc.accuracy >= 0.50 ? 'var(--label)' : 'var(--red)') : 'var(--label-secondary)';

      advStatsHtml += secHeader('📊', 'var(--purple, #af52de)', '統計的信頼性') +
        '<div class="metric-grid-2">' +
          '<div class="metric-card">' +
            '<div class="metric-label">勝率 95% CI</div>' +
            '<div class="metric-value">' + wrLo + '% \u2014 ' + wrHi + '%</div>' +
          '</div>' +
          (roiCI ? '<div class="metric-card">' +
            '<div class="metric-label">ROI 95% CI <span style="font-size:10px;color:var(--label-tertiary)">n=' + roiCI.n + '</span></div>' +
            '<div class="metric-value" style="color:' + roiColor + '">' +
              (roiCI.roi >= 0 ? '+' : '') + roiCI.roi.toFixed(1) + '% ' +
              '<span style="font-size:11px;font-weight:400;color:var(--label-secondary)">[' +
                (roiCI.ciLower >= 0 ? '+' : '') + roiCI.ciLower.toFixed(1) + '%, ' +
                (roiCI.ciUpper >= 0 ? '+' : '') + roiCI.ciUpper.toFixed(1) + '%]' +
              '</span>' +
            '</div>' +
          '</div>' : '') +
          '<div class="metric-card">' +
            '<div class="metric-label">Sharpe\u6bd4' +
              (sharpeSig ? ' <span style="color:var(--green);font-weight:700">\u6709\u610f</span>' : ' <span style="color:var(--label-tertiary)">n.s.</span>') +
            '</div>' +
            '<div class="metric-value">' + sharpeFmt + ' <span style="font-size:11px;font-weight:400;color:var(--label-secondary)">\u00b1' + st.sharpeSE.toFixed(3) + '</span></div>' +
          '</div>' +
          '<div class="metric-card">' +
            '<div class="metric-label">Kelly\u57fa\u6e96</div>' +
            '<div class="metric-value">' + kellyPct + '%</div>' +
          '</div>' +
          (aiAcc ? '<div class="metric-card">' +
            '<div class="metric-label">AI\u7684\u4e2d\u7387 <span style="font-size:10px;color:var(--label-tertiary)">n=' + aiAcc.n + '</span></div>' +
            '<div class="metric-value" style="color:' + aiColor + '">' +
              (aiAcc.accuracy * 100).toFixed(1) + '% ' +
              '<span style="font-size:11px;font-weight:400;color:var(--label-secondary)">BS=' + aiAcc.brierScore.toFixed(2) + '</span>' +
            '</div>' +
          '</div>' : '') +
          '<div class="metric-card">' +
            '<div class="metric-label">PF / 3\u9023\u6557</div>' +
            '<div class="metric-value">' + (st.profitFactor != null ? st.profitFactor.toFixed(2) : '\u2014') + ' / <span style="color:' + (parseFloat(streakPct) > 20 ? 'var(--red)' : 'var(--label)') + '">' + streakPct + '%</span></div>' +
          '</div>' +
        '</div>';
    }

    // ── 4. 銘柄別成績（Progressive Disclosure: 取引ありのみ展開） ──
    function buildStatsCard(instr) {
      var p = byPair[instr.pair];
      if (!p) p = { total: 0, wins: 0, totalPnl: 0 };
      var winRate = p.total > 0 ? (p.wins / p.total * 100) : 0;
      var pnlFmt  = fmtPnl(p.totalPnl, instr.unit);
      var pnlCls  = pnlFmt.cls === 'pos' ? 'var(--green)' : pnlFmt.cls === 'neg' ? 'var(--red)' : 'var(--label-secondary)';

      return '<div class="stats-pair-card" data-stats-pair="' + escHtml(instr.pair) + '">' +
        '<div class="stats-pair-header">' +
          '<span class="stats-pair-name">' + escHtml(instr.label) + '</span>' +
          '<span class="stats-pnl" style="color:' + pnlCls + '">' + pnlFmt.text + '</span>' +
        '</div>' +
        '<div class="stats-bar-track"><div class="stats-bar-fill" style="width:' + winRate.toFixed(0) + '%"></div></div>' +
        '<div class="stats-bar-meta">' +
          '<span>勝率 ' + winRate.toFixed(0) + '%</span>' +
          '<span>' + p.wins + '勝 ' + (p.total - p.wins) + '敗（計' + p.total + '）</span>' +
        '</div>' +
      '</div>';
    }
    var traded = INSTRUMENTS.filter(function(i) { var p = byPair[i.pair]; return p && p.total > 0; });
    var untraded = INSTRUMENTS.filter(function(i) { var p = byPair[i.pair]; return !p || p.total === 0; });
    var pairHtml = secHeader('💹', 'var(--green)', '銘柄別成績') +
      traded.map(buildStatsCard).join('');
    // 未取引は折りたたみ（Cognitive Load軽減）
    if (untraded.length > 0) {
      pairHtml += '<button class="stats-fold-btn" id="untraded-toggle">未取引 ' + untraded.length + '銘柄を表示 ▾</button>' +
        '<div id="untraded-list" style="display:none">' +
          untraded.map(buildStatsCard).join('') +
        '</div>';
    }

    // ── 5. 銘柄スコア（折りたたみ） ──
    var scoresHtml = '';
    var scores = data.instrumentScores || [];
    if (scores.length > 0) {
      scoresHtml = secHeader('🏆', 'var(--yellow, #ffcc00)', '銘柄スコア') +
        '<div id="scores-list">' +
        scores.map(function(s, idx) {
          var instrS = INSTRUMENTS.filter(function(i) { return i.pair === s.pair; })[0];
          var label = instrS ? instrS.label : s.pair;
          var wr = (s.win_rate * 100).toFixed(0);
          var qualified = s.win_rate >= 0.55 && s.avg_rr >= 1.0 && s.total_trades >= 5;
          var barColor = qualified ? 'var(--green)' : 'var(--label-secondary)';
          var barWidth = Math.max(s.score * 100, 3);
          return '<div class="score-row">' +
            '<span class="score-rank">' + (idx + 1) + '</span>' +
            '<div class="score-body">' +
              '<div class="score-head">' +
                '<span class="score-name">' + escHtml(label) +
                  (qualified ? ' <span style="font-size:11px;color:var(--green)">QUALIFIED</span>' : '') +
                '</span>' +
                '<span class="score-val">' + (s.score * 100).toFixed(0) + '点</span>' +
              '</div>' +
              '<div class="score-bar"><div class="score-bar-fill" style="width:' + barWidth + '%;background:' + barColor + '"></div></div>' +
              '<div class="score-details">' +
                '<span>勝率' + wr + '%</span>' +
                '<span>RR ' + s.avg_rr.toFixed(2) + '</span>' +
                '<span>Sharpe ' + s.sharpe.toFixed(2) + '</span>' +
                '<span>' + s.total_trades + '件</span>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('') +
        '</div>';
    }

    // ── 5.5. 銘柄別 RR / Kelly テーブル ──
    var rrKellyHtml = '';
    if (scores.length > 0) {
      var rrRows = scores
        .filter(function(s) { return s.total_trades >= 1; })
        .map(function(s) {
          var rr = s.avg_rr;
          var wr = s.win_rate;
          var kelly = rr > 0 ? wr - (1 - wr) / rr : -9.99;
          return { pair: s.pair, n: s.total_trades, wr: wr, rr: rr, kelly: kelly };
        })
        .sort(function(a, b) { return b.kelly - a.kelly; });

      rrKellyHtml = secHeader('📐', 'var(--teal, #30b0c7)', '銘柄別 RR / Kelly') +
        '<table style="display:table;width:100%;border-collapse:collapse;font-size:12px">' +
        '<thead><tr style="color:var(--label-secondary);font-size:11px">' +
        '<th style="text-align:left;padding:4px 6px;font-weight:500">銘柄</th>' +
        '<th style="text-align:right;padding:4px 6px;font-weight:500">件数</th>' +
        '<th style="text-align:right;padding:4px 6px;font-weight:500">勝率</th>' +
        '<th style="text-align:right;padding:4px 6px;font-weight:500">RR</th>' +
        '<th style="text-align:right;padding:4px 6px;font-weight:500">Kelly</th>' +
        '</tr></thead><tbody>' +
        rrRows.map(function(r) {
          var instrR = INSTRUMENTS.filter(function(i) { return i.pair === r.pair; })[0];
          var label = instrR ? instrR.label : r.pair;
          var kellyColor = r.kelly >= 0.1 ? 'var(--green)' : r.kelly >= 0 ? 'var(--orange, #ff9500)' : 'var(--red)';
          var kellyText = r.kelly <= -9 ? '—' : (r.kelly >= 0 ? '+' : '') + (r.kelly * 100).toFixed(1) + '%';
          var rrColor = r.rr >= 1.5 ? 'var(--green)' : r.rr >= 1.0 ? 'var(--label)' : 'var(--red)';
          return '<tr style="border-bottom:1px solid var(--separator)">' +
            '<td style="padding:6px;font-weight:500">' + escHtml(label) + '</td>' +
            '<td style="text-align:right;padding:6px;color:var(--label-secondary)">' + r.n + '</td>' +
            '<td style="text-align:right;padding:6px">' + (r.wr * 100).toFixed(0) + '%</td>' +
            '<td style="text-align:right;padding:6px;color:' + rrColor + '">' + r.rr.toFixed(2) + '</td>' +
            '<td style="text-align:right;padding:6px;font-weight:600;color:' + kellyColor + '">' + kellyText + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table>';
    }

    // ── 6. 取引履歴（Progressive Disclosure: 初期5件 + もっと見る） ──
    var HIST_INITIAL = 5;
    var closes = (data.recentCloses || []).slice();
    var histHtml = '';
    if (closes.length > 0) {
      histHtml = secHeader('📋', 'var(--teal, #30b0c7)', '取引履歴') +
        '<div id="trade-history">' +
        closes.map(function(c, idx) {
          var instrH = INSTRUMENTS.filter(function(i) { return i.pair === c.pair; })[0];
          var label = instrH ? instrH.label : c.pair;
          var unit = instrH ? instrH.unit : '';
          var pnl = c.pnl != null ? c.pnl : 0;
          var pnlColor = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--label-secondary)';
          var icon = c.close_reason === 'TP' ? '<span style="color:var(--green);font-size:10px;font-weight:700;letter-spacing:0.3px">TP</span>' : c.close_reason === 'SL' ? '<span style="color:var(--red);font-size:10px;font-weight:700;letter-spacing:0.3px">SL</span>' : '—';
          var dir = c.direction === 'BUY' ? '買い' : '空売り';
          var hidden = idx >= HIST_INITIAL ? ' style="display:none" data-hist-extra' : '';
          return '<div class="trade-row"' + hidden + '>' +
            '<div>' +
              '<div class="trade-label">' + escHtml(label) + '</div>' +
              '<div class="trade-meta">' + icon + ' ' + (c.close_reason || '') + ' · ' + dir + ' · ' + fmtTime(c.closed_at) + '</div>' +
            '</div>' +
            '<span class="trade-pnl" style="color:' + pnlColor + '">' + fmtPnl(pnl, unit).text + '</span>' +
          '</div>';
        }).join('') +
        '</div>';
      if (closes.length > HIST_INITIAL) {
        histHtml += '<button class="stats-fold-btn" id="hist-toggle">残り' + (closes.length - HIST_INITIAL) + '件を表示 ▾</button>';
      }
    }

    // 全銘柄の取引数合計
    var totalTrades = INSTRUMENTS.reduce(function(sum, instr) {
      var p = byPair[instr.pair];
      return sum + (p ? p.total : 0);
    }, 0);

    // レイアウト順序: 統計データ → 銘柄別 → スコア → 履歴
    container.innerHTML = advStatsHtml + pairHtml + scoresHtml + rrKellyHtml + histHtml +
      (totalTrades === 0
        ? '<div class="secondary-text" style="padding:8px 0 4px;text-align:center;font-size:13px">まだ決済された取引はありません<br>Cronが蓄積されると成績が表示されます</div>'
        : '');

    // ── 折りたたみイベント ──
    var untradedBtn = document.getElementById('untraded-toggle');
    if (untradedBtn) {
      untradedBtn.addEventListener('click', function() {
        var list = document.getElementById('untraded-list');
        if (!list) return;
        var isHidden = list.style.display === 'none';
        list.style.display = isHidden ? '' : 'none';
        untradedBtn.textContent = isHidden
          ? '未取引 ' + untraded.length + '銘柄を隠す ▴'
          : '未取引 ' + untraded.length + '銘柄を表示 ▾';
      });
    }
    var histBtn = document.getElementById('hist-toggle');
    if (histBtn) {
      histBtn.addEventListener('click', function() {
        var extras = document.querySelectorAll('[data-hist-extra]');
        var isHidden = extras.length > 0 && extras[0].style.display === 'none';
        extras.forEach(function(el) { el.style.display = isHidden ? '' : 'none'; });
        histBtn.textContent = isHidden
          ? '折りたたむ ▴'
          : '残り' + (closes.length - HIST_INITIAL) + '件を表示 ▾';
      });
    }

    // 銘柄カードタップ → 銘柄別取引履歴シート
    container.querySelectorAll('[data-stats-pair]').forEach(function(card) {
      card.addEventListener('click', function() {
        var pair = card.getAttribute('data-stats-pair');
        var instr = INSTRUMENTS.filter(function(i) { return i.pair === pair; })[0];
        var label = instr ? instr.label : pair;
        var unit = instr ? instr.unit : '';
        var p = byPair[pair] || { total: 0, wins: 0, totalPnl: 0 };
        var pairCloses = closes.filter(function(c) { return c.pair === pair; });

        el('sheet-title').textContent = label + ' 取引履歴';

        var summaryHtml =
          '<div style="display:flex;gap:16px;margin-bottom:12px">' +
            '<div style="flex:1;text-align:center;padding:8px;background:var(--bg-tertiary);border-radius:8px">' +
              '<div style="font-size:11px;color:var(--label-secondary)">損益</div>' +
              '<div style="font-size:16px;font-weight:700;color:' + (p.totalPnl > 0 ? 'var(--green)' : p.totalPnl < 0 ? 'var(--red)' : 'var(--label)') + '">' + fmtPnl(p.totalPnl, unit).text + '</div>' +
            '</div>' +
            '<div style="flex:1;text-align:center;padding:8px;background:var(--bg-tertiary);border-radius:8px">' +
              '<div style="font-size:11px;color:var(--label-secondary)">勝率</div>' +
              '<div style="font-size:16px;font-weight:700">' + (p.total > 0 ? (p.wins / p.total * 100).toFixed(0) + '%' : '—') + '</div>' +
            '</div>' +
            '<div style="flex:1;text-align:center;padding:8px;background:var(--bg-tertiary);border-radius:8px">' +
              '<div style="font-size:11px;color:var(--label-secondary)">取引</div>' +
              '<div style="font-size:16px;font-weight:700">' + p.total + '件</div>' +
            '</div>' +
          '</div>';

        var listHtml = '';
        if (pairCloses.length > 0) {
          listHtml = pairCloses.map(function(c) {
            var pnl = c.pnl != null ? c.pnl : 0;
            var pnlColor = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--label-secondary)';
            var icon = c.close_reason === 'TP' ? '<span style="color:var(--green);font-size:10px;font-weight:700;letter-spacing:0.3px">TP</span>' : c.close_reason === 'SL' ? '<span style="color:var(--red);font-size:10px;font-weight:700;letter-spacing:0.3px">SL</span>' : '—';
            var dir = c.direction === 'BUY' ? '買い' : '空売り';
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--separator)">' +
              '<div>' +
                '<div style="font-size:13px">' + icon + ' ' + (c.close_reason || '') + ' · ' + dir + '</div>' +
                '<div style="font-size:11px;color:var(--label-secondary);margin-top:2px">' +
                  fmtPrice(pair, c.entry_rate) + ' → ' + fmtPrice(pair, c.close_rate) + ' · ' + fmtTime(c.closed_at) +
                '</div>' +
              '</div>' +
              '<span style="font-size:15px;font-weight:700;color:' + pnlColor + '">' + fmtPnl(pnl, unit).text + '</span>' +
            '</div>';
          }).join('');
        } else {
          listHtml = '<div style="text-align:center;color:var(--label-secondary);padding:16px;font-size:13px">まだ取引履歴がありません</div>';
        }

        el('sheet-body').innerHTML = summaryHtml + listHtml;
        lockScroll();
        el('sheet').classList.add('open');
        el('sheet-backdrop').classList.add('visible');
      });
    });
  }

  // ── メインレンダリング ──
  // ── 戦略タブ ──
  function renderStrategy(data) {
    if (!data.strategyMap) return;
    var sm = data.strategyMap;

    // 銘柄ティア一覧
    var tiersEl = el('strategy-tiers');
    if (tiersEl && sm.instrumentTiers) {
      var tierGroups = { A: [], B: [], C: [], D: [] };
      sm.instrumentTiers.forEach(function(t) {
        if (tierGroups[t.tier]) tierGroups[t.tier].push(t);
      });
      var html = '';
      ['A', 'B', 'C', 'D'].forEach(function(tier) {
        var items = tierGroups[tier] || [];
        if (items.length === 0) return;
        var colors = { A: '#34c759', B: '#007aff', C: '#ff9500', D: '#8e8e93' };
        var labels = { A: 'x1.0', B: 'x0.7', C: 'x0.5', D: 'x0.3' };
        html += '<div class="stat-card" style="border-left:3px solid ' + colors[tier] + '">' +
          '<div class="stat-label">Tier ' + tier + ' <span style="color:' + colors[tier] + '">' + labels[tier] + '</span></div>' +
          '<div class="stat-value" style="font-size:12px;font-weight:400">' +
          items.map(function(i) { return i.pair; }).join(', ') +
          '</div></div>';
      });
      tiersEl.innerHTML = html;
    }

    // 手法×環境マトリクス
    var matrixEl = el('strategy-matrix');
    if (matrixEl && sm.strategyStats && sm.strategyStats.length > 0) {
      var rows = sm.strategyStats.map(function(s) {
        var reliabilityBadge = s.reliability === 'trusted'
          ? '<span style="color:#34c759">●</span>'
          : s.reliability === 'tentative'
            ? '<span style="color:#ff9500">●</span>'
            : '<span style="color:#8e8e93">●</span>';
        var wrColor = s.winRate >= 0.55 ? '#34c759' : s.winRate >= 0.45 ? '#ff9500' : '#ff3b30';
        return '<tr>' +
          '<td>' + (s.strategy || '—') + '</td>' +
          '<td>' + (s.regime || '—') + '</td>' +
          '<td style="text-align:right">' + s.count + '</td>' +
          '<td style="text-align:right;color:' + wrColor + '">' + (s.winRate * 100).toFixed(0) + '%</td>' +
          '<td style="text-align:right">' + (s.avgPnl >= 0 ? '+' : '') + s.avgPnl.toFixed(1) + '</td>' +
          '<td style="text-align:center">' + reliabilityBadge + '</td>' +
          '</tr>';
      }).join('');
      matrixEl.innerHTML =
        '<table style="width:100%;font-size:11px;border-collapse:collapse">' +
        '<thead><tr style="color:var(--text2);border-bottom:1px solid var(--border)">' +
        '<th style="text-align:left;padding:4px">手法</th>' +
        '<th style="text-align:left;padding:4px">環境</th>' +
        '<th style="text-align:right;padding:4px">N</th>' +
        '<th style="text-align:right;padding:4px">勝率</th>' +
        '<th style="text-align:right;padding:4px">期待値</th>' +
        '<th style="text-align:center;padding:4px">信頼</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
    } else if (matrixEl) {
      matrixEl.innerHTML = '<p style="color:var(--text2);font-size:12px">データ蓄積中...</p>';
    }
  }

  function render(data) {
    var prev = lastData;
    lastData = data;

    // 警報バナー（最優先で描画）
    renderAlertBanner(data);

    // ヘッダー: トレーディングモードバッジ
    var modeBadgeEl = document.getElementById('mode-badge');
    if (modeBadgeEl) {
      if (data.tradingMode === 'live') {
        modeBadgeEl.textContent = 'LIVE';
        modeBadgeEl.className = 'mode-badge mode-live';
        modeBadgeEl.style.display = '';
      } else if (data.tradingMode === 'demo') {
        modeBadgeEl.textContent = 'DEMO';
        modeBadgeEl.className = 'mode-badge mode-demo';
        modeBadgeEl.style.display = '';
      } else {
        modeBadgeEl.style.display = 'none';
      }
    }

    // RiskGuard状態（ログタブに表示）
    var riskEl = document.getElementById('risk-status');
    if (riskEl && data.riskStatus) {
      var rs = data.riskStatus;
      var killCls = rs.killSwitchActive ? 'negative' : 'positive';
      var killText = rs.killSwitchActive ? 'ON' : 'OFF';
      riskEl.innerHTML =
        '<div class="risk-status-card">' +
          '<div class="risk-status-title">RiskGuard</div>' +
          '<div class="risk-status-grid">' +
            '<div class="risk-item"><span class="risk-label">キルスイッチ</span><span class="risk-value ' + killCls + '">' + killText + '</span></div>' +
            '<div class="risk-item"><span class="risk-label">本日損失</span><span class="risk-value ' + (rs.todayLoss < 0 ? 'negative' : '') + '">\\u00A5' + Math.round(rs.todayLoss).toLocaleString('ja-JP') + ' / -\\u00A5' + Math.round(rs.maxDailyLoss).toLocaleString('ja-JP') + '</span></div>' +
            '<div class="risk-item"><span class="risk-label">実弾ポジション</span><span class="risk-value">' + rs.livePositions + ' / ' + rs.maxPositions + '</span></div>' +
          '</div>' +
        '</div>';
      riskEl.style.display = '';
    } else if (riskEl) {
      riskEl.style.display = 'none';
    }

    // TP/SLバナー検出
    detectAndShowBanner(data);

    // 因果サマリー描画
    renderCausalSummary(data);

    // Hero: 資産残高（元手 + 累計PnL）
    var perf = data.performance;
    var heroEl = el('hero-pnl');
    var totalPnl = perf.totalPnl;
    var capital = INITIAL_CAPITAL + totalPnl;
    heroEl.className = 'hero-pnl ' + (totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : 'neutral');
    animatePnl(heroEl, capital);

    var dpEl = el('today-pnl');
    dpEl.textContent = fmtYenCompact(totalPnl);
    dpEl.className   = 'hero-sub-value ' + (totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : 'neutral');

    // 含み損益（全オープンポジション合計）
    var unrealizedTotal = 0;
    var opens = data.openPositions || [];
    if (opens.length > 0) {
      var rMap = {};
      rMap['USD/JPY'] = data.rate;
      var ld2 = data.latestDecision;
      if (ld2) { rMap['Nikkei225'] = ld2.nikkei; rMap['S&P500'] = ld2.sp500; rMap['US10Y'] = ld2.us10y; }
      var spk = data.sparklines || {};
      INSTRUMENTS.forEach(function(instr) {
        if (!rMap[instr.pair]) {
          var pts = spk[instr.pair];
          if (pts && pts.length > 0) rMap[instr.pair] = pts[pts.length - 1].rate;
        }
      });
      opens.forEach(function(pos) {
        var instr = INSTRUMENTS.find(function(i) { return i.pair === pos.pair; });
        var cr = rMap[pos.pair];
        if (instr && cr != null) {
          var pnl = pos.direction === 'BUY'
            ? (cr - pos.entry_rate) * (pos.lot || 1) * (instr.multiplier || 100)
            : (pos.entry_rate - cr) * (pos.lot || 1) * (instr.multiplier || 100);
          unrealizedTotal += pnl;
        }
      });
    }
    var upEl = el('unrealized-pnl');
    if (upEl) {
      upEl.textContent = fmtYenCompact(Math.round(unrealizedTotal));
      upEl.className = 'hero-sub-value ' + (unrealizedTotal > 0 ? 'positive' : unrealizedTotal < 0 ? 'negative' : 'neutral');
    }

    var roiEl = el('roi-value');
    var roiPct = (totalPnl / INITIAL_CAPITAL) * 100;
    if (roiEl) {
      var roiText = Math.abs(roiPct) >= 1000 ? roiPct.toFixed(0) : roiPct.toFixed(2);
      roiEl.textContent = (roiPct >= 0 ? '+' : '') + roiText + '%';
      roiEl.className = 'hero-sub-value ' + (roiPct > 0 ? 'positive' : roiPct < 0 ? 'negative' : 'neutral');
    }
    el('win-rate').textContent     = perf.winRate.toFixed(1) + '%';
    el('total-trades').textContent = perf.totalClosed + ' 件';

    // ウォッチリスト
    renderWatchlist(data);

    renderAiTab(data);

    // 市場状態バー・プログレスバー（資産タブ）
    renderMarketStateBar(data);
    renderPowerProgress(data);

    // 統計タブ
    renderStats(data);

    // ログタブ
    renderLog(data);

    // 戦略タブ
    renderStrategy(data);

    // タブバッジ更新（Zeigarnik効果）
    updateTabBadges(data);

    // ニュースドロワー（acceptedNews優先、なければlatestNewsフォールバック）
    var newsForDrawer = (data.acceptedNews || []).length > 0
      ? (data.acceptedNews || []).map(function(n) {
          return { title: n.title_ja, title_ja: n.title_ja, description: n.desc_ja, desc_ja: n.desc_ja, pubDate: n.fetched_at, source: n.source, url: n.url || null };
        })
      : (data.latestNews || []);
    if (window._renderNews) window._renderNews(newsForDrawer, data.newsAnalysis || []);

    // ティッカーバー（ニュースドロワー展開時の横スクロール銘柄バー）
    var tickerEl = el('ticker-scroll');
    if (tickerEl) {
      tickerEl.innerHTML = INSTRUMENTS.map(function(instr) {
        var pos = (data.openPositions || []).find(function(p) { return p.pair === instr.pair; });
        var sparkPoints = data.sparklines && data.sparklines[instr.pair];
        var currentRate = null;
        if (pos) currentRate = pos.entry_rate;
        if (sparkPoints && sparkPoints.length > 0) currentRate = sparkPoints[sparkPoints.length - 1].rate;
        if (instr.pair === 'USD/JPY' && data.rate) currentRate = data.rate;
        var sparkColor = (sparkPoints && sparkPoints.length >= 2)
          ? (sparkPoints[sparkPoints.length-1].rate >= sparkPoints[0].rate ? 'var(--green)' : 'var(--red)')
          : 'var(--label-secondary)';
        var sparkSvg = drawSparkline(sparkPoints, sparkColor, 48, 20);
        var change = pos ? (pos.pnl != null ? pos.pnl : 0) : 0;
        var changeCls = change > 0 ? 'positive' : change < 0 ? 'negative' : '';
        var changeText = change !== 0 ? ((change > 0 ? '+' : '') + change.toFixed(1)) : '—';
        return '<div class="ticker-item">' +
          '<div class="ticker-name">' + escHtml(instr.label) + '</div>' +
          '<div class="ticker-mid">' +
            '<span class="ticker-price">' + fmtPrice(instr.pair, currentRate) + '</span>' +
            (sparkSvg ? '<span class="ticker-spark">' + sparkSvg + '</span>' : '') +
          '</div>' +
          '<div class="ticker-change ' + changeCls + '">' + changeText + '</div>' +
        '</div>';
      }).join('');
      // シームレスループ用に2倍複製
      tickerEl.innerHTML = tickerEl.innerHTML + tickerEl.innerHTML;
      // iOS Safari対応: アニメーション開始は展開時のみ（marquee-activeクラスで制御）
    }

    // システムステータス
    el('last-run').textContent   = fmtTime(data.systemStatus.lastRun);
    el('total-runs').textContent = Number(data.systemStatus.totalRuns).toLocaleString('ja-JP');

    // PC: 右パネル描画
    renderPanel(data);
  }

  // ── タブバッジ更新（Zeigarnik効果） ──
  function updateTabBadges(data) {
    var tabs = document.querySelectorAll('.tab-item');
    tabs.forEach(function(tab) {
      var old = tab.querySelector('.tab-badge');
      if (old) old.remove();
    });
    // ログタブ: WARN + ERROR 件数
    var logs = data.systemLogs || [];
    var warnCount = logs.filter(function(l) { return l.level === 'WARN' || l.level === 'ERROR'; }).length;
    if (warnCount > 0) {
      var logTab = document.querySelector('[data-tab="tab-log"]');
      if (logTab) {
        var badge = document.createElement('span');
        badge.className = 'tab-badge';
        badge.textContent = warnCount > 99 ? '99+' : String(warnCount);
        logTab.appendChild(badge);
      }
    }
  }

  // ── ログタブ描画 ──
  function renderLog(data) {
    var stats = data.logStats || {};
    var logs  = data.systemLogs || [];

    // JSON detailを人間が読める形に整形
    function fmtLogDetail(detail) {
      if (!detail) return '';
      try {
        var obj = JSON.parse(detail);
        // キーと値をペアで表示（ネストしない）
        return Object.keys(obj).map(function(k) {
          var v = obj[k];
          if (typeof v === 'number') v = Math.round(v * 10000) / 10000;
          return k + ': ' + v;
        }).join(' | ');
      } catch (e) {
        // JSONでなければそのまま（120文字に切り詰め）
        return detail.slice(0, 120);
      }
    }

    // 統計グリッド
    var grid = el('log-stats-grid');
    if (grid) {
      var skipRate = stats.totalRuns > 0
        ? Math.round(stats.holdCount / stats.totalRuns * 100) : 0;
      grid.innerHTML =
        statCell('総実行回数', Number(stats.totalRuns || 0).toLocaleString('ja-JP'), '回') +
        statCell('AI呼出回数', Number(stats.geminiCalls || 0).toLocaleString('ja-JP'), '回') +
        statCell('WARN', stats.warnCount || 0, '件') +
        statCell('ERROR', stats.errorCount || 0, '件');
    }

    // ログリスト
    var list = el('log-list');
    if (!list) return;
    if (logs.length === 0) {
      list.innerHTML = '<div class="log-row"><span class="log-msg" style="color:var(--label-secondary)">ログなし</span></div>';
      return;
    }
    list.innerHTML = logs.map(function(log) {
      var lvlCls = log.level === 'ERROR' ? 'log-level-error' : log.level === 'WARN' ? 'log-level-warn' : 'log-level-info';
      return '<div class="log-row">' +
        '<span class="log-level ' + lvlCls + '">' + escHtml(log.level) + '</span>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;justify-content:space-between;gap:8px">' +
            '<span class="log-msg">' + escHtml(log.message) + '</span>' +
            '<span class="log-time">' + fmtTime(log.created_at) + '</span>' +
          '</div>' +
          (log.detail ? '<div class="log-detail">' + escHtml(fmtLogDetail(log.detail)) + '</div>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  function statCell(label, value, unit) {
    return '<div class="stat-cell">' +
      '<div class="stat-cell-label">' + label + '</div>' +
      '<div><span class="stat-cell-value">' + value + '</span><span class="stat-cell-unit">' + unit + '</span></div>' +
    '</div>';
  }

  // ── AI判断タブ: データ描画 ──
  function renderAiTab(data) {
    var decisions   = data.recentDecisions  || [];
    var openPos     = data.openPositions    || [];
    var stats       = data.statistics       || {};
    var perf        = data.performance      || {};
    var timeline    = el('ai-timeline-list');
    if (!timeline) return;

    // ─ KPI: 今日の判断 ─
    // IPA品質修正: recentDecisions は LIMIT 20 のため過小計上になる
    // サーバー側の専用COUNTクエリ値（todayDecisionCount 等）を使用する
    // todayD: トリガー内訳の計算では引き続き利用（isToday + LIMIT 20 サブセットで可）
    var todayD    = decisions.filter(function(d) { return isToday(d.created_at); });
    var todayTotal = data.todayDecisionCount != null ? data.todayDecisionCount : todayD.length;
    var buyCount  = data.todayBuyCount  != null ? data.todayBuyCount
                  : todayD.filter(function(d) { return d.decision === 'BUY';  }).length;
    var sellCount = data.todaySellCount != null ? data.todaySellCount
                  : todayD.filter(function(d) { return d.decision === 'SELL'; }).length;

    var kpiTodayVal = el('ai-kpi-today-val');
    var kpiTodaySub = el('ai-kpi-today-sub');
    if (kpiTodayVal) kpiTodayVal.textContent = todayTotal > 0 ? String(todayTotal) : '—';
    if (kpiTodaySub) kpiTodaySub.textContent = 'BUY ' + buyCount + ' · SELL ' + sellCount;

    // ─ KPI: AI的中率 ─
    var acc = stats.aiAccuracy;
    var kpiAccVal = el('ai-kpi-acc-val');
    var kpiAccSub = el('ai-kpi-acc-sub');
    if (kpiAccVal) kpiAccVal.textContent = acc && acc.accuracy != null
      ? (acc.accuracy * 100).toFixed(1) + '%' : '—';
    if (kpiAccSub) kpiAccSub.textContent = acc
      ? 'n=' + (acc.n || 0) + ' · Brier ' + (acc.brierScore != null ? acc.brierScore.toFixed(2) : '—')
      : 'n=— · Brier —';

    // ─ KPI: 今日の損益 ─
    var todayPnl  = perf.todayPnl;
    var todayWins = perf.todayWins;
    var todayLosses = perf.todayLosses;
    var kpiPnlVal = el('ai-kpi-pnl-val');
    var kpiPnlSub = el('ai-kpi-pnl-sub');
    if (kpiPnlVal) {
      var pnlText = todayPnl != null
        ? (todayPnl >= 0 ? '+¥' : '-¥') + Math.abs(Math.round(todayPnl)).toLocaleString('ja-JP')
        : '—';
      kpiPnlVal.textContent = pnlText;
      kpiPnlVal.className = 'kpi-val' + (todayPnl > 0 ? ' green' : todayPnl < 0 ? ' red' : '');
    }
    if (kpiPnlSub) {
      var winsText   = todayWins   != null ? String(todayWins)   : '—';
      var lossesText = todayLosses != null ? String(todayLosses) : '—';
      kpiPnlSub.textContent = winsText + ' 勝 ' + lossesText + ' 敗';
    }

    // ─ KPI: 最新判断 ─
    var latest      = decisions[0];
    var kpiBadge    = el('ai-kpi-latest-badge');
    var kpiPair     = el('ai-kpi-latest-pair');
    var kpiTime     = el('ai-kpi-latest-time');
    if (latest) {
      if (kpiBadge) {
        kpiBadge.textContent = latest.decision;
        kpiBadge.className = 'dir-badge ' + (latest.decision === 'BUY' ? 'buy' : latest.decision === 'SELL' ? 'sell' : 'hold');
      }
      if (kpiPair) kpiPair.textContent = latest.pair || 'USD/JPY';
      if (kpiTime) kpiTime.textContent = fmtElapsed(latest.created_at);
    }

    // ─ トリガーカウント ─
    var newsCount = todayD.filter(function(d) { return inferTrigger(d) === 'news'; }).length;
    var rateCount = todayD.filter(function(d) { return inferTrigger(d) === 'rate'; }).length;
    var cronCount = todayD.filter(function(d) { return inferTrigger(d) === 'cron'; }).length;
    var triggerNewsEl = el('ai-trigger-news'); if (triggerNewsEl) triggerNewsEl.textContent = String(newsCount);
    var triggerRateEl = el('ai-trigger-rate'); if (triggerRateEl) triggerRateEl.textContent = String(rateCount);
    var triggerCronEl = el('ai-trigger-cron'); if (triggerCronEl) triggerCronEl.textContent = String(cronCount);

    // ─ タイムラインカード描画 ─
    if (decisions.length === 0) {
      timeline.innerHTML = '<div style="padding:24px;text-align:center;color:var(--label-secondary);font-size:13px">データなし</div>';
      return;
    }

    timeline.innerHTML = decisions.map(function(d, i) {
      var trigger  = inferTrigger(d);
      var dirCls   = d.decision === 'BUY' ? 'buy' : d.decision === 'SELL' ? 'sell' : 'hold';
      var reasoning = fmtReasoning(d.reasoning);

      // 判断結果の判定（4分類: 保有中 / TP勝ち / SL負け / 未実行）
      // openPositions → recentCloses → 未実行 の順で照合
      // IPA品質修正: IEEE 754 浮動小数点許容差 0.01 を使用
      var resultKey  = 'closed';
      var resultText = '⏸ 未実行';
      var resultPnl  = '';
      if (d.decision === 'BUY' || d.decision === 'SELL') {
        var matchedOpen = openPos.find(function(p) {
          return p.pair === (d.pair || 'USD/JPY') && p.direction === d.decision && Math.abs(p.entry_rate - d.rate) < 0.01;
        });
        if (matchedOpen) {
          resultKey  = 'open';
          resultText = '📂 保有中';
        } else {
          var closes = data.recentCloses || [];
          var matchedClose = closes.find(function(p) {
            return p.pair === (d.pair || 'USD/JPY') && p.direction === d.decision && Math.abs(p.entry_rate - d.rate) < 0.01;
          });
          if (matchedClose) {
            if (matchedClose.close_reason === 'TP') {
              resultKey  = 'tp';
              resultText = '✅ TP';
              resultPnl  = matchedClose.pnl != null ? (matchedClose.pnl >= 0 ? ' +' : ' ') + fmt(matchedClose.pnl, 0) : '';
            } else if (matchedClose.close_reason === 'SL') {
              resultKey  = 'sl';
              resultText = '❌ SL';
              resultPnl  = matchedClose.pnl != null ? (matchedClose.pnl >= 0 ? ' +' : ' ') + fmt(matchedClose.pnl, 0) : '';
            } else {
              resultKey  = 'closed';
              resultText = '📋 決済済';
              resultPnl  = matchedClose.pnl != null ? (matchedClose.pnl >= 0 ? ' +' : ' ') + fmt(matchedClose.pnl, 0) : '';
            }
          }
        }
      } else {
        // HOLD判断 → 常に「様子見」
        resultKey  = 'closed';
        resultText = '👀 様子見';
      }

      // 指標チップ
      var chips = [];
      if (d.vix   != null) chips.push('VIX ' + fmt(d.vix, 1));
      if (d.us10y != null) chips.push(fmt(d.us10y, 2) + '%');

      // TP/SL表示（tp_rateがAPIに追加されていれば使用、なければ省略）
      var tpslText = '';
      if (d.tp_rate != null || d.sl_rate != null) {
        tpslText = ' · TP ' + (d.tp_rate != null ? fmt(d.tp_rate, 3) : '—') +
                   ' / SL ' + (d.sl_rate != null ? fmt(d.sl_rate, 3) : '—');
      }

      return '<div class="tl-card" role="listitem" data-ai-idx="' + i + '">' +
        '<div class="tl-inner">' +
          '<div class="tl-accent ' + resultKey + '"></div>' +
          '<div class="tl-row1">' +
            '<div class="tl-left">' +
              '<span class="tl-pair">' + escHtml(d.pair || 'USD/JPY') + '</span>' +
              '<span class="tl-rate">' + fmt(d.rate, 3) + '</span>' +
              '<span class="dir-badge ' + dirCls + '">' + d.decision + '</span>' +
            '</div>' +
            '<div class="tl-meta">' +
              '<span class="tl-time">' + fmtElapsed(d.created_at) + '</span>' +
              '<span class="tl-chevron">▸</span>' +
            '</div>' +
          '</div>' +
          '<div class="tl-row2">' +
            '<span class="tl-chip ' + trigger + '">' + escHtml(triggerLabel(trigger)) + '</span>' +
            (reasoning && reasoning !== '—'
              ? '<span class="tl-reasoning-chip">' + escHtml(reasoning.slice(0, 40)) + (reasoning.length > 40 ? '…' : '') + '</span>'
              : '') +
          '</div>' +
          '<div class="tl-row3">' +
            '<div style="display:flex;gap:4px">' +
              chips.map(function(c) { return '<span class="tl-chip cron">' + escHtml(c) + '</span>'; }).join('') +
            '</div>' +
            '<div class="tl-result">' +
              '<div class="result-dot ' + resultKey + '"></div>' +
              '<span class="tl-result-text ' + resultKey + '">' + resultText + resultPnl + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="detail-panel" id="ai-detail-' + i + '">' +

          // ── セクション1: TP / SL ゲージ（BUY/SELLのみ） ──
          (d.decision !== 'HOLD' && (d.tp_rate != null || d.sl_rate != null)
            ? (function() {
                var tp = d.tp_rate;
                var sl = d.sl_rate;
                var entry = d.rate;
                var isBuy = d.decision === 'BUY';
                // ゲージ計算: SL----Entry----TP を視覚的に表示
                var slDist = sl != null ? Math.abs(entry - sl) : 0;
                var tpDist = tp != null ? Math.abs(tp - entry) : 0;
                var totalDist = slDist + tpDist || 1;
                var slPct = Math.round((slDist / totalDist) * 100);
                var tpPct = 100 - slPct;
                var rrRatio = slDist > 0 ? (tpDist / slDist).toFixed(1) : '—';

                return '<div class="detail-tpsl-section">' +
                  '<div class="detail-section-label">TP / SL</div>' +
                  '<div class="detail-tpsl-gauge">' +
                    '<div class="tpsl-bar">' +
                      '<div class="tpsl-sl-zone" style="width:' + slPct + '%"></div>' +
                      '<div class="tpsl-entry-mark"></div>' +
                      '<div class="tpsl-tp-zone" style="width:' + tpPct + '%"></div>' +
                    '</div>' +
                    '<div class="tpsl-labels">' +
                      '<span class="tpsl-label sl">' + (sl != null ? 'SL ' + fmt(sl, 3) : '—') + '</span>' +
                      '<span class="tpsl-label entry">' + fmt(entry, 3) + '</span>' +
                      '<span class="tpsl-label tp">' + (tp != null ? 'TP ' + fmt(tp, 3) : '—') + '</span>' +
                    '</div>' +
                  '</div>' +
                  '<div class="tpsl-meta">' +
                    '<span class="tpsl-rr">RR ' + rrRatio + '</span>' +
                    (slDist > 0 ? '<span class="tpsl-pips">SL ' + fmt(slDist, 3) + ' / TP ' + fmt(tpDist, 3) + '</span>' : '') +
                  '</div>' +
                '</div>';
              })()
            : '') +

          // ── セクション2: AI判断理由（メインコンテンツ） ──
          (reasoning && reasoning !== '—'
            ? '<div class="detail-reason-section">' +
                '<div class="detail-section-label">AI判断理由</div>' +
                '<div class="detail-reason-body">' + escHtml(reasoning) + '</div>' +
              '</div>'
            : '') +

          // ── セクション3: 市場コンテキスト（指標 + ニュース） ──
          (function() {
            // Path B判定: reasoning が [PATH_B] で始まる
            var isPathB = d.reasoning && d.reasoning.indexOf('[PATH_B]') === 0;

            // ニュース解析
            var newsArr = [];
            if (d.news_summary) {
              try {
                var raw = d.news_summary;
                for (var attempt = 0; attempt < 3 && typeof raw === 'string'; attempt++) {
                  try { raw = JSON.parse(raw); } catch(e) { break; }
                }
                if (Array.isArray(raw)) newsArr = raw;
              } catch(e) {}
            }

            // Path B: title_ja/impact付き = 判断根拠ニュース
            var hasPathBNews = isPathB && newsArr.length > 0 && newsArr.some(function(n) {
              return n && typeof n === 'object' && (n.title_ja || n.impact);
            });

            var sectionHtml = '<div class="detail-context-section">';

            // セクションヘッダー: Path B → 「判断根拠ニュース」、Path A → 「市場コンテキスト」
            if (hasPathBNews) {
              sectionHtml += '<div class="detail-section-label">判断根拠ニュース</div>';
              // Path B: 判断根拠のニュースを強調表示
              sectionHtml += '<div class="detail-news-list pathb">' +
                newsArr.slice(0, 3).map(function(n) {
                  var title = n.title_ja || n.title || (typeof n === 'string' ? n : String(n));
                  var impact = n.impact;
                  var impactCls = impact === 'high' ? 'high' : impact === 'medium' ? 'med' : '';
                  return '<div class="detail-news-item">' +
                    (impactCls ? '<span class="detail-news-dot ' + impactCls + '"></span>' : '<span class="detail-news-dot"></span>') +
                    '<span class="detail-news-title">' + escHtml(String(title).slice(0, 80)) + '</span>' +
                    (impact ? '<div class="detail-news-impact">' + escHtml(impact) + '</div>' : '') +
                  '</div>';
                }).join('') +
              '</div>';
            } else {
              sectionHtml += '<div class="detail-section-label">市場コンテキスト</div>';
            }

            // 指標バー（共通）
            if (d.vix != null || d.us10y != null || d.nikkei != null || d.sp500 != null) {
              sectionHtml += '<div class="detail-indicator-bar">' +
                (d.vix != null ? '<div class="detail-ind"><span class="detail-ind-label">VIX</span><span class="detail-ind-val' + (d.vix >= 25 ? ' warn' : '') + '">' + fmt(d.vix, 1) + '</span></div>' : '') +
                (d.us10y != null ? '<div class="detail-ind"><span class="detail-ind-label">米10Y</span><span class="detail-ind-val">' + fmt(d.us10y, 2) + '%</span></div>' : '') +
                (d.nikkei != null ? '<div class="detail-ind"><span class="detail-ind-label">日経</span><span class="detail-ind-val">' + fmt(d.nikkei, 0) + '</span></div>' : '') +
                (d.sp500 != null ? '<div class="detail-ind"><span class="detail-ind-label">S&P</span><span class="detail-ind-val">' + fmt(d.sp500, 0) + '</span></div>' : '') +
              '</div>';
            }

            // Path A: ニュースがあれば「参考ニュース」として控えめに表示
            if (!hasPathBNews && newsArr.length > 0) {
              sectionHtml += '<div class="detail-news-ref">' +
                '<span class="detail-news-ref-label">参考ニュース（判断時点）</span>' +
                newsArr.slice(0, 2).map(function(n) {
                  var title = n.title_ja || n.title || (typeof n === 'string' ? n : String(n));
                  return '<div class="detail-news-ref-item">' + escHtml(String(title).slice(0, 60)) + '</div>';
                }).join('') +
              '</div>';
            }

            sectionHtml += '</div>';
            return sectionHtml;
          })() +

          // ── セクション4: フッター（トリガー + 結果 + 時刻） ──
          '<div class="detail-footer">' +
            '<div class="detail-footer-left">' +
              '<span class="tl-chip ' + trigger + '" style="font-size:10px">' + escHtml(triggerLabel(trigger)) + '</span>' +
              '<span class="detail-footer-time">' + fmtTimeHMS(d.created_at) + '</span>' +
            '</div>' +
            '<div class="tl-result">' +
              '<div class="result-dot ' + resultKey + '"></div>' +
              '<span class="tl-result-text ' + resultKey + '">' + resultText + resultPnl + '</span>' +
            '</div>' +
          '</div>' +

        '</div>' +
      '</div>';
    }).join('');

    // タップでパネル展開（イベント委譲）
    timeline.onclick = function(e) {
      var card = e.target.closest('[data-ai-idx]');
      if (!card) return;
      var idx   = card.dataset.aiIdx;
      var panel = el('ai-detail-' + idx);
      if (!panel) return;
      var isOpen = card.classList.contains('expanded');
      timeline.querySelectorAll('.tl-card.expanded').forEach(function(c) {
        c.classList.remove('expanded');
        var p = c.querySelector('.detail-panel');
        if (p) p.classList.remove('open');
      });
      if (!isOpen) {
        card.classList.add('expanded');
        panel.classList.add('open');
      }
    };
  }

  function openNewsSheet(d) {
    var bc = d.decision === 'BUY' ? 'badge-buy' : d.decision === 'SELL' ? 'badge-sell' : 'badge-hold';
    el('sheet-title').innerHTML =
      '<span class="decision-pair" style="font-size:16px">' + escHtml(d.pair || '') + '</span> ' +
      '<span class="badge ' + bc + '" style="font-size:13px">' + d.decision + '</span>';

    var rows = '';
    rows += sheetRow('日時', fmtTime(d.created_at));
    if (d.vix != null)   rows += sheetRow('VIX',     fmt(d.vix, 1));
    if (d.us10y != null) rows += sheetRow('米10年債', fmt(d.us10y, 2) + '%');

    if (d.reasoning) {
      rows += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--separator)">' +
        '<div style="font-size:12px;color:var(--label-secondary);margin-bottom:6px">AI判断理由</div>' +
        '<div style="font-size:14px;line-height:1.6;color:var(--label)">' + escHtml(d.reasoning) + '</div>' +
        '</div>';
    }

    if (d.news_summary) {
      // news_summaryをパースしてタイトルリストに変換（多重エンコード対応）
      var newsItems = [];
      try {
        var raw = d.news_summary;
        // 最大3回パースを試行（多重エンコード対応）
        for (var attempt = 0; attempt < 3 && typeof raw === 'string'; attempt++) {
          try { raw = JSON.parse(raw); } catch(e) { break; }
        }
        if (Array.isArray(raw)) {
          // 各アイテムのtitleもJSON文字列の場合があるので展開
          raw.forEach(function(item) {
            if (typeof item === 'string') {
              newsItems.push({ title: item });
            } else if (item.title && item.title.charAt(0) === '[') {
              try {
                var inner = JSON.parse(item.title);
                if (Array.isArray(inner)) inner.forEach(function(i) { newsItems.push(i); });
                else newsItems.push(item);
              } catch(e) { newsItems.push(item); }
            } else {
              newsItems.push(item);
            }
          });
        }
      } catch(e) {
        newsItems = d.news_summary.split(' | ').map(function(t) { return { title: t.trim() }; });
      }
      if (newsItems.length > 0) {
        rows += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--separator)">' +
          '<div style="font-size:12px;color:var(--label-secondary);margin-bottom:6px">参照ニュース</div>' +
          newsItems.slice(0, 5).map(function(n) {
            return '<div style="font-size:12px;line-height:1.5;color:var(--label);padding:4px 0;border-bottom:1px solid var(--separator)">• ' + escHtml(n.title || '') + '</div>';
          }).join('') +
          '</div>';
      }
    }

    el('sheet-body').innerHTML = rows;
    var sheet = el('sheet');
    sheet.style.transform = '';
    lockScroll();
    sheet.classList.add('open');
    el('sheet-backdrop').classList.add('visible');
  }

  function sheetRow(label, val) {
    return '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--separator)">' +
      '<span style="font-size:14px;color:var(--label-secondary)">' + label + '</span>' +
      '<span style="font-size:14px;color:var(--label)">' + val + '</span>' +
    '</div>';
  }

  // ── データ取得 ──
  function refresh() {
    fetch('/api/status')
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        render(data);
        el('last-updated').textContent =
          new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' 更新';
      })
      .catch(function() {
        el('last-updated').textContent = '更新失敗';
      });
  }

  // ── イベントリスナー ──
  var btn = el('refresh-btn');
  if (btn) {
    btn.addEventListener('click', function() {
      btn.classList.add('spinning');
      setTimeout(function() { btn.classList.remove('spinning'); }, 700);
      // ページ自体をハードリロード（キャッシュ無効化）
      location.reload();
    });
  }

  // テーマ切替
  var themeBtn = el('theme-btn');
  var sunIcon = el('theme-icon-sun');
  var moonIcon = el('theme-icon-moon');
  function updateThemeIcon(theme) {
    if (!sunIcon || !moonIcon) return;
    // ダークモード時: 太陽アイコン（ライトに切替）、ライトモード時: 月アイコン（ダークに切替）
    sunIcon.style.display = theme === 'light' ? 'none' : '';
    moonIcon.style.display = theme === 'light' ? '' : 'none';
  }
  if (themeBtn) {
    var savedTheme = localStorage.getItem('fx-theme');
    if (savedTheme) {
      document.documentElement.setAttribute('data-theme', savedTheme);
      updateThemeIcon(savedTheme);
    }
    themeBtn.addEventListener('click', function() {
      var current = document.documentElement.getAttribute('data-theme');
      var next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('fx-theme', next);
      updateThemeIcon(next);
    });
  }

  // 通知許可リクエスト
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // PC: viewport動的変更（タブレット以上ではズーム許可）
  function updateViewport() {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    if (window.innerWidth >= 769) {
      meta.setAttribute('content', 'width=device-width, initial-scale=1.0');
    } else {
      meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
    }
  }
  updateViewport();

  // PC: リサイズ時のレイアウト再描画
  var resizeTimer;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() {
      updateViewport();
      if (lastData) {
        renderWatchlist(lastData);
        renderPanel(lastData);
      }
    }, 250);
  });

  refresh();
  setInterval(refresh, 30000);

  // ─── パラメーター管理 (/api/params) ───────────────────────────────────────

  var paramsData = null;
  var paramsTabActive = 'current';

  // タブ切り替え（HTMLから呼ばれる）
  window.showParamsTab = function(tab) {
    paramsTabActive = tab;
    var cur = el('params-current');
    var hist = el('params-history');
    var btnC = el('params-tab-current');
    var btnH = el('params-tab-history');
    if (cur)  cur.style.display  = tab === 'current'  ? 'block' : 'none';
    if (hist) hist.style.display = tab === 'history'  ? 'block' : 'none';
    if (btnC) { btnC.classList.toggle('active', tab === 'current'); }
    if (btnH) { btnH.classList.toggle('active', tab === 'history'); }
    if (paramsData) renderParamsData(paramsData);
  };

  function loadParams() {
    fetch('/api/params')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        paramsData = d;
        var loading = el('params-loading');
        if (loading) loading.style.display = 'none';
        renderEmergencyBanner(d.latestEmergency);
        renderParamsData(d);
        renderParamsPanelReview(d);
      })
      .catch(function(e) {
        var loading = el('params-loading');
        if (loading) loading.textContent = 'データ取得失敗';
      });
  }

  // ─── 因果サマリー描画（Task 3-B） ──────────────────────────────────────────

  // ─── ヒートマップ描画（Task 6） ──────────────────────────────────────────

  function heatmapColor(val, key) {
    if (key === 'pnl_closed') {
      if (val > 0) return 'rgba(48,209,88,' + Math.min(Math.abs(val) / 500, 0.6) + ')';
      if (val < 0) return 'rgba(255,69,58,' + Math.min(Math.abs(val) / 500, 0.6) + ')';
      return 'transparent';
    }
    if (key === 'vix_effect') {
      return val > 0 ? 'rgba(255,159,10,' + Math.min(val, 0.6) + ')' : 'transparent';
    }
    if (key === 'param_changed') {
      return val > 0 ? 'rgba(10,132,255,0.3)' : 'transparent';
    }
    if (key === 'news_impact') {
      return val > 0 ? 'rgba(255,69,58,' + Math.min(val / 100 * 0.6, 0.6) + ')' : 'transparent';
    }
    return 'transparent';
  }

  function heatmapLabel(val, key) {
    if (key === 'pnl_closed') return val !== 0 ? (val > 0 ? '+' : '') + Math.round(val) : '\\u2014';
    if (key === 'vix_effect') return val > 0 ? val.toFixed(1) : '\\u2014';
    if (key === 'param_changed') return val > 0 ? '\\u2713' : '\\u2014';
    if (key === 'news_impact') return val > 0 ? Math.round(val) : '\\u2014';
    return '\\u2014';
  }

  function renderHeatmap(heatmapData) {
    var hmEl = document.getElementById('causal-heatmap');
    if (!hmEl) return;
    if (!heatmapData || heatmapData.length === 0) {
      hmEl.style.display = 'none';
      return;
    }
    hmEl.style.display = '';

    var cols = ['\\u9298\\u67C4', 'PnL', 'VIX', 'PR', '\\u30CB\\u30E5\\u30FC\\u30B9'];
    var keys = ['pnl_closed', 'vix_effect', 'param_changed', 'news_impact'];

    var html = '<div class="heatmap-grid" style="grid-template-columns: auto repeat(' + keys.length + ', 1fr)">';

    for (var h = 0; h < cols.length; h++) {
      html += '<div class="hm-header">' + cols[h] + '</div>';
    }

    for (var i = 0; i < heatmapData.length; i++) {
      var row = heatmapData[i];
      html += '<div class="hm-pair">' + row.pair + '</div>';
      for (var k = 0; k < keys.length; k++) {
        var val = (row.factors && row.factors[keys[k]]) || 0;
        var bg = heatmapColor(val, keys[k]);
        html += '<div class="hm-cell" style="background:' + bg + '">' + heatmapLabel(val, keys[k]) + '</div>';
      }
    }
    html += '</div>';
    hmEl.innerHTML = html;
  }

  function renderCausalSummary(data) {
    var section = document.getElementById('causal-summary');
    if (!section) return;
    var cs = data.causalSummary;
    if (!cs) { section.style.display = 'none'; return; }
    section.style.display = '';

    // ナラティブ
    var narEl = document.getElementById('causal-narrative');
    if (narEl) narEl.textContent = cs.narrative || '';

    // キードライバー — profitTop
    var profitEl = document.getElementById('causal-profit-top');
    if (profitEl) {
      if (cs.drivers && cs.drivers.profitTop) {
        var p = cs.drivers.profitTop;
        profitEl.innerHTML = '<div class="driver-label">\\u5229\\u76CATop</div>' +
          '<div class="driver-pair">' + p.pair + '</div>' +
          '<div class="driver-pnl positive">+' + Math.round(p.pnl) + '\\u5186</div>' +
          '<div class="driver-reason">' + (p.reason || '') + '</div>';
        profitEl.style.display = '';
        profitEl.onclick = function() { switchTab('tab-stats', 'perf-' + p.pair.replace(/[\\/\\s]/g, '-')); };
      } else {
        profitEl.style.display = 'none';
      }
    }

    // キードライバー — lossTop
    var lossEl = document.getElementById('causal-loss-top');
    if (lossEl) {
      if (cs.drivers && cs.drivers.lossTop) {
        var l = cs.drivers.lossTop;
        lossEl.innerHTML = '<div class="driver-label">\\u640D\\u5931Top</div>' +
          '<div class="driver-pair">' + l.pair + '</div>' +
          '<div class="driver-pnl negative">' + Math.round(l.pnl) + '\\u5186</div>' +
          '<div class="driver-reason">' + (l.reason || '') + '</div>';
        lossEl.style.display = '';
        lossEl.onclick = function() { switchTab('tab-stats', 'perf-' + l.pair.replace(/[\\/\\s]/g, '-')); };
      } else {
        lossEl.style.display = 'none';
      }
    }

    // 要因バッジ (factors)
    var tabMap = {
      'vix': 'tab-strategy',
      'macro': 'tab-strategy',
      'param_review': 'tab-strategy',
      'news': 'tab-ai',
      'trailing': 'tab-stats',
      'delisted': 'tab-log'
    };
    var scrollMap = {
      'vix': '',
      'macro': '',
      'param_review': 'review-history',
      'news': 'news-analysis',
      'trailing': '',
      'delisted': ''
    };
    var factorsEl = document.getElementById('causal-factors');
    if (factorsEl && cs.drivers && cs.drivers.factors) {
      factorsEl.innerHTML = cs.drivers.factors.map(function(f) {
        var cls = f.severity === 'high' ? 'factor-high' : f.severity === 'medium' ? 'factor-medium' : 'factor-low';
        var targetTab = tabMap[f.type] || 'tab-log';
        var targetScroll = scrollMap[f.type] || '';
        return '<span class="factor-badge ' + cls + '" onclick="switchTab(\\'' + targetTab + '\\', \\'' + targetScroll + '\\')">' + f.label + '</span>';
      }).join('');
    }

    // ヒートマップ
    renderHeatmap(cs.heatmap);
  }

  // ─── 警報バナー描画（Task 4-B） ──────────────────────────────────────────

  function renderAlertBanner(data) {
    var container = document.getElementById('alert-banner-container');
    if (!container) return;
    var alerts = [];

    // DD 警告（赤）
    if (data.riskStatus && data.riskStatus.killSwitchActive) {
      alerts.push({ cls: 'red', text: '\\u26A0\\uFE0F DD STOP \\u2014 \\u65E5\\u6B21\\u640D\\u5931\\u4E0A\\u9650\\u8D85\\u904E\\u3002\\u65B0\\u898F\\u30A8\\u30F3\\u30C8\\u30EA\\u30FC\\u505C\\u6B62\\u4E2D' });
    }
    // DD 注意（オレンジ）
    else if (data.riskStatus && data.riskStatus.maxDailyLoss > 0 &&
             data.riskStatus.todayLoss / data.riskStatus.maxDailyLoss > 0.8) {
      var pct = Math.round(data.riskStatus.todayLoss / data.riskStatus.maxDailyLoss * 100);
      alerts.push({ cls: 'orange', text: '\\u26A1 DD\\u6CE8\\u610F \\u2014 \\u65E5\\u6B21\\u640D\\u5931\\u304C\\u4E0A\\u9650\\u306E' + pct + '%\\u306B\\u5230\\u9054' });
    }

    // 緊急ニュース（赤）
    if (data.newsAnalysis) {
      var now = Date.now();
      var tenMin = 10 * 60 * 1000;
      data.newsAnalysis.forEach(function(n) {
        if (n.attention && n.analyzed_at) {
          var diff = now - new Date(n.analyzed_at).getTime();
          if (diff < tenMin) {
            alerts.push({ cls: 'red', text: '\\uD83D\\uDD34 \\u7DCA\\u6025\\u30CB\\u30E5\\u30FC\\u30B9: ' + (n.title_ja || n.title || '\\u901F\\u5831') });
          }
        }
      });
    }

    // システムエラー（オレンジ）
    if (data.systemLogs) {
      var recentErrors = data.systemLogs.slice(0, 5).filter(function(l) { return l.level === 'ERROR'; });
      if (recentErrors.length > 0) {
        alerts.push({ cls: 'orange', text: '\\uD83D\\uDD27 \\u30B7\\u30B9\\u30C6\\u30E0\\u30A8\\u30E9\\u30FC\\u691C\\u51FA: ' + recentErrors[0].message });
      }
    }

    // 孤立ポジション（黄）
    if (data.causalSummary && data.causalSummary.drivers && data.causalSummary.drivers.factors) {
      var delisted = data.causalSummary.drivers.factors.filter(function(f) { return f.type === 'delisted'; });
      if (delisted.length > 0) {
        alerts.push({ cls: 'yellow', text: '\\u26A0 \\u5B64\\u7ACB\\u30DD\\u30B8\\u30B7\\u30E7\\u30F3: ' + delisted[0].label });
      }
    }

    // 表示
    if (alerts.length === 0) {
      container.style.display = 'none';
      return;
    }
    container.style.display = '';
    container.innerHTML = alerts.map(function(a) {
      return '<div class="alert-banner alert-' + a.cls + '">' + a.text + '</div>';
    }).join('');
  }

  // ─── 緊急ニュースバナー（4-B） ─────────────────────────────────────────────

  function renderEmergencyBanner(emergency) {
    var banner = el('emergency-news-banner');
    if (!banner) return;
    if (!emergency || !emergency.created_at) return;

    var now = Date.now();
    var createdMs = new Date(emergency.created_at).getTime();
    var ageMs = now - createdMs;
    var TEN_MIN = 10 * 60 * 1000;

    if (ageMs > TEN_MIN) return; // 10分以上経過ならバナー非表示

    // タイトルを設定
    var titleEl = banner.querySelector('.emergency-news-title');
    if (titleEl) titleEl.textContent = emergency.news_title || '緊急ニュース検出';

    // バナー表示
    banner.classList.add('visible');
    banner.classList.remove('fading');

    // 残り時間後に自動非表示
    var remainMs = TEN_MIN - ageMs;
    setTimeout(function() {
      banner.classList.add('fading');
      setTimeout(function() {
        banner.classList.remove('visible');
        banner.classList.remove('fading');
      }, 800);
    }, remainMs);
  }

  // ─── パラメーターカード展開トグル（4-C） ──────────────────────────────────

  window.toggleParamCard = function(pair) {
    var storageKey = 'param-expanded-cards';
    var expanded = {};
    try { expanded = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch {}

    var cardDetail = document.querySelector('[data-param-detail="' + pair + '"]');
    var chevron    = document.querySelector('[data-param-chevron="' + pair + '"]');
    if (!cardDetail) return;

    var isExpanded = expanded[pair] === true;
    if (isExpanded) {
      expanded[pair] = false;
      cardDetail.classList.remove('expanded');
      if (chevron) chevron.style.transform = 'rotate(0deg)';
    } else {
      expanded[pair] = true;
      cardDetail.classList.add('expanded');
      if (chevron) chevron.style.transform = 'rotate(180deg)';
    }
    try { localStorage.setItem(storageKey, JSON.stringify(expanded)); } catch {}
  };

  // ─── カテゴリアコーディオン（4-D） ────────────────────────────────────────

  window.toggleParamCat = function(cat) {
    var storageKey = 'param-collapsed-cats';
    var collapsed = {};
    try { collapsed = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch {}

    var header = document.querySelector('[data-cat-header="' + cat + '"]');
    var body   = document.querySelector('[data-cat-body="' + cat + '"]');
    if (!header || !body) return;

    var isCollapsed = collapsed[cat] === true;
    if (isCollapsed) {
      collapsed[cat] = false;
      header.classList.remove('collapsed');
      body.classList.remove('collapsed');
    } else {
      collapsed[cat] = true;
      header.classList.add('collapsed');
      body.classList.add('collapsed');
    }
    try { localStorage.setItem(storageKey, JSON.stringify(collapsed)); } catch {}
  };

  // ─── 現在パラメーター表 ───────────────────────────────────────────────────

  // パラメーター名 → 表示ラベル + 小数桁
  var PARAM_COLS = [
    { key: 'rsi_oversold',      label: 'RSI売られ',  dp: 0 },
    { key: 'rsi_overbought',    label: 'RSI買われ',  dp: 0 },
    { key: 'adx_min',           label: 'ADX最小',    dp: 0 },
    { key: 'atr_tp_multiplier', label: 'TP倍率',     dp: 1 },
    { key: 'atr_sl_multiplier', label: 'SL倍率',     dp: 1 },
    { key: 'vix_max',           label: 'VIX上限',    dp: 0 },
    { key: 'param_version',     label: 'Ver',        dp: 0 },
    { key: 'trades_since_review', label: '次Revまで', dp: 0, isProgress: true },
  ];

  function fmt(v, dp) {
    if (v == null) return '—';
    return Number(v).toFixed(dp);
  }

  function rrColor(rr) {
    if (rr == null) return '';
    if (rr >= 2.0) return 'color:#34c759';
    if (rr >= 1.5) return 'color:#ff9500';
    return 'color:#ff3b30';
  }

  function diffBadge(oldVal, newVal, dp) {
    if (oldVal == null || newVal == null) return '';
    var diff = newVal - oldVal;
    if (Math.abs(diff) < 0.001) return '<span style="color:var(--label-secondary);font-size:10px"> (変化なし)</span>';
    var pct = oldVal !== 0 ? Math.round(diff / Math.abs(oldVal) * 100) : 0;
    var color = diff > 0 ? '#34c759' : '#ff3b30';
    var sign = diff > 0 ? '+' : '';
    return '<span style="color:' + color + ';font-size:10px;font-weight:600"> (' + sign + pct + '%)</span>';
  }

  function renderCurrentParams(params) {
    var wrap = el('params-table-wrap');
    if (!wrap || !params || params.length === 0) return;

    // localStorage から展開状態・カテゴリ折りたたみ状態を復元
    var expandedCards = {};
    var collapsedCats = {};
    try { expandedCards = JSON.parse(localStorage.getItem('param-expanded-cards') || '{}'); } catch {}
    try { collapsedCats = JSON.parse(localStorage.getItem('param-collapsed-cats') || '{}'); } catch {}

    var NOW_MS = Date.now();
    var TWELVE_H = 12 * 60 * 60 * 1000;

    var categories = {
      '為替':       ['USD/JPY','EUR/USD','GBP/USD','AUD/USD'],
      '株式指数':   ['S&P500','NASDAQ','Nikkei225','DAX'],
      '暗号資産':   ['BTC/USD','ETH/USD','SOL/USD'],
      'コモディティ':['Gold','Silver','CrudeOil'],
      '債券':       ['US10Y'],
    };
    var catOrder = ['為替','株式指数','暗号資産','コモディティ','債券'];
    var pairMap = {};
    params.forEach(function(p) { pairMap[p.pair] = p; });

    var html = '';

    catOrder.forEach(function(cat) {
      var pairs = categories[cat] || [];
      var catParams = pairs.map(function(pair) { return pairMap[pair]; }).filter(Boolean);
      if (catParams.length === 0) return;

      var isCatCollapsed = collapsedCats[cat] === true;
      var catId = encodeURIComponent(cat);

      html +=
        '<div class="param-category-header' + (isCatCollapsed ? ' collapsed' : '') + '" ' +
          'data-cat-header="' + catId + '" ' +
          'onclick="toggleParamCat(&quot;' + catId + '&quot;)">' +
          '<span class="param-category-title">' + escHtml(cat) + '</span>' +
          '<span class="param-category-chevron">▼</span>' +
        '</div>' +
        '<div class="param-category-body' + (isCatCollapsed ? ' collapsed' : '') + '" ' +
          'data-cat-body="' + catId + '">';

      catParams.forEach(function(p) {
        var rrVal = p.atr_sl_multiplier > 0 ? p.atr_tp_multiplier / p.atr_sl_multiplier : 0;
        var rrStyle = rrVal >= 2.0 ? 'color:var(--green);font-weight:700' : 'color:var(--red);font-weight:700';

        // 進捗バー（Goal Gradient）
        var remainTrades = Math.max(0, (p.review_trade_count || 0) - (p.trades_since_review || 0));
        var total = p.review_trade_count || 1;
        var remainPct = Math.min(100, Math.round(remainTrades / total * 100));
        var progressClass = remainPct > 60 ? 'progress-normal' : remainPct > 20 ? 'progress-warning' : 'progress-urgent';

        // バッジ（Variable Reward）
        var verBadge;
        if (p.param_version >= 2) {
          var lastReviewedMs = p.last_reviewed_at ? new Date(p.last_reviewed_at).getTime() : 0;
          var isRecent = (NOW_MS - lastReviewedMs) < TWELVE_H;
          if (isRecent) {
            verBadge = '<span class="badge-upgraded">UPGRADED</span>';
          } else {
            verBadge = '<span class="badge-version">v' + p.param_version + '</span>';
          }
        } else {
          verBadge = '<span class="badge-version" style="opacity:0.5">v1</span>';
        }

        var reviewedLabel = p.reviewed_by === 'INITIAL'
          ? '<span style="color:var(--label-tertiary);font-size:10px">初期値</span>'
          : '<span style="color:var(--blue);font-size:10px">AI調整済</span>';
        var lastAt = p.last_reviewed_at ? p.last_reviewed_at.slice(0, 10) : '未レビュー';
        var pairKey = p.pair;
        var isExpanded = expandedCards[pairKey] === true;

        html +=
          '<div class="param-card">' +
            // 概要行（常に表示）
            '<div class="param-card-summary" onclick="toggleParamCard(&quot;' + escHtml(pairKey) + '&quot;)">' +
              '<span style="font-size:13px;font-weight:600;flex:1">' + escHtml(p.pair) + '</span>' +
              verBadge +
              '<span style="margin-left:6px">' + reviewedLabel + '</span>' +
              '<span style="font-size:12px;' + rrStyle + ';margin-left:6px">RR ' + rrVal.toFixed(2) + '</span>' +
              '<span style="font-size:10px;color:var(--label-tertiary);margin-left:6px">' + remainTrades + '件</span>' +
              '<span class="param-chevron" data-param-chevron="' + escHtml(pairKey) + '" ' +
                'style="transform:rotate(' + (isExpanded ? '180' : '0') + 'deg)">▼</span>' +
            '</div>' +
            // 進捗バー
            '<div class="param-progress-track">' +
              '<div class="param-progress-fill ' + progressClass + '" style="width:' + remainPct + '%"></div>' +
            '</div>' +
            // 詳細（折りたたみ）
            '<div class="param-card-detail' + (isExpanded ? ' expanded' : '') + '" ' +
              'data-param-detail="' + escHtml(pairKey) + '">' +
              '<div class="param-detail-inner">' +
                '<div class="param-grid-6">' +
                  '<div class="param-grid-cell">' +
                    '<div class="cell-label">RSI売られ</div>' +
                    '<div class="cell-value">' + fmt(p.rsi_oversold, 0) + '</div>' +
                  '</div>' +
                  '<div class="param-grid-cell">' +
                    '<div class="cell-label">RSI買われ</div>' +
                    '<div class="cell-value">' + fmt(p.rsi_overbought, 0) + '</div>' +
                  '</div>' +
                  '<div class="param-grid-cell">' +
                    '<div class="cell-label">ADX最小</div>' +
                    '<div class="cell-value">' + fmt(p.adx_min, 0) + '</div>' +
                  '</div>' +
                  '<div class="param-grid-cell">' +
                    '<div class="cell-label">TP倍率</div>' +
                    '<div class="cell-value">' + fmt(p.atr_tp_multiplier, 1) + '</div>' +
                  '</div>' +
                  '<div class="param-grid-cell">' +
                    '<div class="cell-label">SL倍率</div>' +
                    '<div class="cell-value">' + fmt(p.atr_sl_multiplier, 1) + '</div>' +
                  '</div>' +
                  '<div class="param-grid-cell">' +
                    '<div class="cell-label">VIX上限</div>' +
                    '<div class="cell-value">' + fmt(p.vix_max, 0) + '</div>' +
                  '</div>' +
                '</div>' +
                '<div class="param-last-review">最終レビュー: ' + escHtml(lastAt) + '</div>' +
              '</div>' +
            '</div>' +
          '</div>';
      });

      html += '</div>'; // param-category-body
    });

    wrap.innerHTML = html;
  }

  // ─── 変更履歴 ─────────────────────────────────────────────────────────────

  function renderParamsHistory(history) {
    var listEl = el('params-history-list');
    if (!listEl) return;
    if (!history || history.length === 0) {
      listEl.innerHTML = '<p style="color:var(--label-secondary);font-size:12px;padding:8px 0">レビュー履歴がありません</p>';
      return;
    }

    var PARAM_LABELS = {
      rsi_oversold: 'RSI売られ', rsi_overbought: 'RSI買われ',
      adx_min: 'ADX最小', atr_tp_multiplier: 'TP倍率', atr_sl_multiplier: 'SL倍率',
      vix_max: 'VIX上限',
    };

    var html = '';
    history.forEach(function(h) {
      var oldP = {};
      var newP = {};
      try { oldP = JSON.parse(h.old_params); } catch {}
      try { newP = JSON.parse(h.new_params); } catch {}

      var winPct  = Math.round((h.win_rate || 0) * 100);
      var winColor = winPct >= 50 ? 'var(--green)' : winPct >= 40 ? 'var(--orange)' : 'var(--red)';
      var rrVal   = h.actual_rr || 0;
      var rrCol   = rrVal >= 2.0 ? 'var(--green)' : rrVal >= 1.5 ? 'var(--orange)' : 'var(--red)';
      var pfVal   = h.profit_factor || 0;
      var pfCol   = pfVal >= 1.5 ? 'var(--green)' : pfVal >= 1.0 ? 'var(--orange)' : 'var(--red)';

      // 変化ありパラメーターを列挙（差分バッジサイズ分岐: ≥15%で大きく太字）
      var changedKeys = Object.keys(newP).filter(function(k) {
        return Math.abs((newP[k] || 0) - (oldP[k] || 0)) > 0.001;
      });

      var diffHtml = changedKeys.length === 0
        ? '<span style="color:var(--label-secondary);font-size:11px">変化なし（様子見）</span>'
        : changedKeys.map(function(k) {
            var diff = (newP[k] || 0) - (oldP[k] || 0);
            var pct  = oldP[k] !== 0 ? Math.round(diff / Math.abs(oldP[k]) * 100) : 0;
            var c    = diff > 0 ? 'var(--green)' : 'var(--red)';
            var sign = diff > 0 ? '▲' : '▼';
            // ≥15%変化: font-size:12px・font-weight:700（大きく太字）
            var isBig = Math.abs(pct) >= 15;
            return '<span style="display:inline-flex;align-items:center;gap:3px;' +
              'background:var(--bg-secondary);border-radius:6px;padding:2px 7px;' +
              'font-size:11px;margin:2px">' +
              escHtml(PARAM_LABELS[k] || k) + ' ' +
              '<span style="color:' + c + ';' +
                (isBig ? 'font-size:12px;font-weight:700' : 'font-weight:600') + '">' +
                sign + ' ' + Math.abs(pct) + '%' +
              '</span>' +
              '</span>';
          }).join('');

      html +=
        '<div style="background:var(--bg-secondary);border-radius:12px;padding:12px;margin-bottom:10px">' +

          // 1. ヘッダー: ペア + バージョン + 日時
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
            '<div style="display:flex;align-items:center;gap:6px">' +
              '<span style="font-size:13px;font-weight:700">' + escHtml(h.pair) + '</span>' +
              '<span class="badge-version">v' + (h.param_version || 1) + '</span>' +
            '</div>' +
            '<span style="font-size:11px;color:var(--label-secondary)">' +
              escHtml((h.created_at || '').slice(0, 16).replace('T', ' ')) +
            '</span>' +
          '</div>' +

          // 2. AI判断理由（Peak-End則: 最上段・強調表示）
          '<div class="param-reason-block">' +
            '<div class="param-reason-label">🤖 AI判断理由</div>' +
            escHtml(h.reason || '—') +
          '</div>' +

          // 3. 変更内容
          '<div style="margin-bottom:10px">' +
            '<div style="font-size:10px;color:var(--label-secondary);font-weight:600;' +
              'text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">変更内容</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:0">' + diffHtml + '</div>' +
          '</div>' +

          // 4. 評価実績グリッド
          '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px">' +
            '<div style="text-align:center;background:var(--bg-tertiary);border-radius:8px;padding:6px">' +
              '<div style="font-size:9px;color:var(--label-secondary)">評価Tr数</div>' +
              '<div style="font-size:14px;font-weight:700">' + (h.trades_eval || 0) + '</div>' +
            '</div>' +
            '<div style="text-align:center;background:var(--bg-tertiary);border-radius:8px;padding:6px">' +
              '<div style="font-size:9px;color:var(--label-secondary)">勝率</div>' +
              '<div style="font-size:14px;font-weight:700;color:' + winColor + '">' + winPct + '%</div>' +
            '</div>' +
            '<div style="text-align:center;background:var(--bg-tertiary);border-radius:8px;padding:6px">' +
              '<div style="font-size:9px;color:var(--label-secondary)">実RR</div>' +
              '<div style="font-size:14px;font-weight:700;color:' + rrCol + '">' + rrVal.toFixed(2) + '</div>' +
            '</div>' +
            '<div style="text-align:center;background:var(--bg-tertiary);border-radius:8px;padding:6px">' +
              '<div style="font-size:9px;color:var(--label-secondary)">Profit Factor</div>' +
              '<div style="font-size:14px;font-weight:700;color:' + pfCol + '">' + pfVal.toFixed(2) + '</div>' +
            '</div>' +
          '</div>' +

        '</div>';
    });
    listEl.innerHTML = html;
  }

  // ─── PC右パネル: 最新レビューサマリー ────────────────────────────────────

  function renderParamsPanelReview(d) {
    var panelEl = el('panel-params-review');
    if (!panelEl) return;
    var history = d.history || [];
    if (history.length === 0) {
      panelEl.innerHTML = '<p style="padding:12px;color:var(--label-secondary);font-size:12px">まだレビューなし</p>';
      return;
    }
    // 最新3件を表示
    var html = '';
    history.slice(0, 3).forEach(function(h) {
      var winPct = Math.round((h.win_rate || 0) * 100);
      var winColor = winPct >= 50 ? '#34c759' : '#ff3b30';
      var rrVal = h.actual_rr || 0;
      var rrCol = rrVal >= 2.0 ? '#34c759' : '#ff9500';
      html +=
        '<div style="padding:10px 16px;border-bottom:0.5px solid var(--separator)">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' +
            '<span style="font-size:13px;font-weight:600">' + h.pair + '</span>' +
            '<span style="font-size:10px;color:var(--label-secondary)">' + (h.created_at || '').slice(0, 10) + '</span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--label-secondary);line-height:1.4;margin-bottom:6px">' + escHtml((h.reason || '').slice(0, 80)) + (h.reason && h.reason.length > 80 ? '…' : '') + '</div>' +
          '<div style="display:flex;gap:12px">' +
            '<span style="font-size:11px">勝率 <strong style="color:' + winColor + '">' + winPct + '%</strong></span>' +
            '<span style="font-size:11px">RR <strong style="color:' + rrCol + '">' + rrVal.toFixed(2) + '</strong></span>' +
            '<span style="font-size:11px">PF <strong>' + (h.profit_factor || 0).toFixed(2) + '</strong></span>' +
          '</div>' +
        '</div>';
    });
    panelEl.innerHTML = html;
  }

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderParamsData(d) {
    if (paramsTabActive === 'current') renderCurrentParams(d.params);
    else renderParamsHistory(d.history);
  }

  // 戦略タブがアクティブになった時にロード（遅延ロード）
  document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-tab="tab-strategy"]');
    if (btn && !paramsData) loadParams();
  });

  // 初回ロード時に戦略タブが選択済みなら即ロード
  if (document.querySelector('#tab-strategy.active') || document.querySelector('.tab-item.active[data-tab="tab-strategy"]')) {
    loadParams();
  }

  // 30秒ごとにパラメーターも更新
  setInterval(function() {
    if (paramsData) loadParams();
  }, 60000);

})();
`;

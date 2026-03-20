// ダッシュボード フロントエンド JS
// iPhone「株価」アプリ風 — 3タブ / スパークライン / TP祝福 / ボトムシート

export const JS = `
(function () {
  'use strict';

  var SHOW_INITIAL = 5;
  var historyExpanded = false;
  var lastData = null;
  var lastRecentCloseIds = [];
  var sheetPos = null;
  var lastPnlMap = {};  // PnLバッジ変化検出用 { pair: pnlText }

  // カテゴリ表示順（新カテゴリ追加時はここに足すだけ）
  var CATEGORY_ORDER = ['為替', '株式指数', '暗号資産', 'コモディティ', '債券'];

  // 銘柄設定（順番は気にしなくてOK — categoryで自動ソート）
  var INSTRUMENTS = [
    { pair: 'USD/JPY',   label: 'USD / JPY', unit: '円', multiplier: 100,   category: '為替' },
    { pair: 'EUR/USD',   label: 'EUR / USD', unit: '円', multiplier: 10000, category: '為替' },
    { pair: 'GBP/USD',   label: 'GBP / USD', unit: '円', multiplier: 10000, category: '為替' },
    { pair: 'AUD/USD',   label: 'AUD / USD', unit: '円', multiplier: 10000, category: '為替' },
    { pair: 'S&P500',    label: 'S&P 500',   unit: '円', multiplier: 10,    category: '株式指数' },
    { pair: 'NASDAQ',    label: 'NASDAQ',    unit: '円', multiplier: 1,     category: '株式指数' },
    { pair: 'Nikkei225', label: '日経225',    unit: '円', multiplier: 1,     category: '株式指数' },
    { pair: 'DAX',       label: 'DAX',       unit: '円', multiplier: 1,     category: '株式指数' },
    { pair: 'BTC/USD',   label: 'BTC',       unit: '円', multiplier: 1,     category: '暗号資産' },
    { pair: 'ETH/USD',   label: 'ETH',       unit: '円', multiplier: 1,     category: '暗号資産' },
    { pair: 'SOL/USD',   label: 'SOL',       unit: '円', multiplier: 10,    category: '暗号資産' },
    { pair: 'Gold',      label: 'Gold',      unit: '円', multiplier: 10,    category: 'コモディティ' },
    { pair: 'Silver',    label: 'Silver',    unit: '円', multiplier: 100,   category: 'コモディティ' },
    { pair: 'Copper',    label: '銅',        unit: '円', multiplier: 1000,  category: 'コモディティ' },
    { pair: 'CrudeOil',  label: '原油',      unit: '円', multiplier: 100,   category: 'コモディティ' },
    { pair: 'NatGas',    label: '天然ガス',   unit: '円', multiplier: 1000,  category: 'コモディティ' },
    { pair: 'US10Y',     label: '米10年債',   unit: '円', multiplier: 5000,  category: '債券' },
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
    var sign = pnl >= 0 ? '+' : '';
    var text = unit === '円'
      ? sign + '¥' + Math.abs(Math.round(pnl)).toLocaleString('ja-JP')
      : sign + Number(pnl).toFixed(1) + (unit ? ' ' + unit : '');
    return { text: text, cls: pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'neu' };
  }

  function fmtYen(amount) {
    if (amount == null || isNaN(amount)) return '—';
    return '¥' + Math.round(amount).toLocaleString('ja-JP');
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

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── タブ切替 ──
  function switchTab(targetId) {
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
    // 統計タブ表示時: チャートを正しい幅で再描画
    if (targetId === 'tab-stats' && lastData) {
      requestAnimationFrame(function() { renderEquityChart(lastData); });
    }
  }

  document.querySelectorAll('.tab-item').forEach(function(btn) {
    btn.addEventListener('click', function() {
      switchTab(btn.getAttribute('data-tab'));
    });
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

  function lockScroll() {
    document.body.classList.add('sheet-open');
    if (document.body.classList.contains('drawer-open')) return;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
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

    // HOLDポジション（pos=null）の場合
    if (!pos) {
      title.textContent = (instr ? instr.label : '銘柄') + ' — 待機中';
      body.innerHTML =
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
            var icon = c.close_reason === 'TP' ? '🎯' : c.close_reason === 'SL' ? '🔴' : '—';
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
            var reasonIcon = p.close_reason === 'TP' ? '🎯' : p.close_reason === 'SL' ? '🔴' : '—';
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

    body.innerHTML =
      row('方向', '<span style="color:' + (pos.direction === 'BUY' ? 'var(--green)' : 'var(--red)') + ';font-weight:700">' + (pos.direction === 'BUY' ? '買い' : '空売り') + '</span>') +
      progressHtml +
      (currentRate != null ? row('現在値', fmtPrice(pos.pair, currentRate)) : '') +
      row('含み損益', '<span style="color:' + pnlColor + ';font-weight:700">' + pnlFmt.text + '</span>') +
      row('取引規模', unitLabel) +
      (notional > 0 ? row('想定元本', fmtYen(notional) + ' <span style="font-size:11px;color:var(--label-secondary)">(' + leverage.toFixed(1) + '倍)</span>') : '') +
      row('エントリー日時', fmtTime(pos.entry_at)) +
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
    if (!document.body.classList.contains('drawer-open')) {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.width = '';
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

    function expand() {
      isExpanded = true;
      drawer.style.transition = '';
      drawer.style.transform = '';
      drawer.classList.add('expanded');
      document.body.classList.add('drawer-open');
      // スクロール位置を先頭に戻してティッカーバーを見せる
      if (content) content.scrollTop = 0;
      if (content) {
        content.style.transition = EASE_OUT;
        content.classList.add('drawer-expanded');
        applyContentProgress(1);
      }
      if (compactEl) compactEl.classList.add('marquee-active');
    }
    function collapse() {
      isExpanded = false;
      drawer.style.transition = '';
      drawer.style.transform = '';
      drawer.classList.remove('expanded');
      document.body.classList.remove('drawer-open');
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

    // ドラッグ操作
    drawer.addEventListener('touchstart', function(e) {
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
      // 分析データをindexでマップ化
      var analysisMap = {};
      newsAnalysisData.forEach(function(a) { analysisMap[a.index] = a; });
      body.innerHTML = news.map(function(item, i) {
        var dateStr = '';
        if (item.pubDate) {
          try { dateStr = new Date(item.pubDate).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch(e) { dateStr = item.pubDate; }
        }
        var a = analysisMap[i];
        var flag = (a && a.attention) ? '<span class="news-flag">🔥</span>' : '';
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
      // 分析データからインパクトコメント取得
      var idx = parseInt(row.dataset.newsIdx, 10);
      var analysisMap2 = {};
      newsAnalysisData.forEach(function(a) { analysisMap2[a.index] = a; });
      var ana = analysisMap2[idx];
      var impactHtml = '';
      if (ana && ana.attention && ana.impact) {
        impactHtml = '<div style="background:rgba(255,149,0,0.1);border-left:3px solid #FF9500;padding:10px 12px;border-radius:8px;margin-bottom:12px">' +
          '<div style="font-size:11px;font-weight:600;color:#FF9500;margin-bottom:4px">AI マーケットインパクト</div>' +
          '<div style="font-size:13px;line-height:1.5;color:var(--label)">' + escHtml(ana.impact) + '</div>' +
        '</div>';
      }
      el('sheet-body').innerHTML =
        (dateStr ? '<div style="font-size:12px;color:var(--label-secondary);margin-bottom:8px">' + dateStr + '</div>' : '') +
        '<div style="font-size:15px;font-weight:600;line-height:1.5;margin-bottom:12px">' + escHtml(item.title) + '</div>' +
        impactHtml +
        (item.description ? '<div style="font-size:13px;color:var(--label-secondary);line-height:1.6">' + escHtml(item.description) + '</div>' : '');
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
    var bannerTitle = el('tp-banner-title');
    var bannerSub   = el('tp-banner-sub');
    var bannerIcon  = banner.querySelector('.tp-banner-icon');

    if (isTP) {
      banner.classList.remove('sl-banner');
      bannerIcon.textContent = '🎯';
      bannerTitle.textContent = '利確！TP到達';
    } else if (isSL) {
      banner.classList.add('sl-banner');
      bannerIcon.textContent = '🌸';
      bannerTitle.textContent = '損切り — 金継ぎ';
    } else {
      banner.classList.remove('sl-banner');
      bannerIcon.textContent = '✅';
      bannerTitle.textContent = '決済完了';
    }

    bannerSub.textContent = (pos.pair || '') + '  ' + pnlFmt.text;
    banner.classList.add('show');

    // haptic（対応端末のみ）
    if (isTP && navigator.vibrate) navigator.vibrate([80, 40, 80]);
    if (isSL && navigator.vibrate) navigator.vibrate([200]);

    // プッシュ通知
    if ('Notification' in window && Notification.permission === 'granted') {
      var icon = isTP ? '🎯' : isSL ? '🔴' : '✅';
      new Notification('FX Sim ' + (isTP ? '利確' : isSL ? '損切り' : '決済'), {
        body: icon + ' ' + (pos.pair || '') + ' ' + pnlFmt.text,
        tag: 'fxsim-trade-' + pos.id,
      });
    }

    setTimeout(function() { banner.classList.remove('show'); }, 4000);
    banner.addEventListener('click', function() { banner.classList.remove('show'); }, { once: true });
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

  // ── パフォーマンスサマリー ──
  function renderPerfSummary(data) {
    var target = el('perf-summary');
    if (!target) return;
    var closes = (data.recentCloses || []).slice().reverse();
    var perf = data.performance || {};
    var totalPnl = perf.totalPnl || 0;
    var totalClosed = perf.totalClosed || 0;
    var wins = perf.wins || 0;

    // 最大ドローダウン計算（資産推移のピークからの最大落差）
    var closePnlSum = 0;
    closes.forEach(function(c) { closePnlSum += (c.pnl || 0); });
    var missingPnl = totalPnl - closePnlSum;
    var peak = INITIAL_CAPITAL + missingPnl;
    var maxDD = 0;
    var cumPnl = 0;
    closes.forEach(function(c) {
      cumPnl += (c.pnl || 0);
      var equity = INITIAL_CAPITAL + missingPnl + cumPnl;
      if (equity > peak) peak = equity;
      var dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    });

    // シャープレシオ計算（簡易: 平均リターン / 標準偏差）
    var pnls = closes.map(function(c) { return c.pnl || 0; });
    var avgPnl = pnls.length > 0 ? pnls.reduce(function(a, b) { return a + b; }, 0) / pnls.length : 0;
    var variance = pnls.length > 1 ? pnls.reduce(function(a, b) { return a + (b - avgPnl) * (b - avgPnl); }, 0) / (pnls.length - 1) : 0;
    var stdDev = Math.sqrt(variance);
    var sharpe = stdDev > 0 ? (avgPnl / stdDev) : 0;

    // RR比（平均利益 / 平均損失）
    var winsArr = pnls.filter(function(p) { return p > 0; });
    var lossArr = pnls.filter(function(p) { return p < 0; });
    var avgWin = winsArr.length > 0 ? winsArr.reduce(function(a, b) { return a + b; }, 0) / winsArr.length : 0;
    var avgLoss = lossArr.length > 0 ? Math.abs(lossArr.reduce(function(a, b) { return a + b; }, 0) / lossArr.length) : 0;
    var rrRatio = avgLoss > 0 ? (avgWin / avgLoss) : 0;

    // プロフィットファクター（総利益 / 総損失）
    var totalWin = winsArr.reduce(function(a, b) { return a + b; }, 0);
    var totalLoss = Math.abs(lossArr.reduce(function(a, b) { return a + b; }, 0));
    var profitFactor = totalLoss > 0 ? (totalWin / totalLoss) : 0;

    function stat(label, value, color) {
      return '<div style="text-align:center;min-width:0">' +
        '<div style="font-size:11px;color:var(--label-secondary);margin-bottom:2px">' + label + '</div>' +
        '<div style="font-size:15px;font-weight:700;color:' + (color || 'var(--label)') + '">' + value + '</div>' +
      '</div>';
    }

    var ddColor = maxDD > 1000 ? 'var(--red)' : maxDD > 500 ? 'var(--orange, #FF9500)' : 'var(--label)';
    var sharpeColor = sharpe >= 1 ? 'var(--green)' : sharpe >= 0.5 ? 'var(--label)' : 'var(--red)';
    var pfColor = profitFactor >= 2 ? 'var(--green)' : profitFactor >= 1 ? 'var(--label)' : 'var(--red)';

    target.innerHTML =
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:0 4px">' +
        stat('最大DD', '¥' + Math.round(maxDD).toLocaleString(), ddColor) +
        stat('Sharpe', sharpe.toFixed(2), sharpeColor) +
        stat('RR比', rrRatio.toFixed(2), 'var(--label)') +
        stat('PF', profitFactor.toFixed(2), pfColor) +
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
  function renderStats(data) {
    renderEquityChart(data);
    renderPerfSummary(data);
    var container = el('stats-pairs');
    if (!container) return;
    var byPair = data.performanceByPair || {};

    function buildStatsCard(instr) {
      var p = byPair[instr.pair];
      if (!p) p = { total: 0, wins: 0, totalPnl: 0 };
      var winRate = p.total > 0 ? (p.wins / p.total * 100) : 0;
      var pnlFmt  = fmtPnl(p.totalPnl, instr.unit);
      var pnlCls  = pnlFmt.cls === 'pos' ? 'var(--green)' : pnlFmt.cls === 'neg' ? 'var(--red)' : 'var(--label-secondary)';

      return '<div class="stats-pair-card" data-stats-pair="' + escHtml(instr.pair) + '" style="cursor:pointer;-webkit-tap-highlight-color:transparent">' +
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
    // 取引ありと取引なしにセクション分離（Cognitive Load軽減）
    var traded = INSTRUMENTS.filter(function(i) { var p = byPair[i.pair]; return p && p.total > 0; });
    var untraded = INSTRUMENTS.filter(function(i) { var p = byPair[i.pair]; return !p || p.total === 0; });
    var html = traded.map(buildStatsCard).join('');
    if (untraded.length > 0) {
      html += '<div style="font-size:11px;font-weight:600;color:var(--label-tertiary);letter-spacing:0.8px;text-transform:uppercase;padding:12px 4px 4px">未取引</div>';
      html += untraded.map(buildStatsCard).join('');
    }

    // 全銘柄の取引数合計が0なら empty state を追加
    var totalTrades = INSTRUMENTS.reduce(function(sum, instr) {
      var p = byPair[instr.pair];
      return sum + (p ? p.total : 0);
    }, 0);
    // 取引履歴（全銘柄横断、新しい順）
    var closes = (data.recentCloses || []).slice();
    var histHtml = '';
    if (closes.length > 0) {
      histHtml = '<div style="margin-top:16px">' +
        '<div class="list-header" style="padding:0 0 8px">取引履歴</div>' +
        closes.map(function(c, idx) {
          var instrH = INSTRUMENTS.filter(function(i) { return i.pair === c.pair; })[0];
          var label = instrH ? instrH.label : c.pair;
          var unit = instrH ? instrH.unit : '';
          var pnl = c.pnl != null ? c.pnl : 0;
          var pnlColor = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--label-secondary)';
          var icon = c.close_reason === 'TP' ? '🎯' : c.close_reason === 'SL' ? '🔴' : '—';
          var dir = c.direction === 'BUY' ? '買い' : '空売り';
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--separator)">' +
            '<div>' +
              '<div style="font-size:14px;font-weight:600">' + escHtml(label) + '</div>' +
              '<div style="font-size:11px;color:var(--label-secondary);margin-top:2px">' +
                icon + ' ' + (c.close_reason || '') + ' · ' + dir + ' · ' + fmtTime(c.closed_at) +
              '</div>' +
            '</div>' +
            '<span style="font-size:15px;font-weight:700;color:' + pnlColor + '">' +
              fmtPnl(pnl, unit).text +
            '</span>' +
          '</div>';
        }).join('') +
      '</div>';
    }

    container.innerHTML = html + histHtml +
      (totalTrades === 0
        ? '<div class="secondary-text" style="padding:8px 0 4px;text-align:center;font-size:13px">まだ決済された取引はありません<br>Cronが蓄積されると成績が表示されます</div>'
        : '');

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
            var icon = c.close_reason === 'TP' ? '🎯' : c.close_reason === 'SL' ? '🔴' : '—';
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
  function render(data) {
    var prev = lastData;
    lastData = data;

    // TP/SLバナー検出
    detectAndShowBanner(data);

    // Hero: 資産残高（元手 + 累計PnL）
    var perf = data.performance;
    var heroEl = el('hero-pnl');
    var totalPnl = perf.totalPnl;
    var capital = INITIAL_CAPITAL + totalPnl;
    heroEl.className = 'hero-pnl ' + (totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : 'neutral');
    animatePnl(heroEl, capital);

    var dpEl = el('today-pnl');
    dpEl.textContent = (totalPnl >= 0 ? '+' : '') + fmtYen(totalPnl);
    dpEl.className   = 'hero-sub-value ' + (totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : 'neutral');

    var roiEl = el('roi-value');
    var roi = totalPnl / INITIAL_CAPITAL * 100;
    if (roiEl) {
      roiEl.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(2) + '%';
      roiEl.className = 'hero-sub-value ' + (roi > 0 ? 'positive' : roi < 0 ? 'negative' : 'neutral');
    }
    el('win-rate').textContent     = perf.winRate.toFixed(1) + '%';
    el('total-trades').textContent = perf.totalClosed + ' 件';

    // ウォッチリスト
    renderWatchlist(data);

    // AI最新判断（ポートフォリオタブ）— 直近BUY/SELLを表示
    var ld = data.latestDecision;
    var recentAction = (data.recentDecisions || []).length > 0 ? data.recentDecisions[0] : null;

    // ポートフォリオタブ: 直近アクション + 稼働状況
    if (recentAction) {
      var bc = recentAction.decision === 'BUY' ? 'badge-buy' : 'badge-sell';
      var b1 = el('ai-badge');
      if (b1) { b1.textContent = recentAction.decision; b1.className = 'badge ' + bc + ' ai-badge'; }
      var r1 = el('ai-reasoning');
      if (r1) r1.textContent = fmtReasoning(recentAction.reasoning);
      var t1 = el('ai-time');
      if (t1) t1.textContent = '[' + recentAction.pair + '] ' + fmtTime(recentAction.created_at);
    }
    // 稼働状況ライン
    var statusEl = el('ai-status');
    if (statusEl && data.systemStatus) {
      var runs = data.systemStatus.totalRuns || 0;
      // 連勝/連敗ストリーク計算（Variable Reward）
      var recentC = (data.recentCloses || []).slice();
      var streak = 0;
      var streakType = '';
      for (var si = 0; si < recentC.length; si++) {
        var isWin = (recentC[si].pnl || 0) > 0;
        if (si === 0) { streakType = isWin ? 'win' : 'lose'; streak = 1; }
        else if ((isWin && streakType === 'win') || (!isWin && streakType === 'lose')) { streak++; }
        else { break; }
      }
      var streakText = '';
      if (streak >= 2 && streakType === 'win') streakText = ' · ' + streak + '連勝中';
      else if (streak >= 3 && streakType === 'lose') streakText = ' · ' + streak + '連敗中';
      statusEl.textContent = runs.toLocaleString('ja-JP') + '回監視中 · 次のシグナル待ち' + streakText;
    }

    // AI判断タブ: 従来通りlatestDecisionを表示
    if (ld) {
      var bc2 = ld.decision === 'BUY' ? 'badge-buy' : ld.decision === 'SELL' ? 'badge-sell' : 'badge-hold';
      var b2 = el('ai-badge2');
      if (b2) { b2.textContent = ld.decision; b2.className = 'badge ' + bc2 + ' ai-badge'; }
      var r2 = el('ai-reasoning2');
      if (r2) r2.textContent = fmtReasoning(ld.reasoning);
      var t2 = el('ai-time2');
      if (t2) t2.textContent = (ld.pair ? '[' + ld.pair + '] ' : '') + fmtTime(ld.created_at);
    }

    // 判定履歴
    renderHistory(data.recentDecisions);

    // 統計タブ
    renderStats(data);

    // ログタブ
    renderLog(data);

    // タブバッジ更新（Zeigarnik効果）
    updateTabBadges(data);

    // ニュースドロワー
    if (window._renderNews) window._renderNews(data.latestNews || [], data.newsAnalysis || []);

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

  // ── 判定履歴 ──
  function renderHistory(decisions) {
    var list      = el('decisions-list');
    var toggleBtn = el('toggle-history');
    if (!decisions || decisions.length === 0) {
      list.innerHTML = '<div class="decision-row"><span class="secondary-text">データなし</span></div>';
      if (toggleBtn) toggleBtn.style.display = 'none';
      return;
    }

    var shown = historyExpanded ? decisions : decisions.slice(0, SHOW_INITIAL);

    if (toggleBtn) {
      toggleBtn.style.display = decisions.length > SHOW_INITIAL ? '' : 'none';
      toggleBtn.textContent   = historyExpanded ? '折りたたむ' : 'すべて見る（' + decisions.length + '件）';
      toggleBtn.setAttribute('aria-expanded', historyExpanded ? 'true' : 'false');
    }

    list.innerHTML = shown.map(function(d, i) {
      var bc = d.decision === 'BUY' ? 'badge-buy' : d.decision === 'SELL' ? 'badge-sell' : 'badge-hold';
      var meta = [];
      if (d.vix   != null) meta.push('VIX ' + fmt(d.vix, 1));
      if (d.us10y != null) meta.push(fmt(d.us10y, 2) + '%');

      var holdCls = d.decision === 'HOLD' ? ' decision-row-hold' : '';
      var hasDetail = !!(d.news_summary || d.reddit_signal || d.reasoning);
      var tapCls = hasDetail ? ' decision-row-tappable' : '';
      var reasoningText = fmtReasoning(d.reasoning);
      return '<div class="decision-row' + holdCls + tapCls + '" role="listitem" data-idx="' + i + '">' +
        '<div class="decision-top">' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            (d.pair ? '<span class="decision-pair">' + escHtml(d.pair) + '</span>' : '') +
            '<span class="decision-rate">' + fmt(d.rate, d.pair === 'Nikkei225' || d.pair === "S&P500" ? 0 : 2) + '</span>' +
          '</div>' +
          '<span class="badge ' + bc + '">' + d.decision + '</span>' +
        '</div>' +
        '<div class="decision-top">' +
          '<span class="decision-time">' + fmtTime(d.created_at) + '</span>' +
          '<span class="decision-meta">' + (meta.join(' · ') || '') + '</span>' +
        '</div>' +
        (reasoningText !== '—' ? '<div class="decision-reasoning">' + escHtml(reasoningText) + '</div>' : '') +
      '</div>';
    }).join('');

    // イベント委譲でニュース詳細シートを開く
    list.onclick = function(e) {
      var row = e.target.closest('[data-idx]');
      if (!row) return;
      var d = shown[parseInt(row.dataset.idx, 10)];
      if (!d) return;
      openNewsSheet(d);
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

    if (d.reddit_signal) {
      rows += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--separator)">' +
        '<div style="font-size:12px;color:var(--label-secondary);margin-bottom:6px">Redditシグナル</div>' +
        '<div style="font-size:13px;color:var(--label)">' + escHtml(d.reddit_signal) + '</div>' +
        '</div>';
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

  var toggleBtn = el('toggle-history');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function() {
      historyExpanded = !historyExpanded;
      if (lastData) renderHistory(lastData.recentDecisions);
    });
  }

  // テーマ切替
  var themeBtn = el('theme-btn');
  if (themeBtn) {
    var savedTheme = localStorage.getItem('fx-theme');
    if (savedTheme) {
      document.documentElement.setAttribute('data-theme', savedTheme);
      themeBtn.textContent = savedTheme === 'light' ? '🌙' : '☀️';
    }
    themeBtn.addEventListener('click', function() {
      var current = document.documentElement.getAttribute('data-theme');
      var next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('fx-theme', next);
      themeBtn.textContent = next === 'light' ? '🌙' : '☀️';
    });
  }

  // 通知許可リクエスト
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  refresh();
  setInterval(refresh, 30000);
})();
`;

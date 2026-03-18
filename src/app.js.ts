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

  // 銘柄設定（表示用）
  var INSTRUMENTS = [
    { pair: 'USD/JPY',   label: 'USD / JPY', unit: 'pip', multiplier: 100 },
    { pair: 'Nikkei225', label: '日経225',   unit: 'pt',  multiplier: 0.1 },
    { pair: 'S&P500',    label: 'S&P 500',  unit: 'pt',  multiplier: 0.1 },
    { pair: 'US10Y',     label: '米10年債',  unit: 'bp',  multiplier: 100 },
  ];

  // ── ユーティリティ ──
  function fmt(n, dec) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(dec != null ? dec : 2);
  }

  function fmtPnl(pnl, unit) {
    if (pnl == null || isNaN(pnl)) return { text: '—', cls: 'neu' };
    var sign = pnl >= 0 ? '+' : '';
    return {
      text: sign + Number(pnl).toFixed(1) + (unit ? ' ' + unit : ''),
      cls:  pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'neu',
    };
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtPrice(pair, rate) {
    if (rate == null) return '—';
    if (pair === 'USD/JPY') return Number(rate).toFixed(2);
    if (pair === 'US10Y')   return Number(rate).toFixed(2) + '%';
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
    // 値が変わらない場合でも初回は必ず描画（スケルトン除去）
    if (fromVal === toVal && !isFirstRender) return;
    if (fromVal === toVal) {
      elem.textContent = (toVal >= 0 ? '+' : '') + toVal.toFixed(1);
      return;
    }
    var duration = 800;
    var start = null;
    function step(ts) {
      if (!start) start = ts;
      var progress = Math.min((ts - start) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3); // ease-out-cubic
      var current = fromVal + (toVal - fromVal) * ease;
      var sign = current >= 0 ? '+' : '';
      elem.textContent = sign + current.toFixed(1);
      if (progress < 1) requestAnimationFrame(step);
      else elem.textContent = (toVal >= 0 ? '+' : '') + toVal.toFixed(1);
    }
    requestAnimationFrame(step);
  }

  function lockScroll() {
    // ドロワー展開中はdrawer-openクラスが既にロックしているのでスキップ
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
                (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + ' ' + unit +
              '</span>' +
            '</div>';
          }).join('') +
        '</div>';
    }

    body.innerHTML =
      row('方向', '<span style="color:' + (pos.direction === 'BUY' ? 'var(--green)' : 'var(--red)') + ';font-weight:700">' + pos.direction + '</span>') +
      progressHtml +
      (currentRate != null ? row('現在値', fmtPrice(pos.pair, currentRate)) : '') +
      row('含み損益', '<span style="color:' + pnlColor + ';font-weight:700">' + pnlFmt.text + '</span>') +
      row('エントリー日時', fmtTime(pos.entry_at)) +
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
    // ドロワー展開中はbodyスタイルを触らない（drawer-openが管理）
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
    var body = el('news-drawer-body');
    window._renderNews = function(news) {
      var tab  = el('tab-portfolio');
      if (!news || news.length === 0) {
        drawer.classList.remove('visible');
        if (tab) tab.classList.remove('news-visible');
        return;
      }
      newsData = news;
      drawer.classList.add('visible');
      if (tab) tab.classList.add('news-visible');
      body.innerHTML = news.map(function(item, i) {
        var dateStr = '';
        if (item.pubDate) {
          try { dateStr = new Date(item.pubDate).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch(e) { dateStr = item.pubDate; }
        }
        return '<div class="news-item" data-news-idx="' + i + '">' +
          '<div class="news-item-title">' + escHtml(typeof item === 'string' ? item : item.title) + '</div>' +
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
      el('sheet-body').innerHTML =
        (dateStr ? '<div style="font-size:12px;color:var(--label-secondary);margin-bottom:8px">' + dateStr + '</div>' : '') +
        '<div style="font-size:15px;font-weight:600;line-height:1.5;margin-bottom:12px">' + escHtml(item.title) + '</div>' +
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

    var html = INSTRUMENTS.map(function(instr) {
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
      var dirText  = pos ? pos.direction : 'HOLD';
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
    }).join('');

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

  // ── 統計タブ描画 ──
  function renderStats(data) {
    var container = el('stats-pairs');
    if (!container) return;
    var byPair = data.performanceByPair || {};

    var html = INSTRUMENTS.map(function(instr) {
      var p = byPair[instr.pair];
      if (!p) p = { total: 0, wins: 0, totalPnl: 0 };
      var winRate = p.total > 0 ? (p.wins / p.total * 100) : 0;
      var pnlFmt  = fmtPnl(p.totalPnl, instr.unit);
      var pnlCls  = pnlFmt.cls === 'pos' ? 'var(--green)' : pnlFmt.cls === 'neg' ? 'var(--red)' : 'var(--label-secondary)';

      return '<div class="stats-pair-card">' +
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
    }).join('');

    // 全銘柄の取引数合計が0なら empty state を追加
    var totalTrades = INSTRUMENTS.reduce(function(sum, instr) {
      var p = byPair[instr.pair];
      return sum + (p ? p.total : 0);
    }, 0);
    container.innerHTML = html +
      (totalTrades === 0
        ? '<div class="secondary-text" style="padding:8px 0 4px;text-align:center;font-size:13px">まだ決済された取引はありません<br>Cronが蓄積されると成績が表示されます</div>'
        : '');
  }

  // ── メインレンダリング ──
  function render(data) {
    var prev = lastData;
    lastData = data;

    // TP/SLバナー検出
    detectAndShowBanner(data);

    // Hero PnL（カウントアップ）
    var perf = data.performance;
    var heroEl = el('hero-pnl');
    var totalPnl = perf.totalPnl;
    heroEl.className = 'hero-pnl ' + (totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : 'neutral');
    animatePnl(heroEl, totalPnl);

    var dpEl = el('today-pnl');
    var todayPnlFmt = fmtPnl(perf.todayPnl, '');
    dpEl.textContent = todayPnlFmt.text;
    dpEl.className   = 'hero-sub-value ' + (perf.todayPnl > 0 ? 'positive' : perf.todayPnl < 0 ? 'negative' : 'neutral');

    el('win-rate').textContent     = perf.winRate.toFixed(1) + '%';
    el('total-trades').textContent = perf.totalClosed + ' 件';

    // ウォッチリスト
    renderWatchlist(data);

    // AI最新判断（ポートフォリオタブ）
    var ld = data.latestDecision;
    if (ld) {
      var bc = ld.decision === 'BUY' ? 'badge-buy' : ld.decision === 'SELL' ? 'badge-sell' : 'badge-hold';
      ['ai-badge', 'ai-badge2'].forEach(function(id) {
        var b = el(id);
        if (b) { b.textContent = ld.decision; b.className = 'badge ' + bc + ' ai-badge'; }
      });
      ['ai-reasoning', 'ai-reasoning2'].forEach(function(id) {
        var r = el(id);
        if (r) r.textContent = fmtReasoning(ld.reasoning);
      });
      var timeText = (ld.pair ? '[' + ld.pair + '] ' : '') + fmtTime(ld.created_at);
      ['ai-time', 'ai-time2'].forEach(function(id) {
        var t = el(id);
        if (t) t.textContent = timeText;
      });
    }

    // 判定履歴
    renderHistory(data.recentDecisions);

    // 統計タブ
    renderStats(data);

    // ログタブ
    renderLog(data);

    // ニュースドロワー
    if (window._renderNews) window._renderNews(data.latestNews || []);

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

  // ── ログタブ描画 ──
  function renderLog(data) {
    var stats = data.logStats || {};
    var logs  = data.systemLogs || [];

    // 統計グリッド
    var grid = el('log-stats-grid');
    if (grid) {
      var skipRate = stats.totalRuns > 0
        ? Math.round(stats.holdCount / stats.totalRuns * 100) : 0;
      grid.innerHTML =
        statCell('総実行回数', Number(stats.totalRuns || 0).toLocaleString('ja-JP'), '回') +
        statCell('AI呼出回数', Number(stats.geminiCalls || 0).toLocaleString('ja-JP'), '回') +
        statCell('スキップ率', skipRate, '%') +
        statCell('エラー数', stats.errorCount || 0, '件');
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
          (log.detail ? '<div class="log-detail">' + escHtml(log.detail.slice(0, 120)) + '</div>' : '') +
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
        '<div style="font-size:14px;line-height:1.6;color:var(--label-primary)">' + escHtml(d.reasoning) + '</div>' +
        '</div>';
    }

    if (d.news_summary) {
      rows += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--separator)">' +
        '<div style="font-size:12px;color:var(--label-secondary);margin-bottom:6px">ニュース</div>' +
        '<div style="font-size:13px;line-height:1.7;color:var(--label-primary);white-space:pre-wrap">' + escHtml(d.news_summary) + '</div>' +
        '</div>';
    }

    if (d.reddit_signal) {
      rows += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--separator)">' +
        '<div style="font-size:12px;color:var(--label-secondary);margin-bottom:6px">Redditシグナル</div>' +
        '<div style="font-size:13px;color:var(--label-primary)">' + escHtml(d.reddit_signal) + '</div>' +
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
      '<span style="font-size:14px;color:var(--label-primary)">' + val + '</span>' +
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
      refresh();
    });
  }

  var toggleBtn = el('toggle-history');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function() {
      historyExpanded = !historyExpanded;
      if (lastData) renderHistory(lastData.recentDecisions);
    });
  }

  refresh();
  setInterval(refresh, 30000);
})();
`;

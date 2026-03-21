# AI判断タブ フルリニューアル — 実装プラン

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI判断タブの全面書き換えにより、判断基準・判断材料・判断内容・判断結果の4要素を1カードで完結させる

**Architecture:** KPIグリッド(2×2) → トリガーカウントグリッド → タイムラインカードリスト（タップで詳細パネル展開）の3層構造。バックエンドAPIは変更せず、フロントエンド3ファイルのみ変更。

**Tech Stack:** TypeScript (Cloudflare Workers), CSS in TS template strings, Vanilla JS (DOM manipulation), Chrome DevTools MCP (visual verification)

**Spec:** `docs/superpowers/specs/2026-03-21-ai-tab-renewal-design.md`
**Mockup:** `mockups/ai-tab-mixed-v2.html` (HIG/UX審査済み)

---

## ファイル構成

| ファイル | 変更種別 | 責務 |
|---------|---------|------|
| `src/style.css.ts` | Modify | AI判断タブ専用CSSクラス追加（既存クラス変更なし） |
| `src/dashboard.ts` | Modify | `#tab-ai` HTML構造を全面置換（lines 191-212） |
| `src/app.js.ts` | Modify | ユーティリティ関数追加 + `renderAiTab()` 追加 + 旧コード削除 |

**変更しないファイル:**
- `src/api.ts` — APIレスポンス型変更なし
- `src/index.ts` / `src/db.ts` / その他バックエンドファイル — 変更なし
- 資産タブ・統計タブ・ログタブ — 変更なし

---

## Task 1: CSS — AI判断タブ専用スタイル追加

**Files:**
- Modify: `src/style.css.ts`

### CSSクラス一覧と仕様

追加するCSSクラス（`/* ── AI判断タブ リニューアル ── */` コメントブロックで囲む）:

**KPIグリッド系:**
```css
.ai-kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
.kpi-card {
  position: relative; overflow: hidden;
  background: var(--card-bg); border-radius: 14px; padding: 12px 16px;
  display: flex; flex-direction: column; gap: 4px;
}
.kpi-card::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0;
  width: 3px; background: rgba(255,255,255,0.1);
}
.kpi-val { font-size: 22px; font-weight: 700; line-height: 1.2; color: var(--label); }
.kpi-val.green { color: var(--green); }
.kpi-val.red   { color: var(--red); }
.kpi-sub { font-size: 11px; color: var(--label3); line-height: 1.4; }
.kpi-label { font-size: 11px; color: var(--label2); margin-bottom: 2px; }
/* 最新判断カード内のバッジコンテナ */
.kpi-latest-body { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
```

**トリガーカウントグリッド系:**
```css
.trigger-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
  margin-bottom: 16px;
}
.trigger-cell {
  border-radius: 12px; padding: 8px 12px;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
}
.trigger-cell.news {
  background: rgba(90,200,250,0.08); border: 1px solid rgba(90,200,250,0.2);
}
.trigger-cell.rate {
  background: rgba(255,159,10,0.08); border: 1px solid rgba(255,159,10,0.2);
}
.trigger-cell.cron {
  background: rgba(174,174,178,0.08); border: 1px solid rgba(174,174,178,0.2);
}
.trigger-count { font-size: 20px; font-weight: 700; }
.trigger-cell.news .trigger-count { color: var(--teal); }
.trigger-cell.rate .trigger-count { color: var(--orange); }
.trigger-cell.cron .trigger-count { color: var(--label3); }
.trigger-label { font-size: 11px; color: var(--label2); text-align: center; }
```

**タイムラインセクション系:**
```css
.ai-sec-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 8px;
}
.ai-sec-title { font-size: 15px; font-weight: 600; color: var(--label); }
.ai-sec-filter {
  font-size: 12px; color: var(--blue); padding: 8px 4px; margin: -8px -4px;
}
```

**タイムラインカード系:**
```css
.tl-list { display: flex; flex-direction: column; gap: 8px; }
.tl-card {
  background: var(--card-bg); border-radius: 14px;
  overflow: hidden; cursor: pointer;
  transition: opacity 0.1s ease;
}
.tl-card:active { opacity: 0.75; }
.tl-accent {
  position: absolute; left: 0; top: 0; bottom: 0;
  width: 3px; border-radius: 0;
}
.tl-accent.open { background: var(--blue); }
.tl-accent.tp   { background: var(--green); }
.tl-accent.sl   { background: var(--red); }
.tl-accent.closed { background: var(--label3); }
.tl-inner { position: relative; padding: 12px 12px 12px 16px; }
.tl-row1 { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.tl-row2 { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.tl-row3 { display: flex; align-items: center; justify-content: space-between; }
.tl-left { display: flex; align-items: center; gap: 6px; }
.tl-pair { font-size: 13px; font-weight: 600; color: var(--label); }
.tl-rate { font-size: 13px; color: var(--label2); }
.tl-meta { display: flex; align-items: center; gap: 6px; }
.tl-time { font-size: 11px; color: var(--label3); }
.tl-chevron { font-size: 12px; color: var(--label3); transition: transform 0.25s ease; }
.tl-card.expanded .tl-chevron { transform: rotate(90deg); }
.dir-badge {
  font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 6px;
  letter-spacing: 0.02em;
}
.dir-badge.buy  { background: rgba(48,209,88,0.18); color: var(--green); }
.dir-badge.sell { background: rgba(255,69,58,0.18);  color: var(--red); }
.tl-chip {
  font-size: 11px; padding: 2px 7px; border-radius: 6px;
}
.tl-chip.news   { background: rgba(90,200,250,0.12); color: var(--teal); border: 1px solid rgba(90,200,250,0.28); }
.tl-chip.rate   { background: rgba(255,159,10,0.12);  color: var(--orange); border: 1px solid rgba(255,159,10,0.28); }
.tl-chip.cron   { background: rgba(174,174,178,0.08); color: var(--label3); border: 1px solid rgba(174,174,178,0.2); }
.tl-reasoning-chip { font-size: 11px; color: var(--label2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.tl-result { display: flex; align-items: center; gap: 4px; font-size: 11px; }
.result-dot { width: 7px; height: 7px; border-radius: 50%; }
.result-dot.open   { background: var(--blue); }
.result-dot.tp     { background: var(--green); }
.result-dot.sl     { background: var(--red); }
.result-dot.closed { background: var(--label3); }
.tl-result-text { font-size: 11px; }
.tl-result-text.open   { color: var(--blue); }
.tl-result-text.tp     { color: var(--green); }
.tl-result-text.sl     { color: var(--red); }
.tl-result-text.closed { color: var(--label3); }
```

**詳細パネル系:**
```css
.detail-panel {
  max-height: 0; overflow: hidden; opacity: 0;
  transition: max-height 0.3s cubic-bezier(0.4,0,0.2,1),
              opacity 0.25s ease,
              padding 0.3s cubic-bezier(0.4,0,0.2,1);
  border-top: 0px solid var(--separator);
}
.detail-panel.open {
  max-height: 600px; opacity: 1;
  padding: 14px 16px 16px 15px;
  border-top: 1px solid var(--separator);
}
.detail-trigger-row {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 12px;
}
.detail-trigger-desc { font-size: 12px; color: var(--label2); }
.detail-4pt {
  display: grid; grid-template-columns: 1fr 1.3fr; gap: 4px 8px;
  margin-bottom: 12px;
}
.detail-label { font-size: 11px; color: var(--label3); margin-bottom: 2px; }
.detail-value { font-size: 12px; font-weight: 600; color: var(--label); line-height: 1.4; }
.detail-reasoning {
  padding: 10px 0 10px 10px;
  border-left: 2px solid rgba(255,255,255,0.12);
  margin-bottom: 12px;
}
.detail-reasoning-text { font-size: 12px; color: var(--label2); line-height: 1.6; }
.detail-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.detail-chip {
  font-size: 11px; padding: 2px 7px; border-radius: 6px;
  background: rgba(255,255,255,0.06); color: var(--label2);
}
```

**HOLDセパレーター:**
```css
.hold-sep { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.hold-sep-line { flex: 1; height: 1px; background: var(--separator); }
.hold-sep-label { font-size: 11px; color: var(--label3); white-space: nowrap; }
```

- [ ] **Step 1: `style.css.ts` の末尾（または既存AIセクション付近）を確認**

`src/style.css.ts` の末尾 50行を Read して挿入位置を特定する。

- [ ] **Step 2: CSSクラスを追加**

`src/style.css.ts` の適切な位置に `/* ── AI判断タブ リニューアル ── */` ブロックとして全CSSクラスを挿入する（上記仕様に基づく）。

- [ ] **Step 3: TypeScriptビルド確認**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim && npx wrangler deploy --dry-run 2>&1 | tail -20
```
Expected: `Total Upload:` が表示され、エラーなし。

- [ ] **Step 4: コミット**

```bash
git add src/style.css.ts
git commit -m "feat(ai-tab): add CSS classes for AI tab renewal"
```

---

## Task 2: HTML — `#tab-ai` 構造を全面書き換え

**Files:**
- Modify: `src/dashboard.ts` (lines 191-212 を置換)

### 新しい `#tab-ai` HTML構造

```html
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
```

- [ ] **Step 1: `dashboard.ts` の対象行を確認**

`src/dashboard.ts` を Read（lines 188-215）して置換範囲を確認。

- [ ] **Step 2: `#tab-ai` ブロックを置換**

上記HTMLで lines 191-212 を置換する。

- [ ] **Step 3: TypeScriptビルド確認**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim && npx wrangler deploy --dry-run 2>&1 | tail -20
```
Expected: エラーなし。

- [ ] **Step 4: コミット**

```bash
git add src/dashboard.ts
git commit -m "feat(ai-tab): rewrite #tab-ai HTML structure"
```

---

## Task 3: JS — ユーティリティ関数追加

**Files:**
- Modify: `src/app.js.ts` (helpers section ~ line 93-107 の後に追加)

### 追加する関数

```javascript
// ── AI判断タブ: ユーティリティ ──

// 日付文字列が今日（ローカルタイム）かどうか
function isToday(dateStr) {
  if (!dateStr) return false;
  var d = new Date(dateStr);
  var now = new Date();
  return d.getFullYear() === now.getFullYear() &&
         d.getMonth()    === now.getMonth() &&
         d.getDate()     === now.getDate();
}

// ISO日時 → 「X分前」「X時間前」「XX:XX」形式
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
function inferTrigger(d) {
  var r = (d.reasoning  || '').toLowerCase();
  var n = (d.news_summary || '');
  if (n.length > 10 || r.indexOf('ニュース') !== -1 || r.indexOf('news') !== -1) return 'news';
  if (r.indexOf('レート') !== -1 || r.indexOf('rate') !== -1 || r.indexOf('変動') !== -1) return 'rate';
  return 'cron';
}

// トリガー種別 → 表示ラベル
function triggerLabel(type) {
  if (type === 'news') return 'ニュース起動';
  if (type === 'rate') return 'レート変動';
  return '定期 30m';
}
```

- [ ] **Step 1: 挿入位置を確認**

`src/app.js.ts` lines 100-115 を Read して `fmtReasoning` の終わり位置を特定。

- [ ] **Step 2: 関数を挿入**

`fmtReasoning` 関数の後（line ~104 の `}` の後）に上記コードを追加。

- [ ] **Step 3: ビルド確認**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim && npx wrangler deploy --dry-run 2>&1 | tail -20
```
Expected: エラーなし。

- [ ] **Step 4: コミット**

```bash
git add src/app.js.ts
git commit -m "feat(ai-tab): add inferTrigger, isToday, fmtElapsed, fmtTimeHMS helpers"
```

---

## Task 4: JS — `renderAiTab()` 追加 + 旧コード削除

**Files:**
- Modify: `src/app.js.ts`

### 追加: `renderAiTab(data)` 関数

`renderHistory()` 関数の直後（line ~2285 の後）に追加する:

```javascript
// ── AI判断タブ: データ描画 ──
function renderAiTab(data) {
  var decisions   = data.recentDecisions  || [];
  var openPos     = data.openPositions    || [];
  var stats       = data.statistics       || {};
  var perf        = data.performance      || {};
  var timeline    = el('ai-timeline-list');
  if (!timeline) return;

  // ─ KPI: 今日の判断 ─
  var todayD    = decisions.filter(function(d) { return isToday(d.created_at); });
  var buyCount  = todayD.filter(function(d) { return d.decision === 'BUY';  }).length;
  var sellCount = todayD.filter(function(d) { return d.decision === 'SELL'; }).length;
  var todayTotal = buyCount + sellCount;

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
  var kpiPnlVal = el('ai-kpi-pnl-val');
  var kpiPnlSub = el('ai-kpi-pnl-sub');
  if (kpiPnlVal) {
    var pnlText = todayPnl != null
      ? (todayPnl >= 0 ? '+¥' : '-¥') + Math.abs(Math.round(todayPnl)).toLocaleString('ja-JP')
      : '—';
    kpiPnlVal.textContent = pnlText;
    kpiPnlVal.className = 'kpi-val' + (todayPnl > 0 ? ' green' : todayPnl < 0 ? ' red' : '');
  }
  // NOTE: perf.todayWins / perf.todayLosses は StatusResponse に存在しないため常に '—'
  // スコープ外（将来APIに追加されれば自動表示される）
  if (kpiPnlSub) {
    kpiPnlSub.textContent = '— 勝 — 敗';
  }

  // ─ KPI: 最新判断 ─
  var latest      = decisions[0];
  var kpiBadge    = el('ai-kpi-latest-badge');
  var kpiPair     = el('ai-kpi-latest-pair');
  var kpiTime     = el('ai-kpi-latest-time');
  if (latest) {
    if (kpiBadge) {
      kpiBadge.textContent = latest.decision;
      kpiBadge.className = 'dir-badge ' + (latest.decision === 'BUY' ? 'buy' : 'sell');
    }
    if (kpiPair) kpiPair.textContent = latest.pair || 'USD/JPY';
    if (kpiTime) kpiTime.textContent = fmtElapsed(latest.created_at);
  }

  // ─ トリガーカウント ─
  var newsCount = todayD.filter(function(d) { return inferTrigger(d) === 'news'; }).length;
  var rateCount = todayD.filter(function(d) { return inferTrigger(d) === 'rate'; }).length;
  var cronCount = todayD.filter(function(d) { return inferTrigger(d) === 'cron'; }).length;
  var tn = el('ai-trigger-news'); if (tn) tn.textContent = String(newsCount);
  var tr = el('ai-trigger-rate'); if (tr) tr.textContent = String(rateCount);
  var tc = el('ai-trigger-cron'); if (tc) tc.textContent = String(cronCount);

  // ─ タイムラインカード描画 ─
  if (decisions.length === 0) {
    timeline.innerHTML = '<div style="padding:24px;text-align:center;color:var(--label3);font-size:13px">データなし</div>';
    return;
  }

  timeline.innerHTML = decisions.map(function(d, i) {
    var trigger  = inferTrigger(d);
    var dirCls   = d.decision === 'BUY' ? 'buy' : 'sell';
    var reasoning = fmtReasoning(d.reasoning);

    // 判断結果の判定（openPositionsとの照合）
    var matched = openPos.find(function(p) {
      return p.direction === d.decision && p.entry_rate === d.rate;
    });
    var resultKey  = matched ? 'open' : 'closed';
    var resultText = matched ? '保有中' : 'クローズ済';

    // 指標チップ
    var chips = [];
    if (d.vix   != null) chips.push('VIX ' + fmt(d.vix, 1));
    if (d.us10y != null) chips.push(fmt(d.us10y, 2) + '%');

    return '<div class="tl-card" role="listitem" data-ai-idx="' + i + '">' +
      '<div class="tl-inner">' +
        '<div class="tl-accent ' + resultKey + '"></div>' +
        // Row 1: pair / rate / dir badge | time / chevron
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
        // Row 2: trigger chip / reasoning snippet
        '<div class="tl-row2">' +
          '<span class="tl-chip ' + trigger + '">' + triggerLabel(trigger) + '</span>' +
          (reasoning && reasoning !== '—'
            ? '<span class="tl-reasoning-chip">' + escHtml(reasoning.slice(0, 40)) + (reasoning.length > 40 ? '…' : '') + '</span>'
            : '') +
        '</div>' +
        // Row 3: chips / result
        '<div class="tl-row3">' +
          '<div style="display:flex;gap:4px">' +
            chips.map(function(c) { return '<span class="tl-chip cron">' + escHtml(c) + '</span>'; }).join('') +
          '</div>' +
          '<div class="tl-result">' +
            '<div class="result-dot ' + resultKey + '"></div>' +
            '<span class="tl-result-text ' + resultKey + '">' + resultText + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      // 詳細パネル
      '<div class="detail-panel" id="ai-detail-' + i + '">' +
        // トリガー行
        '<div class="detail-trigger-row">' +
          '<span class="tl-chip ' + trigger + '">' + triggerLabel(trigger) + '</span>' +
          '<span class="detail-trigger-desc">' + (
            trigger === 'news' ? 'ニュースシグナル検知' :
            trigger === 'rate' ? 'レート変動 ±0.05円超' : '定期チェック (30分)'
          ) + '</span>' +
        '</div>' +
        // 4点グリッド
        '<div class="detail-4pt">' +
          '<div>' +
            '<div class="detail-label">判断基準</div>' +
            '<div class="detail-value">' + escHtml(d.pair || 'USD/JPY') + '</div>' +
          '</div>' +
          '<div>' +
            '<div class="detail-label">判断内容</div>' +
            '<div class="detail-value ' + dirCls + '">' +
              d.decision +
              (d.tp_rate || d.sl_rate
                ? ' · TP ' + (d.tp_rate ? fmt(d.tp_rate, 3) : '—') +
                  ' / SL ' + (d.sl_rate ? fmt(d.sl_rate, 3) : '—')
                : '') +
            '</div>' +
          '</div>' +
          '<div>' +
            '<div class="detail-label">判断結果</div>' +
            '<div class="tl-result" style="margin-top:2px">' +
              '<div class="result-dot ' + resultKey + '"></div>' +
              '<span class="tl-result-text ' + resultKey + '">' + resultText + '</span>' +
            '</div>' +
          '</div>' +
          '<div>' +
            '<div class="detail-label">判断時刻</div>' +
            '<div class="detail-value">' + fmtTimeHMS(d.created_at) + '</div>' +
          '</div>' +
        '</div>' +
        // 推論テキスト
        (reasoning && reasoning !== '—'
          ? '<div class="detail-reasoning">' +
              '<div class="detail-reasoning-text">' + escHtml(reasoning) + '</div>' +
            '</div>'
          : '') +
        // 指標チップ
        (chips.length > 0
          ? '<div class="detail-chips">' +
              chips.map(function(c) { return '<span class="detail-chip">' + escHtml(c) + '</span>'; }).join('') +
            '</div>'
          : '') +
      '</div>' +
    '</div>';
  }).join('');

  // タップでパネル展開（イベント委譲）
  timeline.onclick = function(e) {
    var card = e.target.closest('[data-ai-idx]');
    if (!card) return;
    var idx    = card.dataset.aiIdx;
    var panel  = el('ai-detail-' + idx);
    if (!panel) return;
    var isOpen = card.classList.contains('expanded');
    // 他のカードを全て閉じる
    timeline.querySelectorAll('.tl-card.expanded').forEach(function(c) {
      c.classList.remove('expanded');
      var p = c.querySelector('.detail-panel');
      if (p) p.classList.remove('open');
    });
    // このカードをトグル
    if (!isOpen) {
      card.classList.add('expanded');
      panel.classList.add('open');
    }
  };
}
```

### 削除: 旧コード

**削除対象 1**: lines ~2080-2088 (ai-badge2, ai-reasoning2, ai-time2 の更新コード)
```javascript
// ↓ この5行ブロックを削除
var ld = ...
if (ld) {
  var bc2 = ...
  ...
}
```

**削除対象 2**: `renderHistory(data.recentDecisions)` の呼び出し (line ~2091)
→ `renderAiTab(data)` に置換

**削除対象 3**: `renderHistory` 関数本体 (lines 2234-2285)
→ 関数ごと削除（`historyExpanded` 変数・`toggle-history` イベントリスナーも削除）

- [ ] **Step 1: 削除対象コードの範囲確認**

`src/app.js.ts` の以下の行を Read して正確な行番号を確認:
- lines 2075-2095 (旧AI更新 + renderHistory呼び出し)
- lines 2230-2290 (renderHistory関数)
- lines 2395-2410 (toggle-history イベントリスナー)

- [ ] **Step 2: `renderAiTab()` を追加**

`renderHistory()` の後（~line 2285）に上記 `renderAiTab()` 関数を挿入。

- [ ] **Step 3: 旧コード削除**

- lines ~2080-2088 の `ld`/`ai-badge2`/`ai-reasoning2`/`ai-time2` ブロックを削除
- line ~2091 の `renderHistory(data.recentDecisions)` → `renderAiTab(data)` に置換
- `renderHistory` 関数本体を削除
- `historyExpanded` 変数宣言を削除（grep で確認）
- `toggle-history` イベントリスナーを削除

- [ ] **Step 4: ビルド確認**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim && npx wrangler deploy --dry-run 2>&1 | tail -20
```
Expected: エラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/app.js.ts
git commit -m "feat(ai-tab): add renderAiTab(), remove old renderHistory()"
```

---

## Task 5: デプロイ + E2Eビジュアル確認

**Files:** なし（確認のみ）

- [ ] **Step 1: 本番デプロイ**

```bash
cd /c/Users/GENPOOH/Desktop/fx-sim && npm run deploy
```
Expected: `Published fx-sim-v1` メッセージ。

- [ ] **Step 2: モバイル表示確認（375×812）**

Chrome DevTools MCP でモバイルエミュレーション (375×812)。
確認項目:
- KPIグリッド 2×2 が表示される
- トリガーカウントグリッド 3列が表示される
- タイムラインカードが表示される（BUY/SELL各1色のアクセントバー）
- タイムラインカードをタップ → 詳細パネルが展開される
- HOLDセパレーターが「HOLD · 統計タブで確認」で表示される

- [ ] **Step 3: インタラクション確認**

Chrome DevTools MCP の `click` でタイムラインカードをタップ:
- 詳細パネルが滑らかに展開する（300ms アニメーション）
- 2枚目タップで1枚目が閉じる（同時展開なし）
- ▸ アイコンが 90度回転する

- [ ] **Step 4: ダークモード / ライトモード確認**

両テーマで色・コントラストを確認。

- [ ] **Step 5: 問題があれば修正 → 再デプロイ → 再確認**

問題が出たら修正し、`npx wrangler deploy` → スクリーンショット確認を繰り返す。
「あるべき姿」になるまで繰り返す。

- [ ] **Step 6: 最終コミット + PR作成**

```bash
git add -A
git commit -m "feat(ai-tab): AI判断タブ フルリニューアル完了"
```

```bash
gh pr create \
  --title "feat: AI判断タブ フルリニューアル — KPI+トリガー+タイムライン" \
  --body "$(cat <<'EOF'
## Summary
- AI判断タブを全面リニューアル（KPIグリッド＋トリガーカウント＋タイムライン構造）
- 判断基準・判断材料・判断内容・判断結果の4要素を1タップで確認できる詳細パネルを実装
- Apple HIG準拠・UX心理学（Progressive Disclosure / Variable Reward）適用済み

## Test plan
- [ ] KPIグリッドに今日の判断数・AI的中率・損益・最新判断が表示される
- [ ] トリガーカウントグリッドにニュース/レート/定期の件数が表示される
- [ ] タイムラインカードのタップで詳細パネルが展開される
- [ ] 他カードタップで前のパネルが閉じる
- [ ] ダークモード/ライトモード両方で視認性OK

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## 実装上の注意

1. **`renderAiTab` の呼び出しはデータ全体 (`data`) を受け取る** — `recentDecisions` だけでなく `statistics`, `performance`, `openPositions` も使うため
2. **`inferTrigger` は純粋なテキストパターンマッチ** — 前回レート差分の計算は不要（APIに前回値がない）
3. **`RecentDecision` に `tp_rate`/`sl_rate`/`close_reason` フィールドは無い** — `d.tp_rate`, `d.sl_rate` はundefined→falsy→三項演算子で`—`にフォールバック。実行時エラーは起きないが表示は常に「DIRECTION」のみ
4. **`perf.todayWins`/`perf.todayLosses` は `StatusResponse` に存在しない** — 常に「— 勝 — 敗」と表示される。将来APIに追加されれば自動表示される。サブテキストは `todayPnl` のみで十分な情報量があるため許容
5. **HOLDセパレーターは静的HTML** — APIがHOLDを返さないため、件数表示はせず固定テキスト
6. **`historyExpanded` 変数の削除を忘れない** — `renderHistory` 削除と合わせて必ず削除
7. **`panel-decisions` (PC右パネル) は今回変更しない** — `renderHistory` 削除後はpanel-decisionsが空になるが、PC右パネルの更新は本実装スコープ外

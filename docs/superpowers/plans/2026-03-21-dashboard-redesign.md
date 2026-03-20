# Dashboard UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** モックアップ（`/tmp/brainstorm/full-redesign-mockup.html`）のデザインを本番コードベース（`src/dashboard.ts`, `src/style.css.ts`, `src/app.js.ts`）に実装する。

**Architecture:** 3ファイルを順番に修正する。バックエンドAPIの変更はゼロ（既存の `statistics.hierarchicalWinRates`, `statistics.powerAnalysis`, `statistics.ewmaVol` を活用）。CSS変数を追加し、HTMLに新コンポーネントのプレースホルダーを配置し、JSでデータを流し込む。

**Tech Stack:** TypeScript (Cloudflare Workers), Vanilla JS (iife pattern), CSS変数 + Apple HIG, Cloudflare D1

---

## ファイル構造

| ファイル | 変更内容 |
|---------|---------|
| `src/style.css.ts` | CSS変数更新・グラスモーフィズム・新コンポーネントスタイル追加 |
| `src/dashboard.ts` | 資産タブ新セクション・統計タブHTML再構成 |
| `src/app.js.ts` | `renderMarketStateBar()` 追加、`renderAiRanking()` 追加、`renderPerfSummary()` ナラティブ化、`renderStats()` 更新 |

---

## Task 1: CSS — Design Tokens & グラスモーフィズム

**Files:**
- Modify: `src/style.css.ts`

**変更箇所:** `:root` の `--radius` を `16px` に変更。ヘッダー・タブバーに glassmorphism を追加。

- [ ] **Step 1: `--radius` を `12px → 16px` に変更**

`src/style.css.ts` の `:root` ブロックを修正:
```css
/* 変更前 */
--radius:           12px;
--radius-sm:        8px;

/* 変更後 */
--radius:           16px;
--radius-sm:        10px;
```

`Edit` ツールで対象行のみ変更する。

- [ ] **Step 2: ヘッダーにグラスモーフィズムを適用**

`src/style.css.ts` 内の `.header` クラスを探し、以下を追加:
```css
.header {
  background: rgba(28,28,30,0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(84,84,88,0.3);
}
```

ライトモードでは `background: rgba(242,242,247,0.92)` に上書きする。

- [ ] **Step 3: タブバーにグラスモーフィズムを適用**

`src/style.css.ts` 内の `.tab-bar` クラスに以下を追加:
```css
.tab-bar {
  background: rgba(28,28,30,0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-top: 1px solid rgba(84,84,88,0.3);
}
```

- [ ] **Step 4: 新コンポーネント CSS を追記**

`src/style.css.ts` の末尾（閉じるバッククォートの直前）に以下を追加:

```css
/* ─── 市場状態サマリーバー ─── */
.market-state-bar {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0;
  background: var(--bg-elevated);
  border-radius: var(--radius);
  border: 1px solid rgba(255,255,255,0.05);
  margin: 0 16px 8px;
  overflow: hidden;
}
.market-state-cell {
  padding: 12px 8px;
  text-align: center;
  border-right: 1px solid rgba(84,84,88,0.2);
}
.market-state-cell:last-child { border-right: none; }
.market-state-label {
  font-size: 11px;
  color: var(--label-secondary);
  margin-bottom: 4px;
}
.market-state-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--label);
}

/* ─── AI期待銘柄ランキング ─── */
.ai-ranking-header {
  padding: 8px 16px 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--label-secondary);
}
.ai-ranking-list {
  background: var(--bg-elevated);
  border-radius: var(--radius);
  border: 1px solid rgba(255,255,255,0.05);
  margin: 0 16px 8px;
  overflow: hidden;
}
.ai-ranking-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  min-height: 44px;
  border-bottom: 1px solid rgba(84,84,88,0.15);
  transition: background 0.15s;
}
.ai-ranking-row:last-child { border-bottom: none; }
.ai-ranking-row:active { background: rgba(255,255,255,0.04); }
.ai-ranking-medal {
  font-size: 16px;
  width: 24px;
  text-align: center;
  flex-shrink: 0;
}
.ai-ranking-name {
  flex: 1;
  font-size: 15px;
  font-weight: 500;
}
.ai-ranking-bar {
  width: 80px;
  height: 4px;
  background: rgba(255,255,255,0.08);
  border-radius: 2px;
  overflow: hidden;
  flex-shrink: 0;
}
.ai-ranking-bar-fill {
  height: 100%;
  background: var(--green);
  border-radius: 2px;
}
.ai-ranking-pct {
  font-size: 14px;
  font-weight: 600;
  color: var(--green);
  width: 44px;
  text-align: right;
  flex-shrink: 0;
}

/* ─── 統計的有意性プログレスバー（ヒーロー内） ─── */
.power-progress-wrap {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(84,84,88,0.2);
}
.power-progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.power-progress-label {
  font-size: 11px;
  color: var(--label-secondary);
}
.power-progress-pct {
  font-size: 11px;
  font-weight: 600;
  color: var(--orange);
}
.power-progress-track {
  height: 6px;
  background: rgba(255,255,255,0.08);
  border-radius: 3px;
  position: relative;
  overflow: visible;
}
.power-progress-fill {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--orange), var(--green));
  position: relative;
  transition: width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.power-progress-dot {
  position: absolute;
  right: -5px;
  top: 50%;
  transform: translateY(-50%);
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--green);
  box-shadow: 0 0 6px rgba(48,209,88,0.5);
}
.power-progress-sub {
  font-size: 10px;
  color: var(--label-secondary);
  margin-top: 4px;
}

/* ─── レジームバッジ ─── */
.regime-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 6px;
  letter-spacing: 0.02em;
}
.regime-badge--volatile {
  background: rgba(255,69,58,0.15);
  color: var(--red);
}
.regime-badge--ranging {
  background: rgba(255,159,10,0.15);
  color: var(--orange);
}
.regime-badge--trending {
  background: rgba(10,132,255,0.15);
  color: var(--blue);
}

/* ─── 統計タブ ナラティブ構造 ─── */
.stats-narrative-section {
  margin: 0 16px 12px;
}
.stats-narrative-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0 8px;
}
.stats-narrative-question {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--label);
}
.stats-verdict {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 8px;
  flex-shrink: 0;
}
.stats-verdict--yes {
  background: rgba(48,209,88,0.15);
  color: var(--green);
}
.stats-verdict--no {
  background: rgba(255,69,58,0.15);
  color: var(--red);
}
.stats-verdict--warn {
  background: rgba(255,159,10,0.15);
  color: var(--orange);
}
.stats-card {
  background: var(--bg-elevated);
  border-radius: var(--radius);
  border: 1px solid rgba(255,255,255,0.05);
  padding: 16px;
  margin-bottom: 8px;
}
.stats-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 24px;
}
.stats-metric-label {
  font-size: 11px;
  color: var(--label-secondary);
  margin-bottom: 2px;
}
.stats-metric-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
}
.stats-metric-sub {
  font-size: 11px;
  color: var(--label-secondary);
  margin-top: 2px;
}
.ci-bar-wrap {
  background: var(--bg-elevated);
  border-radius: var(--radius);
  border: 1px solid rgba(255,255,255,0.05);
  padding: 12px 16px;
  margin-bottom: 8px;
}
.ci-bar-header {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--label-secondary);
  margin-bottom: 8px;
}
.ci-bar-track {
  height: 6px;
  background: rgba(255,255,255,0.08);
  border-radius: 3px;
  position: relative;
}
.ci-bar-fill {
  position: absolute;
  height: 100%;
  background: var(--blue);
  border-radius: 3px;
}
.ci-bar-marker {
  position: absolute;
  top: -4px;
  width: 2px;
  height: 14px;
  background: rgba(255,255,255,0.4);
  border-radius: 1px;
}
.ci-bar-labels {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--label-secondary);
  margin-top: 4px;
}
```

- [ ] **Step 5: ライトモード上書きを追加**

```css
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .header,
  :root:not([data-theme="dark"]) .tab-bar {
    background: rgba(242,242,247,0.92);
  }
  :root:not([data-theme="dark"]) .market-state-bar,
  :root:not([data-theme="dark"]) .ai-ranking-list,
  :root:not([data-theme="dark"]) .stats-card,
  :root:not([data-theme="dark"]) .ci-bar-wrap {
    border-color: rgba(0,0,0,0.06);
  }
}
```

- [ ] **Step 6: デプロイして CSS が壊れていないことを確認**

```bash
cd C:/Users/GENPOOH/Desktop/fx-sim
npx wrangler deploy 2>&1 | tail -5
```

期待: `Deployed fx-sim-v1 triggers` が出ること

---

## Task 2: dashboard.ts — 資産タブ新コンポーネントの HTML 追加

**Files:**
- Modify: `src/dashboard.ts`

**変更方針:**
- Hero カードの閉じタグ (`</section>`) の直後に `<div id="market-state-bar" class="market-state-bar"></div>` を挿入
- AI最新判断カードの前に AI ranking のプレースホルダーを挿入
- Hero カードの内部に progress bar セクションを追加
- 統計タブの `<div id="perf-summary"></div>` を除去（JS側で `#stats-narrative` に書き込む）

- [ ] **Step 1: Hero カード内部に progress bar を追加**

`dashboard.ts` の L136-138 の以下のテキストを `old_string` に使う（複数行のまま）:
```html
        </div>
      </section>
```
この直前（`</div>` と `</section>` の間）に挿入する。具体的には Edit ツールで:
```html
        </div>
        <div class="power-progress-wrap" id="power-progress-wrap">
          <!-- JS が renderPowerProgress() で書き込む -->
        </div>
      </section>
```
と置換する。

実際の挿入 HTML:
```html
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
```

- [ ] **Step 2: 市場状態バーのプレースホルダーを追加**

Hero `</section>` の直後（AI card `<div class="ai-rich-card"...>` の前）に:
```html
      <!-- 市場状態サマリーバー -->
      <div id="market-state-bar" class="market-state-bar" style="display:none"></div>
```

- [ ] **Step 3: AI ランキングセクションを追加**

市場状態バーの直後（AI card の前）に:
```html
      <!-- AI期待銘柄ランキング -->
      <div id="ai-ranking-section" style="display:none">
        <div class="ai-ranking-header">AI 期待銘柄ランキング</div>
        <div class="ai-ranking-list" id="ai-ranking-list"></div>
      </div>
```

- [ ] **Step 4: 統計タブを再構成**

`dashboard.ts` L201-204 の以下の複数行テキストを Edit ツールの `old_string` にそのまま使う:
```html
      <div class="card" style="padding:12px 16px">
        <div id="perf-summary"></div>
      </div>
```
これを削除して代わりに:
```html
      <!-- 統計ナラティブ（JSが書き込む） -->
      <div id="stats-narrative"></div>
```

- [ ] **Step 5: バージョン番号をバンプ**

`dashboard.ts` L14 の `style.css?v=9` → `style.css?v=10` に変更:
```
old: <link rel="stylesheet" href="/style.css?v=9">
new: <link rel="stylesheet" href="/style.css?v=10">
```

`dashboard.ts` L304 の `app.js?v=9` → `app.js?v=10` に変更:
```
old: <script src="/app.js?v=9"></script>
new: <script src="/app.js?v=10"></script>
```

- [ ] **Step 6: デプロイ確認**

```bash
npx wrangler deploy 2>&1 | tail -5
```

---

## Task 3: app.js.ts — JS ロジック実装

**Files:**
- Modify: `src/app.js.ts`

### 3-A: レジーム判定ユーティリティ

- [ ] **Step 1: `calcRegime()` 関数を追加**

`escHtml()` 関数の直後に:
```javascript
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
    var map = {
      volatile: 'volatile',
      ranging:  'ranging',
      trending: 'trending'
    };
    var cls = 'regime-badge regime-badge--' + (map[regime] || 'ranging');
    return '<span class="' + cls + '">' + (regime || 'ranging') + '</span>';
  }
```

### 3-B: 市場状態サマリーバー

- [ ] **Step 2: `renderMarketStateBar()` 関数を追加**

`renderPerfSummary()` の直前に:
```javascript
  // ── 市場状態サマリーバー（ヒーロー下の帯） ──
  function renderMarketStateBar(data) {
    var bar = el('market-state-bar');
    if (!bar) return;
    var st = data.statistics;
    var regime = calcRegime(st);
    var ewma = st && st.ewmaVol;
    var volLabel = ewma ? (ewma.isHighVol ? '高め' : '普通') : '—';
    var volColor = ewma && ewma.isHighVol ? 'var(--orange)' : 'var(--green)';
    var regimeColor = regime === 'volatile' ? 'var(--red)'
                    : regime === 'trending' ? 'var(--blue)'
                    : 'var(--orange)';
    var logStats = data.systemStatus;
    var totalRuns = (logStats && logStats.totalRuns) || 0;
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
```

### 3-C: AI 銘柄ランキング

- [ ] **Step 3: `renderAiRanking()` 関数を追加**

`renderMarketStateBar()` の直後に:
```javascript
  // ── AI期待銘柄ランキング（階層ベイズ勝率 TOP3） ──
  function renderAiRanking(data) {
    var section = el('ai-ranking-section');
    var listEl  = el('ai-ranking-list');
    if (!section || !listEl) return;
    var rates = (data.statistics && data.statistics.hierarchicalWinRates) || [];
    // n >= 3 のみ対象、bayesRate 降順
    var ranked = rates
      .filter(function(r) { return r.n >= 3; })
      .sort(function(a, b) { return b.bayesRate - a.bayesRate; })
      .slice(0, 3);
    if (ranked.length === 0) { section.style.display = 'none'; return; }

    var medals = ['🥇', '🥈', '🥉'];
    var html = ranked.map(function(r, i) {
      var pct = (r.bayesRate * 100).toFixed(1);
      var barW = Math.round(r.bayesRate * 100);  // 0–100
      // 銘柄ラベルを INSTRUMENTS から解決
      var inst = INSTRUMENTS.find(function(x) { return x.pair === r.pair; });
      var label = inst ? inst.label : r.pair;
      return '<div class="ai-ranking-row">' +
        '<span class="ai-ranking-medal">' + medals[i] + '</span>' +
        '<span class="ai-ranking-name">' + escHtml(label) + '</span>' +
        '<div class="ai-ranking-bar"><div class="ai-ranking-bar-fill" style="width:' + barW + '%"></div></div>' +
        '<span class="ai-ranking-pct">' + pct + '%</span>' +
      '</div>';
    }).join('');

    listEl.innerHTML = html;
    section.style.display = '';
  }
```

### 3-D: 統計的有意性プログレスバー

- [ ] **Step 4: `renderPowerProgress()` 関数を追加**

```javascript
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
    var pct = Math.min(Math.round(pa.progressPct), 100);
    fillEl.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '% 達成';
    if (subEl) subEl.textContent = pa.currentN.toLocaleString('ja-JP') + ' / ' + pa.requiredN.toLocaleString('ja-JP') + ' 件';

    // 有意性達成済みなら green に
    if (pa.isAdequate) {
      fillEl.style.background = 'var(--green)';
      if (pctEl) { pctEl.textContent = '✓ 達成'; pctEl.style.color = 'var(--green)'; }
    }
  }
```

### 3-E: `renderPerfSummary()` をナラティブ構造に置換

- [ ] **Step 5: `renderPerfSummary()` を完全置換**

既存の `renderPerfSummary()` 関数（約90行）を削除し、以下で置換:

```javascript
  // ── 統計タブ ナラティブサマリー（問い→答え形式） ──
  function renderPerfSummary(data) {
    var target = el('stats-narrative');
    if (!target) return;
    var st = data.statistics;
    if (!st) {
      target.innerHTML = '<div style="text-align:center;padding:40px 16px;color:var(--label-secondary);font-size:13px">統計データ蓄積中...</div>';
      return;
    }

    // ── ① 「このAIは統計的に勝てているか？」 ──
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
    var beatRate = baseline ? '+' + (baseline.beatRate * 100 - 50).toFixed(1) + '%' : '—';
    var pValue   = baseline ? 'p=' + baseline.mwu.pValue.toFixed(3) + (baseline.mwu.significant ? ' 有意' : '') : '—';
    var brierStr = aiAcc ? aiAcc.brierScore.toFixed(2) : '—';
    var accPct   = aiAcc ? (aiAcc.accuracy * 100).toFixed(1) + '%' : '—';

    // 総合判定
    var winVerdict = wrCI.lower > 0.5 && (roiCI && roiCI.ciLower > 0);
    var verdictCls = winVerdict ? 'yes' : 'warn';
    var verdictTxt = winVerdict ? '✓ YES' : '△ 様子見';

    // ── ② 「リスクに見合ったリターンか？」 ──
    var sharpe = st.sharpe;
    var dd = st.drawdown;
    var var95 = Math.round(st.var95);
    var kelly = (st.kellyFraction * 100).toFixed(1);
    var sharpeColor = sharpe >= 1 ? 'var(--green)' : sharpe >= 0.5 ? 'var(--label)' : 'var(--red)';
    var ddColor = dd.maxDDPct > 15 ? 'var(--red)' : dd.maxDDPct > 8 ? 'var(--orange)' : 'var(--label)';
    var riskVerdict = sharpe >= 0.5 && dd.maxDDPct < 20;
    var riskVerdictCls = riskVerdict ? 'yes' : 'warn';
    var riskVerdictTxt = riskVerdict ? '✓ YES' : '△ 要注意';

    // ── ③ 「どの銘柄が得意か？」 ──
    var hierRates = st.hierarchicalWinRates || [];
    var topPairs = hierRates
      .filter(function(r) { return r.n >= 3; })
      .sort(function(a, b) { return b.bayesRate - a.bayesRate; })
      .slice(0, 3);
    var medals = ['🥇', '🥈', '🥉'];
    var pairsVerdict = topPairs.length >= 2 ? 'yes' : 'warn';
    var pairsVerdictTxt = topPairs.length >= 2 ? '✓ 明確' : '△ 不明瞭';

    // ── 信頼区間バー ──
    // 勝率CIが50%ラインに対してどの位置か
    var ciMin = Math.min(wrCI.lower * 100, 48);
    var ciMax = Math.max(wrCI.upper * 100, 52);
    var ciRange = ciMax - ciMin || 1;
    var lineAt50 = ((50 - ciMin) / (ciMax - ciMin) * 100).toFixed(1);
    var fillLeft  = ((wrCI.lower * 100 - ciMin) / (ciMax - ciMin) * 100).toFixed(1);
    var fillWidth = (((wrCI.upper - wrCI.lower) * 100) / (ciMax - ciMin) * 100).toFixed(1);
    var above50 = wrCI.lower * 100 > 50 ? '50% 超え確認' : '50% 超え未確認';
    var above50Color = wrCI.lower * 100 > 50 ? 'var(--green)' : 'var(--label-secondary)';

    target.innerHTML =
      // ① 勝てているか
      '<div class="stats-narrative-section">' +
        '<div class="stats-narrative-header">' +
          '<div class="stats-narrative-question">' +
            '<span>📊</span><span>このAIは統計的に勝てているか？</span>' +
          '</div>' +
          '<span class="stats-verdict stats-verdict--' + verdictCls + '">' + verdictTxt + '</span>' +
        '</div>' +
        '<div class="stats-card">' +
          '<div class="stats-grid-2">' +
            '<div>' +
              '<div class="stats-metric-label">勝率 95% CI</div>' +
              '<div class="stats-metric-value" style="color:var(--green)">' + (wrCI.lower * 100).toFixed(1) + '%</div>' +
              '<div class="stats-metric-sub">[' + wrLo + '% – ' + wrHi + '%]</div>' +
            '</div>' +
            '<div>' +
              '<div class="stats-metric-label">ROI 95% CI</div>' +
              '<div class="stats-metric-value" style="color:var(--green)">' + wrPct + '</div>' +
              '<div class="stats-metric-sub">[' + roiLo + ' – ' + roiHi + ']</div>' +
            '</div>' +
            '<div>' +
              '<div class="stats-metric-label">AI精度</div>' +
              '<div class="stats-metric-value">' + accPct + '</div>' +
              '<div class="stats-metric-sub">Brier ' + brierStr + '</div>' +
            '</div>' +
            '<div>' +
              '<div class="stats-metric-label">vs ランダム</div>' +
              '<div class="stats-metric-value" style="color:var(--green)">' + beatRate + '</div>' +
              '<div class="stats-metric-sub">' + pValue + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        // CI バー
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
            '<span>⚖️</span><span>リスクに見合ったリターンか？</span>' +
          '</div>' +
          '<span class="stats-verdict stats-verdict--' + riskVerdictCls + '">' + riskVerdictTxt + '</span>' +
        '</div>' +
        '<div class="stats-card">' +
          '<div class="stats-grid-2">' +
            '<div>' +
              '<div class="stats-metric-label">Sharpe比</div>' +
              '<div class="stats-metric-value" style="color:' + sharpeColor + '">' + sharpe.toFixed(2) + '</div>' +
              '<div class="stats-metric-sub">±' + st.sharpeSE.toFixed(2) + (st.sharpeSignificant ? ' (有意)' : '') + '</div>' +
            '</div>' +
            '<div>' +
              '<div class="stats-metric-label">最大DD</div>' +
              '<div class="stats-metric-value" style="color:' + ddColor + '">-' + dd.maxDDPct.toFixed(1) + '%</div>' +
              '<div class="stats-metric-sub">許容範囲内</div>' +
            '</div>' +
            '<div>' +
              '<div class="stats-metric-label">VaR 95%</div>' +
              '<div class="stats-metric-value">-' + var95.toLocaleString('ja-JP') + '</div>' +
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
            '<span>🎯</span><span>どの銘柄が得意か？</span>' +
          '</div>' +
          '<span class="stats-verdict stats-verdict--' + pairsVerdict + '">' + pairsVerdictTxt + '</span>' +
        '</div>' +
        (topPairs.length > 0 ?
          '<div class="ai-ranking-list" style="margin:0">' +
          topPairs.map(function(r, i) {
            var inst = INSTRUMENTS.find(function(x) { return x.pair === r.pair; });
            var label = inst ? inst.label : r.pair;
            var pct = (r.bayesRate * 100).toFixed(1);
            var barW = Math.round(r.bayesRate * 100);
            return '<div class="ai-ranking-row">' +
              '<span class="ai-ranking-medal">' + medals[i] + '</span>' +
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
```

### 3-F: `renderStats()` — 変更不要を確認

- [ ] **Step 6: `renderStats()` を確認（変更なし）**

`app.js.ts` L1418-1420 の既存 `renderStats()` の先頭:
```javascript
  function renderStats(data) {
    renderEquityChart(data);
    renderPerfSummary(data);
```
`renderPerfSummary(data)` はステップ 3-E で新版に置換済みのため、`renderStats()` 自体への変更は不要。
ただし `stats-pairs` 銘柄カード描画の部分で `perf-summary` IDへの参照がないことを確認する（grep で確認）:

```bash
grep -n "perf-summary" src/app.js.ts
```

期待: 0件（`renderPerfSummary()` 内で `el('perf-summary')` を参照していたので、Task 2 Step 4 で ID を変更したら関数内も `el('stats-narrative')` に更新されているはず）

### 3-G: メインの `render(data)` から新関数を呼ぶ

- [ ] **Step 7: `render()` 内に新関数呼び出しを追加**

`renderStats(data)` が呼ばれている付近を見つけ、その前に以下を追加:

```javascript
    // 市場状態バー・AI ランキング・プログレスバー（資産タブ）
    renderMarketStateBar(data);
    renderAiRanking(data);
    renderPowerProgress(data);
```

- [ ] **Step 8: デプロイ**

```bash
npx wrangler deploy 2>&1 | tail -5
```

- [ ] **Step 9: Chrome DevTools で E2E 確認**

1. `http://localhost:61697/` をリロード（または本番 URL）
2. スクリーンショット（モバイル 375x812）で以下を目視確認:
   - 資産タブ: 市場状態バー（4カラム）が表示
   - 資産タブ: AI ランキング（最低3件）が表示
   - 資産タブ: Hero 内プログレスバーが表示
   - 統計タブ: ナラティブ3問 + ✓YES/△ バッジが表示
   - CI バーが勝率区間に応じて正しく描画

---

## Task 4: コミット

- [ ] **Step 1: 変更ファイルを確認**

```bash
git diff --stat
```

期待: `src/style.css.ts`, `src/dashboard.ts`, `src/app.js.ts` の3ファイル

- [ ] **Step 2: コミット**

```bash
git add src/style.css.ts src/dashboard.ts src/app.js.ts
git commit -m "feat: ダッシュボード UX リニューアル実装

- CSS: --radius 16px・グラスモーフィズム・新コンポーネントスタイル追加
- 資産タブ: 市場状態バー・AI銘柄ランキング・統計的有意性プログレスバー追加
- 統計タブ: ナラティブ型（問い→答え）構造に全面刷新
- UX心理学: Peak-End・Zeigarnik・Goal Gradient・Loss Aversion 適用

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

- [ ] **Step 3: デザインガイドライン更新を確認**

`docs/06_デザイン_ブランドガイドライン.md` に Section 10 の恒久禁止ルールが記録済みであることを確認。
（前セッションで更新済み — 追加不要）

---

## 完了基準チェックリスト

- [ ] `--radius: 16px` が適用されている（カードが丸くなった）
- [ ] ヘッダー・タブバーがガラス感のある半透明になった
- [ ] 資産タブに市場状態4カラムバーが表示される
- [ ] 資産タブに AI 銘柄ランキング TOP3 が表示される
- [ ] ヒーローカード下部にプログレスバーが出る
- [ ] 統計タブが「問い→答え」のナラティブ構造になった
- [ ] CI バーが 50% ラインを基準に勝率区間を可視化している
- [ ] 全インタラクティブ要素に `:active` フィードバックがある
- [ ] デプロイ後に本番で動作確認済み（Chrome DevTools MCP でスクショ）

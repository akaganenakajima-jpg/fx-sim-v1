# PC版レスポンシブデザイン 実装計画

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** モバイルファーストのFX Simダッシュボードを FHD/2K/4K デスクトップに最適化する

**Architecture:** 既存の3ファイル（dashboard.ts, style.css.ts, app.js.ts）にメディアクエリとPC用HTML要素を追記。新規ファイルは作成しない。clamp() ベースの滑らかなスケーリングで FHD〜4K の解像度差を吸収。

**Tech Stack:** TypeScript (Cloudflare Workers), vanilla CSS (media queries + clamp()), vanilla JS

**Spec:** `docs/superpowers/specs/2026-03-20-pc-responsive-design.md`

---

## ファイルマップ

| ファイル | 変更内容 | 責務 |
|---|---|---|
| `src/style.css.ts` | PC用CSS変数追加、4段階メディアクエリ追加 | レイアウト・スケーリング・表示切替 |
| `src/dashboard.ts` | 左サイドバー・右パネルのHTML追加、viewport meta変更 | HTML構造 |
| `src/app.js.ts` | サイドバータブ切替、キーボードショートカット、パネルコンテキスト連動、テーブル表示切替 | インタラクション |

---

## Task 1: PC用CSS変数とベーススタイル追加

**Files:**
- Modify: `src/style.css.ts`

- [ ] **Step 1: PC用CSS変数を `:root` に追加**

`style.css.ts` の既存CSS変数定義（`:root { ... }`）の末尾に以下を追加:

```css
--sidebar-bg: var(--bg);
--sidebar-width: clamp(56px, 3.5vw, 72px);
--panel-bg: var(--bg-elevated);
--panel-width: clamp(300px, 18vw, 420px);
--panel-border: var(--separator);
--container-max: clamp(1200px, 85vw, 2200px);
```

- [ ] **Step 2: デプロイして変数が反映されることを確認**

Run: `npx wrangler deploy`
Chrome DevTools MCP で本番URLを開き、要素のcomputed styleでCSS変数が定義されていることを確認

- [ ] **Step 3: コミット**

```bash
git add src/style.css.ts
git commit -m "style: PC用CSS変数追加（サイドバー・パネル・コンテナ）"
```

---

## Task 2: タブレットブレークポイント（769px〜）CSS

**Files:**
- Modify: `src/style.css.ts`

- [ ] **Step 1: タブレット用メディアクエリを追加**

`style.css.ts` のCSS文字列の末尾（閉じバッククォートの直前）に以下を追加:

```css
/* ═══ Tablet (769px+) ═══ */
@media (min-width: 769px) {
  /* ティッカー・コンパクトサマリー非表示 */
  .compact-summary, #ticker-scroll { display: none !important; }

  /* 底タブバー非表示 */
  .tab-bar { display: none !important; }

  /* タブレット用水平タブバー（上部） */
  .pc-tabbar {
    display: flex !important;
    position: sticky;
    top: 0;
    z-index: 50;
    height: 44px;
    background: var(--bg);
    border-bottom: 1px solid var(--separator);
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 0 16px;
  }

  .pc-tabbar-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    color: var(--label-secondary);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    border: none;
    background: none;
  }

  .pc-tabbar-item:hover {
    background: var(--bg-secondary);
  }

  .pc-tabbar-item.active {
    color: var(--blue);
    background: var(--bg-secondary);
  }

  .pc-tabbar-item svg {
    width: 16px;
    height: 16px;
  }

  /* コンテンツの最大幅制限 */
  .content {
    max-width: 960px;
    margin: 0 auto;
    padding-bottom: 24px;
  }

  /* ウォッチリストのテーブル表示 */
  .watch-table {
    display: table !important;
    width: 100%;
    border-collapse: collapse;
  }

  .watch-table th {
    text-align: left;
    font-size: 11px;
    color: var(--label-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 8px;
    border-bottom: 1px solid var(--separator);
    font-weight: 500;
  }

  .watch-table td {
    padding: clamp(8px, 1vw, 12px);
    border-bottom: 1px solid var(--separator);
    font-size: clamp(0.875rem, 0.8vw + 4px, 1rem);
    vertical-align: middle;
  }

  .watch-table tr {
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .watch-table tr:hover {
    background: var(--bg-secondary);
  }

  .watch-table .pair-name {
    font-weight: 600;
    color: var(--label);
  }

  .watch-table .dir-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
  }

  .watch-table .dir-buy { background: rgba(48,209,88,0.12); color: var(--green); }
  .watch-table .dir-sell { background: rgba(255,69,58,0.12); color: var(--red); }

  .watch-table .sparkline-cell svg {
    width: clamp(60px, 4vw, 100px);
    height: 20px;
  }

  /* 損失回避§4: 利益は強調、損失は抑制 */
  .watch-table .pnl-pos { color: var(--green); font-weight: 600; }
  .watch-table .pnl-neg { color: var(--red); font-weight: 400; opacity: 0.85; }

  /* ニュースドロワー: タブレットでは維持（右パネルがないため）。1920px+で非表示 */

  /* ボトムシート → サイドパネル対応時に無効化（≥1920px） */

  /* ヒーローカードのフォントスケーリング */
  .hero-value, #hero-pnl {
    font-size: clamp(2.625rem, 3vw, 4rem) !important;
  }

  /* カード padding スケーリング */
  .card {
    padding: clamp(1rem, 1.2vw, 2rem);
  }

  /* セクションタイトル */
  .section-title, .card-title {
    font-size: clamp(0.938rem, 1vw, 1.125rem);
  }
}
```

- [ ] **Step 2: デプロイしてタブレット表示を確認**

Run: `npx wrangler deploy`
Chrome DevTools MCP でビューポート幅を 1024px に設定し、底タブバーが消え水平タブバーが表示されることを確認

- [ ] **Step 3: コミット**

```bash
git add src/style.css.ts
git commit -m "style: タブレット(769px+)メディアクエリ追加"
```

---

## Task 3: デスクトップブレークポイント（1280px〜）CSS

**Files:**
- Modify: `src/style.css.ts`

- [ ] **Step 1: デスクトップ用メディアクエリを追加**

タブレットメディアクエリの後に追加:

```css
/* ═══ Desktop (1280px+) ═══ */
@media (min-width: 1280px) {
  /* タブレット用水平タブバー非表示 */
  .pc-tabbar { display: none !important; }

  /* 左サイドバー表示 */
  .pc-sidebar {
    display: flex !important;
    flex-direction: column;
    align-items: center;
    width: var(--sidebar-width);
    min-width: 56px;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--separator);
    padding-top: 12px;
    flex-shrink: 0;
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 60;
  }

  .sidebar-logo {
    font-size: 16px;
    font-weight: 700;
    color: var(--blue);
    margin-bottom: 20px;
    letter-spacing: -0.5px;
  }

  .sidebar-tab {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    margin-bottom: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    position: relative;
    border: none;
    background: none;
    color: var(--label-secondary);
  }

  .sidebar-tab svg {
    width: 20px;
    height: 20px;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.6;
  }

  .sidebar-tab span {
    font-size: 8px;
    margin-top: 2px;
    color: inherit;
  }

  .sidebar-tab:hover {
    background: var(--bg-secondary);
  }

  .sidebar-tab.active {
    color: var(--blue);
    background: rgba(10,132,255,0.12);
  }

  .sidebar-tab.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 3px;
    background: var(--blue);
    border-radius: 0 2px 2px 0;
  }

  .sidebar-spacer { flex: 1; }

  .sidebar-bottom { margin-bottom: 12px; }

  /* メインコンテンツのオフセット（サイドバーはfixed） */
  .content {
    max-width: none;
    margin-left: var(--sidebar-width);
    padding: 20px 24px;
  }

  /* ヘッダーのオフセット */
  .header {
    position: sticky;
    top: 0;
    margin-left: var(--sidebar-width);
    z-index: 40;
  }

  /* TP/SLバナーのオフセット */
  .tp-banner {
    margin-left: var(--sidebar-width);
  }
}
```

- [ ] **Step 2: デプロイしてデスクトップ表示を確認**

Run: `npx wrangler deploy`
Chrome DevTools MCP でビューポート幅を 1440px に設定し、左サイドバーが表示されメインコンテンツが右にオフセットされることを確認

- [ ] **Step 3: コミット**

```bash
git add src/style.css.ts
git commit -m "style: デスクトップ(1280px+)左サイドバーCSS追加"
```

---

## Task 4: FHD+ブレークポイント（1920px〜）CSS

**Files:**
- Modify: `src/style.css.ts`

- [ ] **Step 1: FHD+用メディアクエリを追加**

```css
/* ═══ FHD+ (1920px+) ═══ */
@media (min-width: 1920px) {
  /* ニュースドロワー非表示（右パネルに統合） */
  #news-drawer { display: none !important; }
  #news-drawer-handle { display: none !important; }

  /* 右サイドパネル表示 */
  .pc-panel {
    display: flex !important;
    flex-direction: column;
    width: var(--panel-width);
    min-width: 300px;
    background: var(--panel-bg);
    border-left: 1px solid var(--panel-border);
    flex-shrink: 0;
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    overflow-y: auto;
    z-index: 50;
  }

  .panel-header {
    padding: 16px;
    font-size: 13px;
    font-weight: 600;
    color: var(--label-secondary);
    border-bottom: 1px solid var(--separator);
    position: sticky;
    top: 0;
    background: var(--panel-bg);
    z-index: 1;
  }

  .panel-section {
    padding: 12px 16px;
    border-bottom: 1px solid var(--separator);
  }

  .panel-section .label {
    font-size: 10px;
    color: var(--label-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }

  .panel-section .value {
    font-size: 16px;
    font-weight: 600;
    color: var(--label);
  }

  /* ニュースアイテム（パネル内） */
  .panel-news-item {
    padding: 10px 16px;
    border-bottom: 1px solid var(--separator);
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .panel-news-item:hover {
    background: var(--bg-secondary);
  }

  .panel-news-title {
    font-size: 12px;
    color: var(--label);
    line-height: 1.4;
    margin-bottom: 2px;
  }

  .panel-news-meta {
    font-size: 10px;
    color: var(--label-tertiary);
  }

  .panel-news-attention {
    border-left: 2px solid var(--orange);
    padding-left: 14px;
  }

  /* メインコンテンツのオフセット（右パネル分） */
  .content {
    margin-right: var(--panel-width);
    max-width: var(--container-max);
  }

  .header {
    margin-right: var(--panel-width);
  }

  /* TP/SLバナーをメインコンテンツ内に収める */
  .tp-banner {
    margin-left: var(--sidebar-width);
    margin-right: var(--panel-width);
  }
}

/* ═══ Ultra-wide (2560px+) ═══ */
@media (min-width: 2560px) {
  /* 2カラムウォッチリスト: 保有と待機を横並び */
  .watchlist-columns {
    display: grid !important;
    grid-template-columns: 1fr 1fr;
    gap: 0 24px;
  }
}
```

- [ ] **Step 2: デプロイしてFHD表示を確認**

Run: `npx wrangler deploy`
Chrome DevTools MCP でビューポート幅を 1920px に設定し、右サイドパネルが表示されることを確認

- [ ] **Step 3: コミット**

```bash
git add src/style.css.ts
git commit -m "style: FHD+(1920px+)右パネル・2560px+グリッドCSS追加"
```

---

## Task 1.5: モバイル非表示デフォルトCSS（Task 2より前に実行）

**Files:**
- Modify: `src/style.css.ts`

- [ ] **Step 1: PC要素のデフォルト非表示スタイルを追加**

メディアクエリの**前**（ベーススタイルセクション）に以下を追加:

```css
/* PC要素: モバイルではデフォルト非表示 */
.pc-sidebar { display: none; }
.pc-tabbar { display: none; }
.pc-panel { display: none; }
.watch-table { display: none; }
.watchlist-grid { display: block; }
```

- [ ] **Step 2: デプロイしてモバイル表示が壊れていないことを確認**

Run: `npx wrangler deploy`
Chrome DevTools MCP でモバイルビューポート（375x812）で表示が従来通りであることを確認

- [ ] **Step 3: コミット**

```bash
git add src/style.css.ts
git commit -m "style: PC要素のモバイルデフォルト非表示CSS追加"
```

---

## Task 6: HTML構造変更 — 左サイドバー追加

**Files:**
- Modify: `src/dashboard.ts`

- [ ] **Step 1: サイドバーのHTMLを追加**

`dashboard.ts` の `generateDashboardHTML()` 関数内、`<div id="app">` の直後（headerの前）に以下を追加:

```html
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
```

- [ ] **Step 2: タブレット用水平タブバーのHTMLを追加**

サイドバーの直後に追加:

```html
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
```

- [ ] **Step 3: デプロイして確認**

Run: `npx wrangler deploy`
Chrome DevTools MCP でデスクトップ幅（1440px）でサイドバーが表示されることを確認。モバイル（375px）で非表示であることも確認。

- [ ] **Step 4: コミット**

```bash
git add src/dashboard.ts
git commit -m "feat: PC用左サイドバー・タブレット用タブバーHTML追加"
```

---

## Task 7: HTML構造変更 — 右サイドパネル追加

**Files:**
- Modify: `src/dashboard.ts`

- [ ] **Step 1: 右サイドパネルのHTMLを追加**

`dashboard.ts` の `</div><!-- #app -->` の直前（ボトムシートの前あたり）に追加:

```html
<!-- PC: 右サイドパネル -->
<aside class="pc-panel" id="pc-panel" aria-label="サイドパネル">
  <!-- 資産タブ用: ニュース+マーケット概況 -->
  <div class="panel-content" data-panel="tab-portfolio">
    <div class="panel-section">
      <div class="label">マーケット概況</div>
      <div id="panel-market" style="display:flex;gap:16px;margin-top:6px">
        <!-- JS で動的挿入 -->
      </div>
    </div>
    <div class="panel-header">📰 ニュース</div>
    <div id="panel-news">
      <!-- JS で動的挿入 -->
    </div>
  </div>

  <!-- AI判断タブ用: 判定履歴+スコア -->
  <div class="panel-content" data-panel="tab-ai" style="display:none">
    <div class="panel-header">📋 判定履歴</div>
    <div id="panel-decisions">
      <!-- JS で動的挿入 -->
    </div>
  </div>

  <!-- 統計タブ用: 銘柄詳細+取引履歴 -->
  <div class="panel-content" data-panel="tab-stats" style="display:none">
    <div class="panel-header">📊 銘柄詳細</div>
    <div id="panel-stats-detail">
      <p style="padding:16px;color:var(--label-secondary);font-size:13px">銘柄をクリックして詳細を表示</p>
    </div>
  </div>

  <!-- ログタブ用: RiskGuard+システム情報 -->
  <div class="panel-content" data-panel="tab-log" style="display:none">
    <div class="panel-header">🛡️ RiskGuard</div>
    <div id="panel-riskguard">
      <!-- JS で動的挿入 -->
    </div>
  </div>
</aside>
```

- [ ] **Step 2: パネルコンテンツ表示切替CSSを追加**

`src/style.css.ts` のFHD+メディアクエリ内に追加:

```css
.panel-content { display: none; }
.panel-content.active { display: block; }
```

- [ ] **Step 3: デプロイして確認**

Run: `npx wrangler deploy`
Chrome DevTools MCP で FHD幅（1920px）で右パネルが表示されることを確認

- [ ] **Step 4: コミット**

```bash
git add src/dashboard.ts src/style.css.ts
git commit -m "feat: PC用右サイドパネルHTML追加（コンテキスト連動4種）"
```

---

## Task 8: JavaScript — サイドバー・タブバーのタブ切替

**Files:**
- Modify: `src/app.js.ts`

- [ ] **Step 1: 既存の `switchTab()` を拡張**

`app.js.ts` の既存 `switchTab(targetId)` 関数内に、サイドバー・タブバー・パネルの連動を追加:

```javascript
// 既存のタブ切替処理の後に追加:

// PC: サイドバータブの状態更新
document.querySelectorAll('.sidebar-tab[data-tab]').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.tab === targetId);
});

// PC: タブレットタブバーの状態更新
document.querySelectorAll('.pc-tabbar-item').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.tab === targetId);
});

// PC: 右パネルのコンテキスト切替
document.querySelectorAll('.panel-content').forEach(panel => {
  panel.classList.toggle('active', panel.dataset.panel === targetId);
});
```

- [ ] **Step 2: サイドバー・タブバーのクリックイベントを追加**

`app.js.ts` のイベントリスナー設定部分に追加:

```javascript
// PC: サイドバータブのクリック
document.querySelectorAll('.sidebar-tab[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// PC: タブレットタブバーのクリック
document.querySelectorAll('.pc-tabbar-item').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// PC: サイドバー設定ボタン（テーマ切替）
const sidebarSettings = document.getElementById('sidebar-settings');
if (sidebarSettings) {
  sidebarSettings.addEventListener('click', () => {
    document.getElementById('theme-btn')?.click();
  });
}
```

- [ ] **Step 3: デプロイしてタブ切替が動作することを確認**

Run: `npx wrangler deploy`
Chrome DevTools MCP でデスクトップ幅（1440px）でサイドバータブをクリックし、メインコンテンツが切り替わることを確認

- [ ] **Step 4: コミット**

```bash
git add src/app.js.ts
git commit -m "feat: サイドバー・タブバーのタブ切替JS追加"
```

---

## Task 9: JavaScript — キーボードショートカット

**Files:**
- Modify: `src/app.js.ts`

- [ ] **Step 1: キーボードショートカットのイベントリスナーを追加**

`app.js.ts` のイベントリスナー設定部分に追加:

```javascript
// PC: キーボードショートカット
document.addEventListener('keydown', (e) => {
  // 入力フィールドフォーカス時は無効化
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // 修飾キーが押されている場合は無視（ブラウザショートカットと競合しない）
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key) {
    case '1': switchTab('tab-portfolio'); break;
    case '2': switchTab('tab-ai'); break;
    case '3': switchTab('tab-stats'); break;
    case '4': switchTab('tab-log'); break;
    case 'r': case 'R':
      document.getElementById('refresh-btn')?.click();
      break;
    case 't': case 'T':
      document.getElementById('theme-btn')?.click();
      break;
  }
});
```

- [ ] **Step 2: デプロイして確認**

Run: `npx wrangler deploy`
Chrome DevTools MCP で数字キー1-4でタブ切替、Rで更新、Tでテーマ切替が動作することを確認

- [ ] **Step 3: コミット**

```bash
git add src/app.js.ts
git commit -m "feat: キーボードショートカット追加（1-4タブ切替、R更新、Tテーマ）"
```

---

## Task 10: JavaScript — 右パネルのコンテンツ描画

**Files:**
- Modify: `src/app.js.ts`

- [ ] **Step 1: パネル描画関数を追加**

`app.js.ts` に以下の関数を追加:

```javascript
// PC: 右パネルのコンテンツ描画
function renderPanel(data) {
  if (window.innerWidth < 1920) return; // FHD未満ではスキップ

  // マーケット概況
  const marketEl = document.getElementById('panel-market');
  if (marketEl && data.indicators) {
    const ind = data.indicators;
    marketEl.innerHTML = [
      { label: 'VIX', value: ind.vix?.toFixed(1) || 'N/A', color: ind.vix > 20 ? 'var(--orange)' : 'var(--label)' },
      { label: 'US10Y', value: ind.us10y ? ind.us10y.toFixed(2) + '%' : 'N/A', color: 'var(--label)' },
      { label: 'USD/JPY', value: data.rates?.['USD/JPY']?.toFixed(2) || 'N/A', color: 'var(--label)' },
    ].map(i => '<div><div style="font-size:10px;color:var(--label-secondary)">' + i.label + '</div><div style="font-size:14px;font-weight:600;color:' + i.color + '">' + i.value + '</div></div>').join('');
  }

  // ニュースフィード
  const newsEl = document.getElementById('panel-news');
  if (newsEl && data.news) {
    newsEl.innerHTML = data.news.slice(0, 6).map(n => {
      const hasSignal = n.impact && n.impact !== 'なし';
      return '<div class="panel-news-item' + (hasSignal ? ' panel-news-attention' : '') + '">'
        + '<div class="panel-news-title">' + escHtml(n.title) + '</div>'
        + '<div class="panel-news-meta">Reuters • ' + fmtTimeShort(n.pubDate)
        + (hasSignal ? ' • <span style="color:var(--orange)">⚠ ' + escHtml(n.impact) + '</span>' : '')
        + '</div></div>';
    }).join('');
  }

  // 判定履歴（AI判断パネル）
  const decisionsEl = document.getElementById('panel-decisions');
  if (decisionsEl && data.decisions) {
    decisionsEl.innerHTML = data.decisions.slice(0, 10).map(d => {
      const color = d.decision === 'BUY' ? 'var(--green)' : d.decision === 'SELL' ? 'var(--red)' : 'var(--label-secondary)';
      return '<div style="display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--separator)">'
        + '<span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;color:' + color + '">' + d.decision + '</span>'
        + '<span style="font-size:12px;color:var(--label)">' + d.pair + '</span>'
        + '<span style="font-size:11px;color:var(--label-secondary);margin-left:auto">' + fmtTimeShort(d.created_at) + '</span>'
        + '</div>';
    }).join('');
  }

  // RiskGuard（ログパネル）
  const riskEl = document.getElementById('panel-riskguard');
  if (riskEl && data.logStats) {
    const stats = data.logStats;
    riskEl.innerHTML = '<div style="padding:16px">'
      + [
        { label: '総実行', value: stats.totalRuns || 0 },
        { label: 'AI呼出', value: stats.geminiCalls || 0 },
        { label: 'エラー', value: stats.errors || 0, color: stats.errors > 0 ? 'var(--red)' : 'var(--green)' },
        { label: '警告', value: stats.warnings || 0, color: stats.warnings > 5 ? 'var(--orange)' : 'var(--label)' },
      ].map(s => '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--separator)">'
        + '<span style="font-size:12px;color:var(--label-secondary)">' + s.label + '</span>'
        + '<span style="font-size:13px;font-weight:600;color:' + (s.color || 'var(--label)') + '">' + s.value + '</span></div>'
      ).join('')
      + '</div>';
  }
}
```

- [ ] **Step 2: 既存の `render()` または `fetchData()` 内で `renderPanel(data)` を呼び出す**

データ取得後の描画処理の末尾に追加:

```javascript
renderPanel(data);
```

- [ ] **Step 3: `fmtTimeShort` ヘルパー関数を追加**

```javascript
function fmtTimeShort(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'たった今';
  if (diffMin < 60) return diffMin + '分前';
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return diffH + '時間前';
  return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
}
```

- [ ] **Step 4: デプロイして確認**

Run: `npx wrangler deploy`
Chrome DevTools MCP で FHD幅（1920px）で右パネルにニュース・マーケット概況が表示されることを確認。タブ切替でパネルの内容が変わることも確認。

- [ ] **Step 5: コミット**

```bash
git add src/app.js.ts
git commit -m "feat: 右パネルのコンテキスト連動コンテンツ描画JS追加"
```

---

## Task 11: JavaScript — ウォッチリストのテーブル表示切替

**Files:**
- Modify: `src/app.js.ts`

- [ ] **Step 1: テーブル表示のレンダリング関数を追加**

既存の `renderWatchlist()` 関数内で、ビューポート幅に応じてカード表示/テーブル表示を切り替える分岐を追加:

```javascript
// renderWatchlist() の先頭付近に追加:
const isPC = window.innerWidth >= 769;

if (isPC) {
  // テーブル形式で描画
  const rates = data.rates || {};
  let html = '<div class="watchlist-columns">';

  // 保有ポジション テーブル
  html += '<div><div class="section-title" style="margin-bottom:8px">保有ポジション</div>';
  html += '<table class="watch-table"><thead><tr>'
    + '<th>銘柄</th><th>方向</th><th>エントリー</th><th>現在値</th><th>推移</th><th style="text-align:right">損益</th>'
    + '</tr></thead><tbody>';

  positions.forEach(pos => {
    const instr = INSTRUMENTS.find(i => i.pair === pos.pair);
    if (!instr) return;
    const currentPrice = rates[pos.pair] || pos.entry_rate;
    const pnl = pos.direction === 'BUY'
      ? (currentPrice - pos.entry_rate) * pos.lot * (instr.multiplier || 100)
      : (pos.entry_rate - currentPrice) * pos.lot * (instr.multiplier || 100);
    const sparkColor = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    const sparkSvg = drawSparkline(pos.priceHistory || [], sparkColor, 60, 20);
    const posJson = JSON.stringify(pos).replace(/"/g, '&quot;');
    const instrJson = JSON.stringify(instr).replace(/"/g, '&quot;');
    html += '<tr onclick="openSheet(' + posJson + ', ' + instrJson + ')">'
      + '<td class="pair-name">' + escHtml(pos.pair) + '</td>'
      + '<td><span class="dir-badge dir-' + pos.direction.toLowerCase() + '">' + pos.direction + '</span></td>'
      + '<td style="color:var(--label-secondary)">' + fmtPrice(pos.pair, pos.entry_rate) + '</td>'
      + '<td>' + fmtPrice(pos.pair, currentPrice) + '</td>'
      + '<td class="sparkline-cell">' + sparkSvg + '</td>'
      + '<td style="text-align:right" class="' + (pnl >= 0 ? 'pnl-pos' : 'pnl-neg') + '">' + fmtYen(Math.round(pnl)) + '</td>'
      + '</tr>';
  });
  html += '</tbody></table></div>';

  // 待機銘柄テーブル（ポジションなしの銘柄）
  const holdInstruments = INSTRUMENTS.filter(i => !positions.find(p => p.pair === i.pair));
  if (holdInstruments.length > 0) {
    html += '<div><div class="section-title" style="margin-bottom:8px">待機銘柄</div>';
    html += '<table class="watch-table"><thead><tr>'
      + '<th>銘柄</th><th>カテゴリ</th><th>現在値</th>'
      + '</tr></thead><tbody>';
    holdInstruments.forEach(instr => {
      const rate = rates[instr.pair];
      html += '<tr>'
        + '<td class="pair-name">' + escHtml(instr.pair) + '</td>'
        + '<td style="color:var(--label-secondary);font-size:12px">' + (instr.category || '') + '</td>'
        + '<td>' + (rate ? fmtPrice(instr.pair, rate) : '-') + '</td>'
        + '</tr>';
    });
    html += '</tbody></table></div>';
  }

  html += '</div>'; // .watchlist-columns
  watchlistEl.innerHTML = html;
  return; // テーブル表示で終了
}

// 以下は既存のカード表示ロジック（モバイル用、変更なし）
```

- [ ] **Step 2: リサイズ時のレイアウト更新**

`app.js.ts` に追加:

```javascript
// ウィンドウリサイズ時にウォッチリストの表示モードを切替
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastData) {
      renderWatchlist(lastData);
      renderPanel(lastData);
    }
  }, 250);
});
```

- [ ] **Step 3: デプロイして確認**

Run: `npx wrangler deploy`
Chrome DevTools MCP で 1024px 幅でテーブル表示、375px 幅でカード表示になることを確認

- [ ] **Step 4: コミット**

```bash
git add src/app.js.ts
git commit -m "feat: ウォッチリストのPC用テーブル表示切替 + リサイズ対応"
```

---

## Task 12: viewport メタタグの動的変更

**Files:**
- Modify: `src/app.js.ts`

- [ ] **Step 1: PC表示時にuser-scalableを許可する処理を追加**

`app.js.ts` の初期化処理に追加:

```javascript
// PC表示時にブラウザズームを許可
function updateViewport() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  if (window.innerWidth >= 769) {
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0');
  } else {
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
  }
}
updateViewport();
window.addEventListener('resize', updateViewport);
```

- [ ] **Step 2: デプロイして確認**

Run: `npx wrangler deploy`

- [ ] **Step 3: コミット**

```bash
git add src/app.js.ts
git commit -m "feat: PC表示時にviewportのuser-scalable制限を解除"
```

---

## Task 13: 最終統合テスト・デプロイ

**Files:**
- All modified files

- [ ] **Step 1: 全変更をデプロイ**

Run: `npx wrangler deploy`

- [ ] **Step 2: モバイル表示の回帰テスト**

Chrome DevTools MCP でモバイルビューポート（375x812）で以下を確認:
- 底タブバーが表示される
- ティッカーバーが表示される
- ニュースドロワーが動作する
- サイドバー・タブバー・パネルが非表示
- 既存の全機能が正常動作

- [ ] **Step 3: タブレット表示テスト**

Chrome DevTools MCP でビューポート幅 1024px で確認:
- 水平タブバーが上部に表示
- 底タブバー非表示
- ティッカー非表示
- ウォッチリストがテーブル表示
- タブ切替が動作

- [ ] **Step 4: デスクトップ表示テスト**

Chrome DevTools MCP でビューポート幅 1440px で確認:
- 左サイドバーが表示
- サイドバータブでタブ切替が動作
- 右パネルは非表示（1920px未満）
- メインコンテンツが適切にオフセット

- [ ] **Step 5: FHD+表示テスト**

Chrome DevTools MCP でビューポート幅 1920px で確認:
- 左サイドバー + メイン + 右パネルの3カラム
- タブ切替で右パネルの内容が連動
- キーボードショートカット動作
- ライトモード/ダークモードで表示崩れなし

- [ ] **Step 6: コミット**

```bash
git add -A
git commit -m "feat: PC版レスポンシブデザイン完成（FHD/2K/4K対応）"
```

---

## 補足: 実装順序の依存関係

```
Task 1 (CSS変数) → Task 1.5 (デフォルト非表示) → Task 2 (タブレットCSS)
                                                → Task 3 (デスクトップCSS)
                                                → Task 4 (FHD+ CSS)

Task 6 (サイドバーHTML) → Task 8 (タブ切替JS)
Task 7 (パネルHTML) → Task 10 (パネル描画JS)

Task 8 (タブ切替JS) → Task 9 (キーボードショートカット)

Task 11 (テーブル表示) — 独立（ただしTask 2のCSS後が望ましい）
Task 12 (viewport) — 独立

全タスク → Task 13 (統合テスト)
```

**重要**: Task 1.5（PC要素デフォルト非表示）は Task 2-4 のメディアクエリより**前**に実行すること。
Task 1, 6, 7 は並列実行可能。Task 11, 12 は他のタスクと独立して実行可能。

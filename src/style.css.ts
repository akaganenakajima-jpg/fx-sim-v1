// iOS 26 Liquid Glass + Apple HIG CSS (v7 full rewrite)
// 5-tab layout / SF Pro / 8pt grid / 44pt touch targets / Liquid Glass

export const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#000;--surface:#1C1C1E;--card:#2C2C2E;--elevated:#3A3A3C;
  --text:#F5F5F7;--secondary:#8E8E93;--tertiary:#636366;
  --green:#30D158;--red:#FF453A;--orange:#FF9F0A;--blue:#0A84FF;
  --teal:#64D2FF;--purple:#BF5AF2;
  --r:24px;--rs:8px;
  /* ═══ iOS 26 Liquid Glass (v7) ═══ */
  --glass-bg-rgb:62,62,62;
  --glass-shadow-rgb:0,0,0;
  --glass-border-rgb:68,68,68;
  --glass-opacity:0.72;
  --glass-blur:2px;
  --glass-saturate:360%;
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Hiragino Sans',sans-serif;
  -webkit-font-smoothing:antialiased;
}
body{background:var(--bg);color:var(--text);font-size:15px;line-height:1.47;
  padding-bottom:calc(96px + env(safe-area-inset-bottom,0px));overflow-x:hidden}

/* ═══ Common ═══ */
/* ═══ v7: Glass mixin ═══ */
.glass{
  background:rgba(var(--glass-bg-rgb),var(--glass-opacity));
  backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturate));
  box-shadow:inset 0 0 8px 0 rgba(var(--glass-shadow-rgb),0.2),0 0 10px 0 rgba(var(--glass-shadow-rgb),0.82);
  border:0.5px solid rgba(var(--glass-border-rgb),0.8);
  transform:translateZ(0);-webkit-transform:translateZ(0);
}
/* ═══ v7: Sticky glass header ═══ */
.sbar{display:flex;justify-content:space-between;align-items:center;
  padding:calc(env(safe-area-inset-top,0px) + 8px) 16px 8px;
  position:sticky;top:0;z-index:90;
  background:rgba(0,0,0,0.6);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
}
.sbar-left{display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;box-shadow:0 0 6px currentColor}
.dot.ok{background:var(--green);color:var(--green)}
.dot.warn{background:var(--orange);color:var(--orange)}
.dot.danger{background:var(--red);color:var(--red)}
.sbar-status{font-size:11px;color:var(--secondary)}.sbar-time{font-size:13px;color:var(--tertiary)}
.sec{font-size:11px;font-weight:600;color:var(--tertiary);text-transform:uppercase;letter-spacing:0.4px;padding:16px 16px 8px}
.tab-panel{display:none}.tab-panel.active{display:block}
/* ═══ v7: Floating Liquid Glass tab bar ═══ */
.tabs{position:fixed;bottom:calc(16px + env(safe-area-inset-bottom,0px));left:18px;right:18px;
  padding:8px 4px;
  background:rgba(var(--glass-bg-rgb),var(--glass-opacity));
  backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturate));
  box-shadow:inset 0 0 8px 0 rgba(var(--glass-shadow-rgb),0.2),0 0 10px 0 rgba(var(--glass-shadow-rgb),0.82);
  border:0.5px solid rgba(var(--glass-border-rgb),0.8);
  border-radius:40px;
  display:flex;justify-content:space-around;z-index:100;
  transform:translateZ(0);-webkit-transform:translateZ(0);
  transition:transform 140ms ease-out;
}
.tabs:active{transform:translateZ(0) scale(1.038)}
/* ═══ v7: Tab items with active pill ═══ */
.tab{display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 4px;min-width:44px;min-height:44px;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent;border-radius:32px;transition:background 0.2s}
.tab-icon{width:24px;height:24px;opacity:0.4;transition:opacity 0.2s}.tab-t{font-size:11px;color:var(--tertiary);font-weight:500;transition:color 0.2s}
.tab.on .tab-icon{opacity:1}.tab.on .tab-t{color:var(--blue)}
.tab.on{background:rgba(255,255,255,0.095);border-radius:32px}
.badge-sm{display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600}

/* ═══ Cross-link (v6) ═══ */
.cross-link{font-size:12px;color:var(--blue);cursor:pointer;display:inline-flex;align-items:center;gap:4px;padding:8px 0;min-height:44px}
.cross-link:active{opacity:0.6}

/* ═══ Why tree (v6) ═══ */
.why-toggle{font-size:12px;color:var(--blue);cursor:pointer;padding:8px 0;min-height:44px;display:flex;align-items:center;gap:4px}
.why-toggle:active{opacity:0.6}
.why-tree{display:none;margin:4px 0 0 8px;padding-left:12px;border-left:1px solid var(--tertiary);font-size:12px;color:var(--secondary);line-height:1.7}
.why-tree.open{display:block}
.why-node{margin:8px 0}
.why-q{font-size:12px;color:var(--blue);font-weight:600;margin-bottom:3px}
.why-a{font-size:13px;color:var(--secondary);line-height:1.6}
.why-evidence{color:var(--tertiary);font-size:11px;font-style:italic;margin-top:2px}
.why-sub{margin-left:12px;padding-left:12px;border-left:1px solid rgba(255,255,255,0.06)}

/* ═══ Score bar (v6) ═══ */
.score-row{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:11px}
.score-label{width:32px;flex-shrink:0;color:var(--secondary);font-weight:500}
.score-bar{flex:1;height:6px;background:var(--tertiary);border-radius:3px;overflow:hidden}
.score-fill{height:100%;border-radius:3px;background:var(--green)}
.score-val{width:80px;text-align:right;color:var(--tertiary);font-variant-numeric:tabular-nums;font-size:11px}
.score-total{font-size:12px;font-weight:600;padding:4px 0;margin-top:4px;border-top:1px solid rgba(255,255,255,0.06)}

/* ═══ KPI grid (v6) ═══ */
.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:8px 16px 0}
.kpi{padding:12px 8px;background:var(--surface);border-radius:var(--rs);text-align:center}
.kpi-val{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}.kpi-lbl{font-size:11px;color:var(--tertiary);margin-top:4px}

/* ═══ DD stage bar (v6) ═══ */
.dd-bar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:0 16px 8px;background:var(--tertiary)}
.dd-seg{height:100%}

/* ═══ Health expand (v6) ═══ */
.hc-expand{display:none;padding:8px 0 0 36px;font-size:12px;color:var(--secondary);line-height:1.7}
.hc-expand.open{display:block}
.hc-detail{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.hc-detail-label{color:var(--tertiary)}
.spark-mini{display:inline-block;vertical-align:middle}

/* ═══ Env matrix (v6) ═══ */
.matrix-grid{display:grid;grid-template-columns:80px repeat(3,1fr);gap:2px;font-size:11px;margin:0 16px 8px;background:var(--surface);border-radius:var(--rs);padding:8px;overflow-x:auto}
.matrix-h{padding:4px 6px;color:var(--tertiary);font-weight:600;text-align:center;font-size:11px}.matrix-h:first-child{text-align:left}
.matrix-p{padding:4px 6px;font-weight:500}.matrix-c{padding:4px 6px;text-align:center;border-radius:4px;font-variant-numeric:tabular-nums}

/* ═══ Brier sparkline (v6) ═══ */
.brier-row{display:flex;align-items:center;gap:12px;padding:8px 16px;font-size:12px;color:var(--secondary)}
.brier-label{flex-shrink:0;font-weight:500}.brier-val{font-weight:700;font-variant-numeric:tabular-nums}

/* ═══ AI type breakdown (v6) ═══ */
.ai-breakdown{display:flex;gap:4px;margin:8px 16px 0}
.ai-brk{flex:1;padding:12px 8px;background:var(--surface);border-radius:var(--rs);text-align:center}
.ai-brk-type{font-size:11px;color:var(--tertiary);margin-bottom:4px}.ai-brk-val{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}
.ai-brk-sub{font-size:11px;color:var(--tertiary);margin-top:4px}

/* ═══ TAB 1: 今 ═══ */
.hero{text-align:center;padding:24px 16px 0}
.pnl{font-size:48px;font-weight:800;letter-spacing:-2px;line-height:1;font-variant-numeric:tabular-nums}
.pnl.pos{color:var(--green)}.pnl.neg{color:var(--red);text-shadow:0 0 40px rgba(255,69,58,0.15)}
.pnl-sub{font-size:13px;color:var(--secondary);margin-top:4px}
.metrics{display:flex;flex-wrap:wrap;gap:1px;margin:16px 16px 0}
.m{flex:1;min-width:72px;text-align:center;padding:8px 0;background:var(--surface)}.m:first-child{border-radius:var(--rs) 0 0 var(--rs)}.m:last-child{border-radius:0 var(--rs) var(--rs) 0}
.m-val{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}.m-lbl{font-size:11px;color:var(--tertiary);text-transform:uppercase;letter-spacing:0.4px;margin-top:4px}
.sig{margin:8px 16px 0;display:flex;align-items:center;gap:8px}.sig-track{flex:1;height:3px;background:var(--tertiary);border-radius:2px;overflow:hidden}.sig-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,var(--orange),var(--green))}.sig-lbl{font-size:11px;color:var(--tertiary)}
.story{margin:16px 16px 0;padding:16px;background:var(--surface);border-radius:var(--r);border-left:3px solid var(--blue)}
.story-text{font-size:14px;line-height:1.6;color:var(--secondary)}.story-text b{color:var(--text);font-weight:600}.story-text .g{color:var(--green)}.story-text .r{color:var(--red)}.story-text .o{color:var(--orange)}
.drivers{display:flex;gap:8px;margin-top:12px}
.drv{flex:1;padding:12px;background:var(--bg);border-radius:var(--rs);min-height:44px;cursor:pointer;-webkit-tap-highlight-color:transparent}
.drv:active{opacity:0.7}
.drv-tag{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px}.drv-tag.profit{color:var(--green)}.drv-tag.loss{color:var(--red)}
.drv-pair{font-size:13px;font-weight:600}.drv-pnl{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;margin:2px 0}.drv-reason{font-size:11px;color:var(--tertiary)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.chip{padding:8px 12px;border-radius:14px;font-size:11px;font-weight:500;min-height:44px;display:inline-flex;align-items:center;cursor:pointer;-webkit-tap-highlight-color:transparent}
.chip:active{opacity:0.6}
.chip.w{background:rgba(255,159,10,0.1);color:var(--orange)}.chip.i{background:rgba(10,132,255,0.1);color:var(--blue)}
.hm{margin:12px 16px 0;background:var(--surface);border-radius:var(--rs);padding:8px;overflow-x:auto}
.hm-g{display:grid;grid-template-columns:72px repeat(4,1fr);gap:2px;font-size:11px}
.hm-h{padding:4px 6px;color:var(--tertiary);font-weight:600;text-align:center;font-size:11px}.hm-h:first-child{text-align:left}.hm-p{padding:4px 6px;font-weight:500}.hm-c{padding:4px 6px;text-align:center;border-radius:4px;font-variant-numeric:tabular-nums}
.news-feed{margin:0 16px}.nf-item{padding:16px;background:var(--surface);border-radius:var(--rs);margin-bottom:8px;border-left:3px solid var(--tertiary)}
.nf-item.nf-emergency{border-left-color:var(--red)}.nf-item.nf-trend{border-left-color:var(--blue)}.nf-item.nf-attention{border-left-color:var(--orange)}
.nf-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.nf-badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nf-badge-emergency{background:rgba(255,69,58,0.2);color:var(--red)}.nf-badge-trend{background:rgba(10,132,255,0.25);color:var(--blue)}.nf-badge-attention{background:rgba(255,159,10,0.2);color:var(--orange)}.nf-badge-info{background:rgba(142,142,147,0.15);color:var(--secondary)}
.nf-time{font-size:11px;color:var(--tertiary);white-space:nowrap;flex-shrink:0;margin-left:8px}.nf-headline{font-size:14px;font-weight:600;line-height:1.4;margin-bottom:8px}
.nf-ai{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;padding:8px 12px;background:rgba(10,132,255,0.06);border-radius:8px}
.nf-ai-label{font-size:11px;color:var(--blue);white-space:nowrap;font-weight:600;flex-shrink:0}.nf-ai-text{font-size:13px;color:var(--secondary);line-height:1.6}
.nf-action{display:flex;gap:8px;align-items:center}.nf-action-text{font-size:12px;color:var(--secondary)}.nf-action-text b{font-weight:600}
.positions{margin:0 16px}.pos{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--surface);border-radius:var(--rs);margin-bottom:8px;position:relative;overflow:hidden;min-height:56px}
.pos::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px}.pos.win::before{background:var(--green)}.pos.lose::before{background:var(--red)}
.pos.rr-high{box-shadow:inset 0 0 0 1px rgba(48,209,88,0.15),0 0 12px rgba(48,209,88,0.08)}.pos.rr-high::before{background:var(--green);width:4px}
.pos-dir{width:32px;height:32px;border-radius:8px;display:grid;place-items:center;font-size:12px;font-weight:800;flex-shrink:0}
.pos-dir.b{background:rgba(10,132,255,0.12);color:var(--blue)}.pos-dir.s{background:rgba(100,210,255,0.12);color:var(--teal)}
.pos-body{flex:1}.pos-top{display:flex;justify-content:space-between;align-items:baseline}
.pos-pair{font-size:15px;font-weight:600}.pos-pnl{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}.pos-pnl.pos{color:var(--green)}.pos-pnl.neg{color:var(--red)}
.pos-rr-badge{font-size:12px;font-weight:700;padding:2px 8px;border-radius:6px;font-variant-numeric:tabular-nums;letter-spacing:0.3px}
.pos-bot{display:flex;justify-content:space-between;align-items:center;margin-top:4px}.pos-meta{font-size:11px;color:var(--tertiary)}.pos-meta .time-warn{color:var(--orange)}
.mkt-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:0 16px}
.mkt{padding:8px;background:var(--surface);border-radius:var(--rs);text-align:center}.mkt-v{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}.mkt-l{font-size:11px;color:var(--tertiary);margin-top:4px}.mkt-d{font-size:11px}.mkt-d.up{color:var(--green)}.mkt-d.dn{color:var(--red)}
.wait-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:8px 16px 0}.wt{padding:8px;background:var(--surface);border-radius:var(--rs)}.wt-pair{font-size:12px;font-weight:500}.wt-price{font-size:11px;color:var(--secondary);font-variant-numeric:tabular-nums;margin-top:2px}

/* ═══ TAB 2: 学び ═══ */
.th-sort-btn{font-size:11px;padding:4px 10px;border-radius:12px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:var(--tertiary);cursor:pointer;min-height:28px;font-weight:500;transition:all 0.15s}
.th-sort-btn.th-sort-active{background:var(--blue);color:#fff;border-color:var(--blue)}
.th-sort-btn:active{opacity:0.7}
.evo-card{margin:0 16px 8px;padding:16px;background:var(--surface);border-radius:var(--r)}
.evo-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.evo-pair{font-size:17px;font-weight:700}.evo-verdict{font-size:13px;font-weight:600}
.evo-chart{height:48px;margin:8px 0;position:relative}
.evo-chart svg{width:100%;height:100%}
.evo-changes{margin-top:8px}
.evo-change{display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px}
.evo-change:last-child{border-bottom:none}
.evo-dot{width:8px;height:8px;border-radius:50%;margin-top:4px;flex-shrink:0}
.evo-dot.improved{background:var(--green)}.evo-dot.worsened{background:var(--red)}.evo-dot.neutral{background:var(--tertiary)}
.evo-text{font-size:13px;color:var(--secondary);line-height:1.5}
.evo-result{font-weight:600}
.worked{color:var(--green)}.didnt{color:var(--red)}.unchanged{color:var(--tertiary)}
.verdict-strip{display:flex;gap:8px;margin:8px 16px 0}
.verdict-box{flex:1;padding:12px;background:var(--surface);border-radius:var(--rs);text-align:center}
.verdict-num{font-size:24px;font-weight:800;font-variant-numeric:tabular-nums}
.verdict-lbl{font-size:11px;color:var(--tertiary);text-transform:uppercase;margin-top:4px}

/* ═══ TAB 3: AI ═══ */
.ai-score{text-align:center;padding:24px 16px 8px}
.ai-score-num{font-size:56px;font-weight:800;letter-spacing:-2px}
.ai-score-label{font-size:13px;color:var(--secondary);margin-top:4px}
.ai-score-sub{font-size:12px;color:var(--tertiary);margin-top:8px}
.verdict-card{margin:0 16px 8px;padding:16px;background:var(--surface);border-radius:var(--rs);border-left:3px solid var(--tertiary)}
.verdict-card.correct{border-left-color:var(--green)}.verdict-card.wrong{border-left-color:var(--red)}.verdict-card.pending{border-left-color:var(--blue)}
.vc-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.vc-action{font-size:14px;font-weight:600}
.vc-verdict{font-size:12px;font-weight:700;padding:2px 8px;border-radius:4px}
.vc-verdict.correct{background:rgba(48,209,88,0.15);color:var(--green)}
.vc-verdict.wrong{background:rgba(255,69,58,0.15);color:var(--red)}
.vc-verdict.pending{background:rgba(10,132,255,0.15);color:var(--blue)}
.vc-reason{font-size:13px;color:var(--secondary);line-height:1.6;margin-bottom:4px}
.vc-outcome{font-size:12px;font-weight:600}.vc-time{font-size:11px;color:var(--tertiary)}

/* ═══ TAB 4: 戦略 ═══ */
.journey-card{margin:0 16px 12px;padding:16px;background:var(--surface);border-radius:var(--r)}
.jc-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.jc-pair{font-size:17px;font-weight:700}.jc-ver{font-size:12px;color:var(--blue)}
.jc-summary{font-size:13px;color:var(--secondary);line-height:1.5;margin-bottom:12px;padding:8px 12px;background:var(--bg);border-radius:var(--rs)}
.jc-timeline{position:relative;padding-left:20px}
.jc-timeline::before{content:'';position:absolute;left:6px;top:4px;bottom:4px;width:2px;background:var(--tertiary)}
.jc-step{position:relative;padding-bottom:16px}
.jc-step:last-child{padding-bottom:0}
.jc-step::before{content:'';position:absolute;left:-16px;top:4px;width:10px;height:10px;border-radius:50%;border:2px solid var(--tertiary);background:var(--bg)}
.jc-step.good::before{border-color:var(--green);background:rgba(48,209,88,0.2)}
.jc-step.bad::before{border-color:var(--red);background:rgba(255,69,58,0.2)}
.jc-step.current::before{border-color:var(--blue);background:var(--blue)}
.jc-step-header{display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px}
.jc-step-ver{font-weight:600}.jc-step-time{color:var(--tertiary)}
.jc-step-desc{font-size:12px;color:var(--secondary);line-height:1.5}
.jc-step-result{font-size:11px;font-weight:600;margin-top:2px}
.jc-params-toggle{font-size:12px;color:var(--blue);cursor:pointer;margin-top:8px;padding:8px 0;min-height:44px;display:flex;align-items:center}
.jc-params{display:none;margin-top:8px;font-size:11px}
.jc-params.open{display:block}
.jc-param-row{display:flex;justify-content:space-between;padding:4px 0;color:var(--tertiary)}
.jc-param-row .val{color:var(--secondary);font-weight:500;font-variant-numeric:tabular-nums}

/* ═══ TAB 5: 系統 ═══ */
.health-hero{text-align:center;padding:32px 16px 16px}
.health-icon{font-size:64px;margin-bottom:8px}
.health-text{font-size:20px;font-weight:700}
.health-sub{font-size:13px;color:var(--secondary);margin-top:4px}
.health-checks{margin:0 16px}
.hc{padding:16px;background:var(--surface);border-radius:var(--rs);margin-bottom:8px;cursor:pointer;-webkit-tap-highlight-color:transparent}
.hc:active{opacity:0.8}
.hc-row{display:flex;justify-content:space-between;align-items:center}
.hc-left{display:flex;align-items:center;gap:10px}
.hc-label{font-size:14px;font-weight:500}
.hc-value{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.hc-value.ok{color:var(--green)}.hc-value.warn{color:var(--orange)}.hc-value.error{color:var(--red)}
.log-section{margin:0 16px;max-height:300px;overflow-y:auto;-webkit-overflow-scrolling:touch}
.log-item{padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px}
.log-header{display:flex;gap:8px;align-items:center;margin-bottom:4px}
.log-level{font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px}
.log-level.info{background:rgba(10,132,255,0.15);color:var(--blue)}.log-level.warn{background:rgba(255,159,10,0.15);color:var(--orange)}.log-level.error{background:rgba(255,69,58,0.15);color:var(--red)}
.log-cat{font-size:11px;color:var(--tertiary)}.log-time{font-size:11px;color:var(--tertiary);margin-left:auto}
.log-msg{font-size:13px;color:var(--secondary);line-height:1.5}
/* ═══════════════════════════════════════════════════
   PRESERVED: Light mode overrides
   ═══════════════════════════════════════════════════ */
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg:#F2F2F7;--surface:#FFFFFF;--card:#E5E5EA;--elevated:#D1D1D6;
    --text:#000000;--secondary:#8A8A8E;--tertiary:rgba(60,60,67,0.3);
    --green:#34C759;--red:#FF3B30;--orange:#FF9500;--blue:#007AFF;--teal:#32ADE6;--purple:#AF52DE;
    --glass-bg-rgb:242,242,247;--glass-shadow-rgb:0,0,0;--glass-border-rgb:200,200,200;
  }
}
:root[data-theme="light"] {
  --bg:#F2F2F7;--surface:#FFFFFF;--card:#E5E5EA;--elevated:#D1D1D6;
  --text:#000000;--secondary:#8A8A8E;--tertiary:rgba(60,60,67,0.3);
  --green:#34C759;--red:#FF3B30;--orange:#FF9500;--blue:#007AFF;--teal:#32ADE6;--purple:#AF52DE;
  --glass-bg-rgb:242,242,247;--glass-shadow-rgb:0,0,0;--glass-border-rgb:200,200,200;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .sbar { background:rgba(242,242,247,0.92); }
  :root:not([data-theme="dark"]) .tabs { background:rgba(242,242,247,0.92); }
}
:root[data-theme="light"] .sbar { background:rgba(242,242,247,0.92); }
:root[data-theme="light"] .tabs { background:rgba(242,242,247,0.92); }

/* ═══════════════════════════════════════════════════
   PRESERVED: Body states
   ═══════════════════════════════════════════════════ */
body.drawer-open, body.sheet-open { overflow: hidden !important; touch-action: none; }
#app { min-height: 100dvh; }

/* ═══════════════════════════════════════════════════
   PRESERVED: Skeleton loading
   ═══════════════════════════════════════════════════ */
.skeleton-line { display: inline-block; background: linear-gradient(90deg, var(--surface) 25%, var(--elevated) 50%, var(--surface) 75%); background-size: 200% 100%; animation: shimmer 1.6s ease-in-out infinite; border-radius: 6px; vertical-align: middle; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* ═══════════════════════════════════════════════════
   PRESERVED: UX Psychology animations
   ═══════════════════════════════════════════════════ */
@keyframes urgent-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
@keyframes upgraded-glow { 0%, 100% { box-shadow: 0 0 0 0 rgba(48, 209, 88, 0); } 50% { box-shadow: 0 0 8px 2px rgba(48, 209, 88, 0.55); } }
@keyframes emergency-flash { 0%, 100% { background-color: var(--red); } 50% { background-color: #ff6b60; } }
@keyframes pnl-flash { 0% { filter: brightness(1); } 30% { filter: brightness(2.2) saturate(1.5); } 100% { filter: brightness(1); } }

/* ═══════════════════════════════════════════════════
   PRESERVED: Bottom Sheet
   ═══════════════════════════════════════════════════ */
.sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 30; opacity: 0; pointer-events: none; transition: opacity 0.3s ease; }
.sheet-backdrop.visible { opacity: 1; pointer-events: auto; }
.sheet { position: fixed; bottom: 0; left: 0; right: 0; background: var(--surface); border-radius: 20px 20px 0 0; z-index: 40; transform: translateY(100%); transition: transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1); padding-bottom: env(safe-area-inset-bottom); min-height: 55dvh; max-height: 65dvh; overflow-y: auto; }
.sheet.open { transform: translateY(0); }
.sheet-handle { width: 36px; height: 4px; background: var(--elevated); border-radius: 3px; margin: 12px auto 0; }
.sheet-title { font-size: 17px; font-weight: 600; padding: 16px 20px 8px; letter-spacing: -0.2px; }
.sheet-body { padding: 8px 20px 24px; display: flex; flex-direction: column; gap: 16px; }
.sheet-row { display: flex; justify-content: space-between; align-items: baseline; }
.sheet-label { font-size: 15px; color: var(--secondary); }
.sheet-value { font-size: 17px; font-weight: 500; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }
.sheet-progress-wrap { margin: 4px 0 2px; }
.sheet-progress-label { display: flex; justify-content: space-between; font-size: 11px; color: var(--secondary); margin-bottom: 5px; }
.sheet-progress-track { height: 6px; background: var(--elevated); border-radius: 3px; position: relative; overflow: visible; }
.sheet-progress-sl { position: absolute; top: 0; left: 0; height: 100%; background: var(--red); border-radius: 3px 0 0 3px; opacity: 0.5; transition: width 0.4s ease; }
.sheet-progress-tp { position: absolute; top: 0; right: 0; height: 100%; background: var(--green); border-radius: 0 3px 3px 0; opacity: 0.6; transition: width 0.4s ease; }
.sheet-progress-cursor { position: absolute; top: 50%; transform: translate(-50%, -50%); width: 10px; height: 10px; border-radius: 50%; background: var(--text); border: 2px solid var(--surface); box-shadow: 0 0 4px rgba(0,0,0,0.5); transition: left 0.4s ease; }
.sheet-distance-row { display: flex; justify-content: space-between; margin-top: 8px; gap: 8px; }
.sheet-distance-item { flex: 1; background: var(--card); border-radius: var(--rs); padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.sheet-distance-label { font-size: 10px; color: var(--secondary); font-weight: 600; letter-spacing: 0.5px; }
.sheet-distance-value { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }

/* ═══════════════════════════════════════════════════
   PRESERVED: News Drawer
   ═══════════════════════════════════════════════════ */
.news-drawer { position: fixed; left: 0; right: 0; bottom: calc(49px + env(safe-area-inset-bottom)); max-height: calc(100dvh - 49px - env(safe-area-inset-bottom) - env(safe-area-inset-top) - 120px); overflow: hidden; z-index: 15; background: var(--surface); border-top: 1px solid rgba(255,255,255,0.10); -webkit-backdrop-filter: blur(24px) saturate(1.8); backdrop-filter: blur(24px) saturate(1.8); border-radius: 14px 14px 0 0; transform: translateY(calc(100% - 68px)); transition: transform 0.42s cubic-bezier(0.34, 1.56, 0.64, 1); will-change: transform; touch-action: pan-y; display: none; flex-direction: column; }
.news-drawer.visible { display: flex; }
.news-drawer.expanded { transform: translateY(0); bottom: 0; height: calc(100dvh - env(safe-area-inset-top) - 120px); }
.news-drawer.expanded .news-drawer-body { overflow-y: auto; -webkit-overflow-scrolling: touch; flex: 1; min-height: 0; touch-action: pan-y; }
.news-drawer-handle { width: 36px; height: 4px; background: rgba(255,255,255,0.28); border-radius: 2px; margin: 8px auto 0; }
.news-drawer-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; min-height: 44px; cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: none; }
.news-drawer-title { font-size: 13px; font-weight: 600; color: var(--text); }
.news-drawer-chevron { font-size: 18px; color: var(--secondary); transition: transform 0.3s ease; display: inline-block; line-height: 1; transform: rotate(-90deg); }
.news-drawer.expanded .news-drawer-chevron { transform: rotate(90deg); }
.news-drawer-body { overflow: hidden; padding: 0 0 8px; }
.news-item { padding: 12px 16px; min-height: 44px; display: flex; flex-direction: column; justify-content: center; border-bottom: 1px solid rgba(255,255,255,0.06); cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
.news-item:last-child { border-bottom: none; }
.news-item:active { background: rgba(255,255,255,0.06); }
.news-attention { background: rgba(255,149,0,0.08); }
.news-flag { display: inline-block; margin-right: 5px; font-size: 9px; font-weight: 700; letter-spacing: 0.4px; color: var(--orange); background: rgba(255,149,0,0.15); padding: 1px 5px; border-radius: 4px; vertical-align: middle; }
.news-item-title { font-size: 13px; color: var(--text); line-height: 1.45; margin-bottom: 4px; }
.news-item-date { font-size: 11px; color: var(--tertiary); font-variant-numeric: tabular-nums; }
body.drawer-open .tabs, body.sheet-open .tabs { transform: translateZ(0) translateY(100%); transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1); }

/* ═══════════════════════════════════════════════════
   PRESERVED: Traceability
   ═══════════════════════════════════════════════════ */
.trace-section { margin: 12px 0; padding: 10px 12px; background: var(--surface); border-radius: 8px; }
.trace-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 4px; }
.trace-reasoning { font-size: 12px; line-height: 1.5; color: var(--secondary); font-family: 'SF Mono', ui-monospace, monospace; word-break: break-all; }
.trace-formula { font-size: 12px; font-family: 'SF Mono', ui-monospace, monospace; color: var(--text); padding: 4px 0; }
.trace-note { font-size: 11px; color: var(--orange); margin-top: 2px; }
.trace-params { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; font-size: 12px; }
.trace-param-label { color: var(--secondary); }
.trace-param-value { font-weight: 500; }
.trace-history-item { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 12px; }
.trace-history-item:last-child { border-bottom: none; }
.trace-history-version { font-weight: 600; color: var(--blue); }
.trace-history-reason { color: var(--secondary); margin-top: 2px; line-height: 1.4; }

/* ═══════════════════════════════════════════════════
   PRESERVED: TP/SL Banners
   ═══════════════════════════════════════════════════ */
.tp-banner { position: fixed; inset: 0; pointer-events: none; z-index: 50; }
.tp-banner-inner { position: absolute; top: calc(env(safe-area-inset-top) + 56px); left: 16px; right: 16px; background: var(--green); color: #000; border-radius: var(--r); padding: 16px; font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; transform: translateY(-16px); opacity: 0; pointer-events: none; transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease; overflow: hidden; }
.tp-banner.show .tp-banner-inner { transform: translateY(0); opacity: 1; pointer-events: auto; }
.tp-banner-inner::before { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.25) 50%, transparent 100%); background-size: 200% 100%; animation: tp-shimmer 1.2s ease-in-out 3; }
@keyframes tp-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.tp-banner-icon { font-size: 22px; flex-shrink: 0; }
.tp-banner-text { flex: 1; }
.tp-banner-title { font-size: 16px; font-weight: 800; }
.tp-banner-sub { font-size: 15px; opacity: 1; font-weight: 700; }
.tp-banner.sl-banner .tp-banner-inner { background: linear-gradient(135deg, #2C2C2E 0%, #3A3A3C 50%, #2C2C2E 100%); color: var(--text); }
.tp-banner.sl-banner .tp-banner-inner::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent 30%, rgba(212,175,55,0.35) 50%, transparent 70%); background-size: 200% 100%; animation: kintsugi-shine 2.5s ease-in-out 2; }
@keyframes kintsugi-shine { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* ═══════════════════════════════════════════════════
   PRESERVED: Emergency news banner
   ═══════════════════════════════════════════════════ */
.emergency-news-banner { display: none; align-items: center; gap: 8px; padding: 10px 14px; background: var(--red); border-radius: 10px; margin-bottom: 12px; color: #fff; font-size: 13px; font-weight: 600; opacity: 0; transition: opacity 0.4s ease; }
.emergency-news-banner.visible { display: flex; opacity: 1; animation: emergency-flash 1.5s ease-in-out infinite; }
.emergency-news-banner.fading { opacity: 0; }

/* ═══════════════════════════════════════════════════
   PRESERVED: Parameter cards
   ═══════════════════════════════════════════════════ */
.param-card { border-radius: 12px; background: var(--card); margin-bottom: 8px; overflow: hidden; }
.param-card-summary { display: flex; align-items: center; gap: 8px; padding: 10px 14px; min-height: 44px; cursor: pointer; -webkit-tap-highlight-color: transparent; user-select: none; }
.param-card-summary:active { opacity: 0.7; }
.param-chevron { font-size: 11px; color: var(--tertiary); transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1); flex-shrink: 0; }
.param-card-detail { max-height: 0; overflow: hidden; transition: max-height 0.3s ease-out; }
.param-card-detail.expanded { max-height: 300px; }
.param-detail-inner { padding: 0 14px 12px; border-top: 1px solid rgba(255,255,255,0.06); margin-top: 0; }
.param-grid-6 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding-top: 10px; }
.param-grid-cell { text-align: center; }
.param-grid-cell .cell-label { font-size: 10px; color: var(--tertiary); margin-bottom: 2px; }
.param-grid-cell .cell-value { font-size: 13px; font-weight: 600; }
.param-last-review { margin-top: 8px; font-size: 11px; color: var(--tertiary); text-align: center; }
.param-group-header td { font-size: 11px; font-weight: 600; color: var(--blue); padding: 8px 6px 4px; border-bottom: 1px solid rgba(255,255,255,0.06); text-transform: uppercase; letter-spacing: 0.5px; }
.param-group-divider { grid-column: 1 / -1; font-size: 10px; font-weight: 600; color: var(--blue); padding: 6px 0 2px; letter-spacing: 0.5px; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.06); margin-top: 4px; }
.param-progress-track { height: 5px; background: var(--elevated); border-radius: 3px; margin: 4px 14px 6px; overflow: hidden; }
.param-progress-fill { height: 100%; border-radius: 3px; transition: width 0.5s cubic-bezier(0.22, 1, 0.36, 1); }
.param-progress-fill.progress-normal { background: var(--blue); }
.param-progress-fill.progress-warning { background: var(--orange); }
.param-progress-fill.progress-urgent { background: var(--red); animation: urgent-pulse 1.2s ease-in-out infinite; }
.param-category-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 4px 6px; cursor: pointer; -webkit-tap-highlight-color: transparent; user-select: none; min-height: 44px; }
.param-category-title { font-size: 13px; font-weight: 600; color: var(--secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.param-category-chevron { font-size: 11px; color: var(--tertiary); transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1); }
.param-category-header.collapsed .param-category-chevron { transform: rotate(-90deg); }
.param-category-body { max-height: 9999px; overflow: hidden; transition: max-height 0.35s ease-out; }
.param-category-body.collapsed { max-height: 0; }
.badge-version { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 5px; background: var(--elevated); color: var(--secondary); vertical-align: middle; }
.badge-upgraded { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 5px; background: rgba(48, 209, 88, 0.15); color: var(--green); vertical-align: middle; animation: upgraded-glow 2s ease-in-out infinite; }
.param-reason-block { background: rgba(0, 122, 255, 0.08); border-left: 3px solid var(--blue); border-radius: 0 8px 8px 0; padding: 8px 10px; margin-bottom: 10px; font-size: 13px; line-height: 1.5; }
.param-reason-label { font-size: 10px; font-weight: 700; color: var(--blue); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }

/* ═══════════════════════════════════════════════════
   PRESERVED: AI tab components
   ═══════════════════════════════════════════════════ */
.ai-kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
.kpi-card { position: relative; overflow: hidden; background: var(--surface); border-radius: 14px; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
.kpi-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: rgba(255,255,255,0.1); }
.kpi-val { font-size: 22px; font-weight: 700; line-height: 1.2; color: var(--text); }
.kpi-val.green { color: var(--green); }
.kpi-val.red { color: var(--red); }
.kpi-sub { font-size: 11px; color: var(--tertiary); line-height: 1.4; }
.kpi-label { font-size: 11px; color: var(--secondary); margin-bottom: 2px; }
.kpi-latest-body { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.trigger-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
.trigger-cell { border-radius: 12px; padding: 8px 12px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.trigger-cell.news { background: rgba(90,200,250,0.08); border: 1px solid rgba(90,200,250,0.2); }
.trigger-cell.rate { background: rgba(255,159,10,0.08); border: 1px solid rgba(255,159,10,0.2); }
.trigger-cell.cron { background: rgba(174,174,178,0.08); border: 1px solid rgba(174,174,178,0.2); }
.trigger-count { font-size: 20px; font-weight: 700; }
.trigger-cell.news .trigger-count { color: var(--teal); }
.trigger-cell.rate .trigger-count { color: var(--orange); }
.trigger-cell.cron .trigger-count { color: var(--tertiary); }
.trigger-label { font-size: 11px; color: var(--secondary); text-align: center; }
.ai-sec-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.ai-sec-title { font-size: 15px; font-weight: 600; color: var(--text); }
.ai-sec-filter { font-size: 12px; color: var(--blue); padding: 8px 4px; margin: -8px -4px; }
.tl-list { display: flex; flex-direction: column; gap: 8px; }
.tl-card { position: relative; background: var(--surface); border-radius: 14px; overflow: hidden; cursor: pointer; transition: opacity 0.1s ease; }
.tl-card:active { opacity: 0.75; }
.tl-accent { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; }
.tl-accent.open { background: var(--blue); }
.tl-accent.tp { background: var(--green); }
.tl-accent.sl { background: var(--red); }
.tl-accent.closed { background: var(--tertiary); }
.tl-inner { padding: 12px 12px 12px 16px; }
.tl-row1 { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.tl-row2 { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.tl-row3 { display: flex; align-items: center; justify-content: space-between; }
.tl-left { display: flex; align-items: center; gap: 6px; }
.tl-pair { font-size: 13px; font-weight: 600; color: var(--text); }
.tl-rate { font-size: 13px; color: var(--secondary); }
.tl-meta { display: flex; align-items: center; gap: 6px; }
.tl-time { font-size: 11px; color: var(--tertiary); }
.tl-chevron { font-size: 12px; color: var(--tertiary); transition: transform 0.25s ease; }
.tl-card.expanded .tl-chevron { transform: rotate(90deg); }
.dir-badge { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 6px; letter-spacing: 0.02em; }
.dir-badge.buy { background: rgba(10,132,255,0.18); color: var(--blue); }
.dir-badge.sell { background: rgba(100,210,255,0.18); color: var(--teal); }
.tl-chip { font-size: 11px; padding: 2px 7px; border-radius: 6px; white-space: nowrap; }
.tl-chip.news { background: rgba(90,200,250,0.12); color: var(--teal); border: 1px solid rgba(90,200,250,0.28); }
.tl-chip.rate { background: rgba(255,159,10,0.12); color: var(--orange); border: 1px solid rgba(255,159,10,0.28); }
.tl-chip.cron { background: rgba(174,174,178,0.08); color: var(--tertiary); border: 1px solid rgba(174,174,178,0.2); }
.tl-reasoning-chip { font-size: 11px; color: var(--secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.tl-result { display: flex; align-items: center; gap: 4px; }
.result-dot { width: 7px; height: 7px; border-radius: 50%; }
.result-dot.open { background: var(--blue); }
.result-dot.tp { background: var(--green); }
.result-dot.sl { background: var(--red); }
.result-dot.closed { background: var(--tertiary); }
.tl-result-text { font-size: 11px; }
.tl-result-text.open { color: var(--blue); }
.tl-result-text.tp { color: var(--green); }
.tl-result-text.sl { color: var(--red); }
.tl-result-text.closed { color: var(--tertiary); }
.detail-panel { max-height: 0; overflow: hidden; opacity: 0; transition: max-height 0.3s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease, padding 0.3s cubic-bezier(0.4,0,0.2,1); border-top: 0px solid rgba(255,255,255,0.06); }
.detail-panel.open { max-height: 800px; opacity: 1; padding: 14px 16px 16px 15px; border-top: 1px solid rgba(255,255,255,0.06); }
.detail-section-label { font-size: 10px; font-weight: 600; color: var(--tertiary); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px; }
.detail-tpsl-section { margin-bottom: 16px; }
.detail-tpsl-gauge { margin-bottom: 6px; }
.tpsl-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--elevated); }
.tpsl-sl-zone { background: linear-gradient(90deg, var(--red), rgba(255,69,58,0.4)); border-radius: 3px 0 0 3px; }
.tpsl-tp-zone { background: linear-gradient(90deg, rgba(48,209,88,0.4), var(--green)); border-radius: 0 3px 3px 0; }
.tpsl-entry-mark { width: 2px; background: var(--text); flex-shrink: 0; position: relative; z-index: 1; }
.tpsl-labels { display: flex; justify-content: space-between; margin-top: 4px; }
.tpsl-label { font-size: 11px; font-weight: 500; }
.tpsl-label.sl { color: var(--red); }
.tpsl-label.entry { color: var(--secondary); font-size: 10px; }
.tpsl-label.tp { color: var(--green); }
.tpsl-meta { display: flex; align-items: center; gap: 12px; }
.tpsl-rr { font-size: 12px; font-weight: 700; background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 6px; }
.tpsl-pips { font-size: 11px; color: var(--tertiary); }
.detail-reason-section { margin-bottom: 16px; }
.detail-reason-body { font-size: 13px; line-height: 1.7; padding: 10px 12px; background: rgba(255,255,255,0.04); border-radius: 10px; border-left: 3px solid var(--blue); }
.detail-context-section { margin-bottom: 12px; }
.detail-indicator-bar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.detail-ind { display: flex; flex-direction: column; align-items: center; background: rgba(255,255,255,0.05); border-radius: 8px; padding: 6px 10px; min-width: 56px; }
.detail-ind-label { font-size: 9px; color: var(--tertiary); margin-bottom: 2px; letter-spacing: 0.04em; }
.detail-ind-val { font-size: 13px; font-weight: 600; }
.detail-ind-val.warn { color: var(--orange); }
.detail-news-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.detail-news-item { display: flex; align-items: flex-start; gap: 8px; }
.detail-news-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tertiary); margin-top: 5px; flex-shrink: 0; }
.detail-news-dot.high { background: var(--red); }
.detail-news-dot.med { background: var(--orange); }
.detail-news-title { font-size: 12px; color: var(--secondary); line-height: 1.5; }
.detail-news-list.pathb .detail-news-item { padding: 6px 0; }
.detail-news-list.pathb .detail-news-title { font-size: 13px; color: var(--text); font-weight: 500; }
.detail-news-impact { font-size: 11px; color: var(--secondary); margin-left: 14px; margin-top: 2px; line-height: 1.5; }
.detail-news-ref { margin-top: 8px; padding: 8px 10px; background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px dashed rgba(255,255,255,0.08); }
.detail-news-ref-label { font-size: 10px; color: var(--tertiary); display: block; margin-bottom: 6px; }
.detail-news-ref-item { font-size: 11px; color: var(--tertiary); line-height: 1.5; padding: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-footer { display: flex; align-items: center; justify-content: space-between; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06); }
.detail-footer-left { display: flex; align-items: center; gap: 8px; }
.detail-footer-time { font-size: 11px; color: var(--tertiary); }
.detail-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.detail-chip { font-size: 11px; padding: 2px 7px; border-radius: 6px; background: rgba(255,255,255,0.06); color: var(--secondary); }
.hold-sep { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.hold-sep-line { flex: 1; height: 1px; background: rgba(255,255,255,0.06); }
.hold-sep-label { font-size: 11px; color: var(--tertiary); white-space: nowrap; }

/* ═══════════════════════════════════════════════════
   PRESERVED: Causal summary, heatmap, alerts, misc
   ═══════════════════════════════════════════════════ */
.causal-summary { padding: 12px 16px; margin: 8px 0; border-radius: 12px; background: var(--surface); }
.causal-narrative { font-size: 14px; line-height: 1.5; color: var(--secondary); margin-bottom: 10px; }
.causal-drivers { display: flex; gap: 8px; margin-bottom: 10px; }
@media (max-width: 767px) { .causal-drivers { flex-direction: column; } }
.driver-card { flex: 1; padding: 10px 12px; border-radius: 8px; background: var(--bg); border-left: 3px solid transparent; cursor: pointer; }
.driver-card:active { opacity: 0.7; }
.driver-profit { border-left-color: var(--green); }
.driver-loss { border-left-color: var(--red); }
.driver-label { font-size: 11px; color: var(--secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
.driver-pair { font-size: 15px; font-weight: 600; }
.driver-pnl { font-size: 18px; font-weight: 700; margin: 2px 0; }
.driver-pnl.positive { color: var(--green); }
.driver-pnl.negative { color: var(--red); }
.driver-reason { font-size: 12px; color: var(--secondary); }
.causal-factors { display: flex; flex-wrap: wrap; gap: 4px; }
.factor-badge { display: inline-block; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; cursor: pointer; }
.factor-high { background: rgba(255,69,58,0.2); color: #FF453A; }
.factor-medium { background: rgba(255,159,10,0.2); color: #FF9F0A; }
.factor-low { background: rgba(142,142,147,0.2); color: #8E8E93; }
.causal-heatmap { margin-top: 10px; }
.heatmap-grid { display: grid; gap: 1px; font-size: 11px; border-radius: 6px; overflow: hidden; }
.alert-banner-container { position: fixed; top: 0; left: 0; width: 100%; z-index: 9999; pointer-events: none; }
.alert-banner { padding: 8px 16px; font-size: 13px; font-weight: 600; text-align: center; pointer-events: auto; }
.alert-red { background: #FF453A; color: #fff; }
.alert-orange { background: #FF9F0A; color: #fff; }
.alert-yellow { background: #FFD60A; color: #1C1C1E; }
.highlight-flash { animation: flash-bg 0.8s ease-out; }
@keyframes flash-bg { 0% { background-color: rgba(0,122,255,0.15); } 100% { background-color: transparent; } }
.positive { color: var(--green); }
.negative { color: var(--red); }
.neutral { color: var(--text); }
.sparkline { display: block; flex-shrink: 0; }

@media (prefers-reduced-motion: reduce) {
  .skeleton-line { animation: none; }
  .param-progress-fill.progress-urgent { animation: none; }
  .badge-upgraded { animation: none; }
  .emergency-news-banner.visible { animation: none; }
  .param-card-detail { transition: none; }
  .param-category-body { transition: none; }
}

/* ═══ Tracking list text overflow protection ═══ */
#tracking-list-container div { overflow: hidden; text-overflow: ellipsis; }

/* ═══ Accessibility: キーボードフォーカス表示 (WCAG 2.4.7) ═══ */
:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
  border-radius: var(--rs);
}
.tab:focus-visible, .pc-tabbar-item:focus-visible, .sidebar-tab:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

/* ═══════════════════════════════════════════════════
   PRESERVED: PC Responsive
   ═══════════════════════════════════════════════════ */
:root { --sidebar-bg: var(--bg); --sidebar-width: clamp(56px, 3.5vw, 72px); --panel-bg: var(--surface); --panel-width: clamp(300px, 18vw, 420px); --panel-border: rgba(255,255,255,0.06); --container-max: clamp(1200px, 85vw, 2200px); }
.pc-sidebar { display: none; }
.pc-tabbar { display: none; }
.pc-panel { display: none; }
.panel-content { display: none; }
.panel-content.active { display: block; }

@media (min-width: 769px) {
  .tabs { display: none !important; }
  .pc-tabbar { display: flex !important; position: sticky; top: 0; z-index: 50; height: 44px; background: var(--bg); border-bottom: 1px solid rgba(255,255,255,0.06); align-items: center; justify-content: center; gap: 4px; padding: 0 16px; }
  .pc-tabbar-item { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: var(--rs); color: var(--secondary); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; border: none; background: none; }
  .pc-tabbar-item:hover { background: var(--card); }
  .pc-tabbar-item.active { color: var(--blue); background: var(--card); }
  .pc-tabbar-item svg { width: 16px; height: 16px; }
  .sbar { position: static; }
  .tab-panel.active { display: block; }
  /* カード系のコンテナをグリッド化し、間延びを防止 */
  #journey-cards, #evo-cards, #ai-pr-cards, #ai-news-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 16px;
    padding: 0 16px 24px;
  }
  /* モバイル用の上下マージンをリセットし、グリッドのgapに任せる */
  .journey-card, .evo-card, .verdict-card {
    margin: 0 !important;
  }
}
@media (min-width: 1280px) {
  .pc-tabbar { display: none !important; }
  .pc-sidebar { display: flex !important; flex-direction: column; align-items: center; width: var(--sidebar-width); min-width: 56px; background: var(--sidebar-bg); border-right: 1px solid rgba(255,255,255,0.06); padding-top: 12px; flex-shrink: 0; position: fixed; top: 0; left: 0; bottom: 0; z-index: 60; }
  .sidebar-logo { font-size: 16px; font-weight: 700; color: var(--blue); margin-bottom: 20px; letter-spacing: -0.5px; }
  .sidebar-tab { width: 44px; height: 44px; border-radius: 10px; display: flex; flex-direction: column; align-items: center; justify-content: center; margin-bottom: 4px; cursor: pointer; transition: all 0.15s ease; position: relative; border: none; background: none; color: var(--secondary); }
  .sidebar-tab svg { width: 20px; height: 20px; stroke: currentColor; fill: none; stroke-width: 1.6; }
  .sidebar-tab span { font-size: 9px; margin-top: 2px; color: inherit; }
  .sidebar-tab:hover { background: var(--card); }
  .sidebar-tab.active { color: var(--blue); background: rgba(10,132,255,0.12); }
  .sidebar-tab.active::before { content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; background: var(--blue); border-radius: 0 2px 2px 0; }
  .sidebar-spacer { flex: 1; }
  .sidebar-bottom { margin-bottom: 12px; }
  body { margin-left: var(--sidebar-width); }
  .sbar { position: sticky; margin-left: 0; }
  .tp-banner { margin-left: var(--sidebar-width); }
}
@media (min-width: 1920px) {
  .news-drawer { display: none !important; }
  .pc-panel { display: flex !important; flex-direction: column; width: var(--panel-width); min-width: 300px; background: var(--panel-bg); border-left: 1px solid var(--panel-border); flex-shrink: 0; position: fixed; top: 0; right: 0; bottom: 0; overflow-y: auto; overflow-x: hidden; z-index: 50; }
  .panel-header { padding: 16px; font-size: 13px; font-weight: 600; color: var(--secondary); border-bottom: 1px solid rgba(255,255,255,0.06); position: sticky; top: 0; background: var(--panel-bg); z-index: 1; }
  .panel-section { padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .panel-section .label { font-size: 11px; color: var(--secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .panel-section .value { font-size: 16px; font-weight: 600; }
  .panel-news-item { padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,0.06); cursor: pointer; transition: background 0.15s ease; }
  .panel-news-item:hover { background: var(--card); }
  .panel-news-title { font-size: 12px; line-height: 1.4; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .panel-news-meta { font-size: 11px; color: var(--tertiary); }
  .panel-news-attention { border-left: 2px solid var(--orange); padding-left: 14px; }
  body { margin-right: var(--panel-width); }
  .tp-banner { margin-left: var(--sidebar-width); margin-right: var(--panel-width); }
}
@media (min-width: 2560px) {
  body { max-width: var(--container-max); margin-left: auto; margin-right: auto; }
}

/* ═══ PWA standalone mode ═══ */
@media (display-mode: standalone) {
  .sbar {
    padding-top: calc(env(safe-area-inset-top, 0px) + 4px);
  }
  /* body はヘッダーのsafe-area分をpadding-topに持たない（sbarが担う） */
  body { padding-top: 0; }
  /* iOS standalone: overscroll-behavior で Safari の戻る/進むジェスチャーを抑制 */
  html { overflow: hidden; height: 100dvh; overscroll-behavior: none; }
  body { overflow-y: auto; height: 100dvh; -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain; }
  /* フローティングタブバー: standalone では少し上げる（ホームインジケーター分） */
  .tabs {
    bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  }
  /* ボトムシートもsafe-area対応 */
  .sheet { padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }
  /* Pull-to-Refresh インジケーター: ノッチの下から表示 */
  #pull-indicator { top: env(safe-area-inset-top, 0px); }
}

/* ═══ Pull-to-Refresh spinner ═══ */
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ═══ アクティビティフィード ═══ */
.feed-item{display:grid;grid-template-columns:52px 38px 72px 1fr auto;align-items:center;column-gap:6px;padding:8px 16px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px}
.feed-item-ind{opacity:0.8}
.feed-tag{padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;letter-spacing:0.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.feed-tag-buy{background:rgba(10,132,255,0.18);color:#0A84FF}
.feed-tag-sell{background:rgba(100,210,255,0.18);color:#64D2FF}
.feed-tag-loss{background:rgba(255,159,10,0.18);color:#FF9F0A}
.feed-tag-trend-up{background:rgba(48,209,88,0.15);color:#30D158}
.feed-tag-trend-dn{background:rgba(255,69,58,0.15);color:#FF453A}
.feed-time{color:var(--tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.feed-pair{font-weight:600;color:var(--secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed-rate{font-variant-numeric:tabular-nums;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed-note{color:var(--secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;grid-column:4/-1}
.feed-act{font-weight:700;white-space:nowrap}
.feed-act-buy{color:#0A84FF}
.feed-act-sell{color:#64D2FF}
.feed-act-hold{color:var(--tertiary)}
`;

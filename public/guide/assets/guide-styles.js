/*
 * guide-styles.js — 返校指南电子版样式单一来源（schema v2 · 枢纽 × 校区架构）
 *
 * 为什么 CSS 放在 JS 里：前台页 / 编辑器两个出口共用同一份样式，且需要把
 * 样式内联进离屏文档。放在 JS 字符串里，file:// 直接打开也能拿到完整
 * cssText，不依赖 fetch 或 CORS。window.GUIDE_CSS 导出原始字符串。
 *
 * 设计语言：现代、干净、移动优先。卡片 14px 圆角 + 柔和投影，slate 色板，
 * 线路徽标保留各线路专色。打印走 .gc-print-root 离屏树：屏幕 UI 包在
 * #gc-screen 里，@media print 隐藏 #gc-screen、显示 .gc-print-root。
 */
window.GUIDE_CSS = String.raw`
:root{
  /* —— 设计令牌（slate 色板） —— */
  --page:#f5f6f8; --surface:#ffffff; --ink:#0f172a; --ink-2:#334155;
  --sub:#64748b; --faint:#94a3b8; --line:#e2e8f0; --chip:#f1f5f9;
  --primary:#1e80c1; --primary-pressed:#125b8b; --primary-container:#e8f1f8;
  --warning-bg:#fffbeb; --warning-line:#fcd34d; --warning-ink:#92400e;

  /* 时间轴图元 */
  --seg-neutral:#8f98a3; --dot:#475569;
  --bus:#f2b203; --bus-ink:#8f6400;

  --font-sans:"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif;

  --r-sm:8px; --r-md:10px; --r-card:14px;
  --shadow-card:0 1px 2px rgba(15,23,42,.06),0 4px 16px rgba(15,23,42,.06);
  --shadow-hover:0 2px 4px rgba(15,23,42,.07),0 10px 28px rgba(15,23,42,.11);
}

*{box-sizing:border-box}
body{margin:0;font-family:var(--font-sans);color:var(--ink);background:var(--page);
  -webkit-font-smoothing:antialiased}

/* ══════════════ 卡片栅格 ══════════════
 * 移动优先：默认单列，≥1024px 双列，间距 16px。 */
.gc-grid{display:grid;gap:16px;grid-template-columns:minmax(0,1fr)}
@media screen and (min-width:1024px){
  .gc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  /* 长文步骤卡片跨两列：窄栏里逐条步骤会折得太碎 */
  .gc-grid>.gc-card--steps{grid-column:1/-1}
}

.gc-empty{text-align:center;padding:56px 20px;font-size:14px;line-height:21px;
  color:var(--faint);letter-spacing:.02em;background:var(--surface);
  border:1px dashed var(--line);border-radius:var(--r-card)}

/* ══════════════ 原子卡片 ══════════════ */
.gc-card{width:100%;background:var(--surface);border:1px solid var(--line);
  border-radius:var(--r-card);padding:22px;box-shadow:var(--shadow-card);
  position:relative;transition:transform .15s ease,box-shadow .15s ease;
  break-inside:avoid;page-break-inside:avoid}
@media (hover:hover){
  .gc-card:hover{transform:translateY(-1px);box-shadow:var(--shadow-hover)}
}

/* 卡片头第一行：出发点名 + 括注 */
.gc-card-head{margin-bottom:10px}
.gc-origin{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;min-width:0}
.gc-origin__name{margin:0;font-size:18px;font-weight:650;line-height:26px;
  letter-spacing:-.01em}
.gc-origin__note{font-size:12px;font-weight:500;line-height:17px;color:var(--sub)}

/* 卡片头第二行：目的地 chip + 方式徽章 + 右对齐计量 chips */
.gc-card-chips{display:flex;align-items:center;flex-wrap:wrap;gap:8px;
  margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.gc-card-chips:empty{display:none}
.gc-spacer{flex:1}
.gc-dest-chip{display:inline-block;background:var(--primary-container);
  color:var(--primary-pressed);font-size:13px;font-weight:600;line-height:19px;
  padding:3px 12px;border-radius:999px;letter-spacing:.02em;white-space:nowrap}
.gc-mode-badge{font-size:12px;font-weight:600;line-height:18px;padding:3px 12px;
  border-radius:999px;letter-spacing:.04em;white-space:nowrap}
.gc-mode-badge[data-mode="metro"]{background:#b3261e;color:#fff}
.gc-mode-badge[data-mode="bus"]{background:#f59e0b;color:#422006}
.gc-mode-badge[data-mode="rail"]{background:#1e6fb8;color:#fff}
.gc-mode-badge[data-mode="maglev"]{background:#ea7c28;color:#3d2200}
.gc-mode-badge[data-mode="airport"]{background:#35689f;color:#fff}
.gc-mode-badge[data-mode="mixed"],.gc-mode-badge[data-mode="other"]{background:#475569;color:#fff}
.gc-meta-chip{font-size:12px;font-weight:600;line-height:18px;color:var(--ink-2);
  background:var(--chip);padding:3px 10px;border-radius:999px;white-space:nowrap;
  font-variant-numeric:tabular-nums}

/* 提醒 flags：琥珀色警示 chips，位于时间轴上方 */
.gc-flags{display:flex;flex-wrap:wrap;gap:6px;margin:-4px 0 12px}
.gc-flag{font-size:11px;font-weight:600;line-height:16px;letter-spacing:.03em;
  color:var(--warning-ink);background:var(--warning-bg);
  border:1px solid var(--warning-line);padding:3px 9px;border-radius:999px;
  white-space:nowrap}

/* 卡片脚：备注行 + 发车时刻盒 */
.gc-card-foot{margin-top:14px;padding-top:12px;border-top:1px solid var(--line);
  display:flex;flex-direction:column;gap:10px}
.gc-note{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:18px;
  color:var(--sub)}
.gc-note__label{flex:none;font-size:11px;font-weight:600;color:var(--faint);
  letter-spacing:.05em}
.gc-note__text{min-width:0}
.gc-sched{border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden}
.gc-sched__t{background:var(--chip);font-size:12px;font-weight:600;line-height:17px;
  color:var(--ink-2);padding:7px 12px;letter-spacing:.03em}
.gc-sched__row{display:flex;gap:12px;padding:8px 12px;font-size:12px;line-height:18px}
.gc-sched__row+.gc-sched__row{border-top:1px solid var(--line)}
.gc-sched__label{flex:none;font-weight:600;color:var(--ink-2)}
.gc-sched__times{color:var(--sub);font-variant-numeric:tabular-nums}

/* ══════════════ 图标（来自图标库，按 id 引用） ══════════════ */
.gc-ico{display:inline-flex;align-items:center;justify-content:center;flex:none;
  line-height:0;vertical-align:middle}
.gc-ico svg,.gc-ico img{width:100%;height:100%;display:block;object-fit:contain}

/* ══════════════ 时间轴 ══════════════ */
.gc-tl{display:flex;flex-direction:column}
.gc-leg{display:grid;grid-template-columns:36px minmax(0,1fr);align-items:stretch}
.gc-gutter{position:relative}
.gc-gutter .ln{position:absolute;width:3px;transform:translateX(-1.5px)}
.gc-gutter .ln--top{top:0;height:50%}
.gc-gutter .ln--bot{top:50%;height:50%}
.gc-gutter .ln--full{top:0;height:100%}
.gc-gutter .dot{position:absolute;width:10px;height:10px;border-radius:50%;
  background:var(--dot);transform:translate(-5px,-5px)}
.gc-gutter .dot--hollow{background:#fff;border:2.5px solid var(--dot)}
.gc-gutter .cx{position:absolute;width:15px;height:8px;border-radius:4px;background:#fff;
  border:2.5px solid var(--dot);transform:translate(-7.5px,-4px)}

.gc-body{padding:2px 0 9px}
.gc-leg[data-leg-type="ride"] .gc-body,
.gc-leg[data-leg-type="walk"] .gc-body{padding:1px 0 9px}
.gc-stop__name{font-size:16px;font-weight:600;line-height:23px}
.gc-stop__exit{font-size:11px;font-weight:500;line-height:16px;color:var(--ink-2);
  letter-spacing:.02em}
.gc-walk{font-size:12px;line-height:17px;color:var(--sub);letter-spacing:.03em;
  font-variant-numeric:tabular-nums}
.gc-ride{display:flex;align-items:center;flex-wrap:wrap;gap:4px 6px}
.gc-mico{flex:none;display:block}
.gc-lnum{font-size:12px;font-weight:600;line-height:17px;color:#fff;padding:1px 6px;
  border-radius:3px;background:var(--c,var(--seg-neutral));letter-spacing:.02em;
  font-variant-numeric:tabular-nums}
.gc-suffix{font-size:13px;font-weight:600;line-height:18px}
.gc-busline{font-size:13px;font-weight:600;line-height:18px;color:var(--bus-ink);
  background:rgba(242,178,3,.2);padding:1px 6px;border-radius:3px}
.gc-toward-t{font-size:13px;font-weight:500;line-height:18px;color:#20293a}
.gc-lnote{font-size:11px;line-height:16px;color:var(--sub);letter-spacing:.02em}
.gc-notes{display:flex;flex-direction:column;gap:2px;margin-top:2px}

/* 终点强调：把「到了」做成视觉落点 */
.gc-leg[data-terminal="1"] .gc-stop__name{color:var(--primary-pressed)}
.gc-leg[data-terminal="1"] .gc-gutter .dot{background:var(--primary);
  width:13px;height:13px;transform:translate(-6.5px,-6.5px)}

/* ══════════════ 步骤卡片（实景指引 / 附表教程） ══════════════ */
.gc-steps{display:flex;flex-direction:column;gap:16px}
.gc-steps__intro{font-size:13px;line-height:21px;color:var(--ink-2);
  letter-spacing:.01em;background:var(--chip);border-radius:var(--r-md);
  padding:12px 14px}
.gc-sec__t{display:flex;align-items:center;gap:7px;margin:0 0 8px;
  font-size:15px;font-weight:600;line-height:21px;letter-spacing:-.01em}
.gc-sec__dot{flex:none;width:9px;height:9px;border-radius:50%;
  background:var(--c,var(--primary))}
.gc-sec__list{margin:0;padding:0 0 0 22px;display:flex;flex-direction:column;gap:7px}
.gc-sec__list:not(ol){padding-left:0}
.gc-step{font-size:13px;line-height:20px;color:#20293a;letter-spacing:.01em}
.gc-step::marker{color:var(--primary);font-weight:600}
.gc-step__t{display:block}
.gc-step__n{display:block;font-size:11px;line-height:16px;color:var(--sub);margin-top:1px}

/* 实景指引图文混排：小节级照片 + 步骤配图（双列网格，对齐原稿版式） */
.gc-secfigs{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));
  gap:12px;margin:0 0 12px}
.gc-secfig{margin:0}
.gc-secfig img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;
  border-radius:var(--r-sm);border:1px solid var(--line)}
.gc-secfig__cap{font-size:12px;font-weight:600;line-height:17px;color:var(--ink-2);
  margin-top:5px}
.gc-sec__list--grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;
  padding-left:0;list-style:none;counter-reset:gstep}
.gc-sec__list--grid .gc-step{counter-increment:gstep}
.gc-sec__list--grid .gc-step__t::before{content:counter(gstep) ". ";
  color:var(--primary);font-weight:600}
.gc-step__figs{display:flex;gap:6px;margin-bottom:6px}
.gc-step__fig{flex:1 1 0;min-width:0;width:100%;height:auto;border-radius:var(--r-sm);
  border:1px solid var(--line);object-fit:cover}
@media screen and (max-width:640px){
  .gc-sec__list--grid{grid-template-columns:1fr}
}
.gc-pending{display:flex;flex-direction:column;gap:3px;padding:11px 13px;
  border:1px dashed var(--warning-line);border-radius:var(--r-md);
  background:var(--warning-bg)}
.gc-pending__l{font-size:12px;font-weight:600;line-height:17px;
  color:var(--warning-ink);letter-spacing:.02em}
.gc-pending__d{font-size:11px;line-height:17px;color:#6b5228;letter-spacing:.01em}

/* ══════════════ 图示卡片（真图 + 热区） ══════════════ */
.gc-figcard__head{display:flex;align-items:baseline;gap:10px;margin-bottom:4px}
.gc-figcard__t{margin:0;font-size:17px;font-weight:600;line-height:24px;
  letter-spacing:-.01em;padding-bottom:3px;border-bottom:3px solid var(--primary)}
.gc-figcard__cap{font-size:12px;line-height:17px;color:var(--sub);
  letter-spacing:.02em;margin:10px 0 14px}
.gc-figwrap{position:relative;background:var(--chip);border-radius:var(--r-md);
  overflow:hidden;line-height:0}
.gc-figwrap img{width:100%;height:auto;display:block}

/* 热区：半透明虚线描边默认常显，hover 加深；坐标百分比随图缩放 */
.gc-hot{position:absolute;transform:translate(-50%,-50%);border:0;padding:0;
  background:none;cursor:pointer;border-radius:var(--r-sm);
  width:var(--hw,44px);height:var(--hh,44px);min-width:24px;min-height:24px}
.gc-hot::after{content:"";position:absolute;inset:0;border-radius:inherit;
  background:rgba(30,128,193,.10);border:1.5px dashed rgba(30,128,193,.65);
  transition:background .15s ease,border-color .15s ease}
.gc-hot:hover::after,.gc-hot:focus-visible::after{
  background:rgba(30,128,193,.22);border-color:var(--primary)}
.gc-hot:focus-visible{outline:none}
.gc-fighint{display:flex;align-items:center;gap:7px;margin-top:12px;
  font-size:11px;line-height:16px;color:var(--faint);letter-spacing:.02em}

/* ══════════════ 枢纽级区块（枢纽指引 / 实况指引 / 备注） ══════════════ */
.gc-hub-sec{margin-top:28px}
.gc-hub-sec__t{display:flex;align-items:center;gap:8px;margin:0 0 12px;
  font-size:16px;font-weight:600;line-height:23px;letter-spacing:-.01em}
.gc-hub-sec__t::before{content:"";flex:none;width:4px;height:16px;
  border-radius:2px;background:var(--primary)}
.gc-placeholder{border:1.5px dashed #cbd5e1;border-radius:var(--r-md);
  color:var(--faint);text-align:center;padding:24px;font-size:13px;line-height:20px;
  background:var(--surface)}
.gc-hub-fig{width:100%;height:auto;display:block;border-radius:var(--r-md);
  background:var(--surface);border:1px solid var(--line)}
.gc-hub-video{width:100%;max-width:100%;display:block;border-radius:var(--r-md);
  background:#0f172a}
.gc-hub-video__note{margin-top:8px;font-size:12px;line-height:18px;color:var(--sub)}

/* 实况指引：视频入口卡片 + 居中弹层 */
.gc-video-entry{display:flex;align-items:center;gap:12px;width:100%;margin-top:14px;
  padding:14px 16px;border:1px solid var(--line);border-radius:var(--r-md);
  background:var(--surface);cursor:pointer;font:inherit;text-align:left;
  transition:border-color .15s ease, box-shadow .15s ease}
.gc-video-entry:hover{border-color:var(--primary);box-shadow:var(--shadow-card)}
.gc-video-entry__icon{flex:none;width:34px;height:34px;border-radius:50%;
  background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;
  font-size:13px;padding-left:2px}
.gc-video-entry__t{font-size:14px;font-weight:600;color:var(--ink)}
.gc-video-entry__n{font-size:12px;color:var(--sub);margin-left:auto;text-align:right}
.gc-video-layer{position:fixed;inset:0;z-index:95;background:rgba(15,23,42,.72);
  display:flex;align-items:center;justify-content:center;padding:20px}
.gc-video-layer__box{position:relative;max-width:min(920px,94vw);width:100%}
.gc-video-layer__video{width:100%;max-height:84vh;display:block;border-radius:var(--r-md);
  background:#0f172a}
.gc-video-layer__x{position:absolute;top:-14px;right:-14px;z-index:1;width:34px;height:34px;
  border-radius:50%;border:0;background:var(--surface);color:var(--ink);font-size:14px;
  cursor:pointer;box-shadow:var(--shadow-hover)}

/* 备注富文本排版 */
.gc-remark{font-size:14px;line-height:1.75;color:var(--ink-2)}
.gc-remark p{margin:0 0 10px}
.gc-remark ul,.gc-remark ol{margin:0 0 10px;padding-left:22px}
.gc-remark li{margin-bottom:4px}
.gc-remark img{max-width:100%;height:auto;border-radius:var(--r-sm)}
.gc-remark a{color:var(--primary);text-decoration:none}
.gc-remark a:hover{text-decoration:underline}

/* ══════════════ 弹出详情 / 提示 ══════════════ */
.gc-pop{position:fixed;z-index:80;max-width:296px;background:var(--surface);
  border-radius:var(--r-card);box-shadow:var(--shadow-hover);
  border:1px solid var(--line);padding:15px 17px}
.gc-pop__t{font-size:15px;font-weight:600;line-height:21px;margin-bottom:5px;
  padding-right:18px}
.gc-pop__b{font-size:13px;line-height:20px;color:var(--ink-2)}
.gc-pop__links{display:flex;flex-direction:column;gap:7px;margin-top:11px}
.gc-pop__links a{font-size:13px;font-weight:600;color:var(--primary);
  text-decoration:none;display:inline-flex;align-items:center;gap:5px;min-height:26px}
.gc-pop__links a:hover{text-decoration:underline}
.gc-pop__x{position:absolute;top:9px;right:9px;border:0;background:none;cursor:pointer;
  color:var(--faint);font-size:15px;line-height:1;padding:5px}
.gc-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:90;
  background:rgba(15,23,42,.92);color:#fff;font-size:13px;font-weight:500;
  padding:10px 18px;border-radius:999px;box-shadow:var(--shadow-hover);
  max-width:86vw;text-align:center}

/* ══════════════ 手机 ══════════════ */
@media screen and (max-width:640px){
  .gc-card{padding:18px;border-radius:var(--r-md)}
  .gc-origin__name{font-size:16px;line-height:23px}
  .gc-stop__name{font-size:15px;line-height:22px}
  .gc-hub-sec{margin-top:22px}
}

/* ══════════════ 打印 / PDF ══════════════
 * 屏幕 UI 包在 #gc-screen 里；.gc-print-root 由 buildPrintRoot 离屏构建、
 * viewer append 一次。打印时隐藏屏幕树、显示打印树，版式：A4 纵向，
 * 标题页单独一页，之后每个枢纽一页起，卡片双列。 */
.gc-print-root{display:none}
@page{size:A4;margin:12mm}
@media print{
  #gc-screen,.gc-pop,.gc-toast,.gc-fighint,.gc-video-entry,.gc-video-layer{display:none!important}
  body{background:#fff}
  .gc-print-root{display:block!important;color:#0f172a}

  /* 标题页：标题 + 版本行 + 枢纽 × 校区路线数矩阵 */
  .gc-print-title{break-after:page;page-break-after:always;padding-top:20mm}
  .gc-print-title__t{margin:0;font-size:34px;font-weight:700;line-height:42px;
    letter-spacing:-.02em}
  .gc-print-title__s{font-size:20px;font-weight:500;line-height:30px;
    color:#334155;margin-top:4mm}
  .gc-print-title__e{font-size:12px;line-height:18px;color:#64748b;margin-top:6mm;
    padding-bottom:8mm;border-bottom:2px solid #1e80c1}
  .gc-print-matrix__cap{font-size:13px;font-weight:600;margin:12mm 0 4mm}
  .gc-print-matrix{border-collapse:collapse;width:100%}
  .gc-print-matrix th,.gc-print-matrix td{border:1px solid #cbd5e1;
    padding:5px 8px;font-size:11px;line-height:16px;text-align:center}
  .gc-print-matrix th{background:#f1f5f9;font-weight:600}
  .gc-print-matrix__hub{text-align:left;font-weight:600}

  /* 每个枢纽一页起（紧跟标题页的第一个枢纽不再强制分页） */
  .gc-print-hub{break-before:page;page-break-before:always}
  .gc-print-title+.gc-print-hub{break-before:auto;page-break-before:auto}
  .gc-print-hubband{color:#fff;padding:8px 14px;border-radius:8px;
    font-size:16px;font-weight:600;line-height:22px;margin-bottom:5mm;
    print-color-adjust:exact;-webkit-print-color-adjust:exact}
  .gc-print-hubband__note{font-size:11px;font-weight:500;opacity:.85;margin-left:8px}
  .gc-print-subhead{font-size:13px;font-weight:600;line-height:19px;
    margin:5mm 0 3mm;break-after:avoid;page-break-after:avoid}
  .gc-print-root .gc-hub-sec{margin-top:0;margin-bottom:5mm}
  .gc-print-root .gc-hub-sec__t{font-size:13px;margin-bottom:3mm}
  .gc-print-root .gc-remark{font-size:11px}

  /* 卡片双列 */
  .gc-print-cards{column-count:2;column-gap:6mm}
  .gc-print-cards>.gc-card{break-inside:avoid;page-break-inside:avoid;
    margin:0 0 4mm}
  .gc-print-root .gc-card{box-shadow:none;border:1px solid #d8dde3;
    border-radius:8px;padding:12px 13px;transform:none}
  .gc-print-root .gc-card:hover{transform:none;box-shadow:none}

  /* 窄栏字号整体收一档，卡片才不会在 A4 半栏里溢出 */
  .gc-print-root .gc-origin__name{font-size:14px;line-height:20px}
  .gc-print-root .gc-origin__note{font-size:10px;line-height:14px}
  .gc-print-root .gc-card-chips{margin-bottom:8px;padding-bottom:8px;gap:6px}
  .gc-print-root .gc-dest-chip{font-size:10px;line-height:15px;padding:2px 8px}
  .gc-print-root .gc-mode-badge{font-size:10px;line-height:15px;padding:2px 9px}
  .gc-print-root .gc-meta-chip{font-size:10px;line-height:15px;padding:2px 8px}
  .gc-print-root .gc-flag{font-size:9px;line-height:14px;padding:2px 7px}
  .gc-print-root .gc-stop__name{font-size:13px;line-height:19px}
  .gc-print-root .gc-stop__exit{font-size:10px;line-height:14px}
  .gc-print-root .gc-leg{grid-template-columns:30px minmax(0,1fr)}
  .gc-print-root .gc-body{padding:1px 0 7px}
  .gc-print-root .gc-walk,.gc-print-root .gc-lnote{font-size:10px;line-height:15px}
  .gc-print-root .gc-toward-t,.gc-print-root .gc-suffix,
  .gc-print-root .gc-busline{font-size:11px;line-height:16px}
  .gc-print-root .gc-lnum{font-size:11px;line-height:16px}
  .gc-print-root .gc-note{font-size:10px;line-height:15px}
  .gc-print-root .gc-sched__t,.gc-print-root .gc-sched__row{font-size:10px}
  .gc-print-root .gc-figcard__t{font-size:14px;line-height:20px}
  .gc-print-root .gc-figcard__cap{font-size:10px;line-height:15px;margin:6px 0 8px}
  .gc-print-root .gc-steps__intro,.gc-print-root .gc-step{font-size:11px;line-height:17px}
  .gc-print-root .gc-sec__t{font-size:12px;line-height:18px}

  /* 打印不出现交互元素与空态提示 */
  .gc-print-root .gc-hot{display:none}
  .gc-print-root .gc-empty{display:none}

  /* 线路徽标与色带保留颜色 */
  .gc-lnum,.gc-busline,.gc-mode-badge,.gc-dest-chip,.gc-meta-chip,.gc-flag,
  .gc-sched__t,.gc-gutter .ln,.gc-gutter .dot,.gc-gutter .cx,
  .gc-print-matrix th,.gc-steps__intro,.gc-pending{
    print-color-adjust:exact;-webkit-print-color-adjust:exact}
}
`;
(function inject(){
  if (document.getElementById('guide-css')) return;
  var el = document.createElement('style');
  el.id = 'guide-css';
  el.textContent = window.GUIDE_CSS;
  document.head.appendChild(el);
})();

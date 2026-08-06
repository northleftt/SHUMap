/*
 * guide-styles.js — 返校指南电子版样式单一来源（卡片流架构）
 *
 * 为什么 CSS 放在 JS 里：前台页 / 编辑器 / 导出渲染三个出口共用同一份样式，
 * 且单卡片 PNG 导出需要把样式内联进 <foreignObject>。放在 JS 字符串里，
 * file:// 直接打开时也能拿到完整 cssText，不依赖 fetch 或 CORS。
 *
 * 架构：原子卡片（一卡一条路线）纵向堆叠成长页面，不再受 A4 单页高度约束。
 * 每张卡片可独立导出 PNG；打印时按卡片分页，不切断卡片内部。
 */
window.GUIDE_CSS = String.raw`
:root{
  /* —— 继承 SHUMap src/index.css 设计令牌 —— */
  --primary:#1e80c1; --primary-pressed:#125b8b; --primary-container:#e8f1f8;
  --page:#f5f6f8; --surface:#ffffff; --ink:#0f172a; --sub:#94a3b8; --line:#e8ebef;
  --chip:#f1f3f6; --track:#eef1f4;
  --success:#16a34a; --warning:#f59e0b; --error:#dc2626;

  /* —— 指南版式专用 —— */
  --card:#f0f1f3;          /* 原稿灰底圆角卡 */
  --card-ink:#2b3440;
  --seg-neutral:#8f98a3;
  --seg-walk:#b9bfc7;
  --dot:#465060;

  /* 上海轨道交通线路色 */
  --l1:#e4002b; --l2:#8cc63e; --l3:#ffd100; --l4:#5b2d8e; --l7:#f3901d;
  --l9:#71c5e8; --l10:#c1a2ca; --l11:#871c2b; --l17:#bc8b5e;
  --bus:#f2b203; --bus-ink:#8f6400;

  --font-sans:"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif;
  --font-mono:"SF Mono",ui-monospace,"JetBrains Mono",Menlo,monospace;

  /* 卡片宽度是唯一的版式基准：导出 PNG 时 2 倍 = 1560px，适合公众号/小红书 */
  --card-w:780px;
  --card-pad:26px;

  --r-sm:8px; --r-md:11px; --r-lg:12px; --r-xl:14px; --r-2xl:18px; --r-3xl:22px;
  --shadow-card:0 2px 10px rgba(15,23,42,.07);
  --shadow-lift:0 8px 24px rgba(15,23,42,.13);
}

*{box-sizing:border-box}
body{margin:0;font-family:var(--font-sans);color:var(--ink);background:var(--page);
  -webkit-font-smoothing:antialiased}

/* ══════════════ 卡片流舞台 ══════════════
 * --flow-w 是内容区宽度：单列时等于卡片宽（780px），双列时放宽到 1240px，
 * 卡片改由栅格决定宽度。窄屏用媒体查询把双列强制压回单列 —— 780px 的卡片
 * 塞进 390px 的栏里会把时间轴挤变形。 */
.gc-flow{display:flex;flex-direction:column;align-items:center;gap:20px;
  padding:24px 16px 96px;--flow-w:var(--card-w)}
.gc-group{width:100%;max-width:var(--flow-w);display:flex;flex-direction:column;gap:20px}
.gc-group__cards{display:grid;gap:20px;grid-template-columns:minmax(0,1fr)}
.gc-group__cards>*{max-width:none}

.gc-flow[data-cols="2"]{--flow-w:1240px}
.gc-flow[data-cols="2"] .gc-group__cards{grid-template-columns:repeat(2,minmax(0,1fr))}
/* 长文卡片（实景指引 / 附表）跨两列：窄栏里逐条步骤会折得太碎 */
.gc-flow[data-cols="2"] .gc-group__cards>.gc-card--steps{grid-column:1/-1}
/* 必须限定 screen：A4 打印宽度约 794px，会命中任何 max-width 断点，
   否则打印时双列被压回单列 —— 那不是想要的导出版式。 */
@media screen and (max-width:1180px){
  .gc-flow[data-cols="2"]{--flow-w:var(--card-w)}
  .gc-flow[data-cols="2"] .gc-group__cards{grid-template-columns:minmax(0,1fr)}
}

/* 目录卡片默认只给打印用：屏幕上走 .gc-pick 选择器。
   编辑器要预览目录版式，传 showCover 换成 data-cover="both"。 */
.gc-flow[data-cover="print"] .gc-cover{display:none}

.gc-empty{width:100%;max-width:var(--card-w);text-align:center;padding:56px 20px;
  font-size:14px;line-height:21px;color:var(--sub);letter-spacing:.02em;
  background:var(--surface);border:1px dashed var(--line);border-radius:var(--r-2xl)}
.gc-grouphead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;
  padding:16px 2px 0}
.gc-grouphead__t{font-size:19px;font-weight:600;line-height:26px;letter-spacing:-.01em}
.gc-grouphead__n{font-size:12px;line-height:17px;color:var(--sub);letter-spacing:.02em}
.gc-grouphead__rule{flex:1;height:1px;background:var(--line);min-width:24px}

/* ══════════════ 原子卡片 ══════════════ */
.gc-card{width:100%;max-width:var(--card-w);background:var(--surface);
  border:1px solid var(--line);border-radius:var(--r-3xl);padding:var(--card-pad);
  box-shadow:var(--shadow-card);position:relative;
  break-inside:avoid;page-break-inside:avoid}
.gc-card[data-dim="1"]{opacity:.3;filter:saturate(.4)}

/* 卡片头：枢纽名 + 括注 + 去往标签 —— 沿用原稿页眉语言 */
.gc-card__head{display:flex;align-items:flex-start;justify-content:space-between;
  gap:16px;margin-bottom:4px}
.gc-hub{display:flex;align-items:baseline;flex-wrap:wrap;gap:5px 8px;min-width:0}
.gc-hub__name{font-size:21px;font-weight:600;line-height:29px;letter-spacing:-.01em}
.gc-hub__note{font-size:12px;font-weight:500;line-height:17px;color:#3b4552;
  letter-spacing:.01em}
.gc-toward{display:inline-block;background:var(--primary);color:#fff;font-size:14px;
  font-weight:600;line-height:20px;padding:3px 12px;letter-spacing:.03em;
  border-radius:3px;white-space:nowrap}
.gc-mark{flex:none;width:104px;padding-top:3px}
.gc-mark svg{width:100%;height:auto;display:block}

/* 卡片计量行：出行方式徽章 + 耗时票价 */
.gc-card__meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  margin:14px 0 16px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.gc-mode{font-size:13px;font-weight:600;line-height:19px;padding:3px 14px;
  border-radius:999px;letter-spacing:.04em;white-space:nowrap}
.gc-mode[data-mode="metro"]{background:#7b1226;color:#fff}
.gc-mode[data-mode="bus"]{background:var(--bus);color:#3d2c00}
.gc-mode[data-mode="rail"]{background:var(--primary);color:#fff}
.gc-mode[data-mode="mixed"]{background:#4b5563;color:#fff}
/* 磁浮 / 市域机场线：原稿给了各自的专色，徽章跟着走，
   不然它们会和地铁方案撞成同一个深红，看不出是另一种交通工具。 */
.gc-mode[data-mode="maglev"]{background:#ee7b23;color:#3d2200}
.gc-mode[data-mode="airport"]{background:#35689f;color:#fff}
.gc-mode[data-mode="other"]{background:#4b5563;color:#fff}
.gc-stat{font-size:15px;font-weight:600;line-height:21px;color:var(--card-ink);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.gc-stat span{font-size:12px;font-weight:500;color:#68727e;letter-spacing:.02em}
.gc-flag{font-size:11px;font-weight:600;line-height:16px;letter-spacing:.04em;
  color:var(--primary-pressed);background:var(--primary-container);
  padding:3px 9px;border-radius:999px;white-space:nowrap}
.gc-spacer{flex:1}

/* ══════════════ 图标（来自图标库，按 id 引用） ══════════════ */
/* 统一的图标盒子：内联 SVG 或 data URI 都撑满它，随字号缩放。
   inline-flex + align-items:center 让它和同行文字的基线看起来齐平。 */
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
.gc-stop__exit{font-size:11px;font-weight:500;line-height:16px;color:#4d5865;
  letter-spacing:.02em}
.gc-walk{font-size:12px;line-height:17px;color:#68727e;letter-spacing:.03em;
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
.gc-note{font-size:11px;line-height:16px;color:#5b6573;letter-spacing:.02em}
.gc-notes{display:flex;flex-direction:column;gap:2px;margin-top:2px}

/* 终点强调：把"到了"这件事做成视觉落点 */
.gc-leg[data-terminal="1"] .gc-stop__name{color:var(--primary-pressed)}
.gc-leg[data-terminal="1"] .gc-gutter .dot{background:var(--primary);
  width:13px;height:13px;transform:translate(-6.5px,-6.5px)}

/* ══════════════ 步骤卡片（实景指引 / 附表教程） ══════════════
 * 原稿这两类页面不是时间轴，而是「配图 + 编号说明」。这里只排文字层：
 * 照片是版权素材，随原稿走，先把步骤文字和读图方法立起来。 */
.gc-steps{display:flex;flex-direction:column;gap:16px}
.gc-steps__intro{font-size:13px;line-height:21px;color:#3b4552;letter-spacing:.01em;
  background:var(--chip);border-radius:var(--r-md);padding:12px 14px}
.gc-sec__t{display:flex;align-items:center;gap:7px;margin:0 0 8px;
  font-size:15px;font-weight:600;line-height:21px;letter-spacing:-.01em}
.gc-sec__dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--c,var(--primary))}
.gc-sec__list{margin:0;padding:0 0 0 22px;display:flex;flex-direction:column;gap:7px}
.gc-sec__list:not(ol){padding-left:0}
.gc-step{font-size:13px;line-height:20px;color:#20293a;letter-spacing:.01em}
.gc-step::marker{color:var(--primary);font-weight:600}
.gc-step__t{display:block}
.gc-step__n{display:block;font-size:11px;line-height:16px;color:#68727e;margin-top:1px}
.gc-pending{display:flex;flex-direction:column;gap:3px;padding:11px 13px;
  border:1px dashed var(--warning);border-radius:var(--r-md);background:#fffbeb}
.gc-pending__l{font-size:12px;font-weight:600;line-height:17px;color:#92400e;
  letter-spacing:.02em}
.gc-pending__d{font-size:11px;line-height:17px;color:#6b5228;letter-spacing:.01em}

/* ══════════════ 出发点选择器（屏幕首屏） ══════════════ */
.gc-pick{width:100%;max-width:var(--flow-w);background:var(--surface);
  border:1px solid var(--line);border-radius:var(--r-3xl);padding:26px var(--card-pad);
  box-shadow:var(--shadow-card)}
.gc-pick__head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.gc-pick__t1{font-size:27px;font-weight:600;line-height:35px;letter-spacing:-.025em}
.gc-pick__t2{font-size:17px;font-weight:500;line-height:25px;letter-spacing:-.01em;
  color:#3b4552}
.gc-pick__lead{font-size:14px;font-weight:600;line-height:20px;letter-spacing:-.01em;
  margin:16px 0 14px;padding-top:14px;border-top:1px solid var(--line)}
.gc-pick__grid{display:grid;gap:16px 20px;
  grid-template-columns:repeat(auto-fit,minmax(232px,1fr))}
.gc-pick__hubN{display:flex;align-items:center;gap:8px;margin:0 0 3px;
  font-size:16px;font-weight:600;line-height:23px;letter-spacing:-.01em}
.gc-pick__hubNote{font-size:11px;line-height:16px;color:#68727e;margin:0 0 8px 20px}
.gc-pick__chips{display:flex;flex-wrap:wrap;gap:7px;margin-left:20px}
.gc-pick__chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);
  background:var(--surface);font:inherit;color:var(--ink);cursor:pointer;
  border-radius:999px;padding:7px 13px;min-height:38px}
.gc-pick__chip:hover{border-color:var(--primary);background:var(--primary-container)}
.gc-pick__chipL{font-size:13px;font-weight:600;line-height:19px}
.gc-pick__chipN{font-size:11px;font-weight:600;line-height:16px;color:#68727e;
  font-variant-numeric:tabular-nums}
.gc-pick__chip:hover .gc-pick__chipN{color:var(--primary-pressed)}

/* ══════════════ 浏览目录（抽屉） ══════════════ */
.gc-tocwrap{position:fixed;inset:0;z-index:70;display:none}
.gc-tocwrap[data-open="1"]{display:block}
.gc-tocwrap__veil{position:absolute;inset:0;background:rgba(15,23,42,.34)}
.gc-tocpanel{position:absolute;top:0;bottom:0;left:0;width:min(320px,86vw);
  background:var(--surface);box-shadow:var(--shadow-lift);display:flex;
  flex-direction:column;overflow:hidden}
.gc-tocpanel__h{display:flex;align-items:center;gap:8px;padding:14px 16px;
  border-bottom:1px solid var(--line)}
.gc-tocpanel__t{font-size:15px;font-weight:600;letter-spacing:-.01em}
.gc-toc{flex:1;overflow-y:auto;padding:12px 12px 32px}
.gc-toc__hub{margin-bottom:14px}
.gc-toc__hubN{display:flex;align-items:center;gap:8px;padding:0 4px 6px;
  font-size:13px;font-weight:600;line-height:19px;color:#3b4552}
.gc-toc__items{display:flex;flex-direction:column;gap:2px}
.gc-toc__item{display:flex;align-items:center;gap:8px;width:100%;border:0;
  background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;
  border-radius:var(--r-sm);padding:9px 10px;min-height:40px}
.gc-toc__item:hover{background:var(--chip)}
.gc-toc__item[aria-current="true"]{background:var(--primary-container);
  color:var(--primary-pressed);font-weight:600}
.gc-toc__label{flex:1;font-size:13px;line-height:19px}
.gc-toc__n{font-size:11px;font-weight:600;color:#8b949f;font-variant-numeric:tabular-nums}

/* ══════════════ 顶部二维 Tab（枢纽 × 校区） ══════════════ */
.gc-dims{display:flex;flex-direction:column;gap:6px;padding:0 16px 10px}
.gc-dim{display:flex;align-items:center;gap:8px;min-width:0}
.gc-dim__l{flex:none;font-size:11px;font-weight:600;letter-spacing:.06em;color:#8b949f}
.gc-dim__row{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:1px 0}
.gc-dim__row::-webkit-scrollbar{display:none}

/* ══════════════ 图示卡片（原稿真图 + 热区） ══════════════ */
.gc-figcard{width:100%;max-width:var(--card-w);background:var(--surface);
  border:1px solid var(--line);border-radius:var(--r-3xl);padding:var(--card-pad);
  box-shadow:var(--shadow-card);break-inside:avoid;page-break-inside:avoid}
.gc-figcard__head{display:flex;align-items:baseline;gap:10px;margin-bottom:4px}
.gc-figcard__t{font-size:19px;font-weight:600;line-height:26px;letter-spacing:-.01em;
  padding-bottom:3px;border-bottom:3px solid var(--primary)}
.gc-figcard__cap{font-size:12px;line-height:17px;color:#5b6573;letter-spacing:.02em;
  margin:10px 0 14px}
.gc-figwrap{position:relative;background:var(--card);border-radius:var(--r-2xl);
  overflow:hidden;line-height:0}
.gc-figwrap img{width:100%;height:auto;display:block}

/* 热区：绝对定位在真图之上，坐标用百分比所以随图缩放 */
.gc-hot{position:absolute;transform:translate(-50%,-50%);border:0;padding:0;
  background:none;cursor:pointer;border-radius:50%;
  width:var(--hw,44px);height:var(--hh,44px);min-width:32px;min-height:32px}
.gc-hot::after{content:"";position:absolute;inset:0;border-radius:inherit;
  background:rgba(30,128,193,.14);border:2px solid var(--primary);
  opacity:0;transition:opacity .15s ease}
.gc-hot:hover::after,.gc-hot:focus-visible::after{opacity:1}
.gc-hot:focus-visible{outline:none}
.gc-figwrap[data-reveal="1"] .gc-hot::after{opacity:.55}
.gc-hot__pin{position:absolute;top:50%;left:50%;width:9px;height:9px;
  border-radius:50%;background:var(--primary);border:2px solid #fff;
  transform:translate(-50%,-50%);box-shadow:0 1px 4px rgba(15,23,42,.35);
  opacity:0;transition:opacity .15s ease}
.gc-figwrap[data-reveal="1"] .gc-hot__pin{opacity:1}
.gc-fighint{display:flex;align-items:center;gap:7px;margin-top:12px;
  font-size:11px;line-height:16px;color:var(--sub);letter-spacing:.02em}

/* ══════════════ 目录卡片 ══════════════ */
.gc-cover{width:100%;max-width:var(--card-w);background:var(--surface);
  border:1px solid var(--line);border-radius:var(--r-3xl);padding:34px var(--card-pad) 28px;
  box-shadow:var(--shadow-card);position:relative;overflow:hidden;
  break-inside:avoid;page-break-inside:avoid}
.gc-cover>*{position:relative;z-index:1}
/* 水印层必须写在 .gc-cover>* 之后：两者同为单类权重，后写者胜。
   若顺序颠倒，水印会被拉回文档流、占掉半张卡把标题推到下方。 */
.gc-cover__wm{position:absolute;inset:0;pointer-events:none;opacity:.42;z-index:0}
.gc-cover__wm svg{width:100%;height:100%;display:block}
.gc-cover__t1{font-size:40px;font-weight:600;line-height:48px;letter-spacing:-.025em}
.gc-cover__t2{font-size:26px;font-weight:500;line-height:36px;letter-spacing:-.02em}
.gc-cover__rule{height:4px;background:var(--primary);margin:12px 0 22px}
.gc-cover__lead{font-size:17px;font-weight:600;line-height:24px;letter-spacing:-.01em;
  margin-bottom:18px}
.gc-hubs{display:grid;grid-template-columns:1fr 1fr;gap:22px 20px}
.gc-hubcard{min-width:0}
.gc-hubcard__name{display:flex;align-items:center;gap:9px;font-size:19px;font-weight:600;
  line-height:26px;letter-spacing:-.01em}
.gc-swatch{flex:none;width:12px;height:19px;border-radius:2px;background:var(--c)}
.gc-hubcard__note{font-size:11px;line-height:16px;color:#4d5865;margin:2px 0 7px 21px}
.gc-entries{display:flex;flex-direction:column;gap:2px;margin-left:21px}
.gc-entry{display:grid;grid-template-columns:16px 1fr auto;align-items:center;gap:9px;
  font-size:14px;line-height:20px;background:none;border:0;padding:4px 6px 4px 0;
  text-align:left;color:inherit;font-family:inherit;border-radius:var(--r-sm);
  min-height:32px}
.gc-entry__arrow{color:#5b6573;font-size:13px}
.gc-entry__label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-entry__page{font-size:13px;font-variant-numeric:tabular-nums;color:#20293a;
  letter-spacing:.02em}
.gc-entry[data-linked="1"]{cursor:pointer}
.gc-entry[data-linked="1"]:hover{background:var(--primary-container)}
.gc-entry[data-linked="0"]{color:#98a1ac}
.gc-entry[data-linked="0"] .gc-entry__page,
.gc-entry[data-linked="0"] .gc-entry__arrow{color:#a8b0ba}
.gc-cover__foot{font-size:11px;line-height:16px;color:#7c858f;letter-spacing:.02em;
  margin-top:22px;text-align:right}

/* ══════════════ 卡片操作条（屏幕专用，导出/打印时隐藏） ══════════════ */
.gc-acts{position:absolute;top:12px;right:12px;display:flex;gap:5px;opacity:0;
  transition:opacity .15s ease;z-index:5}
.gc-card:hover .gc-acts,.gc-figcard:hover .gc-acts,
.gc-card:focus-within .gc-acts,.gc-figcard:focus-within .gc-acts{opacity:1}
.gc-act{border:1px solid var(--line);background:rgba(255,255,255,.96);font:inherit;
  font-size:11px;font-weight:600;color:#4d5865;border-radius:var(--r-sm);
  padding:5px 9px;cursor:pointer;min-height:28px;letter-spacing:.02em;
  box-shadow:0 1px 3px rgba(15,23,42,.1)}
.gc-act:hover{border-color:var(--primary);color:var(--primary)}
.gc-act--danger:hover{border-color:var(--error);color:var(--error)}
.gc-act[disabled]{opacity:.35;cursor:not-allowed}

/* ══════════════ 顶部外壳 ══════════════ */
.gc-chrome{position:sticky;top:0;z-index:40;background:rgba(255,255,255,.93);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  border-bottom:1px solid var(--line)}
.gc-chrome__row{display:flex;align-items:center;gap:10px;padding:10px 16px;flex-wrap:wrap}
.gc-brand{font-size:15px;font-weight:600;letter-spacing:-.01em}
.gc-brand span{color:var(--sub);font-weight:500;font-size:12px;letter-spacing:.02em}
/* 内容来源徽标：只在回落到离线稿时出现。正式内容不显示任何标记 ——
   一切正常时不该有多余的装饰去分散注意力。 */
.gc-srcbadge{font-size:11px;font-weight:600;line-height:16px;letter-spacing:.04em;
  padding:2px 8px;border-radius:999px;white-space:nowrap;
  color:#92400e;background:#fef3c7;border:1px solid #fcd34d}
.gc-srcbadge[data-tone="err"]{color:#991b1b;background:#fee2e2;border-color:#fca5a5}
.gc-seg{display:flex;background:var(--chip);border-radius:999px;padding:3px;gap:2px}
.gc-seg button{border:0;background:none;font:inherit;font-size:13px;font-weight:600;
  color:#5b6573;padding:6px 14px;border-radius:999px;cursor:pointer;min-height:34px}
.gc-seg button[aria-pressed="true"]{background:var(--surface);color:var(--primary);
  box-shadow:0 1px 3px rgba(15,23,42,.12)}
.gc-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);
  background:var(--surface);color:var(--ink);font:inherit;font-size:13px;font-weight:600;
  padding:8px 14px;border-radius:var(--r-md);cursor:pointer;min-height:38px;
  text-decoration:none;box-shadow:0 1px 2px rgba(15,23,42,.06)}
.gc-btn:hover{border-color:#cfd6de;background:#fbfcfd}
.gc-btn:active{transform:translateY(1px)}
.gc-btn--primary{background:var(--primary);border-color:var(--primary);color:#fff;
  box-shadow:0 2px 6px rgba(30,128,193,.3)}
.gc-btn--primary:hover{background:var(--primary-pressed);border-color:var(--primary-pressed)}
/* 方形图标按钮：目录抽屉的开关。padding 收成正方，触控区仍有 38px */
.gc-btn--icon{padding:8px 11px;font-size:15px;line-height:20px}
/* 工具开关只在手机出现；桌面上筛选与工具直接排在顶栏里 */
.gc-btn--tools{display:none}
/* 桌面：tools 容器不参与布局，子元素直接进顶栏的 flex 流 */
.gc-chrome__tools{display:contents}
.gc-tabs{display:flex;gap:6px;overflow-x:auto;padding:0 16px 10px;scrollbar-width:none}
.gc-tabs::-webkit-scrollbar{display:none}
.gc-tab{border:1px solid var(--line);background:var(--surface);font:inherit;font-size:13px;
  font-weight:600;color:#4d5865;padding:7px 13px;border-radius:999px;cursor:pointer;
  white-space:nowrap;min-height:34px}
.gc-tab[aria-selected="true"]{background:var(--primary-container);border-color:var(--primary);
  color:var(--primary-pressed)}

/* 弹出详情 */
.gc-pop{position:fixed;z-index:80;max-width:296px;background:var(--surface);
  border-radius:var(--r-xl);box-shadow:var(--shadow-lift);border:1px solid var(--line);
  padding:15px 17px}
.gc-pop__t{font-size:15px;font-weight:600;line-height:21px;margin-bottom:5px;
  padding-right:18px}
.gc-pop__b{font-size:13px;line-height:20px;color:#4d5865}
.gc-pop__links{display:flex;flex-direction:column;gap:7px;margin-top:11px}
.gc-pop__links a{font-size:13px;font-weight:600;color:var(--primary);text-decoration:none;
  display:inline-flex;align-items:center;gap:5px;min-height:26px}
.gc-pop__links a:hover{text-decoration:underline}
.gc-pop__x{position:absolute;top:9px;right:9px;border:0;background:none;cursor:pointer;
  color:var(--sub);font-size:15px;line-height:1;padding:5px}
.gc-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:90;
  background:rgba(15,23,42,.92);color:#fff;font-size:13px;font-weight:500;padding:10px 18px;
  border-radius:999px;box-shadow:var(--shadow-lift);max-width:86vw;text-align:center}

/* ══════════════ 手机 ══════════════
 * 小屏一律单列：780px 的卡片塞进半个手机屏会把时间轴挤变形。
 * 这里用 !important 压过 data-cols="2"，因为列数是外壳按屏宽算出来的，
 * 但用户可能在窄窗口手动选了双列。 */
/* 必须限定 screen：A4 纵向正文宽约 794px，会命中 max-width:820px。
   不限定的话打印时手机规则也生效 —— 目录塌成单列、卡片被迫单列，
   导出的 PDF 版式就和原稿不一样了。 */
@media screen and (max-width:820px){
  :root{--card-pad:18px}
  .gc-flow{padding:14px 10px 72px;gap:14px}
  .gc-group{gap:14px}
  .gc-flow[data-cols="2"] .gc-group__cards{grid-template-columns:minmax(0,1fr)!important}
  .gc-group__cards{gap:14px}
  .gc-card,.gc-figcard,.gc-cover,.gc-pick{border-radius:var(--r-2xl)}
  .gc-hubs{grid-template-columns:1fr}
  .gc-card__head{flex-direction:column-reverse;align-items:flex-start;gap:8px}
  .gc-mark{width:88px}
  .gc-cover__t1{font-size:30px;line-height:38px}
  .gc-cover__t2{font-size:20px;line-height:29px}
  .gc-entry{min-height:44px}
  .gc-acts{opacity:1;position:static;justify-content:flex-end;margin-bottom:10px}

  .gc-pick{padding:20px 18px}
  .gc-pick__t1{font-size:22px;line-height:30px}
  .gc-pick__t2{font-size:15px;line-height:22px}
  .gc-pick__grid{grid-template-columns:1fr;gap:14px}
  .gc-pick__chip{min-height:42px}
  .gc-dims{padding:0 12px 8px}

  /* 顶栏收腰：手机上筛选与五个工具按钮全展开会占掉三分之一屏。
     收成「目录 + 品牌 + ⚙」一排，其余进 ⚙ 展开的整行。 */
  .gc-chrome__row{padding:8px 12px;gap:8px}
  .gc-btn--tools{display:inline-flex}
  .gc-chrome__tools{display:none;flex-basis:100%;flex-wrap:wrap;gap:8px;padding-top:2px}
  .gc-chrome__tools[data-open="1"]{display:flex}
  /* 枢纽/校区两排 Tab 右缘淡出，给出「还能往左滑」的提示 */
  .gc-dim__row{mask-image:linear-gradient(90deg,#000 88%,transparent);
    -webkit-mask-image:linear-gradient(90deg,#000 88%,transparent)}
}

/* ══════════════ 打印 / PDF ══════════════
 * 版式回到原稿：目录单独一页在前，之后每个卡片组内部左右双列
 * —— 原稿每页就是「地铁一列 / 公交一列」并排，双列是还原而不是新样式。
 * A4 正文宽 190mm ≈ 718px，两列各约 345px，与原稿单列 250pt 同一量级，
 * 所以这里同时把内边距和字号收一档，避免站名换行。 */
@page{size:A4 portrait;margin:12mm 10mm}
@media print{
  .gc-chrome,.gc-pop,.gc-toast,.gc-acts,.gc-fighint,.gc-noprint,
  .gc-pick,.gc-tocwrap,.ge-panel,.ge-top{display:none!important}
  body{background:#fff}
  .gc-flow{padding:0;gap:0;--flow-w:none}
  .gc-group{max-width:none;gap:10px;margin-bottom:10px;
    break-inside:auto;page-break-inside:auto}

  /* 小标题不能单独留在页尾：break-after:avoid 让它跟着下面的卡片走。
     组本身允许跨页（长组必须能断），但「标题 + 第一张卡」得在一起。 */
  .gc-grouphead{break-after:avoid;page-break-after:avoid;
    break-inside:avoid;page-break-inside:avoid}

  /* 目录：屏幕上隐藏，打印时必须回来 —— 它就是原稿第 0 页 */
  .gc-flow[data-cover="print"] .gc-cover{display:block!important}
  .gc-cover{break-after:page;page-break-after:always;max-width:none;
    box-shadow:none;border-color:#d8dde3}

  /* 双列栅格。打印时不受屏宽媒体查询影响，强制两列 */
  .gc-group__cards{display:grid!important;
    grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px 10px!important}
  .gc-group__cards>.gc-card--steps{grid-column:1/-1}

  .gc-card,.gc-figcard{max-width:none;box-shadow:none;border-color:#d8dde3;
    margin:0;padding:13px 14px;border-radius:10px}
  .gc-card[data-dim="1"]{opacity:1;filter:none}

  /* 窄栏字号：整体收一档，卡片才不会在 A4 半栏里溢出 */
  .gc-hub__name{font-size:16px;line-height:22px}
  .gc-hub__note{font-size:10px;line-height:14px}
  .gc-toward{font-size:11px;line-height:16px;padding:2px 8px}
  .gc-mark{width:66px}
  .gc-card__meta{margin:9px 0 10px;padding-bottom:9px;gap:7px}
  .gc-mode{font-size:11px;line-height:16px;padding:2px 10px}
  .gc-stat{font-size:12px;line-height:17px}
  .gc-stop__name{font-size:13px;line-height:19px}
  .gc-stop__exit{font-size:10px;line-height:14px}
  .gc-leg{grid-template-columns:30px minmax(0,1fr)}
  .gc-body{padding:1px 0 7px}
  .gc-walk,.gc-note{font-size:10px;line-height:15px}
  .gc-toward-t,.gc-suffix,.gc-busline{font-size:11px;line-height:16px}
  .gc-lnum{font-size:11px;line-height:16px}
  .gc-grouphead{padding:8px 2px 0}
  .gc-grouphead__t{font-size:15px;line-height:21px}
  .gc-grouphead__n{font-size:10px;line-height:14px}
  .gc-figcard__t{font-size:15px;line-height:21px}
  .gc-figcard__cap{font-size:10px;line-height:15px;margin:7px 0 10px}
  .gc-steps__intro,.gc-step{font-size:11px;line-height:17px}
  .gc-sec__t{font-size:13px;line-height:19px}

  .gc-figwrap[data-reveal="1"] .gc-hot::after,
  .gc-figwrap[data-reveal="1"] .gc-hot__pin{opacity:0}
  .gc-empty{display:none}
}
`;
(function inject(){
  if (document.getElementById('guide-css')) return;
  var el = document.createElement('style');
  el.id = 'guide-css';
  el.textContent = window.GUIDE_CSS;
  document.head.appendChild(el);
})();

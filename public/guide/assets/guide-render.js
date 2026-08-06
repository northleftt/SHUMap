/*
 * guide-render.js — 返校指南电子版共用渲染层（原子卡片架构）
 *
 * 前台展示页、可视化编辑器、导出渲染三个出口都调用这里的函数，
 * 保证「网页上看到的」「编辑器里改的」「导出成 PNG/PDF 的」是同一份代码画出来的。
 *
 * 卡片是最小单位：renderCard 输出一张自包含的卡片 DOM，可以单独导出成图。
 *
 * 对外接口（window.GuideRender）：
 *   renderCard(card, data, opts)     → 一张卡片（route / figure）
 *   renderCover(cover, data, opts)   → 目录卡片
 *   renderFlow(data, opts)           → 完整卡片流（含分组小标题）
 *   exportCardPng(cardEl, name, s)   → 单卡片 PNG 导出
 *   toast(msg) / closePop()          → 交互反馈
 *   iconList/findIcon/renderIcon    → 图标库（编辑器共用同一注册表）
 *   h / RAIL / guideMark            → 供编辑器复用的图元
 */
window.GuideRender = (function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var SVG_TAGS = /^(svg|g|path|circle|rect|text|line|polyline|polygon|defs|marker|tspan|clipPath|ellipse|use)$/;

  /* 时间轴轨道几何：第一条轨道 x=14，多条并行时每条右移 7px */
  var RAIL = { x0: 14, gap: 7, gutter: 36 };

  /* 热区尺寸的参照宽度（px）：数据里的 w/h 是在「卡片正文宽 728px」下量出来的。
     渲染时换算成百分比，卡片变窄（手机、双列）时热区跟着等比缩小，
     不会像固定 px 那样在小屏上糊成一片。728 = 780 卡宽 - 26×2 内边距。 */
  var HOT_REF = 728;

  /* 维度筛选的「不限」哨兵。不能用 "all"：数据里 campus:"all" 是一个真实取值
     （松江枢纽、附表那种不分校区的整页），用 "all" 当哨兵会让「各校区通用」
     这个 Tab 变成「全部」，两个 Tab 同时高亮且筛不动。 */
  var ANY_DIM = "*";

  function h(tag, attrs) {
    var el = SVG_TAGS.test(tag)
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag);
    var a = attrs || {};
    for (var k in a) {
      var v = a[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.setAttribute("class", v);
      else if (k === "style") el.setAttribute("style", v);
      else if (k === "text") el.textContent = v;
      else if (k === "dataset") { for (var d in v) el.dataset[d] = v[d]; }
      else if (k.slice(0, 2) === "on" && typeof v === "function")
        el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, String(v));
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid === null || kid === undefined || kid === false) continue;
      if (Array.isArray(kid)) kid.forEach(function (k2) { if (k2) el.appendChild(k2); });
      else if (typeof kid === "string") el.appendChild(document.createTextNode(kid));
      else el.appendChild(kid);
    }
    return el;
  }

  function lineColor(key, data) {
    var map = (data && data.lineColors) || {};
    if (!key) return map.neutral || "#8f98a3";
    return map[key] || key;
  }

  /* ── 确定性伪随机街道底图：只用于目录卡片的水印 ───────────────── */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function streetLayer(w, hgt, seed, opts) {
    var o = opts || {};
    var rnd = mulberry32(seed);
    var g = h("g", { fill: "none", stroke: o.stroke || "#dfe3e6", "stroke-linecap": "square" });
    for (var i = 0; i < (o.majors || 8); i++) {
      var y = rnd() * hgt;
      var skew = (rnd() - 0.5) * hgt * 0.16;
      g.appendChild(h("path", { d: "M-4 " + y.toFixed(1) + " L" + (w + 4) + " " + (y + skew).toFixed(1), "stroke-width": (1 + rnd() * 0.6).toFixed(2) }));
    }
    for (var j = 0; j < (o.majorsV || 7); j++) {
      var x = rnd() * w;
      var sk2 = (rnd() - 0.5) * w * 0.14;
      g.appendChild(h("path", { d: "M" + x.toFixed(1) + " -4 L" + (x + sk2).toFixed(1) + " " + (hgt + 4), "stroke-width": (1 + rnd() * 0.6).toFixed(2) }));
    }
    var cells = o.cells || 30;
    for (var c = 0; c < cells; c++) {
      var cx = rnd() * w, cy = rnd() * hgt;
      var bw = 12 + rnd() * 40, bh = 10 + rnd() * 34;
      g.appendChild(h("rect", { x: cx.toFixed(1), y: cy.toFixed(1), width: bw.toFixed(1), height: bh.toFixed(1), "stroke-width": 0.5 }));
    }
    var wy = hgt * (0.44 + rnd() * 0.26);
    g.appendChild(h("path", {
      d: "M-4 " + wy.toFixed(1) + " Q" + (w * 0.32).toFixed(1) + " " + (wy - hgt * 0.08).toFixed(1) +
         " " + (w * 0.58).toFixed(1) + " " + (wy + hgt * 0.035).toFixed(1) +
         " T" + (w + 4) + " " + (wy - hgt * 0.045).toFixed(1),
      stroke: o.water || "#d3e3ec", "stroke-width": 2.4,
    }));
    return h("svg", { viewBox: "0 0 " + w + " " + hgt, preserveAspectRatio: "xMidYMid slice", "aria-hidden": "true" }, g);
  }

  /* ══════════════ 图标库 ══════════════
   * 图标不再写在代码里，而是按 id 查注册表。data.icons 优先（随 JSON 导出／导入
   * 一起走，用户上传的图标存在这里），缺失时回落到 GUIDE_ICON_SEED 出厂种子。
   *
   * 两种存储格式都支持：svg（内联标记）与 uri（data URI）。都不用外部路径 ——
   * 单卡片导出 PNG 走 <foreignObject>，其中加载不了相对路径的外部文件。
   */
  function iconList(data) {
    var seed = window.GUIDE_ICON_SEED || [];
    var own = (data && data.icons) || [];
    var byId = {}, out = [];
    own.concat(seed).forEach(function (ic) {
      if (!ic || !ic.id || byId[ic.id]) return;   // 同 id 时用户的覆盖出厂的
      byId[ic.id] = 1;
      out.push(ic);
    });
    return out;
  }

  function findIcon(data, id) {
    if (!id) return null;
    var all = iconList(data);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  /* 把图标画成 DOM。svg 走 innerHTML（保留矢量、可继承 currentColor），
     uri 走 <img>。size 是高度（px），宽度按 ratio 推算，缺省为正方。 */
  function renderIcon(data, id, opts) {
    var o = opts || {};
    var ic = findIcon(data, id);
    if (!ic) return null;
    var hgt = o.size || 15;
    var wid = ic.ratio ? Math.round(hgt * ic.ratio) : hgt;
    var box = h("span", {
      class: "gc-ico" + (o.cls ? " " + o.cls : ""),
      dataset: { iconId: id },
      style: "height:" + hgt + "px;width:" + wid + "px",
      "aria-label": o.label || ic.name || "",
      role: o.label ? "img" : null,
      "aria-hidden": o.label ? null : "true",
    });
    if (ic.svg) box.innerHTML = ic.svg;
    else if (ic.uri) box.appendChild(h("img", { src: ic.uri, alt: o.label || ic.name || "" }));
    return box;
  }

  /* 卡片右上角的品牌标。id 可由 data.meta.markIcon 指定，默认用出厂字标。 */
  function guideMark(data) {
    var id = (data && data.meta && data.meta.markIcon) || "brand-shutf";
    var ic = findIcon(data, id);
    if (!ic) return h("span", null);
    var wrap = h("div", { class: "gc-mark", "aria-label": ic.name || "" });
    var node = renderIcon(data, id, { size: 36, label: ic.name });
    if (node) {
      /* 品牌标按容器宽度自适应，不锁死像素高 —— 手机上卡片会变窄 */
      node.setAttribute("style", "height:auto;width:100%");
      wrap.appendChild(node);
    }
    return wrap;
  }

  /* 交通方式图标：数据里可用 ln.icon 指定任意 id；没指定时按 kind 取默认。 */
  var KIND_ICON = { metro: "metro-sh", rail: "rail-sh", bus: null };
  function lineIcon(data, ln) {
    var id = ln.icon || KIND_ICON[ln.kind] || null;
    return id ? renderIcon(data, id, { cls: "gc-mico", size: 15 }) : null;
  }

  /* ══════════════ 时间轴 ══════════════ */

  function railXs(rails) {
    return (rails || []).map(function (_, i) { return RAIL.x0 + i * RAIL.gap; });
  }
  function railsBelow(leg) {
    return (leg && (leg.mergeTo || leg.rails)) || [];
  }

  function gutter(leg, prevLeg, data) {
    var g = h("div", { class: "gc-gutter" });
    var top = (prevLeg && railsBelow(prevLeg)) || [];
    var bottom = railsBelow(leg);
    var isJoint = leg.type !== "stop";

    if (isJoint) {
      var xb = railXs(bottom);
      bottom.forEach(function (key, i) {
        g.appendChild(h("div", { class: "ln ln--full", style: "left:" + xb[i] + "px;background:" + lineColor(key, data) }));
      });
    } else {
      var xt = railXs(top), xb2 = railXs(bottom);
      top.forEach(function (key, i) {
        g.appendChild(h("div", { class: "ln ln--top", style: "left:" + xt[i] + "px;background:" + lineColor(key, data) }));
      });
      bottom.forEach(function (key, i) {
        g.appendChild(h("div", { class: "ln ln--bot", style: "left:" + xb2[i] + "px;background:" + lineColor(key, data) }));
      });
    }

    if (!isJoint) {
      var span = top.length >= bottom.length ? top : bottom;
      var xs = railXs(span);
      var cx = xs.length > 1 ? (xs[0] + xs[xs.length - 1]) / 2 : RAIL.x0;
      if (leg.marker === "transfer")
        g.appendChild(h("div", { class: "cx", style: "left:" + cx + "px;top:50%" }));
      else if (leg.marker === "hollow")
        g.appendChild(h("div", { class: "dot dot--hollow", style: "left:" + RAIL.x0 + "px;top:50%" }));
      else
        g.appendChild(h("div", { class: "dot", style: "left:" + RAIL.x0 + "px;top:50%" }));
    }
    return g;
  }

  function rideBody(leg, data) {
    var wrap = h("div", { class: "gc-notes" });
    (leg.lines || []).forEach(function (ln) {
      var row = h("div", { class: "gc-ride" });
      var ico = lineIcon(data, ln);
      if (ico) row.appendChild(ico);
      if (ln.kind === "bus") {
        row.appendChild(h("span", { class: "gc-busline", text: ln.no }));
      } else {
        row.appendChild(h("span", { class: "gc-lnum", style: "--c:" + lineColor(ln.color, data), text: ln.no }));
        if (ln.suffix) row.appendChild(h("span", { class: "gc-suffix", text: ln.suffix }));
      }
      if (ln.toward) row.appendChild(h("span", { class: "gc-toward-t", text: ln.toward }));
      if (ln.note) row.appendChild(h("span", { class: "gc-note", text: ln.note }));
      wrap.appendChild(row);
      (ln.notes || []).forEach(function (n) {
        wrap.appendChild(h("div", { class: "gc-note", text: n }));
      });
    });
    return wrap;
  }

  function legBody(leg, data) {
    if (leg.type === "walk")
      return h("div", { class: "gc-walk", text: "步行" + leg.meters + "米" });
    if (leg.type === "ride") return rideBody(leg, data);
    return h("div", null,
      h("div", { class: "gc-stop__name", text: leg.name }),
      leg.exit ? h("div", { class: "gc-stop__exit", text: leg.exit }) : null
    );
  }

  function renderTimeline(card, data, opts) {
    var tl = h("div", { class: "gc-tl" });
    (card.legs || []).forEach(function (leg, i) {
      var prev = i ? card.legs[i - 1] : null;
      var row = h("div", {
        class: "gc-leg",
        dataset: {
          legIndex: i, legType: leg.type,
          terminal: leg.terminal ? "1" : "0",
        },
      },
        gutter(leg, prev, data),
        h("div", { class: "gc-body" }, legBody(leg, data))
      );
      if (opts && opts.onPickLeg)
        row.addEventListener("click", function (e) {
          e.stopPropagation();
          opts.onPickLeg({ cardId: card.id, legIndex: i });
        });
      tl.appendChild(row);
    });
    return tl;
  }

  /* ══════════════ 卡片操作条 ══════════════ */

  function actionBar(card, opts) {
    var o = opts || {};
    var acts = [];
    acts.push(h("button", {
      class: "gc-act", type: "button", title: "把这张卡片导出为 PNG", text: "存图",
      onclick: function (e) {
        e.stopPropagation();
        var el = e.target.closest("[data-card-id]");
        exportCardPng(el, "shu-guide-" + card.id, 2)
          .then(function () { toast("已导出「" + (card.title || card.hub && card.hub.name || card.id) + "」"); })
          .catch(function (err) { toast("导出失败：" + err.message); });
      },
    }));
    if (o.onDuplicate) acts.push(h("button", {
      class: "gc-act", type: "button", title: "复制这张卡片", text: "复制",
      onclick: function (e) { e.stopPropagation(); o.onDuplicate(card.id); },
    }));
    if (o.onMove) {
      acts.push(h("button", {
        class: "gc-act", type: "button", title: "上移", text: "↑",
        onclick: function (e) { e.stopPropagation(); o.onMove(card.id, -1); },
      }));
      acts.push(h("button", {
        class: "gc-act", type: "button", title: "下移", text: "↓",
        onclick: function (e) { e.stopPropagation(); o.onMove(card.id, 1); },
      }));
    }
    if (o.onDelete) acts.push(h("button", {
      class: "gc-act gc-act--danger", type: "button", title: "删除这张卡片", text: "✕",
      onclick: function (e) { e.stopPropagation(); o.onDelete(card.id); },
    }));
    return h("div", { class: "gc-acts gc-noprint" }, acts);
  }

  /* ══════════════ 路线卡片 ══════════════ */

  function renderRouteCard(card, data, opts) {
    var o = opts || {};
    var head = h("div", { class: "gc-card__head" },
      h("div", { class: "gc-hub" },
        h("h3", { class: "gc-hub__name", text: card.hub.name }),
        card.hub.note ? h("span", { class: "gc-hub__note", text: card.hub.note }) : null
      ),
      guideMark(data)
    );

    var meta = h("div", { class: "gc-card__meta" },
      card.modeLabel
        ? h("span", { class: "gc-mode", dataset: { mode: card.mode }, text: card.modeLabel })
        : null,
      card.toward ? h("span", { class: "gc-toward", text: card.toward }) : null,
      h("span", { class: "gc-spacer" }),
      h("span", { class: "gc-stat" },
        h("span", null, ""),
        document.createTextNode(card.durationMin + "分钟"),
        h("span", null, " / "),
        document.createTextNode(card.fareYuan + "元")
      )
    );

    var flags = (card.flags || []).length
      ? h("div", { class: "gc-card__meta", style: "border:0;margin:-8px 0 12px;padding:0" },
          (card.flags || []).map(function (f) { return h("span", { class: "gc-flag", text: f }); }))
      : null;

    var el = h("article", {
      class: "gc-card", dataset: { cardId: card.id, kind: "route", mode: card.mode },
      "data-od-id": "route-card-" + card.id,
      tabindex: "0",
    },
      actionBar(card, o),
      head, meta, flags,
      renderTimeline(card, data, o)
    );

    if (o.onPickCard)
      el.addEventListener("click", function () { o.onPickCard(card.id); });
    return el;
  }

  /* ══════════════ 图示卡片（原稿真图 + 热区） ══════════════ */

  /* 图示素材有两个来源，按优先级回落：
       1. window.GUIDE_FIGURE_DATA —— 出厂内联包（含 base64，离线可用）
       2. /api/public/guide-assets/<key> —— D1 通道，合入 SHUMap 后的正式来源
     内联包优先是为了让这套文件脱离后端也能打开（原型与离线校对）；
     正式部署时不带内联包，全部走接口。 */
  var ASSET_BASE = "/api/public/guide-assets/";

  /* key → data URI。PNG 导出需要 data URI（<foreignObject> 里加载不了外部文件），
     所以走接口的图会在导出前被 inlineExternalImages 抓下来缓存在这里。 */
  var figureCache = {};

  function figureRegistry() { return window.GUIDE_FIGURE_DATA || {}; }

  function figureSrc(key) {
    var f = figureRegistry()[key];
    if (f && f.uri) return f.uri;
    return figureCache[key] || null;
  }
  function figureSize(key) {
    return figureRegistry()[key] || null;
  }
  function figureUrl(key) {
    return ASSET_BASE + encodeURIComponent(key);
  }

  /* 屏幕/打印用 SVG（矢量，放大不糊、文字仍是文字）；
     导出 PNG 时由 exportCardPng 换成内联位图 —— <foreignObject> 里
     无法加载相对路径的外部文件，只有 data URI 才画得出来。 */
  function renderFigureCard(card, data, opts) {
    var o = opts || {};
    var meta = figureSize(card.figure);
    var raster = figureSrc(card.figure);
    var vector = meta && meta.svg;

    var wrap = h("div", { class: "gc-figwrap", dataset: { reveal: "0" } });
    /* 三级回落：内联矢量 → 内联位图 → D1 接口。
       前两级来自出厂包（离线可用），最后一级是合入 SHUMap 后的正式来源。
       没有内联包时不再显示「素材缺失」——那会让正式部署看起来是坏的。 */
    var src = vector || raster || figureUrl(card.figure);
    var img = h("img", {
      src: src,
      alt: card.title + "（取自原稿矢量文件）",
      loading: "lazy",
      decoding: "async",
      width: vector ? (meta.vw || null) : (meta ? meta.w : null),
      height: vector ? (meta.vh || null) : (meta ? meta.h : null),
      dataset: {
        figKey: card.figure,
        vector: vector ? "1" : "0",
        /* remote=1 标记「这张图的字节还不在本地」：exportCardPng 导出前
           必须先把它抓成 data URI，否则 <foreignObject> 里画出来是空白。 */
        remote: (vector || raster) ? "0" : "1",
      },
    });
    /* 接口取图失败时才降级成文字提示，且说清是哪个键，便于后台补素材 */
    img.addEventListener("error", function () {
      if (img.dataset.failed === "1") return;
      img.dataset.failed = "1";
      img.replaceWith(h("div", {
        style: "padding:48px 20px;text-align:center;font-size:13px;color:#68727e",
        text: "图示素材尚未上传：" + card.figure,
      }));
    });
    wrap.appendChild(img);

    (card.hotspots || []).forEach(function (hs) {
      var btn = h("button", {
        class: "gc-hot", type: "button",
        dataset: { hotId: hs.id },
        style: "left:" + hs.x + "%;top:" + hs.y + "%" +
               ";--hw:" + ((hs.w || 44) / HOT_REF * 100).toFixed(3) + "%" +
               ";--hh:" + ((hs.h || 44) / HOT_REF * 100).toFixed(3) + "%",
        "aria-label": hs.title,
      }, h("span", { class: "gc-hot__pin" }));
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        openPop(btn, hs, o);
      });
      if (o.onPickHot)
        btn.addEventListener("contextmenu", function (e) {
          e.preventDefault();
          o.onPickHot({ cardId: card.id, hotId: hs.id });
        });
      wrap.appendChild(btn);
    });

    var reveal = h("button", {
      class: "gc-act", type: "button", text: "显示可点位置",
      onclick: function (e) {
        e.stopPropagation();
        var on = wrap.dataset.reveal === "1";
        wrap.dataset.reveal = on ? "0" : "1";
        e.target.textContent = on ? "显示可点位置" : "隐藏标记";
      },
    });

    var el = h("article", {
      class: "gc-figcard", dataset: { cardId: card.id, kind: "figure" },
      "data-od-id": "figure-card-" + card.id,
    },
      actionBar(card, o),
      h("div", { class: "gc-figcard__head" },
        h("h3", { class: "gc-figcard__t", text: card.title })
      ),
      card.caption ? h("div", { class: "gc-figcard__cap", text: card.caption }) : null,
      wrap,
      h("div", { class: "gc-fighint gc-noprint" },
        reveal,
        h("span", { text: (card.hotspots || []).length + " 个可点位置 · 点击查看详情或跳转" })
      )
    );
    return el;
  }

  /* ══════════════ 步骤卡片（实景指引 / 附表教程） ══════════════
   * 原稿的「实景指引」页是照片 + 序号说明，「附表1」是纯文字教程。
   * 两者共用这一种卡片：sections[] 分小节，每节 steps[] 是有序步骤。
   * section.bare = true 时不显示步骤序号（教程型，不是照着走的操作序列）。
   * card.pending 用来显式声明「这部分原稿数据还没录进来」——
   * 宁可在页面上写明缺口，也不要让读者以为看到的就是全部。
   */
  function renderStepsCard(card, data, opts) {
    var o = opts || {};
    var head = h("div", { class: "gc-card__head" },
      h("div", { class: "gc-hub" },
        h("h3", { class: "gc-hub__name", text: card.hub ? card.hub.name : (card.title || "") }),
        card.hub && card.hub.note
          ? h("span", { class: "gc-hub__note", text: card.hub.note }) : null
      ),
      guideMark(data)
    );

    var meta = h("div", { class: "gc-card__meta" },
      card.toward ? h("span", { class: "gc-toward", text: card.toward }) : null,
      h("span", { class: "gc-spacer" }),
      card.page ? h("span", { class: "gc-stat" }, h("span", null, "原稿第 " + card.page + " 页")) : null
    );

    var body = h("div", { class: "gc-steps" });
    if (card.intro) body.appendChild(h("div", { class: "gc-steps__intro", text: card.intro }));

    (card.sections || []).forEach(function (sec) {
      var box = h("section", { class: "gc-sec", dataset: { accent: sec.accent || "" } });
      if (sec.title)
        box.appendChild(h("h4", { class: "gc-sec__t", text: sec.title },
          sec.accent ? h("span", { class: "gc-sec__dot", style: "--c:" + sec.accent }) : null));
      var list = h(sec.bare ? "div" : "ol", { class: "gc-sec__list" });
      (sec.steps || []).forEach(function (st) {
        list.appendChild(h(sec.bare ? "div" : "li", { class: "gc-step" },
          h("span", { class: "gc-step__t", text: st.text }),
          st.note ? h("span", { class: "gc-step__n", text: st.note }) : null
        ));
      });
      box.appendChild(list);
      body.appendChild(box);
    });

    if (card.pending)
      body.appendChild(h("div", { class: "gc-pending" },
        h("span", { class: "gc-pending__l", text: card.pending.label }),
        card.pending.detail ? h("span", { class: "gc-pending__d", text: card.pending.detail }) : null
      ));

    var el = h("article", {
      class: "gc-card gc-card--steps",
      dataset: { cardId: card.id, kind: "steps" },
      "data-od-id": "steps-card-" + card.id,
      tabindex: "0",
    }, actionBar(card, o), head, meta, body);

    if (o.onPickCard)
      el.addEventListener("click", function () { o.onPickCard(card.id); });
    return el;
  }

  function renderCard(card, data, opts) {
    if (card.kind === "figure") return renderFigureCard(card, data, opts);
    if (card.kind === "steps") return renderStepsCard(card, data, opts);
    return renderRouteCard(card, data, opts);
  }

  /* ══════════════ 目录卡片 ══════════════ */

  function renderCover(cover, data, opts) {
    var o = opts || {};
    var grid = h("div", { class: "gc-hubs", "data-od-id": "cover-hub-grid" });
    (cover.hubs || []).forEach(function (hub) {
      var entries = h("div", { class: "gc-entries" });
      (hub.entries || []).forEach(function (en) {
        var linked = !!en.groupId;
        var btn = h("button", {
          class: "gc-entry", type: "button",
          dataset: { linked: linked ? "1" : "0", groupId: en.groupId || "" },
          "aria-label": hub.name + " " + en.label + " 第" + en.page + "页" + (linked ? "" : "（本轮未包含）"),
        },
          h("span", { class: "gc-entry__arrow", text: en.arrow || "→" }),
          h("span", { class: "gc-entry__label", text: en.label }),
          h("span", { class: "gc-entry__page", text: linked ? "第" + en.page + "页" : "第" + en.page + "页 · 待录入" })
        );
        if (linked && o.onNavigate) btn.addEventListener("click", function () { o.onNavigate(en.groupId); });
        else if (!linked) btn.addEventListener("click", function () {
          toast("第" + en.page + "页「" + hub.name + " " + en.label + "」数据尚未录入");
        });
        entries.appendChild(btn);
      });
      grid.appendChild(h("div", { class: "gc-hubcard", dataset: { hubId: hub.id } },
        h("h3", { class: "gc-hubcard__name" },
          h("span", { class: "gc-swatch", style: "--c:" + hub.color }),
          h("span", { text: hub.name })
        ),
        hub.note ? h("div", { class: "gc-hubcard__note", text: hub.note }) : null,
        entries,
        hub.tail ? h("div", { class: "gc-hubcard__note", style: "margin-top:5px", text: hub.tail }) : null
      ));
    });

    return h("article", {
      class: "gc-cover", dataset: { cardId: "cover", kind: "cover" }, "data-od-id": "cover-card",
    },
      h("div", { class: "gc-cover__wm" }, streetLayer(780, 620, 424242, { cells: 34 })),
      h("div", { style: "display:flex;justify-content:flex-end;margin-bottom:6px" }, guideMark(data)),
      h("div", { "data-od-id": "cover-title" },
        h("div", { class: "gc-cover__t1", text: data.meta.title }),
        h("div", { class: "gc-cover__t2", text: data.meta.subtitle })
      ),
      h("div", { class: "gc-cover__rule" }),
      h("div", { class: "gc-cover__lead", text: cover.lead }),
      grid,
      h("div", { class: "gc-cover__foot", text: "*" + data.meta.footnote })
    );
  }

  /* ══════════════ 出发点选择器（屏幕专用） ══════════════
   * 原稿目录是「枢纽 × 校区 + 页码」的表格，那是纸质版翻页用的。
   * 手机上没有页码这回事，所以屏幕上换成这个选择器：先点枢纽，再点校区。
   * 目录卡片（renderCover）仍然保留，只在打印/PDF 里出现，版式与原稿一致。
   */
  /* data.campuses 是数组（要保序），查名字得先转成 id → 条目 的表。
     缓存在闭包里没意义 —— 编辑器会整份换掉 data，所以每次现算。 */
  function campusEntry(data, id) {
    var list = (data && data.campuses) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* 校区短名：优先 group 自带的 campusLabel（允许单个分组改写），
     其次查 data.campuses，最后退回 campus 键本身。短名用在选择器、
     目录和顶部 Tab 上 —— 那些地方放不下「虹桥枢纽 → 宝山校区」这种完整标题。
     short 只在顶部 Tab 用（"宝山"），label 用在选择器和目录（"宝山校区"）。 */
  function campusLabel(data, g, useShort) {
    if (!g) return "";
    if (g.campusLabel) return g.campusLabel;
    var e = campusEntry(data, g.campus);
    if (e) return (useShort && e.short) || e.label || e.id;
    return g.campus || g.title || "";
  }

  /* 顶部 Tab 用的枢纽 / 校区维度。只列真正有卡片的项，
     避免 Tab 上出现点进去是空的选项。 */
  function hubList(data) {
    var out = [];
    ((data.cover && data.cover.hubs) || []).forEach(function (hub) {
      var n = 0;
      (data.groups || []).forEach(function (g) {
        if (g.hub !== hub.id) return;
        n += (data.cards || []).filter(function (c) { return c.group === g.id; }).length;
      });
      if (n) out.push({ id: hub.id, label: hub.name, color: hub.color, count: n });
    });
    return out;
  }

  /* 校区维度按 data.campuses 的声明顺序排，而不是按 groups 里第一次出现的
     顺序 —— 后者会让 Tab 顺序随分组增删漂移。 */
  function campusList(data) {
    var out = [];
    ((data && data.campuses) || []).forEach(function (c) {
      var n = 0;
      (data.groups || []).forEach(function (g) {
        if (g.campus !== c.id) return;
        n += (data.cards || []).filter(function (x) { return x.group === g.id; }).length;
      });
      if (n) out.push({ id: c.id, label: c.label || c.id, short: c.short || c.label || c.id, count: n });
    });
    return out;
  }

  function renderPicker(data, opts) {
    var o = opts || {};
    var hubs = (data.cover && data.cover.hubs) || [];
    var grid = h("div", { class: "gc-pick__grid" });

    hubs.forEach(function (hub) {
      var groups = (data.groups || []).filter(function (g) { return g.hub === hub.id; });
      if (!groups.length) return;
      var chips = h("div", { class: "gc-pick__chips" });
      groups.forEach(function (g) {
        var n = (data.cards || []).filter(function (c) { return c.group === g.id; }).length;
        var btn = h("button", {
          class: "gc-pick__chip", type: "button",
          dataset: { groupId: g.id },
          "aria-label": hub.name + " 去往 " + campusLabel(data, g) + "，" + n + " 张卡片",
        },
          h("span", { class: "gc-pick__chipL", text: campusLabel(data, g) }),
          h("span", { class: "gc-pick__chipN", text: n + " 卡" })
        );
        if (o.onNavigate)
          btn.addEventListener("click", function () { o.onNavigate(g.id); });
        chips.appendChild(btn);
      });
      grid.appendChild(h("div", { class: "gc-pick__hub", dataset: { hubId: hub.id } },
        h("h3", { class: "gc-pick__hubN" },
          h("span", { class: "gc-swatch", style: "--c:" + hub.color }),
          h("span", { text: hub.name })
        ),
        hub.note ? h("div", { class: "gc-pick__hubNote", text: hub.note }) : null,
        chips
      ));
    });

    return h("section", { class: "gc-pick gc-noprint", "data-od-id": "entry-picker" },
      h("div", { class: "gc-pick__head" },
        h("div", null,
          h("div", { class: "gc-pick__t1", text: data.meta.title }),
          h("div", { class: "gc-pick__t2", text: data.meta.subtitle })
        ),
        guideMark(data)
      ),
      h("div", { class: "gc-pick__lead", text: (data.cover && data.cover.lead) || "从下列枢纽出发…" }),
      grid
    );
  }

  /* ══════════════ 浏览目录（大纲） ══════════════
   * 按枢纽把分组折起来，点条目跳到对应卡片组。返回的节点自带
   * data-group-id，外壳用它同步「当前所在分组」的高亮。
   */
  function renderToc(data, opts) {
    var o = opts || {};
    var hubs = (data.cover && data.cover.hubs) || [];
    var box = h("nav", { class: "gc-toc", "aria-label": "指南目录" });

    hubs.forEach(function (hub) {
      var groups = (data.groups || []).filter(function (g) { return g.hub === hub.id; });
      if (!groups.length) return;
      var items = h("div", { class: "gc-toc__items" });
      groups.forEach(function (g) {
        var cards = (data.cards || []).filter(function (c) { return c.group === g.id; });
        var btn = h("button", {
          class: "gc-toc__item", type: "button",
          dataset: { groupId: g.id },
        },
          h("span", { class: "gc-toc__label", text: campusLabel(data, g) }),
          h("span", { class: "gc-toc__n", text: String(cards.length) })
        );
        btn.addEventListener("click", function () {
          if (o.onNavigate) o.onNavigate(g.id);
          if (o.onPicked) o.onPicked(g.id);
        });
        items.appendChild(btn);
      });
      box.appendChild(h("div", { class: "gc-toc__hub" },
        h("div", { class: "gc-toc__hubN" },
          h("span", { class: "gc-swatch", style: "--c:" + hub.color }),
          h("span", { text: hub.name })
        ),
        items
      ));
    });
    return box;
  }

  /* ══════════════ 卡片流 ══════════════ */

  function renderFlow(data, opts) {
    var o = opts || {};
    var flow = h("div", {
      class: "gc-flow", "data-od-id": "card-flow",
      /* cols：1 = 强制单列（手机），2 = 双列（大屏与打印）。
         cover：print = 目录只在打印里出现（屏幕走 .gc-pick 选择器）；
                both  = 屏幕也显示目录，供编辑器预览导出版式。 */
      dataset: {
        cols: o.columns === 1 ? "1" : "2",
        cover: o.showCover ? "both" : "print",
      },
    });

    /* 屏幕看选择器，打印看原稿目录 —— 两者都进 DOM，由 CSS 决定谁出现 */
    if (!o.hideCover) {
      flow.appendChild(renderPicker(data, o));
      flow.appendChild(renderCover(data.cover, data, o));
    }

    var groups = data.groups || [];
    var seen = {};
    groups.forEach(function (g) {
      var cards = (data.cards || []).filter(function (c) { return c.group === g.id; });
      if (!cards.length) return;
      cards.forEach(function (c) { seen[c.id] = true; });

      /* "*"（或不传）= 不按该维度筛。不能用 "all" 当哨兵：
         数据里真有 campus:"all"（松江、附表那种不分校区的整页）。 */
      if (o.hub && o.hub !== ANY_DIM && g.hub !== o.hub) return;
      if (o.campus && o.campus !== ANY_DIM && g.campus !== o.campus) return;

      var shown = cards.filter(function (c) {
        return !(o.filter && c.kind === "route" && o.filter !== "all" && c.mode !== o.filter);
      });
      if (!shown.length) return;

      var holder = h("div", { class: "gc-group__cards" });
      shown.forEach(function (c) { holder.appendChild(renderCard(c, data, o)); });

      flow.appendChild(h("section", {
        class: "gc-group", id: "group-" + g.id,
        dataset: { groupId: g.id, hub: g.hub || "", campus: g.campus || "" },
      },
        h("div", { class: "gc-grouphead" },
          h("h2", { class: "gc-grouphead__t", text: g.title }),
          g.note ? h("span", { class: "gc-grouphead__n", text: g.note }) : null,
          h("span", { class: "gc-grouphead__rule" })
        ),
        holder
      ));
    });

    /* 未归入任何分组的卡片仍然渲染，避免数据里加了卡片却看不见 */
    var loose = (data.cards || []).filter(function (c) { return !seen[c.id]; });
    var dimmed = (o.hub && o.hub !== ANY_DIM) || (o.campus && o.campus !== ANY_DIM);
    if (loose.length && !dimmed) {
      var lh = h("div", { class: "gc-group__cards" });
      loose.forEach(function (c) { lh.appendChild(renderCard(c, data, o)); });
      flow.appendChild(h("section", { class: "gc-group", dataset: { groupId: "" } },
        h("div", { class: "gc-grouphead" },
          h("h2", { class: "gc-grouphead__t", text: "未分组卡片" }),
          h("span", { class: "gc-grouphead__rule" })
        ),
        lh
      ));
    }

    if (!flow.querySelector(".gc-group"))
      flow.appendChild(h("div", { class: "gc-empty", text: "当前筛选下没有卡片，换个枢纽或校区试试。" }));

    return flow;
  }

  /* ══════════════ 弹出详情 / 提示 ══════════════ */

  var popEl = null;
  function closePop() {
    if (popEl) { popEl.remove(); popEl = null; }
  }
  function openPop(anchor, cfg, opts) {
    closePop();
    var o = opts || {};
    var links = h("div", { class: "gc-pop__links" });
    (cfg.links || []).forEach(function (l) {
      var isInternal = /^#/.test(l.href);
      var a = h("a", {
        href: isInternal ? "#" : l.href,
        target: isInternal ? null : "_blank",
        rel: isInternal ? null : "noopener noreferrer",
        text: l.label + (isInternal ? "" : " ↗"),
      });
      if (isInternal)
        a.addEventListener("click", function (e) {
          e.preventDefault();
          closePop();
          if (o.onInternalLink) o.onInternalLink(l.href, l);
          else toast("内部跳转：" + l.href);
        });
      links.appendChild(a);
    });

    popEl = h("div", { class: "gc-pop", role: "dialog", "aria-label": cfg.title },
      h("button", { class: "gc-pop__x", type: "button", "aria-label": "关闭", text: "✕", onclick: closePop }),
      h("div", { class: "gc-pop__t", text: cfg.title }),
      cfg.body ? h("div", { class: "gc-pop__b", text: cfg.body }) : null,
      (cfg.links || []).length ? links : null
    );
    document.body.appendChild(popEl);

    var r = anchor.getBoundingClientRect();
    var pw = popEl.offsetWidth, ph = popEl.offsetHeight;
    var left = r.left + r.width / 2 - pw / 2;
    var top = r.bottom + 10;
    left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
    if (top + ph > window.innerHeight - 12) top = Math.max(12, r.top - ph - 10);
    popEl.style.left = left + "px";
    popEl.style.top = top + "px";
  }

  var toastTimer = null;
  function toast(msg) {
    var old = document.querySelector(".gc-toast");
    if (old) old.remove();
    var el = h("div", { class: "gc-toast", role: "status", text: msg });
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, 2800);
  }

  document.addEventListener("click", function (e) {
    if (popEl && !popEl.contains(e.target)) closePop();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });

  /* ══════════════ 单卡片 PNG 导出 ══════════════ */

  /* 把走接口的图抓成 data URI 并缓存。
     必须做这一步：<foreignObject> 内不会发起网络请求，外部 URL 一律画成空白。
     缓存按 key 存，所以「批量存图」只会为同一张图抓一次。 */
  function inlineRemoteFigure(key) {
    if (figureCache[key]) return Promise.resolve(figureCache[key]);
    return fetch(figureUrl(key), { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("图示 " + key + " 取回失败（HTTP " + res.status + "）");
        return res.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve(String(fr.result)); };
          fr.onerror = function () { reject(new Error("图示 " + key + " 无法转成内联数据")); };
          fr.readAsDataURL(blob);
        });
      })
      .then(function (uri) { figureCache[key] = uri; return uri; });
  }

  /* 导出前的准备：把这张卡片里所有 remote=1 的图预取成 data URI。
     没有远端图时立即 resolve，不引入额外一轮事件循环。 */
  function prepareCardForExport(cardEl) {
    if (!cardEl) return Promise.resolve();
    var keys = Array.prototype.slice
      .call(cardEl.querySelectorAll('img[data-remote="1"][data-fig-key]'))
      .map(function (im) { return im.dataset.figKey; })
      .filter(function (k, i, arr) { return k && arr.indexOf(k) === i; });
    if (!keys.length) return Promise.resolve();
    return Promise.all(keys.map(inlineRemoteFigure));
  }

  function exportCardPng(cardEl, filename, scale) {
    /* 先把远端图内联进缓存，再走原来的同步渲染管线。
       这样调用方仍然只看到一个 Promise，行为不变。 */
    return prepareCardForExport(cardEl).then(function () {
      return exportCardPngSync(cardEl, filename, scale);
    });
  }

  function exportCardPngSync(cardEl, filename, scale) {
    return new Promise(function (resolve, reject) {
      if (!cardEl) return reject(new Error("找不到卡片元素"));
      var s = scale || 2;
      var pad = 18;
      var w = cardEl.offsetWidth;
      var hgt = cardEl.offsetHeight;
      if (!w || !hgt) return reject(new Error("卡片尺寸为 0"));

      var clone = cardEl.cloneNode(true);
      clone.querySelectorAll(".gc-acts,.gc-fighint,.gc-noprint").forEach(function (n) { n.remove(); });
      clone.querySelectorAll("[data-reveal]").forEach(function (n) { n.dataset.reveal = "0"; });
      /* 把矢量图换回内联位图：<foreignObject> 内无法加载相对路径的外部
         SVG 文件，不换的话导出的图里图示位置会是空白。 */
      clone.querySelectorAll('img[data-vector="1"]').forEach(function (im) {
        var meta = figureSize(im.dataset.figKey);
        if (meta && meta.uri) {
          var box = im.getBoundingClientRect();
          im.setAttribute("src", meta.uri);
          im.setAttribute("width", meta.w);
          im.setAttribute("height", meta.h);
          if (box.width) im.setAttribute("style", "width:100%;height:auto;display:block");
        }
      });
      /* 走接口的图：换成 prepareCardForExport 预取好的 data URI。
         宽高保持渲染时的实际盒子，避免导出图里比例变形。 */
      clone.querySelectorAll('img[data-remote="1"]').forEach(function (im) {
        var uri = figureCache[im.dataset.figKey];
        if (!uri) return;
        im.setAttribute("src", uri);
        im.removeAttribute("width");
        im.removeAttribute("height");
        im.setAttribute("style", "width:100%;height:auto;display:block");
      });
      clone.removeAttribute("tabindex");
      clone.setAttribute("style", "width:" + w + "px;box-shadow:none;margin:0");

      var wrap = document.createElement("div");
      wrap.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
      wrap.setAttribute("style",
        "width:" + (w + pad * 2) + "px;padding:" + pad + "px;background:#f5f6f8;" +
        "display:flex;justify-content:center;font-family:" +
        '"PingFang SC","Hiragino Sans GB","Noto Sans SC",sans-serif');
      var st = document.createElement("style");
      st.textContent = window.GUIDE_CSS;
      wrap.appendChild(st);
      wrap.appendChild(clone);

      var totalW = w + pad * 2;
      var totalH = hgt + pad * 2;
      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + totalW + '" height="' + totalH + '">' +
        '<foreignObject width="100%" height="100%">' +
        new XMLSerializer().serializeToString(wrap) +
        "</foreignObject></svg>";

      var img = new Image();
      img.onload = function () {
        var cv = document.createElement("canvas");
        cv.width = totalW * s;
        cv.height = totalH * s;
        var ctx = cv.getContext("2d");
        ctx.fillStyle = "#f5f6f8";
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.setTransform(s, 0, 0, s, 0, 0);
        ctx.drawImage(img, 0, 0);
        try {
          var a = document.createElement("a");
          a.download = (filename || "guide-card") + ".png";
          a.href = cv.toDataURL("image/png");
          a.click();
          resolve(true);
        } catch (err) { reject(err); }
      };
      img.onerror = function () { reject(new Error("PNG 渲染失败")); };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }

  return {
    h: h, RAIL: RAIL, lineColor: lineColor, guideMark: guideMark,
    iconList: iconList, findIcon: findIcon, renderIcon: renderIcon, lineIcon: lineIcon,
    streetLayer: streetLayer, figureSrc: figureSrc, figureSize: figureSize,
    renderCard: renderCard, renderRouteCard: renderRouteCard, renderFigureCard: renderFigureCard,
    renderStepsCard: renderStepsCard,
    renderCover: renderCover, renderFlow: renderFlow,
    renderPicker: renderPicker, renderToc: renderToc,
    hubList: hubList, campusList: campusList, campusLabel: campusLabel,
    toast: toast, closePop: closePop, exportCardPng: exportCardPng,
  };
})();

/*
 * guide-render.js — 返校指南电子版共用渲染层（schema v2 · 枢纽 × 校区架构）
 *
 * 前台展示页与可视化编辑器共读这里的函数，保证「网页上看到的」与
 * 「编辑器里改的」是同一份代码画出来的。v2 架构：卡片直接携带 hub/campus
 * 两个 id，不再有 v1 的 cover/groups 分段层；normalizeData 负责把线上
 * 可能残留的旧版数据（D1 旧修订）就地升级成 v2。
 *
 * 对外接口（window.GuideRender）：
 *   normalizeData(raw)               → v2 数据（兼容 v1 输入）
 *   allIcons / iconById / renderIcon → 图标库（data.icons 覆盖出厂种子）
 *   sanitizeRichHtml(html)           → 富文本白名单消毒（编辑器共用）
 *   renderCard / renderRouteCard / renderFigureCard / renderStepsCard
 *   renderHubGuide / renderHubVideo / renderRemark → 枢纽级区块
 *   renderPairView(container, data, hubId, campusId, opts) → 一对组合的整页
 *   buildPrintRoot(data)             → 打印/PDF 用的离屏文档树
 *   h / esc / RAIL / HOT_REF / lineColor / lineIcon → 供编辑器复用的图元
 *   toast / closePop / openPop       → 交互反馈
 */
window.GuideRender = (function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var SVG_TAGS = /^(svg|g|path|circle|rect|text|line|polyline|polygon|defs|marker|tspan|clipPath|ellipse|use)$/;

  /* 时间轴轨道几何：第一条轨道 x=14，多条并行时每条右移 7px */
  var RAIL = { x0: 14, gap: 7, gutter: 36 };

  /* 热区尺寸的参照宽度（px）：数据里的 w/h 是在「卡片正文宽 728px」下量出来的。
     渲染时换算成百分比，卡片变窄（手机、双列）时热区跟着等比缩小。 */
  var HOT_REF = 728;

  /* 图示素材统一走 D1 接口，不再有出厂内联包 */
  var ASSET_BASE = "/api/public/guide-assets/";

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
      else if (k === "dataset") {
        for (var d in v) {
          if (v[d] === null || v[d] === undefined) continue;
          el.dataset[d] = v[d];
        }
      }
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

  /* 拼 innerHTML 前的转义（编辑器会用到） */
  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function lineColor(key, data) {
    var map = (data && data.lineColors) || {};
    if (!key) return map.neutral || "#8f98a3";
    return map[key] || key;
  }

  /* ══════════════ 数据规范化 ══════════════
   * 两种历史形态都要就地升级：
   *   v1：顶层有 cover / groups，卡片用 group 挂分段、hub 是 {name,note} 对象
   *   中间形态 v2：schema 已是 2，但实景指引/换乘指南还是独立的 steps 卡
   *     （sceneGuide 改造前保存的草稿就是这种）—— steps 卡摘进 hub.sceneGuide
   * 已经是当前形态（无 steps 卡的 v2）或不认识的数据原样返回。 */
  function normalizeData(raw) {
    if (!raw) return raw;
    var d;
    if (raw.schema === 2) {
      d = raw;
    } else if (raw.cover || raw.groups) {
      d = upgradeV1(raw);
    } else {
      return raw;
    }
    return liftSceneGuides(d);
  }

  /* steps 卡 → hub.sceneGuide。非破坏：没有 steps 卡时原样返回输入。 */
  function liftSceneGuides(d) {
    var cards = d.cards || [];
    if (!cards.some(function (c) { return c.kind === "steps"; })) return d;

    var hubs = (d.hubs || []).map(function (hb) {
      var out = {};
      for (var k in hb) out[k] = hb[k];
      /* 已有 sceneGuide 又混着 steps 卡的中间数据：深拷贝再合并，不改输入对象 */
      if (out.sceneGuide) out.sceneGuide = JSON.parse(JSON.stringify(out.sceneGuide));
      else out.sceneGuide = null;
      return out;
    });
    var keptCards = [];
    cards.forEach(function (c) {
      if (c.kind !== "steps") { keptCards.push(c); return; }
      var hub = null;
      for (var i = 0; i < hubs.length; i++) if (hubs[i].id === c.hub) { hub = hubs[i]; break; }
      if (!hub) { keptCards.push(c); return; }   // 找不到枢纽就不丢数据
      if (!hub.sceneGuide) hub.sceneGuide = {};
      if (c.intro) hub.sceneGuide.intro = hub.sceneGuide.intro ? hub.sceneGuide.intro + "\n" + c.intro : c.intro;
      hub.sceneGuide.sections = (hub.sceneGuide.sections || []).concat(c.sections || []);
      if (c.pending) hub.sceneGuide.pending = c.pending;
    });
    var campuses = (d.campuses || []).filter(function (camp) {
      return camp.id !== "scene" || keptCards.some(function (c) { return c.campus === "scene"; });
    });

    var out = {};
    for (var k in d) out[k] = d[k];
    out.schema = 2;
    out.hubs = hubs;
    out.campuses = campuses;
    out.cards = keptCards;
    return out;
  }

  function upgradeV1(raw) {
    var groups = raw.groups || [];
    var meta = raw.meta || {};

    var hubs = ((raw.cover && raw.cover.hubs) || []).map(function (hb, i) {
      return {
        id: hb.id, name: hb.name, note: hb.note || null,
        color: hb.color || "#465060", order: i + 1,
        guideFigures: [], guideVideos: [], remark: "", sceneGuide: null,
      };
    });

    var cards = (raw.cards || []).map(function (c) {
      var g = null;
      for (var i = 0; i < groups.length; i++)
        if (groups[i].id === c.group) { g = groups[i]; break; }
      var out = {};
      for (var k in c) {
        if (k === "group" || k === "page" || k === "hub") continue;
        out[k] = c[k];
      }
      if (c.hub && typeof c.hub === "object") out.origin = c.hub;
      out.hub = g ? g.hub : (typeof c.hub === "string" ? c.hub : "");
      out.campus = g ? g.campus : (typeof c.campus === "string" ? c.campus : "all");
      return out;
    });

    return {
      schema: 2,
      meta: {
        title: meta.title || "", subtitle: meta.subtitle || "",
        edition: meta.edition || "", version: meta.version || "",
        revisedAt: meta.revisedAt || "", revisionNote: meta.revisionNote || "",
      },
      lineColors: raw.lineColors || {},
      campuses: raw.campuses || [],
      hubs: hubs,
      icons: raw.icons,
      cards: cards,
    };
  }

  function hubById(data, id) {
    var list = (data && data.hubs) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ══════════════ 校区适用性 ══════════════
   * 枢纽指引图（hub.guideFigures）与实况指引小节（section.campuses）都可声明
   * 适用校区：只在选中这些校区方向时显示；不声明（或空数组）= 通用，所有方向
   * 都显示。campusId 传 null（打印稿 / 全量视图）时不过滤，由调用方给声明了
   * campuses 的项补「XX 方向」标签。 */
  function hubFigures(hub) {
    if (!hub) return [];
    if (Array.isArray(hub.guideFigures))
      return hub.guideFigures.filter(function (f) { return f && f.src; });
    if (hub.guideFigure) return [{ src: hub.guideFigure }];   // 旧草稿兼容
    return [];
  }
  function hubVideos(hub) {
    if (!hub) return [];
    if (Array.isArray(hub.guideVideos))
      return hub.guideVideos.filter(function (v) { return v && v.url; });
    if (hub.guideVideo && hub.guideVideo.url) return [hub.guideVideo];   // 旧草稿兼容
    return [];
  }
  function appliesTo(item, campusId) {
    if (!campusId) return true;
    var cs = item && item.campuses;
    return !cs || !cs.length || cs.indexOf(campusId) !== -1;
  }
  function campusTag(campuses, campusIds) {
    var names = (campusIds || []).map(function (id) {
      var c = null;
      (campuses || []).forEach(function (x) { if (x.id === id) c = x; });
      return c ? (c.short || c.label || c.id) : id;
    });
    if (!names.length) return null;
    return h("span", { class: "gc-camptag", text: names.join(" / ") + " 方向" });
  }

  /* ══════════════ 图标库 ══════════════
   * 图标按 id 查注册表。data.icons 优先（用户上传，随 JSON 导出／导入），
   * 缺失时回落到 GUIDE_ICON_SEED 出厂种子。存储格式二选一：svg（内联标记）
   * 或 uri（data URI），都不用外部路径。 */
  function allIcons(data) {
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

  function iconById(data, id) {
    if (!id) return null;
    var all = allIcons(data);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  /* 把图标画成 DOM。iconOrId 可以是图标对象或 id；size 是高度（px），
     宽度按 ratio 推算，缺省为正方。svg 走 innerHTML，uri 走 <img>。 */
  function renderIcon(data, iconOrId, size) {
    var ic = typeof iconOrId === "string" ? iconById(data, iconOrId) : iconOrId;
    if (!ic) return null;
    var hgt = size || 15;
    var wid = ic.ratio ? Math.round(hgt * ic.ratio) : hgt;
    var box = h("span", {
      class: "gc-ico",
      dataset: { iconId: ic.id },
      style: "height:" + hgt + "px;width:" + wid + "px",
      "aria-hidden": "true",
    });
    if (ic.svg) box.innerHTML = ic.svg;
    else if (ic.uri) box.appendChild(h("img", { src: ic.uri, alt: ic.name || "" }));
    return box;
  }

  /* 交通方式图标：数据里可用 ln.icon 指定任意 id；没指定时按 kind 取默认。 */
  var KIND_ICON = { metro: "metro-sh", rail: "rail-sh", bus: null };
  function lineIcon(data, ln) {
    var id = ln.icon || KIND_ICON[ln.kind] || null;
    var node = id ? renderIcon(data, id, 15) : null;
    if (node) node.setAttribute("class", node.getAttribute("class") + " gc-mico");
    return node;
  }

  /* ══════════════ 富文本消毒（枢纽备注 / 编辑器共用） ══════════════
   * 白名单标签：b strong i em u p br ul ol li a img span。
   * 属性：a[href] 只允许 http/https/mailto/#（外链补 target=_blank rel=noopener）；
   * img[src] 只允许 /api/public/guide-assets/ 路径或 data:image/ URI（保留 alt）。
   * 其余标签剥壳保留文字，script/style 整体删除，其余属性一律删除。 */
  var RICH_TAGS = { b: 1, strong: 1, i: 1, em: 1, u: 1, p: 1, br: 1, ul: 1, ol: 1, li: 1, a: 1, img: 1, span: 1 };
  var HREF_OK = /^(https?:|mailto:|#)/i;
  var IMG_SRC_OK = /^(\/api\/public\/guide-assets\/|data:image\/)/i;

  function sanitizeRichHtml(html) {
    html = String(html === null || html === undefined ? "" : html);
    if (!html) return "";
    if (typeof DOMParser === "undefined") return sanitizeFallback(html);
    var doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
    var box = doc.body.firstChild;
    if (box) cleanRichChildren(box);
    return box ? box.innerHTML : "";
  }

  function cleanRichChildren(parent) {
    var nodes = Array.prototype.slice.call(parent.childNodes);
    nodes.forEach(function (node) {
      if (node.nodeType === 8) { parent.removeChild(node); return; }   // 注释
      if (node.nodeType !== 1) return;                                 // 文本保留
      var tag = node.tagName.toLowerCase();
      if (tag === "script" || tag === "style") { parent.removeChild(node); return; }
      if (!RICH_TAGS[tag]) {
        /* 非白名单标签：剥壳，保留内部内容 */
        cleanRichChildren(node);
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
        return;
      }
      cleanRichChildren(node);
      cleanRichAttrs(node, tag);
    });
  }

  function cleanRichAttrs(el, tag) {
    var keep = {};
    if (tag === "a") {
      var href = el.getAttribute("href") || "";
      if (HREF_OK.test(href)) {
        keep.href = href;
        if (/^https?:/i.test(href)) { keep.target = "_blank"; keep.rel = "noopener"; }
      }
    } else if (tag === "img") {
      var src = el.getAttribute("src") || "";
      if (IMG_SRC_OK.test(src)) keep.src = src;
      keep.alt = el.getAttribute("alt") || "";
    }
    while (el.attributes.length) el.removeAttribute(el.attributes[0].name);
    for (var k in keep) el.setAttribute(k, keep[k]);
  }

  /* 无 DOM 环境（node 测试、极端老浏览器）的正则兜底，规则与上面一致 */
  function sanitizeFallback(html) {
    var s = String(html);
    s = s.replace(/<!--[\s\S]*?-->/g, "");
    s = s.replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
    s = s.replace(/<\s*(script|style)\b[^>]*\/?>/gi, "");
    s = s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, function (m, close, tag, attrs) {
      tag = tag.toLowerCase();
      if (!RICH_TAGS[tag]) return "";
      if (close) return "</" + tag + ">";
      if (tag === "a") {
        var href = pickAttr(attrs, "href");
        if (!HREF_OK.test(href)) return "<a>";
        var extra = /^https?:/i.test(href) ? ' target="_blank" rel="noopener"' : "";
        return '<a href="' + esc(href) + '"' + extra + ">";
      }
      if (tag === "img") {
        var src = pickAttr(attrs, "src");
        if (!IMG_SRC_OK.test(src)) src = "";
        return '<img src="' + esc(src) + '" alt="' + esc(pickAttr(attrs, "alt")) + '">';
      }
      return "<" + tag + ">";
    });
    return s;
  }

  function pickAttr(attrs, name) {
    var m = attrs.match(new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', "i"));
    return m ? (m[1] || m[2] || m[3] || "") : "";
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
      if (ln.note) row.appendChild(h("span", { class: "gc-lnote", text: ln.note }));
      wrap.appendChild(row);
      (ln.notes || []).forEach(function (n) {
        wrap.appendChild(h("div", { class: "gc-lnote", text: n }));
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
      leg.exit ? h("div", { class: "gc-stop__exit", text: leg.exit }) : null,
      leg.note ? h("div", { class: "gc-lnote", text: leg.note }) : null
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

  /* ══════════════ 路线卡片 ══════════════ */

  function renderSchedule(schedule) {
    var box = h("div", { class: "gc-sched" },
      h("div", { class: "gc-sched__t", text: "发车时刻" }));
    (schedule || []).forEach(function (en) {
      var times = h("div", { class: "gc-sched__times" });
      String(en.times || "").split("\n").forEach(function (line) {
        times.appendChild(h("div", { text: line }));
      });
      box.appendChild(h("div", { class: "gc-sched__row" },
        h("div", { class: "gc-sched__label", text: en.label }),
        times
      ));
    });
    return box;
  }

  function renderRouteCard(card, data, opts) {
    var o = opts || {};
    var origin = card.origin || {};

    var head = h("div", { class: "gc-card-head" },
      h("div", { class: "gc-origin" },
        h("h3", { class: "gc-origin__name", text: origin.name || "" }),
        origin.note ? h("span", { class: "gc-origin__note", text: origin.note }) : null
      )
    );

    var chips = h("div", { class: "gc-card-chips" },
      card.toward ? h("span", { class: "gc-dest-chip", text: card.toward }) : null,
      card.modeLabel
        ? h("span", { class: "gc-mode-badge", dataset: { mode: card.mode || "other" }, text: card.modeLabel })
        : null,
      h("span", { class: "gc-spacer" }),
      card.durationMin !== null && card.durationMin !== undefined
        ? h("span", { class: "gc-meta-chip", text: "约 " + card.durationMin + " 分钟" }) : null,
      card.fareYuan !== null && card.fareYuan !== undefined
        ? h("span", { class: "gc-meta-chip", text: card.fareYuan + " 元" }) : null
    );

    var flags = (card.flags || []).length
      ? h("div", { class: "gc-flags" },
          card.flags.map(function (f) { return h("span", { class: "gc-flag", text: f }); }))
      : null;

    var hasNote = !!(card.note && String(card.note).trim());
    var hasSched = (card.schedule || []).length > 0;
    var foot = (hasNote || hasSched)
      ? h("div", { class: "gc-card-foot" },
          hasNote ? h("div", { class: "gc-note" },
            h("span", { class: "gc-note__label", text: "备注" }),
            h("span", { class: "gc-note__text", text: card.note })) : null,
          hasSched ? renderSchedule(card.schedule) : null)
      : null;

    var el = h("article", {
      class: "gc-card gc-card--route",
      id: "card-" + card.id,
      dataset: { cardId: card.id, kind: "route", mode: card.mode },
      tabindex: "0",
    }, head, chips, flags, renderTimeline(card, data, o), foot);

    if (o.onPickCard)
      el.addEventListener("click", function () { o.onPickCard(card.id); });
    return el;
  }

  /* ══════════════ 图示卡片（真图 + 热区） ══════════════
   * 素材只走 /api/public/guide-assets/<key>（SVG 优先，PNG 亦可）。
   * 热区坐标用百分比（HOT_REF 换算），随图等比缩放，默认常显。 */
  function renderFigureCard(card, data, opts) {
    var o = opts || {};
    var wrap = h("div", { class: "gc-figwrap" });
    var img = h("img", {
      src: ASSET_BASE + encodeURIComponent(card.figure),
      alt: card.title || "图示",
      loading: "lazy", decoding: "async",
      dataset: { figKey: card.figure },
    });
    img.addEventListener("error", function () {
      if (img.dataset.failed === "1") return;
      img.dataset.failed = "1";
      img.replaceWith(h("div", { class: "gc-placeholder", text: "图示素材尚未上传：" + card.figure }));
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
      });
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

    var el = h("article", {
      class: "gc-card gc-card--figure",
      id: "card-" + card.id,
      dataset: { cardId: card.id, kind: "figure" },
    },
      h("div", { class: "gc-figcard__head" },
        h("h3", { class: "gc-figcard__t", text: card.title || "图示" })),
      card.caption ? h("div", { class: "gc-figcard__cap", text: card.caption }) : null,
      wrap,
      (card.hotspots || []).length
        ? h("div", { class: "gc-fighint" },
            h("span", { text: (card.hotspots || []).length + " 个可点位置 · 点击查看详情或跳转" }))
        : null
    );
    if (o.onPickCard)
      el.addEventListener("click", function () { o.onPickCard(card.id); });
    return el;
  }

  /* ══════════════ 步骤卡片（实景指引 / 附表教程） ══════════════
   * sections[] 分小节，每节 steps[] 是有序步骤；section.bare = true 时不显示
   * 步骤序号。card.pending 显式声明「这部分原稿数据还没录进来」。 */
  /* 步骤内容体：steps 卡片与枢纽 sceneGuide 共用（intro + 小节 + pending）
     图文混排：step.figure（字符串或数组）画在步骤文字上方；某一步有图时
     整个小节的步骤列表切双列网格（对齐原稿实景指引版式）。
     section.figures 是小节级照片（如上海站的出站口指示牌），带说明文字。 */
  function figureSrc(ref) {
    if (/^(https?:|data:|\/)/.test(ref)) return ref;
    return ASSET_BASE + encodeURIComponent(ref);
  }
  function stepFigs(ref) {
    var srcs = Array.isArray(ref) ? ref : [ref];
    return h("span", { class: "gc-step__figs" }, srcs.map(function (s) {
      return h("img", { class: "gc-step__fig", src: figureSrc(s), alt: "实景照片",
        loading: "lazy", decoding: "async" });
    }));
  }
  function renderStepsBody(obj, campusId, campuses) {
    var body = h("div", { class: "gc-steps" });
    if (obj.intro) body.appendChild(h("div", { class: "gc-steps__intro", text: obj.intro }));

    (obj.sections || []).filter(function (sec) { return appliesTo(sec, campusId); })
      .forEach(function (sec) {
      var box = h("section", { class: "gc-sec", dataset: { accent: sec.accent || "" } });
      if (sec.title)
        box.appendChild(h("h4", { class: "gc-sec__t", text: sec.title },
          sec.accent ? h("span", { class: "gc-sec__dot", style: "--c:" + sec.accent }) : null,
          !campusId && sec.campuses && sec.campuses.length
            ? campusTag(campuses, sec.campuses) : null));
      if (sec.figures && sec.figures.length)
        box.appendChild(h("div", { class: "gc-secfigs" }, sec.figures.map(function (f) {
          return h("figure", { class: "gc-secfig" },
            h("img", { src: figureSrc(f.src), alt: f.caption || "实景照片",
              loading: "lazy", decoding: "async" }),
            f.caption ? h("figcaption", { class: "gc-secfig__cap", text: f.caption }) : null);
        })));
      var hasFigs = (sec.steps || []).some(function (st) { return st.figure; });
      var list = h(sec.bare && !hasFigs ? "div" : "ol", {
        class: "gc-sec__list" + (hasFigs ? " gc-sec__list--grid" : ""),
      });
      (sec.steps || []).forEach(function (st) {
        list.appendChild(h(sec.bare && !hasFigs ? "div" : "li", { class: "gc-step" },
          st.figure ? stepFigs(st.figure) : null,
          h("span", { class: "gc-step__t", text: st.text }),
          st.note ? h("span", { class: "gc-step__n", text: st.note }) : null
        ));
      });
      box.appendChild(list);
      body.appendChild(box);
    });

    if (obj.pending)
      body.appendChild(h("div", { class: "gc-pending" },
        h("span", { class: "gc-pending__l", text: obj.pending.label }),
        obj.pending.detail ? h("span", { class: "gc-pending__d", text: obj.pending.detail }) : null
      ));
    return body;
  }

  function renderStepsCard(card, data, opts) {
    var o = opts || {};
    var origin = card.origin || {};

    var head = h("div", { class: "gc-card-head" },
      h("div", { class: "gc-origin" },
        h("h3", { class: "gc-origin__name", text: origin.name || card.title || "" }),
        origin.note ? h("span", { class: "gc-origin__note", text: origin.note }) : null
      )
    );

    var chips = card.toward
      ? h("div", { class: "gc-card-chips" },
          h("span", { class: "gc-dest-chip", text: card.toward }))
      : null;

    var el = h("article", {
      class: "gc-card gc-card--steps",
      id: "card-" + card.id,
      dataset: { cardId: card.id, kind: "steps" },
      tabindex: "0",
    }, head, chips, renderStepsBody(card));

    if (o.onPickCard)
      el.addEventListener("click", function () { o.onPickCard(card.id); });
    return el;
  }

  function renderCard(card, data, opts) {
    if (card.kind === "figure") return renderFigureCard(card, data, opts);
    if (card.kind === "steps") return renderStepsCard(card, data, opts);
    return renderRouteCard(card, data, opts);
  }

  /* ══════════════ 枢纽级区块 ══════════════ */

  function hubSecTitle(text) {
    return h("h3", { class: "gc-hub-sec__t", text: text });
  }

  /* 枢纽指引：guideFigures 按校区过滤后渲染（SVG 走素材接口）。枢纽一张图
     都没有时给虚线占位；有图但当前方向不适用时返回 null（整块不显示）。
     campusId 为 null（打印稿）时全部显示，带「XX 方向」标签。 */
  function renderHubGuide(hub, campusId, campuses) {
    var all = hubFigures(hub);
    if (!all.length) {
      return h("section", { class: "gc-hub-sec" }, hubSecTitle("枢纽指引"),
        h("div", { class: "gc-placeholder", text: "枢纽指引图待上传" }));
    }
    var shown = all.filter(function (f) { return appliesTo(f, campusId); });
    if (!shown.length) return null;
    var body = h("div", { class: "gc-hubfigs" }, shown.map(function (f) {
      var img = h("img", {
        class: "gc-hub-fig",
        src: figureSrc(f.src),
        alt: (hub.name || "") + " 枢纽指引图",
        loading: "lazy", decoding: "async",
      });
      var fig = h("figure", { class: "gc-hubfig" },
        !campusId && f.campuses && f.campuses.length ? campusTag(campuses, f.campuses) : null,
        img);
      img.addEventListener("error", function () {
        fig.replaceWith(h("div", { class: "gc-placeholder", text: "枢纽指引图加载失败：" + f.src }));
      });
      return fig;
    }));
    return h("section", { class: "gc-hub-sec" }, hubSecTitle("枢纽指引"), body);
  }

  /* 实况指引：枢纽的实景引导（sceneGuide 小节图文，按校区过滤）+ 视频入口。
     有可见小节/引言/pending 渲染步骤图文；guideVideos 按校区过滤后每条渲染
     「点击查看视频引导」入口，点开是居中的视频弹层。有内容但当前方向都不适用
     时返回 null（整块不显示）；什么内容都没有时虚线占位。 */
  function renderHubVideo(hub, campusId, campuses) {
    var sg = hub && hub.sceneGuide;
    var secs = sg ? (sg.sections || []).filter(function (sec) { return appliesTo(sec, campusId); }) : [];
    var hasAnyScene = !!(sg && ((sg.sections && sg.sections.length) || sg.intro || sg.pending));
    var hasScene = !!(sg && (secs.length || sg.intro || sg.pending));
    var allVideos = hubVideos(hub);
    var videos = allVideos.filter(function (v) { return appliesTo(v, campusId); });
    var kids = [];
    if (hasScene)
      kids.push(renderStepsBody({ intro: sg.intro, sections: secs, pending: sg.pending }, campusId, campuses));
    videos.forEach(function (gv) {
      var entry = h("button", {
        class: "gc-video-entry", type: "button",
      },
        h("span", { class: "gc-video-entry__icon", text: "▶" }),
        h("span", { class: "gc-video-entry__t", text: "点击查看视频引导" }),
        !campusId && gv.campuses && gv.campuses.length ? campusTag(campuses, gv.campuses) : null,
        gv.note ? h("span", { class: "gc-video-entry__n", text: gv.note }) : null
      );
      entry.addEventListener("click", function () { openVideoLayer(gv); });
      kids.push(entry);
    });
    if (!kids.length) {
      if (hasAnyScene || allVideos.length) return null;   /* 有内容但都不适用这个方向：不显示 */
      kids.push(h("div", { class: "gc-placeholder", text: "实况指引待补充" }));
    }
    return h("section", { class: "gc-hub-sec" }, hubSecTitle("实况指引"), kids);
  }

  /* 视频弹层：遮罩 + 居中播放器，点遮罩或 ✕ 关闭（关闭即暂停） */
  var videoLayerEl = null;
  function openVideoLayer(gv) {
    closeVideoLayer();
    var video = h("video", {
      class: "gc-video-layer__video", controls: "controls", autoplay: "autoplay",
      src: gv.url, poster: gv.poster || null,
    });
    var layer = h("div", { class: "gc-video-layer" },
      h("div", { class: "gc-video-layer__box" },
        h("button", {
          class: "gc-video-layer__x", type: "button", text: "✕",
          onclick: function (e) { e.stopPropagation(); closeVideoLayer(); },
        }),
        video
      )
    );
    layer.addEventListener("click", function (e) { if (e.target === layer) closeVideoLayer(); });
    document.body.appendChild(layer);
    videoLayerEl = layer;
  }
  function closeVideoLayer() {
    if (!videoLayerEl) return;
    var v = videoLayerEl.querySelector("video");
    if (v) v.pause();
    videoLayerEl.remove();
    videoLayerEl = null;
  }

  /* 备注：hub.remark 经白名单消毒后渲染。空备注在前台返回 null（不渲染），
     编辑器传 opts.placeholder 可换成虚线占位。 */
  function renderRemark(hub, opts) {
    var o = opts || {};
    var html = hub && hub.remark ? sanitizeRichHtml(hub.remark) : "";
    if (!html.trim()) {
      if (!o.placeholder) return null;
      return h("section", { class: "gc-hub-sec" }, hubSecTitle("备注"),
        h("div", { class: "gc-placeholder",
          text: typeof o.placeholder === "string" ? o.placeholder : "备注待填写" }));
    }
    var box = h("div", { class: "gc-remark" });
    box.innerHTML = html;
    return h("section", { class: "gc-hub-sec" }, hubSecTitle("备注"), box);
  }

  /* ══════════════ 枢纽 × 校区组合页 ══════════════
   * 顺序：该组合的卡片栅格（route/figure/steps 按数据序）→ 枢纽指引 →
   * 实况指引 → 备注。opts.modeFilter（Set 或数组）只筛路线卡的出行方式。 */
  function renderPairView(container, data, hubId, campusId, opts) {
    var o = opts || {};
    var d = normalizeData(data);
    var hub = hubById(d, hubId);

    while (container.firstChild) container.removeChild(container.firstChild);

    var filter = null;
    if (o.modeFilter) {
      filter = typeof o.modeFilter.has === "function"
        ? o.modeFilter
        : { has: function (m) { return o.modeFilter.indexOf(m) !== -1; } };
    }

    var cards = (d.cards || []).filter(function (c) {
      return c.hub === hubId && c.campus === campusId;
    });
    var shown = cards.filter(function (c) {
      return !(filter && c.kind === "route" && !filter.has(c.mode));
    });

    if (shown.length) {
      var grid = h("div", { class: "gc-grid" });
      shown.forEach(function (c) { grid.appendChild(renderCard(c, d, o)); });
      container.appendChild(grid);
    } else {
      container.appendChild(h("div", { class: "gc-empty", text: "当前筛选下没有卡片，换个出行方式试试。" }));
    }

    if (hub) {
      var hg = renderHubGuide(hub, campusId, d.campuses);
      if (hg) container.appendChild(hg);
      var hv = renderHubVideo(hub, campusId, d.campuses);
      if (hv) container.appendChild(hv);
      var remark = renderRemark(hub, o);
      if (remark) container.appendChild(remark);
    }
    return container;
  }

  /* ══════════════ 打印 / PDF 文档树 ══════════════
   * 离屏构建，viewer 把它 append 一次，用打印 CSS 切换显隐：
   * 屏幕 UI 包在 #gc-screen 里，打印时隐藏 #gc-screen、显示 .gc-print-root。
   * 第 1 页是标题页（标题 + 枢纽 × 校区路线数矩阵），之后枢纽用色带衔接、
   * 自然分页：色带页眉 → 枢纽指引 → 备注 → 各校区的「枢纽 → 校区」小标题
   * + 卡片（双列 inline-block 逐行填充）。 */
  function buildPrintRoot(data) {
    var d = normalizeData(data);
    var meta = d.meta || {};
    var hubs = (d.hubs || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    var campuses = d.campuses || [];

    /* 枢纽 × 校区 路线数矩阵 */
    var counts = {};
    (d.cards || []).forEach(function (c) {
      if (c.kind !== "route") return;
      counts[c.hub + "|" + c.campus] = (counts[c.hub + "|" + c.campus] || 0) + 1;
    });

    var headRow = h("tr", null, h("th", { text: "" }));
    campuses.forEach(function (camp) {
      headRow.appendChild(h("th", { text: camp.short || camp.label || camp.id }));
    });
    var tbody = h("tbody", null);
    hubs.forEach(function (hub) {
      var tr = h("tr", null, h("td", { class: "gc-print-matrix__hub", text: hub.name }));
      campuses.forEach(function (camp) {
        var n = counts[hub.id + "|" + camp.id] || 0;
        tr.appendChild(h("td", { text: n ? String(n) : "—" }));
      });
      tbody.appendChild(tr);
    });

    var editionLine = [meta.edition, meta.version ? "版本 " + meta.version : "", meta.revisedAt ? "修订于 " + meta.revisedAt : ""]
      .filter(function (s) { return s; }).join(" · ");

    var root = h("div", { class: "gc-print-root" },
      h("section", { class: "gc-print-title" },
        h("h1", { class: "gc-print-title__t", text: meta.title || "" }),
        meta.subtitle ? h("div", { class: "gc-print-title__s", text: meta.subtitle }) : null,
        editionLine ? h("div", { class: "gc-print-title__e", text: editionLine }) : null,
        h("div", { class: "gc-print-matrix__cap", text: "各枢纽前往各校区的路线方案数" }),
        h("table", { class: "gc-print-matrix" }, h("thead", null, headRow), tbody)
      )
    );

    hubs.forEach(function (hub) {
      var sec = h("section", { class: "gc-print-hub" });
      sec.appendChild(h("div", {
        class: "gc-print-hubband", style: "background:" + (hub.color || "#465060"),
      },
        h("span", { class: "gc-print-hubband__n", text: hub.name }),
        hub.note ? h("span", { class: "gc-print-hubband__note", text: hub.note }) : null
      ));
      var phg = renderHubGuide(hub, null, campuses);   /* 打印稿全量显示，带方向标签 */
      if (phg) sec.appendChild(phg);
      var phv = renderHubVideo(hub, null, campuses);   /* 实况指引：步骤图文进打印稿，视频入口由打印 CSS 隐藏 */
      if (phv) sec.appendChild(phv);
      var remark = renderRemark(hub);
      if (remark) sec.appendChild(remark);

      campuses.forEach(function (camp) {
        var cards = (d.cards || []).filter(function (c) {
          return c.hub === hub.id && c.campus === camp.id;
        });
        if (!cards.length) return;
        sec.appendChild(h("h3", { class: "gc-print-subhead",
          text: hub.name + " → " + (camp.label || camp.id) }));
        var box = h("div", { class: "gc-print-cards" });
        cards.forEach(function (c) { box.appendChild(renderCard(c, d)); });
        sec.appendChild(box);
      });
      root.appendChild(sec);
    });

    return root;
  }

  /* ══════════════ 弹出详情 / 提示 ══════════════
   * 热区链接三种去向：#card:<id> 页内滚动到那张卡片；#shumap:<id> 交给
   * opts.onShumapLink（或 onInternalLink）处理；http(s) 新窗口打开。 */
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
          var mCard = l.href.match(/^#card:(.+)$/);
          var mShu = l.href.match(/^#shumap:(.+)$/);
          if (mCard) {
            var target = document.getElementById("card-" + mCard[1]);
            if (target && target.scrollIntoView) {
              target.scrollIntoView({ behavior: "smooth", block: "start" });
              return;
            }
          }
          if (mShu && o.onShumapLink) { o.onShumapLink(mShu[1], l); return; }
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
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closePop(); closeVideoLayer(); } });

  return {
    h: h, esc: esc, RAIL: RAIL, HOT_REF: HOT_REF,
    lineColor: lineColor, lineIcon: lineIcon,
    normalizeData: normalizeData,
    hubFigures: hubFigures, hubVideos: hubVideos, appliesTo: appliesTo,
    allIcons: allIcons, iconById: iconById, renderIcon: renderIcon,
    sanitizeRichHtml: sanitizeRichHtml,
    renderCard: renderCard, renderRouteCard: renderRouteCard,
    renderFigureCard: renderFigureCard, renderStepsCard: renderStepsCard,
    renderTimeline: renderTimeline, renderStepsBody: renderStepsBody,
    figureSrc: figureSrc,
    renderHubGuide: renderHubGuide, renderHubVideo: renderHubVideo,
    renderRemark: renderRemark, renderPairView: renderPairView,
    buildPrintRoot: buildPrintRoot,
    toast: toast, closePop: closePop, openPop: openPop,
  };
})();

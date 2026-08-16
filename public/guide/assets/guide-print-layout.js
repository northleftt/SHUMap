/* 返校指南 · 打印排版模块（window.GuidePrintLayout）
 *
 * 为什么存在：PDF 导出曾经把分页整个交给浏览器打印引擎 —— 双列卡片靠
 * inline-block + nth-child 奇偶配对，某张卡被 break-inside:avoid 挤到下一页后，
 * 后续配对整体漂移，「错版」频出；编辑器预览又是另一套屏幕排版，无法提前发现。
 *
 * 这里改成显式分页：buildPrintRoot 的产物挂到 186mm（A4 减 12mm×2 边距）实宽的
 * 离屏容器里量出每个原子块的高度，pack() 把块装进一页一页 PAGE_H_MM 高的页面，
 * renderPaged() 重组为 .gc-print-page 树。编辑器预览和真实打印用同一棵分页后的
 * DOM（版式 CSS 常显，见 guide-styles.js），所见即所得。
 *
 * 可调设置（随指南数据持久化，schema v2 原样透传）：
 *   hub.printBreakBefore  —— 该枢纽从新的一页开始
 *   card.printBreakBefore —— 该卡片（所在的行）从新的一页开始
 *   card.printSpan === 2  —— 卡片独占整行（默认 1，双列配对）
 *   card.printDensity     —— "compact" | "loose"（默认标准）卡片疏密
 *   card.printImgW        —— 图示卡图片宽度百分比（40–99，默认 100）
 *
 * pack 是纯函数（不碰 DOM），node 测试直接喂高度数组即可。 */
(function () {
  "use strict";

  var PAGE_W_MM = 186;   /* A4 210 − 12×2 页边距 */
  var PAGE_H_MM = 273;   /* A4 297 − 12×2 */
  var ROW_GAP_MM = 4;    /* .gc-print-cards>.gc-card 的 margin-bottom */
  /* 装页安全边距：屏幕测量与真实打印渲染存在毫米级差异（实测一页图文混排
     能差出 ~3mm），贴着页高装页会在打印时把末尾整块（break-inside:avoid）
     挤到下一页 —— 页数与预览不一致。按 267mm 装页，页底留 6mm 余量吸收误差：
     肉眼几乎不可见，但预览和 PDF 逐页一致。 */
  var SAFETY_MM = 6;
  var FIT_TOLERANCE = 0.1;

  /* ══════════════ pack：分页核心（纯函数） ══════════════
   * 输入块序列（按文档顺序）：
   *   {type:"title"|"band"|"block"|"subhead"|"card", hmm: 毫米高,
   *    span?: 1|2, breakBefore?: bool, keepWithNext?: bool, id?: string}
   * 卡片两两配成行（行高 = 较大者 + 行间距），span:2 独占整行；
   * keepWithNext 的块（色带、小标题）放不进「自身 + 下一块」时整体推下一页；
   * breakBefore 强制新起一页；比整页还高的块照样放下并记入 overflows。
   * 返回 {pages: [[unit…], …], overflows: [{id, hmm, ref}]}。 */
  function pack(units, pageHmm) {
    pageHmm = pageHmm || PAGE_H_MM;
    var limit = pageHmm - SAFETY_MM;   /* 装页上限；overflow 判定仍按整页高 */

    /* 第一步：把连续的 card 配成 row，行是之后最小的分页单位 */
    var seq = [];
    var pending = null;
    function rowOf(cards) {
      var hmm = 0;
      cards.forEach(function (c) { if (c.hmm > hmm) hmm = c.hmm; });
      return {
        type: "row", cards: cards, hmm: hmm + ROW_GAP_MM,
        breakBefore: !!cards[0].breakBefore, id: cards[0].id,
      };
    }
    function flushPending() { if (pending) { seq.push(rowOf([pending])); pending = null; } }
    (units || []).forEach(function (u) {
      if (u.type === "card") {
        if (u.span === 2) { flushPending(); seq.push(rowOf([u])); return; }
        if (u.breakBefore) { flushPending(); pending = u; return; }
        if (pending) { seq.push(rowOf([pending, u])); pending = null; }
        else pending = u;
        return;
      }
      flushPending();
      seq.push(u);
    });
    flushPending();

    /* 第二步：顺序装页 */
    var pages = [], cur = [], curH = 0, overflows = [];
    function closePage() { if (cur.length) pages.push(cur); cur = []; curH = 0; }
    function fits(h) { return curH + h <= limit + FIT_TOLERANCE; }
    /* prevKeepsAlone：上一块带 keepWithNext 且独占当前页 —— 这一块必须跟它同页，
       否则色带/小标题会孤悬一页（两块合计超限时宁肯一起溢出也不拆开） */
    var prevKeepsAlone = false;
    for (var i = 0; i < seq.length; i++) {
      var u = seq[i];
      if (u.hmm > pageHmm) {
        overflows.push({
          id: u.id || u.type,
          hmm: Math.round(u.hmm * 10) / 10,
          ref: u.el || (u.cards && u.cards[0] && u.cards[0].el) || null,
        });
      }
      if (u.type === "title") {          /* 标题页恒独占第 1 页 */
        closePage(); cur.push(u); curH += u.hmm; closePage();
        prevKeepsAlone = false; continue;
      }
      if (u.breakBefore && !prevKeepsAlone) closePage();
      var need = u.hmm;
      if (u.keepWithNext && i + 1 < seq.length) need += seq[i + 1].hmm;
      if (!prevKeepsAlone && !fits(need) && cur.length) closePage();
      cur.push(u); curH += u.hmm;
      prevKeepsAlone = !!u.keepWithNext && cur.length === 1;
    }
    closePage();
    return { pages: pages, overflows: overflows };
  }

  /* ══════════════ per-card 排版偏好 ══════════════
   * 在测量之前应用，保证量到的高度就是打印高度：
   *   card.printSpan === 2        → data-span="2"（独占整行，CSS 生效）
   *   card.printDensity           → data-density="compact|loose"（卡片疏密）
   *   card.printImgW（40–99，%）  → 图示卡图片宽度，等比缩放、居中
   * 这三个字段都在数据里随版本持久化，编辑器排版预览的工具条写入。 */
  function applyPrintPrefs(root, data) {
    var cards = {};
    ((data && data.cards) || []).forEach(function (c) { cards[c.id] = c; });
    root.querySelectorAll(".gc-card[data-card-id]").forEach(function (el) {
      var c = cards[el.getAttribute("data-card-id")] || {};
      if (c.printSpan === 2) el.setAttribute("data-span", "2");
      else el.removeAttribute("data-span");
      if (c.printDensity === "compact" || c.printDensity === "loose")
        el.setAttribute("data-density", c.printDensity);
      else el.removeAttribute("data-density");
      var wrap = el.querySelector(".gc-figwrap");
      if (wrap) {
        var w = Number(c.printImgW);
        if (w >= 40 && w < 100) {
          wrap.style.width = w + "%";
          wrap.style.marginLeft = "auto";
          wrap.style.marginRight = "auto";
        } else {
          wrap.style.width = "";
          wrap.style.marginLeft = "";
          wrap.style.marginRight = "";
        }
      }
    });
  }

  /* ══════════════ 测量（DOM，浏览器端） ══════════════ */

  function pxPerMm() {
    var d = document.createElement("div");
    d.style.cssText = "position:absolute;visibility:hidden;height:100mm;width:10mm";
    document.body.appendChild(d);
    var v = d.offsetHeight / 100;
    d.remove();
    return v || 3.7795;   /* 96dpi 理论值兜底 */
  }

  function heightMm(el, ppm) {
    return el.getBoundingClientRect().height / ppm;
  }
  function marginsMm(el, ppm) {
    var cs = window.getComputedStyle(el);
    return ((parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)) / ppm;
  }

  /* 把打印树拍平成原子块序列。比整页还高且有多个子块的容器递归拆到子块，
     尽量避免一整块（如多小节的实况指引）塞不进任何一页。 */
  function collectUnits(root, data, ppm) {
    var cards = {}, hubs = {};
    ((data && data.cards) || []).forEach(function (c) { cards[c.id] = c; });
    ((data && data.hubs) || []).forEach(function (hb) { hubs[hb.id] = hb; });

    var units = [];
    function pushBlock(el, opts) {
      var hmm = heightMm(el, ppm) + marginsMm(el, ppm);
      if (hmm > PAGE_H_MM && el.children.length > 1) {
        Array.prototype.forEach.call(el.children, function (ch) { pushBlock(ch, opts); });
        return;
      }
      var u = { type: "block", el: el, hmm: hmm };
      if (opts) for (var k in opts) u[k] = opts[k];
      units.push(u);
    }

    Array.prototype.forEach.call(root.children, function (top) {
      if (top.classList.contains("gc-print-title")) {
        units.push({ type: "title", el: top, hmm: heightMm(top, ppm) });
        return;
      }
      if (!top.classList.contains("gc-print-hub")) { pushBlock(top); return; }
      var hubId = top.getAttribute("data-hub-id") || "";
      var hub = hubs[hubId] || {};
      Array.prototype.forEach.call(top.children, function (child) {
        if (child.classList.contains("gc-print-hubband")) {
          units.push({
            type: "band", id: "hub:" + hubId, hubId: hubId, el: child,
            hmm: heightMm(child, ppm) + marginsMm(child, ppm),
            keepWithNext: true, breakBefore: !!hub.printBreakBefore,
          });
        } else if (child.classList.contains("gc-print-subhead")) {
          units.push({
            type: "subhead", el: child,
            hmm: heightMm(child, ppm) + marginsMm(child, ppm),
            keepWithNext: true,
          });
        } else if (child.classList.contains("gc-print-cards")) {
          Array.prototype.forEach.call(child.children, function (cardEl) {
            var cid = cardEl.getAttribute("data-card-id") || "";
            var c = cards[cid] || {};
            /* 宽度已由 applyPrintPrefs 设置好（span:2 走 data-span 的 CSS 整行宽），
               直接量即可 */
            units.push({
              type: "card", id: "card:" + cid, cardId: cid, el: cardEl,
              hmm: heightMm(cardEl, ppm),
              span: c.printSpan === 2 ? 2 : 1,
              breakBefore: !!c.printBreakBefore,
            });
          });
        } else {
          pushBlock(child);
        }
      });
    });
    return units;
  }

  /* ══════════════ 重组为分页树 ══════════════
   * 块从测量树里搬进来（appendChild 是移动不是复制）。行内卡片回到
   * inline-block 双列容器：每页一个 .gc-print-cards、从配对边界开始，
   * 奇偶配对因此与 pack 的行模型一致。 */
  function renderPaged(packed) {
    var out = document.createElement("div");
    out.className = "gc-print-root";
    packed.pages.forEach(function (units, pi) {
      var page = document.createElement("div");
      page.className = "gc-print-page";
      var cardsBox = null;
      units.forEach(function (u) {
        if (u.type === "row") {
          if (!cardsBox) {
            cardsBox = document.createElement("div");
            cardsBox.className = "gc-print-cards";
            page.appendChild(cardsBox);
          }
          u.cards.forEach(function (c) {
            if (c.span === 2) c.el.setAttribute("data-span", "2");
            else c.el.removeAttribute("data-span");
            cardsBox.appendChild(c.el);
          });
          return;
        }
        cardsBox = null;
        if (u.type === "band" && u.hubId) u.el.setAttribute("data-hub-id", u.hubId);
        page.appendChild(u.el);
      });
      var no = document.createElement("div");
      no.className = "gc-print-page__no";
      no.textContent = "第 " + (pi + 1) + " 页 / 共 " + packed.pages.length + " 页";
      page.appendChild(no);
      out.appendChild(page);
    });
    return out;
  }

  /* ══════════════ 一站式入口 ══════════════
   * buildPrintRoot → 离屏 186mm 实宽测量（等图片就绪）→ pack → 分页树。
   * 返回 Promise<{root, pages, overflows}>；root 不带 .gc-on —— 屏幕预览
   * 由调用方加，前台/打印路径保持屏幕隐藏。 */
  function layout(data, opts) {
    opts = opts || {};
    var R = window.GuideRender;
    var raw = R.buildPrintRoot(data);
    applyPrintPrefs(raw, data);   /* 先应用 per-card 偏好再测量，量到的就是打印高度 */
    var mount = document.createElement("div");
    mount.style.cssText = "position:absolute;left:-12000px;top:0;width:" + PAGE_W_MM + "mm";
    raw.classList.add("gc-on");   /* 版式规则常显，离屏测量与打印同宽同字号 */
    mount.appendChild(raw);
    document.body.appendChild(mount);
    return new Promise(function (resolve) {
      R.whenPrintReady(raw, resolve);
    }).then(function () {
      var ppm = pxPerMm();
      var units = collectUnits(raw, data, ppm);
      var packed = pack(units, opts.pageHmm);
      var root = renderPaged(packed);
      mount.remove();
      return { root: root, pages: packed.pages, overflows: packed.overflows };
    });
  }

  window.GuidePrintLayout = {
    PAGE_W_MM: PAGE_W_MM,
    PAGE_H_MM: PAGE_H_MM,
    ROW_GAP_MM: ROW_GAP_MM,
    pack: pack,
    layout: layout,
  };
})();

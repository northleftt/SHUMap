/*
 * guide-versions.js — 指南内容的版本管理
 *
 * 为什么需要它：这份内容每年开学前要改一轮（票价调整、线路改道、新增枢纽），
 * 而错一个数字就会让新生坐错车。所以需要能「存一版、比一比、退回去」，
 * 而不是只有一份随时被覆盖的 localStorage 草稿。
 *
 * 存储布局（每版一个键，而不是全部塞进一个键）：
 *   shu-guide-vindex   → 索引：[{id,name,note,createdAt,stats,hash}, ...]
 *   shu-guide-ver:<id> → 该版本的完整数据快照（JSON）
 *   shu-guide-vcur     → 当前「已发布」版本的 id
 * 分键存的原因：保存新版本时只写一个键，不必把所有历史快照重新序列化一遍；
 * 单版约 40-60KB，localStorage 5MB 上限下够存几十版，超了会给明确提示。
 *
 * 合入 SHUMap 后，这一层换成 D1 + releases 表即可：对外接口（list/save/
 * restore/diff）保持不变，只把 STORE 换成一个走 fetch 的适配器。
 */
window.GuideVersions = (function () {
  "use strict";

  var IDX_KEY = "shu-guide-vindex";
  var CUR_KEY = "shu-guide-vcur";
  var VER_PREFIX = "shu-guide-ver:";
  var MAX_VERSIONS = 40;   /* 超过就提示先删旧版，避免写满配额后静默失败 */

  /* localStorage 在 file:// 或沙箱里可能直接抛 SecurityError，
     所以每次读写都包一层；失败时退化成「内存版本库」，
     至少当前会话内可用，刷新丢失但不会把页面搞崩。 */
  var memory = {};
  var usable = (function () {
    try {
      var k = "__guide_probe__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  })();

  function readRaw(k) {
    if (!usable) return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null;
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function writeRaw(k, v) {
    if (!usable) { memory[k] = v; return true; }
    try { localStorage.setItem(k, v); return true; }
    catch (e) {
      /* 配额写满：QuotaExceededError（Safari 里是 QUOTA_EXCEEDED_ERR） */
      throw new Error("本地存储已写满，请先删除旧版本再保存（" + (e.name || "QuotaExceeded") + "）");
    }
  }
  function dropRaw(k) {
    if (!usable) { delete memory[k]; return; }
    try { localStorage.removeItem(k); } catch (e) {}
  }

  function readJson(k, fallback) {
    var raw = readRaw(k);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  /* ── 内容指纹 ────────────────────────────────────────
     djb2 over JSON。只用来判断「两版内容是否相同」和给版本列表一个短标识，
     不做任何安全用途（不抗碰撞构造，也不需要）。 */
  function fingerprint(obj) {
    var s = stableJson(obj);
    var hash = 5381;
    for (var i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  /* JSON.stringify 的键顺序跟对象构造顺序有关，同样内容换个录入顺序
     指纹就会变。这里按键名排序后再序列化，指纹才真正对应「内容」。 */
  function stableJson(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
    var keys = Object.keys(v).sort();
    return "{" + keys.map(function (k) {
      return JSON.stringify(k) + ":" + stableJson(v[k]);
    }).join(",") + "}";
  }

  /* ── 统计：版本列表上给出「这一版有多少内容」 ─────────── */
  function statsOf(data) {
    var cards = (data && data.cards) || [];
    var byKind = {};
    cards.forEach(function (c) {
      var k = c.kind || "route";
      byKind[k] = (byKind[k] || 0) + 1;
    });
    return {
      groups: ((data && data.groups) || []).length,
      cards: cards.length,
      byKind: byKind,
      hubs: ((data && data.cover && data.cover.hubs) || []).length,
    };
  }

  function nowIso() { return new Date().toISOString(); }

  function newId() {
    /* 时间前缀让 id 天然按时间排序，后缀防同秒冲突 */
    return "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ── 索引读写 ───────────────────────────────────────── */
  function index() {
    var list = readJson(IDX_KEY, []);
    return Array.isArray(list) ? list : [];
  }
  function writeIndex(list) {
    writeRaw(IDX_KEY, JSON.stringify(list));
  }

  function list() {
    var cur = currentId();
    return index().slice().sort(function (a, b) {
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    }).map(function (m) {
      var copy = {};
      for (var k in m) copy[k] = m[k];
      copy.isCurrent = m.id === cur;
      return copy;
    });
  }

  function meta(id) {
    return index().filter(function (m) { return m.id === id; })[0] || null;
  }

  /* 取某一版的完整数据。返回深拷贝 —— 调用方拿去随便改，
     不会污染存储里的快照。 */
  function get(id) {
    var m = meta(id);
    if (!m) return null;
    var data = readJson(VER_PREFIX + id, null);
    if (!data) return null;
    return { meta: m, data: data };
  }

  function restore(id) {
    var rec = get(id);
    if (!rec) throw new Error("版本不存在或数据已丢失：" + id);
    return JSON.parse(JSON.stringify(rec.data));
  }

  /* ── 保存 ───────────────────────────────────────────
     同内容重复保存会被拒绝（返回 existing），避免版本列表里堆一串
     指纹相同的版本，回溯时根本分不清该退到哪一版。 */
  function save(data, opts) {
    var o = opts || {};
    if (!data || !data.cards || !data.cover)
      throw new Error("数据不完整（缺少 cover / cards），拒绝存版");

    var hash = fingerprint(data);
    var idx = index();

    if (!o.force) {
      var same = idx.filter(function (m) { return m.hash === hash; })[0];
      if (same) return { created: false, existing: same };
    }
    if (idx.length >= MAX_VERSIONS)
      throw new Error("版本数已达上限 " + MAX_VERSIONS + "，请先删除旧版本");

    var id = newId();
    var m = {
      id: id,
      name: (o.name || "").trim() || defaultName(data),
      note: (o.note || "").trim(),
      edition: (data.meta && data.meta.edition) || "",
      createdAt: nowIso(),
      hash: hash,
      stats: statsOf(data),
    };

    /* 先写快照再写索引：万一写快照时配额爆了，索引里不会留下
       指向空数据的幽灵条目。 */
    writeRaw(VER_PREFIX + id, JSON.stringify(data));
    try {
      idx.push(m);
      writeIndex(idx);
    } catch (e) {
      dropRaw(VER_PREFIX + id);   /* 回滚，保持索引与快照一致 */
      throw e;
    }
    if (o.makeCurrent) setCurrent(id);
    return { created: true, meta: m };
  }

  function defaultName(data) {
    var ed = (data.meta && data.meta.edition) || "未命名";
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return ed + " · " + (d.getMonth() + 1) + "月" + d.getDate() + "日 " +
           pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function update(id, patch) {
    var idx = index();
    var hit = idx.filter(function (m) { return m.id === id; })[0];
    if (!hit) throw new Error("版本不存在：" + id);
    if (patch && typeof patch.name === "string") hit.name = patch.name.trim() || hit.name;
    if (patch && typeof patch.note === "string") hit.note = patch.note;
    writeIndex(idx);
    return hit;
  }

  function remove(id) {
    var idx = index().filter(function (m) { return m.id !== id; });
    writeIndex(idx);
    dropRaw(VER_PREFIX + id);
    if (currentId() === id) dropRaw(CUR_KEY);
    return true;
  }

  function currentId() { return readRaw(CUR_KEY) || ""; }
  function setCurrent(id) {
    if (id && !meta(id)) throw new Error("版本不存在：" + id);
    if (id) writeRaw(CUR_KEY, id); else dropRaw(CUR_KEY);
    return id;
  }

  /* ── 结构化对比 ──────────────────────────────────────
     不做逐字符 diff：那对「哪条线路改了」没有帮助。
     按 id 对齐 groups / cards，报出新增、删除、内容变动三类，
     变动项再给出具体改了哪些字段 —— 复核时能直接盯着那几项看。 */
  function diff(a, b) {
    return {
      meta: diffObject((a && a.meta) || {}, (b && b.meta) || {}),
      cover: fingerprint((a && a.cover) || {}) === fingerprint((b && b.cover) || {})
        ? null : "目录内容有变动",
      groups: diffList((a && a.groups) || [], (b && b.groups) || []),
      cards: diffList((a && a.cards) || [], (b && b.cards) || []),
    };
  }

  function byId(arr) {
    var m = {};
    (arr || []).forEach(function (x) { if (x && x.id) m[x.id] = x; });
    return m;
  }

  function diffList(a, b) {
    var ma = byId(a), mb = byId(b);
    var added = [], removed = [], changed = [];
    Object.keys(mb).forEach(function (id) {
      if (!ma[id]) added.push({ id: id, label: labelOf(mb[id]) });
      else if (fingerprint(ma[id]) !== fingerprint(mb[id]))
        changed.push({ id: id, label: labelOf(mb[id]), fields: changedFields(ma[id], mb[id]) });
    });
    Object.keys(ma).forEach(function (id) {
      if (!mb[id]) removed.push({ id: id, label: labelOf(ma[id]) });
    });
    return { added: added, removed: removed, changed: changed };
  }

  function labelOf(x) {
    if (!x) return "";
    if (x.title) return x.title;
    if (x.hub && x.hub.name) return x.hub.name + (x.modeLabel ? " · " + x.modeLabel : "");
    return x.id || "";
  }

  /* 顶层字段级比较。嵌套结构（legs / hotspots / sections）只报「有变动」
     和条目数变化 —— 再往深处报，复核清单会长到没人看。 */
  function changedFields(a, b) {
    var keys = {}, out = [];
    Object.keys(a || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(b || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      var va = a ? a[k] : undefined, vb = b ? b[k] : undefined;
      if (fingerprint(va === undefined ? null : va) === fingerprint(vb === undefined ? null : vb)) return;
      if (Array.isArray(va) || Array.isArray(vb)) {
        var na = Array.isArray(va) ? va.length : 0;
        var nb = Array.isArray(vb) ? vb.length : 0;
        out.push(k + (na === nb ? "（内容有变）" : "（" + na + " → " + nb + " 项）"));
      } else if (va && typeof va === "object" || vb && typeof vb === "object") {
        out.push(k + "（内容有变）");
      } else {
        out.push(k + "：" + fmt(va) + " → " + fmt(vb));
      }
    });
    return out;
  }

  function fmt(v) {
    if (v === undefined || v === null || v === "") return "空";
    if (typeof v === "string" && v.length > 24) return v.slice(0, 24) + "…";
    return String(v);
  }

  function diffObject(a, b) {
    return changedFields(a, b);
  }

  /* diff 结果压成一行摘要，给版本列表用 */
  function summarize(d) {
    var parts = [];
    var push = function (label, x) {
      var bits = [];
      if (x.added.length) bits.push("+" + x.added.length);
      if (x.removed.length) bits.push("-" + x.removed.length);
      if (x.changed.length) bits.push("~" + x.changed.length);
      if (bits.length) parts.push(label + " " + bits.join(" "));
    };
    push("卡片", d.cards);
    push("分组", d.groups);
    if (d.meta && d.meta.length) parts.push("文档信息 ~" + d.meta.length);
    if (d.cover) parts.push("目录有变");
    return parts.length ? parts.join(" · ") : "内容一致";
  }

  /* ── 导出 / 导入 ─────────────────────────────────────
     带版本元信息的信封格式，和「导出纯 guide-data.json」区分开：
     信封能带上版本名、备注、指纹，导入时可以校验数据没被改坏。 */
  function envelope(id) {
    var rec = get(id);
    if (!rec) throw new Error("版本不存在：" + id);
    return {
      kind: "shu-guide-version",
      schema: 1,
      exportedAt: nowIso(),
      meta: rec.meta,
      data: rec.data,
    };
  }

  function importEnvelope(obj, opts) {
    var o = opts || {};
    if (!obj || typeof obj !== "object") throw new Error("文件内容不是 JSON 对象");

    /* 两种都接受：版本信封，或者裸的 guide-data */
    var data = obj.kind === "shu-guide-version" ? obj.data : obj;
    if (!data || !data.cards || !data.cover)
      throw new Error("缺少 cover / cards，不像是指南数据");

    var m = (obj.kind === "shu-guide-version" && obj.meta) || {};
    if (m.hash && fingerprint(data) !== m.hash)
      throw new Error("指纹校验不通过：文件里的数据与导出时不一致");

    return save(data, {
      name: o.name || m.name || "",
      note: o.note || m.note || "由文件导入",
      makeCurrent: !!o.makeCurrent,
      force: true,   /* 导入是显式动作，即使内容与已有版本相同也照存 */
    });
  }

  return {
    list: list, meta: meta, get: get, save: save, update: update, remove: remove,
    restore: restore, currentId: currentId, setCurrent: setCurrent,
    diff: diff, summarize: summarize, statsOf: statsOf, fingerprint: fingerprint,
    envelope: envelope, importEnvelope: importEnvelope,
    storageUsable: function () { return usable; },
    MAX_VERSIONS: MAX_VERSIONS,
  };
})();

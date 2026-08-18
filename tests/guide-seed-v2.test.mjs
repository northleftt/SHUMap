// 返校指南种子数据的 schema v2 契约。
//
// 为什么钉这个：种子文件是前台 / 编辑器 / 导出三个出口共读的出厂内容，
// v1 → v2 迁移（scripts/convert-guide-seed-v2.mjs）改变了卡片寻址方式 ——
// group+page 分段层删除，卡片直接挂 hub / campus 两个 id。渲染层按 id 反查
// 枢纽与校区，任何一张卡片指向不存在的 id 都会在页面上静默缺块。
// 另外路线卡的「发车时刻表」从线路 notes 提取到卡片级 schedule，
// 提取漏掉一条，学生就看不到班次时刻。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seedFile = path.join(root, "public", "guide", "data", "guide-seed.js");

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(seedFile, "utf8"), sandbox, { filename: seedFile });
const data = sandbox.window.GUIDE_DATA;

assert.ok(data, "guide-seed.js 应求值出 window.GUIDE_DATA");

test("seed declares schema v2 and drops the v1 cover/groups layers", () => {
  assert.equal(data.schema, 2);
  assert.ok(!("cover" in data), "v2 不再有 cover");
  assert.ok(!("groups" in data), "v2 不再有 groups");
});

test("seed lineColors is a library of {fill,text,label}, including black-ink lines", () => {
  const map = data.lineColors;
  assert.equal(typeof map, "object");
  for (const [key, entry] of Object.entries(map)) {
    assert.equal(typeof entry, "object", `${key} 应为色库对象而不是裸 hex`);
    assert.match(entry.fill, /^#[0-9A-Fa-f]{6}$/, `${key}.fill`);
    assert.match(entry.text, /^#[0-9A-Fa-f]{6}$/, `${key}.text`);
    assert.equal(typeof entry.label, "string");
  }
  assert.equal(map.l2.text.toLowerCase(), "#111111", "2 号线黑字");
  assert.equal(map.l7.text.toLowerCase(), "#111111", "7 号线黑字");
  assert.equal(map.l1.text.toLowerCase(), "#ffffff", "1 号线白字");
});

test("every card carries hub/campus id refs that resolve, and no group/page", () => {
  const hubIds = new Set(data.hubs.map((h) => h.id));
  const campusIds = new Set(data.campuses.map((c) => c.id));
  assert.ok(data.cards.length > 0, "种子不应为空");
  for (const card of data.cards) {
    assert.equal(typeof card.hub, "string", `${card.id} 缺 hub id`);
    assert.equal(typeof card.campus, "string", `${card.id} 缺 campus id`);
    assert.ok(hubIds.has(card.hub), `${card.id} 的 hub "${card.hub}" 不在 hubs 里`);
    assert.ok(campusIds.has(card.campus), `${card.id} 的 campus "${card.campus}" 不在 campuses 里`);
    assert.ok(!("group" in card), `${card.id} 不应再有 group`);
    assert.ok(!("page" in card), `${card.id} 不应再有 page`);
  }
});

test("route cards carry note/schedule, and origin replaces the old hub object", () => {
  const routes = data.cards.filter((c) => c.kind === "route");
  assert.ok(routes.length > 0);
  for (const card of routes) {
    assert.ok(Array.isArray(card.schedule), `${card.id}.schedule 必须是数组`);
    assert.equal(typeof card.note, "string", `${card.id}.note 必须是字符串`);
    for (const entry of card.schedule) {
      assert.equal(typeof entry.label, "string");
      assert.equal(typeof entry.times, "string");
      assert.ok(entry.times.trim(), `${card.id} 的 schedule 条目时刻为空`);
    }
    // v1 的 hub 对象 {name,note} 改名 origin；hub 现在是 id 字符串
    if (card.origin !== undefined) {
      assert.equal(typeof card.origin, "object");
      assert.equal(typeof card.origin.name, "string");
    }
  }
});

test("hubs have the v2 shape: id/name/color/order plus media and remark fields", () => {
  assert.ok(data.hubs.length > 0, "hubs 不应为空");
  const orders = new Set();
  for (const hub of data.hubs) {
    assert.equal(typeof hub.id, "string");
    assert.equal(typeof hub.name, "string");
    assert.equal(typeof hub.color, "string");
    assert.equal(typeof hub.order, "number");
    assert.ok(!orders.has(hub.order), `hub order ${hub.order} 重复`);
    orders.add(hub.order);
    assert.ok(Array.isArray(hub.guideFigures), `hub ${hub.id} 应有 guideFigures 数组`);
    for (const f of hub.guideFigures) {
      assert.equal(typeof f.src, "string");
      assert.ok(!f.campuses || Array.isArray(f.campuses));
    }
    assert.ok(Array.isArray(hub.guideVideos), `hub ${hub.id} 应有 guideVideos 数组`);
    for (const v of hub.guideVideos) {
      assert.equal(typeof v.url, "string");
      assert.ok(!v.campuses || Array.isArray(v.campuses));
    }
    assert.equal(typeof hub.remark, "string");
    // v1 目录字段不得残留
    for (const dropped of ["entries", "page", "tail"]) {
      assert.ok(!(dropped in hub), `hub ${hub.id} 不应再有 ${dropped}`);
    }
  }
});

test("scene guidance lives on hubs (sceneGuide), not as standalone steps cards", () => {
  // 实景指引/换乘指南绑在枢纽的「实况指引」上：cards 里不再有 steps 卡，
  // campuses 里不再有「实景指引」校区，枢纽用 sceneGuide 承载小节图文。
  assert.ok(!data.cards.some((c) => c.kind === "steps"), "cards 里不应再有 steps 卡");
  assert.ok(!data.campuses.some((c) => c.id === "scene"), "campuses 里不应再有 scene");

  const withScene = data.hubs.filter((h) => h.sceneGuide);
  assert.ok(withScene.length >= 5, "至少 5 个枢纽应有 sceneGuide（虹桥/上海站/南站/浦东/附录）");
  for (const hub of withScene) {
    const sg = hub.sceneGuide;
    assert.ok(Array.isArray(sg.sections), `hub ${hub.id} sceneGuide.sections 必须是数组`);
    for (const sec of sg.sections) {
      assert.equal(typeof sec.title, "string");
      assert.ok(Array.isArray(sec.steps), `hub ${hub.id} 小节「${sec.title}」缺 steps`);
      for (const st of sec.steps) assert.equal(typeof st.text, "string");
    }
  }
  // 松江站换乘指南的 pending（车次表待录入）要跟着迁过去
  const appendix = data.hubs.find((h) => h.id === "appendix");
  assert.ok(appendix?.sceneGuide?.pending, "appendix 枢纽的 sceneGuide 应保留 pending");
});

test("sceneGuide section campus tags reference real campuses and match route coverage", () => {
  // 实况指引小节可声明 campuses（只在该校区方向显示），不声明 = 通用。
  // 打错校区 id 会让小节在任何方向都看不见；只通公交的枢纽小节漏打标签，
  // 会让乘地铁的学生看到一段用不上的指引。
  const campusIds = new Set(data.campuses.map((c) => c.id));
  for (const hub of data.hubs) {
    for (const sec of hub.sceneGuide?.sections || []) {
      for (const id of sec.campuses || []) {
        assert.ok(campusIds.has(id), `hub ${hub.id} 小节「${sec.title}」引用了不存在的校区 ${id}`);
      }
    }
  }
  const secOf = (hubId, titlePart) =>
    data.hubs.find((h) => h.id === hubId).sceneGuide.sections.find((s) => s.title.includes(titlePart));
  // 嘉虹1线 / 虹桥枢纽9路 / 上嘉线都只到嘉定：这三个小节必须只标嘉定
  //（种子在 vm 里求值，数组原型与本域不同，先摊平成本域数组再比）
  assert.deepEqual([...secOf("hongqiao", "嘉虹1线").campuses], ["jiading"]);
  assert.deepEqual([...secOf("hongqiao", "虹桥枢纽9路").campuses], ["jiading"]);
  assert.deepEqual([...secOf("shanghai-south", "上嘉线").campuses], ["jiading"]);
  // 上海站出站口选择、浦东机场、松江换乘指南是各方向通用：不得打标签
  assert.ok(!secOf("shanghai-railway", "出站口选择").campuses, "出站口选择应通用");
  assert.ok(!secOf("pudong-airport", "磁浮").campuses, "浦东机场小节应通用");
});

test("sceneGuide figure refs that point at /guide/figures/ exist on disk", () => {
  // 实景照片是随站点部署的静态文件（不走 R2）。种子写了路径而文件缺失时，
  // 前台只会静默出现裂图，所以这里把每个本地引用都钉到磁盘上。
  const refs = [];
  for (const hub of data.hubs) {
    for (const sec of hub.sceneGuide?.sections || []) {
      for (const fig of sec.figures || []) refs.push(fig.src);
      for (const st of sec.steps || []) {
        const figs = Array.isArray(st.figure) ? st.figure : st.figure ? [st.figure] : [];
        refs.push(...figs);
      }
    }
  }
  assert.ok(refs.length > 0, "sceneGuide 应至少引用一张照片");
  for (const ref of refs) {
    if (!ref.startsWith("/")) continue; // R2 asset key 不在本测试范围
    assert.ok(
      fs.existsSync(path.join(root, "public", ref)),
      `引用的图片不存在: ${ref}`,
    );
  }
});

test("schedule notes embedded in route legs were lifted to card-level schedule", () => {
  const west = data.cards.find((c) => c.id === "hq-jd-bus-west");
  assert.ok(west, "缺卡片 hq-jd-bus-west");
  assert.ok(west.schedule.length > 0, "hq-jd-bus-west 应提取出嘉虹1路发车时刻");
  assert.match(west.schedule[0].label, /嘉虹1路/);
  assert.match(west.schedule[0].times, /08:30/);
  // 提取后线路 notes 里不得残留发车时刻表，其余说明保留
  const line = west.legs.flatMap((l) => l.lines || []).find((l) => l.no === "嘉虹1路");
  assert.ok(line.notes.some((n) => n.includes("提前购票")));
  assert.ok(!line.notes.some((n) => n.startsWith("发车时刻表")));

  // 多行写法的两张卡也要提取
  for (const id of ["sh-jd-bus", "ss-jd-bus"]) {
    const card = data.cards.find((c) => c.id === id);
    assert.ok(card, `缺卡片 ${id}`);
    assert.ok(card.schedule.length > 0, `${id} 应提取出发车时刻`);
    assert.ok(card.schedule[0].times.includes("\n"), `${id} 的多行时刻应保留换行`);
  }

  // 全量扫描：任何线路 notes 里都不许再残留「发车时刻表」
  for (const card of data.cards) {
    for (const leg of card.legs || []) {
      for (const l of leg.lines || []) {
        for (const n of l.notes || []) {
          assert.ok(!n.startsWith("发车时刻表"), `${card.id} 的 ${l.no} 仍残留发车时刻表 note`);
        }
      }
    }
  }
});

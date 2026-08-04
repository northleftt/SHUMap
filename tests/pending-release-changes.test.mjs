import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on;");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((value) => value.endsWith(".sql")).sort()) {
    db.exec(read(`migrations-v2/${name}`));
  }
  return db;
}

// 「地图数据只来自 release」这条约定的代价：后台改完，用户端要等下一次发版才会变。
// 此前后台没有任何地方提示这件事，改完看不到效果时无从判断是自己填错了还是只差一次
// 发版。这组测试盯住那个判断依据本身。

test("the pending diff filters exactly like the release candidate query", () => {
  const source = read("worker/modules/releases.ts");
  const candidate = source.slice(source.indexOf("async function buildCandidate"), source.indexOf("async function loadReleaseMapFilters"));
  const pending = source.slice(source.indexOf("export async function pendingReleaseChanges"));
  assert.ok(candidate.length > 0 && pending.length > 0, "两段代码都要能找到");

  // 三条过滤条件必须逐字一致。差一条就会出现「这里说有改动，发版却不带它」，
  // 那比没有提示更糟——人会以为发过了。
  for (const clause of [
    /places?[\s\S]{0,400}?lifecycle_status<>'retired' and p\.approval_pending=0 and r\.editorial_status='approved'/,
    /facility_instances[\s\S]{0,400}?lifecycle_status='active' and f\.approval_pending=0 and r\.editorial_status='approved'/,
    /merchant_outlets[\s\S]{0,400}?lifecycle_status<>'retired' and m\.approval_pending=0 and r\.editorial_status='approved'/,
  ]) {
    assert.match(candidate, clause, "发版候选集应当包含这条过滤");
    assert.match(pending, clause, "待发布比对应当用同一条过滤");
  }
});

test("the diff compares item_hash, which covers structural changes like a moved pin", () => {
  const source = read("worker/modules/releases.ts");
  const pending = source.slice(source.indexOf("export async function pendingReleaseChanges"));
  // release_items.item_hash 存的就是 revision 的 content_hash。
  assert.match(pending, /r\.content_hash as itemHash/);
  assert.match(pending, /ri\.item_hash as itemHash/);

  // content_hash 覆盖 structure_json，而位置存在 structure_json.locations 里。
  // 所以「在校区图上挪了个点」会产生新哈希，不需要另外比锚点表——这个前提一旦
  // 被改坏（比如哈希不再含 structure），位置改动就会在清单里凭空消失。
  for (const file of ["worker/modules/places.ts", "worker/modules/facilities.ts", "worker/modules/merchants.ts"]) {
    assert.match(read(file), /sha256\(`[^`]*\$\{structureJson\}`\)/, `${file} 的 content_hash 必须覆盖 structure_json`);
  }
});

test("entities without a revision flow fall back to a time comparison", () => {
  const source = read("worker/modules/releases.ts");
  const pending = source.slice(source.indexOf("export async function pendingReleaseChanges"));
  // 站点没有修订，release_items 里也没有它，唯一的变更痕迹是 updated_at。
  // 判据取 activated_at（快照真正生效的时刻），缺失时退回 created_at。
  assert.match(pending, /active\.activatedAt \?\? active\.createdAt/);
  assert.match(pending, /stop\.updatedAt > releasedAt/);
  // 这条比哈希弱，注释里必须说清宁可多报也不漏报，否则下一个人会以为它是等价的。
  assert.match(pending, /宁可多报/);
});

test("transit stops really do carry an updated_at to compare against", () => {
  const db = database();
  const columns = db.prepare("pragma table_info(transit_stops)").all().map((row) => row.name);
  assert.ok(columns.includes("updated_at"), "站点的时间比较依赖这一列");
  assert.ok(columns.includes("status"), "只有 active 的站点进快照");
  db.close();
});

test("a never-published database reports everything as added", () => {
  const source = read("worker/modules/releases.ts");
  const pending = source.slice(source.indexOf("export async function pendingReleaseChanges"));
  // 没有 active release 时不能拿空快照去 diff——那样每一项都要走 removed 分支。
  assert.match(pending, /if \(!active\)/);
  assert.match(pending, /release: null/);
});

test("the release_items join can actually resolve a display name", () => {
  const db = database();
  // 清单要显示名字而不是 id，靠的是 release_items.revision_id → *_revisions.display_name。
  const items = db.prepare("pragma table_info(release_items)").all().map((row) => row.name);
  assert.ok(items.includes("revision_id"), "没有它就只能显示 id");
  assert.ok(items.includes("item_hash"), "没有它就无法判断「改过」");
  const revisions = db.prepare("pragma table_info(place_revisions)").all().map((row) => row.name);
  assert.ok(revisions.includes("display_name"));
  db.close();
});

test("the endpoint is registered behind publish:release", () => {
  const router = read("worker/index-v2.ts");
  assert.match(router, /"\/api\/admin\/releases\/pending"/);
  // 必须排在 POST /api/admin/releases 之前那类精确匹配里，且要 publish:release。
  const block = router.slice(router.indexOf('"/api/admin/releases/pending"') - 200, router.indexOf('"/api/admin/releases/pending"') + 300);
  assert.match(block, /requireSession\(request, env, "publish:release"\)/);
  assert.match(block, /pendingReleaseChanges\(env\)/);
});

test("the sidebar badge and the release page read one shared source", () => {
  const context = read("src/admin/PendingReleaseContext.tsx");
  const sidebar = read("src/admin/AdminPage.tsx");
  const page = read("src/admin/pages/ReleasesPage.tsx");

  // 两处各自请求会漂移成两种说法，那比没有提示更糟。
  assert.match(sidebar, /usePendingRelease\(\)/);
  assert.match(page, /usePendingRelease\(\)/);
  assert.match(sidebar, /<PendingReleaseProvider>/);

  // 小黄点只挂在发布中心那一项：它是唯一能解决这件事的地方。
  assert.match(sidebar, /item\.to === "\/admin\/releases" && pending/);

  // 没有 publish:release 的账号不请求（端点本身也要这个权限）。
  assert.match(context, /hasPermission\("publish:release"\)/);
  // 取不到就不显示，不要在别的页面上弹错误。
  assert.match(context, /setPending\(null\)/);
});

test("publishing and rolling back both recompute the badge", () => {
  const page = read("src/admin/pages/ReleasesPage.tsx");
  // 发版成功后清单应立刻变空、小黄点灭掉；回滚换了 active release，同样要重算。
  const publishBlock = page.slice(page.indexOf("async function publish"), page.indexOf("async function doRollback"));
  const rollbackBlock = page.slice(page.indexOf("async function doRollback"), page.indexOf("return (", page.indexOf("async function doRollback")));
  assert.match(publishBlock, /reloadPending\(\)/, "发版后必须重算，否则会继续提示刚做完的事");
  assert.match(rollbackBlock, /reloadPending\(\)/, "回滚换了线上版本，待发布集合随之改变");
});

test("the panel states cover loading, clean, and dirty", () => {
  const page = read("src/admin/pages/ReleasesPage.tsx");
  const panel = page.slice(page.indexOf("function PendingChangesPanel"), page.indexOf("/** 地图版本生命周期状态"));
  assert.match(panel, /if \(!pending\)/, "还没取到时要说正在比对，不能装作没有改动");
  assert.match(panel, /if \(!pending\.hasPendingChanges\)/, "干净时要明确说线上与后台一致");
  // 关键那句话：改动已保存但用户端看不到。这是整个功能存在的理由。
  assert.match(panel, /用户端还看不到/);
  // 「移除」这一类没有可跳转的编辑页（东西已经不在后台了），必须换一句说明而不是
  // 给一个点开就 404 的链接。
  assert.match(panel, /已从后台移除/);
});

test("the three change kinds are all labelled and only editable ones link out", () => {
  const page = read("src/admin/pages/ReleasesPage.tsx");
  for (const kind of ["added", "changed", "removed"]) {
    assert.match(page, new RegExp(`${kind}:`), `${kind} 必须有中文文案与图标`);
  }
  // removed 的实体已经不在后台，给链接点开就是 404。
  assert.match(page, /if \(row\.change === "removed"\) return null/);
});

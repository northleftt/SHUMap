// 小程序端「转发 / 分享到朋友圈 / 复制链接」自验。
//
// 背景：右上角菜单里的「转发」只在页面定义了 onShareAppMessage 时才出现，
// 「复制链接」跟着同一项解锁，「分享到朋友圈」还要额外定义 onShareTimeline。
// 之前全仓一个都没定义，所以真机上是「当前页面不可转发 / 不可分享」+ 复制链接灰掉。
//
// 本测试分两部分：
// 1. lib/share.ts 纯函数（sharePath / shareQuery / shareTitle）行为；
// 2. 源码断言：每个注册页都定义了 onShareAppMessage，
//    除 web-view 容器页（朋友圈是单页模式，web-view 不可用）外都定义 onShareTimeline。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const miniRoot = join(root, "miniprogram/miniprogram");
const outDir = join(root, "tmp/share-test");
mkdirSync(outDir, { recursive: true });

execFileSync(join(root, "node_modules/.bin/esbuild"), [
  join(miniRoot, "lib/share.ts"),
  "--bundle",
  "--platform=node",
  "--format=cjs",
  `--outfile=${join(outDir, "share.cjs")}`,
]);
const share = createRequire(import.meta.url)(join(outDir, "share.cjs"));

// ---------------------------------------------------------------------------
// 1. 纯函数
// ---------------------------------------------------------------------------

// shareQuery：空值整项丢掉，键值 encodeURIComponent
assert.equal(share.shareQuery({ a: "1", b: "2" }), "a=1&b=2");
assert.equal(share.shareQuery({ a: "1", b: "", c: null, d: undefined }), "a=1");
assert.equal(share.shareQuery({}), "");
assert.equal(share.shareQuery(), "");
assert.equal(share.shareQuery({ poi: "place:HA 楼" }), "poi=place%3AHA%20%E6%A5%BC");
assert.equal(share.shareQuery({ n: 0 }), "n=0", "数字 0 不应被当作空值丢掉");

// sharePath：绝对路径 + 无参数时不带 ?
assert.equal(share.sharePath("/pages/map/map"), "/pages/map/map");
assert.equal(share.sharePath("pages/map/map"), "/pages/map/map", "缺前导斜杠应补上");
assert.equal(share.sharePath("/pages/map/map", {}), "/pages/map/map");
assert.equal(
  share.sharePath("/pages/shuttle/shuttle", { f: "campus-bs", t: "campus-yc" }),
  "/pages/shuttle/shuttle?f=campus-bs&t=campus-yc",
);

// shareTitle：空主题回落 App 名；主题过长不再拼后缀；整句截到 28
assert.equal(share.shareTitle(""), share.APP_SHARE_TITLE);
assert.equal(share.shareTitle(null), share.APP_SHARE_TITLE);
assert.equal(share.shareTitle("   "), share.APP_SHARE_TITLE, "纯空白也算空主题");
assert.equal(share.shareTitle("水秀食堂"), "水秀食堂 · 上海大学校园地图");
assert.equal(share.shareTitle("宝山 → 延长", "校车时刻"), "宝山 → 延长 · 校车时刻");
{
  // 18 字 + " · " + 8 字后缀 = 29 > 28，拼不下后缀就只保留主题本身
  // （拼上再截会把地名截掉后半截，反而更难认）。
  const long = "十八个字的很长很长很长的地点名字啊啊";
  assert.equal(long.length, 18);
  assert.equal(share.shareTitle(long), long, "主题本身够长时不拼后缀");
  // 17 字刚好放得下（17 + 3 + 8 = 28），是边界上的另一侧
  const fits = "十七个字的很长很长很长的地点名字啊";
  assert.equal(fits.length, 17);
  assert.equal(share.shareTitle(fits), `${fits} · 上海大学校园地图`);
}
{
  const tooLong = "四十字的超长地点名".repeat(5);
  assert.ok(share.shareTitle(tooLong).length <= 28, "整句应截到 28 字以内");
}
assert.equal(share.shareTitle("网页", ""), "网页", "后缀为空串时只用主题");

// enableShareMenus：老基础库不认 menus（fail 回调）时退回只请求转发菜单
{
  const calls = [];
  globalThis.wx = {
    showShareMenu(options) {
      calls.push(options);
      if (options.menus && calls.length === 1) options.fail?.({ errMsg: "menus not support" });
    },
  };
  share.enableShareMenus();
  assert.equal(calls.length, 2, "menus 失败后应重试一次不带 menus 的调用");
  assert.deepEqual(calls[0].menus, ["shareAppMessage", "shareTimeline"]);
  assert.equal(calls[1].menus, undefined);

  calls.length = 0;
  share.enableShareMenus(false);
  assert.deepEqual(calls[0].menus, ["shareAppMessage"], "withTimeline=false 只请求转发");

  // wx.showShareMenu 不存在时不应抛错
  globalThis.wx = {};
  share.enableShareMenus();
  delete globalThis.wx;
}

// ---------------------------------------------------------------------------
// 2. 源码断言：每个注册页都要能转发
// ---------------------------------------------------------------------------

const appJson = JSON.parse(readFileSync(join(miniRoot, "app.json"), "utf8"));
assert.ok(appJson.pages.length >= 9, "页面清单读取异常");

/** 朋友圈是单页模式，web-view 组件在该模式下不可用，故本页只开转发。 */
const TIMELINE_EXEMPT = new Set(["pages/webview/webview"]);

for (const page of appJson.pages) {
  const source = readFileSync(join(miniRoot, `${page}.ts`), "utf8");
  assert.match(
    source,
    /\bonShareAppMessage\s*\(/,
    `${page} 缺 onShareAppMessage：右上角菜单会显示「当前页面不可转发」且复制链接不可点`,
  );
  if (TIMELINE_EXEMPT.has(page)) {
    assert.doesNotMatch(source, /\bonShareTimeline\s*\(/, `${page} 是 web-view 容器页，不应开启朋友圈分享`);
  } else {
    assert.match(source, /\bonShareTimeline\s*\(/, `${page} 缺 onShareTimeline：菜单会显示「当前页面不可分享」`);
  }
  assert.match(source, /enableShareMenus\(/, `${page} 未调用 enableShareMenus`);
}

// 深链参数与消费方对齐：地图页转发带 ?poi=/?campus=，落到 pending-map-poi 通道。
{
  const mapSource = readFileSync(join(miniRoot, "pages/map/map.ts"), "utf8");
  assert.match(mapSource, /options\?\.poi/, "地图页 onLoad 应读取转发深链的 poi 参数");
  assert.match(mapSource, /options\?\.campus/, "地图页 onLoad 应读取转发深链的 campus 参数");
  assert.match(
    mapSource,
    /shumap\.pending-map-poi["']\s*,\s*sharedPoi \|\| `campus:\$\{sharedCampus\}`/,
    "转发深链应复用 pending-map-poi 一次性通道",
  );
  // campus: 分支要同时认 key（转发卡片带的是 activeCampusKey）与 id（原有 tab 深链调用方）
  const campusBranch = mapSource.slice(
    mapSource.indexOf('pending.startsWith("campus:")'),
    mapSource.indexOf("this.poiByKey.get(pending)"),
  );
  assert.ok(campusBranch.length > 0, "地图页应有 campus: 深链分支");
  assert.match(campusBranch, /item\.key === \w+/, "campus: 深链需认 campus.key（转发卡片带的就是它）");
  assert.match(campusBranch, /item\.id === \w+/, "campus: 深链需继续认 campus.id（原有 tab 深链）");
}

// 校车页：OD 回填要在首次 reloadLines 之前，否则会先按默认 OD 多请求一次。
{
  const shuttleSource = readFileSync(join(miniRoot, "pages/shuttle/shuttle.ts"), "utf8");
  const applyAt = shuttleSource.indexOf("this.applyPendingRoute();");
  const reloadAt = shuttleSource.indexOf("this.reloadLines();", applyAt);
  assert.ok(applyAt > 0, "校车页应有 applyPendingRoute 调用");
  assert.ok(reloadAt > applyAt, "applyPendingRoute 必须排在 reloadLines 之前");
}

// 楼层页：转发带 placeId + floor，boot 里回落最低层。
{
  const floorsSource = readFileSync(join(miniRoot, "pages/floors/floors.ts"), "utf8");
  assert.match(floorsSource, /options\.floor/, "楼层页应读取转发深链的 floor 参数");
  assert.match(floorsSource, /pendingFloorId/, "楼层页应有 pendingFloorId 状态");
}

console.log("miniprogram-share: all assertions passed");

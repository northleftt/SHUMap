// 校车乘坐指南（「如何坐车？」）。
//
// 这份内容复用 guide_documents（slug=shuttle-ride），所以没有新迁移、没有新端点。
// 值得钉在测试里的是三件事：
//
//   1. 规范化规则两端一致。契约在 shared/shuttle-guide-contract.ts（管理端吃），
//      小程序有一份手抄（miniprogram/miniprogram/lib/shuttle-guide.ts，因为小程序
//      构建不出仓库根目录）。手抄漏改不会有任何报错，只表现为「后台存进去的块
//      小程序不显示」。所以这里对着同一批输入跑两份实现，逐条比对。
//   2. 宽松读取。内容是 JSON 存的，手改过的稿子、将来加了新块类型的稿子都可能带
//      不认识的东西。规则是「少画一块，不要整页白屏」——空块丢掉、坏 asset 键丢掉。
//   3. 入口显隐。校车页那个「如何坐车？」必须在未发布 / 断网 / 空文档时都不出现：
//      点进去看一个空页比没有入口更糟。这条钉的是源码结构（默认 false + 探测才亮）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");
const require = createRequire(import.meta.url);

/** TS 源码 → 可 require 的 CJS。小程序那份带 wx/config 依赖，esbuild 打包能吃掉。 */
function bundle(entry, name) {
  const out = join(root, `tmp/shuttle-guide-test/${name}.cjs`);
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(join(root, "node_modules/.bin/esbuild"), [
    join(root, entry),
    "--bundle", "--platform=node", "--format=cjs", `--outfile=${out}`,
  ]);
  return require(out);
}

const shared = bundle("shared/shuttle-guide-contract.ts", "shared");
const mp = bundle("miniprogram/miniprogram/lib/shuttle-guide.ts", "miniprogram");

// ---------------------------------------------------------------------------
// 1. 规范化：四种块各自的接收与丢弃
// ---------------------------------------------------------------------------

test("四种块类型都能读出来，空内容的块被丢掉", () => {
  const content = shared.normalizeShuttleGuideContent({
    meta: { title: "如何坐车", subtitle: "宝山 / 嘉定 / 延长" },
    blocks: [
      { type: "heading", text: "上车前" },
      { type: "paragraph", text: "  刷校园卡或出示电子校车票。  " },
      { type: "list", items: ["提前 5 分钟到候车点", "  ", "对号上车"] },
      { type: "image", asset: "shuttle-ride-abc", caption: "  候车点位置  " },
      // 以下全部应被丢掉
      { type: "heading", text: "   " },
      { type: "paragraph", text: "" },
      { type: "list", items: [] },
      { type: "list", items: ["  ", ""] },
      { type: "video", url: "https://example.test/x" },
      null,
      "字符串不是块",
    ],
  });

  assert.equal(content.schema, 2);
  assert.equal(content.kind, "article");
  assert.deepEqual(content.meta, { title: "如何坐车", subtitle: "宝山 / 嘉定 / 延长" });
  assert.deepEqual(content.blocks, [
    { type: "heading", text: "上车前" },
    { type: "paragraph", text: "刷校园卡或出示电子校车票。" },
    { type: "list", items: ["提前 5 分钟到候车点", "对号上车"] },
    { type: "image", asset: "shuttle-ride-abc", caption: "候车点位置" },
  ]);
  // guide 模块的 assertContentShape 要求这两个是数组，否则存进去就被自己的校验拒掉
  assert.deepEqual(content.hubs, []);
  assert.deepEqual(content.cards, []);
});

test("图片块的 asset 键必须合法，图注可空", () => {
  // 键非法 = 整块丢掉：那个键会进 URL，也进 guide_assets 查询，放行只会得到 404 空框
  for (const asset of ["", "  ", "A-Upper", "has_underscore", "-leading", "trailing-", "ab", "x".repeat(65)]) {
    assert.equal(shared.normalizeBlock({ type: "image", asset }), null, `应拒绝 asset=${JSON.stringify(asset)}`);
  }
  assert.deepEqual(
    shared.normalizeBlock({ type: "image", asset: "shuttle-ride-abc" }),
    { type: "image", asset: "shuttle-ride-abc", caption: null },
    "没有图注时 caption 为 null（不是空串）",
  );
});

test("整份内容缺字段 / 类型不对时退化成空文章，不抛错", () => {
  for (const raw of [null, undefined, 42, "text", [], {}, { blocks: "not-an-array" }, { meta: 7 }]) {
    const content = shared.normalizeShuttleGuideContent(raw);
    assert.deepEqual(content.blocks, []);
    assert.deepEqual(content.meta, { title: "", subtitle: "" });
  }
  const empty = shared.emptyContent();
  assert.deepEqual(empty.blocks, []);
  assert.ok(Array.isArray(empty.hubs) && Array.isArray(empty.cards));
});

test("referencedAssets 去重且只收图片块", () => {
  const content = shared.normalizeShuttleGuideContent({
    blocks: [
      { type: "image", asset: "shuttle-ride-aaa" },
      { type: "paragraph", text: "中间夹一段文字" },
      { type: "image", asset: "shuttle-ride-aaa", caption: "同一张图用两次" },
      { type: "image", asset: "shuttle-ride-bbb" },
    ],
  });
  assert.deepEqual(shared.referencedAssets(content), ["shuttle-ride-aaa", "shuttle-ride-bbb"]);
});

test("newAssetKey 产出的键能过服务端的 ASSET_KEY_PATTERN", () => {
  // 与 worker/modules/guide.ts 的正则同源；键不合法时上传直接 400，编辑器里表现为「加图片没反应」
  const workerPattern = /ASSET_KEY_PATTERN = (\/[^\n]+\/);/.exec(read("worker/modules/guide.ts"));
  assert.ok(workerPattern, "worker 侧应有 ASSET_KEY_PATTERN");
  assert.equal(workerPattern[1], String(shared.ASSET_KEY_PATTERN), "契约里的键规则应与 worker 一致");
  for (let i = 0; i < 50; i += 1) {
    const key = shared.newAssetKey();
    assert.match(key, shared.ASSET_KEY_PATTERN, `newAssetKey 产出了非法键 ${key}`);
    assert.ok(key.startsWith("shuttle-ride-"), "键应带 slug 前缀便于在素材列表里分辨归属");
  }
});

// ---------------------------------------------------------------------------
// 2. 两份实现行为一致
//
// 小程序构建不出仓库根目录，lib/shuttle-guide.ts 是 shared 契约的手抄。
// 漏改不报错，只表现为「后台能存、小程序不显示」，所以逐条比对。
// ---------------------------------------------------------------------------

test("小程序手抄与 shared 契约对同一批输入给出相同结果", () => {
  const cases = [
    { meta: { title: "如何坐车", subtitle: "副标题" }, blocks: [{ type: "heading", text: "上车前" }] },
    { blocks: [{ type: "paragraph", text: "  两端都要 trim  " }] },
    { blocks: [{ type: "list", items: ["一", "  ", "二"] }] },
    { blocks: [{ type: "image", asset: "shuttle-ride-abc", caption: " 图注 " }] },
    { blocks: [{ type: "image", asset: "BAD_KEY" }] },
    { blocks: [{ type: "unknown" }, null, 7, "x"] },
    { blocks: "not-an-array" },
    {},
    null,
  ];
  for (const raw of cases) {
    assert.deepEqual(
      mp.normalizeShuttleGuideContent(raw),
      shared.normalizeShuttleGuideContent(raw),
      `两端规范化结果不一致：${JSON.stringify(raw)}`,
    );
  }
  assert.equal(mp.SHUTTLE_GUIDE_SLUG, shared.SHUTTLE_GUIDE_SLUG, "slug 必须一致，否则两端读写不同文档");
  assert.equal(String(mp.ASSET_KEY_PATTERN), String(shared.ASSET_KEY_PATTERN));
});

// ---------------------------------------------------------------------------
// 3. 小程序视图模型
// ---------------------------------------------------------------------------

test("块视图把类型摊成布尔标志（WXML 没有 switch）", () => {
  const content = mp.normalizeShuttleGuideContent({
    blocks: [
      { type: "heading", text: "上车前" },
      { type: "paragraph", text: "刷卡上车" },
      { type: "list", items: ["提前到站"] },
      { type: "image", asset: "shuttle-ride-abc", caption: "候车点" },
    ],
  });
  const views = mp.buildBlockViews(content);
  assert.deepEqual(views.map((v) => v.key), ["b0", "b1", "b2", "b3"], "wx:key 应稳定且唯一");
  assert.deepEqual(
    views.map((v) => [v.isHeading, v.isParagraph, v.isList, v.isImage]),
    [[true, false, false, false], [false, true, false, false], [false, false, true, false], [false, false, false, true]],
    "每块应且只应命中一个标志",
  );
  assert.equal(views[0].text, "上车前");
  assert.deepEqual(views[2].items, ["提前到站"]);
  assert.equal(views[3].caption, "候车点");

  // 图片地址必须是绝对的：小程序 <image> 不认同源相对路径
  assert.match(views[3].src, /^https?:\/\/.+\/api\/public\/guide-assets\/shuttle-ride-abc$/);
  // 且不试 `<key>-png` 派生（那是返校指南 SVG 图示的特例，这份图本身就是位图）
  assert.doesNotMatch(views[3].src, /-png$/);
});

test("previewUrls 只收图片块，供 previewImage 左右翻", () => {
  const views = mp.buildBlockViews(mp.normalizeShuttleGuideContent({
    blocks: [
      { type: "image", asset: "shuttle-ride-aaa" },
      { type: "paragraph", text: "夹一段文字" },
      { type: "image", asset: "shuttle-ride-bbb" },
    ],
  }));
  const urls = mp.previewUrls(views);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => /^https?:\/\//.test(url)));
  assert.deepEqual(mp.previewUrls([]), []);
});

test("响应缺 revisionNo 时判为无效（宁可当未发布，也不渲染半份内容）", () => {
  assert.equal(mp.parseShuttleGuidePayload(null), null);
  assert.equal(mp.parseShuttleGuidePayload({ title: "x" }), null, "缺 revisionNo");
  assert.equal(mp.parseShuttleGuidePayload({ title: "x", revisionNo: "3" }), null, "revisionNo 类型不对");
  const ok = mp.parseShuttleGuidePayload({
    title: "校车乘坐指南",
    revisionNo: 3,
    content: { meta: { title: "如何坐车" }, blocks: [{ type: "paragraph", text: "正文" }] },
  });
  assert.equal(ok.revisionNo, 3);
  assert.equal(ok.title, "校车乘坐指南");
  assert.equal(ok.content.meta.title, "如何坐车");
  assert.equal(ok.content.blocks.length, 1);
});

// ---------------------------------------------------------------------------
// 4. 源码结构：页面注册、事件绑定、入口显隐
// ---------------------------------------------------------------------------

test("乘车指南页已注册且事件绑定都有处理器", () => {
  const app = JSON.parse(read("miniprogram/miniprogram/app.json"));
  assert.ok(
    app.pages.includes("pages/shuttle-guide/shuttle-guide"),
    "app.json 未注册 pages/shuttle-guide/shuttle-guide：navigateTo 会直接失败",
  );

  const wxml = read("miniprogram/miniprogram/pages/shuttle-guide/shuttle-guide.wxml");
  const source = read("miniprogram/miniprogram/pages/shuttle-guide/shuttle-guide.ts");
  const bindings = [...wxml.matchAll(/(?:bind|catch)[a-zA-Z-]*="([a-zA-Z_$][\w$]*)"/g)].map((m) => m[1]);
  const missing = [...new Set(bindings)].filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(source));
  assert.deepEqual(missing, [], `乘车指南 WXML 事件缺少处理器：${missing.join(", ")}`);

  // 三态齐全：未发布与网络错误必须分开——404 是「还没写」，不该给重试按钮和网络报错
  for (const state of ["loading", "unpublished", "error"]) {
    assert.ok(wxml.includes(`'${state}'`), `WXML 缺 ${state} 态`);
  }
  assert.match(source, /statusCode === 404/, "404 应判为未发布而不是错误");

  // 转发能力（tests/miniprogram-share.test.mjs 也会扫，这里就近再钉一次意图）
  assert.match(source, /\bonShareAppMessage\s*\(/);
  assert.match(source, /\bonShareTimeline\s*\(/);
});

test("「如何坐车？」入口默认不显示，只在探测到已发布内容后才亮", () => {
  const source = read("miniprogram/miniprogram/pages/shuttle/shuttle.ts");
  const wxml = read("miniprogram/miniprogram/pages/shuttle/shuttle.wxml");

  // 默认 false 是关键：内容未发布 / 断网时点进去只能看空页或报错页
  assert.match(source, /guideEntryVisible:\s*false/, "入口默认应为 false");
  assert.match(source, /hasPublishedShuttleGuide\(\)/, "应通过探测决定显隐");
  assert.match(
    source,
    /if\s*\(available\)\s*this\.setData\(\{\s*guideEntryVisible:\s*true\s*\}\)/,
    "只在探测为真时置 true —— 不能无条件 setData(available)，那会在断网时闪一下再消失",
  );
  assert.match(wxml, /wx:if="\{\{guideEntryVisible\}\}"[\s\S]{0,120}如何坐车/, "入口应受 guideEntryVisible 门控");
  assert.match(source, /openRideGuide\(\)/);
  assert.match(source, /"\/pages\/shuttle-guide\/shuttle-guide"/);

  // 探测失败不能影响时刻表：两条数据通道独立
  assert.doesNotMatch(source, /await this\.probeGuide\(\)/, "探测不应阻塞 onLoad 的班次加载");
});

// 头部这一行落在微信胶囊按钮（右上角「···」与「×」）的纵向区间里，所以「如何坐车？」
// 必须紧贴标题成组、整行左对齐。第一版写成 justify-content: space-between 把它推到最右，
// 真机上直接压在胶囊底下 —— 这一段就是钉住那个回归。
test("「如何坐车？」紧贴标题左对齐，不能被推到胶囊按钮底下", () => {
  const wxss = read("miniprogram/miniprogram/pages/shuttle/shuttle.wxss");
  const header = wxss.slice(wxss.indexOf(".header {"), wxss.indexOf(".route-card {"));

  assert.ok(header.includes(".guide-link {"), "测试切错了区间：应包含 .guide-link 规则");
  assert.doesNotMatch(
    header,
    /justify-content:\s*space-between/,
    "头部不能用 space-between —— 会把「如何坐车？」推到右上角与微信胶囊按钮重合",
  );
  assert.match(header, /\.guide-link \{[^}]*margin-left:/, "入口应靠 margin-left 紧贴标题右侧");
  // 标题与入口都不许伸展：任一个 flex:1 都会把另一个挤到行尾，等价于右对齐。
  for (const selector of [".title", ".guide-link"]) {
    const rule = header.slice(header.indexOf(`${selector} {`));
    assert.match(rule.slice(0, rule.indexOf("}")), /flex:\s*none/, `${selector} 应为 flex: none`);
  }
});

// 纯灰字读起来像说明文字而不是可点的东西，所以前面加了个圆圈问号给出「这能点」的信号。
// 要求是「符号也是相同的灰」——圆圈描边、问号、文字三者同色，所以这里比的是色值相等，
// 而不是各自 match 一个写死的 #94a3b8：将来整体调灰度时，改一处漏一处仍会被抓到。
test("圆圈问号与文字同色同组，圆圈用 border 画而不是 emoji", () => {
  const wxss = read("miniprogram/miniprogram/pages/shuttle/shuttle.wxss");
  const wxml = read("miniprogram/miniprogram/pages/shuttle/shuttle.wxml");

  const ruleOf = (selector) => {
    const at = wxss.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `WXSS 缺 ${selector} 规则`);
    return wxss.slice(at, wxss.indexOf("}", at));
  };
  const icon = ruleOf(".guide-icon");
  const label = ruleOf(".guide-text");

  const hexIn = (rule, prop) => {
    const found = new RegExp(`${prop}:[^;]*?(#[0-9a-fA-F]{3,8})`).exec(rule);
    assert.ok(found, `${prop} 应写成十六进制色值，便于与文字色比对`);
    return found[1].toLowerCase();
  };
  const ink = hexIn(label, "color");
  assert.equal(hexIn(icon, "color"), ink, "问号字符应与文字同色");
  assert.equal(hexIn(icon, "border"), ink, "圆圈描边应与文字同色");

  // 图标比文字小一号才不抢视线（26rpx 文字 / 20rpx 问号）
  const sizeOf = (rule) => Number(/font-size:\s*(\d+)rpx/.exec(rule)?.[1]);
  assert.ok(sizeOf(icon) < sizeOf(label), "问号字号应小于文字字号");

  // 正圆：等宽高 + border-radius 50% + border-box（否则描边让 28rpx 变成外径 32rpx）
  assert.match(icon, /border-radius:\s*50%/, "应是正圆");
  assert.match(icon, /box-sizing:\s*border-box/, "描边应算进尺寸，否则圆比预期大");
  assert.equal(
    /width:\s*(\d+)rpx/.exec(icon)?.[1],
    /height:\s*(\d+)rpx/.exec(icon)?.[1],
    "圆的宽高必须相等，否则是椭圆",
  );

  // Skyline 下 view 默认 column：图标行与问号居中都得显式写，否则会竖排 / 不居中
  assert.match(icon, /justify-content:\s*center/, "问号应水平居中");
  assert.match(ruleOf(".guide-link"), /flex-direction:\s*row/, "Skyline 下 view 默认 column，必须显式 row");

  // 圆圈里是普通问号字符，不是 emoji 问号（后者自带彩色，压不成与文字同一个灰）。
  // 断言「就是 ASCII ?」比枚举 emoji 更严，也不必在源码里写那些字符。
  const at = wxml.indexOf('class="guide-link"');
  const entry = wxml.slice(at, wxml.indexOf("</view>", wxml.indexOf("guide-text", at)));
  assert.match(entry, /class="guide-icon">\?</, "圆圈里应是 ASCII 问号");
  assert.match(entry, /class="guide-text">如何坐车</, "文案是「如何坐车」（问号已由图标承担）");
});

test("空文档不算已发布：入口与页面都按未发布处理", () => {
  // 后台建了文档但还没写正文时，入口不该出现（点进去是个只有标题的空页）
  const lib = read("miniprogram/miniprogram/lib/shuttle-guide.ts");
  assert.match(
    lib,
    /payload\.content\.blocks\.length > 0/,
    "hasPublishedShuttleGuide 应要求有正文",
  );
  assert.match(lib, /catch\s*\{[\s\S]*?return false/, "任何失败都应返回 false（入口不出现）");

  const page = read("miniprogram/miniprogram/pages/shuttle-guide/shuttle-guide.ts");
  assert.match(page, /blocks\.length === 0[\s\S]{0,120}state:\s*"unpublished"/, "空正文应走未发布态");
});

test("管理端乘坐指南面板挂在校车时刻页，且用同一份 shared 契约", () => {
  const transit = read("src/admin/pages/TransitPage.tsx");
  assert.match(transit, /\{ key: "guide", label: "乘坐指南" \}/, "校车时刻页应有「乘坐指南」分区");
  assert.match(transit, /tab === "guide" \? <ShuttleGuidePanel \/> : null/);

  const panel = read("src/admin/components/ShuttleGuidePanel.tsx");
  assert.match(
    panel,
    /from "\.\.\/\.\.\/\.\.\/shared\/shuttle-guide-contract"/,
    "管理端应直接吃 shared 契约，不要再抄一份规范化逻辑",
  );
  // 发布前必须走审核：这条流水线是 guide 模块给的，面板只能按它的顺序调
  for (const call of ["saveGuideRevision", "submitGuideRevision", "reviewGuideRevision", "publishGuideRevision"]) {
    assert.ok(panel.includes(call), `面板缺 ${call}`);
  }
});

// 图片上传曾表现为「传不上去」：字节其实进了 R2，但 apiFetch 在每次非 GET 的
// /api/admin/ 写操作后广播 admin-data-changed，广播让面板里两个 useAsyncData 双双
// 回到 loading → 编辑器卸载重挂 → 刚加的图片块（连同其他未保存的块）被服务端旧草稿
// 覆盖掉。两条修法都要在：素材上传不广播，且面板刷新期间不得卸载子树。
test("上传插图不会清掉未保存的块（不广播 + 刷新期间不卸载）", () => {
  const client = read("src/lib/api/client.ts");
  const exclusions = client.slice(
    client.indexOf("const ADMIN_REFRESH_EXCLUSIONS"),
    client.indexOf("]", client.indexOf("const ADMIN_REFRESH_EXCLUSIONS")),
  );
  assert.match(
    exclusions,
    /\/\^\\\/api\\\/admin\\\/guide\\\/assets/,
    "guide/assets 的写操作必须免广播：它只往 R2 塞字节，不改任何列表页读到的数据",
  );

  const panel = read("src/admin/components/ShuttleGuidePanel.tsx");
  // 两层都要留住上一次的成功数据，否则任何一次 reload 都会卸载 ReadyEditor。
  for (const [holder, label] of [["lastList", "文档列表"], ["lastDetail", "文档详情"]]) {
    assert.match(panel, new RegExp(`${holder}\\s*===\\s*null`), `${label} 应在刷新期间沿用旧数据`);
    assert.match(
      panel,
      new RegExp(`if\\s*\\([a-zA-Z.]+\\.state\\.status === "ready"\\) set${holder[0].toUpperCase()}${holder.slice(1)}\\(`),
      `${label} 应在 ready 时记住数据`,
    );
  }
  // 不能再出现「非 ready 就渲染 LoadingState」——那正是卸载重挂的来源。
  assert.doesNotMatch(
    panel,
    /state\.status !== "ready"\) return <LoadingState/,
    "不得在非 ready 时直接渲染 LoadingState：会把编辑器卸载，未保存的块全丢",
  );
  // ReadyEditor 的 key 只跟版本 id 绑：上传图片不产生新版本，所以不该重挂。
  assert.match(panel, /key=\{lastDetail\.working\?\.id \?\? "none"\}/, "key 应只随版本 id 变化");
});

console.log("shuttle-ride-guide: all assertions passed");

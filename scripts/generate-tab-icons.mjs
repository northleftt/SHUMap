// 生成小程序 tabBar / 菜单 / 地图抽屉用 PNG 图标。
// 图标源：node_modules/lucide-react 的 __iconNode（与 Web 端 BottomTabBar 同一套 lucide 图标），
// sharp 栅格化为 81x81 PNG（微信 tabBar 推荐尺寸）。
//
// 用法：node scripts/generate-tab-icons.mjs
// 产出：
//   miniprogram/miniprogram/images/tabs/{map,bus,globe,user-round}.png          普通态 #94a3b8（--color-sub）
//   miniprogram/miniprogram/images/tabs/{map,bus,globe,user-round}-active.png   选中态 #1e80c1（--color-primary）
//   miniprogram/miniprogram/images/menu/{clock,info,bug,heart}.png              我的页菜单图标 #0f172a（--color-ink）
//   miniprogram/miniprogram/images/poi/<key>.png                                列表行/设施图标方块用（#1e80c1）：
//     building-2/store/map-pin + 设施 iconKey 全集（映射读 src/lib/facilityIcons.tsx 的
//     FACILITY_ICON_BY_KEY，lucide 名逐一对齐；未知 key 页面侧用 generic 兜底）
//   miniprogram/miniprogram/images/poi-w/<key>.png                              同上白色版：
//     地图图钉/楼层徽章的**选中态**（对齐 Web 端 MapPoiOverlay/FloorPlanCanvas：
//     未选中 = 白底蓝图标，选中 = 蓝底白图标）
//   miniprogram/miniprogram/images/sheet/<name>.png                             抽屉/详情卡 UI 图标
//     （heart-filled 是填充态：fill+stroke 同色，其余 lucide 线框图标 fill=none；
//     severity-* 三色对齐 Web 端 SeverityBanner 的 info/warning/critical 图标）

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAB_OUT = path.join(ROOT, "miniprogram/miniprogram/images/tabs");
const MENU_OUT = path.join(ROOT, "miniprogram/miniprogram/images/menu");
const POI_OUT = path.join(ROOT, "miniprogram/miniprogram/images/poi");
const POI_W_OUT = path.join(ROOT, "miniprogram/miniprogram/images/poi-w");
const SHEET_OUT = path.join(ROOT, "miniprogram/miniprogram/images/sheet");

const SIZE = 81;
// 24 单位图标放大到 48px，居中留 16.5px 边距
const SCALE = 2;
const OFFSET = (SIZE - 24 * SCALE) / 2;

const COLOR_SUB = "#94a3b8";
const COLOR_PRIMARY = "#1e80c1";
const COLOR_INK = "#0f172a";
const COLOR_FACT = "#64748b";
const COLOR_WHITE = "#ffffff";

async function iconNode(name) {
  const mod = await import(`lucide-react/dist/esm/icons/${name}.mjs`);
  return mod.__iconNode;
}

function elementToSvg([tag, attrs]) {
  const attrText = Object.entries(attrs)
    .filter(([key]) => key !== "key")
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
  return `<${tag} ${attrText}/>`;
}

function buildSvg(nodes, color, filled = false) {
  const body = nodes.map(elementToSvg).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<g transform="translate(${OFFSET} ${OFFSET}) scale(${SCALE})" fill="${filled ? color : "none"}" stroke="${color}" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`
  );
}

async function render(nodes, color, outPath, filled = false) {
  await sharp(Buffer.from(buildSvg(nodes, color, filled)), { density: 384 })
    .resize(SIZE, SIZE)
    .png()
    .toFile(outPath);
  console.log(`✓ ${path.relative(ROOT, outPath)}`);
}

for (const dir of [TAB_OUT, MENU_OUT, POI_OUT, POI_W_OUT, SHEET_OUT]) mkdirSync(dir, { recursive: true });

for (const name of ["map", "bus", "globe", "utensils", "user-round"]) {
  const nodes = await iconNode(name);
  await render(nodes, COLOR_SUB, path.join(TAB_OUT, `${name}.png`));
  await render(nodes, COLOR_PRIMARY, path.join(TAB_OUT, `${name}-active.png`));
}

for (const name of ["clock", "info", "bug", "heart"]) {
  const nodes = await iconNode(name);
  await render(nodes, COLOR_INK, path.join(MENU_OUT, `${name}.png`));
}

// 列表行/设施图标方块（蓝字浅蓝底方块里的蓝色图标）。
// key → lucide 名，逐一对齐 src/lib/facilityIcons.tsx 的 FACILITY_ICON_BY_KEY；
// 另加楼宇/商户/通用地点的行图标（对齐 SearchHomeSheet 的 PlaceSquareIcon）。
const POI_ICONS = {
  "building-2": "building-2",
  store: "store",
  "map-pin": "map-pin",
  printer: "printer",
  desk: "book-open",
  restroom: "toilet",
  water: "glass-water",
  elevator: "arrow-up-down",
  vending: "shopping-basket",
  battery: "battery-charging",
  charging: "plug-zap",
  service: "info",
  wifi: "wifi",
  food: "utensils",
  parking: "circle-parking",
  bike: "bike",
  bus: "bus",
  mail: "mail",
  health: "heart-pulse",
  lounge: "sofa",
  locker: "package",
  security: "shield-check",
  landmark: "landmark",
  sports: "dumbbell",
  trash: "trash-2",
  generic: "map-pin",
};
for (const [key, lucideName] of Object.entries(POI_ICONS)) {
  const nodes = await iconNode(lucideName);
  await render(nodes, COLOR_PRIMARY, path.join(POI_OUT, `${key}.png`));
  // 白色版：图钉/徽章选中态是蓝底白图标（对齐 Web 端 MapPoiOverlay / FloorPlanCanvas）
  await render(nodes, COLOR_WHITE, path.join(POI_W_OUT, `${key}.png`));
}

// 抽屉/详情卡 / 地图浮层 UI 图标（按使用场景分色）。
const SHEET_ICONS = [
  ["sunrise", "sunrise", COLOR_PRIMARY],
  ["sun", "sun", COLOR_PRIMARY],
  ["moon", "moon", COLOR_PRIMARY],
  ["search", "search", COLOR_SUB],
  ["x", "x", COLOR_FACT],
  ["chevron-right", "chevron-right", COLOR_SUB],
  ["chevron-left", "chevron-left", COLOR_INK],
  ["chevron-down", "chevron-down", COLOR_SUB],
  ["clock", "clock", COLOR_FACT],
  ["building-2", "building-2", COLOR_FACT],
  ["phone", "phone", COLOR_FACT],
  ["wallet", "wallet", COLOR_FACT],
  ["heart", "heart", COLOR_FACT],
  ["navigation", "navigation", COLOR_WHITE],
  ["maximize-2", "maximize-2", COLOR_INK],
  ["minimize-2", "minimize-2", COLOR_INK],
  // 地图右上控件列（对齐 Web 端 MapPage 的回中/图层圆钮与 MapCanvas 缩放条）
  ["crosshair", "crosshair", COLOR_PRIMARY],
  ["layers", "layers", COLOR_INK],
  ["layers-w", "layers", COLOR_WHITE],
  ["layers-active", "layers", COLOR_PRIMARY],
  ["zoom-in", "zoom-in", COLOR_SUB],
  ["zoom-out", "zoom-out", COLOR_SUB],
  // 空态 / 列表态（对齐 EmptyState 默认 Inbox、搜索无结果 SearchX、错误 CircleAlert）
  ["rotate-ccw", "rotate-ccw", COLOR_SUB],
  ["search-x", "search-x", COLOR_PRIMARY],
  ["circle-alert", "circle-alert", COLOR_PRIMARY],
  ["inbox", "inbox", COLOR_PRIMARY],
  ["store", "store", COLOR_FACT],
  // 楼层图视图切换（对齐 FloorsPage 的 列表/平面图 分段控件）
  ["layout-list", "layout-list", COLOR_SUB],
  ["layout-list-w", "layout-list", COLOR_WHITE],
  ["map", "map", COLOR_SUB],
  ["map-w", "map", COLOR_WHITE],
  // 运营事件 severity（对齐 SeverityBanner：info=Info 蓝 / warning=Wrench 橙 / critical=TriangleAlert 红）
  ["severity-info", "info", COLOR_PRIMARY],
  ["severity-warning", "wrench", "#f59e0b"],
  ["severity-critical", "triangle-alert", "#dc2626"],
  ["severity-info-w", "info", COLOR_WHITE],
  ["severity-warning-w", "wrench", COLOR_WHITE],
  ["severity-critical-w", "triangle-alert", COLOR_WHITE],
];
for (const [name, lucideName, color] of SHEET_ICONS) {
  const nodes = await iconNode(lucideName);
  await render(nodes, color, path.join(SHEET_OUT, `${name}.png`));
}
// 收藏选中态：填充心（fill+stroke 同色）
{
  const nodes = await iconNode("heart");
  await render(nodes, COLOR_PRIMARY, path.join(SHEET_OUT, "heart-filled.png"), true);
}

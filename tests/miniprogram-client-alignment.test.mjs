import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "tmp/client-alignment-test");
mkdirSync(outDir, { recursive: true });

for (const [entry, out] of [
  ["miniprogram/miniprogram/lib/transit/schedule.ts", "schedule.cjs"],
  ["miniprogram/miniprogram/lib/submissions-log.ts", "submissions.cjs"],
  ["miniprogram/miniprogram/lib/photo-upload.ts", "photo-upload.cjs"],
  ["miniprogram/miniprogram/lib/map/svg-highlight.ts", "svg-highlight.cjs"],
]) {
  execFileSync(join(root, "node_modules/.bin/esbuild"), [
    join(root, entry), "--bundle", "--platform=node", "--format=cjs", `--outfile=${join(outDir, out)}`,
  ]);
}

const require = createRequire(import.meta.url);
const schedule = require(join(outDir, "schedule.cjs"));
const stop = { id: "stop-1", place_id: "place-1", name: "校车站", campus_id: null };
const point = schedule.navigationPointForStop(stop, [{
  entityType: "place",
  entityId: "place-1",
  role: "navigation_target",
  isPrimary: 1,
  geometry_type: "Point",
  geometry_json: '{"type":"Point","coordinates":[121.4,31.3]}',
  crs: "GCJ02",
  location_hint: "候车点",
}]);
assert.deepEqual(point, { longitude: 121.4, latitude: 31.3, displayName: "候车点" });
assert.equal(schedule.navigationPointForStop(stop, []), null);

const photoUpload = require(join(outDir, "photo-upload.cjs"));
assert.equal(photoUpload.detectImageContentType(Uint8Array.from([0xff, 0xd8, 0xff]).buffer), "image/jpeg");
assert.equal(photoUpload.detectImageContentType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]).buffer), "image/png");
assert.equal(photoUpload.detectImageContentType(Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]).buffer), "image/webp");
assert.equal(photoUpload.detectImageContentType(Uint8Array.from([1, 2, 3]).buffer), null);

const pngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
]).buffer;
let binaryRequest = null;
globalThis.wx = {
  getFileSystemManager: () => ({
    readFile: ({ success }) => success({ data: pngBytes }),
  }),
  getImageInfo: ({ success }) => success({ width: 1, height: 1 }),
  cloud: {
    callContainer: (options) => {
      binaryRequest = options;
      options.success({
        statusCode: 201,
        data: { mediaId: "media_probe", byteSize: pngBytes.byteLength, contentType: "image/png", status: "quarantined" },
      });
    },
  },
};
const uploaded = await photoUpload.uploadPublicPhoto("mock-photo.png");
assert.equal(uploaded.mediaId, "media_probe");
assert.equal(binaryRequest.path, "/api/public/media");
assert.equal(binaryRequest.method, "POST");
assert.equal(binaryRequest.apiVersion, 1);
assert.equal(binaryRequest.header["content-type"], "image/png");
assert.strictEqual(binaryRequest.data, pngBytes);
delete globalThis.wx;

const svgHighlight = require(join(outDir, "svg-highlight.cjs"));
const highlightedSvg = svgHighlight.injectSvgHighlight(
  '<svg viewBox="0 0 10 10"><g id="building:a.b"><path d="M0 0"/></g></svg>',
  ["building:a.b", "building:a.b"],
  "match",
);
assert.match(highlightedSvg, /#building\\:a\\\.b path/);
assert.match(highlightedSvg, /fill: rgba\(215, 232, 243, 0\.95\) !important/);
assert.match(highlightedSvg, /stroke: #1e80c1 !important/);
assert.match(highlightedSvg, /stroke-width: 1\.8 !important/);
assert.match(highlightedSvg, /<path d="M0 0" style="fill: rgba\(215, 232, 243, 0\.95\) !important/);
assert.equal((highlightedSvg.match(/#building\\:a\\\.b path/g) ?? []).length, 1, "重复楼宇 id 应去重");
const selectedSvg = svgHighlight.injectSvgHighlight(
  '<svg viewBox="0 0 10 10"><g id="building"><rect width="1" height="1"/></g></svg>',
  ["building"],
  "selected",
);
assert.match(selectedSvg, /fill: rgba\(215, 232, 243, 1\) !important/);
assert.match(selectedSvg, /stroke-width: 3 !important/);
assert.equal(svgHighlight.injectSvgHighlight("<svg></svg>", [], "match"), null);

const wxml = readFileSync(join(root, "miniprogram/miniprogram/pages/map/map.wxml"), "utf8");
const mapSource = readFileSync(join(root, "miniprogram/miniprogram/pages/map/map.ts"), "utf8");
const bindings = [...wxml.matchAll(/(?:bind|catch)[a-zA-Z-]*="([a-zA-Z_$][\w$]*)"/g)].map((match) => match[1]);
const missing = [...new Set(bindings)].filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(mapSource));
assert.deepEqual(missing, [], `地图 WXML 事件缺少处理器：${missing.join(", ")}`);
assert.match(mapSource, /writeLocalTextAsset\("campus-map"/);
assert.match(mapSource, /filterHighlightActive:/);
assert.match(mapSource, /filterHighlightedBuildingCount:/);
assert.doesNotMatch(mapSource, /assetUrl:\s*`\$\{config\.apiBaseUrl\}\/api\/public\/maps/);
assert.doesNotMatch(mapSource, /item\.url\s*&&\s*!item\.local/, "本地详情图片也应支持大图预览");
const baseLayerIndex = wxml.indexOf('src="{{assetUrl}}"');
const filterLayerIndex = wxml.indexOf('src="{{filterHighlightUrl}}"');
const eventLayerIndex = wxml.indexOf('src="{{eventOverlayUrl}}"');
assert.ok(
  baseLayerIndex >= 0 && baseLayerIndex < filterLayerIndex && filterLayerIndex < eventLayerIndex,
  "筛选楼宇覆盖层应位于底图与运营事件层之间",
);

const app = JSON.parse(readFileSync(join(root, "miniprogram/miniprogram/app.json"), "utf8"));
assert.ok(app.pages.includes("pages/feedback/feedback"));

const feedbackWxml = readFileSync(join(root, "miniprogram/miniprogram/pages/feedback/feedback.wxml"), "utf8");
const feedbackSource = readFileSync(join(root, "miniprogram/miniprogram/pages/feedback/feedback.ts"), "utf8");
const feedbackBindings = [...feedbackWxml.matchAll(/(?:bind|catch)[a-zA-Z-]*="([a-zA-Z_$][\w$]*)"/g)]
  .map((match) => match[1]);
const missingFeedbackHandlers = [...new Set(feedbackBindings)]
  .filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(feedbackSource));
assert.deepEqual(missingFeedbackHandlers, [], `反馈 WXML 事件缺少处理器：${missingFeedbackHandlers.join(", ")}`);
assert.match(feedbackSource, /const MAX_PHOTOS = 3/);
assert.match(feedbackSource, /photoMediaIds:[\s\S]*\.filter\([\s\S]*\.map\(/);
assert.match(feedbackWxml, /bindtap="choosePhotos"/);
assert.match(feedbackSource, /uploadPublicPhoto\(path\)/);

const webviewWxml = readFileSync(join(root, "miniprogram/miniprogram/pages/webview/webview.wxml"), "utf8");
assert.match(webviewWxml, /无法直接打开\{\{title\}\}/);
assert.doesNotMatch(webviewWxml, /预约页面/);

console.log("miniprogram-client-alignment: all assertions passed");

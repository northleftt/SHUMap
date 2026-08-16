// 腾讯选点组件（locpicker）的接线自验。
//
// 这个文件存在的唯一理由：locpicker 的两个接线细节写错了都不报错，只表现为
// 「地图能用但永远收不到选点」，肉眼极难定位。已经踩过一次（origin 校验写成
// iframe 自己的域，导致每条消息被丢弃），所以把实测结论钉在测试里。
//
// 下面的 origin 与 payload 是在真实浏览器里点击选点器抓到的原样值。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isCenterEcho,
  isTencentOrigin,
  locpickerUrl,
  readLocationPickerMessage,
  TENCENT_LOCPICKER_ORIGIN,
  TENCENT_MESSAGE_ORIGINS,
} from "../shared/tencent-locpicker.mjs";

// 真实抓包：iframe 的 src 在 apis.map.qq.com，但消息从 mapapi.qq.com 发来。
const OBSERVED_MESSAGE_ORIGIN = "https://mapapi.qq.com";
// 注意：这条恰好就是「载入回显」——坐标逐位等于我们传进去的宝山中心
// (121.3945, 31.3164)。当初把它当成一次成功选点，于是校准器里多出了一个
// 残差 509m 的假控制点。留着它当 fixture，正好用来钉住回显判据。
const OBSERVED_PAYLOAD = {
  module: "locationPicker",
  latlng: { lat: 31.3164, lng: 121.3945 },
  poiaddress: "上海市宝山区东外环路",
  poiname: "宝山区上海大学(宝山校区)",
  cityname: "上海市",
};
const BAOSHAN_CENTER = { longitude: 121.3945, latitude: 31.3164 };

test("实测的消息 origin 必须被接受（回归：写成 iframe 自己的域会丢掉所有选点）", () => {
  assert.ok(
    isTencentOrigin(OBSERVED_MESSAGE_ORIGIN),
    `${OBSERVED_MESSAGE_ORIGIN} 是实际发消息的域，必须在白名单里`,
  );
  // iframe 自身的域也保留，以防组件日后改回从页面自己发。
  assert.ok(isTencentOrigin(TENCENT_LOCPICKER_ORIGIN));
  assert.ok(TENCENT_MESSAGE_ORIGINS.includes(OBSERVED_MESSAGE_ORIGIN));
});

test("origin 是逐字全等比对，不接受后缀/子串匹配", () => {
  // endsWith(".qq.com") 之类会把任意子域甚至攻击者控制的域放进来。
  for (const origin of [
    "https://evil.qq.com",
    "https://mapapi.qq.com.evil.com",
    "http://mapapi.qq.com", // 明文
    "https://mapapi.qq.com/", // 带尾斜杠不是合法 origin
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(isTencentOrigin(origin), false, `${String(origin)} 不应通过`);
  }
});

test("实测 payload 能解析出 GCJ-02 坐标与 POI 名称", () => {
  const pick = readLocationPickerMessage(OBSERVED_PAYLOAD);
  assert.ok(pick, "实测 payload 必须能解析");
  assert.equal(pick.longitude, 121.3945);
  assert.equal(pick.latitude, 31.3164);
  assert.equal(pick.name, "宝山区上海大学(宝山校区)");
  assert.equal(pick.address, "上海市宝山区东外环路");
  assert.equal(pick.city, "上海市");
});

test("回传坐标系与库里导航点的坐标系一致，可直接入库", () => {
  // coordtype=5 = 腾讯/Google/高德坐标系 = GCJ-02。契约常量是 .ts，node 不能直接
  // import，改为断言源码文本——这里要钉的是「两者相等」这件事本身。
  const contract = readFileSync(new URL("../shared/revision-contract.ts", import.meta.url), "utf8");
  assert.match(contract, /NAVIGATION_CRS\s*=\s*"GCJ02"/);
  const picker = readFileSync(new URL("../shared/tencent-locpicker.mjs", import.meta.url), "utf8");
  assert.match(picker, /coordtype:\s*"5"/);
});

test("载入回显必须被识别出来（回归：曾被当成选点，造出 509m 残差的假控制点）", () => {
  const echo = readLocationPickerMessage(OBSERVED_PAYLOAD);
  assert.ok(echo, "回显本身是一条合法选点消息，形状上无法与真实选点区分");
  assert.equal(
    isCenterEcho(echo, BAOSHAN_CENTER),
    true,
    "坐标逐位等于传入的中心，必须判为回显",
  );
});

test("中心附近的真实点击不被误杀（所以判据用全等而不是容差）", () => {
  // 只差最后一位小数（约 1 厘米）也是真实点击，不能当回显丢掉。
  for (const latlng of [
    { lat: 31.3164, lng: 121.3945001 },
    { lat: 31.3164001, lng: 121.3945 },
    { lat: 31.316401, lng: 121.394501 },
  ]) {
    const pick = readLocationPickerMessage({ module: "locationPicker", latlng });
    assert.ok(pick);
    assert.equal(isCenterEcho(pick, BAOSHAN_CENTER), false, `${JSON.stringify(latlng)} 是真实点击`);
  }
});

test("isCenterEcho 只在两者都给全时判真", () => {
  const pick = readLocationPickerMessage(OBSERVED_PAYLOAD);
  assert.equal(isCenterEcho(pick, { longitude: 121.2487, latitude: 31.377 }), false, "别的校区中心不算");
  assert.equal(isCenterEcho(null, BAOSHAN_CENTER), false);
  assert.equal(isCenterEcho(pick, null), false);
});

test("校准器丢弃回显，判据用的是当前校区的中心", () => {
  const source = readFileSync(new URL("../src/admin/components/GeoCalibrator.tsx", import.meta.url), "utf8");
  assert.match(source, /isCenterEcho\(pick,\s*center\)/, "必须调用回显判据");
  // center 必须取自当前校区，而不是写死某一个校区。
  assert.match(source, /const center = CAMPUS_CENTER\[campusKey\]/);
  // 中心随校区变，监听器要跟着重建，否则切到别的校区后判据还在用旧中心。
  const listener = source.slice(source.indexOf("const center = CAMPUS_CENTER[campusKey]"));
  assert.match(listener.slice(0, 1600), /\}, \[campusKey\]\)/, "message 监听的依赖必须含 campusKey");
  // iframe 的 coord 与回显判据必须同源，否则判据永远命不中。
  assert.match(source, /locpickerUrl\(\{ key: TENCENT_KEY, \.\.\.CAMPUS_CENTER\[campusKey\] \}\)/);
});

test("payload 是 JSON 字符串时同样能解析", () => {
  // 同一页上混着地图组件的其他消息，两种形态都得接。
  const pick = readLocationPickerMessage(JSON.stringify(OBSERVED_PAYLOAD));
  assert.ok(pick);
  assert.equal(pick.latitude, 31.3164);
  assert.equal(pick.longitude, 121.3945);
});

test("非选点消息一律返回 null（靠 module 判别，不是「有 latlng 就算」）", () => {
  const rejected = [
    null,
    undefined,
    "",
    "not json",
    "[1,2,3]",
    [OBSERVED_PAYLOAD],
    {},
    { module: "somethingElse", latlng: { lat: 31.3, lng: 121.4 } },
    { latlng: { lat: 31.3, lng: 121.4 } }, // 缺 module
    { module: "locationPicker" }, // 缺 latlng
    { module: "locationPicker", latlng: null },
    { module: "locationPicker", latlng: { lat: "31.3", lng: "121.4" } }, // 字符串坐标
    { module: "locationPicker", latlng: { lat: Number.NaN, lng: 121.4 } },
    { module: "locationPicker", latlng: { lat: 91, lng: 121.4 } }, // 越界
    { module: "locationPicker", latlng: { lat: 31.3, lng: 181 } },
  ];
  for (const data of rejected) {
    assert.equal(readLocationPickerMessage(data), null, `${JSON.stringify(data)} 不应被当作选点`);
  }
});

test("缺失的 POI 文本字段降级成空串而不是 undefined", () => {
  const pick = readLocationPickerMessage({ module: "locationPicker", latlng: { lat: 31.3, lng: 121.4 } });
  assert.ok(pick);
  assert.deepEqual(
    { name: pick.name, address: pick.address, city: pick.city },
    { name: "", address: "", city: "" },
  );
});

test("URL 的 coord 是纬度在前（写反了地图会开到别处，且不报错）", () => {
  const url = new URL(locpickerUrl({ key: "K", longitude: 121.3945, latitude: 31.3164 }));
  assert.equal(url.origin, TENCENT_LOCPICKER_ORIGIN);
  assert.equal(url.pathname, "/tools/locpicker");
  assert.equal(url.searchParams.get("coord"), "31.3164,121.3945");
  // type=1 才是 iframe 模式；coordtype=5 才是 GCJ-02。
  assert.equal(url.searchParams.get("type"), "1");
  assert.equal(url.searchParams.get("coordtype"), "5");
  assert.equal(url.searchParams.get("key"), "K");
  assert.equal(url.searchParams.get("referer"), "SHUMap");
  assert.equal(url.searchParams.get("zoom"), "17");
});

test("locpickerUrl 拒绝非有限坐标", () => {
  assert.throws(() => locpickerUrl({ key: "K", longitude: Number.NaN, latitude: 31.3 }), /finite/);
  assert.throws(() => locpickerUrl({ key: "K", longitude: 121.4, latitude: undefined }), /finite/);
});

test("校准器走 shared 模块，没有另抄一份 origin / URL 拼装", () => {
  const source = readFileSync(new URL("../src/admin/components/GeoCalibrator.tsx", import.meta.url), "utf8");
  assert.match(source, /from "\.\.\/\.\.\/\.\.\/shared\/tencent-locpicker\.mjs"/);
  assert.match(source, /isTencentOrigin\(event\.origin\)/);
  // 域名与 coord 拼装都不该在组件里重现，否则这个测试就保护不到它了。
  assert.doesNotMatch(source, /mapapi\.qq\.com/);
  assert.doesNotMatch(source, /tools\/locpicker/);
});

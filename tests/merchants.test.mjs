// Unit tests for the release -> front-end merchant projection
// (src/lib/release/merchants.ts). The module is asset-import free so it can be
// loaded directly; it is copied to a .mts path because the package is
// "type": "commonjs" and Node only strips types for ES modules.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src/lib/release/merchants.ts");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shumap-merchants-"));
const modulePath = path.join(tempDir, "merchants.mts");
fs.copyFileSync(source, modulePath);
const { groupMerchantsByPlace, normalizeMerchant } = await import(modulePath);

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("merchants group onto their host place and sort by name", () => {
  const grouped = groupMerchantsByPlace([
    { id: "m2", hostPlaceId: "place_lib", displayName: "B 咖啡" },
    { id: "m1", hostPlaceId: "place_lib", displayName: "A 面馆" },
    { id: "m3", hostPlaceId: "place_canteen", displayName: "三食堂窗口" },
  ]);
  assert.deepEqual([...grouped.keys()].sort(), ["place_canteen", "place_lib"]);
  assert.deepEqual(grouped.get("place_lib").map((m) => m.id), ["m1", "m2"]);
  assert.equal(grouped.get("place_canteen").length, 1);
});

test("outlets without a host place are dropped (no standalone merchant page)", () => {
  const grouped = groupMerchantsByPlace([
    { id: "m1", hostPlaceId: null, displayName: "无绑定门店" },
    { id: "m2", hostPlaceId: "", displayName: "空绑定门店" },
  ]);
  assert.equal(grouped.size, 0);
});

test("a missing merchants array yields an empty grouping", () => {
  assert.equal(groupMerchantsByPlace(undefined).size, 0);
  assert.equal(groupMerchantsByPlace(null).size, 0);
  assert.equal(groupMerchantsByPlace([]).size, 0);
});

test("extension fields are read from the merchant revision payload", () => {
  const merchant = normalizeMerchant({
    id: "m1",
    hostPlaceId: "place_lib",
    floorId: "floor_1",
    displayName: "校园咖啡",
    businessType: "  咖啡轻食  ",
    openingHours: { text: "08:00 - 20:00" },
    contact: { phone: "6613 5200" },
    content: { avgPrice: "¥15", stallCode: "A12", summary: "图书馆一层西侧" },
  });
  assert.equal(merchant.businessType, "咖啡轻食");
  assert.equal(merchant.openingHours, "08:00 - 20:00");
  assert.equal(merchant.phone, "6613 5200");
  assert.equal(merchant.avgPrice, "¥15");
  assert.equal(merchant.stallCode, "A12");
  assert.equal(merchant.summary, "图书馆一层西侧");
  assert.equal(merchant.floorId, "floor_1");
});

test("opening hours and contact accept plain strings as well as objects", () => {
  const merchant = normalizeMerchant({
    id: "m1",
    hostPlaceId: "place_lib",
    displayName: "窗口",
    openingHours: "07:00 - 19:00",
    contact: "6613 0000",
  });
  assert.equal(merchant.openingHours, "07:00 - 19:00");
  assert.equal(merchant.phone, "6613 0000");
});

test("content.menu is normalized: unnamed entries dropped, prices stringified", () => {
  const merchant = normalizeMerchant({
    id: "m1",
    hostPlaceId: "place_lib",
    displayName: "校园咖啡",
    content: {
      menu: [
        { name: "拿铁", price: 15, description: "中杯" },
        { name: "美式" },
        { price: "¥9" },
        "not an object",
        null,
      ],
    },
  });
  assert.deepEqual(merchant.menu, [
    { name: "拿铁", price: "15", description: "中杯" },
    { name: "美式", price: "", description: "" },
  ]);
});

test("absent optional fields normalize to empty strings rather than undefined", () => {
  const merchant = normalizeMerchant({ id: "m1", hostPlaceId: "place_lib", displayName: "窗口" });
  assert.equal(merchant.businessType, "");
  assert.equal(merchant.openingHours, "");
  assert.equal(merchant.stallCode, "");
  assert.equal(merchant.avgPrice, "");
  assert.deepEqual(merchant.menu, []);
  assert.equal(merchant.floorId, null);
});

test("release search documents cover merchant outlets and inherit the host campus", () => {
  const releases = fs.readFileSync(path.join(root, "worker/modules/releases.ts"), "utf8");
  assert.match(releases, /merchant_outlet/);
  assert.match(releases, /campusByPlace/);
  assert.match(releases, /fallbackCampusId/);
  assert.match(releases, /merchantSearchText/);
});

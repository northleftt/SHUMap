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

function merchant(overrides = {}) {
  return {
    id: "merchant_default",
    organizationId: null,
    hostPlaceId: "place_default",
    floorId: null,
    indoorSpaceId: null,
    revisionId: "merchant_revision_default",
    displayName: "门店",
    businessType: null,
    openingHours: null,
    contact: null,
    content: {},
    contentHash: "hash",
    ...overrides,
  };
}

test("merchants group onto their host place and sort by name", () => {
  const grouped = groupMerchantsByPlace([
    merchant({ id: "m2", hostPlaceId: "place_lib", displayName: "B 咖啡" }),
    merchant({ id: "m1", hostPlaceId: "place_lib", displayName: "A 面馆" }),
    merchant({ id: "m3", hostPlaceId: "place_canteen", displayName: "三食堂窗口" }),
  ]);
  assert.deepEqual([...grouped.keys()].sort(), ["place_canteen", "place_lib"]);
  assert.deepEqual(grouped.get("place_lib").map((m) => m.id), ["m1", "m2"]);
  assert.equal(grouped.get("place_canteen").length, 1);
});

test("independent outlets stay out of host-place groups", () => {
  const grouped = groupMerchantsByPlace([merchant({ id: "m1", hostPlaceId: null })]);
  assert.equal(grouped.size, 0);
});

test("an empty merchants array yields an empty grouping", () => {
  assert.equal(groupMerchantsByPlace([]).size, 0);
});

test("extension fields are read from the merchant revision payload", () => {
  const normalized = normalizeMerchant(merchant({
    id: "m1",
    hostPlaceId: "place_lib",
    floorId: "floor_1",
    displayName: "校园咖啡",
    businessType: "  咖啡轻食  ",
    openingHours: { text: "08:00 - 20:00" },
    contact: { phone: "6613 5200" },
    content: { avgPrice: "¥15", stallCode: "A12", summary: "图书馆一层西侧" },
  }));
  assert.equal(normalized.businessType, "咖啡轻食");
  assert.equal(normalized.openingHours, "08:00 - 20:00");
  assert.equal(normalized.phone, "6613 5200");
  assert.equal(normalized.avgPrice, "¥15");
  assert.equal(normalized.stallCode, "A12");
  assert.equal(normalized.summary, "图书馆一层西侧");
  assert.equal(normalized.floorId, "floor_1");
});

test("opening hours and contact require their canonical object shapes", () => {
  assert.throws(
    () => normalizeMerchant(merchant({ openingHours: "07:00 - 19:00" })),
    /openingHours must be an object or null/,
  );
  assert.throws(
    () => normalizeMerchant(merchant({ contact: "6613 0000" })),
    /contact must be an object or null/,
  );
});

test("content.menu follows one exact schema", () => {
  const normalized = normalizeMerchant(merchant({
    id: "m1",
    hostPlaceId: "place_lib",
    displayName: "校园咖啡",
    content: {
      menu: [
        { name: "拿铁", price: "¥15", description: "中杯" },
        { name: "美式" },
      ],
    },
  }));
  assert.deepEqual(normalized.menu, [
    { name: "拿铁", price: "¥15", description: "中杯" },
    { name: "美式", price: "", description: "" },
  ]);
  assert.throws(
    () => normalizeMerchant(merchant({ content: { menu: [{ name: "拿铁", price: 15 }] } })),
    /content\.menu\[0\]\.price must be a string/,
  );
  assert.throws(
    () => normalizeMerchant(merchant({ content: { menu: [{ price: "¥9" }] } })),
    /content\.menu\[0\]\.name must be non-empty/,
  );
});

test("absent optional fields stay empty in the display model", () => {
  const normalized = normalizeMerchant(merchant({ id: "m1", hostPlaceId: "place_lib", displayName: "窗口" }));
  assert.equal(normalized.businessType, "");
  assert.equal(normalized.openingHours, "");
  assert.equal(normalized.stallCode, "");
  assert.equal(normalized.avgPrice, "");
  assert.deepEqual(normalized.menu, []);
  assert.equal(normalized.floorId, null);
});

test("release search documents cover merchant outlets and inherit the host campus", () => {
  const releases = fs.readFileSync(path.join(root, "worker/modules/releases.ts"), "utf8");
  assert.match(releases, /merchant_outlet/);
  assert.match(releases, /campusByPlace/);
  assert.match(releases, /merchantSearchText/);
});

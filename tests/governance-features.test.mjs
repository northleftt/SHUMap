import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function freshDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(read(`migrations-v2/${name}`));
  }
  return db;
}

test("volunteer role has only collection permission", () => {
  const db = freshDatabase();
  const row = db.prepare("select permissions_json from roles where id='volunteer'").get();
  assert.deepEqual(JSON.parse(row.permissions_json), ["collect:data"]);
  assert.equal(JSON.parse(row.permissions_json).includes("read:admin"), false);
  db.close();
});

test("collection endpoints require the narrow account permission", () => {
  const worker = read("worker/index-v2.ts");
  assert.match(worker, /requireSession\(request, env, "collect:data"\)/);
  const collections = read("worker/modules/collections.ts");
  assert.match(collections, /assignee_user_id/);
  assert.match(collections, /row\.assigneeUserId === userId/);
});

test("revision tables carry structure and map filter rows are manageable", () => {
  const db = freshDatabase();
  for (const table of ["place_revisions", "facility_revisions", "merchant_revisions"]) {
    const columns = db.prepare(`pragma table_info(${table})`).all().map((row) => row.name);
    assert.ok(columns.includes("structure_json"));
  }
  const charging = db.prepare(`select c.label,t.code as facility_type_code
    from map_filter_categories c
    join map_filter_members m on m.category_id=c.id
    join facility_types t on t.id=m.facility_type_id
   where c.key='charging'`).get();
  assert.deepEqual({ ...charging }, { label: "充电桩", facility_type_code: "charging_station" });
  db.close();
});

test("facility locations are changed only through reviewed revision structures", () => {
  const facilities = read("worker/modules/facilities.ts");
  const reviews = read("worker/modules/reviews.ts");
  const router = read("worker/index-v2.ts");
  assert.match(facilities, /normalizeFacilityRevision/);
  assert.match(reviews, /replaceLocationStatements\(env, principal, "facility"/);
  assert.doesNotMatch(router, /\/api\/admin\/facilities\/:id\/location/);
});

test("journeys enforce boarding and alighting rules plus added dates", () => {
  const source = read("worker/modules/transit.ts");
  assert.match(source, /fps\.pickup_type<>'none'/);
  assert.match(source, /tps\.dropoff_type<>'none'/);
  assert.match(source, /fps\.pickup_type<>'reservation_only'/);
  assert.match(source, /exception_type='added'/);
});

test("campus-lines 校区对校区模型：线路级预约与写入侧收紧（0024）", () => {
  const source = read("worker/modules/transit.ts");
  const router = read("worker/index-v2.ts");
  // 写入侧 pickup_type 收紧：拒 reservation_only（读侧 journeys 查询保留兼容）
  assert.match(source, /PICKUP_WRITE_TYPES = \["regular", "none"\]/);
  // 预约是线路级属性：transit_routes 写入带 booking_policy/booking_url
  assert.match(source, /insert into transit_routes\([^)]*booking_policy[^)]*booking_url[^)]*\)/);
  // updateRoute 级联覆盖 active 班次的 booking_policy
  assert.match(source, /update transit_trips set booking_policy=\?/);
  // campus-lines 公共端点注册到路由
  assert.match(router, /path === "\/api\/public\/transit\/campus-lines"/);
  assert.match(router, /publicCampusLines\(request, env\)/);
});

test("release manifest publishes dynamic filters and aliases are searchable", () => {
  const source = read("worker/modules/releases.ts");
  assert.match(source, /map_filter_categories where active=1/);
  assert.match(source, /name_type in \('alias','former','short','english'\)/);
  assert.match(source, /mapFilters/);
});

test("content image uploads reject svg and map svg upload requires map permission", () => {
  const media = read("worker/modules/media.ts");
  const router = read("worker/index-v2.ts");
  assert.match(media, /PUBLIC_UPLOAD_TYPES = new Set\(\["image\/jpeg", "image\/png", "image\/webp"\]\)/);
  assert.match(router, /path === "\/api\/admin\/maps\/upload-intents"[\s\S]*?requireSession\(request, env, "write:maps"\)/);
  assert.match(router, /path === "\/api\/admin\/media"[\s\S]*?requireSession\(request, env, "write:content"\)/);
});

test("editors submit complete reviewed structures and omit blank location rows", () => {
  const place = read("src/admin/pages/PlaceEditorPage.tsx");
  const facility = read("src/admin/pages/FacilityEditorPage.tsx");
  const merchant = read("src/admin/pages/MerchantEditorPage.tsx");
  assert.match(place, /parentPlaceId: parentPlaceId \|\| null/);
  assert.match(place, /filter\(\(location\) => !isLocationDraftBlank\(location\)\)/);
  assert.match(facility, /indoorSpaceId: indoorSpaceId \|\| null,[\s\S]*?quantity: parsedQuantity,[\s\S]*?operationalStatus,[\s\S]*?locations:/);
  assert.match(merchant, /indoorSpaceId: indoorSpaceId \|\| null,[\s\S]*?locations:/);
});

test("revision hashes cover structural data and floor media rehash keeps it", () => {
  const place = read("worker/modules/places.ts");
  const facility = read("worker/modules/facilities.ts");
  const merchant = read("worker/modules/merchants.ts");
  const review = read("worker/modules/reviews.ts");
  assert.match(place, /\$\{contentJson\}\\n\$\{structureJson\}/);
  assert.match(facility, /\$\{contentJson\}\\n\$\{structureJson\}/);
  assert.match(merchant, /\$\{contentJson\}\\n\$\{structureJson\}/);
  assert.match(review, /structure_json as structureJson/);
  assert.match(review, /\$\{row\.structureJson\}/);
});

test("transit stop sequence editor submits the complete chosen sequence", () => {
  const page = read("src/admin/pages/TransitPage.tsx");
  const worker = read("worker/modules/transit.ts");
  // 站点顺序编辑器把完整序列交给 replace-transit-pattern-stops（增删改都走这一个调用）
  assert.match(page, /replaceTransitPatternStops\(selectedPatternId, sequence\)/);
  assert.doesNotMatch(page, /stops\.slice\(0, 2\)/);
  assert.match(worker, /A stop can appear only once in a pattern/);
  assert.match(worker, /MAX_PATTERN_STOPS/);
});

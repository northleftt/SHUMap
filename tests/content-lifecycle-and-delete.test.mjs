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

// 地点与设施此前只能新建，建错了没有任何移除入口。补的是两条通道：停用（保留历史，
// 首选）与删除（只清建错的数据）。这里盯住 schema 上「为什么必须先数引用」的部分。

test("places and facilities are referenced by restrict, so a blind delete would be a 500", () => {
  const schema = read("migrations-v2/0001_architecture_v2.sql");
  // 这几处都是 on delete restrict：硬删会撞外键。deletePlace/deleteFacility 因此
  // 必须先数一遍引用再回 409，而不是把数据库错误漏成 500。
  assert.match(schema, /parent_place_id text references places\(id\) on delete restrict/);
  assert.match(schema, /host_place_id text references places\(id\) on delete restrict/);
  assert.match(schema, /place_id text references places\(id\) on delete restrict/);
});

// 0001 已经种好了三个校区，这里用现成的 campus_baoshan，不再插一个重复 code。
// kind 用 other：0011 里只有它这一档的筛选组默认是启用的，而 0012 的
// require_place_active_map_filter_insert 会拒掉分类没有启用筛选组的地点。
const SEED = `insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
    values('place_parent','other','campus_baoshan','active','2026-08-01','2026-08-01');
  insert into places(id,kind_id,campus_id,parent_place_id,lifecycle_status,created_at,updated_at)
    values('place_child','other','campus_baoshan','place_parent','active','2026-08-01','2026-08-01');`;

test("a place with children cannot be deleted at the database level", () => {
  const db = database();
  db.exec(SEED);
  assert.throws(
    () => db.exec("delete from places where id='place_parent'"),
    /FOREIGN KEY/i,
    "有下级地点时数据库就会拒绝，所以 handler 必须先回 409",
  );
});

test("retiring is always allowed even when deleting is not", () => {
  const db = database();
  db.exec(SEED);
  // 0012 的 require_place_active_map_filter_update 在 retired 时不生效，
  // 所以「停用」这条路不会被筛选组归属挡住 —— 它必须永远走得通。
  db.exec("update places set lifecycle_status='retired' where id='place_parent'");
  const row = db.prepare("select lifecycle_status as status from places where id='place_parent'").get();
  assert.equal(row.status, "retired");
});

test("the map filter trigger only guards non-retired rows", () => {
  const guard = read("migrations-v2/0012_map_filter_integrity.sql");
  assert.match(guard, /before update of kind_id,lifecycle_status on places\s*\nwhen new\.lifecycle_status <> 'retired'/);
  assert.match(guard, /before update of facility_type_id,lifecycle_status on facility_instances\s*\nwhen new\.lifecycle_status <> 'retired'/);
});

test("both handlers count references and refuse released entities", () => {
  const places = read("worker/modules/places.ts");
  const facilities = read("worker/modules/facilities.ts");
  for (const [source, code] of [[places, "place"], [facilities, "facility"]]) {
    assert.match(source, new RegExp(`${code}_in_use`), `${code} 需要一个可读的占用错误码`);
    // 发布过的实体删掉会让历史 release 的 release_items 指向不存在的行，
    // 而那些快照是回滚的依据。
    assert.match(source, new RegExp(`${code}_released`));
    assert.match(source, /from release_items where entity_type=/);
  }
});

test("retiring an entity also retires its location bindings", () => {
  const places = read("worker/modules/places.ts");
  const facilities = read("worker/modules/facilities.ts");
  const locations = read("worker/modules/locations.ts");
  // entity_locations 是独立时间轴，不跟着 lifecycle 走。留着会让唯一索引
  // （idx_entity_locations_one_primary / one_active_footprint）在下次编辑时才炸。
  assert.match(places, /retireEntityLocations\(env, "place", placeId\)/);
  assert.match(facilities, /retireEntityLocations\(env, "facility", facilityId\)/);
  // 重新启用必须把最近一次停用关掉的绑定打开，否则楼宇没有 footprint，
  // 下一版发布会卡在「必须恰好一个 footprint」。
  assert.match(locations, /export async function restoreEntityLocations/);
  assert.match(places, /else if \(before.lifecycle_status === "retired"\) await restoreEntityLocations\(env, "place", placeId\)/);
  assert.match(facilities, /else if \(before.lifecycle_status === "retired"\) await restoreEntityLocations\(env, "facility", facilityId\)/);
});

test("reopening the last retired location bindings does not hit uniqueness", () => {
  const db = database();
  db.exec(SEED);
  db.exec(`
    insert into location_anchors(
      id,campus_id,role,geometry_type,geometry_json,crs,precision_level,verification_status,created_at,updated_at
    ) values(
      'anchor_restore','campus_baoshan','primary_display',
      'Point','{"type":"Point","coordinates":[121.4,31.3]}','GCJ02','exact','verified','2026-08-01','2026-08-01'
    );
    insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,valid_from,valid_to,created_at)
      values('eloc_restore','place','place_parent','anchor_restore','primary_display',1,'2026-08-01',null,'2026-08-01');
  `);
  db.exec("update entity_locations set valid_to='2026-08-20' where id='eloc_restore'");
  assert.equal(
    db.prepare("select valid_to as validTo from entity_locations where id='eloc_restore'").get().validTo,
    "2026-08-20",
  );
  db.exec("update entity_locations set valid_to=null where id='eloc_restore'");
  const row = db.prepare("select valid_to as validTo from entity_locations where id='eloc_restore'").get();
  assert.equal(row.validTo, null);
  db.close();
});

test("deleting an entity clears its anchors rather than orphaning them", () => {
  const schema = read("migrations-v2/0001_architecture_v2.sql");
  // entity_locations.anchor_id 是 cascade，但反向不是：删掉绑定不会带走
  // location_anchors 行。两个 handler 都显式删锚点。
  assert.match(schema, /anchor_id text not null references location_anchors\(id\) on delete cascade/);
  for (const file of ["worker/modules/places.ts", "worker/modules/facilities.ts"]) {
    const source = read(file);
    assert.match(source, /delete from location_anchors where id in/, `${file} 必须清掉自己的锚点`);
  }
});

test("the endpoints are registered with write:content gating", () => {
  const router = read("worker/index-v2.ts");
  for (const fragment of [
    /"\/api\/admin\/places\/:id\/lifecycle"/,
    /"\/api\/admin\/facilities\/:id\/lifecycle"/,
  ]) {
    assert.match(router, fragment);
  }
  // 删除与停用都是写操作，不能只靠 read:admin。逐个盯住调用点前面那一行
  // requireSession 的 scope —— 只数出现次数的话，import 行也会被算进来。
  for (const handler of ["deletePlace", "deleteFacility", "updatePlaceLifecycle", "updateFacilityLifecycle"]) {
    const callSite = new RegExp(
      `requireSession\\(request, env, "write:content"\\);\\s*\\n\\s*return ${handler}\\(`,
    );
    assert.match(router, callSite, `${handler} 必须挂在 write:content 后面`);
  }
});

test("the admin list surfaces lifecycle and offers retire before delete", () => {
  const page = read("src/admin/pages/ContentPage.tsx");
  // 之前这张表上删除/停用按钮数为 0，建错的数据只能一直留着。
  assert.match(page, /<LifecyclePill status=\{row\.lifecycle\}/);
  assert.match(page, /停用/);
  assert.match(page, /window\.confirm/);
  // 停用不是终点：列表和地点编辑器都要能改回启用，否则楼宇下架后只能新建。
  assert.match(page, /启用/);
  assert.match(page, /updatePlaceLifecycle\(p\.id, "active"\)/);
  assert.match(read("src/admin/pages/PlaceEditorPage.tsx"), /updatePlaceLifecycle\(id, next\)/);
  // 409 的机器码要翻成能照着做的话。
  assert.match(page, /place_in_use:/);
  assert.match(page, /facility_released:/);
  // 商户没有删除端点，那一列必须是 null 而不是指向一个不存在的接口。
  assert.match(page, /remove: null/);
});

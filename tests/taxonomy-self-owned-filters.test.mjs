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

// ---------------------------------------------------------------------------
// 后台曾把「筛选按钮」当成一层独立对象：新建一个类型前，先得建一个按钮、再把类型放
// 进去。但库里的按钮与成员是一对一的——「容器」的分组能力一次都没用上，屏幕上却多出
// 一层要求维护者先理解的东西。
//
// 现在新建类型时服务端顺手建好它自己那个按钮。这组断言盯住两件事：一是真实数据确实
// 是一对一（否则合并会丢信息），二是新的建 / 删语句顺序能过 0012 那几个触发器。
// ---------------------------------------------------------------------------

test("every seeded filter carries exactly one member, so the container layer held nothing", () => {
  const db = database();
  const shared = db.prepare(
    `select c.id,(select count(*) from map_filter_members m where m.category_id=c.id) as members
       from map_filter_categories c
      where (select count(*) from map_filter_members m where m.category_id=c.id) <> 1`,
  ).all();
  assert.deepEqual(shared, [], "一个按钮装两样东西的分组能力从未被使用");
  db.close();
});

test("a place kind and its own filter can be created in one batch", () => {
  const db = database();
  // 与 createPlaceKind 的语句顺序一致：类型 → 按钮 → 成员。
  // 0012 的 require_place_active_map_filter_insert 只在写 places 时才检查，所以
  // place_kinds 先落库不会被拒；真正的考验是随后建的地点能不能过。
  db.exec(`
    insert into place_kinds(id,name,sort_order,is_searchable) values('museum','博物馆',70,1);
    insert into map_filter_categories(id,key,label,active,sort_order,created_at,updated_at)
      values('mapfilter_museum','museum','博物馆',1,70,datetime('now'),datetime('now'));
    insert into map_filter_members(id,category_id,place_kind_id,facility_type_id,includes_merchants,sort_order,created_at)
      values('member_museum','mapfilter_museum','museum',null,0,100,datetime('now'));
  `);
  db.exec(`
    insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
      values('place_museum','museum','campus_baoshan','active',datetime('now'),datetime('now'));
  `);
  const row = db.prepare(
    `select c.label from places p
       join map_filter_members m on m.place_kind_id=p.kind_id
       join map_filter_categories c on c.id=m.category_id
      where p.id='place_museum'`,
  ).get();
  assert.equal(row.label, "博物馆");
  db.close();
});

test("a facility type and its own filter survive the active-status trigger", () => {
  const db = database();
  // require_facility_type_active_map_filter_insert 要求类型在 status='active' 时
  // 就已经归属一个启用按钮。所以顺序必须是：disabled 的类型 → 按钮 → 成员 → 转 active。
  db.exec(`
    insert into facility_types(id,code,name,category,icon_key,visibility_policy_json,status,created_at,updated_at)
      values('facility_type_locker_v2','locker_v2','智能柜','amenity','locker','{}','disabled',datetime('now'),datetime('now'));
    insert into map_filter_categories(id,key,label,active,sort_order,created_at,updated_at)
      values('mapfilter_locker_v2','locker_v2','智能柜',1,300,datetime('now'),datetime('now'));
    insert into map_filter_members(id,category_id,place_kind_id,facility_type_id,includes_merchants,sort_order,created_at)
      values('member_locker_v2','mapfilter_locker_v2',null,'facility_type_locker_v2',0,100,datetime('now'));
    update facility_types set status='active' where id='facility_type_locker_v2';
  `);
  const status = db.prepare("select status from facility_types where id='facility_type_locker_v2'").get();
  assert.equal(status.status, "active");
  db.close();
});

test("building the filter after activating the type is what the trigger rejects", () => {
  const db = database();
  // 反证：颠倒顺序会被拒。这就是为什么两个 create 都不能图省事写成一条 insert。
  assert.throws(
    () => db.exec(`
      insert into facility_types(id,code,name,category,icon_key,visibility_policy_json,status,created_at,updated_at)
        values('facility_type_bad','bad','顺序错误','other','generic','{}','active',datetime('now'),datetime('now'));
    `),
    /active facility type must belong to an active map filter/,
  );
  db.close();
});

test("deleting an unused type takes its own filter with it", () => {
  const db = database();
  // 留下一个空按钮会被发版校验拒（Active map filter ... has no members），所以
  // deletePlaceKind / deleteFacilityType 会把按钮一并删掉。
  db.exec(`
    insert into place_kinds(id,name,sort_order,is_searchable) values('kiosk','岗亭',80,1);
    insert into map_filter_categories(id,key,label,active,sort_order,created_at,updated_at)
      values('mapfilter_kiosk','kiosk','岗亭',1,80,datetime('now'),datetime('now'));
    insert into map_filter_members(id,category_id,place_kind_id,facility_type_id,includes_merchants,sort_order,created_at)
      values('member_kiosk','mapfilter_kiosk','kiosk',null,0,100,datetime('now'));
  `);
  db.exec(`
    delete from map_filter_members where place_kind_id='kiosk';
    delete from map_filter_categories where id='mapfilter_kiosk';
    delete from place_kinds where id='kiosk';
  `);
  const orphan = db.prepare(
    `select c.id from map_filter_categories c
      where (select count(*) from map_filter_members m where m.category_id=c.id)=0`,
  ).all();
  assert.deepEqual(orphan, [], "删类型不能留下空按钮");
  db.close();
});

test("a filter carrying live places still cannot be hidden", () => {
  const db = database();
  // 合并入口不等于放宽约束：按钮的停用保护（protect_used_map_filter_deactivation）
  // 照旧生效，界面把它翻译成一句可读的中文而不是原始的 abort 文本。
  db.exec(`
    insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
      values('place_live','building','campus_baoshan','active',datetime('now'),datetime('now'));
  `);
  assert.throws(
    () => db.exec("update map_filter_categories set active=0 where id='map_filter_teaching'"),
    /map filter with live members cannot be deactivated/,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// 接口与界面：归属不再是可选项
// ---------------------------------------------------------------------------

test("neither create path asks the caller to pick a filter", () => {
  const kinds = read("worker/modules/map-filters.ts");
  const types = read("worker/modules/facility-types.ts");
  // 两个 create 都自己建按钮，不再从请求体里读 categoryId / mapFilterCategoryId。
  assert.match(kinds, /allocateMapFilterKey\(env, id\)/);
  assert.match(types, /allocateMapFilterKey\(env, code\)/);
  assert.doesNotMatch(kinds, /"categoryId"\]/);
  // 客户端的两个 create 入参里不能再有归属字段。响应里保留 mapFilterCategoryId 这个
  // 只读 id 是可以的（界面用它定位按钮），所以这里只盯写入参数，不搜整个文件。
  const client = read("src/lib/api/admin.ts");
  const createBodies = client.match(/export function create(PlaceKind|FacilityType)\(body: \{[^}]*\}/g);
  assert.equal(createBodies.length, 2);
  for (const body of createBodies) {
    assert.doesNotMatch(body, /categoryId/);
    assert.match(body, /filterLabel\?: string/);
  }
});

test("filter properties are edited as properties of the type", () => {
  const kinds = read("worker/modules/map-filters.ts");
  const types = read("worker/modules/facility-types.ts");
  for (const source of [kinds, types]) {
    assert.match(source, /"filterLabel", "filterSortOrder", "filterActive"|filterLabel/);
    // 按钮还挂着别的成员时拒绝就地改：那会牵连另一个类型。
    assert.match(source, /map_filter_shared/);
  }
});

test("the page presents two type lists rather than three layers", () => {
  const page = read("src/admin/pages/TaxonomyPage.tsx");
  assert.match(page, /function PlaceKindCard/);
  assert.match(page, /function FacilityTypeCard/);
  // 「移到别的标签」的下拉整个消失了 —— 归属不再是一件要决定的事。
  assert.doesNotMatch(page, /移到别的标签/);
  assert.doesNotMatch(page, /createMapFilterMember|updateMapFilterMember|deleteMapFilterMember/);
});

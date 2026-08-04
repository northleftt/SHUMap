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

// 楼外 POI 的渲染、录入与站点图钉在批次 12/13 打通后，实际操作后台仍有四处走不通。
// 这四组断言各盯住一处，都是「链路已经建好但入口被挡住」的形态。

// ---------------------------------------------------------------------------
// 一、四类楼外地点建不出来：它们的筛选标签在 0011 里是 active=0 落库的
// ---------------------------------------------------------------------------

const OUTDOOR_KINDS = ["outdoor_area", "service_place", "transit_stop", "sports_venue"];

test("the four outdoor place kinds can actually be created", () => {
  const db = database();
  // 0012 的 require_place_active_map_filter_insert 要求地点分类归属一个启用标签，
  // 而这四类的标签原本是停用的，于是后台一律回 inactive_place_kind。
  for (const kindId of OUTDOOR_KINDS) {
    db.prepare(
      `insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
       values(?,?,'campus_baoshan','active',datetime('now'),datetime('now'))`,
    ).run(`place_${kindId}`, kindId);
  }
  const count = db.prepare("select count(*) as total from places").get();
  assert.equal(count.total, OUTDOOR_KINDS.length);
  db.close();
});

test("each outdoor kind still belongs to exactly one active filter", () => {
  const db = database();
  // 发布校验要求「已发布的地点分类恰好归属一个启用标签」（releases.ts 的 ownerCount
  // 检查）。启用标签不能顺手多挂一条成员，否则 exactly-one 变成 two。
  for (const kindId of OUTDOOR_KINDS) {
    const row = db.prepare(
      `select count(*) as owners from map_filter_members m
         join map_filter_categories c on c.id=m.category_id and c.active=1
        where m.place_kind_id=?`,
    ).get(kindId);
    assert.equal(row.owners, 1, `${kindId} 必须恰好归属一个启用标签`);
  }
  db.close();
});

test("activating those filters does not disturb the deactivation guard", () => {
  const db = database();
  db.prepare(
    `insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
     values('place_gate','service_place','campus_baoshan','active',datetime('now'),datetime('now'))`,
  ).run();
  // protect_used_map_filter_deactivation 只拦 active 1→0。标签启用后它开始生效，
  // 这正是想要的：有地点在用就不许再停用回去。
  assert.throws(
    () => db.exec("update map_filter_categories set active=0 where id='map_filter_service_place'"),
    /map filter with live members cannot be deactivated/,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// 二、没传过照片的设施 / 商户打不开编辑页
// ---------------------------------------------------------------------------

test("media is optional for facilities and merchants, so the reader must accept its absence", () => {
  const contracts = read("worker/lib/revision-contracts.ts");
  // 存储契约里 facility / merchant 的 media 只在字段存在时校验，编辑器保存时也会在
  // 没有照片时 delete content.media。所以 content={} 是正常数据，不是坏数据。
  assert.match(contracts, /function validateOptionalMedia[\s\S]*?if \(Object\.hasOwn\(content, "media"\)\)/);
  const panel = read("src/admin/components/MediaPanel.tsx");
  assert.match(panel, /if \(value === undefined \|\| value === null\) return \[\];/);
});

test("place media stays required because its contract demands it", () => {
  const contracts = read("worker/lib/revision-contracts.ts");
  // 对照：地点的 detail.media 是必填，缺了就该报错。上面那处放宽不能顺带把这里也放宽。
  assert.match(contracts, /for \(const required of \["facts", "media"\] as const\)/);
});

// ---------------------------------------------------------------------------
// 三、分类页看不到每个地点类型下有哪些地点
// ---------------------------------------------------------------------------

test("the taxonomy API returns the places behind every place kind", () => {
  const source = read("worker/modules/map-filters.ts");
  // 之前每个成员只有一个 usageCount：「建筑 121 个地点」一个都点不开，也无从确认
  // 某个地点归到了哪个筛选按钮。明细现在直接挂在地点类型上（按钮不再是独立一层）。
  assert.match(source, /interface PlaceKindEntryRow/);
  assert.match(source, /entries: entriesByKind\.get\(kind\.id\) \?\? \[\]/);
  // 名称要能显示草稿地点，与设施类型的 instances 一致（coalesce 到最新修订）。
  assert.match(source, /order by r2\.revision_no desc limit 1/);
});

test("the place entry query runs against the real schema", () => {
  const db = database();
  db.exec(`
    insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
      values('place_named','service_place','campus_baoshan','active',datetime('now'),datetime('now'));
    insert into place_revisions(id,place_id,revision_no,editorial_status,display_name,content_hash,created_at)
      values('prev_draft','place_named',1,'draft','测试服务点','hash1',datetime('now'));
  `);
  // 只有草稿修订、current_revision_id 还是空的地点也必须显示出名字 —— 否则刚建好的
  // 地点在标签页里是一行 id，看不出是什么。
  const row = db.prepare(
    `select coalesce(pr.display_name,
              (select r2.display_name from place_revisions r2 where r2.place_id=p.id order by r2.revision_no desc limit 1),
              p.id
            ) as displayName,
            case when b.place_id is null then 0 else 1 end as isBuilding
       from places p
       left join buildings b on b.place_id=p.id
       left join place_revisions pr on pr.id=p.current_revision_id
      where p.id='place_named'`,
  ).get();
  assert.equal(row.displayName, "测试服务点");
  assert.equal(row.isBuilding, 0);
  db.close();
});

test("the taxonomy page renders that place list", () => {
  const page = read("src/admin/pages/TaxonomyPage.tsx");
  assert.match(page, /function PlaceEntryList/);
  assert.match(page, /<PlaceEntryList canEdit=\{canEdit\} entries=\{kind\.entries\}/);
  // 明细里要能看出是楼宇还是楼外地点 —— 这决定它出不出独立图钉。
  assert.match(page, /entry\.isBuilding \? "楼宇" : "楼外地点"/);
});

// ---------------------------------------------------------------------------
// 四、设施加了但地图上不显示：campusDefault 关着，而后台改不了
// ---------------------------------------------------------------------------

test("campusDefault is what decides whether an outdoor facility is drawn at all", () => {
  const state = read("src/pages/map/useMapPageState.ts");
  // 没有搜索词也没选筛选时，只看 visibility.default，而它来自 campusDefault。
  assert.match(state, /return poi\.visibility\.default;/);
  const mapData = read("src/lib/release/mapData.ts");
  assert.match(mapData, /default: policyBoolean\(facility\.visibilityPolicy, "campusDefault", false, facility\.id\)/);
});

test("the visibility switches are editable rather than hard-wired", () => {
  const worker = read("worker/modules/facility-types.ts");
  // 新建时默认关着是对的（几百个卫生间会糊满地图），但必须能改，否则新建的楼外
  // 点位永远不出现，管理员没有任何办法自己解决。
  assert.match(worker, /const EDITABLE_VISIBILITY_KEYS = \[\s*"campusDefault"/);
  assert.match(worker, /sets\.push\("visibility_policy_json=\?"\)/);
  const client = read("src/lib/api/admin.ts");
  assert.match(client, /visibilityPolicy\?: FacilityVisibilityPolicy;/);
  const page = read("src/admin/pages/TaxonomyPage.tsx");
  assert.match(page, /admin\.updateFacilityType\(type\.id, \{ visibilityPolicy: \{ \[item\.key\]: !on \} \}\)/);
});

test("a visibility edit patches rather than replaces the stored policy", () => {
  const worker = read("worker/modules/facility-types.ts");
  // buildingSummary / floorDefault 在界面上没有开关。整体覆盖会把种子里的这些取值
  // 抹成默认值，而那要等发布之后才会被发现。
  assert.match(worker, /const nextPolicy = patch === null \? null : \{ \.\.\.currentPolicy, \.\.\.patch \}/);
  assert.doesNotMatch(worker, /visibility_policy_json=\?[\s\S]{0,80}DEFAULT_VISIBILITY_POLICY/);
});

test("a patched policy still satisfies the stored json check", () => {
  const db = database();
  const before = db.prepare(
    "select visibility_policy_json as policy from facility_types where id='facility_type_drinking_water'",
  ).get();
  const patched = { ...JSON.parse(before.policy), campusDefault: true };
  db.prepare("update facility_types set visibility_policy_json=?,updated_at=datetime('now') where id=?")
    .run(JSON.stringify(patched), "facility_type_drinking_water");
  const after = db.prepare(
    "select visibility_policy_json as policy from facility_types where id='facility_type_drinking_water'",
  ).get();
  const parsed = JSON.parse(after.policy);
  assert.equal(parsed.campusDefault, true);
  // 没动过的键必须还在。
  assert.equal(parsed.buildingSummary, true);
  assert.equal(parsed.floorDefault, true);
  db.close();
});

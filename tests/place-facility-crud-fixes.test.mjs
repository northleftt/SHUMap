import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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

async function bundleModule(entryPoint) {
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    jsx: "automatic",
    loader: { ".tsx": "tsx" },
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
  return import(moduleUrl);
}

// ---------------------------------------------------------------------------
// Bug 1：删除楼宇地点漏数 location_anchors 的外键引用 → 500
//
// location_anchors.building_place_id 是 on delete restrict。设施 / 商户 / 运营事件
// 可以把位置点进一栋自己并不寄居的楼，这层引用不在 placeUsage 原先生数的六张
// 「宿主」表里：计数全零 → handler 放行 → 数据库撞外键 → 管理端收到裸 500。
// 修复：placeUsage 增数 locationRefs（排除地点自己的锚点——它们随删除一起走）。
// ---------------------------------------------------------------------------

const LOCATION_REFS_COUNT_SQL = `
  select count(*) as count from location_anchors la
   where la.building_place_id=?
     and not exists (
       select 1 from entity_locations el
        where el.anchor_id=la.id and el.entity_type='place' and el.entity_id=?
     )`;

function seedBuilding(db) {
  db.exec(`
    insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
      values('place_b','other','campus_baoshan','active','2026-08-01','2026-08-01');
    insert into buildings(place_id) values('place_b');`);
}

test("placeUsage counts anchors other entities bound to the building", () => {
  const places = read("worker/modules/places.ts");
  // 修复后的 handler 必须把 location_anchors 纳入引用计数……
  assert.match(places, /from location_anchors la\s+where la\.building_place_id=\?/);
  // ……且排除地点自己的锚点，否则任何带位置的楼宇都永远删不掉。
  assert.match(places, /el\.entity_type='place' and el\.entity_id=\?/);

  const db = database();
  seedBuilding(db);
  // 别的实体（运营事件）把位置点进了这栋楼；地点自己没有任何锚点。
  db.exec(`
    insert into location_anchors(id,building_place_id,role,geometry_type,precision_level,verification_status,created_at,updated_at)
      values('anchor_other','place_b','event_location','Point','building','reviewed','2026-08-01','2026-08-01');`);
  const refs = db.prepare(LOCATION_REFS_COUNT_SQL).get("place_b", "place_b");
  assert.equal(refs.count, 1, "外来锚点必须被计为引用，deletePlace 才回 409 而不是撞外键 500");
  assert.throws(
    () => db.exec("delete from places where id='place_b'"),
    /FOREIGN KEY/i,
    "不计数的话数据库层就是会拒（这就是原来的 500）",
  );
});

test("the place's own anchors do not count as blocking references", () => {
  const db = database();
  seedBuilding(db);
  db.exec(`
    insert into location_anchors(id,building_place_id,role,geometry_type,precision_level,verification_status,created_at,updated_at)
      values('anchor_own','place_b','primary_display','Point','building','reviewed','2026-08-01','2026-08-01');
    insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
      values('eloc_own','place','place_b','anchor_own','primary_display',1,'2026-08-01');`);
  const refs = db.prepare(LOCATION_REFS_COUNT_SQL).get("place_b", "place_b");
  assert.equal(refs.count, 0, "自己的锚点随删除一起走，不该拦住删除");
});

// ---------------------------------------------------------------------------
// Bug 2/3：设施编辑器保存时把空位置行 / 双主要位置送进契约 → 400
//
// 设施编辑器有两个面板共写 locationDrafts（楼层图「服务位置」+「楼外位置」）。
// 两个真实翻车路径：点了「添加位置」没填就保存（空行被后端「必须指明空间归属」
// 拒掉）；服务位置已是主要位置时再在楼外面板加行（新行默认点亮 isPrimary，
// 「恰好一个主要位置」拒掉）。修复：保存与面板合并都过 finalizeLocationDrafts。
// ---------------------------------------------------------------------------

const { finalizeLocationDrafts, emptyLocation } = await bundleModule("src/admin/components/LocationEditor.tsx");

test("finalizeLocationDrafts drops rows where nothing was ever filled", () => {
  const filled = { ...emptyLocation("primary_display"), id: "a", campusId: "campus_baoshan", longitude: "121.4", latitude: "31.32" };
  const blank = { ...emptyLocation("centroid"), id: "b", isPrimary: false };
  const result = finalizeLocationDrafts([filled, blank]);
  assert.deepEqual(result.map((row) => row.id), ["a"], "空行不该进修订草稿（后端会对它 400）");
});

test("finalizeLocationDrafts keeps exactly one primary when two panels both claim it", () => {
  // 服务位置（先存在、是主要位置）+ 楼外面板新增行（emptyLocation 默认点亮 isPrimary）。
  const service = { ...emptyLocation("service_position"), id: "svc", isPrimary: true, floorId: "floor_1", buildingPlaceId: "place_b" };
  const outdoor = { ...emptyLocation("primary_display"), id: "out", isPrimary: true, campusId: "campus_baoshan" };
  const result = finalizeLocationDrafts([service, outdoor]);
  assert.equal(result.filter((row) => row.isPrimary).length, 1, "契约要求恰好一个主要位置");
  assert.equal(result.find((row) => row.isPrimary)?.id, "out", "撞车时后动手的面板（数组靠后）赢");
});

test("finalizeLocationDrafts promotes the first row when filtering removed the only primary", () => {
  // 空行占位了主要位置，被滤掉后一个主要位置都没有，同样过不了契约。
  const blankPrimary = emptyLocation("centroid");
  const filled = { ...emptyLocation("primary_display"), id: "a", isPrimary: false, campusId: "campus_baoshan" };
  const result = finalizeLocationDrafts([blankPrimary, filled]);
  assert.equal(result.filter((row) => row.isPrimary).length, 1);
  assert.equal(result[0].isPrimary, true);
});

test("FacilityEditorPage routes both saves and the outdoor panel merge through finalizeLocationDrafts", () => {
  const source = read("src/admin/pages/FacilityEditorPage.tsx");
  assert.equal(source.match(/finalizeLocationDrafts\(locationDrafts\)\.map\(locationInput\)/g)?.length, 2, "新建与修订两条保存路径都要过 finalize");
  assert.match(source, /finalizeLocationDrafts\(\[\s*\.\.\.current\.filter/, "楼外面板合并时也要收敛");
});

// ---------------------------------------------------------------------------
// Bug 4：换楼 / 换楼层后服务位置草稿过期
//
// service_position 草稿行里钉死了 floorId 与那张楼层平面图的 mapVersionId。
// 用户在「挂接位置」里改楼或改层时只清了 floorId/indoorSpaceId 三个标量，草稿
// 原样保留——保存后设施被标到一张已经不属于它的楼层图上，且层级校验照样放行
// （同楼换层时 floorId 与 buildingPlaceId 仍然相配）。修复：换楼 / 换层时清掉
// 服务位置草稿。
// ---------------------------------------------------------------------------

test("FacilityEditorPage drops the service_position draft when building or floor changes", () => {
  const source = read("src/admin/pages/FacilityEditorPage.tsx");
  const clears = source.match(/setLocationDrafts\(\(rows\) => rows\.filter\(\(location\) => location\.role !== "service_position"\)\)/g);
  assert.equal(clears?.length, 2, "「所属楼宇」与「楼层」两个 onChange 都要清服务位置草稿");
});

// ---------------------------------------------------------------------------
// Bug 5：设施列表「更新时间」显示的是核验时间
//
// listFacilities 原先只回 lastVerifiedAt（核验时间，多数设施为空），ContentPage
// 拿它填「更新时间」列，于是一直显示「—」。修复：后端补出 updated_at，前端改用它。
// ---------------------------------------------------------------------------

test("facility list exposes updatedAt and the content table uses it", () => {
  assert.match(read("worker/modules/facilities.ts"), /f\.updated_at as updatedAt/);
  const content = read("src/admin/pages/ContentPage.tsx");
  assert.match(content, /updatedAt: String\(f\.updatedAt \?\? ""\)/);
  assert.doesNotMatch(content, /updatedAt: String\(f\.lastVerifiedAt/);
});

// ---------------------------------------------------------------------------
// Bug 7：楼层编号「3F」「1B」被前端误拒
//
// 后端 floors.ts 的 canonicalLevelCode 前后缀都收（F3/3F/F03 → F3），而
// PlaceEditorPage 的 suggestFloorOrder 只认 F<n>/B<n>——用户按中文习惯填「3F」，
// 前端直接抛「不支持的楼层编号」，一个后端本来接受的输入死在提交前。
// ---------------------------------------------------------------------------

const { canonicalFloorLevelCode } = await bundleModule("src/admin/pages/PlaceEditorPage.tsx");

test("canonicalFloorLevelCode accepts the same forms the backend accepts", () => {
  for (const [raw, expected] of [["3", "F3"], ["f3", "F3"], ["F03", "F3"], ["3F", "F3"], ["b1", "B1"], ["B01", "B1"], ["1B", "B1"]]) {
    assert.equal(canonicalFloorLevelCode(raw), expected, `${raw} 应规范化为 ${expected}`);
  }
  assert.equal(canonicalFloorLevelCode("一层"), null);
  assert.equal(canonicalFloorLevelCode(""), null);
});

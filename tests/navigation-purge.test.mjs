// 存量导航终点清除脚本（scripts/generate_navigation_purge.mjs）纯逻辑自验。
//
// 这个脚本会改 place_revisions.structure_json 并重算 content_hash，出错的后果是
// 「地点在后台打不开」或「发版清单里凭空多/少一条」，所以几件事必须钉住：
// 1. 哈希公式与 worker/modules/places.ts 逐字一致（含 null → 空串的拼接口径）；
// 2. 只摘 navigation_target，其余位置逐字节不动；
// 3. 任何不确定的行一律跳过并阻断出 SQL，绝不出半成品；
// 4. 守卫输入（facility/merchant 修订表里是否也存了导航点）缺失时拒绝出 SQL。
//
// 实测背景：远端有 124 个导航点（place 122 + facility 1 + transit_stop 1），
// 其中 3 个没有 structure_json 副本（回填生成 / 非 place 实体），只能删关系表。
// 这两种形态都要被覆盖。

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ANCHOR_QUERY,
  GUARD_QUERY,
  normalizeRows,
  placeContentHash,
  planNavigationPurge,
  renderPurgeSql,
  REVISION_QUERY,
  rewriteStructureJson,
  ROLE,
} from "../scripts/generate_navigation_purge.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

/** 守卫全通过（远端实测两者都是 0）。 */
const CLEAN_GUARDS = [{ facilityRevisionNav: 0, merchantRevisionNav: 0 }];

const navLocation = (placeId) => ({
  campusId: "campus_baoshan",
  buildingPlaceId: placeId,
  role: ROLE,
  geometryType: "Point",
  geometry: { type: "Point", coordinates: [121.39552, 31.313513] },
  crs: "GCJ02",
  locationHint: "上海市宝山区上大路99号 上海大学宝山校区 A楼",
  precisionLevel: "exact",
  sourceId: "source_campus_maps",
  isPrimary: true,
});

const footprintLocation = (placeId) => ({
  campusId: "campus_baoshan",
  buildingPlaceId: placeId,
  role: "footprint",
  geometryType: "Polygon",
  mapVersionId: "mapver_4ba7a816ef2f46f2be71a0845330eee6",
  mapFeatureId: "mapfeat_baoshan_building_A",
  precisionLevel: "exact",
  sourceId: "source_campus_maps",
  isPrimary: false,
});

/** 合成一条与库里同形的 revision 行，content_hash 按真实公式算好，默认自洽。 */
function revision(overrides = {}) {
  const placeId = overrides.placeId ?? "place_baoshan_building-a";
  const structure = overrides.structure ?? {
    kindId: "building",
    campusId: "campus_baoshan",
    parentPlaceId: null,
    stableCode: "building-a",
    aliases: [],
    building: { buildingCode: "building-a", managingOrganizationId: null, publicAccessLevel: "unknown" },
    locations: [navLocation(placeId), footprintLocation(placeId)],
  };
  const base = {
    revisionId: overrides.revisionId ?? "prev_aaaa",
    placeId,
    displayName: "A 楼",
    summary: null,
    description: null,
    contentJson: JSON.stringify({ detail: { facts: [], media: [] }, address: "上海市宝山区上大路99号" }),
    structureJson: JSON.stringify(structure),
  };
  const merged = { ...base, ...overrides };
  delete merged.structure;
  return { ...merged, contentHash: overrides.contentHash ?? placeContentHash(merged) };
}

/** 合成一条锚点/绑定行。 */
function anchor(overrides = {}) {
  return {
    bindingId: overrides.bindingId ?? "eloc_aaaa",
    anchorId: overrides.anchorId ?? "anchor_aaaa",
    entityType: overrides.entityType ?? "place",
    entityId: overrides.entityId ?? "place_baoshan_building-a",
    sourceId: overrides.sourceId ?? "source_campus_maps",
  };
}

test("哈希公式与 worker/modules/places.ts 逐字一致", () => {
  // 脚本里的实现必须复刻这一行；公式漂了就会把全部 update 的前置条件算错。
  const source = read("worker/modules/places.ts");
  assert.match(
    source,
    /sha256\(\s*`\$\{[^}]*displayName\}\\n\$\{[^}]*summary \?\? ""\}\\n\$\{[^}]*description \?\? ""\}\\n\$\{contentJson\}\\n\$\{structureJson\}`/,
    "places.ts 的哈希公式变了，脚本里的 placeContentHash 必须同步",
  );

  const expected = crypto
    .createHash("sha256")
    .update('A 楼\n\n\n{"a":1}\n{"b":2}', "utf8")
    .digest("hex");
  assert.equal(
    placeContentHash({
      displayName: "A 楼",
      summary: null,
      description: null,
      contentJson: '{"a":1}',
      structureJson: '{"b":2}',
    }),
    expected,
    "null 的 summary/description 必须拼成空串",
  );

  // 与 0016 迁移里那条真实数据交叉验证：同一份内容必须算出迁移里写死的哈希。
  const migration = read("migrations-v2/0016_field_test_residue.sql");
  const contentJson = /set content_json='(\{"detail":\{"facts":\[\{"label":"开放时间".*?)',\n/s.exec(migration);
  const structureJson = /structure_json='(\{"kindId":"building".*?)',\n/s.exec(migration);
  const contentHash = /content_hash='([0-9a-f]{64})'\n where id='prev_1b55c3caa5dc4bd98010e05fa4024545'/.exec(migration);
  assert.ok(contentJson && structureJson && contentHash, "0016 里那条 A 楼 update 的三个字段都要能取到");
  assert.equal(
    placeContentHash({
      displayName: "A 楼",
      summary: null,
      description: null,
      // SQL 里的 '' 是单引号转义，还原成字面量。
      contentJson: contentJson[1].replaceAll("''", "'"),
      structureJson: structureJson[1].replaceAll("''", "'"),
    }),
    contentHash[1],
    "对 0016 里的真实行，脚本算出的哈希必须等于迁移写死的那个",
  );
});

test("只摘 navigation_target，其余位置与字段逐字节不动", () => {
  const structureJson = revision().structureJson;
  const result = rewriteStructureJson(structureJson);
  assert.equal(result.ok, true);
  assert.equal(result.removed, 1);

  const before = JSON.parse(structureJson);
  const after = JSON.parse(result.next);
  assert.deepEqual(
    after.locations,
    before.locations.filter((item) => item.role !== ROLE),
    "剩下的位置必须与原来完全一致",
  );
  const strip = (value) => {
    const copy = { ...value };
    delete copy.locations;
    return JSON.stringify(copy);
  };
  assert.equal(strip(after), strip(before), "locations 以外的字段必须逐字节不变");
});

test("无法忠实往返 / 结构异常的 structure_json 一律拒绝", () => {
  // 键序与 JSON.stringify 不一致：重写会连带改动无关字节，必须拒绝。
  assert.equal(rewriteStructureJson('{"locations":[],"kindId":"building"} ').ok, false);
  assert.match(rewriteStructureJson('{ "kindId":"b","locations":[] }').reason, /逐字节往返/);
  // 浮点记法差异同样拦下（1.0 会被 stringify 成 1）。
  assert.match(rewriteStructureJson('{"locations":[],"n":1.0}').reason, /逐字节往返/);
  assert.match(rewriteStructureJson("not json").reason, /不是合法 JSON/);
  assert.match(rewriteStructureJson("[]").reason, /不是对象/);
  assert.match(rewriteStructureJson('{"locations":null}').reason, /不是数组/);
});

test("like 预筛误命中归 noop，不算错误也不阻断出 SQL", () => {
  // REVISION_QUERY 用 like '%navigation_target%' 预筛，会命中把这个词写进
  // locationHint 之类文本的修订。那种修订不需要改，但也不能当成错误停手。
  const hit = rewriteStructureJson(
    JSON.stringify({ locations: [{ role: "footprint", locationHint: "navigation_target 备注" }] }),
  );
  assert.equal(hit.ok, false);
  assert.equal(hit.noop, true);
  assert.match(hit.reason, /没有导航终点/);

  const plan = planNavigationPurge({
    anchors: [anchor()],
    revisions: [
      revision({ revisionId: "prev_real" }),
      revision({
        revisionId: "prev_noop",
        placeId: "place_baoshan_building-z",
        structure: { kindId: "building", locations: [{ role: "footprint", locationHint: "navigation_target" }] },
      }),
    ],
    guards: CLEAN_GUARDS,
  });
  assert.equal(plan.report.noops, 1);
  assert.equal(plan.report.skipped, 0);
  assert.equal(plan.updates.length, 1);
  assert.doesNotThrow(() => renderPurgeSql(plan));
});

test("正常输入：按 revision 聚合 update、按 anchor 去重 delete", () => {
  // 同一个 place 的两条 revision 各存一份导航点，锚点/绑定只有一份。
  const plan = planNavigationPurge({
    anchors: [
      anchor(),
      anchor(), // 重复输入必须无害
      anchor({ anchorId: "anchor_bbbb", bindingId: "eloc_bbbb", entityId: "place_baoshan_building-b" }),
    ],
    revisions: [
      revision({ revisionId: "prev_a1" }),
      revision({ revisionId: "prev_a2" }),
      revision({ revisionId: "prev_b1", placeId: "place_baoshan_building-b" }),
    ],
    guards: CLEAN_GUARDS,
  });
  assert.equal(plan.report.revisionsSeen, 3);
  assert.equal(plan.updates.length, 3);
  assert.equal(plan.report.places, 2);
  assert.equal(plan.deletes.length, 2, "锚点必须按 id 去重");
  assert.equal(plan.report.skipped, 0);
  assert.equal(plan.report.relationalOnly, 0, "两个锚点都有 structure_json 副本");

  for (const update of plan.updates) {
    assert.doesNotMatch(update.structureJson, /navigation_target/);
    assert.notEqual(update.contentHash, update.oldHash, "改了 structure_json 就必须换哈希");
  }

  const sql = renderPurgeSql(plan, { generatedAt: "2026-08-14T00:00:00.000Z" });
  // 每条 delete 带 role 限定，每条 update 带旧哈希前置条件 —— 可安全重跑的前提。
  assert.equal((sql.match(/delete from location_anchors where id='[^']+' and role='navigation_target';/g) ?? []).length, 2);
  assert.equal((sql.match(/delete from entity_locations where id='[^']+' and role='navigation_target';/g) ?? []).length, 2);
  assert.equal((sql.match(/ and content_hash='[0-9a-f]{64}';/g) ?? []).length, 3);
  // 先删绑定再删锚点。
  assert.ok(sql.indexOf("delete from entity_locations") < sql.indexOf("delete from location_anchors"));
  assert.match(sql, /^-- 存量导航终点清除/);
  assert.match(sql, /pragma foreign_keys = on;/);
});

test("没有 structure_json 副本的锚点只删关系表，并在报告里点名", () => {
  // 远端实测的三个：facility×1、transit_stop×1、回填生成的 place×1。
  // 它们没有 structure_json 副本（facility_revisions 里是 0，transit_stops 没有修订表），
  // 必须照删关系表，且要被明确列出来而不是静默处理。
  const plan = planNavigationPurge({
    anchors: [
      anchor(),
      anchor({ anchorId: "anchor_fac", bindingId: "eloc_fac", entityType: "facility", entityId: "facility_x", sourceId: "source_navigation_backfill_affine_v1" }),
      anchor({ anchorId: "anchor_stop", bindingId: "eloc_stop", entityType: "transit_stop", entityId: "stop_宝山校区", sourceId: "source_navigation_backfill_affine_v1" }),
      anchor({ anchorId: "anchor_bf", bindingId: "eloc_bf", entityType: "place", entityId: "place_no_struct", sourceId: "source_navigation_backfill_affine_v1" }),
    ],
    revisions: [revision()],
    guards: CLEAN_GUARDS,
  });
  assert.equal(plan.deletes.length, 4);
  assert.equal(plan.report.relationalOnly, 3);
  assert.deepEqual(
    plan.relationalOnly.map((item) => item.entityId).sort(),
    ["facility_x", "place_no_struct", "stop_宝山校区"].sort(),
  );
  assert.deepEqual(plan.report.anchorsByType, { place: 2, facility: 1, transit_stop: 1 });

  const sql = renderPurgeSql(plan);
  // 四个锚点全删，但只改一条 revision。
  assert.equal((sql.match(/delete from location_anchors/g) ?? []).length, 4);
  assert.equal((sql.match(/update place_revisions/g) ?? []).length, 1);
});

test("现有 content_hash 与内容不自洽时跳过，并阻断出 SQL", () => {
  // 哈希不自洽说明公式或数据已经漂了，此时算出的新哈希同样不可信，必须停手。
  const plan = planNavigationPurge({
    anchors: [anchor()],
    revisions: [revision({ contentHash: "0".repeat(64) })],
    guards: CLEAN_GUARDS,
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /不自洽/);
  assert.throws(() => renderPurgeSql(plan), /无法安全重写/);
});

test("缺少守卫输入时拒绝出 SQL", () => {
  // 只删关系表而 facility/merchant 的 structure_json 还留着导航点，
  // 编辑器一保存就复活 —— 所以必须先确认那两张表是干净的。
  const plan = planNavigationPurge({ anchors: [anchor()], revisions: [revision()] });
  assert.equal(plan.guardsProvided, false);
  assert.throws(() => renderPurgeSql(plan), /缺少守卫输入/);
});

test("守卫发现 facility / merchant 修订表里也有导航点时阻断", () => {
  const facility = planNavigationPurge({
    anchors: [anchor()],
    revisions: [revision()],
    guards: [{ facilityRevisionNav: 2, merchantRevisionNav: 0 }],
  });
  assert.deepEqual(facility.guardFailures.length, 1);
  assert.throws(() => renderPurgeSql(facility), /守卫未通过/);

  const merchant = planNavigationPurge({
    anchors: [anchor()],
    revisions: [revision()],
    guards: [{ facilityRevisionNav: 0, merchantRevisionNav: 3 }],
  });
  assert.throws(() => renderPurgeSql(merchant), /merchant_revisions/);
});

test("normalizeRows 兼容 wrangler --json 的三种包装", () => {
  const rows = [revision()];
  assert.equal(normalizeRows([{ results: rows, success: true }, { results: [revision({ revisionId: "prev_b" })] }]).length, 2);
  assert.deepEqual(normalizeRows({ results: rows }), rows);
  assert.deepEqual(normalizeRows(rows), rows);
  assert.deepEqual(normalizeRows([]), []);
  assert.throws(() => normalizeRows({ nope: 1 }), /Unrecognized input/);
});

test("三条配套查询取齐所需字段", () => {
  // 少取一个哈希输入字段就会让哈希算错，而错误只在执行时表现为「0 行匹配」——沉默失败。
  for (const column of ["display_name", "summary", "description", "content_json", "structure_json", "content_hash"]) {
    assert.match(REVISION_QUERY, new RegExp(`r\\.${column}`), `修订查询必须取 ${column}`);
  }
  // 锚点查询不能限定 entity_type：非 place 实体的导航点也要删。
  assert.match(ANCHOR_QUERY, /el\.role='navigation_target'/);
  assert.doesNotMatch(ANCHOR_QUERY, /entity_type\s*=\s*'place'/);
  // 守卫查询必须同时查两张修订表。
  assert.match(GUARD_QUERY, /facility_revisions/);
  assert.match(GUARD_QUERY, /merchant_revisions/);
});

test("空输入不出 SQL", () => {
  assert.throws(
    () => renderPurgeSql(planNavigationPurge({ guards: CLEAN_GUARDS })),
    /没有可清除的导航终点/,
  );
});

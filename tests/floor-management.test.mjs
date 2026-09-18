// 楼层管理。
//
// 关注三件事：
//   1. 0032 起一层楼就是 floors 表里的一行 + 可选的一张位图（PNG/JPEG/WebP 直传），
//      不再有 SVG 导入、图纸版本、图上锚点那一套。levelCode 是去空白的自由文本，
//      展示顺序完全由客户端给出的 levelOrder 决定，服务端不再按编号推导。
//   2. 楼层页看到的设施 / 商户是按 floor_id **反查**出来的，不是复制的副本。
//      这就是「双向同步」的实现方式：改设施侧，楼层页刷新即变。
//   3. 删除楼层必须先解除引用（设施、商户、历史图纸版本、锚点），否则会留下悬空设施。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const bundle = await build({
  stdin: {
    contents: `
      export {
        listFloorsForBuilding,
        getFloorDetail,
        createFloor,
        updateFloor,
        deleteFloor,
        uploadFloorImage,
      } from "./worker/modules/floors.ts";
    `,
    resolveDir: root,
    sourcefile: "floor-management-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const handlers = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

class Statement {
  constructor(sqlite, sql, values = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.sqlite, this.sql, values);
  }

  async first() {
    return this.sqlite.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.sqlite.prepare(this.sql).all(...this.values) };
  }

  async run() {
    this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true };
  }
}

class D1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(sql) {
    return new Statement(this.sqlite, sql);
  }

  async batch(statements) {
    this.sqlite.exec("begin");
    try {
      for (const statement of statements) this.sqlite.prepare(statement.sql).run(...statement.values);
      this.sqlite.exec("commit");
    } catch (error) {
      this.sqlite.exec("rollback");
      throw error;
    }
    return statements.map(() => ({ success: true }));
  }
}

class R2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, bytes, options) {
    this.objects.set(key, { bytes: Uint8Array.from(new Uint8Array(bytes)), options });
  }
}

const now = "2026-08-03T00:00:00.000Z";
const principal = { userId: "user_editor", permissions: ["write:maps"] };

/** 一栋楼 + 一个可用账号，作为所有用例的起点。 */
function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(read(`migrations-v2/${name}`));
  }
  sqlite.prepare(
    `insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at)
     values('user_editor','editor@example.test','编辑','hash','active',1,?,?)`,
  ).run(now, now);
  sqlite.prepare(
    `insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
     values('place_tower','building','campus_baoshan','active',?,?)`,
  ).run(now, now);
  sqlite.prepare(
    "insert into buildings(place_id,building_code,public_access_level) values('place_tower','TOWER','public')",
  ).run();
  return sqlite;
}

function jsonRequest(body, method = "POST") {
  return new Request("https://example.test/api/admin/floors", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function imageRequest(bytes, contentType) {
  return new Request("https://example.test/api/admin/floors/floor_x/image", {
    method: "PUT",
    headers: { "content-type": contentType },
    body: bytes,
  });
}

async function addFloor(env, levelCode, { levelOrder = 0, displayName = "", isPublic = true } = {}) {
  const response = await handlers.createFloor(
    jsonRequest({ buildingPlaceId: "place_tower", levelCode, levelOrder, displayName, isPublic }),
    env,
    principal,
    "request_floor",
  );
  assert.equal(response.status, 201);
  return response.json();
}

/** 一条历史楼层绑定图纸版本（map_versions.floor_id 仍在 schema 里，删除守卫与用量要算它）。 */
function addPlan(sqlite, floorId, { id, label = "2026-08", status = "ready" }) {
  sqlite.prepare(
    `insert into media_assets(id,bucket_scope,object_key,content_type,byte_size,sha256,status,created_at)
     values(?,'private',?,'image/svg+xml',10,?,'approved',?)`,
  ).run(`media_${id}`, `private/imports/${id}.svg`, `hash_${id}`, now);
  sqlite.prepare(
    "insert into map_assets(id,asset_type,media_asset_id,checksum,created_at) values(?,'floor_svg',?,?,?)",
  ).run(`asset_${id}`, `media_${id}`, `hash_${id}`, now);
  sqlite.prepare(
    `insert into map_versions(id,campus_id,floor_id,map_asset_id,version_label,coordinate_space_type,
       coordinate_space_json,lifecycle_status,created_at)
     values(?,null,?,?,?,'svg_viewbox','{"width":100,"height":100}',?,?)`,
  ).run(id, floorId, `asset_${id}`, label, status, now);
}

// 真实 PNG 文件头（魔术字节），sniff 只认这个。
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

// --- 写入口 ----------------------------------------------------------------

test("creating a floor stores the trimmed free-form code and the client-supplied order", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };

  // levelCode 是自由文本（不再规范成 F<n>/B<n>），只去空白与非空校验；
  // levelOrder 由客户端给出并原样存储，服务端不推导。
  const created = await addFloor(env, " 三层 ", { levelOrder: 7 });
  assert.equal(created.levelCode, "三层");
  assert.equal(created.levelOrder, 7);
  assert.equal(created.displayName, "三层", "显示名留空时按编号顶上");

  const stored = sqlite.prepare("select level_code,level_order,display_name,is_public from floors where id=?").get(created.id);
  assert.equal(stored.level_code, "三层");
  assert.equal(stored.level_order, 7);
  assert.equal(stored.is_public, 1);

  // 排序值必填且必须是有限数字：缺省、字符串、NaN/Infinity（JSON 里落成 null）都拒绝。
  await assert.rejects(
    () => handlers.createFloor(
      jsonRequest({ buildingPlaceId: "place_tower", levelCode: "F9", displayName: "", isPublic: true }),
      env, principal, "request_missing_order",
    ),
    (error) => error.status === 400 && error.code === "validation_error" && /floor\.levelOrder is required/.test(error.message),
  );
  for (const bad of ["3", Number.NaN, Infinity]) {
    await assert.rejects(
      () => addFloor(env, "F9", { levelOrder: bad }),
      (error) => error.status === 400 && error.code === "validation_error" && /levelOrder must be a finite number/.test(error.message),
    );
  }
  // 编号去空白后为空也拒绝。
  await assert.rejects(
    () => addFloor(env, "   "),
    (error) => error.status === 400 && error.code === "validation_error" && /levelCode is required/.test(error.message),
  );
  // 未知字段一律拒绝。
  await assert.rejects(
    () => handlers.createFloor(
      jsonRequest({ buildingPlaceId: "place_tower", levelCode: "F1", levelOrder: 1, displayName: "", isPublic: true, plan: "svg" }),
      env, principal, "request_extra",
    ),
    (error) => error.status === 400 && /floor\.plan is not supported/.test(error.message),
  );
});

test("an explicit display name is kept, and the same level cannot be added twice", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };

  const created = await addFloor(env, "F2", { levelOrder: 2, displayName: "二层大厅" });
  assert.equal(created.displayName, "二层大厅");

  // 同楼同编号（去空白后相同）必须回可读的 409 而不是外键错误。
  await assert.rejects(
    () => addFloor(env, " F2 ", { levelOrder: 3 }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "floor_exists");
      return true;
    },
  );
  assert.equal(sqlite.prepare("select count(*) as count from floors").get().count, 1);
  // 创建要留痕。
  assert.equal(
    sqlite.prepare("select count(*) as count from audit_events where action='floor.create'").get().count,
    1,
  );
});

// --- 反查即同步 ------------------------------------------------------------

test("floor detail reverse-looks-up the facilities and merchants bound to it", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  const floor = await addFloor(env, "F1", { levelOrder: 1 });
  const other = await addFloor(env, "F2", { levelOrder: 2 });

  // 设施与商户在各自编辑器里选楼层，这里只写 floor_id——楼层侧不存副本。
  sqlite.prepare(
    `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,created_at,updated_at)
     values('facility_printer','facility_type_printer','place_tower',?,'active','available',?,?)`,
  ).run(floor.id, now, now);
  sqlite.prepare(
    `insert into merchant_outlets(id,host_place_id,floor_id,lifecycle_status,created_at,updated_at)
     values('merchant_cafe','place_tower',?,'active',?,?)`,
  ).run(floor.id, now, now);

  const detail = await (await handlers.getFloorDetail(env, floor.id)).json();
  assert.equal(detail.floor.levelCode, "F1");
  assert.equal(detail.floor.buildingName, null, "楼宇还没有当前修订，名称应为 null 而不是编造一个");
  assert.equal(detail.floor.imageMediaId, null);
  assert.equal(detail.floor.imageUrl, null, "没上传图片时 imageUrl 为 null");
  assert.deepEqual(detail.facilities.map((row) => row.id), ["facility_printer"]);
  assert.deepEqual(detail.merchants.map((row) => row.id), ["merchant_cafe"]);
  // 没有修订时设施名回落到类型名，与内容管理列表同口径。
  assert.equal(detail.facilities[0].displayName, "打印服务");
  assert.equal(detail.facilities[0].positionedCount, 0, "还没落点");
  assert.equal(detail.usage.facilities, 1);
  assert.equal(detail.usage.merchants, 1);
  // 0032 起详情只有 floor/facilities/merchants/anchors/usage，不再有 plans 与 spaces。
  assert.ok(!("plans" in detail), "楼层详情不再带 plans");
  assert.ok(!("spaces" in detail), "楼层详情不再带 spaces");

  // 另一层不应该看到这些内容。
  const otherDetail = await (await handlers.getFloorDetail(env, other.id)).json();
  assert.deepEqual(otherDetail.facilities, []);
  assert.deepEqual(otherDetail.merchants, []);

  // 关键：在设施侧改楼层归属，楼层页无需任何同步动作就跟着变。
  sqlite.prepare("update facility_instances set floor_id=? where id='facility_printer'").run(other.id);
  const afterMove = await (await handlers.getFloorDetail(env, floor.id)).json();
  assert.deepEqual(afterMove.facilities, [], "设施移走后原楼层立刻不再列出它");
  const movedTo = await (await handlers.getFloorDetail(env, other.id)).json();
  assert.deepEqual(movedTo.facilities.map((row) => row.id), ["facility_printer"]);
});

test("a facility anchored on the floor is reported as positioned", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  const floor = await addFloor(env, "F1", { levelOrder: 1 });
  sqlite.prepare(
    `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,created_at,updated_at)
     values('facility_printer','facility_type_printer','place_tower',?,'active','available',?,?)`,
  ).run(floor.id, now, now);
  // 锚点直接挂在楼层上（floor_id），不再需要图纸版本。
  sqlite.prepare(
    `insert into location_anchors(id,floor_id,role,geometry_type,geometry_json,crs,map_version_id,
       precision_level,verification_status,created_at,updated_at)
     values('anchor_printer',?,'service_position','Point','{"type":"Point","coordinates":[10,20]}',null,null,
       'exact','reviewed',?,?)`,
  ).run(floor.id, now, now);
  sqlite.prepare(
    `insert into entity_locations(id,entity_type,entity_id,anchor_id,role,is_primary,created_at)
     values('eloc_printer','facility','facility_printer','anchor_printer','service_position',1,?)`,
  ).run(now);

  const detail = await (await handlers.getFloorDetail(env, floor.id)).json();
  assert.equal(detail.facilities[0].positionedCount, 1);
  assert.equal(detail.anchors.length, 1);
  assert.equal(detail.anchors[0].entityId, "facility_printer");
  assert.equal(detail.usage.anchors, 1);
});

test("the building overview lists floors by levelOrder with image and usage, not plans", async () => {
  const sqlite = database();
  const bucket = new R2Bucket();
  const env = { DB: new D1(sqlite), SHUMAP_BUCKET: bucket };
  const basement = await addFloor(env, "B1", { levelOrder: -1 });
  const first = await addFloor(env, "F1", { levelOrder: 1 });
  const second = await addFloor(env, "F2", { levelOrder: 2 });
  addPlan(sqlite, first.id, { id: "map_version_f1" });
  sqlite.prepare(
    `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,created_at,updated_at)
     values('facility_printer','facility_type_printer','place_tower',?,'active','available',?,?)`,
  ).run(first.id, now, now);
  // F2 上传过平面图，总览里要能直接拿到图片地址。
  await handlers.uploadFloorImage(imageRequest(PNG_BYTES, "image/png"), env, principal, second.id, "request_image");

  const response = await handlers.listFloorsForBuilding(
    new Request("https://example.test/api/admin/floors?buildingPlaceId=place_tower"),
    env,
  );
  const payload = await response.json();
  // 按客户端给的 levelOrder 降序，高层在上。
  assert.deepEqual(payload.items.map((row) => row.levelCode), ["F2", "F1", "B1"]);
  assert.equal(payload.building.placeId, "place_tower");

  const firstRow = payload.items.find((row) => row.id === first.id);
  assert.ok(!("plans" in firstRow), "楼层总览不再带 plans——一层楼就是一张可选图片");
  assert.equal(firstRow.imageMediaId, null);
  assert.equal(firstRow.imageUrl, null);
  assert.deepEqual(Object.keys(firstRow.usage).sort(), ["anchors", "facilities", "mapVersions", "merchants"]);
  assert.equal(firstRow.usage.facilities, 1);
  assert.equal(firstRow.usage.mapVersions, 1);
  assert.equal(firstRow.isPublic, true);

  const secondRow = payload.items.find((row) => row.id === second.id);
  assert.ok(secondRow.imageMediaId, "上传过的楼层应有 imageMediaId");
  assert.equal(secondRow.imageUrl, `/api/public/media/${secondRow.imageMediaId}`);
  assert.equal(secondRow.usage.facilities, 0);

  assert.ok(basement, "地下层同样出现在总览里");

  await assert.rejects(
    () => handlers.listFloorsForBuilding(new Request("https://example.test/api/admin/floors"), env),
    (error) => error.status === 400 && error.code === "validation_error",
  );
});

// --- 平面图图片上传 ----------------------------------------------------------

test("uploading a floor image stores a public published media asset and links the floor", async () => {
  const sqlite = database();
  const bucket = new R2Bucket();
  const env = { DB: new D1(sqlite), SHUMAP_BUCKET: bucket };
  const floor = await addFloor(env, "F1", { levelOrder: 1 });

  const response = await handlers.uploadFloorImage(
    imageRequest(PNG_BYTES, "image/png"),
    env, principal, floor.id, "request_upload",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, floor.id);
  assert.ok(body.imageMediaId);
  assert.equal(body.imageUrl, `/api/public/media/${body.imageMediaId}`);

  // 落盘 public/media/，行记 public/published，因此公共端点立刻可读、随发版下发。
  const media = sqlite.prepare("select * from media_assets where id=?").get(body.imageMediaId);
  assert.equal(media.bucket_scope, "public");
  assert.equal(media.status, "published");
  assert.equal(media.content_type, "image/png");
  assert.equal(media.object_key, `public/media/${body.imageMediaId}.png`);
  assert.equal(media.byte_size, PNG_BYTES.byteLength);
  assert.equal(media.uploaded_by, "user_editor");
  assert.ok(bucket.objects.has(media.object_key), "图片字节应写入 R2");

  // floors.image_media_id 指向新图，并记审计。
  assert.equal(sqlite.prepare("select image_media_id from floors where id=?").get(floor.id).image_media_id, body.imageMediaId);
  assert.equal(
    sqlite.prepare("select count(*) as count from audit_events where action='floor.image'").get().count,
    1,
  );

  // 重复 PUT 即替换：指向新图，旧图行原地保留。
  const replaced = await (await handlers.uploadFloorImage(
    imageRequest(PNG_BYTES, "image/png"),
    env, principal, floor.id, "request_replace",
  )).json();
  assert.notEqual(replaced.imageMediaId, body.imageMediaId);
  assert.equal(sqlite.prepare("select image_media_id from floors where id=?").get(floor.id).image_media_id, replaced.imageMediaId);
  assert.equal(sqlite.prepare("select count(*) as count from media_assets where bucket_scope='public'").get().count, 2);
});

test("floor image upload rejects non-bitmap types, sniff mismatches, empty bodies, and unknown floors", async () => {
  const sqlite = database();
  const bucket = new R2Bucket();
  const env = { DB: new D1(sqlite), SHUMAP_BUCKET: bucket };
  const floor = await addFloor(env, "F1", { levelOrder: 1 });

  // svg 会带脚本，永不放行。
  await assert.rejects(
    () => handlers.uploadFloorImage(imageRequest(PNG_BYTES, "image/svg+xml"), env, principal, floor.id, "request_svg"),
    (error) => error.status === 415 && error.code === "unsupported_media_type",
  );
  // 声明 image/png 但字节是 JPEG：声明与嗅探必须一致。
  await assert.rejects(
    () => handlers.uploadFloorImage(imageRequest(JPEG_BYTES, "image/png"), env, principal, floor.id, "request_mismatch"),
    (error) => error.status === 415 && error.code === "unsupported_media_type",
  );
  // 空body。
  await assert.rejects(
    () => handlers.uploadFloorImage(imageRequest(new Uint8Array(0), "image/png"), env, principal, floor.id, "request_empty"),
    (error) => error.status === 400 && error.code === "validation_error",
  );
  // 未知楼层。
  await assert.rejects(
    () => handlers.uploadFloorImage(imageRequest(PNG_BYTES, "image/png"), env, principal, "floor_missing", "request_404"),
    (error) => error.status === 404 && error.code === "not_found",
  );
  // 全部失败路径都不应该落任何对象或行。
  assert.equal(bucket.objects.size, 0);
  assert.equal(sqlite.prepare("select count(*) as count from media_assets where bucket_scope='public'").get().count, 0);
  assert.equal(sqlite.prepare("select image_media_id from floors where id=?").get(floor.id).image_media_id, null);
});

// --- 删除与可见性 ----------------------------------------------------------

test("a floor with content attached cannot be deleted, and says what is holding it", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  const floor = await addFloor(env, "F1", { levelOrder: 1 });
  sqlite.prepare(
    `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,created_at,updated_at)
     values('facility_printer','facility_type_printer','place_tower',?,'active','available',?,?)`,
  ).run(floor.id, now, now);
  addPlan(sqlite, floor.id, { id: "map_version_f1" });

  await assert.rejects(
    () => handlers.deleteFloor(env, principal, floor.id, "request_delete"),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "floor_in_use");
      // 明细要能让界面说清「先把 1 个设施移走」，而不是丢一个数据库错误。
      assert.equal(error.details.facilities, 1);
      assert.equal(error.details.mapVersions, 1);
      return true;
    },
  );
  assert.equal(sqlite.prepare("select count(*) as count from floors where id=?").get(floor.id).count, 1);

  // 解除引用后可以删。
  sqlite.prepare("delete from facility_instances where id='facility_printer'").run();
  sqlite.prepare("delete from map_versions where id='map_version_f1'").run();
  const deleted = await (await handlers.deleteFloor(env, principal, floor.id, "request_delete")).json();
  assert.equal(deleted.deleted, true);
  assert.equal(sqlite.prepare("select count(*) as count from floors where id=?").get(floor.id).count, 0);
  // 删除要留痕。
  assert.equal(
    sqlite.prepare("select count(*) as count from audit_events where action='floor.delete'").get().count,
    1,
  );
});

test("hiding a floor keeps it and its content, unlike deleting", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  const floor = await addFloor(env, "F1", { levelOrder: 1 });
  sqlite.prepare(
    `insert into facility_instances(id,facility_type_id,host_place_id,floor_id,lifecycle_status,operational_status,created_at,updated_at)
     values('facility_printer','facility_type_printer','place_tower',?,'active','available',?,?)`,
  ).run(floor.id, now, now);

  await handlers.updateFloor(jsonRequest({ isPublic: false }, "PATCH"), env, principal, floor.id, "request_hide");
  const stored = sqlite.prepare("select is_public from floors where id=?").get(floor.id);
  assert.equal(stored.is_public, 0);
  // 内容原样保留——这正是「下架」与「删除」的区别。
  assert.equal(sqlite.prepare("select count(*) as count from facility_instances").get().count, 1);
});

test("floor updates patch display name, order, and visibility only", async () => {
  const sqlite = database();
  const env = { DB: new D1(sqlite) };
  const floor = await addFloor(env, "F1", { levelOrder: 1 });

  const updated = await (await handlers.updateFloor(
    jsonRequest({ displayName: "一楼大厅", levelOrder: 10 }, "PATCH"),
    env, principal, floor.id, "request_patch",
  )).json();
  assert.equal(updated.displayName, "一楼大厅");
  assert.equal(updated.levelOrder, 10);
  const stored = sqlite.prepare("select display_name,level_order,is_public from floors where id=?").get(floor.id);
  assert.equal(stored.display_name, "一楼大厅");
  assert.equal(stored.level_order, 10);
  assert.equal(stored.is_public, 1, "没传的字段保持原值");

  // level_code 是楼内唯一键且被设施/锚点引用，不在可改字段里。
  await assert.rejects(
    () => handlers.updateFloor(jsonRequest({ levelCode: "F2" }, "PATCH"), env, principal, floor.id, "request_code"),
    (error) => error.status === 400 && /floorUpdate\.levelCode is not supported/.test(error.message),
  );
});

// --- 接线 ------------------------------------------------------------------

test("the floor endpoints are registered behind the map permission", () => {
  const worker = read("worker/index-v2.ts");
  assert.match(worker, /path === "\/api\/admin\/floors"[\s\S]{0,200}?listFloorsForBuilding/);
  assert.match(worker, /method === "POST" && path === "\/api\/admin\/floors"[\s\S]{0,200}?createFloor/);
  assert.match(worker, /\/api\/admin\/floors\/:id\/image/);
  assert.match(worker, /getFloorDetail/);
  assert.match(worker, /updateFloor/);
  assert.match(worker, /deleteFloor/);
  assert.match(worker, /uploadFloorImage/);

  // 0032 拆掉的旧链路：图纸状态端点与室内空间写入口都不应再出现。
  assert.doesNotMatch(worker, /floor-plans\/:id\/status/);
  assert.doesNotMatch(worker, /updateFloorPlanStatus/);
  assert.doesNotMatch(worker, /createSpace/);
  assert.doesNotMatch(worker, /method === "POST" && path === "\/api\/admin\/spaces"/);

  // 写操作要 write:maps，读用 read:admin。
  for (const call of ["createFloor(request", "updateFloor(request", "deleteFloor(env", "uploadFloorImage(request"]) {
    const at = worker.lastIndexOf(call);
    assert.ok(at > 0, `${call} must be called from the router`);
    const gate = worker.lastIndexOf('requireSession(request, env, "write:maps")', at);
    assert.ok(gate > 0 && at - gate < 200, `${call} must be gated by write:maps`);
  }
  const detailAt = worker.lastIndexOf("getFloorDetail(env");
  const detailGate = worker.lastIndexOf('requireSession(request, env, "read:admin")', detailAt);
  assert.ok(detailGate > 0 && detailAt - detailGate < 200, "floor detail must require read:admin");
});

test("the place editor floor panel uploads plan images directly", () => {
  const page = read("src/admin/pages/PlaceEditorPage.tsx");
  // 楼层管理并入楼宇编辑页：每层一张位图，直传 PUT /api/admin/floors/:id/image，只接受 PNG/JPEG/WebP。
  assert.match(page, /uploadFloorImage/);
  assert.match(page, /image\/png,image\/jpeg,image\/webp/);
  // 旧的 SVG 导入管线（意图 → 上传 → 导入任务）与图纸状态操作都已拆除。
  assert.doesNotMatch(page, /updateFloorPlanStatus/);
  assert.doesNotMatch(page, /createMapUploadIntent/);
  assert.doesNotMatch(page, /createImportJob/);
  assert.doesNotMatch(page, /floor_svg/);

  // 独立的「楼层与楼层图」入口已撤掉；旧路径重定向到内容管理。
  const adminShell = read("src/admin/AdminPage.tsx");
  assert.doesNotMatch(adminShell, /FloorsPage/);
  assert.doesNotMatch(adminShell, /楼层与楼层图/);
  assert.match(adminShell, /path="floors" element=\{<Navigate to="\/admin\/content" replace \/>/);
});

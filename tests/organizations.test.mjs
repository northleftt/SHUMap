// 品牌 / 机构维护 + 商户生命周期。两条链路都是「引用表 + 即时生效的状态位」，
// 关注点是引用计数是否数全、有引用时删除是否被拒、停用是否不动既有引用。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  stdin: {
    contents: `
      export {
        createOrganization,
        deleteOrganization,
        listOrganizations,
        updateOrganization,
      } from "./worker/modules/organizations.ts";
      export { updateMerchantLifecycle } from "./worker/modules/merchants.ts";
    `,
    resolveDir: root,
    sourcefile: "organizations-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`;
const handlers = await import(moduleUrl);

class Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    this.database.prepare(this.sql).run(...this.values);
    return { success: true };
  }
}

class D1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("begin");
    try {
      for (const statement of statements) this.database.prepare(statement.sql).run(...statement.values);
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
    return statements.map(() => ({ success: true }));
  }
}

const now = "2026-08-03T00:00:00.000Z";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("pragma foreign_keys=on");
  for (const name of fs.readdirSync(path.join(root, "migrations-v2")).filter((value) => value.endsWith(".sql")).sort()) {
    sqlite.exec(fs.readFileSync(path.join(root, "migrations-v2", name), "utf8"));
  }
  sqlite.prepare(
    `insert into users(id,email,display_name,password_hash,status,token_version,created_at,updated_at)
     values('user_editor','editor@example.test','编辑','hash','active',1,?,?)`,
  ).run(now, now);
  return sqlite;
}

function request(body, method = "POST") {
  return new Request("https://example.test/api/admin/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const principal = { userId: "user_editor", permissions: ["write:content"] };

async function createOrganization(env, name, kind = "vendor") {
  const response = await handlers.createOrganization(request({ name, kind }), env, principal, "request_create");
  assert.equal(response.status, 201);
  return (await response.json()).id;
}

/** 五处引用各建一行，用来验证 usage 计数覆盖全部外键。 */
function referenceEverywhere(sqlite, organizationId) {
  sqlite.prepare(
    `insert into merchant_outlets(id,organization_id,lifecycle_status,created_at,updated_at)
     values('merchant_ref',?,'active',?,?)`,
  ).run(organizationId, now, now);
  sqlite.prepare(
    `insert into data_sources(id,source_type,title,organization_id,reliability,created_at)
     values('source_ref','official','校方文件',?,'authoritative',?)`,
  ).run(organizationId, now);
  sqlite.prepare(
    `insert into operational_events(id,event_type,severity,editorial_status,operational_status,title,starts_at,
       responsible_organization_id,created_at,updated_at)
     values('event_ref','maintenance','warning','approved','active','电梯检修',?,?,?,?)`,
  ).run(now, organizationId, now, now);
  sqlite.prepare(
    `insert into places(id,kind_id,campus_id,lifecycle_status,created_at,updated_at)
     values('place_ref','building','campus_baoshan','active',?,?)`,
  ).run(now, now);
  sqlite.prepare(
    "insert into buildings(place_id,building_code,managing_organization_id,public_access_level) values('place_ref','REF',?,'public')",
  ).run(organizationId);
  sqlite.prepare(
    `insert into transit_routes(id,code,name,operator_id,status,created_at,updated_at)
     values('route_ref','REF','校车环线',?,'active',?,?)`,
  ).run(organizationId, now, now);
}

async function listed(env, organizationId) {
  const payload = await (await handlers.listOrganizations(env)).json();
  const row = payload.items.find((item) => item.id === organizationId);
  assert.ok(row, `organization ${organizationId} missing from the list`);
  return { row, payload };
}

test("the list reports every foreign key that points at an organization", async () => {
  const sqlite = database();
  const env = { DB: new D1Database(sqlite) };
  const organizationId = await createOrganization(env, "蜜雪冰城");
  referenceEverywhere(sqlite, organizationId);

  const { row, payload } = await listed(env, organizationId);
  assert.deepEqual(row.usage, { merchants: 1, sources: 1, events: 1, buildings: 1, transit: 1 });
  assert.equal(row.status, "active");
  assert.equal(row.kind, "vendor");
  assert.ok(payload.kinds.includes("vendor"));
  sqlite.close();
});

test("a referenced organization cannot be deleted", async () => {
  const sqlite = database();
  const env = { DB: new D1Database(sqlite) };
  const organizationId = await createOrganization(env, "被引用的品牌");
  referenceEverywhere(sqlite, organizationId);

  await assert.rejects(
    () => handlers.deleteOrganization(env, principal, organizationId, "request_delete"),
    (error) => {
      assert.equal(error?.status, 409);
      assert.equal(error?.code, "organization_in_use");
      return true;
    },
  );
  assert.ok(sqlite.prepare("select id from organizations where id=?").get(organizationId));
  sqlite.close();
});

test("each single reference on its own blocks deletion", async () => {
  for (const column of [
    ["merchant_outlets", "organization_id"],
    ["data_sources", "organization_id"],
    ["operational_events", "responsible_organization_id"],
    ["buildings", "managing_organization_id"],
    ["transit_routes", "operator_id"],
  ]) {
    const [table, foreignKey] = column;
    const sqlite = database();
    const env = { DB: new D1Database(sqlite) };
    const organizationId = await createOrganization(env, `只被 ${table} 引用`);
    referenceEverywhere(sqlite, organizationId);
    // 只保留待测的那一处引用，其余清空。
    for (const [otherTable, otherKey] of [
      ["merchant_outlets", "organization_id"],
      ["data_sources", "organization_id"],
      ["operational_events", "responsible_organization_id"],
      ["buildings", "managing_organization_id"],
      ["transit_routes", "operator_id"],
    ]) {
      if (otherTable !== table) sqlite.exec(`update ${otherTable} set ${otherKey}=null`);
    }

    const { row } = await listed(env, organizationId);
    assert.equal(Object.values(row.usage).reduce((sum, value) => sum + value, 0), 1);
    await assert.rejects(
      () => handlers.deleteOrganization(env, principal, organizationId, `request_delete_${table}_${foreignKey}`),
      (error) => {
        assert.equal(error?.code, "organization_in_use");
        return true;
      },
    );
    sqlite.close();
  }
});

test("an unreferenced organization is deleted for real and audited", async () => {
  const sqlite = database();
  const env = { DB: new D1Database(sqlite) };
  const organizationId = await createOrganization(env, "没人用的机构", "other");

  const { row } = await listed(env, organizationId);
  assert.deepEqual(row.usage, { merchants: 0, sources: 0, events: 0, buildings: 0, transit: 0 });

  const response = await handlers.deleteOrganization(env, principal, organizationId, "request_delete");
  assert.equal(response.status, 204);
  assert.equal(sqlite.prepare("select id from organizations where id=?").get(organizationId), undefined);
  const audited = sqlite.prepare(
    "select action,entity_id from audit_events where entity_type='organization' and action='organization.delete'",
  ).get();
  assert.deepEqual({ ...audited }, { action: "organization.delete", entity_id: organizationId });
  sqlite.close();
});

test("retiring an organization leaves every referencing row untouched", async () => {
  const sqlite = database();
  const env = { DB: new D1Database(sqlite) };
  const organizationId = await createOrganization(env, "停用的品牌");
  referenceEverywhere(sqlite, organizationId);

  const response = await handlers.updateOrganization(
    request({ status: "retired" }, "PATCH"),
    env,
    principal,
    organizationId,
    "request_retire",
  );
  assert.equal(response.status, 200);

  const { row } = await listed(env, organizationId);
  assert.equal(row.status, "retired");
  assert.deepEqual(row.usage, { merchants: 1, sources: 1, events: 1, buildings: 1, transit: 1 });
  assert.equal(row.name, "停用的品牌");
  const merchant = sqlite.prepare("select organization_id,lifecycle_status from merchant_outlets where id='merchant_ref'").get();
  assert.deepEqual({ ...merchant }, { organization_id: organizationId, lifecycle_status: "active" });
  sqlite.close();
});

test("organization updates change only the supplied fields", async () => {
  const sqlite = database();
  const env = { DB: new D1Database(sqlite) };
  const organizationId = await createOrganization(env, "改名前", "vendor");

  await handlers.updateOrganization(request({ name: "改名后" }, "PATCH"), env, principal, organizationId, "request_rename");
  const renamed = (await listed(env, organizationId)).row;
  assert.equal(renamed.name, "改名后");
  assert.equal(renamed.kind, "vendor");
  assert.equal(renamed.status, "active");

  await handlers.updateOrganization(request({ kind: "school" }, "PATCH"), env, principal, organizationId, "request_kind");
  const rekinded = (await listed(env, organizationId)).row;
  assert.equal(rekinded.kind, "school");
  assert.equal(rekinded.name, "改名后");
  sqlite.close();
});

test("organization writes reject unknown kinds, empty patches, and missing rows", async () => {
  const sqlite = database();
  const env = { DB: new D1Database(sqlite) };
  const organizationId = await createOrganization(env, "校验用");

  for (const [body, pattern] of [
    [{ name: "错类型", kind: "brand" }, /kind must be one of/],
    [{ name: "缺类型" }, /organization\.kind is required/],
    [{ name: "多字段", kind: "vendor", status: "active" }, /organization\.status is not supported/],
  ]) {
    await assert.rejects(
      () => handlers.createOrganization(request(body), env, principal, "request_invalid"),
      (error) => {
        assert.equal(error?.status, 400);
        assert.equal(error?.code, "validation_error");
        assert.match(String(error?.message), pattern);
        return true;
      },
    );
  }

  await assert.rejects(
    () => handlers.updateOrganization(request({}, "PATCH"), env, principal, organizationId, "request_empty"),
    (error) => {
      assert.match(String(error?.message), /organizationUpdate must contain at least one field/);
      return true;
    },
  );
  await assert.rejects(
    () => handlers.updateOrganization(request({ status: "disabled" }, "PATCH"), env, principal, organizationId, "request_bad_status"),
    (error) => {
      assert.match(String(error?.message), /status must be one of: active, retired/);
      return true;
    },
  );
  for (const call of [
    () => handlers.updateOrganization(request({ name: "无此机构" }, "PATCH"), env, principal, "org_missing", "request_missing"),
    () => handlers.deleteOrganization(env, principal, "org_missing", "request_missing_delete"),
  ]) {
    await assert.rejects(call, (error) => {
      assert.equal(error?.status, 404);
      assert.equal(error?.code, "not_found");
      return true;
    });
  }
  sqlite.close();
});

function insertMerchant(sqlite) {
  sqlite.prepare(
    `insert into merchant_outlets(id,lifecycle_status,created_at,updated_at)
     values('merchant_lifecycle','planned',?,?)`,
  ).run(now, now);
  return "merchant_lifecycle";
}

test("every lifecycle status of the check constraint can be set", async () => {
  const sqlite = database();
  const env = { DB: new D1Database(sqlite) };
  const outletId = insertMerchant(sqlite);

  for (const lifecycleStatus of ["active", "temporarily_closed", "retired", "planned"]) {
    const response = await handlers.updateMerchantLifecycle(
      request({ lifecycleStatus }, "PATCH"),
      env,
      principal,
      outletId,
      `request_${lifecycleStatus}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: outletId, lifecycleStatus });
    assert.equal(sqlite.prepare("select lifecycle_status from merchant_outlets where id=?").get(outletId).lifecycle_status, lifecycleStatus);
  }

  const audited = sqlite.prepare(
    "select count(*) as count from audit_events where action='merchant.lifecycle.update' and entity_id=?",
  ).get(outletId);
  assert.equal(audited.count, 4);
  sqlite.close();
});

test("lifecycle updates reject unsupported values, extra fields, and unknown outlets", async () => {
  const sqlite = database();
  const env = { DB: new D1Database(sqlite) };
  const outletId = insertMerchant(sqlite);

  for (const [body, pattern] of [
    [{ lifecycleStatus: "closed" }, /lifecycleStatus must be one of: planned, active, temporarily_closed, retired/],
    [{ lifecycleStatus: "active", note: "顺便改点别的" }, /merchantLifecycle\.note is not supported/],
    [{}, /merchantLifecycle\.lifecycleStatus is required/],
  ]) {
    await assert.rejects(
      () => handlers.updateMerchantLifecycle(request(body, "PATCH"), env, principal, outletId, "request_invalid"),
      (error) => {
        assert.equal(error?.status, 400);
        assert.equal(error?.code, "validation_error");
        assert.match(String(error?.message), pattern);
        return true;
      },
    );
  }
  assert.equal(sqlite.prepare("select lifecycle_status from merchant_outlets where id=?").get(outletId).lifecycle_status, "planned");

  await assert.rejects(
    () => handlers.updateMerchantLifecycle(request({ lifecycleStatus: "active" }, "PATCH"), env, principal, "merchant_missing", "request_missing"),
    (error) => {
      assert.equal(error?.status, 404);
      assert.equal(error?.code, "not_found");
      return true;
    },
  );
  sqlite.close();
});

test("the lifecycle endpoint touches nothing but the status and the timestamp", async () => {
  const sqlite = database();
  const env = { DB: new D1Database(sqlite) };
  const organizationId = await createOrganization(env, "门店品牌");
  sqlite.prepare(
    `insert into merchant_outlets(id,organization_id,lifecycle_status,created_at,updated_at)
     values('merchant_scoped',?,'active',?,?)`,
  ).run(organizationId, now, now);

  await handlers.updateMerchantLifecycle(
    request({ lifecycleStatus: "temporarily_closed" }, "PATCH"),
    env,
    principal,
    "merchant_scoped",
    "request_scoped",
  );
  const outlet = sqlite.prepare(
    "select organization_id,lifecycle_status,current_revision_id,created_at from merchant_outlets where id='merchant_scoped'",
  ).get();
  assert.deepEqual({ ...outlet }, {
    organization_id: organizationId,
    lifecycle_status: "temporarily_closed",
    current_revision_id: null,
    created_at: now,
  });
  sqlite.close();
});

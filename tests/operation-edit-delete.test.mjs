// Coverage for the operational-event edit/delete loop:
//   PUT    /api/admin/operations/:id  (updateOperationalEvent)
//   DELETE /api/admin/operations/:id  (deleteOperationalEvent)
//
// Handler-level tests over a fake D1 (same harness as admin-write-contracts):
// the state machine (rejected → draft re-queue, approved stays approved, ended
// is read-only) and the color validation live in the handler, not the schema.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bundle = await build({
  stdin: {
    contents: `export { updateOperationalEvent, deleteOperationalEvent } from "./worker/modules/operations.ts";`,
    resolveDir: root,
    sourcefile: "operation-edit-delete-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});

const handlers = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

class FakeStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new FakeStatement(this.database, this.sql, values);
  }

  async first() {
    return this.database.first(this.sql, this.values);
  }

  async all() {
    return { results: this.database.all(this.sql, this.values) };
  }

  async run() {
    this.database.executions.push({ sql: this.sql, values: this.values });
    return { success: true };
  }
}

class FakeDatabase {
  constructor(eventRow) {
    this.eventRow = eventRow;
    this.executions = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    for (const statement of statements) {
      this.executions.push({ sql: statement.sql, values: statement.values });
    }
    return statements.map(() => ({ success: true }));
  }

  first(sql, values) {
    if (sql.includes("from operational_events where id=?")) return this.eventRow;
    if (/^select (?:id|place_id) from [a-z_]+ where/.test(sql)) return { id: values[0] };
    return null;
  }

  all(sql) {
    if (sql.includes("from entity_locations")) {
      return this.eventRow ? [{ anchorId: "anchor_1" }, { anchorId: "anchor_2" }] : [];
    }
    return [];
  }
}

const principal = { userId: "user_test" };

function request(body, method = "PUT") {
  return new Request("https://example.test/api/admin/operations/event_1", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function eventRow(overrides = {}) {
  return {
    id: "event_1",
    event_type: "maintenance",
    severity: "warning",
    color: null,
    editorial_status: "draft",
    operational_status: "scheduled",
    title: "旧标题",
    description: null,
    starts_at: "2026-08-01T01:00:00.000Z",
    expected_ends_at: null,
    auto_expire_at: null,
    source_id: null,
    responsible_organization_id: null,
    ...overrides,
  };
}

function editBody(overrides = {}) {
  return {
    eventType: "maintenance",
    severity: "warning",
    color: null,
    title: "新标题",
    description: null,
    startsAt: "2026-08-01T01:00:00.000Z",
    expectedEndsAt: null,
    autoExpireAt: null,
    sourceId: null,
    responsibleOrganizationId: null,
    targets: [{ type: "place", id: "place_1", impactType: "affected" }],
    ...overrides,
  };
}

test("update keeps draft events in draft and rewrites fields + targets", async () => {
  const database = new FakeDatabase(eventRow());
  const response = await handlers.updateOperationalEvent(
    request(editBody({ color: "#7C3AED" })), { DB: database }, principal, "event_1", "request_1",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "event_1", editorialStatus: "draft" });
  const update = database.executions.find((entry) => entry.sql.includes("update operational_events"));
  assert.ok(update, "应更新事件行");
  assert.equal(update.values[2], "#7c3aed", "color 归一化为小写入库");
  assert.equal(update.values[3], "新标题");
  assert.ok(database.executions.some((entry) => entry.sql.includes("delete from operational_event_targets")));
  assert.ok(database.executions.some((entry) => entry.sql.includes("insert into operational_event_targets")));
});

test("update sends rejected events back to draft and clears the review stamp", async () => {
  const database = new FakeDatabase(eventRow({ editorial_status: "rejected", reviewed_by: "user_reviewer" }));
  const response = await handlers.updateOperationalEvent(
    request(editBody()), { DB: database }, principal, "event_1", "request_2",
  );
  assert.deepEqual(await response.json(), { id: "event_1", editorialStatus: "draft" });
  const update = database.executions.find((entry) => entry.sql.includes("update operational_events"));
  assert.equal(update.values[10], "draft", "rejected 改完回 draft 重新排队");
  assert.match(update.sql, /reviewed_by=case when editorial_status='rejected'/);
});

test("update keeps approved events approved", async () => {
  const database = new FakeDatabase(eventRow({ editorial_status: "approved" }));
  const response = await handlers.updateOperationalEvent(
    request(editBody()), { DB: database }, principal, "event_1", "request_3",
  );
  assert.deepEqual(await response.json(), { id: "event_1", editorialStatus: "approved" });
});

test("update rejects ended events and bad colors", async () => {
  const ended = new FakeDatabase(eventRow({ editorial_status: "approved", operational_status: "resolved" }));
  await assert.rejects(
    () => handlers.updateOperationalEvent(request(editBody()), { DB: ended }, principal, "event_1", "request_4"),
    /Ended events cannot be edited/,
  );
  const database = new FakeDatabase(eventRow());
  await assert.rejects(
    () => handlers.updateOperationalEvent(request(editBody({ color: "red" })), { DB: database }, principal, "event_1", "request_5"),
    /color must be a #rrggbb hex color/,
  );
  await assert.rejects(
    () => handlers.updateOperationalEvent(request(editBody({ unknown: 1 })), { DB: database }, principal, "event_1", "request_6"),
    /unknown/i,
  );
});

test("update 404s when the event does not exist", async () => {
  const database = new FakeDatabase(null);
  await assert.rejects(
    () => handlers.updateOperationalEvent(request(editBody()), { DB: database }, principal, "event_missing", "request_7"),
    /Event does not exist/,
  );
});

test("delete removes the event with its geometry bindings and anchors", async () => {
  const database = new FakeDatabase(eventRow());
  const response = await handlers.deleteOperationalEvent({ DB: database }, principal, "event_1", "request_8");
  assert.deepEqual(await response.json(), { id: "event_1", deleted: true });
  assert.ok(database.executions.some((entry) =>
    entry.sql.includes("delete from entity_locations where entity_type='operational_event'")));
  const anchorDelete = database.executions.find((entry) => entry.sql.includes("delete from location_anchors"));
  assert.ok(anchorDelete, "应删除几何锚点");
  assert.deepEqual(anchorDelete.values, ["anchor_1", "anchor_2"]);
  assert.ok(database.executions.some((entry) => entry.sql.includes("delete from operational_events where id=?")));
  assert.ok(database.executions.some((entry) => entry.sql.includes("insert into audit_events")), "删除必须审计");
});

test("delete 404s when the event does not exist", async () => {
  const database = new FakeDatabase(null);
  await assert.rejects(
    () => handlers.deleteOperationalEvent({ DB: database }, principal, "event_missing", "request_9"),
    /Event does not exist/,
  );
});

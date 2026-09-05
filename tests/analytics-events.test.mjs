import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bundle = await build({
  stdin: {
    contents: `
      export { recordAnalyticsEvent, getAnalyticsSummary, ANALYTICS_EVENT_TYPES } from "./worker/modules/analytics.ts";
    `,
    resolveDir: root,
    sourcefile: "analytics-events-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});

const encodedBundle = Buffer.from(bundle.outputFiles[0].contents).toString("base64");
const { recordAnalyticsEvent, getAnalyticsSummary, ANALYTICS_EVENT_TYPES } =
  await import(`data:text/javascript;base64,${encodedBundle}`);

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
  constructor() {
    this.executions = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  first(sql) {
    // 限流计数：永远不回桶满
    if (sql.includes("from public_rate_limits")) return { requestCount: 0 };
    return null;
  }

  all(sql) {
    if (sql.includes("substr(created_at, 1, 10)")) {
      return [
        { day: "2026-09-03", event_type: "map_view", event_count: 12 },
        { day: "2026-09-03", event_type: "search", event_count: 5 },
      ];
    }
    if (sql.includes("max(place_name)")) {
      return [{ place_id: "place_1", place_name: "图书馆", view_count: 9 }];
    }
    if (sql.includes("group by event_type")) {
      return [
        { event_type: "map_view", event_count: 20 },
        { event_type: "poi_view", event_count: 8 },
      ];
    }
    return [];
  }
}

function makeEnv() {
  return { DB: new FakeDatabase() };
}

function postEvent(body) {
  return new Request("https://example.test/api/analytics/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("all declared analytics event types are accepted and inserted", async () => {
  for (const eventType of ANALYTICS_EVENT_TYPES) {
    const env = makeEnv();
    const response = await recordAnalyticsEvent(
      postEvent({ eventType, campus: "宝山", meta: { probe: true } }),
      env,
    );
    assert.equal(response.status, 204, `${eventType} should be accepted`);
    const insert = env.DB.executions.find((execution) => execution.sql.includes("insert into analytics_events"));
    assert.ok(insert, `${eventType} should be inserted`);
    assert.equal(insert.values[1], eventType);
  }
});

test("unknown event types are rejected with 400", async () => {
  await assert.rejects(
    recordAnalyticsEvent(postEvent({ eventType: "hover" }), makeEnv()),
    (error) => error.status === 400 && error.code === "validation_error",
  );
});

test("analytics summary aggregates totals, daily breakdown and top places", async () => {
  const response = await getAnalyticsSummary(makeEnv(), new URL("https://example.test/api/admin/analytics/summary"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.days, 7);
  assert.deepEqual(body.totals, [
    { event_type: "map_view", event_count: 20 },
    { event_type: "poi_view", event_count: 8 },
  ]);
  assert.equal(body.daily.length, 2);
  assert.equal(body.daily[0].day, "2026-09-03");
  assert.deepEqual(body.topPlaces, [{ place_id: "place_1", place_name: "图书馆", view_count: 9 }]);
});

test("analytics summary honors days param and rejects out-of-range values", async () => {
  const ok = await getAnalyticsSummary(makeEnv(), new URL("https://example.test/api/admin/analytics/summary?days=30"));
  assert.equal((await ok.json()).days, 30);
  for (const days of ["0", "91", "abc", "1.5"]) {
    await assert.rejects(
      getAnalyticsSummary(makeEnv(), new URL(`https://example.test/api/admin/analytics/summary?days=${days}`)),
      (error) => error.status === 400,
      `days=${days} should be rejected`,
    );
  }
});

test("worker event type list matches the 0030 migration CHECK constraint", () => {
  const migration = fs.readFileSync(path.join(root, "migrations-v2/0030_analytics_event_types.sql"), "utf8");
  const match = migration.match(/check \(event_type in \(([^)]+)\)\)/i);
  assert.ok(match, "migration should declare the event_type CHECK");
  const migrationTypes = match[1].match(/'([a-z_]+)'/g).map((item) => item.slice(1, -1)).sort();
  assert.deepEqual([...ANALYTICS_EVENT_TYPES].sort(), migrationTypes);
});

test("admin analytics summary route is registered", () => {
  const worker = fs.readFileSync(path.join(root, "worker/index-v2.ts"), "utf8");
  assert.match(worker, /\/api\/admin\/analytics\/summary/);
});

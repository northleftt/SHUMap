import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bundle = await build({
  stdin: {
    contents: `
      export { createFloor, updateFloor } from "./worker/modules/spaces.ts";
      export { createPattern, createCalendar, createTrip, updateTrip } from "./worker/modules/transit.ts";
      export {
        createMapFilter,
        updateMapFilter,
        createMapFilterMember,
        updateMapFilterMember,
      } from "./worker/modules/map-filters.ts";
    `,
    resolveDir: root,
    sourcefile: "admin-write-contracts-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});

const encodedBundle = Buffer.from(bundle.outputFiles[0].contents).toString("base64");
const handlers = await import(`data:text/javascript;base64,${encodedBundle}`);

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

  async batch(statements) {
    for (const statement of statements) {
      this.executions.push({ sql: statement.sql, values: statement.values });
    }
    return statements.map(() => ({ success: true }));
  }

  first(sql, values) {
    if (sql.includes("select * from map_filter_members where id=?")) {
      return {
        id: values[0],
        category_id: "map_filter_teaching",
        place_kind_id: "building",
        facility_type_id: null,
        includes_merchants: 0,
        sort_order: 10,
      };
    }
    if (sql.includes("from map_filter_categories where id=?")) {
      return { id: values[0], key: "teaching", label: "教学", active: 1, sort_order: 10 };
    }
    if (sql.includes("from transit_trips") && sql.includes("status='active'")) {
      return {
        id: "trip_1",
        pattern_id: "pattern_1",
        service_calendar_id: "calendar_1",
        booking_policy: "optional",
        booking_url: "https://example.test/book",
      };
    }
    if (sql.includes("from floors where id=?")) {
      return {
        id: "floor_1",
        building_place_id: "place_1",
        level_code: "1F",
        level_order: 1,
        display_name: "一层",
        is_public: 1,
      };
    }
    if (/^select (?:id|place_id) from [a-z_]+ where/.test(sql)) {
      return { id: values[0], place_id: values[0] };
    }
    return null;
  }

  all(sql) {
    if (sql.includes("from transit_pattern_stops where pattern_id=?")) {
      return [
        { stop_id: "stop_a", stop_sequence: 0 },
        { stop_id: "stop_b", stop_sequence: 1 },
      ];
    }
    return [];
  }
}

const principal = { userId: "user_test" };

function request(body, method = "POST") {
  return new Request("https://example.test/api/admin/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function environment(database = new FakeDatabase()) {
  return { env: { DB: database }, database };
}

async function rejectsValidation(action, message) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.status, 400);
    assert.equal(error?.code, "validation_error");
    assert.match(String(error?.message), message);
    return true;
  });
}

const completeFloor = {
  buildingPlaceId: "place_1",
  levelCode: "1F",
  levelOrder: 1,
  displayName: "一层",
  isPublic: true,
};

test("space write contracts reject unknown, missing, empty, and coerced fields", async () => {
  {
    const { env } = environment();
    await rejectsValidation(
      () => handlers.createFloor(request({ ...completeFloor, extra: true }), env, principal, "request_1"),
      /floor\.extra is not supported/,
    );
  }
  {
    const { env } = environment();
    const { displayName: _displayName, ...incomplete } = completeFloor;
    await rejectsValidation(
      () => handlers.createFloor(request(incomplete), env, principal, "request_2"),
      /floor\.displayName is required/,
    );
  }
  {
    const { env } = environment();
    await rejectsValidation(
      () => handlers.createFloor(request({ ...completeFloor, isPublic: 1 }), env, principal, "request_3"),
      /isPublic must be a boolean/,
    );
  }
  {
    const { env } = environment();
    await rejectsValidation(
      () => handlers.updateFloor(request({}, "PATCH"), env, principal, "floor_1", "request_4"),
      /floorUpdate must contain at least one field/,
    );
  }
});

const completePattern = {
  routeId: "route_1",
  directionId: 0,
  name: "上行",
  stops: [
    { stopId: "stop_a", pickupType: "regular", dropoffType: "regular" },
    { stopId: "stop_b", pickupType: "none", dropoffType: "regular" },
  ],
};

test("pattern stops require explicit pickup and dropoff policies", async () => {
  for (const missing of ["pickupType", "dropoffType"]) {
    const { env } = environment();
    const stops = completePattern.stops.map((stop) => ({ ...stop }));
    delete stops[0][missing];
    await rejectsValidation(
      () => handlers.createPattern(request({ ...completePattern, stops }), env, principal, `request_${missing}`),
      new RegExp(`stops\\[0\\]\\.${missing} is required`),
    );
  }
});

const weekdays = {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
};

test("calendar weekdays only accept explicit booleans", async () => {
  const { env } = environment();
  await rejectsValidation(
    () => handlers.createCalendar(request({
      name: "教学周",
      validFrom: "2026-09-01",
      validTo: "2027-01-31",
      dayType: "weekday",
      weekdays: { ...weekdays, monday: 1 },
      exceptions: [],
      sourceId: null,
    }), env, principal, "request_calendar"),
    /weekdays\.monday must be a boolean/,
  );
});

// 日型（0025）是必填且枚举受限：它决定客户端「今天是工作日/假日……」标签。
// 漏填时宁可 400，也不要默默落成 'other' —— 那样标签会静默消失，而运营以为填好了。
test("calendar dayType is required and enum-checked", async () => {
  const { env } = environment();
  const body = {
    name: "教学周",
    validFrom: "2026-09-01",
    validTo: "2027-01-31",
    weekdays,
    exceptions: [],
    sourceId: null,
  };
  await rejectsValidation(
    () => handlers.createCalendar(request(body), env, principal, "request_calendar"),
    /dayType is required/,
  );
  await rejectsValidation(
    () => handlers.createCalendar(request({ ...body, dayType: "winterBreak" }), env, principal, "request_calendar"),
    /dayType/,
  );
});

test("calendar dayType reaches the insert", async () => {
  const { env, database } = environment();
  await handlers.createCalendar(request({
    name: "2026-2027 寒假",
    validFrom: "2027-01-26",
    validTo: "2027-03-01",
    dayType: "winter_break",
    weekdays,
    exceptions: [],
    sourceId: null,
  }), env, principal, "request_calendar");
  const insert = database.executions.find((entry) => entry.sql.includes("insert into service_calendars"));
  assert.ok(insert, "应写入 service_calendars");
  assert.match(insert.sql, /day_type/);
  assert.ok(insert.values.includes("winter_break"), `day_type 应进绑定值：${JSON.stringify(insert.values)}`);
});

const completeTrip = {
  patternId: "pattern_1",
  serviceCalendarId: "calendar_1",
  publicLabel: null,
  bookingPolicy: "not_required",
  bookingUrl: null,
  sourceId: null,
  stopTimes: [
    { arrivalTime: "08:00", departureTime: "08:00" },
    { arrivalTime: "08:20", departureTime: "08:20" },
  ],
};

test("trip contracts accept omitted bookingPolicy but require other booking fields and typed stop times", async () => {
  // bookingPolicy 自 0024 起是线路级属性，前端不再随班次提交：缺省必须放行
  //（曾是必填，把管理端「添加班次」打成一律 400），bookingUrl 等其余字段仍必填。
  {
    const { env } = environment();
    const withoutPolicy = { ...completeTrip };
    delete withoutPolicy.bookingPolicy;
    const response = await handlers.createTrip(request(withoutPolicy), env, principal, "request_no_policy");
    assert.equal(response.status, 201);
  }
  for (const missing of ["bookingUrl"]) {
    const { env } = environment();
    const incomplete = { ...completeTrip };
    delete incomplete[missing];
    await rejectsValidation(
      () => handlers.createTrip(request(incomplete), env, principal, `request_${missing}`),
      new RegExp(`transitTrip\\.${missing} is required`),
    );
  }

  const { env } = environment();
  await rejectsValidation(
    () => handlers.createTrip(request({
      ...completeTrip,
      stopTimes: [
        { arrivalTime: 800, departureTime: "08:00" },
        completeTrip.stopTimes[1],
      ],
    }), env, principal, "request_stop_time"),
    /stopTimes\[0\]\.arrivalTime must be a string/,
  );
});

test("trip update accepts null as an explicit booking URL clear", async () => {
  const { env, database } = environment();
  const response = await handlers.updateTrip(
    request({ bookingUrl: null }, "PATCH"),
    env,
    principal,
    "trip_1",
    "request_clear_booking_url",
  );
  assert.equal(response.status, 200);

  const update = database.executions.find(({ sql }) => sql.startsWith("update transit_trips set"));
  assert.ok(update);
  assert.deepEqual(update.values, ["calendar_1", "optional", null, "trip_1"]);
});

test("map filter writes reject removed source fields and key changes", async () => {
  {
    const { env } = environment();
    await rejectsValidation(
      () => handlers.createMapFilter(
        request({ key: "newChip", label: "新分类", sourceType: "place_kind" }),
        env,
        principal,
        "request_map_filter_create",
      ),
      /mapFilter\.sourceType is not supported/,
    );
  }
  {
    const { env } = environment();
    await rejectsValidation(
      () => handlers.updateMapFilter(
        request({ key: "changed" }, "PATCH"),
        env,
        principal,
        "map_filter_teaching",
        "request_map_filter_update",
      ),
      /mapFilterUpdate\.key is not supported/,
    );
  }
});

test("map filter member writes reject removed selector fields", async () => {
  {
    const { env } = environment();
    await rejectsValidation(
      () => handlers.createMapFilterMember(
        request({ placeKindId: "building", sourceType: "place_kind" }),
        env,
        principal,
        "map_filter_teaching",
        "request_map_filter_member_create",
      ),
      /mapFilterMember\.sourceType is not supported/,
    );
  }
  {
    const { env } = environment();
    await rejectsValidation(
      () => handlers.updateMapFilterMember(
        request({ placeKindId: "library" }, "PATCH"),
        env,
        principal,
        "member_teaching",
        "request_map_filter_member_update",
      ),
      /mapFilterMemberUpdate\.placeKindId is not supported/,
    );
  }
});

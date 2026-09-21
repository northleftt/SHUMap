import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 管理端校历 / 就餐页的客户端日型推导（src/lib/calendar/dayType.ts）。
// 口径必须与 worker/lib/daytype.ts 的校历部分一致：
// 调休工作日 > 法定节假日 > 寒暑假区间 > 周六日 > 其余。

const bundle = await build({
  stdin: {
    contents: `
      export { deriveDayType, isWeekend, shanghaiWeekday, nextAcademicYearName, monthGrid } from "./src/lib/calendar/dayType.ts";
    `,
    resolveDir: root,
    sourcefile: "calendar-daytype-client-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const { deriveDayType, isWeekend, shanghaiWeekday, nextAcademicYearName, monthGrid } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

const terms = [
  { dayType: "term", validFrom: "2026-09-07", validTo: "2027-01-15" },
  { dayType: "winter_break", validFrom: "2027-01-16", validTo: "2027-02-26" },
  { dayType: "summer_break", validFrom: "2027-07-05", validTo: "2027-08-31" },
];
const dates = [
  { serviceDate: "2026-10-01", kind: "holiday" },
  { serviceDate: "2026-09-26", kind: "workday_override" },
];

test("周末按上海时区判定，不受运行环境 TZ 影响", () => {
  assert.equal(shanghaiWeekday("2026-09-19"), "saturday");
  assert.equal(shanghaiWeekday("2026-09-20"), "sunday");
  assert.equal(shanghaiWeekday("2026-09-21"), "monday");
  assert.equal(isWeekend("2026-09-19"), true);
  assert.equal(isWeekend("2026-09-21"), false);
  assert.equal(shanghaiWeekday("not-a-date"), null);
  assert.equal(isWeekend("2026/09/19"), false);
});

test("普通工作日 / 周末的推导", () => {
  assert.equal(deriveDayType("2026-09-21", terms, dates), "weekday");
  assert.equal(deriveDayType("2026-09-19", terms, dates), "weekend");
  assert.equal(deriveDayType("2026-09-20", terms, dates), "weekend");
});

test("调休工作日优先于周六日", () => {
  // 2026-09-26 是周六，但在调休工作日列表里 → 工作日。
  assert.equal(deriveDayType("2026-09-26", terms, dates), "weekday");
});

test("法定节假日优先于周六日与假期区间", () => {
  // 2026-10-01 是周四 → 假日。
  assert.equal(deriveDayType("2026-10-01", terms, dates), "holiday");
  // 落在寒假区间里的法定节假日仍是假日。
  const holidayInBreak = [{ serviceDate: "2027-02-17", kind: "holiday" }];
  assert.equal(deriveDayType("2027-02-17", terms, holidayInBreak), "holiday");
  // 同一日期同时有两种记录时，调休工作日优先（与 worker 判定顺序一致）。
  const both = [
    { serviceDate: "2026-10-01", kind: "holiday" },
    { serviceDate: "2026-10-01", kind: "workday_override" },
  ];
  assert.equal(deriveDayType("2026-10-01", terms, both), "weekday");
});

test("寒暑假区间（含边界）", () => {
  assert.equal(deriveDayType("2027-01-16", terms, dates), "winter_break");
  assert.equal(deriveDayType("2027-02-26", terms, dates), "winter_break");
  assert.equal(deriveDayType("2027-01-20", terms, dates), "winter_break");
  assert.equal(deriveDayType("2027-07-10", terms, dates), "summer_break");
  // term 区间不参与日型推导。
  assert.equal(deriveDayType("2026-10-09", terms, dates), "weekday");
});

test("下一学年名：数字结构 +1，解析不了返回空串", () => {
  assert.equal(nextAcademicYearName("2025-2026"), "2026-2027");
  assert.equal(nextAcademicYearName("2025 – 2026"), "2026-2027");
  assert.equal(nextAcademicYearName("第 12 学年"), "");
});

test("月份网格：周一开头，6×7，月外格子为 null", () => {
  // 2026-09-01 是周二，第一周周一格为空。
  const weeks = monthGrid(2026, 8);
  assert.equal(weeks[0][0], null);
  assert.equal(weeks[0][1], "2026-09-01");
  const flat = weeks.flat().filter(Boolean);
  assert.equal(flat.length, 30);
  assert.equal(flat[0], "2026-09-01");
  assert.equal(flat[29], "2026-09-30");
  // 跨年：2027 年 1 月。
  const jan = monthGrid(2027, 0).flat().filter(Boolean);
  assert.equal(jan[0], "2027-01-01");
  assert.equal(jan.length, 31);
});

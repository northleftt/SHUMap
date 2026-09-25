// 就餐模块：开放安排 + 供餐时段 + 校历，外加商户营业状态的实时读端。
//
// 三张表都即时生效、不进 release（0035/0036），与商户本体内容（修订流 + 发版）分工：
// 楼层开不开、时段怎么划，改完 30s 内对前台生效；食堂/楼层/商户叫什么、卖什么，仍走发布。

import type { SessionPrincipal } from "../domain/types";
import type { Env } from "../types/cloudflare";
import { all, assertExists, first } from "../lib/db";
import { HttpError, json, noContent, readJson } from "../lib/http";
import { exactObject, isoNow, jsonString, makeId, oneOf } from "../lib/values";
import { CAMPUS_DAY_TYPES, resolveCampusDayType, shanghaiWeekday, type CampusDayType } from "../lib/daytype";
import { audit } from "./audit";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MEALS = ["breakfast", "lunner", "latenight"] as const;
const TERM_DAY_TYPES = ["term", "winter_break", "summer_break"] as const;
const DATE_KINDS = ["holiday", "workday_override"] as const;

function dateValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new HttpError(400, "validation_error", `${field} must be YYYY-MM-DD`);
  return value;
}

function timeValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !TIME_RE.test(value)) throw new HttpError(400, "validation_error", `${field} must be HH:MM`);
  return value;
}

function nameValue(value: unknown, field: string, max = 100): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new HttpError(400, "validation_error", `${field} must be a non-empty string within ${max} chars`);
  }
  return value.trim();
}

// 开放安排的适用日型：weekday 不录——工作日默认全开是常态，台风天这类例外应录进
// 校历当特殊日、由 holiday 类安排承接；允许录 weekday 会得到一条前台永远不生效的安排
// （前台只在非工作日应用白名单），管理端给了开关却静默无效。
const DINING_DAY_TYPES = CAMPUS_DAY_TYPES.filter((type) => type !== "weekday");

function dayTypeSet(value: unknown, field: string): CampusDayType[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, "validation_error", `${field} must be a non-empty array`);
  return value.map((item, index) => oneOf(item, `${field}[${index}]`, DINING_DAY_TYPES));
}

function shanghaiToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

// ---------------------------------------------------------------------------
// 公开读端
// ---------------------------------------------------------------------------

/**
 * GET /api/public/dining/schedule?date=YYYY-MM-DD — 就餐页的实时数据源。
 *
 * 一次下发：当天日型（校历判定，与校车页同口径）、全局供餐时段表、当天命中的开放安排。
 * 无安排时 arrangement 为 null：工作日由客户端按默认全开展示，周末/假日显示「暂无安排信息」。
 * 照 facility-status 的模式：D1 直读 + 30s 缓存，不进 release。
 */
export async function publicDiningSchedule(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? shanghaiToday();
  if (!DATE_RE.test(date)) throw new HttpError(400, "validation_error", "Invalid date");
  const weekday = shanghaiWeekday(date);
  if (!weekday) throw new HttpError(400, "validation_error", "Invalid date");
  const dayType = await resolveCampusDayType(env, date, weekday);
  const mealPeriods = await all(
    env.DB,
    "select meal,start_time as startTime,end_time as endTime,sort_order as sortOrder from dining_meal_periods order by sort_order,id",
  );
  const schedules = await all<{ id: string; dayTypes: string }>(
    env.DB,
    "select id,day_types as dayTypes from dining_schedules where valid_from<=? and valid_to>=? order by updated_at desc,id",
    [date, date],
  );
  let arrangement: { scheduleId: string; floors: Array<{ floorId: string; noBreakfast: boolean }> } | null = null;
  for (const schedule of schedules) {
    let types: unknown;
    try { types = JSON.parse(schedule.dayTypes); } catch { continue; }
    if (!Array.isArray(types) || !types.includes(dayType)) continue;
    const floors = await all<{ floorId: string; noBreakfast: number }>(
      env.DB,
      "select floor_id as floorId,no_breakfast as noBreakfast from dining_schedule_floors where schedule_id=?",
      [schedule.id],
    );
    arrangement = {
      scheduleId: schedule.id,
      floors: floors.map((floor) => ({ floorId: floor.floorId, noBreakfast: floor.noBreakfast === 1 })),
    };
    break;
  }
  return json({ date, dayType, mealPeriods, arrangement }, { headers: { "cache-control": "public, max-age=30" } });
}

/**
 * GET /api/public/merchant-status — 商户营业状态的实时读端（facility-status 的商户版）。
 *
 * 暂停营业（temporarily_closed）必须立刻对用户生效，而 release 快照里商户没有
 * lifecycle 字段（加进 manifest 会破坏已发布小程序的 exactObject 白名单），所以走
 * 实时通道。retired（关店）不下发：关店改变的是商户清单本身，随下一次 release 生效；
 * 实时通道只承载不变清单、只变状态的 temporarily_closed。
 */
export async function publicMerchantStatus(env: Env): Promise<Response> {
  const rows = await all<{ id: string; lifecycleStatus: string }>(
    env.DB,
    "select id,lifecycle_status as lifecycleStatus from merchant_outlets where lifecycle_status<>'retired'",
  );
  const statuses: Record<string, string> = {};
  for (const row of rows) statuses[row.id] = row.lifecycleStatus;
  return json({ statuses }, { headers: { "cache-control": "public, max-age=30" } });
}

// ---------------------------------------------------------------------------
// 管理端：校历
// ---------------------------------------------------------------------------

export async function listAcademicYears(env: Env): Promise<Response> {
  const [years, terms, dates] = await Promise.all([
    all<{ id: string; name: string }>(env.DB, "select id,name from academic_years order by name desc"),
    all<{ id: string; yearId: string; name: string; dayType: string; validFrom: string; validTo: string; sortOrder: number }>(
      env.DB,
      "select id,year_id as yearId,name,day_type as dayType,valid_from as validFrom,valid_to as validTo,sort_order as sortOrder from academic_terms order by sort_order,id",
    ),
    all<{ yearId: string; serviceDate: string; kind: string }>(
      env.DB,
      "select year_id as yearId,service_date as serviceDate,kind from academic_dates order by service_date",
    ),
  ]);
  return json({
    items: years.map((year) => ({
      ...year,
      terms: terms.filter((term) => term.yearId === year.id),
      dates: dates.filter((date) => date.yearId === year.id),
    })),
  });
}

interface TermInput { name: string; dayType: string; validFrom: string; validTo: string; sortOrder: number }
interface DateInput { serviceDate: string; kind: string }

function termInputs(value: unknown): TermInput[] {
  if (!Array.isArray(value)) throw new HttpError(400, "validation_error", "terms must be an array");
  return value.map((raw, index) => {
    const row = exactObject(raw, `terms[${index}]`, ["name", "dayType", "validFrom", "validTo"], ["sortOrder"]);
    const term: TermInput = {
      name: nameValue(row.name, `terms[${index}].name`),
      dayType: oneOf(row.dayType, `terms[${index}].dayType`, TERM_DAY_TYPES),
      validFrom: dateValue(row.validFrom, `terms[${index}].validFrom`),
      validTo: dateValue(row.validTo, `terms[${index}].validTo`),
      sortOrder: typeof row.sortOrder === "number" && Number.isInteger(row.sortOrder) ? row.sortOrder : (index + 1) * 10,
    };
    if (term.validFrom > term.validTo) throw new HttpError(400, "validation_error", `terms[${index}] validFrom must not exceed validTo`);
    return term;
  });
}

function dateInputs(value: unknown): DateInput[] {
  if (!Array.isArray(value)) throw new HttpError(400, "validation_error", "dates must be an array");
  const dates: DateInput[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const row = exactObject(raw, `dates[${index}]`, ["serviceDate", "kind"]);
    const date: DateInput = {
      serviceDate: dateValue(row.serviceDate, `dates[${index}].serviceDate`),
      kind: oneOf(row.kind, `dates[${index}].kind`, DATE_KINDS),
    };
    const key = `${date.serviceDate}:${date.kind}`;
    if (seen.has(key)) continue; // 同学年同日同 kind 有 unique 约束，重复去重避免落 500
    seen.add(key);
    dates.push(date);
  }
  return dates;
}

async function replaceYearRows(env: Env, yearId: string, terms: TermInput[], dates: DateInput[]) {
  const statements = [
    env.DB.prepare("delete from academic_terms where year_id=?").bind(yearId),
    env.DB.prepare("delete from academic_dates where year_id=?").bind(yearId),
    ...terms.map((term) =>
      env.DB.prepare("insert into academic_terms(id,year_id,name,day_type,valid_from,valid_to,sort_order) values(?,?,?,?,?,?,?)")
        .bind(makeId("aterm"), yearId, term.name, term.dayType, term.validFrom, term.validTo, term.sortOrder),
    ),
    ...dates.map((date) =>
      env.DB.prepare("insert into academic_dates(id,year_id,service_date,kind) values(?,?,?,?)")
        .bind(makeId("adate"), yearId, date.serviceDate, date.kind),
    ),
  ];
  await env.DB.batch(statements);
}

export async function createAcademicYear(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "academicYear", ["name", "terms", "dates"]);
  const name = nameValue(body.name, "name");
  const terms = termInputs(body.terms);
  const dates = dateInputs(body.dates ?? []);
  // name 有 unique 约束；撞名时给可读的 409 而不是约束错误落 500
  const duplicate = await first<{ id: string }>(env.DB, "select id from academic_years where name=?", [name]);
  if (duplicate) throw new HttpError(409, "academic_year_exists", "同名学年已存在");
  const id = makeId("ay");
  const now = isoNow();
  await env.DB.prepare("insert into academic_years(id,name,created_at,updated_at) values(?,?,?,?)").bind(id, name, now, now).run();
  await replaceYearRows(env, id, terms, dates);
  await audit(env, principal, "academic_year.create", "academic_year", id, requestId, null, { name, terms, dates });
  return json({ id, name }, { status: 201 });
}

export async function updateAcademicYear(request: Request, env: Env, principal: SessionPrincipal, yearId: string, requestId: string): Promise<Response> {
  const before = await first<{ id: string; name: string }>(env.DB, "select id,name from academic_years where id=?", [yearId]);
  if (!before) throw new HttpError(404, "not_found", "Academic year does not exist");
  const body = exactObject(await readJson<unknown>(request), "academicYear", ["name", "terms", "dates"]);
  const name = nameValue(body.name, "name");
  const terms = termInputs(body.terms);
  const dates = dateInputs(body.dates ?? []);
  const duplicate = await first<{ id: string }>(env.DB, "select id from academic_years where name=? and id<>?", [name, yearId]);
  if (duplicate) throw new HttpError(409, "academic_year_exists", "同名学年已存在");
  await env.DB.prepare("update academic_years set name=?,updated_at=? where id=?").bind(name, isoNow(), yearId).run();
  await replaceYearRows(env, yearId, terms, dates);
  await audit(env, principal, "academic_year.update", "academic_year", yearId, requestId, before, { name, terms, dates });
  return json({ id: yearId, name });
}

/**
 * 删除保护：今天落在该学年的任一区间（学期/假期）或逐日特殊日期（节假日/调休）
 * 里时不可删——删掉后今天的日型判定会退化成纯星期判断。校车服务日历只是班次
 * 调度规则、不经校历解析，删除学年不影响它，无需额外保护。
 */
export async function deleteAcademicYear(env: Env, principal: SessionPrincipal, yearId: string, requestId: string): Promise<Response> {
  const before = await first<{ id: string; name: string }>(env.DB, "select id,name from academic_years where id=?", [yearId]);
  if (!before) throw new HttpError(404, "not_found", "Academic year does not exist");
  const today = shanghaiToday();
  const covering = await first<{ id: string }>(
    env.DB,
    "select id from academic_terms where year_id=? and valid_from<=? and valid_to>=? limit 1",
    [yearId, today, today],
  );
  const coveringDate = await first<{ id: string }>(
    env.DB,
    "select id from academic_dates where year_id=? and service_date=? limit 1",
    [yearId, today],
  );
  if (covering || coveringDate) throw new HttpError(409, "academic_year_current", "当前学年不可删除");
  await env.DB.batch([
    env.DB.prepare("delete from academic_terms where year_id=?").bind(yearId),
    env.DB.prepare("delete from academic_dates where year_id=?").bind(yearId),
    env.DB.prepare("delete from academic_years where id=?").bind(yearId),
  ]);
  await audit(env, principal, "academic_year.delete", "academic_year", yearId, requestId, before, null);
  return noContent();
}

// ---------------------------------------------------------------------------
// 管理端：供餐时段 + 开放安排
// ---------------------------------------------------------------------------

/** 管理端「就餐安排」页的聚合读端：时段表 + 全部安排（含楼层清单）。 */
export async function listDiningAdmin(env: Env): Promise<Response> {
  const [mealPeriods, schedules, floors] = await Promise.all([
    all(env.DB, "select id,meal,start_time as startTime,end_time as endTime,sort_order as sortOrder from dining_meal_periods order by sort_order,id"),
    all<{ id: string; validFrom: string; validTo: string; dayTypes: string; updatedAt: string }>(
      env.DB,
      "select id,valid_from as validFrom,valid_to as validTo,day_types as dayTypes,updated_at as updatedAt from dining_schedules order by valid_from desc,id",
    ),
    all<{ scheduleId: string; floorId: string; noBreakfast: number }>(
      env.DB,
      "select schedule_id as scheduleId,floor_id as floorId,no_breakfast as noBreakfast from dining_schedule_floors",
    ),
  ]);
  return json({
    mealPeriods,
    schedules: schedules.map((schedule) => ({
      ...schedule,
      dayTypes: JSON.parse(schedule.dayTypes) as string[],
      floors: floors
        .filter((floor) => floor.scheduleId === schedule.id)
        .map((floor) => ({ floorId: floor.floorId, noBreakfast: floor.noBreakfast === 1 })),
    })),
  });
}

interface PeriodInput { meal: string; startTime: string; endTime: string; sortOrder: number }

/** 整表替换时段表（A17 的表格编辑器一次保存）。 */
export async function replaceMealPeriods(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const body = exactObject(await readJson<unknown>(request), "mealPeriods", ["periods"]);
  if (!Array.isArray(body.periods)) throw new HttpError(400, "validation_error", "periods must be an array");
  const periods: PeriodInput[] = body.periods.map((raw, index) => {
    const row = exactObject(raw, `periods[${index}]`, ["meal", "startTime", "endTime"], ["sortOrder"]);
    const period: PeriodInput = {
      meal: oneOf(row.meal, `periods[${index}].meal`, MEALS),
      startTime: timeValue(row.startTime, `periods[${index}].startTime`),
      endTime: timeValue(row.endTime, `periods[${index}].endTime`),
      sortOrder: typeof row.sortOrder === "number" && Number.isInteger(row.sortOrder) ? row.sortOrder : (index + 1) * 10,
    };
    if (period.startTime >= period.endTime) throw new HttpError(400, "validation_error", `periods[${index}] startTime must be before endTime`);
    return period;
  });
  const statements = [env.DB.prepare("delete from dining_meal_periods")];
  for (const period of periods) {
    statements.push(
      env.DB.prepare("insert into dining_meal_periods(id,meal,start_time,end_time,sort_order) values(?,?,?,?,?)")
        .bind(makeId("dmp"), period.meal, period.startTime, period.endTime, period.sortOrder),
    );
  }
  await env.DB.batch(statements);
  await audit(env, principal, "dining.meal_periods.replace", "dining_meal_periods", "*", requestId, null, { periods });
  return json({ count: periods.length });
}

interface ScheduleFloorInput { floorId: string; noBreakfast: boolean }

async function scheduleInputs(request: Request): Promise<{ validFrom: string; validTo: string; dayTypes: CampusDayType[]; floors: ScheduleFloorInput[] }> {
  const body = exactObject(await readJson<unknown>(request), "diningSchedule", ["validFrom", "validTo", "dayTypes", "floors"]);
  const validFrom = dateValue(body.validFrom, "validFrom");
  const validTo = dateValue(body.validTo, "validTo");
  if (validFrom > validTo) throw new HttpError(400, "validation_error", "validFrom must not exceed validTo");
  const dayTypes = dayTypeSet(body.dayTypes, "dayTypes");
  if (!Array.isArray(body.floors)) throw new HttpError(400, "validation_error", "floors must be an array");
  const floors: ScheduleFloorInput[] = [];
  const seenFloors = new Set<string>();
  for (const [index, raw] of body.floors.entries()) {
    const row = exactObject(raw, `floors[${index}]`, ["floorId"], ["noBreakfast"]);
    if (typeof row.floorId !== "string" || !row.floorId) throw new HttpError(400, "validation_error", `floors[${index}].floorId is required`);
    if (seenFloors.has(row.floorId)) continue; // 重复楼层去重，避免 PK 冲突落 500
    seenFloors.add(row.floorId);
    floors.push({ floorId: row.floorId, noBreakfast: row.noBreakfast === true });
  }
  return { validFrom, validTo, dayTypes, floors };
}

async function writeScheduleFloors(env: Env, scheduleId: string, floors: ScheduleFloorInput[]) {
  for (const floor of floors) await assertExists(env.DB, "floors", floor.floorId, "Floor");
  const statements = [env.DB.prepare("delete from dining_schedule_floors where schedule_id=?").bind(scheduleId)];
  for (const floor of floors) {
    statements.push(
      env.DB.prepare("insert into dining_schedule_floors(schedule_id,floor_id,no_breakfast) values(?,?,?)")
        .bind(scheduleId, floor.floorId, floor.noBreakfast ? 1 : 0),
    );
  }
  await env.DB.batch(statements);
}

export async function createDiningSchedule(request: Request, env: Env, principal: SessionPrincipal, requestId: string): Promise<Response> {
  const input = await scheduleInputs(request);
  const id = makeId("dsched");
  const now = isoNow();
  await env.DB.prepare("insert into dining_schedules(id,valid_from,valid_to,day_types,created_by,created_at,updated_at) values(?,?,?,?,?,?,?)")
    .bind(id, input.validFrom, input.validTo, jsonString(input.dayTypes), principal.userId, now, now).run();
  await writeScheduleFloors(env, id, input.floors);
  await audit(env, principal, "dining_schedule.create", "dining_schedule", id, requestId, null, input);
  return json({ id }, { status: 201 });
}

export async function updateDiningSchedule(request: Request, env: Env, principal: SessionPrincipal, scheduleId: string, requestId: string): Promise<Response> {
  const before = await first<{ id: string }>(env.DB, "select id from dining_schedules where id=?", [scheduleId]);
  if (!before) throw new HttpError(404, "not_found", "Dining schedule does not exist");
  const input = await scheduleInputs(request);
  await env.DB.prepare("update dining_schedules set valid_from=?,valid_to=?,day_types=?,updated_at=? where id=?")
    .bind(input.validFrom, input.validTo, jsonString(input.dayTypes), isoNow(), scheduleId).run();
  await writeScheduleFloors(env, scheduleId, input.floors);
  await audit(env, principal, "dining_schedule.update", "dining_schedule", scheduleId, requestId, before, input);
  return json({ id: scheduleId });
}

export async function deleteDiningSchedule(env: Env, principal: SessionPrincipal, scheduleId: string, requestId: string): Promise<Response> {
  const before = await first<{ id: string }>(env.DB, "select id from dining_schedules where id=?", [scheduleId]);
  if (!before) throw new HttpError(404, "not_found", "Dining schedule does not exist");
  await env.DB.batch([
    env.DB.prepare("delete from dining_schedule_floors where schedule_id=?").bind(scheduleId),
    env.DB.prepare("delete from dining_schedules where id=?").bind(scheduleId),
  ]);
  await audit(env, principal, "dining_schedule.delete", "dining_schedule", scheduleId, requestId, before, null);
  return noContent();
}

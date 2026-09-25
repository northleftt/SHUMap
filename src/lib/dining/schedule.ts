// 就餐前台纯逻辑：实时接口（dining/schedule、merchant-status）的响应解析、
// 供餐时段计算、楼层开放状态聚合、校区排序与 release 派生的食堂视图模型。
//
// 本模块只允许 type-only 外部依赖（tests/dining-frontend.test.mjs 直接拷贝成
// .mts 用 node:test 跑，运行时 import 会解析不到）。校验风格与
// src/lib/release/mapData.ts 的 contractError 一致：契约不符直接抛，不猜。

import type { PublicDayType, ReleaseManifest } from "../api/types";
import type { CampusConfig, CampusKey, MerchantSummary } from "../types";

// ---------------------------------------------------------------------------
// 实时接口契约（worker/modules/dining.ts，勿改 worker）
// ---------------------------------------------------------------------------

export type DiningMeal = "breakfast" | "lunner" | "latenight";
const MEALS: readonly DiningMeal[] = ["breakfast", "lunner", "latenight"];

export type MerchantLifecycle = "planned" | "active" | "temporarily_closed" | "retired";
const MERCHANT_LIFECYCLES: readonly MerchantLifecycle[] = ["planned", "active", "temporarily_closed", "retired"];

const DAY_TYPES: readonly PublicDayType[] = ["weekday", "weekend", "holiday", "winter_break", "summer_break"];

export interface DiningMealPeriod {
  meal: DiningMeal;
  startTime: string;
  endTime: string;
  sortOrder: number;
}

export interface DiningArrangement {
  scheduleId: string;
  floors: Array<{ floorId: string; noBreakfast: boolean }>;
}

export interface DiningScheduleResponse {
  date: string;
  dayType: PublicDayType;
  mealPeriods: DiningMealPeriod[];
  arrangement: DiningArrangement | null;
}

export interface MerchantStatusResponse {
  statuses: Record<string, MerchantLifecycle>;
}

function contractError(message: string): Error {
  return new Error(`Dining data contract violation: ${message}`);
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function timeString(value: unknown, field: string): string {
  if (typeof value !== "string" || !TIME_RE.test(value)) {
    throw contractError(`${field} must be HH:MM`);
  }
  return value;
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseDiningScheduleResponse(value: unknown): DiningScheduleResponse {
  const root = objectAt(value, "dining/schedule response");
  if (typeof root.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(root.date)) {
    throw contractError("date must be YYYY-MM-DD");
  }
  if (typeof root.dayType !== "string" || !(DAY_TYPES as readonly string[]).includes(root.dayType)) {
    throw contractError(`unsupported dayType ${JSON.stringify(root.dayType)}`);
  }
  if (!Array.isArray(root.mealPeriods)) throw contractError("mealPeriods must be an array");
  const mealPeriods = root.mealPeriods.map((item, index) => {
    const row = objectAt(item, `mealPeriods[${index}]`);
    if (typeof row.meal !== "string" || !(MEALS as readonly string[]).includes(row.meal)) {
      throw contractError(`mealPeriods[${index}].meal must be one of ${MEALS.join("/")}`);
    }
    if (typeof row.sortOrder !== "number" || !Number.isFinite(row.sortOrder)) {
      throw contractError(`mealPeriods[${index}].sortOrder must be a number`);
    }
    return {
      meal: row.meal as DiningMeal,
      startTime: timeString(row.startTime, `mealPeriods[${index}].startTime`),
      endTime: timeString(row.endTime, `mealPeriods[${index}].endTime`),
      sortOrder: row.sortOrder,
    };
  });
  let arrangement: DiningArrangement | null = null;
  if (root.arrangement !== null && root.arrangement !== undefined) {
    const raw = objectAt(root.arrangement, "arrangement");
    if (typeof raw.scheduleId !== "string" || !raw.scheduleId) {
      throw contractError("arrangement.scheduleId must be a non-empty string");
    }
    if (!Array.isArray(raw.floors)) throw contractError("arrangement.floors must be an array");
    arrangement = {
      scheduleId: raw.scheduleId,
      floors: raw.floors.map((item, index) => {
        const row = objectAt(item, `arrangement.floors[${index}]`);
        if (typeof row.floorId !== "string" || !row.floorId) {
          throw contractError(`arrangement.floors[${index}].floorId must be a non-empty string`);
        }
        if (typeof row.noBreakfast !== "boolean") {
          throw contractError(`arrangement.floors[${index}].noBreakfast must be a boolean`);
        }
        return { floorId: row.floorId, noBreakfast: row.noBreakfast };
      }),
    };
  }
  return { date: root.date, dayType: root.dayType as PublicDayType, mealPeriods, arrangement };
}

export function parseMerchantStatusResponse(value: unknown): MerchantStatusResponse {
  const root = objectAt(value, "merchant-status response");
  const raw = objectAt(root.statuses, "merchant-status statuses");
  const statuses: Record<string, MerchantLifecycle> = {};
  for (const [id, status] of Object.entries(raw)) {
    if (typeof status !== "string" || !(MERCHANT_LIFECYCLES as readonly string[]).includes(status)) {
      throw contractError(`statuses[${id}] must be one of ${MERCHANT_LIFECYCLES.join("/")}`);
    }
    statuses[id] = status as MerchantLifecycle;
  }
  return { statuses };
}

// ---------------------------------------------------------------------------
// 时刻与时段
// ---------------------------------------------------------------------------

/** 餐别中文名（餐别词汇：早餐 / 午晚餐 / 夜宵）。 */
export const MEAL_LABELS: Record<DiningMeal, string> = {
  breakfast: "早餐",
  lunner: "午晚餐",
  latenight: "夜宵",
};

/** 日型中文名（时段条后缀、安排 banner 共用）。 */
export const DAY_TYPE_LABELS: Record<PublicDayType, string> = {
  weekday: "工作日",
  weekend: "周末",
  holiday: "节假日",
  winter_break: "寒假",
  summer_break: "暑假",
};

export function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** 上海时区的今天（与 worker shanghaiToday 同口径，不受设备时区影响）。 */
export function shanghaiToday(now: number = Date.now()): string {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

/** 当前时刻的上海时区分钟数（时段计算与 worker 的 Asia/Shanghai 口径一致）。 */
export function shanghaiMinutes(now: number = Date.now()): number {
  const text = new Date(now).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return minutesOf(text);
}

function sortedPeriods(periods: readonly DiningMealPeriod[]): DiningMealPeriod[] {
  return [...periods].sort(
    (a, b) => minutesOf(a.startTime) - minutesOf(b.startTime) || a.sortOrder - b.sortOrder,
  );
}

/**
 * 时段条用的餐段名：lunner 分午餐/晚餐两段（11:00–13:00 / 16:40–18:30），
 * 按开始时刻区分（15:00 前为午餐）。
 */
export function segmentMealName(period: DiningMealPeriod): string {
  if (period.meal === "lunner") return period.startTime < "15:00" ? "午餐" : "晚餐";
  return MEAL_LABELS[period.meal];
}

export type MealNow =
  | { kind: "serving"; period: DiningMealPeriod }
  | { kind: "break"; previous: DiningMealPeriod | null; next: DiningMealPeriod }
  | { kind: "ended" };

/** 由供餐时段表 + 当前时刻算「现在在哪个餐段 / 下一段几点开始」。 */
export function mealNow(periods: readonly DiningMealPeriod[], nowMinutes: number): MealNow {
  const sorted = sortedPeriods(periods);
  for (const period of sorted) {
    if (minutesOf(period.startTime) <= nowMinutes && nowMinutes < minutesOf(period.endTime)) {
      return { kind: "serving", period };
    }
  }
  const nextIndex = sorted.findIndex((period) => minutesOf(period.startTime) > nowMinutes);
  if (nextIndex >= 0) {
    return { kind: "break", previous: nextIndex > 0 ? sorted[nextIndex - 1] : null, next: sorted[nextIndex] };
  }
  return { kind: "ended" };
}

/**
 * 顶部时段条文案（纯文字）：
 * 「当前：午餐时段（至 13:00）」/「当前：午休中 · 晚餐 16:40 开始」/「当前：今日供餐已结束」。
 * 有开放安排命中时加「· 周末营业安排」类后缀（工作日例外安排同样标注）。
 */
export function periodBarText(schedule: DiningScheduleResponse, nowMinutes: number): string {
  const state = mealNow(schedule.mealPeriods, nowMinutes);
  let text: string;
  if (state.kind === "serving") {
    text = `当前：${segmentMealName(state.period)}时段（至 ${state.period.endTime}）`;
  } else if (state.kind === "break") {
    const isLunchBreak = state.previous !== null
      && segmentMealName(state.previous) === "午餐"
      && segmentMealName(state.next) === "晚餐";
    text = `当前：${isLunchBreak ? "午休中" : "供餐间歇"} · ${segmentMealName(state.next)} ${state.next.startTime} 开始`;
  } else {
    text = "当前：今日供餐已结束";
  }
  if (schedule.arrangement) {
    text += ` · ${DAY_TYPE_LABELS[schedule.dayType]}营业安排`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// 楼层开放状态
// ---------------------------------------------------------------------------

export type FloorOpenStatus =
  | { kind: "open" }
  /** 「今日休息」（灰）：整楼关闭，或开放安排白名单未命中。 */
  | { kind: "rest" }
  /** 「晚餐 16:40 开」类（灰）：当前时刻该层不供餐，但今天还有它的餐段。 */
  | { kind: "upcoming"; meal: string; startTime: string };

/**
 * 楼层行状态聚合。规则：
 * - 整楼关闭（place lifecycle 非 active）→ 今日休息；
 * - 有开放安排命中当天（不论日型）→ 按白名单：未命中 → 今日休息，命中但
 *   noBreakfast 时当天早餐段不算该层供餐。工作日的安排就是「例外覆盖默认全开」
 *   的通道（台风/维修等），与周末/假日安排同一机制；
 * - 无安排：工作日默认全开；周末/假日按未命中兜底（页面级空态「暂无安排信息」
 *   会先兜住，真走到这里也不猜）；
 * - 其余按「该层 meals ∩ 餐段」判定：在餐段内 = 正常（不标注），
 *   今天还有它的餐段 = 「X餐 HH:MM 开」，今天已没有 = 今日休息。
 */
export function floorOpenStatus(input: {
  dayType: PublicDayType;
  arrangement: DiningArrangement | null;
  floorId: string;
  meals: readonly DiningMeal[];
  periods: readonly DiningMealPeriod[];
  nowMinutes: number;
  placeClosed: boolean;
}): FloorOpenStatus {
  if (input.placeClosed) return { kind: "rest" };
  let meals = input.meals;
  if (input.arrangement) {
    const entry = input.arrangement.floors.find((floor) => floor.floorId === input.floorId) ?? null;
    if (!entry) return { kind: "rest" };
    if (entry.noBreakfast) meals = meals.filter((meal) => meal !== "breakfast");
  } else if (input.dayType !== "weekday") {
    return { kind: "rest" };
  }
  const segments = sortedPeriods(input.periods).filter((period) => meals.includes(period.meal));
  for (const period of segments) {
    if (minutesOf(period.startTime) <= input.nowMinutes && input.nowMinutes < minutesOf(period.endTime)) {
      return { kind: "open" };
    }
  }
  const next = segments.find((period) => minutesOf(period.startTime) > input.nowMinutes);
  if (next) return { kind: "upcoming", meal: segmentMealName(next), startTime: next.startTime };
  return { kind: "rest" };
}

export function floorStatusLabel(status: FloorOpenStatus): string | null {
  if (status.kind === "open") return null;
  if (status.kind === "rest") return "今日休息";
  return `${status.meal} ${status.startTime} 开`;
}

// ---------------------------------------------------------------------------
// 校区排序
// ---------------------------------------------------------------------------

/** 未定位时的校区默认顺序：宝山 → 嘉定 → 延长。 */
export const CAMPUS_FALLBACK_ORDER: readonly CampusKey[] = ["baoshan", "jiading", "yanchang"];

/** 定位所在校区排第一，其余按默认顺序；未知 key 排在最后且保持原顺序。 */
export function orderCampusKeys(keys: readonly CampusKey[], located: CampusKey | null): CampusKey[] {
  const first = located !== null && keys.includes(located) ? [located] : [];
  const ordered = CAMPUS_FALLBACK_ORDER.filter((key) => key !== located && keys.includes(key));
  const extra = keys.filter((key) => !CAMPUS_FALLBACK_ORDER.includes(key) && key !== located);
  return [...first, ...ordered, ...extra];
}

// ---------------------------------------------------------------------------
// release 派生：食堂视图模型
// ---------------------------------------------------------------------------

/** place content 的 dining.floors 条目（楼层供餐：餐别 + 品类标签）。 */
export interface FloorDiningInfo {
  levelCode: string;
  meals: DiningMeal[];
  stallTypes: string[];
}

/**
 * 解析 place content.dining（可选）：{ floors: [{ levelCode, meals, stallTypes }] }。
 * 没有 dining 数据返回 []，由调用方给默认值；形状不符抛契约错误。
 */
export function parsePlaceDining(placeId: string, content: Record<string, unknown>): FloorDiningInfo[] {
  const raw = content.dining;
  if (raw === undefined || raw === null) return [];
  const dining = objectAt(raw, `place ${placeId} content.dining`);
  if (dining.floors === undefined) return [];
  if (!Array.isArray(dining.floors)) {
    throw contractError(`place ${placeId} content.dining.floors must be an array`);
  }
  return dining.floors.map((item, index) => {
    const row = objectAt(item, `place ${placeId} dining.floors[${index}]`);
    if (typeof row.levelCode !== "string" || !row.levelCode.trim()) {
      throw contractError(`place ${placeId} dining.floors[${index}].levelCode must be a non-empty string`);
    }
    if (!Array.isArray(row.meals)) {
      throw contractError(`place ${placeId} dining.floors[${index}].meals must be an array`);
    }
    const meals = row.meals.map((meal, mealIndex) => {
      if (typeof meal !== "string" || !(MEALS as readonly string[]).includes(meal)) {
        throw contractError(
          `place ${placeId} dining.floors[${index}].meals[${mealIndex}] must be one of ${MEALS.join("/")}`,
        );
      }
      return meal as DiningMeal;
    });
    if (!Array.isArray(row.stallTypes)) {
      throw contractError(`place ${placeId} dining.floors[${index}].stallTypes must be an array`);
    }
    const stallTypes = row.stallTypes.map((stall, stallIndex) => {
      if (typeof stall !== "string") {
        throw contractError(`place ${placeId} dining.floors[${index}].stallTypes[${stallIndex}] must be a string`);
      }
      return stall.trim();
    }).filter((stall) => stall.length > 0);
    return { levelCode: row.levelCode.trim(), meals, stallTypes };
  });
}

/** 楼层实拍：canonical detail.media 按 floorLevelCode 过滤（同 FloorsPage 逻辑）。 */
export function floorMediaOf(placeId: string, content: Record<string, unknown>, levelCode: string): string[] {
  const detail = objectAt(content.detail, `place ${placeId} content.detail`);
  if (!Array.isArray(detail.media)) throw contractError(`place ${placeId} detail.media must be an array`);
  const urls: string[] = [];
  for (const [index, item] of detail.media.entries()) {
    const row = objectAt(item, `place ${placeId} detail.media[${index}]`);
    if (typeof row.url !== "string" || !row.url.trim()) {
      throw contractError(`place ${placeId} detail.media[${index}].url must be a non-empty string`);
    }
    if (row.floorLevelCode !== undefined && typeof row.floorLevelCode !== "string") {
      throw contractError(`place ${placeId} detail.media[${index}].floorLevelCode must be a string`);
    }
    if (row.floorLevelCode === levelCode) urls.push(row.url);
  }
  return urls;
}

/** 楼层号短标签（楼层块用）：F1 → 1F，B1 → B1，其他原样展示。 */
export function levelShortLabel(levelCode: string): string {
  const normalized = levelCode.trim().toUpperCase();
  const floor = /^F(\d+)$/.exec(normalized);
  if (floor) return `${floor[1]}F`;
  const basement = /^B(\d+)$/.exec(normalized);
  if (basement) return `B${basement[1]}`;
  return levelCode;
}

/** 无 dining 数据的楼层默认早餐 + 午晚餐都供。 */
export const DEFAULT_FLOOR_MEALS: readonly DiningMeal[] = ["breakfast", "lunner"];

export interface DiningFloorView {
  floorId: string;
  levelCode: string;
  levelOrder: number;
  displayName: string;
  imageUrl: string | null;
  meals: DiningMeal[];
  stallTypes: string[];
  merchants: MerchantSummary[];
}

export interface CanteenView {
  placeId: string;
  name: string;
  campusKey: CampusKey;
  campusLabel: string;
  /** 整楼关闭（place lifecycle 非 active），页面按整楼休息态渲染。 */
  closed: boolean;
  content: Record<string, unknown>;
  floors: DiningFloorView[];
}

/**
 * 就餐页的食堂清单：release 里 kindId === 'canteen' 的楼宇（retired 不进 release）。
 * 楼层骨架取 manifest.floors，供餐数据取 place content.dining，商家按 floorId 归层。
 */
export function buildCanteens(
  manifest: ReleaseManifest,
  campuses: CampusConfig[],
  merchantsByPlace: ReadonlyMap<string, MerchantSummary[]>,
): CanteenView[] {
  const campusById = new Map(campuses.map((campus) => [campus.id, campus]));
  return manifest.places
    .filter((place) => place.kindId === "canteen")
    .map((place) => {
      const campus = place.campusId ? campusById.get(place.campusId) : undefined;
      if (!campus) {
        throw contractError(`canteen ${place.id} does not identify a released campus`);
      }
      const diningByLevel = new Map(
        parsePlaceDining(place.id, place.content).map((info) => [info.levelCode, info]),
      );
      const merchants = merchantsByPlace.get(place.id) ?? [];
      const floors = manifest.floors
        .filter((floor) => floor.buildingPlaceId === place.id && floor.isPublic !== 0)
        .sort((a, b) => a.levelOrder - b.levelOrder)
        .map((floor) => {
          const dining = diningByLevel.get(floor.levelCode);
          return {
            floorId: floor.id,
            levelCode: floor.levelCode,
            levelOrder: floor.levelOrder,
            displayName: floor.displayName,
            imageUrl: floor.imageUrl,
            meals: dining ? dining.meals : [...DEFAULT_FLOOR_MEALS],
            stallTypes: dining ? dining.stallTypes : [],
            merchants: merchants.filter((merchant) => merchant.floorId === floor.id),
          };
        });
      return {
        placeId: place.id,
        name: place.displayName,
        campusKey: campus.key,
        campusLabel: campus.label,
        closed: place.lifecycleStatus !== "active",
        content: place.content,
        floors,
      };
    });
}

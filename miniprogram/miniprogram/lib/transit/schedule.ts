// 校车时刻表逻辑。搬运自 Web 端 src/lib/transit/schedule.ts：
// 纯函数（日期分桶、班次合并、倒计时）逐行保留；
// 网络层从 publicApi 换成 lib/api 的 apiGet，并增加包内快照兜底。
//
// 数据双通道：优先 GET /api/public/transit/journeys（班次为实时数据），
// 失败/离线时降级到打包进包内的 data/shuttle-schedule 快照（Ver2025.11）。
// 站点身份来自 release manifest；manifest 也取不到时退化为快照里的校区名。
// 注：数据文件是 .ts 模块（原 .json 内容原样 export default）——小程序编译器
// 只把源码文件打包成可 require 的模块，直接 require .json 会在运行时报模块未定义。

import { apiGet } from "../api";
import academicCalendarData from "../../data/academic-calendar";
import shuttleSnapshot from "../../data/shuttle-schedule";
import type {
  Journey,
  JourneysResponse,
  ReleaseTransitManifest,
  ReleaseNavigationLocation,
  TransitStop,
  TripStop,
  TripStopsResponse,
} from "./types";

export function navigationPointForStop(
  stop: TransitStop,
  locations: ReleaseNavigationLocation[],
): TransitStop["navigationPoint"] {
  const location = locations.find((item) =>
    item.role === "navigation_target"
    && item.isPrimary === 1
    && (
      (item.entityType === "transit_stop" && item.entityId === stop.id)
      || (Boolean(stop.place_id) && item.entityType === "place" && item.entityId === stop.place_id)
    ),
  );
  if (!location || location.geometry_type !== "Point" || location.crs !== "GCJ02" || !location.geometry_json) {
    return null;
  }
  try {
    const geometry = JSON.parse(location.geometry_json) as { type?: unknown; coordinates?: unknown };
    if (
      geometry.type !== "Point"
      || !Array.isArray(geometry.coordinates)
      || geometry.coordinates.length !== 2
      || geometry.coordinates.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) return null;
    const [longitude, latitude] = geometry.coordinates as number[];
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
    return { longitude, latitude, displayName: location.location_hint || stop.name };
  } catch {
    return null;
  }
}

export type DateBucket = "weekday" | "weekend" | "holiday" | "winterBreak" | "summerBreak";

/** 班次数据来源：实时接口或包内快照。 */
export type ScheduleSource = "api" | "snapshot";

export interface ScheduleItem {
  /** Stable trip identity from the backend. 快照模式下为 `snapshot:` 前缀的合成 id。 */
  tripId: string;
  routeName: string;
  departureTime: string;
  /** null when the source only carries departure times (current data). */
  arrivalTime: string | null;
  isReservation: boolean;
  bookingPolicy: string;
  bookingUrl: string | null;
  /** Stop sequence range within the trip's pattern (for M7 下车点列表)。 */
  fromSequence: number;
  toSequence: number;
}

// ---------------------------------------------------------------------------
// Date helpers (display + bucket label only; schedule resolution is server-side)
// ---------------------------------------------------------------------------

interface DateRange {
  start: string;
  end: string;
}

interface AcademicYear {
  id: string;
  firstSemester: DateRange;
  winterBreak: DateRange;
  secondSemester: DateRange;
  summerBreak: DateRange;
  holidayDates: string[];
  workdayOverrideDates?: string[];
}

const academicCalendar = academicCalendarData as { academicYears: AcademicYear[] };

export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isDateInRange(dateKey: string, range: DateRange): boolean {
  return dateKey >= range.start && dateKey <= range.end;
}

function findAcademicYear(dateKey: string): AcademicYear | undefined {
  return academicCalendar.academicYears.find((year) => {
    const ranges = [year.firstSemester, year.winterBreak, year.secondSemester, year.summerBreak];
    return (
      ranges.some((range) => isDateInRange(dateKey, range)) ||
      year.holidayDates.includes(dateKey) ||
      year.workdayOverrideDates?.includes(dateKey)
    );
  });
}

export function getCurrentDateBucket(date: Date = new Date()): DateBucket {
  const dateKey = toDateKey(date);
  const academicYear = findAcademicYear(dateKey);

  if (academicYear) {
    if (academicYear.holidayDates.includes(dateKey)) return "holiday";
    if (isDateInRange(dateKey, academicYear.winterBreak)) return "winterBreak";
    if (isDateInRange(dateKey, academicYear.summerBreak)) return "summerBreak";
    if (academicYear.workdayOverrideDates?.includes(dateKey)) return "weekday";
  }

  return date.getDay() === 0 || date.getDay() === 6 ? "weekend" : "weekday";
}

export const BUCKET_LABELS: Record<DateBucket, string> = {
  weekday: "工作日",
  weekend: "周末",
  holiday: "假日",
  winterBreak: "寒假",
  summerBreak: "暑假",
};

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function formatDate(date: Date): { month: number; day: number; weekday: string } {
  return { month: date.getMonth() + 1, day: date.getDate(), weekday: WEEKDAYS[date.getDay()] };
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** 月/日选择器安全改日期（2/31 → 2/28）。 */
export function getSafeDate(baseDate: Date, type: "month" | "day", value: number): Date {
  const year = baseDate.getFullYear();
  const month = type === "month" ? value - 1 : baseDate.getMonth();
  const dayLimit = getDaysInMonth(year, month);
  const day = type === "day" ? Math.min(value, dayLimit) : Math.min(baseDate.getDate(), dayLimit);
  return new Date(year, month, day);
}

export function parseTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
}

export function getRemainingBuses(schedules: ScheduleItem[], currentTime: Date = new Date()): ScheduleItem[] {
  const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  return schedules
    .filter((s) => parseTime(s.departureTime) > currentMinutes)
    .sort((a, b) => parseTime(a.departureTime) - parseTime(b.departureTime));
}

// ---------------------------------------------------------------------------
// Journey loading（实时接口）
// ---------------------------------------------------------------------------

function journeyToScheduleItem(journey: Journey): ScheduleItem {
  return {
    tripId: journey.tripId,
    routeName: journey.routeName,
    departureTime: journey.departureTime,
    arrivalTime: journey.arrivalTime,
    isReservation: journey.bookingPolicy === "required",
    bookingPolicy: journey.bookingPolicy,
    bookingUrl: journey.bookingUrl,
    fromSequence: journey.fromSequence,
    toSequence: journey.toSequence,
  };
}

/**
 * Fetch the day's schedules between two stops from the journeys endpoint.
 * Trip identity is preserved.
 */
export async function fetchSchedules(fromStopId: string, toStopId: string, date: Date): Promise<ScheduleItem[]> {
  const response = await apiGet<JourneysResponse>("/api/public/transit/journeys", {
    fromStopId,
    toStopId,
    date: toDateKey(date),
  });
  return response.journeys.map(journeyToScheduleItem);
}

/** 取某班次的停靠序列（M7 预览的数据源）。 */
export async function fetchTripStops(tripId: string): Promise<TripStop[]> {
  const response = await apiGet<TripStopsResponse>(
    `/api/public/transit/trips/${encodeURIComponent(tripId)}/stops`,
  );
  return response.stops;
}

// ---------------------------------------------------------------------------
// 包内快照兜底（data/shuttle-schedule.json，Ver2025.11）
//
// 快照按「校区名 → 分桶时刻表」组织，没有 tripId / 停靠序列，只能还原时刻网格，
// 班次预览的停靠时间线在快照模式下不可用（页面据此降级展示）。
// ---------------------------------------------------------------------------

interface SnapshotScheduleEntry {
  departureTime: string;
  isReservation: boolean;
  viaCampus?: string;
}

interface SnapshotRoute {
  id: string;
  from: string;
  to: string;
  note?: string;
  schedules: Record<string, SnapshotScheduleEntry[]>;
}

const snapshotRoutes = (shuttleSnapshot as { version: string; routes: SnapshotRoute[] }).routes;

/** 快照版本号（如 Ver2025.11），离线提示用。 */
export const SNAPSHOT_VERSION: string = (shuttleSnapshot as { version: string }).version;

/** 快照里的站点集合（校区名去重，id 就用名字）。 */
export function snapshotStops(): TransitStop[] {
  const names: string[] = [];
  snapshotRoutes.forEach((route) => {
    if (!names.includes(route.from)) names.push(route.from);
    if (!names.includes(route.to)) names.push(route.to);
  });
  return names.map((name) => ({
    id: name,
    place_id: null,
    campus_id: null,
    code: null,
    name,
    status: "active",
    created_at: "",
    updated_at: "",
  }));
}

/** 从快照取一条线路某天的班次；没有这条线路返回 null，该桶无班次返回 []。 */
export function snapshotSchedules(fromStopName: string, toStopName: string, date: Date): ScheduleItem[] | null {
  const route = snapshotRoutes.find((item) => item.from === fromStopName && item.to === toStopName);
  if (!route) return null;
  const bucket = getCurrentDateBucket(date);
  const entries = route.schedules[bucket] ?? [];
  return entries.map((entry) => ({
    tripId: `snapshot:${route.id}:${entry.departureTime}:${entry.isReservation ? "r" : "n"}`,
    routeName: `${route.from} → ${route.to}`,
    departureTime: entry.departureTime,
    arrivalTime: null,
    isReservation: entry.isReservation,
    bookingPolicy: entry.isReservation ? "required" : "not_required",
    bookingUrl: null,
    fromSequence: 0,
    toSequence: 1,
  }));
}

/**
 * 站点列表：优先 release manifest（站点带 place_id，可跳地图），
 * 接口失败时退化为快照里的校区名集合。
 */
export async function loadTransitStops(): Promise<{ stops: TransitStop[]; source: ScheduleSource }> {
  try {
    const manifest = await apiGet<ReleaseTransitManifest>("/api/public/releases/current");
    if (manifest.transit.stops.length > 0) {
      const locations = manifest.locations ?? [];
      return {
        stops: manifest.transit.stops.map((stop) => ({
          ...stop,
          navigationPoint: navigationPointForStop(stop, locations),
        })),
        source: "api",
      };
    }
    return { stops: snapshotStops(), source: "snapshot" };
  } catch {
    return { stops: snapshotStops(), source: "snapshot" };
  }
}

/**
 * 当日班次：优先 journeys 实时接口，失败/离线时降级到包内快照。
 * 快照模式下按日历分桶（工作日/周末/假日/寒暑假）取时刻。
 */
export async function fetchSchedulesWithFallback(
  fromStop: TransitStop,
  toStop: TransitStop,
  date: Date,
): Promise<{ schedules: ScheduleItem[]; source: ScheduleSource }> {
  try {
    const schedules = await fetchSchedules(fromStop.id, toStop.id, date);
    return { schedules, source: "api" };
  } catch {
    const fallback = snapshotSchedules(fromStop.name, toStop.name, date);
    if (fallback === null) throw new Error("离线数据中没有这条线路");
    return { schedules: fallback, source: "snapshot" };
  }
}

// ---------------------------------------------------------------------------
// 时刻网格合并（同一时刻既有预约又有非预约班次时合并显示）
// ---------------------------------------------------------------------------

export type ScheduleStatus = "reservation" | "nonReservation" | "mixed";

export interface DisplayScheduleItem {
  departureTime: string;
  status: ScheduleStatus;
}

export function mergeSchedulesByTime(schedules: ScheduleItem[]): DisplayScheduleItem[] {
  const merged = new Map<string, { hasReservation: boolean; hasNonReservation: boolean }>();

  schedules.forEach((schedule) => {
    const current = merged.get(schedule.departureTime) ?? { hasReservation: false, hasNonReservation: false };
    if (schedule.isReservation) current.hasReservation = true;
    else current.hasNonReservation = true;
    merged.set(schedule.departureTime, current);
  });

  return Array.from(merged.entries()).map(([departureTime, availability]) => ({
    departureTime,
    status:
      availability.hasReservation && availability.hasNonReservation
        ? "mixed"
        : availability.hasReservation
          ? "reservation"
          : "nonReservation",
  }));
}

// ---------------------------------------------------------------------------
// M7 班次路线预览 — GET /api/public/transit/trips/:tripId/stops
//
// 停靠序列与时刻此前读 release manifest 里冻结的那一份。班次改了要立刻生效，
// 所以这里和 journeys 一样走实时读；manifest 只留站点。
// ---------------------------------------------------------------------------

export interface TripPreviewStop {
  stopId: string;
  stopName: string;
  sequence: number;
  role: "boarding" | "alighting" | "intermediate";
  time: string | null;
  timeLabel: "发车" | "到达" | null;
}

/**
 * Build the M7 preview: ordered stops of the trip's pattern between the
 * journey's from/to sequence, annotated with times from stop_times.
 * Current data only carries the first departure time — later times are null.
 */
export function buildTripPreview(
  tripStops: TripStop[],
  schedule: ScheduleItem,
): { stops: TripPreviewStop[]; durationMinutes: number | null } {
  const inRange = tripStops
    .filter((row) => row.stopSequence >= schedule.fromSequence && row.stopSequence <= schedule.toSequence)
    .sort((a, b) => a.stopSequence - b.stopSequence);

  const stops: TripPreviewStop[] = inRange.map((row) => {
    const isFirst = row.stopSequence === schedule.fromSequence;
    const isLast = row.stopSequence === schedule.toSequence;
    const depart = row.departureTime;
    const arrive = row.arrivalTime;
    return {
      stopId: row.stopId,
      stopName: row.stopName,
      sequence: row.stopSequence,
      role: isFirst ? "boarding" : isLast ? "alighting" : "intermediate",
      time: isFirst ? depart : (arrive ?? depart),
      timeLabel: isFirst ? (depart ? "发车" : null) : arrive || depart ? "到达" : null,
    };
  });

  const firstTime = stops.find((s) => s.time)?.time;
  const lastTime = [...stops].reverse().find((s) => s.time)?.time;
  const durationMinutes =
    firstTime && lastTime && lastTime !== firstTime && stops.length > 1
      ? Math.max(0, parseTime(lastTime) - parseTime(firstTime))
      : null;

  return { stops, durationMinutes };
}

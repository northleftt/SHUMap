import { CLIENT_CONTRACT } from "../client-contract";
// 校车时刻表逻辑。对齐 Web 端 src/lib/transit/schedule.ts（0024 校区对校区改版）：
// 纯函数（日期分桶、剩余班次、线路预览）逐行移植；
// 网络层从 publicApi 换成 lib/api 的 apiGet，并保留包内快照兜底。
//
// 数据双通道：优先 GET /api/public/transit/campus-lines（班次为实时数据），
// 失败/离线时降级到打包进包内的 data/shuttle-schedule 快照（Ver2025.11）。
// 端点身份来自 release manifest；manifest 也取不到时退化为快照里的端点列表。
// 注：数据文件是 .ts 模块（原 .json 内容原样 export default）——小程序编译器
// 只把源码文件打包成可 require 的模块，直接 require .json 会在运行时报模块未定义。
//
// 预约与否是线路级属性（CampusLine.bookingPolicy）；时刻网格按发车时刻把
// 预/非班次合并成一格展示（旧版 mergeSchedulesByTime 语义）。
//
// 日型（工作日/周末/假日/寒暑假）**在线时由服务端按管理端的服务日历给出**
// （CampusLinesResponse.dayType）。本文件仍保留 getCurrentDateBucket 的本地算法，
// 但它**只服务离线快照**：快照按日型分桶存时刻（snapshotCampusLines），断网时没有
// 服务端可问，只能本地判。Web 端不需要这个回退，所以那边已经完全删掉了本地算法。
//
// 本地算法的数据源 data/academic-calendar 是 2026-03-11 提交 1ee1733 手写的草稿
// （无生成脚本、worker 侧零引用、假日只列到 2026-06-19），所以它天生会过期——
// 这也正是在线路径不能再用它的原因。离线时宁可标签不准，也要有个时刻表可看。

import { apiGet } from "../api";
import academicCalendarData from "../../data/academic-calendar";
import shuttleSnapshot from "../../data/shuttle-schedule";
import type {
  CampusJourney,
  CampusLine,
  CampusLinesResponse,
  PublicDayType,
  ReleaseNavigationLocation,
  ReleaseTransitManifest,
  TransitStop,
} from "./types";

/**
 * 站点的 GCJ-02 导航终点（唤起第三方地图用）。
 *
 * 刻意**不看 isPrimary**：一个实体的 primary 名额只有一个，站点那一个被候车点
 * （boarding_point，svg 画布坐标）占着，所以 navigation_target 行必然是
 * isPrimary=0。旧实现要求 isPrimary===1，于是 11 个站点无一命中——预览时间线上
 * 的「导航」入口从来没出现过。发布层保证同一实体的 navigation_target 唯一
 * （src/lib/release/mapData.ts 会对重复直接报契约错误），因此不必再排序取优。
 */
export function navigationPointForStop(
  stop: TransitStop,
  locations: ReleaseNavigationLocation[],
): TransitStop["navigationPoint"] {
  const location = locations.find((item) =>
    item.role === "navigation_target"
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

/**
 * 站点在地图上的 POI 键，没上图时返回 null。
 *
 * 发布层给每个「有画布点位」的站点造一枚 `transit_stop:<id>` 的 POI：自己标了
 * 候车点就用它，否则借绑定地点的点位（见 lib/release/mapData.ts）。所以地图深链
 * 的键一律是 `transit_stop:<id>`，与站点有没有绑地点无关。
 *
 * 这里判「有没有上图」必须跟发布层同一条规则（svg_viewbox 画布点），不能只看
 * `place_id`：11 个站点里只有嘉定北门绑了地点，其余 10 个 place_id 都是 null，
 * 旧实现于是回落到 `campus:<id>` —— 那个深链只切校区、不开详情，正是「点了上下车点
 * 回到地图却没打开 POI」的原因。而陈太公寓只有 GCJ02 坐标、没有画布点位，
 * 确实没有 POI 可开，这里如实返回 null，让调用方不要给出可点入口。
 */
export function mapPoiKeyForStop(
  stop: TransitStop,
  locations: ReleaseNavigationLocation[],
): string | null {
  const hasCanvasPoint = (entityType: string, entityId: string): boolean =>
    locations.some((item) =>
      item.entityType === entityType
      && item.entityId === entityId
      && item.geometry_type === "Point"
      && item.crs === "svg_viewbox");
  if (hasCanvasPoint("transit_stop", stop.id)) return `transit_stop:${stop.id}`;
  if (stop.place_id && hasCanvasPoint("place", stop.place_id)) return `transit_stop:${stop.id}`;
  return null;
}

export type DateBucket = "weekday" | "weekend" | "holiday" | "winterBreak" | "summerBreak";

/** 班次数据来源：实时接口或包内快照。 */
export type ScheduleSource = "api" | "snapshot";

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

/** 离线快照分桶名 → 中文标签（断网时用；在线走 DAY_TYPE_LABELS）。 */
export const BUCKET_LABELS: Record<DateBucket, string> = {
  weekday: "工作日",
  weekend: "周末",
  holiday: "假日",
  winterBreak: "寒假",
  summerBreak: "暑假",
};

/** 服务端日型 → 中文标签。键与 0025 迁移的 day_type 枚举一致。 */
export const DAY_TYPE_LABELS: Record<PublicDayType, string> = {
  weekday: "工作日",
  weekend: "周末",
  holiday: "假日",
  winter_break: "寒假",
  summer_break: "暑假",
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

/** 过滤掉已过发车的班次并按时刻排序；departureTime 为 null 的班次排最后。 */
export function getRemainingJourneys<T extends { departureTime: string | null }>(
  journeys: T[],
  currentTime: Date = new Date(),
): T[] {
  const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  return journeys
    .filter((journey) => journey.departureTime !== null && parseTime(journey.departureTime) > currentMinutes)
    .sort((a, b) => parseTime(a.departureTime as string) - parseTime(b.departureTime as string));
}

// ---------------------------------------------------------------------------
// 校区对校区线路加载（0024 改版）
// ---------------------------------------------------------------------------

/** 校车 OD 端点：有站点的校区 + 无校区站点的伪端点（如陈太公寓）。 */
export interface TransitEndpoint {
  /** campus_id，或无校区站点的 `stop:<stopId>`。 */
  id: string;
  name: string;
}

/**
 * 从 release manifest 推导可选端点：transit 站点出现过的校区按 manifest.campuses
 * 顺序排列；campus_id 为 null 的站点（陈太公寓）各自成组追加在后。
 */
export function listTransitEndpoints(manifest: {
  campuses: Array<{ id: string; name: string }>;
  transit: { stops: TransitStop[] };
}): TransitEndpoint[] {
  const endpoints: TransitEndpoint[] = [];
  for (const campus of manifest.campuses) {
    if (manifest.transit.stops.some((stop) => stop.campus_id === campus.id)) {
      endpoints.push({ id: campus.id, name: campus.name });
    }
  }
  for (const stop of manifest.transit.stops) {
    if (stop.campus_id === null) endpoints.push({ id: `stop:${stop.id}`, name: stop.name });
  }
  return endpoints;
}

/** 拉取某校区对当日的全部线路（含停靠序列与班次逐站时刻）。 */
export async function fetchCampusLines(
  fromEndpointId: string,
  toEndpointId: string,
  date: Date,
): Promise<CampusLinesResponse> {
  return apiGet<CampusLinesResponse>("/api/public/transit/campus-lines", {
    contract: CLIENT_CONTRACT,
    from: fromEndpointId,
    to: toEndpointId,
    date: toDateKey(date),
  });
}

/** 线路的全部上车点（跨 pattern 去重，保持停靠顺序）。 */
export function lineBoardingStops(line: CampusLine): Array<{ stopId: string; stopName: string }> {
  const seen = new Set<string>();
  const stops: Array<{ stopId: string; stopName: string }> = [];
  for (const pattern of line.patterns) {
    for (const stop of pattern.stops) {
      if (stop.pickupType === "none" || seen.has(stop.stopId)) continue;
      seen.add(stop.stopId);
      stops.push({ stopId: stop.stopId, stopName: stop.stopName });
    }
  }
  return stops;
}

/** 线路的全部下车点（跨 pattern 去重，保持停靠顺序）。 */
export function lineAlightingStops(line: CampusLine): Array<{ stopId: string; stopName: string }> {
  const seen = new Set<string>();
  const stops: Array<{ stopId: string; stopName: string }> = [];
  for (const pattern of line.patterns) {
    for (const stop of pattern.stops) {
      if (stop.dropoffType === "none" || seen.has(stop.stopId)) continue;
      seen.add(stop.stopId);
      stops.push({ stopId: stop.stopId, stopName: stop.stopName });
    }
  }
  return stops;
}

/** 多条线路的站点列表合并去重（按 stopId，保持首次出现顺序）。 */
function mergeStopLists(
  lists: Array<Array<{ stopId: string; stopName: string }>>,
): Array<{ stopId: string; stopName: string }> {
  const seen = new Set<string>();
  const stops: Array<{ stopId: string; stopName: string }> = [];
  for (const list of lists) {
    for (const stop of list) {
      if (seen.has(stop.stopId)) continue;
      seen.add(stop.stopId);
      stops.push(stop);
    }
  }
  return stops;
}

/** 同类多条线路的上车点合并去重（「上下车点」区块按预约类别拆行用）。 */
export function linesBoardingStops(lines: CampusLine[]): Array<{ stopId: string; stopName: string }> {
  return mergeStopLists(lines.map(lineBoardingStops));
}

/** 同类多条线路的下车点合并去重。 */
export function linesAlightingStops(lines: CampusLine[]): Array<{ stopId: string; stopName: string }> {
  return mergeStopLists(lines.map(lineAlightingStops));
}

// ---------------------------------------------------------------------------
// 班次展示：跨线路摊平 + 时刻合并（旧版「最近一班 / 今日其他班次」语义，
// 预约与否读所属线路的 bookingPolicy）
// ---------------------------------------------------------------------------

/** 预约车 = required / optional 线路；非预约车 = not_required。 */
export function isReservationLine(line: CampusLine): boolean {
  return line.bookingPolicy === "required" || line.bookingPolicy === "optional";
}

/** 摊平到班次粒度的展示条目：携带所属线路与预约类别。 */
export interface FlatLineJourney {
  line: CampusLine;
  journey: CampusJourney;
  /** 已过滤 null，保证非空。 */
  departureTime: string;
  isReservation: boolean;
}

/** 某校区对全部线路的当日班次合并：剔除无发车时刻的班次，按时刻升序。 */
export function flattenLineJourneys(lines: CampusLine[]): FlatLineJourney[] {
  const flat: FlatLineJourney[] = [];
  for (const line of lines) {
    for (const journey of line.journeys) {
      if (journey.departureTime === null) continue;
      flat.push({ line, journey, departureTime: journey.departureTime, isReservation: isReservationLine(line) });
    }
  }
  return flat.sort((a, b) => parseTime(a.departureTime) - parseTime(b.departureTime));
}

/**
 * 某个发车时刻的全部班次，非预约在前、预约在后。
 *
 * 时刻网格把同一时刻的预约与非预约班次合并成一格（见 mergeSchedulesByTime），
 * 所以点开这一格必须把两班都给出来。以前这里是 `find(...)`，只返回先命中的那一班
 * ——摊平顺序里非预约常在前，于是「预 非」那一格点开永远只看到非预约车，
 * 另一半信息在界面上没有任何入口。与 Web 端 src/lib/transit/schedule.ts 同式。
 */
export function journeysAtTime(journeys: FlatLineJourney[], departureTime: string): FlatLineJourney[] {
  return journeys
    .filter((item) => item.departureTime === departureTime)
    .sort((left, right) => Number(left.isReservation) - Number(right.isReservation));
}

/** 同一时刻可能既有预约又有非预约班次 — 合并成一个时刻格（旧版时刻网格语义）。 */
export type ScheduleStatus = "reservation" | "nonReservation" | "mixed";

export interface DisplayScheduleItem {
  departureTime: string;
  status: ScheduleStatus;
}

export function mergeSchedulesByTime(journeys: FlatLineJourney[]): DisplayScheduleItem[] {
  const merged = new Map<string, { hasReservation: boolean; hasNonReservation: boolean }>();

  journeys.forEach((item) => {
    const current = merged.get(item.departureTime) ?? { hasReservation: false, hasNonReservation: false };
    if (item.isReservation) current.hasReservation = true;
    else current.hasNonReservation = true;
    merged.set(item.departureTime, current);
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
// 班次路线预览 — 数据随 campus-lines 响应一次到位，不再二次请求
// ---------------------------------------------------------------------------

export interface LinePreviewStop {
  stopId: string;
  stopName: string;
  sequence: number;
  role: "boarding" | "alighting" | "intermediate";
  time: string | null;
  timeLabel: "发车" | "到达" | null;
  /**
   * true 表示这一站的 time 是推算值（发车时刻 + 历史区间用时中位数），不是排班
   * 时刻。UI 必须把它和排班时刻区分开——把推算值显示成确定时刻会让人按它掐点
   * 到站。见 worker/modules/travel-time.ts。
   */
  isEstimated: boolean;
  /** 推算到达跨到次日（如 22:00 发车的末班车）。仅 isEstimated 时有意义。 */
  dayOffset: number;
}

/**
 * 用线路的 pattern 停靠序列 + 班次逐站时刻拼预览时间线。
 *
 * 源数据只有首站发车时刻（返校指南 PDF 与管理端录入都只有发车列），下车站的
 * arrival_time 基本全空。所以这里在排班时刻缺失时回落到服务端给的推算到达时间
 * （estimatedArrivalTime），并用 isEstimated 标出来由 UI 区分显示。
 */
export function buildLinePreview(
  line: CampusLine,
  journey: CampusJourney,
): { stops: LinePreviewStop[]; durationMinutes: number | null; hasEstimated: boolean } {
  const pattern = line.patterns.find((candidate) => candidate.patternId === journey.patternId);
  if (!pattern) throw new Error(`班次 ${journey.tripId} 的 pattern 不在线路 ${line.routeId} 内`);
  const times = new Map(journey.stopTimes.map((time) => [time.stopSequence, time]));
  const ordered = [...pattern.stops].sort((a, b) => a.stopSequence - b.stopSequence);
  const stops: LinePreviewStop[] = ordered.map((stop, index) => {
    const time = times.get(stop.stopSequence);
    const isFirst = index === 0;
    const isLast = index === ordered.length - 1;
    const scheduled = isFirst ? (time?.departureTime ?? null) : (time?.arrivalTime ?? time?.departureTime ?? null);
    // 首站不推算：它的发车时刻就是排班本身，没有未知量。
    const estimated = isFirst ? null : (time?.estimatedArrivalTime ?? null);
    const value = scheduled ?? estimated;
    const isEstimated = scheduled === null && estimated !== null;
    return {
      stopId: stop.stopId,
      stopName: stop.stopName,
      sequence: stop.stopSequence,
      role: isFirst ? "boarding" : isLast ? "alighting" : "intermediate",
      time: value,
      timeLabel: value === null ? null : isFirst ? "发车" : "到达",
      isEstimated,
      dayOffset: isEstimated ? (time?.estimatedArrivalDayOffset ?? 0) : 0,
    };
  });

  // 全程用时优先用班次级的估算（服务端按整链累加得出，跨零点也已处理）；
  // 没有估算时退回「首末两个已知时刻之差」的老算法。
  const firstTime = stops.find((stop) => stop.time)?.time;
  const lastTime = [...stops].reverse().find((stop) => stop.time)?.time;
  const durationMinutes = journey.estimatedDurationMinutes
    ?? (firstTime && lastTime && lastTime !== firstTime && stops.length > 1
      ? Math.max(0, parseTime(lastTime) - parseTime(firstTime))
      : null);

  return { stops, durationMinutes, hasEstimated: stops.some((stop) => stop.isEstimated) };
}

// ---------------------------------------------------------------------------
// 包内快照兜底（data/shuttle-schedule.ts，由 generate_miniprogram_shuttle_snapshot.mjs 生成）
//
// 快照按「校区对 → 线路 → 分桶时刻」组织，没有停靠序列（patterns 为空），
// 只能还原线路分组与时刻网格；上下车点 chips 与班次预览时间线在快照模式下
// 不可用（页面据此降级展示）。
// ---------------------------------------------------------------------------

interface SnapshotLine {
  routeName: string;
  bookingPolicy: string;
  bookingUrl: string | null;
  schedules: Record<string, string[]>;
}

interface ShuttleSnapshot {
  version: string;
  endpoints: TransitEndpoint[];
  /** 键：`${fromEndpointId}>${toEndpointId}`（保留方向）。 */
  pairs: Record<string, SnapshotLine[]>;
}

const snapshot = shuttleSnapshot as unknown as ShuttleSnapshot;

/** 快照版本号（如 Ver2025.11），离线提示用。 */
export const SNAPSHOT_VERSION: string = snapshot.version;

/** 快照里的端点集合（校区 + 陈太公寓伪端点）。 */
export function snapshotEndpoints(): TransitEndpoint[] {
  return snapshot.endpoints.map((endpoint) => ({ ...endpoint }));
}

/**
 * 从快照取某校区对某天的线路；没有这个校区对返回 null。
 * 班次按日历分桶（工作日/周末/假日/寒暑假）取时刻，合成 CampusLine 结构
 * （tripId 为 `snapshot:` 前缀的合成 id，patterns 为空）。
 */
export function snapshotCampusLines(fromEndpointId: string, toEndpointId: string, date: Date): CampusLine[] | null {
  const pairKey = `${fromEndpointId}>${toEndpointId}`;
  const snapshotLines = snapshot.pairs[pairKey];
  if (!snapshotLines) return null;
  const bucket = getCurrentDateBucket(date);
  return snapshotLines.map((line, index) => ({
    routeId: `snapshot:${pairKey}:${index}`,
    routeName: line.routeName,
    bookingPolicy: line.bookingPolicy,
    bookingUrl: line.bookingUrl,
    patterns: [],
    journeys: (line.schedules[bucket] ?? []).map((departureTime) => ({
      tripId: `snapshot:${pairKey}:${index}:${departureTime}`,
      patternId: "",
      publicLabel: null,
      departureTime,
      arrivalTime: null,
      // 快照是包内静态数据，不含用时样本 —— 估算到达时间只有实时接口能给。
      // 离线时页面只显示发车时刻，不显示「预计到达」。
      estimatedArrivalTime: null,
      estimatedArrivalDayOffset: null,
      estimatedDurationMinutes: null,
      stopTimes: [],
    })),
  }));
}

/**
 * 端点列表：优先 release manifest（站点带画布点位，上下车点可跳地图），
 * 接口失败时退化为快照里的端点集合（stops 为空，地图深链不可用）。
 */
export async function loadTransitEndpoints(): Promise<{
  endpoints: TransitEndpoint[];
  stops: TransitStop[];
  source: ScheduleSource;
}> {
  try {
    const manifest = await apiGet<ReleaseTransitManifest>("/api/public/releases/current");
    const endpoints = listTransitEndpoints(manifest);
    if (endpoints.length > 0) {
      const locations = manifest.locations ?? [];
      return {
        endpoints,
        stops: manifest.transit.stops.map((stop) => ({
          ...stop,
          navigationPoint: navigationPointForStop(stop, locations),
          mapPoiKey: mapPoiKeyForStop(stop, locations),
        })),
        source: "api",
      };
    }
    return { endpoints: snapshotEndpoints(), stops: [], source: "snapshot" };
  } catch {
    return { endpoints: snapshotEndpoints(), stops: [], source: "snapshot" };
  }
}

/**
 * 当日线路：优先 campus-lines 实时接口，失败/离线时降级到包内快照。
 * 快照模式下按日历分桶取时刻。
 */
export async function fetchCampusLinesWithFallback(
  fromEndpoint: TransitEndpoint,
  toEndpoint: TransitEndpoint,
  date: Date,
): Promise<{ lines: CampusLine[]; source: ScheduleSource; dayTypeLabel: string }> {
  try {
    const response = await fetchCampusLines(fromEndpoint.id, toEndpoint.id, date);
    // 在线：日型由服务端按管理端的服务日历给出。老版本服务端不带这个字段，
    // 此时回落到本地分桶（?? 分支），不让标签整块消失。
    return {
      lines: response.lines,
      source: "api",
      dayTypeLabel: DAY_TYPE_LABELS[response.dayType] ?? BUCKET_LABELS[getCurrentDateBucket(date)],
    };
  } catch {
    const fallback = snapshotCampusLines(fromEndpoint.id, toEndpoint.id, date);
    if (fallback === null) throw new Error("离线数据中没有这条线路");
    // 离线：没有服务端可问，只能本地判（数据源是那份会过期的草稿，见文件头）。
    return { lines: fallback, source: "snapshot", dayTypeLabel: BUCKET_LABELS[getCurrentDateBucket(date)] };
  }
}

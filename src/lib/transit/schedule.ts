// Shuttle schedule helpers. Schedules and line structure come from the v2 public
// transit API (GET /api/public/transit/campus-lines, 0024 校区对校区改版);
// stop identity comes from the active release manifest via ReleaseContext —
// stops carry geometry and are map data, the timetable is live.
//
// 预约与否是线路级属性（CampusLine.bookingPolicy）；时刻网格按发车时刻把
// 预/非班次合并成一格展示（旧版 mergeSchedulesByTime 语义）。
//
// 日型（工作日/周末/假日/寒暑假）**由服务端按管理端的服务日历给出**
// （CampusLinesResponse.dayType，由校历判定，见 worker/lib/daytype.ts）。
// 这里曾经自己算：读 data/academic-calendar.json —— 2026-03-11 提交 1ee1733 手写的
// 一份草稿，没有生成脚本、worker 侧零引用、假日只列到 2026-06-19。而班次归属早就
// 按 service_calendars 过滤了，两套数据没有代码连通，于是会出现「页面说今天是假日、
// 但假日班次一个都不出」。运营只应该改一处（管理端日历），所以本文件不再读那份 JSON。

import { publicApi } from "../api";
import type {
  CampusJourney,
  CampusLine,
  CampusLinesResponse,
  PublicDayType,
  TransitStop,
} from "../api/types";

// ---------------------------------------------------------------------------
// Date helpers (display only; 日型与班次归属都在服务端定)
// ---------------------------------------------------------------------------

export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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
  signal?: AbortSignal,
): Promise<CampusLinesResponse> {
  return publicApi.getCampusLines({ from: fromEndpointId, to: toEndpointId, date: toDateKey(date) }, signal);
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
 * 另一半信息在界面上没有任何入口。
 */
export function journeysAtTime(journeys: FlatLineJourney[], departureTime: string): FlatLineJourney[] {
  return journeys
    .filter((item) => item.departureTime === departureTime)
    .sort((left, right) => Number(left.isReservation) - Number(right.isReservation));
}

/** Same departure time can carry both a 预约 and a 非预约 trip — merge for the grid. */
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
 * 时刻的优先级：排班到达时刻 > 排班发车时刻 > 推算到达时刻。源数据（返校指南
 * 原稿）只有首站发车时刻，中间站与末站的到达列基本全空，所以除首站之外基本都
 * 落到推算值上；推算值来自定时采样的区间用时中位数，缺样本时为 null（显示「暂无」）。
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

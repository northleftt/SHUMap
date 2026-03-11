import shuttleData from "../../data/shuttle-schedule.json";

export type DateBucket = "weekday" | "weekend" | "holiday" | "winterBreak" | "summerBreak";

export interface ScheduleItem {
  departureTime: string;
  isReservation: boolean;
  viaCampus?: string;
}

export interface ShuttleRoute {
  id: string;
  from: string;
  to: string;
  sourcePage: number;
  schedules: {
    weekday: ScheduleItem[];
    weekend: ScheduleItem[];
    holiday: ScheduleItem[];
    winterBreak: ScheduleItem[];
    summerBreak: ScheduleItem[];
  };
}

const campuses = ["宝山校区", "嘉定校区", "延长校区", "陈太公寓"] as const;
export type Campus = (typeof campuses)[number];

export function getCampuses(): Campus[] {
  return [...campuses];
}

export function getCampusId(campus: Campus): string {
  const map: Record<Campus, string> = {
    "宝山校区": "baoshan",
    "嘉定校区": "jiading",
    "延长校区": "yanchang",
    "陈太公寓": "chentaigongyu",
  };
  return map[campus];
}

export function getCampusName(id: string): Campus | undefined {
  const map: Record<string, Campus> = {
    baoshan: "宝山校区",
    jiading: "嘉定校区",
    yanchang: "延长校区",
    chentaigongyu: "陈太公寓",
  };
  return map[id];
}

export function getRouteId(from: Campus, to: Campus): string {
  return `${getCampusId(from)}-to-${getCampusId(to)}`;
}

export function findRoute(from: Campus, to: Campus): ShuttleRoute | undefined {
  const routeId = getRouteId(from, to);
  return (shuttleData as { routes: ShuttleRoute[] }).routes.find((r) => r.id === routeId);
}

export function getCurrentDateBucket(date: Date = new Date()): DateBucket {
  const day = date.getDay();
  const month = date.getMonth() + 1;

  // 寒暑假判定（简化逻辑，实际需要根据academic-calendar.json）
  // 寒假：1-2月，暑假：7-8月
  if (month === 1 || month === 2) return "winterBreak";
  if (month === 7 || month === 8) return "summerBreak";

  // 周末判定
  if (day === 0 || day === 6) return "weekend";

  // 默认工作日
  return "weekday";
}

export function formatDate(date: Date): { month: number; day: number; weekday: string } {
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  return {
    month: date.getMonth() + 1,
    day: date.getDate(),
    weekday: weekdays[date.getDay()],
  };
}

export function parseTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
}

export function getNextBus(
  schedules: ScheduleItem[],
  currentTime: Date = new Date()
): ScheduleItem | null {
  const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();

  const upcoming = schedules
    .filter((s) => parseTime(s.departureTime) > currentMinutes)
    .sort((a, b) => parseTime(a.departureTime) - parseTime(b.departureTime));

  return upcoming[0] || null;
}

export function getRemainingBuses(
  schedules: ScheduleItem[],
  currentTime: Date = new Date()
): ScheduleItem[] {
  const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();

  return schedules
    .filter((s) => parseTime(s.departureTime) > currentMinutes)
    .sort((a, b) => parseTime(a.departureTime) - parseTime(b.departureTime));
}

export function getTodaySchedules(
  from: Campus,
  to: Campus,
  date: Date = new Date()
): ScheduleItem[] {
  const route = findRoute(from, to);
  if (!route) return [];

  const bucket = getCurrentDateBucket(date);
  return route.schedules[bucket] || [];
}

export function getAllSchedules(
  from: Campus,
  to: Campus,
  date: Date = new Date()
): { nextBus: ScheduleItem | null; remaining: ScheduleItem[]; all: ScheduleItem[] } {
  const all = getTodaySchedules(from, to, date);
  const nextBus = getNextBus(all, date);
  const remaining = getRemainingBuses(all, date);

  return { nextBus, remaining, all };
}

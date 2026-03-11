import academicCalendarData from "../../data/academic-calendar.json";
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
  note?: string;
  schedules: {
    weekday: ScheduleItem[];
    weekend: ScheduleItem[];
    holiday: ScheduleItem[];
    winterBreak: ScheduleItem[];
    summerBreak: ScheduleItem[];
  };
}

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

function toDateKey(date: Date): string {
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

export function formatDate(date: Date): { month: number; day: number; weekday: string } {
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
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

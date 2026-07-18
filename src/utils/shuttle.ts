// Shuttle data helpers. Schedules are sourced from the v2 public transit API
// (GET /api/public/transit/journeys) — NOT from bundled static JSON. Transit
// stop identity is resolved from the active release's transit stops, so shuttle
// data shares the same release-gated content source as the rest of the app.
//
// Trip identity (tripId), booking policy, canonical stops, and arrivalTime: null
// semantics are preserved from the backend contract.

import academicCalendarData from "../../data/academic-calendar.json";
import { publicApi } from "../lib/api";
import type { Journey, TransitStop } from "../lib/api/types";

export type DateBucket = "weekday" | "weekend" | "holiday" | "winterBreak" | "summerBreak";

export interface ScheduleItem {
  /** Stable trip identity from the backend. */
  tripId: string;
  departureTime: string;
  /** null when the source only carries departure times (current data). */
  arrivalTime: string | null;
  isReservation: boolean;
  bookingPolicy: string;
  bookingUrl: string | null;
  routeName: string;
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

// ---------------------------------------------------------------------------
// Date helpers (display + calendar-bucket label only; schedule resolution is
// performed server-side by the journeys endpoint).
// ---------------------------------------------------------------------------

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
  currentTime: Date = new Date(),
): ScheduleItem | null {
  const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  const upcoming = schedules
    .filter((s) => parseTime(s.departureTime) > currentMinutes)
    .sort((a, b) => parseTime(a.departureTime) - parseTime(b.departureTime));
  return upcoming[0] || null;
}

export function getRemainingBuses(
  schedules: ScheduleItem[],
  currentTime: Date = new Date(),
): ScheduleItem[] {
  const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  return schedules
    .filter((s) => parseTime(s.departureTime) > currentMinutes)
    .sort((a, b) => parseTime(a.departureTime) - parseTime(b.departureTime));
}

// ---------------------------------------------------------------------------
// Release-backed stop resolution + journey loading
// ---------------------------------------------------------------------------

/** Load the active release's transit stops. Throws ApiError (incl. release_unavailable). */
export async function loadTransitStops(signal?: AbortSignal): Promise<TransitStop[]> {
  const manifest = await publicApi.getCurrentRelease(signal);
  return manifest.transit.stops;
}

/** Resolve a campus display name to its transit stop ID within the release stops. */
export function resolveStopId(stops: TransitStop[], campus: Campus): string | null {
  const match = stops.find((stop) => stop.name === campus);
  return match ? match.id : null;
}

function journeyToScheduleItem(journey: Journey): ScheduleItem {
  return {
    tripId: journey.tripId,
    departureTime: journey.departureTime,
    arrivalTime: journey.arrivalTime, // preserved: null when source has no arrivals
    isReservation: journey.bookingPolicy === "required",
    bookingPolicy: journey.bookingPolicy,
    bookingUrl: journey.bookingUrl,
    routeName: journey.routeName,
  };
}

/**
 * Fetch the day's schedules between two campuses from the journeys endpoint.
 * Returns [] when either stop is unresolved. Trip identity is preserved.
 */
export async function fetchSchedules(
  stops: TransitStop[],
  from: Campus,
  to: Campus,
  date: Date,
  signal?: AbortSignal,
): Promise<ScheduleItem[]> {
  const fromStopId = resolveStopId(stops, from);
  const toStopId = resolveStopId(stops, to);
  if (!fromStopId || !toStopId) return [];
  const response = await publicApi.getJourneys({ fromStopId, toStopId, date: toDateKey(date) }, signal);
  return response.journeys.map(journeyToScheduleItem);
}

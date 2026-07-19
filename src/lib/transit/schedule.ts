// Shuttle schedule helpers. Schedules come from the v2 public transit API
// (GET /api/public/transit/journeys); stop identity comes from the active
// release manifest via ReleaseContext — shuttle data shares the same
// release-gated content source as the rest of the app.
//
// Trip identity (tripId), booking policy, and arrivalTime: null semantics are
// preserved from the backend contract.

import academicCalendarData from "../../../data/academic-calendar.json";
import { publicApi } from "../api";
import type { Journey, ReleaseManifest, TransitStop } from "../api/types";

export type DateBucket = "weekday" | "weekend" | "holiday" | "winterBreak" | "summerBreak";

export interface ScheduleItem {
  /** Stable trip identity from the backend. */
  tripId: string;
  routeName: string;
  departureTime: string;
  /** null when the source only carries departure times (current data). */
  arrivalTime: string | null;
  isReservation: boolean;
  bookingPolicy: string;
  bookingUrl: string | null;
  /** Stop sequence range within the trip's pattern (for M7 下车点列表). */
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
// Journey loading
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
export async function fetchSchedules(
  fromStopId: string,
  toStopId: string,
  date: Date,
  signal?: AbortSignal,
): Promise<ScheduleItem[]> {
  const response = await publicApi.getJourneys({ fromStopId, toStopId, date: toDateKey(date) }, signal);
  return response.journeys.map(journeyToScheduleItem);
}

/** Same departure time can carry both a 预约 and a 非预约 trip — merge for the grid. */
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
// M7 班次路线预览 — patternStops / stopTimes (light typing over manifest arrays)
// ---------------------------------------------------------------------------

interface PatternStopRow {
  pattern_id: string;
  stop_id: string;
  stop_sequence: number;
  pickup_type: string;
  dropoff_type: string;
}

interface StopTimeRow {
  trip_id: string;
  stop_id: string;
  stop_sequence: number;
  arrival_time: string | null;
  departure_time: string | null;
}

interface TripRow {
  id: string;
  pattern_id: string;
}

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
  manifest: ReleaseManifest,
  schedule: ScheduleItem,
): { stops: TripPreviewStop[]; durationMinutes: number | null } {
  const trips = manifest.transit.trips as unknown as TripRow[];
  const trip = trips.find((row) => row.id === schedule.tripId);
  if (!trip) return { stops: [], durationMinutes: null };

  const stopNameById = new Map(manifest.transit.stops.map((stop) => [stop.id, stop.name]));
  const patternStops = (manifest.transit.patternStops as unknown as PatternStopRow[])
    .filter((row) => row.pattern_id === trip.pattern_id)
    .sort((a, b) => a.stop_sequence - b.stop_sequence);
  const stopTimes = (manifest.transit.stopTimes as unknown as StopTimeRow[]).filter(
    (row) => row.trip_id === schedule.tripId,
  );
  const timeBySequence = new Map(stopTimes.map((row) => [row.stop_sequence, row]));

  const inRange = patternStops.filter(
    (row) => row.stop_sequence >= schedule.fromSequence && row.stop_sequence <= schedule.toSequence,
  );

  const stops: TripPreviewStop[] = inRange.map((row) => {
    const time = timeBySequence.get(row.stop_sequence);
    const isFirst = row.stop_sequence === schedule.fromSequence;
    const isLast = row.stop_sequence === schedule.toSequence;
    const depart = time?.departure_time ?? null;
    const arrive = time?.arrival_time ?? null;
    return {
      stopId: row.stop_id,
      stopName: stopNameById.get(row.stop_id) ?? row.stop_id,
      sequence: row.stop_sequence,
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

/** Resolve a transit stop to a map POI key: place_id first, then name match. */
export function stopToPoiKey(stop: TransitStop | undefined, buildings: { poiKey: string; name: string }[]): string | null {
  if (!stop) return null;
  if (stop.place_id) return stop.place_id;
  const byName = buildings.find((building) => building.name === stop.name);
  return byName ? byName.poiKey : null;
}

// Frozen legacy label semantics; new clients use academic calendars via daytype.ts.
import type { Env } from "../types/cloudflare";
import { all } from "./db";
import type { CampusDayType, WeekdayColumn } from "./daytype";
export async function legacyTransitDayType(env: Env, date: string, weekday: WeekdayColumn): Promise<CampusDayType> {
  const calendars = await all<{ dayType: string }>(env.DB,
    `select day_type as dayType from service_calendars c where c.valid_from<=? and c.valid_to>=?
      and (c.${weekday}=1 or exists(select 1 from service_calendar_exceptions a where a.calendar_id=c.id and a.service_date=? and a.exception_type='added'))
      and not exists(select 1 from service_calendar_exceptions e where e.calendar_id=c.id and e.service_date=? and e.exception_type='removed')`,
    [date, date, date, date]);
  const present = new Set(calendars.map(c => c.dayType));
  for (const type of ["holiday", "winter_break", "summer_break", "weekend", "weekday"] as const) if (present.has(type)) return type;
  return weekday === "saturday" || weekday === "sunday" ? "weekend" : "weekday";
}

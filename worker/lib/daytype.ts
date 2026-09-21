// 校园级日型判定：「今天是什么日子」的唯一一份算法。
//
// 日型数据归属统一校历（0035 的 academic_* 表，管理端「日历管理」维护），
// service_calendars 降为临时规则通道：命中的非 'other' 日历（考试周加开、临时调班）
// 覆盖校历结果，跟随校历的日历不参与。校车页与就餐页对「今天」永远同口径。
//
// 判定优先级（规则写死、数据全部可配）：
//   1. 临时规则（service_calendars，命中规则与班次过滤一致，非 'other' 按优先级取）
//   2. 校历调休工作日列表 → weekday
//   3. 校历法定节假日列表 → holiday
//   4. 校历假期区间（winter_break / summer_break）
//   5. 周六日 → weekend（写死，不随校历配置）
//   6. 其余 → weekday

import type { Env } from "../types/cloudflare";
import { all, first } from "./db";

export type CampusDayType = "weekday" | "weekend" | "holiday" | "winter_break" | "summer_break";

export const CAMPUS_DAY_TYPES: readonly CampusDayType[] = [
  "weekday", "weekend", "holiday", "winter_break", "summer_break",
];

const WEEKDAY_COLUMNS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type WeekdayColumn = (typeof WEEKDAY_COLUMNS)[number];

const DAY_TYPE_PRIORITY: readonly CampusDayType[] = ["holiday", "winter_break", "summer_break", "weekend", "weekday"];

/** 上海时区的星期列名（Intl 显式时区，不受运行环境 TZ 影响）；date 非法时返回 null。 */
export function shanghaiWeekday(date: string): WeekdayColumn | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "long" })
    .format(new Date(`${date}T12:00:00+08:00`))
    .toLowerCase();
  return (WEEKDAY_COLUMNS as readonly string[]).includes(name) ? (name as WeekdayColumn) : null;
}

/** 重叠日历的确定优先级：holiday > 寒暑假 > weekend > weekday。 */
export function pickDayType(types: readonly string[], fallback: CampusDayType): CampusDayType {
  for (const candidate of DAY_TYPE_PRIORITY) {
    if (types.includes(candidate)) return candidate;
  }
  return fallback;
}

/** 某天生效的临时规则日历（命中规则与班次过滤一致）。 */
async function loadActiveRuleCalendars(env: Env, date: string, weekday: WeekdayColumn): Promise<Array<{ dayType: string }>> {
  return all<{ dayType: string }>(
    env.DB,
    `select day_type as dayType from service_calendars c
      where c.valid_from<=? and c.valid_to>=?
        and (c.${weekday}=1 or exists(
          select 1 from service_calendar_exceptions a
           where a.calendar_id=c.id and a.service_date=? and a.exception_type='added'
        ))
        and not exists(select 1 from service_calendar_exceptions e
           where e.calendar_id=c.id and e.service_date=? and e.exception_type='removed')`,
    [date, date, date, date],
  );
}

/**
 * 解析某天的校园日型。调用方负责给出合法 date（YYYY-MM-DD）与对应 weekday
 * （shanghaiWeekday 的结果）。临时规则优先于校历；校历之外回落到按星期判周末/工作日。
 */
export async function resolveCampusDayType(env: Env, date: string, weekday: WeekdayColumn): Promise<CampusDayType> {
  const calendars = await loadActiveRuleCalendars(env, date, weekday);
  const ruleTypes = calendars.map((calendar) => calendar.dayType).filter((type) => type !== "other");
  if (ruleTypes.length > 0) return pickDayType(ruleTypes, "weekday");

  const special = await first<{ kind: string }>(
    env.DB,
    "select kind from academic_dates where service_date=? limit 1",
    [date],
  );
  if (special?.kind === "workday_override") return "weekday";
  if (special?.kind === "holiday") return "holiday";
  const term = await first<{ dayType: string }>(
    env.DB,
    "select day_type as dayType from academic_terms where valid_from<=? and valid_to>=? and day_type<>'term' order by sort_order limit 1",
    [date, date],
  );
  if (term && (CAMPUS_DAY_TYPES as readonly string[]).includes(term.dayType)) return term.dayType as CampusDayType;
  return weekday === "saturday" || weekday === "sunday" ? "weekend" : "weekday";
}

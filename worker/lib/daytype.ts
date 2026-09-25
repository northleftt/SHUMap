// 校园级日型判定：「今天是什么日子」的唯一一份算法、唯一一份数据。
//
// 日型标签是校历（0035 的 academic_* 表，管理端「日历管理」维护）的固有属性。
// 校车服务日历只是班次的调度规则（星期勾选 + 例外日期 + 有效期），从来就不是
// 日型来源——这里不读 service_calendars，校车页与就餐页对「今天」必然同口径。
// 特殊日（调休、校庆、临时放假）一律录进校历，不在任何功能侧局部改写。
//
// 判定优先级（规则写死、数据全部可配）：
//   1. 校历调休工作日列表 → weekday
//   2. 校历法定节假日列表 → holiday
//   3. 校历假期区间（winter_break / summer_break）
//   4. 周六日 → weekend（写死，不随校历配置）
//   5. 其余 → weekday

import type { Env } from "../types/cloudflare";
import { first } from "./db";

export type CampusDayType = "weekday" | "weekend" | "holiday" | "winter_break" | "summer_break";

export const CAMPUS_DAY_TYPES: readonly CampusDayType[] = [
  "weekday", "weekend", "holiday", "winter_break", "summer_break",
];

const WEEKDAY_COLUMNS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type WeekdayColumn = (typeof WEEKDAY_COLUMNS)[number];

/** 上海时区的星期列名（Intl 显式时区，不受运行环境 TZ 影响）；date 非法时返回 null。 */
export function shanghaiWeekday(date: string): WeekdayColumn | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "long" })
    .format(new Date(`${date}T12:00:00+08:00`))
    .toLowerCase();
  return (WEEKDAY_COLUMNS as readonly string[]).includes(name) ? (name as WeekdayColumn) : null;
}

/**
 * 解析某天的校园日型。调用方负责给出合法 date（YYYY-MM-DD）与对应 weekday
 * （shanghaiWeekday 的结果）。
 */
export async function resolveCampusDayType(env: Env, date: string, weekday: WeekdayColumn): Promise<CampusDayType> {
  // 同一天可能同时录了 holiday 与 workday_override（unique 含 kind，管理端也
  // 不拦）：必须有确定性优先级，且与管理端预览（src/lib/calendar/dayType.ts）
  // 同口径——调休工作日优先于法定节假日。
  const special = await first<{ kind: string }>(
    env.DB,
    "select kind from academic_dates where service_date=? order by case kind when 'workday_override' then 0 else 1 end limit 1",
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

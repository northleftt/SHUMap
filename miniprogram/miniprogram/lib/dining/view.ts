import { buildCanteens, floorMediaOf, floorOpenStatus, floorStatusLabel, levelShortLabel, MEAL_LABELS, orderCampusKeys, type CanteenView, type DiningFloorView, type DiningScheduleResponse, type MerchantStatusResponse } from "./schedule";
import { groupMerchantsByPlace } from "../release/merchants";
import type { LoadedRelease } from "../release/mapData";
import type { CampusKey } from "../release/types";

export function canteensOf(release: LoadedRelease): CanteenView[] {
  return buildCanteens(release.manifest, release.campuses, groupMerchantsByPlace(release.manifest.merchants));
}

export function floorView(canteen: CanteenView, floor: DiningFloorView, schedule: DiningScheduleResponse | null, statuses: MerchantStatusResponse["statuses"], nowMinutes: number) {
  const status = schedule && (canteen.closed || schedule.dayType === "weekday" || schedule.arrangement) ? floorOpenStatus({ ...schedule, periods: schedule.mealPeriods, floorId: floor.floorId, meals: floor.meals, nowMinutes, placeClosed: canteen.closed }) : null;
  const noBreakfast = Boolean(schedule?.arrangement?.floors.find(row => row.floorId === floor.floorId)?.noBreakfast);
  return {
    ...floor,
    shortLabel: levelShortLabel(floor.levelCode),
    stallText: floor.stallTypes.join(" · "),
    statusText: status ? floorStatusLabel(status) || "" : "",
    merchants: floor.merchants.map(merchant => ({
      ...merchant,
      closed: statuses[merchant.id] === "temporarily_closed",
      subtitle: [merchant.businessType, merchant.openingHours].filter(Boolean).join(" · ") || "营业信息完善中",
      facts: [
        { label: "营业时间", value: merchant.openingHours },
        { label: "档口号", value: merchant.stallCode },
        { label: "人均", value: merchant.avgPrice },
        { label: "联系电话", value: merchant.phone },
      ].filter(fact => fact.value.trim()),
    })),
    mealRows: (["breakfast", "lunner", "latenight"] as const).map(meal => ({
      meal, label: MEAL_LABELS[meal], served: floor.meals.includes(meal) && !(meal === "breakfast" && noBreakfast),
      unavailableText: meal === "breakfast" && noBreakfast ? "今日不供应" : "不供应",
      icon: meal === "breakfast" ? "sunrise" : meal === "lunner" ? "sun" : "moon",
      times: floor.meals.includes(meal) && !(meal === "breakfast" && noBreakfast) ? (schedule?.mealPeriods || []).filter(period => period.meal === meal).map(period => `${period.startTime}–${period.endTime}`).join(" · ") : "",
    })),
    photos: [
      ...(floor.imageUrl ? [{ sourceUrl: floor.imageUrl, label: "平面图" }] : []),
      ...floorMediaOf(canteen.placeId, canteen.content, floor.levelCode).map((sourceUrl, index) => ({ sourceUrl, label: `实拍图 ${index + 1}` })),
    ],
  };
}

export function diningView(canteens: CanteenView[], schedule: DiningScheduleResponse | null, statuses: MerchantStatusResponse["statuses"], nowMinutes: number, located: CampusKey | null, placeId = "", floorId = "") {
  const keys = orderCampusKeys(Array.from(new Set(canteens.map(c => c.campusKey))), located);
  const noArrangement = Boolean(schedule && schedule.dayType !== "weekday" && !schedule.arrangement);
  const canteen = canteens.find(c => c.placeId === placeId) || null;
  const selected = canteen?.floors.find(f => f.floorId === floorId) || canteen?.floors[0] || null;
  const wholeDayRest = Boolean(canteen && (canteen.closed || (schedule?.arrangement && canteen.floors.length > 0 && !canteen.floors.some(f => schedule.arrangement!.floors.some(row => row.floorId === f.floorId)))));
  return {
    noArrangement, wholeDayRest, canteen,
    groups: keys.map(key => ({ key, label: canteens.find(c => c.campusKey === key)!.campusLabel, located: key === located,
      canteens: canteens.filter(c => c.campusKey === key).map(c => ({ ...c, floors: c.floors.map(f => floorView(c, f, schedule, statuses, nowMinutes)) })),
    })),
    floor: canteen && selected ? floorView(canteen, selected, schedule, statuses, nowMinutes) : null,
    floorTabs: (canteen?.floors || []).map(f => ({ id: f.floorId, label: levelShortLabel(f.levelCode), active: f.floorId === selected?.floorId })),
    alternatives: wholeDayRest && schedule && canteen ? canteens.filter(c => c.placeId !== placeId && c.campusKey === canteen.campusKey && c.floors.some(f => floorOpenStatus({ ...schedule, periods: schedule.mealPeriods, floorId: f.floorId, meals: f.meals, nowMinutes, placeClosed: c.closed }).kind !== "rest")).map(c => ({ placeId: c.placeId, name: c.name })) : [],
  };
}

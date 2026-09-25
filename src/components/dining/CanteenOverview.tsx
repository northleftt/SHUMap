import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { SectionHeader } from "../ui/SectionHeader";
import { useRelease } from "../../lib/release/ReleaseContext";
import { groupMerchantsByPlace } from "../../lib/release/merchants";
import { buildCanteens, floorOpenStatus, floorStatusLabel, levelShortLabel, shanghaiMinutes } from "../../lib/dining/schedule";
import { ungroupedMerchants } from "../../lib/dining/facilities";
import { useDiningSchedule, useMerchantStatus } from "../../lib/hooks/useDining";
import { useNow } from "../../lib/hooks/useNow";
import type { MapPoi } from "../../lib/types";
import { DiningFacilities } from "./DiningFacilities";

export function CanteenOverview({ poi, onOpenMerchant, facilityStatuses, facilityError, facilityLoading }: {
  poi: MapPoi; onOpenMerchant: (id: string) => void;
  facilityStatuses: Record<string, string> | null; facilityError?: string; facilityLoading: boolean;
}) {
  const release = useRelease().release;
  const now = useNow();
  const scheduleState = useDiningSchedule();
  const merchantState = useMerchantStatus();
  const navigate = useNavigate();
  const canteen = useMemo(() => release ? buildCanteens(release.manifest, release.campuses, groupMerchantsByPlace(release.manifest.merchants)).find(c => c.placeId === poi.entityId) : null, [release, poi.entityId]);
  const floors = canteen?.floors ?? [];
  const schedule = scheduleState.status === "ready" ? scheduleState.schedule : null;
  const noArrangement = schedule && schedule.dayType !== "weekday" && !schedule.arrangement;
  const others = ungroupedMerchants(poi.merchants, floors);
  const openFloor = (floorId?: string) => navigate(`/places/${encodeURIComponent(poi.entityId)}/dining${floorId ? `?floor=${encodeURIComponent(floorId)}` : ""}`);
  const closed = (id: string) => merchantState.status === "ready" && merchantState.statuses[id] === "temporarily_closed";
  return <div data-testid="canteen-overview">
    <section className="mt-4">
      <SectionHeader title="楼层与档口" action={<button type="button" className="text-primary" onClick={() => openFloor()}>查看供餐详情 ›</button>} />
      {scheduleState.status === "error" && <p className="mt-2 text-aux text-error">就餐时段与开放安排加载失败，请稍后重试</p>}
      {merchantState.status === "error" && <p className="mt-2 text-aux text-error">商家营业状态加载失败，请稍后重试</p>}
      {noArrangement && <p className="mt-2 text-aux text-sub">今日暂无就餐安排信息</p>}
      {!floors.length && <p className="mt-3 text-aux text-sub">该食堂的楼层信息正在完善中</p>}
      <div className="mt-2 divide-y divide-line">
        {floors.map(floor => {
          const status = schedule && (!noArrangement || canteen?.closed) ? floorStatusLabel(floorOpenStatus({ ...schedule, periods: schedule.mealPeriods, floorId: floor.floorId, meals: floor.meals, nowMinutes: shanghaiMinutes(now), placeClosed: Boolean(canteen?.closed) })) : null;
          return <div className="flex items-start gap-3 py-3" key={floor.floorId}>
            <button type="button" onClick={() => openFloor(floor.floorId)} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary-container font-semibold text-primary" aria-label={`查看${floor.displayName}`}>{levelShortLabel(floor.levelCode)}</button>
            <div className="min-w-0 flex-1">
              <button type="button" className="w-full text-left" onClick={() => openFloor(floor.floorId)}>
                <span className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1"><span className="text-body font-semibold">{floor.displayName}</span>{status && <span className="text-aux text-sub">{status}</span>}</span>
                {floor.stallTypes.length > 0 && <span className="mt-0.5 block break-words text-aux text-sub">{floor.stallTypes.join(" · ")}</span>}
              </button>
              <div className="mt-1.5 flex flex-wrap gap-1.5">{floor.merchants.map(m => <button key={m.id} type="button" onClick={() => onOpenMerchant(m.id)} className={`max-w-full break-words rounded-full px-2.5 py-1 text-left text-label ${closed(m.id) ? "bg-page text-sub line-through" : "bg-primary-container text-primary"}`}>{m.name}{m.openingHours ? ` ${m.openingHours}` : ""}</button>)}</div>
            </div>
          </div>;
        })}
      </div>
    </section>
    {others.length > 0 && <section className="mt-4"><SectionHeader title="其他商户" /><div className="divide-y divide-line">{others.map(m => <button key={m.id} type="button" onClick={() => onOpenMerchant(m.id)} className="flex w-full items-center gap-2 py-3 text-left"><span className="min-w-0 flex-1"><span className={`block font-semibold ${closed(m.id) ? "text-sub line-through" : ""}`}>{m.name}</span><span className="mt-0.5 block break-words text-aux text-sub">{["未标注公开楼层", m.openingHours].filter(Boolean).join(" · ")}</span></span><span className="text-sub">›</span></button>)}</div></section>}
    <DiningFacilities facilities={poi.facilities} floors={floors} statuses={facilityStatuses} error={facilityError} loading={facilityLoading} placeId={poi.entityId} iconKeyByTypeCode={release ? new Map(release.manifest.facilityTypes.map(type => [type.code, type.iconKey])) : undefined} />
  </div>;
}

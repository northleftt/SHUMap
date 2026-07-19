import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import { getPlace } from "../../lib/api/public";
import type { PublicPlaceFacility, PublicPlaceFloor } from "../../lib/api/types";
import { facilityDotColor } from "../../lib/facilityIcons";
import { useAsyncData } from "../../lib/hooks/useAsyncData";

const KIND_LABELS: Record<string, string> = {
  kind_building: "建筑",
  kind_outdoor: "室外区域",
  kind_service: "服务地点",
  kind_transit: "交通站点",
  kind_sports: "运动场馆",
  kind_residence: "宿舍",
  kind_other: "其他",
};

/** 设施位置描述：约定 content.locationDescription，兼容历史字段。 */
function locationDescription(facility: PublicPlaceFacility): string {
  const content = facility.content ?? {};
  for (const key of ["locationDescription", "location", "position", "hint"]) {
    const value = content[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** 楼层信息提示：约定 place.content.floorNotes，兜底 detail.facilityNotes。 */
function floorNotes(content: Record<string, unknown>): string {
  const direct = content.floorNotes;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const detail = content.detail;
  if (detail && typeof detail === "object") {
    const notes = (detail as Record<string, unknown>).facilityNotes;
    if (typeof notes === "string" && notes.trim()) return notes.trim();
  }
  return "";
}

function floorLabel(floor: PublicPlaceFloor): string {
  return floor.displayName?.trim() || floor.levelCode;
}

/** M4 楼层设施（列表版；平面图版 M5 槽位预留）。 */
export function FloorsPage() {
  const { placeId = "" } = useParams();
  const { state } = useAsyncData((signal) => getPlace(placeId, signal), [placeId]);
  const [activeFloorId, setActiveFloorId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<string | null>(null);

  const data = state.status === "ready" ? state.data : undefined;
  const floors = useMemo(() => data?.floors ?? [], [data]);
  const facilities = useMemo(() => data?.facilities ?? [], [data]);

  // 默认选中一层（levelOrder 最小且非地下）
  const selectedFloorId = activeFloorId ?? floors[0]?.id ?? null;

  const floorFacilities = useMemo(() => {
    if (!selectedFloorId) return facilities;
    return facilities.filter((facility) => facility.floorId === selectedFloorId);
  }, [facilities, selectedFloorId]);

  const typeChips = useMemo(() => {
    const seen = new Map<string, string>();
    for (const facility of floorFacilities) {
      if (!seen.has(facility.typeCode)) seen.set(facility.typeCode, facility.typeName);
    }
    return Array.from(seen.entries());
  }, [floorFacilities]);

  const visibleFacilities = useMemo(
    () => (activeType ? floorFacilities.filter((f) => f.typeCode === activeType) : floorFacilities),
    [floorFacilities, activeType],
  );

  if (state.status === "loading") {
    return (
      <div className="h-full bg-page">
        <LoadingState label="正在加载楼层设施…" />
      </div>
    );
  }
  if (state.status === "error" || !data) {
    return (
      <div className="h-full bg-page px-5 pt-16">
        <EmptyState title="楼宇信息加载失败" subtitle={state.message ?? "请稍后重试"} />
      </div>
    );
  }

  const notes = floorNotes(data.place.content);
  const kindLabel = KIND_LABELS[data.place.kindId] ?? "建筑";

  return (
    <div className="flex h-full flex-col bg-page">
      <div className="mx-auto flex h-full w-full max-w-[780px] flex-col">
        <PageHeader
          title={`${data.place.displayName} · 楼层设施`}
          subtitle={floors.length > 0 ? `${kindLabel} · 共 ${floors.length} 层` : kindLabel}
        />

        <div className="flex-1 overflow-y-auto pb-6">
        {/* 楼层切换 pills */}
        {floors.length > 1 ? (
          <div className="scrollbar-hidden flex gap-2 overflow-x-auto px-4 pt-3">
            {floors.map((floor) => {
              const active = floor.id === selectedFloorId;
              return (
                <button
                  key={floor.id}
                  type="button"
                  className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl text-body font-semibold ${
                    active ? "bg-primary text-white" : "bg-surface text-ink active:bg-line"
                  }`}
                  onClick={() => {
                    setActiveFloorId(floor.id);
                    setActiveType(null);
                  }}
                >
                  {floorLabel(floor)}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* 信息提示 */}
        {notes ? (
          <div className="mx-4 mt-3 rounded-2xl bg-primary-container px-4 py-3.5">
            <div className="text-label text-sub">信息提示</div>
            <div className="mt-1 whitespace-pre-line text-body font-medium leading-relaxed text-primary">
              {notes}
            </div>
          </div>
        ) : null}

        {/* 设施类别 chips */}
        {typeChips.length > 0 ? (
          <ChipRow className="px-4 pt-3">
            <Chip active={activeType === null} variant="outline" onClick={() => setActiveType(null)}>
              全部
            </Chip>
            {typeChips.map(([code, name]) => (
              <Chip key={code} active={activeType === code} variant="outline" onClick={() => setActiveType(code)}>
                {name}
              </Chip>
            ))}
          </ChipRow>
        ) : null}

        {/* 设施列表 */}
        <div className="mx-4 mt-3 overflow-hidden rounded-2xl bg-surface shadow-card">
          {visibleFacilities.length === 0 ? (
            <EmptyState
              title="该楼层暂无设施信息"
              subtitle={facilities.length === 0 ? "该楼宇的设施信息正在完善中" : "试试切换楼层或类别"}
            />
          ) : (
            visibleFacilities.map((facility, index) => (
              <div
                key={facility.id}
                className={`flex items-center gap-3 px-4 py-3.5 ${index > 0 ? "border-t border-line" : ""}`}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: facilityDotColor(index) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-body font-semibold text-ink">
                    {facility.displayName || facility.typeName}
                  </div>
                  {locationDescription(facility) ? (
                    <div className="mt-0.5 truncate text-aux text-sub">{locationDescription(facility)}</div>
                  ) : null}
                </div>
                <span className="text-sub">›</span>
              </div>
            ))
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

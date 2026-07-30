import { LayoutList, Map as MapIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { FloorPlanCanvas, type FloorPlanAnchor } from "../../components/map/FloorPlanCanvas";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import { getPlace } from "../../lib/api/public";
import type { PublicPlaceFacility, PublicPlaceFloor, ReleaseManifest } from "../../lib/api/types";
import { facilityDotColor, facilityIcon } from "../../lib/facilityIcons";
import { useAsyncData } from "../../lib/hooks/useAsyncData";
import { facilityAnchorsForFloor, floorMapVersionsByFloor } from "../../lib/release/floorPlans";
import { useRelease } from "../../lib/release/ReleaseContext";
// 类目中文名只维护一份（此前这里有一张同样写错前缀的副本）。
import { KIND_LABELS } from "../map/category";

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

/**
 * 楼层列表：优先用 release manifest 的 floors（发布态的权威骨架），缺失时回退到
 * 详情接口。manifest 是内容的唯一发布源，但早于 floors 字段的 artifact 里没有它，
 * 所以两条路都要留着。
 */
function resolveFloors(
  manifest: ReleaseManifest | null,
  placeId: string,
  fallback: PublicPlaceFloor[],
): PublicPlaceFloor[] {
  const fromManifest = (manifest?.floors ?? [])
    .filter((floor) => floor.buildingPlaceId === placeId && floor.isPublic !== 0)
    .map((floor) => ({
      id: floor.id,
      levelCode: floor.levelCode,
      levelOrder: floor.levelOrder,
      displayName: floor.displayName,
    }));
  if (!fromManifest.length) return fallback;
  return fromManifest.sort((a, b) => a.levelOrder - b.levelOrder);
}

/**
 * 采集上来的楼层照片：审核采纳时按「楼层编号 → 已发布照片地址」写进
 * place content.floorMedia（floors 表没有照片列，也不该为此加列）。
 */
function floorMediaOf(content: Record<string, unknown>, levelCode: string): string[] {
  const media = content.floorMedia;
  if (!media || typeof media !== "object" || Array.isArray(media)) return [];
  const urls = (media as Record<string, unknown>)[levelCode];
  if (!Array.isArray(urls)) return [];
  return urls.filter((url): url is string => typeof url === "string" && url.trim().length > 0);
}

type ViewMode = "list" | "plan";

/**
 * M4/M5 楼层设施：列表版 + 平面图版。
 *
 * 楼层设施数据来自 GET /api/public/places/:id；平面图底图与设施锚点来自 active
 * release manifest（maps[] / locations[]），底图 SVG 走
 * GET /api/public/maps/:mapVersionId/asset。当前楼层没有已发布图纸时平面图入口
 * 隐藏，页面退回列表版，不报错。
 */
export function FloorsPage() {
  const { placeId = "" } = useParams();
  const { state } = useAsyncData((signal) => getPlace(placeId, signal), [placeId]);
  const { release } = useRelease();
  const [activeFloorId, setActiveFloorId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedFacilityId, setSelectedFacilityId] = useState<string | null>(null);

  const data = state.status === "ready" ? state.data : undefined;
  const manifest = release?.manifest ?? null;
  const floors = useMemo(
    () => resolveFloors(manifest, placeId, data?.floors ?? []),
    [manifest, placeId, data],
  );
  const facilities = useMemo(() => data?.facilities ?? [], [data]);
  const planByFloor = useMemo(() => floorMapVersionsByFloor(manifest), [manifest]);

  // 默认选中一层（levelOrder 最小且非地下）
  const selectedFloorId = activeFloorId ?? floors[0]?.id ?? null;
  const floorPlan = selectedFloorId ? planByFloor.get(selectedFloorId) ?? null : null;
  // 该楼层无已发布图纸 → 平面图入口隐藏，内容回退列表版。
  const effectiveMode: ViewMode = floorPlan ? viewMode : "list";

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

  /** 徽章 = 锚点 ⋈ 本层可见设施；锚点数据缺失时为空数组（只渲染图纸）。 */
  const planAnchors = useMemo<FloorPlanAnchor[]>(() => {
    if (!floorPlan || !selectedFloorId) return [];
    const byId = new Map(visibleFacilities.map((facility) => [facility.id, facility]));
    return facilityAnchorsForFloor(manifest, selectedFloorId, floorPlan.id)
      .map((anchor) => {
        const facility = byId.get(anchor.facilityId);
        if (!facility) return null;
        return {
          id: anchor.id,
          facilityId: anchor.facilityId,
          x: anchor.x,
          y: anchor.y,
          label: facility.displayName || facility.typeName,
          typeCode: facility.typeCode,
        } satisfies FloorPlanAnchor;
      })
      .filter((anchor): anchor is FloorPlanAnchor => anchor !== null);
  }, [floorPlan, manifest, selectedFloorId, visibleFacilities]);

  const selectedFacility = useMemo(
    () => visibleFacilities.find((facility) => facility.id === selectedFacilityId) ?? null,
    [visibleFacilities, selectedFacilityId],
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
  const selectedFloor = floors.find((floor) => floor.id === selectedFloorId) ?? null;
  const floorPhotos = selectedFloor ? floorMediaOf(data.place.content, selectedFloor.levelCode) : [];
  const SelectedIcon = selectedFacility ? facilityIcon(selectedFacility.typeCode) : null;

  function switchFloor(floorId: string) {
    setActiveFloorId(floorId);
    setActiveType(null);
    setSelectedFacilityId(null);
  }

  return (
    <div className="flex h-full flex-col bg-page">
      <div className="mx-auto flex h-full w-full max-w-[780px] flex-col">
        <PageHeader
          title={`${data.place.displayName} · 楼层设施`}
          subtitle={floors.length > 0 ? `${kindLabel} · 共 ${floors.length} 层` : kindLabel}
          right={
            floorPlan ? (
              <div className="flex shrink-0 overflow-hidden rounded-full bg-page p-0.5">
                {(
                  [
                    ["list", "列表", LayoutList],
                    ["plan", "平面图", MapIcon],
                  ] as const
                ).map(([mode, label, Icon]) => (
                  <button
                    key={mode}
                    aria-pressed={effectiveMode === mode}
                    className={`flex h-8 items-center gap-1 rounded-full px-3 text-aux ${
                      effectiveMode === mode ? "bg-primary text-white" : "text-sub"
                    }`}
                    onClick={() => setViewMode(mode)}
                    type="button"
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
              </div>
            ) : null
          }
        />

        <div className={effectiveMode === "plan" ? "flex min-h-0 flex-1 flex-col" : "flex-1 overflow-y-auto pb-6"}>
          {/* 楼层切换 pills */}
          {floors.length > 1 ? (
            <div className="scrollbar-hidden flex shrink-0 gap-2 overflow-x-auto px-4 pt-3">
              {floors.map((floor) => {
                const active = floor.id === selectedFloorId;
                return (
                  <button
                    key={floor.id}
                    type="button"
                    className={`relative grid h-11 w-11 shrink-0 place-items-center rounded-xl text-body font-semibold ${
                      active ? "bg-primary text-white" : "bg-surface text-ink active:bg-line"
                    }`}
                    onClick={() => switchFloor(floor.id)}
                  >
                    {floorLabel(floor)}
                    {/* 有平面图的楼层加角标，切层前就能看出哪层有图 */}
                    {planByFloor.has(floor.id) ? (
                      <span
                        className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${
                          active ? "bg-white" : "bg-primary"
                        }`}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* 信息提示（仅列表版；平面图态优先给图纸留高度） */}
          {notes && effectiveMode === "list" ? (
            <div className="mx-4 mt-3 rounded-2xl bg-primary-container px-4 py-3.5">
              <div className="text-label text-sub">信息提示</div>
              <div className="mt-1 whitespace-pre-line text-body font-medium leading-relaxed text-primary">
                {notes}
              </div>
            </div>
          ) : null}

          {/* 本层实拍（采集照片，仅列表版） */}
          {effectiveMode === "list" && floorPhotos.length > 0 ? (
            <div className="scrollbar-hidden mt-3 flex gap-2 overflow-x-auto px-4">
              {floorPhotos.map((url, index) => (
                <img
                  alt={`${selectedFloor ? floorLabel(selectedFloor) : ""} 实拍图 ${index + 1}`}
                  className="h-28 w-40 shrink-0 rounded-xl object-cover"
                  key={url}
                  loading={index === 0 ? "eager" : "lazy"}
                  src={url}
                />
              ))}
            </div>
          ) : null}

          {/* 设施类别 chips（横滑，两态共用） */}
          {typeChips.length > 0 ? (
            <ChipRow className="shrink-0 px-4 pt-3">
              <Chip active={activeType === null} variant="outline" onClick={() => { setActiveType(null); setSelectedFacilityId(null); }}>
                全部
              </Chip>
              {typeChips.map(([code, name]) => (
                <Chip
                  key={code}
                  active={activeType === code}
                  variant="outline"
                  onClick={() => { setActiveType(code); setSelectedFacilityId(null); }}
                >
                  {name}
                </Chip>
              ))}
            </ChipRow>
          ) : null}

          {effectiveMode === "plan" && floorPlan ? (
            <div className="relative mx-4 mb-4 mt-3 min-h-0 flex-1 overflow-hidden rounded-2xl bg-surface shadow-card">
              <FloorPlanCanvas
                anchors={planAnchors}
                mapVersionId={floorPlan.id}
                onSelectFacility={setSelectedFacilityId}
                selectedFacilityId={selectedFacilityId}
              />
              {/* 无锚点数据时只渲染图纸，并说明原因，避免看起来像加载失败 */}
              {planAnchors.length === 0 ? (
                <div className="pointer-events-none absolute left-3 right-3 top-3 rounded-xl bg-surface/90 px-3 py-2 text-aux text-sub shadow-card">
                  该楼层图纸暂无设施标注，可切换到列表查看 {floorFacilities.length} 项设施
                </div>
              ) : null}
              {/* 点徽章弹小卡 */}
              {selectedFacility ? (
                <div className="absolute bottom-3 left-3 right-16 rounded-2xl bg-surface px-4 py-3 shadow-card">
                  <div className="flex items-center gap-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-container text-primary">
                      {SelectedIcon ? <SelectedIcon size={16} /> : null}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body font-semibold text-ink">
                        {selectedFacility.displayName || selectedFacility.typeName}
                      </div>
                      <div className="truncate text-aux text-sub">
                        {locationDescription(selectedFacility) || selectedFacility.typeName}
                      </div>
                    </div>
                    <button
                      aria-label="关闭"
                      className="shrink-0 text-sub"
                      onClick={() => setSelectedFacilityId(null)}
                      type="button"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            /* 设施列表 */
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
                    className={`flex items-center gap-3 px-4 py-3.5 ${index > 0 ? "border-t border-line" : ""} ${
                      facility.id === selectedFacilityId ? "bg-primary-container" : ""
                    }`}
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
          )}
        </div>
      </div>
    </div>
  );
}

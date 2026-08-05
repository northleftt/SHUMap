import { LayoutList, Map as MapIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { FloorPlanCanvas, type FloorPlanAnchor } from "../../components/map/FloorPlanCanvas";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import { ImagePreview } from "../../components/ui/ImagePreview";
import type { PublicPlaceFacility, PublicPlaceFloor, ReleaseManifest } from "../../lib/api/types";
import { facilityDotColor, facilityIcon } from "../../lib/facilityIcons";
import { facilityStatusLabel, resolveFacilityStatus, useFacilityStatus } from "../../lib/hooks/useFacilityStatus";
import { facilityAnchorsForFloor, floorMapVersionsByFloor } from "../../lib/release/floorPlans";
import { releaseFacilitiesForPlace } from "../../lib/release/mapData";
import { useRelease } from "../../lib/release/ReleaseContext";
// 类目中文名只维护一份（此前这里有一张同样写错前缀的副本）。

/** 设施位置描述只读取 canonical content.locationDescription。 */
function locationDescription(facility: PublicPlaceFacility): string {
  const value = facility.content.locationDescription;
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`Facility ${facility.id} locationDescription must be a string`);
  return value.trim();
}

function facilityMedia(facility: PublicPlaceFacility): Array<{ url: string; alt: string }> {
  const value = facility.content.media;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Facility ${facility.id} content.media must be an array`);
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Facility ${facility.id} content.media[${index}] must be an object`);
    }
    const url = (raw as Record<string, unknown>).url;
    if (typeof url !== "string" || !url.trim()) {
      throw new Error(`Facility ${facility.id} content.media[${index}].url must be a non-empty string`);
    }
    const alt = (raw as Record<string, unknown>).alt;
    if (alt !== undefined && typeof alt !== "string") {
      throw new Error(`Facility ${facility.id} content.media[${index}].alt must be a string`);
    }
    return { url, alt: typeof alt === "string" ? alt.trim() : "" };
  });
}

/** 楼层信息提示来自 canonical detail.facts 的“楼层说明”。 */
function floorNotes(content: Record<string, unknown>): string {
  const detail = content.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error("Place content.detail must be an object");
  }
  const facts = (detail as Record<string, unknown>).facts;
  if (!Array.isArray(facts)) throw new Error("Place detail.facts must be an array");
  const rows = facts.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Place detail.facts[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.label !== "string" || typeof row.value !== "string") {
      throw new Error(`Place detail.facts[${index}] must contain string label and value`);
    }
    return row;
  });
  const row = rows.find((item) => item.label === "楼层说明");
  return row ? String(row.value).trim() : "";
}

function floorLabel(floor: PublicPlaceFloor): string {
  if (typeof floor.displayName !== "string" || !floor.displayName.trim()) {
    throw new Error(`Floor ${floor.id} has an empty display name`);
  }
  return floor.displayName.trim();
}

/** 楼层列表：只认 release manifest 的 floors（发布态的权威骨架）。 */
function resolveFloors(manifest: ReleaseManifest, placeId: string): PublicPlaceFloor[] {
  return manifest.floors
    .filter((floor) => floor.buildingPlaceId === placeId && floor.isPublic !== 0)
    .map((floor) => ({
      id: floor.id,
      levelCode: floor.levelCode,
      levelOrder: floor.levelOrder,
      displayName: floor.displayName,
    }))
    .sort((a, b) => a.levelOrder - b.levelOrder);
}

/**
 * 采集上来的楼层照片存为 canonical detail.media，并以 floorLevelCode 关联楼层。
 */
function floorMediaOf(content: Record<string, unknown>, levelCode: string): string[] {
  const detail = content.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error("Place content.detail must be an object");
  }
  const media = (detail as Record<string, unknown>).media;
  if (!Array.isArray(media)) throw new Error("Place detail.media must be an array");
  const urls: string[] = [];
  for (const [index, item] of media.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Place detail.media[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.url !== "string" || !row.url.trim()) {
      throw new Error(`Place detail.media[${index}].url must be a non-empty string`);
    }
    if (row.floorLevelCode !== undefined && typeof row.floorLevelCode !== "string") {
      throw new Error(`Place detail.media[${index}].floorLevelCode must be a string`);
    }
    if (row.floorLevelCode === levelCode) urls.push(row.url);
  }
  return urls;
}

type ViewMode = "list" | "plan";

/**
 * M4/M5 楼层设施：列表版 + 平面图版。
 *
 * 楼宇、楼层、设施骨架与平面图底图/锚点全部来自 active release manifest
 * （places[] / floors[] / facilities[] / facilityTypes[] / maps[] / locations[]），
 * 底图 SVG 走 GET /api/public/maps/:mapVersionId/asset。设施的运营状态另走
 * GET /api/public/facility-status 实时覆盖。当前楼层没有已发布图纸时平面图入口
 * 隐藏，页面退回列表版，不报错。
 */
export function FloorsPage() {
  const { placeId = "" } = useParams();
  const releaseState = useRelease();
  if (releaseState.status === "loading") {
    return (
      <div className="h-full bg-page">
        <LoadingState label="正在加载楼层设施…" />
      </div>
    );
  }
  if (releaseState.status !== "ready") {
    return (
      <div className="h-full bg-page px-5 pt-16">
        <EmptyState
          title={releaseState.status === "error" ? "楼宇信息加载失败" : "暂无该楼宇信息"}
          subtitle={releaseState.status === "error" ? "请稍后重试" : undefined}
        />
      </div>
    );
  }
  return <ReadyFloorsPage manifest={releaseState.release.manifest} placeId={placeId} />;
}

function ReadyFloorsPage({ manifest, placeId }: { manifest: ReleaseManifest; placeId: string }) {
  const [activeFloorId, setActiveFloorId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedFacilityId, setSelectedFacilityId] = useState<string | null>(null);
  // 运营状态盖在快照基线上，读取失败时在列表上方明确提示。
  const facilityStatus = useFacilityStatus();

  const place = useMemo(
    () => manifest.places.find((row) => row.id === placeId) ?? null,
    [manifest, placeId],
  );
  const floors = useMemo(() => resolveFloors(manifest, placeId), [manifest, placeId]);
  const facilities = useMemo(() => releaseFacilitiesForPlace(manifest, placeId), [manifest, placeId]);
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

  if (!place) {
    return (
      <div className="h-full bg-page px-5 pt-16">
        <EmptyState title="暂无该楼宇信息" />
      </div>
    );
  }

  if (!place.content) throw new Error(`Release place ${place.id} has no canonical content`);
  const placeContent = place.content;
  const notes = floorNotes(placeContent);
  const kindLabel = place.kindName;
  const selectedFloor = floors.find((floor) => floor.id === selectedFloorId) ?? null;
  const floorPhotos = selectedFloor ? floorMediaOf(placeContent, selectedFloor.levelCode) : [];
  const SelectedIcon = selectedFacility ? facilityIcon(selectedFacility.typeCode) : null;
  const selectedFacilityStatusLabel = selectedFacility && facilityStatus.status === "ready"
    ? facilityStatusLabel(resolveFacilityStatus(facilityStatus.statuses, selectedFacility.id))
    : null;
  const selectedFacilityPhoto = selectedFacility ? facilityMedia(selectedFacility)[0] : null;

  function switchFloor(floorId: string) {
    setActiveFloorId(floorId);
    setActiveType(null);
    setSelectedFacilityId(null);
  }

  return (
    <div className="flex h-full flex-col bg-page">
      <div className="mx-auto flex h-full w-full max-w-[780px] flex-col">
        <PageHeader
          title={`${place.displayName} · 楼层设施`}
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
          {facilityStatus.status === "error" ? (
            <div className="mx-4 mt-3 rounded-2xl bg-error-bg px-4 py-3 text-aux text-error">
              设施实时状态加载失败：{facilityStatus.message}
            </div>
          ) : facilityStatus.status === "loading" && facilities.length > 0 ? (
            <div className="mx-4 mt-3 rounded-2xl bg-page px-4 py-3 text-aux text-sub">正在加载设施实时状态…</div>
          ) : null}
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
                <ImagePreview
                  alt={`${selectedFloor ? floorLabel(selectedFloor) : ""} 实拍图 ${index + 1}`}
                  buttonClassName="h-28 w-40 shrink-0 rounded-xl"
                  imageClassName="h-full w-full object-cover"
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
                  {selectedFacilityPhoto ? (
                    <ImagePreview
                      alt={selectedFacilityPhoto.alt || selectedFacility.displayName || selectedFacility.typeName}
                      buttonClassName="mb-2 h-24 w-full rounded-xl"
                      imageClassName="h-full w-full object-cover"
                      src={selectedFacilityPhoto.url}
                    />
                  ) : null}
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
                      {selectedFacilityStatusLabel ? (
                        <div className="mt-0.5 text-label text-warning">{selectedFacilityStatusLabel}</div>
                      ) : null}
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
                visibleFacilities.map((facility, index) => {
                  const facilityPhoto = facilityMedia(facility)[0] ?? null;
                  const statusLabel = facilityStatus.status === "ready"
                    ? facilityStatusLabel(resolveFacilityStatus(facilityStatus.statuses, facility.id))
                    : null;
                  return (
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
                      {facilityPhoto ? (
                        <ImagePreview
                          alt={facilityPhoto.alt || facility.displayName || facility.typeName}
                          buttonClassName="h-10 w-14 shrink-0 rounded-lg"
                          imageClassName="h-full w-full object-cover"
                          src={facilityPhoto.url}
                        />
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-body font-semibold text-ink">
                            {facility.displayName || facility.typeName}
                          </span>
                          {statusLabel ? (
                            <span className="shrink-0 rounded-full bg-warning-bg px-2 py-0.5 text-label text-warning">
                              {statusLabel}
                            </span>
                          ) : null}
                        </div>
                        {locationDescription(facility) ? (
                          <div className="mt-0.5 truncate text-aux text-sub">{locationDescription(facility)}</div>
                        ) : null}
                      </div>
                      <span className="text-sub">›</span>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

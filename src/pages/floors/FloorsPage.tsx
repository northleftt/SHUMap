import { LayoutList, Map as MapIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { FloorImageViewer } from "../../components/map/FloorImageViewer";
import { Chip, ChipRow } from "../../components/ui/Chip";
import { EmptyState, LoadingState } from "../../components/ui/EmptyState";
import { PageHeader } from "../../components/ui/PageHeader";
import { ImagePreview } from "../../components/ui/ImagePreview";
import type { PublicPlaceFacility, PublicPlaceFloor, ReleaseManifest } from "../../lib/api/types";
import { useBreakpoint } from "../../lib/hooks/useBreakpoint";
import { usePageView } from "../../lib/analytics";
import { facilityDotColor } from "../../lib/facilityIcons";
import { facilityStatusLabel, resolveFacilityStatus, useFacilityStatus } from "../../lib/hooks/useFacilityStatus";
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

/** 楼层列表：只认 release manifest 的 floors（发布态的权威骨架），imageUrl 是该层平面图位图。 */
function resolveFloors(manifest: ReleaseManifest, placeId: string): PublicPlaceFloor[] {
  return manifest.floors
    .filter((floor) => floor.buildingPlaceId === placeId && floor.isPublic !== 0)
    .map((floor) => ({
      id: floor.id,
      levelCode: floor.levelCode,
      levelOrder: floor.levelOrder,
      displayName: floor.displayName,
      imageUrl: floor.imageUrl,
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
 * 楼宇、楼层、设施骨架全部来自 active release manifest（places[] / floors[] /
 * facilities[] / facilityTypes[]），平面图是每层一张位图（floors[].imageUrl →
 * /api/public/media/<id>）。设施的运营状态另走 GET /api/public/facility-status
 * 实时覆盖。当前楼层没有上传平面图时平面图入口隐藏，页面退回列表版，不报错。
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
  const wide = useBreakpoint() === "desktop";
  const [searchParams] = useSearchParams();
  const [activeFloorId, setActiveFloorId] = useState<string | null>(searchParams.get("floor"));
  const [activeType, setActiveType] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(searchParams.get("view") === "plan" ? "plan" : "list");
  usePageView("floors");
  // 运营状态盖在快照基线上，读取失败时在列表上方明确提示。
  const facilityStatus = useFacilityStatus();

  const place = useMemo(
    () => manifest.places.find((row) => row.id === placeId) ?? null,
    [manifest, placeId],
  );
  const floors = useMemo(() => resolveFloors(manifest, placeId), [manifest, placeId]);
  const facilities = useMemo(() => releaseFacilitiesForPlace(manifest, placeId), [manifest, placeId]);
  // 有平面图位图的楼层：平面图入口与角标都以 imageUrl 为准
  const imageByFloor = useMemo(() => {
    const map = new Map<string, string>();
    for (const floor of floors) {
      if (floor.imageUrl) map.set(floor.id, floor.imageUrl);
    }
    return map;
  }, [floors]);

  const allFloors = activeFloorId === "all";
  // 默认选中一层（levelOrder 最小且非地下）
  const selectedFloorId = allFloors ? null : floors.some(floor => floor.id === activeFloorId) ? activeFloorId : floors[0]?.id ?? null;
  const floorImageUrl = selectedFloorId ? imageByFloor.get(selectedFloorId) ?? null : null;
  // 该楼层无平面图 → 平面图入口隐藏，内容回退列表版。
  const effectiveMode: ViewMode = floorImageUrl ? viewMode : "list";

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

  function switchFloor(floorId: string) {
    setActiveFloorId(floorId);
    setActiveType(null);
  }

  return (
    <div className="flex h-full flex-col bg-page">
      <div className="mx-auto flex h-full w-full max-w-[780px] flex-col lg:max-w-none">
        <PageHeader
          title={`${place.displayName} · 楼层设施`}
          subtitle={floors.length > 0 ? `${kindLabel} · 共 ${floors.length} 层` : kindLabel}
          right={
            floorImageUrl && !wide ? (
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

        <div className={wide || effectiveMode === "plan" ? "flex min-h-0 flex-1 flex-col" : "min-h-0 flex-1 overflow-y-auto pb-6"}>
          {/* 楼层切换 pills */}
          {floors.length > 0 ? (
            <div className="scrollbar-hidden flex shrink-0 gap-2 overflow-x-auto px-4 pt-3">
              <button type="button" onClick={() => switchFloor("all")} className={`h-11 shrink-0 rounded-xl px-3 text-body font-semibold ${allFloors ? "bg-primary text-white" : "bg-surface text-ink"}`}>全部楼层</button>
              {floors.map((floor) => {
                const active = floor.id === selectedFloorId;
                return (
                  <button
                    key={floor.id}
                    type="button"
                    className={`relative grid h-11 min-w-11 shrink-0 place-items-center whitespace-nowrap rounded-xl px-3 text-body font-semibold ${
                      active ? "bg-primary text-white" : "bg-surface text-ink active:bg-line"
                    }`}
                    onClick={() => switchFloor(floor.id)}
                  >
                    {floorLabel(floor)}
                    {/* 有平面图的楼层加角标，切层前就能看出哪层有图 */}
                    {imageByFloor.has(floor.id) ? (
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
          {notes && (wide || effectiveMode === "list") ? (
            <div className="mx-4 mt-3 rounded-2xl bg-primary-container px-4 py-3.5">
              <div className="text-label text-sub">信息提示</div>
              <div className="mt-1 whitespace-pre-line text-body font-medium leading-relaxed text-primary">
                {notes}
              </div>
            </div>
          ) : null}

          {/* 本层实拍（采集照片，仅列表版） */}
          {!wide && effectiveMode === "list" && floorPhotos.length > 0 ? (
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
              <Chip active={activeType === null} variant="outline" onClick={() => setActiveType(null)}>
                全部
              </Chip>
              {typeChips.map(([code, name]) => (
                <Chip
                  key={code}
                  active={activeType === code}
                  variant="outline"
                  onClick={() => setActiveType(code)}
                >
                  {name}
                </Chip>
              ))}
            </ChipRow>
          ) : null}

          <div data-testid="floor-workspace" className={wide ? `grid min-h-0 flex-1 gap-4 p-4 ${floorImageUrl ? "grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_360px]" : "grid-cols-1"}` : effectiveMode === "plan" ? "flex min-h-0 flex-1 flex-col" : ""}>
          {(wide || effectiveMode === "plan") && floorImageUrl ? (
            <div data-testid="floor-plan-pane" className="relative mx-4 mb-4 mt-3 min-h-0 flex-1 overflow-hidden rounded-2xl bg-surface shadow-card lg:m-0">
              <FloorImageViewer
                alt={`${place.displayName}${selectedFloor ? ` · ${floorLabel(selectedFloor)}` : ""} 平面图`}
                src={floorImageUrl}
              />
            </div>
          ) : null}
          {wide || effectiveMode !== "plan" || !floorImageUrl ? (
            /* 设施列表 */
            <div data-testid="floor-facility-pane" className="mx-4 mt-3 overflow-hidden rounded-2xl bg-surface shadow-card lg:m-0 lg:min-h-0 lg:overflow-y-auto">
              {wide ? <h2 className="px-4 pb-1 pt-4 text-emphasis">{selectedFloor ? `${floorLabel(selectedFloor)} · 本层设施` : "楼层设施"}</h2> : null}
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
                      className={`flex items-center gap-3 px-4 py-3.5 ${index > 0 ? "border-t border-line" : ""}`}
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
                        {allFloors || locationDescription(facility) ? (
                          <div className="mt-0.5 truncate text-aux text-sub">{[allFloors ? floors.find(f => f.id === facility.floorId)?.displayName || "楼层待完善" : "", locationDescription(facility)].filter(Boolean).join(" · ")}</div>
                        ) : null}
                      </div>
                      <span className="text-sub">›</span>
                    </div>
                  );
                })
              )}
              {wide && floorPhotos.length > 0 ? <section className="border-t border-line p-4"><h2 className="mb-3 text-emphasis">本层实拍</h2><div className="grid grid-cols-2 gap-2">{floorPhotos.map((url,index) => <ImagePreview key={url} src={url} alt={`本层实拍 ${index+1}`} buttonClassName="h-28 w-full rounded-xl" imageClassName="h-full w-full object-cover" />)}</div></section> : null}
            </div>
          ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

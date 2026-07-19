// Release-derived map data. The sole production content source is the active
// release manifest (GET /api/public/releases/current). There is NO fallback to
// bundled static business data; when no release is active the loader throws and
// the UI renders an explicit empty state.
//
// Identity vs. rendering: a building's business identity is its stable place ID.
// The SVG element id (carried in place content as legacySvgElementId) is used
// ONLY as a selector for the SVG renderer — never as a business/POI id.

import baoshanSvg from "../../../地图/宝山本部地图.svg?raw";
import jiadingSvg from "../../../地图/嘉定校区地图.svg?raw";
import yanchangSvg from "../../../地图/延长校区地图.svg?raw";
import { getCurrentRelease } from "../api/public";
import type {
  ReleaseLocation,
  ReleaseManifest,
  ReleasePlace,
} from "../api/types";
import type {
  CampusConfig,
  CampusKey,
  FilterKey,
  MapBuilding,
  NavigationUrls,
  PoiDetailData,
} from "../types";

export const campusConfigs: CampusConfig[] = [
  {
    key: "baoshan",
    label: "宝山校区",
    svgRaw: baoshanSvg,
    focusPoint: { x: 0.48, y: 0.43 },
    scaleMultiplier: 1.78,
    minScaleMultiplier: 1,
    edgePaddingRatio: 0.18,
    selectionEdgePaddingRatio: 0.3,
    selectionScaleMultiplier: 2.15,
  },
  {
    key: "jiading",
    label: "嘉定校区",
    svgRaw: jiadingSvg,
    focusPoint: { x: 0.37, y: 0.5 },
    scaleMultiplier: 3.05,
    minScaleMultiplier: 1,
    edgePaddingRatio: 0.3,
    selectionEdgePaddingRatio: 0.4,
    selectionScaleMultiplier: 2.4,
  },
  {
    key: "yanchang",
    label: "延长校区",
    svgRaw: yanchangSvg,
    focusPoint: { x: 0.52, y: 0.46 },
    scaleMultiplier: 0.8,
    minScaleMultiplier: 1,
    edgePaddingRatio: 0.2,
    selectionEdgePaddingRatio: 0.32,
    selectionScaleMultiplier: 1.35,
  },
];

export const campusByKey = Object.fromEntries(
  campusConfigs.map((campus) => [campus.key, campus]),
) as Record<CampusKey, CampusConfig>;

export const filters: Array<{ key: FilterKey; label: string }> = [
  { key: "teaching", label: "教学楼" },
  { key: "library", label: "图书馆" },
  { key: "dorm", label: "宿舍楼" },
  { key: "canteen", label: "食堂" },
  { key: "commercial", label: "商业" },
  { key: "printing", label: "打印机" },
  { key: "parking", label: "停车场" },
  { key: "powerBank", label: "充电宝" },
];

// Facility type codes that map onto user-facing filter chips. Derived building
// summaries ("has a printer") come from hosted facility instances, per the v2
// model, rather than independently maintained booleans.
const FACILITY_FILTER_BY_TYPE: Record<string, FilterKey> = {
  printer: "printing",
  printing: "printing",
  power_bank: "powerBank",
  powerbank: "powerBank",
  parking: "parking",
};

// ---------------------------------------------------------------------------
// Campus mapping
// ---------------------------------------------------------------------------

/** campuses[].code is like "campus_baoshan"; map to the local CampusKey. */
function campusKeyFromCode(code: string | null | undefined): CampusKey | null {
  if (!code) return null;
  const normalized = code.replace(/^campus_/, "");
  if (normalized === "baoshan" || normalized === "jiading" || normalized === "yanchang") {
    return normalized;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detail + navigation assembly
// ---------------------------------------------------------------------------

function normalizePoiDetail(detail: unknown): PoiDetailData {
  const source = (detail && typeof detail === "object" ? detail : {}) as Record<string, unknown>;
  const media = Array.isArray(source.media)
    ? (source.media as PoiDetailData["media"])
    : ([
        typeof source.coverImageUrl === "string" && source.coverImageUrl
          ? { role: "cover" as const, url: String(source.coverImageUrl), alt: "" }
          : null,
        typeof source.galleryImageUrl === "string" && source.galleryImageUrl
          ? { role: "gallery" as const, url: String(source.galleryImageUrl), alt: "" }
          : null,
      ].filter(Boolean) as PoiDetailData["media"]);
  const facts = Array.isArray(source.facts)
    ? (source.facts as PoiDetailData["facts"])
    : ([
        ["所属单位", source.organization],
        ["进入方式", source.accessMethod],
        ["开放时间", source.openHours],
        ["联系电话", source.phone],
      ]
        .filter(([, value]) => typeof value === "string" && value)
        .map(([label, value]) => ({ label: String(label), value: String(value) })) as PoiDetailData["facts"]);

  return {
    summary: typeof source.summary === "string" ? source.summary : "",
    description: typeof source.description === "string" ? source.description : "",
    media,
    facts,
  };
}

interface NavPoint {
  longitude: number;
  latitude: number;
  displayName: string;
}

/** Extract a navigation point from a place's primary navigation_target anchor. */
function navPointFromLocation(location: ReleaseLocation | undefined, fallbackName: string): NavPoint | null {
  if (!location?.geometry_json) return null;
  try {
    const geometry = JSON.parse(location.geometry_json) as { type?: string; coordinates?: [number, number] };
    const coords = geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const [longitude, latitude] = coords;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
    const hint = typeof location.location_hint === "string" ? location.location_hint : "";
    return { longitude, latitude, displayName: hint || fallbackName };
  } catch {
    return null;
  }
}

function buildNavigationUrls(nav: NavPoint | null): NavigationUrls | null {
  if (!nav) return null;
  const name = encodeURIComponent(nav.displayName);
  const { longitude, latitude } = nav;
  return {
    amap: `https://uri.amap.com/navigation?to=${longitude},${latitude},${name}&mode=car&policy=1&src=SHUMap&coordinate=gaode&callnative=0`,
    tencent: `https://apis.map.qq.com/uri/v1/routeplan?type=drive&tocoord=${latitude},${longitude}&to=${name}&referer=SHUMap`,
    baidu: `https://api.map.baidu.com/direction?destination=latlng:${latitude},${longitude}|name:${name}&mode=driving&coord_type=gcj02&output=html&src=SHUMap`,
    system: `geo:${latitude},${longitude}?q=${latitude},${longitude}(${name})`,
  };
}

// ---------------------------------------------------------------------------
// Filter-group derivation (from canonical release records, not name matching)
// ---------------------------------------------------------------------------

function deriveFilterGroups(place: ReleasePlace, hostedFacilityFilters: Set<FilterKey>): FilterKey[] {
  const groups = new Set<FilterKey>(hostedFacilityFilters);
  const legacyCategory = typeof place.content?.legacyCategory === "string" ? place.content.legacyCategory : "";

  switch (legacyCategory) {
    case "dorm":
      groups.add("dorm");
      break;
    case "canteen":
      groups.add("canteen");
      groups.add("commercial");
      break;
    case "library":
      groups.add("library");
      break;
    case "other":
      groups.add("commercial");
      break;
    case "building":
    default: {
      if (/行政|办公|中心|伟长/.test(place.displayName)) groups.add("teaching");
      if (/馆/.test(place.displayName)) groups.add("library");
      if (/楼|教学|实验|学院/.test(place.displayName)) groups.add("teaching");
      break;
    }
  }
  if (groups.size === 0) groups.add("teaching");
  return Array.from(groups);
}

// ---------------------------------------------------------------------------
// Manifest -> MapBuilding[]
// ---------------------------------------------------------------------------

/** Build the renderable + searchable building set from a release manifest. */
export function buildMapBuildings(manifest: ReleaseManifest): MapBuilding[] {
  const campusKeyById = new Map<string, CampusKey>();
  const campusLabelById = new Map<string, string>();
  for (const campus of manifest.campuses) {
    const key = campusKeyFromCode(campus.code);
    if (key) campusKeyById.set(campus.id, key);
    campusLabelById.set(campus.id, campus.name);
  }

  // Primary navigation_target anchor per place.
  const primaryNavByPlace = new Map<string, ReleaseLocation>();
  for (const location of manifest.locations) {
    if (location.entityType !== "place") continue;
    if (location.role !== "navigation_target" && location.role !== "primary_display") continue;
    const existing = primaryNavByPlace.get(location.entityId);
    if (!existing || location.isPrimary === 1) primaryNavByPlace.set(location.entityId, location);
  }

  // Hosted facility filter chips per host place.
  const facilityFiltersByPlace = new Map<string, Set<FilterKey>>();
  for (const facility of manifest.facilities) {
    if (!facility.hostPlaceId) continue;
    const filterKey = FACILITY_FILTER_BY_TYPE[facility.facilityTypeId];
    if (!filterKey) continue;
    const set = facilityFiltersByPlace.get(facility.hostPlaceId) ?? new Set<FilterKey>();
    set.add(filterKey);
    facilityFiltersByPlace.set(facility.hostPlaceId, set);
  }

  const buildings: MapBuilding[] = [];
  for (const place of manifest.places) {
    const campusKey = place.campusId ? campusKeyById.get(place.campusId) : null;
    if (!campusKey) continue; // Only render places bound to a known campus SVG.

    const content = place.content ?? {};
    const svgElementId = typeof content.legacySvgElementId === "string" ? content.legacySvgElementId : "";
    const detail = normalizePoiDetail(content.detail);
    const nav = navPointFromLocation(primaryNavByPlace.get(place.id), place.displayName);
    const navigationUrls = buildNavigationUrls(nav);
    const hostedFilters = facilityFiltersByPlace.get(place.id) ?? new Set<FilterKey>();

    buildings.push({
      id: place.id,
      svgElementId,
      name: place.displayName,
      campusKey,
      campusLabel: place.campusId ? campusLabelById.get(place.campusId) ?? "" : "",
      category: typeof content.legacyCategory === "string" ? content.legacyCategory : place.kindId,
      kindId: place.kindId,
      filterGroups: deriveFilterGroups(place, hostedFilters),
      tags: [],
      detail,
      navigationUrls,
      poiKey: place.id,
    });
  }
  return buildings;
}

export interface LoadedRelease {
  releaseId: string;
  version: string;
  manifest: ReleaseManifest;
  buildings: MapBuilding[];
}

/**
 * Load the active release and build the map model. Throws ApiError (including
 * isReleaseUnavailable) on failure — callers must handle the empty state
 * explicitly rather than falling back to stale bundled data.
 */
export async function loadRelease(signal?: AbortSignal): Promise<LoadedRelease> {
  const manifest = await getCurrentRelease(signal);
  return {
    releaseId: manifest.release.id,
    version: manifest.release.version,
    manifest,
    buildings: buildMapBuildings(manifest),
  };
}

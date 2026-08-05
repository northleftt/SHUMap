// Release-derived map data. The active release is the only production source.

import { fetchMapAssetSvg, getCurrentRelease } from "../api/public";
import type {
  PublicPlaceFacility,
  ReleaseFacility,
  ReleaseLocation,
  ReleaseManifest,
  ReleasePlace,
  TransitStop,
} from "../api/types";
import type {
  CampusConfig,
  CampusKey,
  FilterKey,
  MapBuilding,
  MapPoi,
  MapPoiPoint,
  MapPoiVisibility,
  MerchantSummary,
  NavigationUrls,
  PoiDetailData,
} from "../types";
import { NAVIGATION_CRS } from "../../../shared/revision-contract";
import { groupMerchantsByPlace, normalizeMerchant } from "./merchants";

type CampusDisplayConfig = Omit<
  CampusConfig,
  "id" | "key" | "label" | "mapVersionId" | "svgRaw"
>;

const CAMPUS_DISPLAY: Record<CampusKey, CampusDisplayConfig> = {
  baoshan: {
    focusPoint: { x: 0.48, y: 0.43 },
    scaleMultiplier: 1.78,
    minScaleMultiplier: 1,
    edgePaddingRatio: 0.18,
    selectionEdgePaddingRatio: 0.3,
    selectionScaleMultiplier: 2.15,
  },
  jiading: {
    focusPoint: { x: 0.37, y: 0.5 },
    scaleMultiplier: 3.05,
    minScaleMultiplier: 1,
    edgePaddingRatio: 0.3,
    selectionEdgePaddingRatio: 0.4,
    selectionScaleMultiplier: 2.4,
  },
  yanchang: {
    focusPoint: { x: 0.52, y: 0.46 },
    scaleMultiplier: 0.8,
    minScaleMultiplier: 1,
    edgePaddingRatio: 0.2,
    selectionEdgePaddingRatio: 0.32,
    selectionScaleMultiplier: 1.35,
  },
};

function contractError(message: string): Error {
  return new Error(`Release data contract violation: ${message}`);
}

function campusKey(code: string): CampusKey {
  if (code === "baoshan" || code === "jiading" || code === "yanchang") return code;
  throw contractError(`unsupported campus code ${JSON.stringify(code)}`);
}

function facilityTypesById(manifest: ReleaseManifest) {
  return new Map(manifest.facilityTypes.map((type) => [type.id, type]));
}

/** Published facilities hosted by a place, resolved through the release dictionary. */
export function releaseFacilitiesForPlace(
  manifest: ReleaseManifest,
  placeId: string,
): PublicPlaceFacility[] {
  const typeById = facilityTypesById(manifest);
  return manifest.facilities
    .filter((facility) => facility.hostPlaceId === placeId)
    .map((facility) => {
      const type = typeById.get(facility.facilityTypeId);
      if (!type) {
        throw contractError(
          `facility ${facility.id} references missing facility type ${facility.facilityTypeId}`,
        );
      }
      return {
        id: facility.id,
        typeCode: type.code,
        typeName: type.name,
        displayName: facility.displayName,
        operationalStatus: facility.operationalStatus,
        floorId: facility.floorId,
        content: facility.content,
      };
    });
}

function detailOf(place: ReleasePlace): PoiDetailData {
  const content = place.content;
  const raw = content.detail;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw contractError(`place ${place.id} content.detail must be an object`);
  }
  const detail = raw as Record<string, unknown>;
  if (!Array.isArray(detail.media)) {
    throw contractError(`place ${place.id} detail.media must be an array`);
  }
  const media = detail.media.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw contractError(`place ${place.id} detail.media[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.url !== "string" || !row.url.trim()) {
      throw contractError(`place ${place.id} detail.media[${index}].url must be a non-empty string`);
    }
    if (row.role !== "cover" && row.role !== "gallery") {
      throw contractError(`place ${place.id} detail.media[${index}].role must be cover or gallery`);
    }
    const role: "cover" | "gallery" = row.role;
    if (row.id !== undefined && typeof row.id !== "string") {
      throw contractError(`place ${place.id} detail.media[${index}].id must be a string`);
    }
    if (row.alt !== undefined && typeof row.alt !== "string") {
      throw contractError(`place ${place.id} detail.media[${index}].alt must be a string`);
    }
    if (row.caption !== undefined && typeof row.caption !== "string") {
      throw contractError(`place ${place.id} detail.media[${index}].caption must be a string`);
    }
    if (row.floorLevelCode !== undefined && typeof row.floorLevelCode !== "string") {
      throw contractError(`place ${place.id} detail.media[${index}].floorLevelCode must be a string`);
    }
    return {
      ...(row.id === undefined ? {} : { id: row.id }),
      role,
      url: row.url,
      ...(row.alt === undefined ? {} : { alt: row.alt }),
      ...(row.caption === undefined ? {} : { caption: row.caption }),
      ...(row.floorLevelCode === undefined ? {} : { floorLevelCode: row.floorLevelCode }),
    };
  });
  if (!Array.isArray(detail.facts)) {
    throw contractError(`place ${place.id} detail.facts must be an array`);
  }
  const facts = detail.facts.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw contractError(`place ${place.id} detail.facts[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.label !== "string" || typeof row.value !== "string") {
      throw contractError(`place ${place.id} detail.facts[${index}] must contain string label and value`);
    }
    if (row.id !== undefined && typeof row.id !== "string") {
      throw contractError(`place ${place.id} detail.facts[${index}].id must be a string`);
    }
    return {
      ...(row.id === undefined ? {} : { id: row.id }),
      label: row.label,
      value: row.value,
    };
  });
  return {
    summary: place.summary ?? "",
    description: place.description ?? "",
    media,
    facts,
  };
}

function optionalText(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw contractError(`${field} must be a string when present`);
  return value.trim();
}

function mediaOf(value: unknown, field: string): PoiDetailData["media"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw contractError(`${field} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw contractError(`${field}[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    if (row.role !== "cover" && row.role !== "gallery") {
      throw contractError(`${field}[${index}].role must be cover or gallery`);
    }
    const url = optionalText(row.url, `${field}[${index}].url`);
    if (!url) throw contractError(`${field}[${index}].url must be non-empty`);
    const id = optionalText(row.id, `${field}[${index}].id`);
    const alt = optionalText(row.alt, `${field}[${index}].alt`);
    const caption = optionalText(row.caption, `${field}[${index}].caption`);
    const floorLevelCode = optionalText(row.floorLevelCode, `${field}[${index}].floorLevelCode`);
    return {
      ...(id ? { id } : {}),
      role: row.role,
      url,
      ...(alt ? { alt } : {}),
      ...(caption ? { caption } : {}),
      ...(floorLevelCode ? { floorLevelCode } : {}),
    };
  });
}

function facilityDetail(facility: ReleaseFacility): PoiDetailData {
  const content = facility.content;
  const facts = [
    facility.serviceHours?.text ? { label: "服务时间", value: facility.serviceHours.text } : null,
    optionalText(content.fee, `facility ${facility.id} content.fee`)
      ? { label: "费用", value: optionalText(content.fee, `facility ${facility.id} content.fee`) }
      : null,
    optionalText(content.locationDescription, `facility ${facility.id} content.locationDescription`)
      ? { label: "位置", value: optionalText(content.locationDescription, `facility ${facility.id} content.locationDescription`) }
      : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null);
  return {
    summary: optionalText(content.note, `facility ${facility.id} content.note`),
    description: "",
    media: mediaOf(content.media, `facility ${facility.id} content.media`),
    facts,
  };
}

function merchantDetail(merchant: MerchantSummary): PoiDetailData {
  const facts = [
    merchant.openingHours ? { label: "营业时间", value: merchant.openingHours } : null,
    merchant.stallCode ? { label: "档口号", value: merchant.stallCode } : null,
    merchant.avgPrice ? { label: "人均", value: merchant.avgPrice } : null,
    merchant.phone ? { label: "联系电话", value: merchant.phone } : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null);
  return {
    summary: merchant.summary,
    description: "",
    media: merchant.media,
    facts,
  };
}

/**
 * 校车站点没有修订，也没有 content_json，能展示的就是站点代码与上/下车点说明。
 * 时刻表照旧走实时接口（GET /api/public/transit/journeys），不冻进快照。
 */
function transitStopDetail(stop: TransitStop, location: ReleaseLocation): PoiDetailData {
  const facts = [
    stop.code ? { label: "站点代码", value: stop.code } : null,
    location.location_hint ? { label: "上车位置", value: location.location_hint } : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null);
  return { summary: "", description: "", media: [], facts };
}

interface NavPoint {
  longitude: number;
  latitude: number;
  displayName: string;
}

function navPoint(location: ReleaseLocation, placeName: string): NavPoint {
  if (location.geometry_type !== "Point" || location.crs !== NAVIGATION_CRS) {
    throw contractError(`navigation location ${location.id} must be a ${NAVIGATION_CRS} Point`);
  }
  if (!location.geometry_json) {
    throw contractError(`navigation location ${location.id} has no geometry`);
  }
  let geometry: { type?: string; coordinates?: unknown };
  try {
    geometry = JSON.parse(location.geometry_json) as { type?: string; coordinates?: unknown };
  } catch {
    throw contractError(`navigation location ${location.id} contains invalid geometry JSON`);
  }
  if (
    geometry.type !== "Point" ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length !== 2 ||
    typeof geometry.coordinates[0] !== "number" ||
    typeof geometry.coordinates[1] !== "number" ||
    !Number.isFinite(geometry.coordinates[0]) ||
    !Number.isFinite(geometry.coordinates[1])
  ) {
    throw contractError(`navigation location ${location.id} must contain a finite GeoJSON Point`);
  }
  if (
    geometry.coordinates[0] < -180 || geometry.coordinates[0] > 180
    || geometry.coordinates[1] < -90 || geometry.coordinates[1] > 90
  ) {
    throw contractError(`navigation location ${location.id} has invalid longitude or latitude`);
  }
  return {
    longitude: geometry.coordinates[0],
    latitude: geometry.coordinates[1],
    displayName: location.location_hint || placeName,
  };
}

function navigationUrls(point: NavPoint): NavigationUrls {
  const name = encodeURIComponent(point.displayName);
  const { longitude, latitude } = point;
  return {
    amap: `https://uri.amap.com/navigation?to=${longitude},${latitude},${name}&mode=car&policy=1&src=SHUMap&coordinate=gaode&callnative=0`,
    tencent: `https://apis.map.qq.com/uri/v1/routeplan?type=drive&tocoord=${latitude},${longitude}&to=${name}&referer=SHUMap`,
    baidu: `https://api.map.baidu.com/direction?destination=latlng:${latitude},${longitude}|name:${name}&mode=driving&coord_type=gcj02&output=html&src=SHUMap`,
    system: `geo:${latitude},${longitude}?q=${latitude},${longitude}(${name})`,
  };
}

const DEFAULT_POINT_VISIBILITY: MapPoiVisibility = {
  default: true,
  searchable: true,
  filterable: true,
  search: true,
  filter: true,
  whenUnavailable: true,
};

function policyBoolean(policy: Record<string, unknown>, key: string, fallback: boolean, facilityId: string): boolean {
  const value = policy[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw contractError(`facility ${facilityId} visibilityPolicy.${key} must be a boolean`);
  }
  return value;
}

function facilityVisibility(facility: ReleaseFacility): MapPoiVisibility {
  return {
    default: policyBoolean(facility.visibilityPolicy, "campusDefault", false, facility.id),
    searchable: policyBoolean(facility.visibilityPolicy, "searchable", true, facility.id),
    filterable: policyBoolean(facility.visibilityPolicy, "filterable", true, facility.id),
    search: policyBoolean(facility.visibilityPolicy, "showOnSearch", true, facility.id),
    filter: policyBoolean(facility.visibilityPolicy, "showOnFilter", true, facility.id),
    whenUnavailable: policyBoolean(facility.visibilityPolicy, "showWhenUnavailable", true, facility.id),
  };
}

function primaryPointLocations(manifest: ReleaseManifest): Map<string, ReleaseLocation> {
  const candidates = new Map<string, ReleaseLocation[]>();
  for (const location of manifest.locations) {
    if (
      location.geometry_type !== "Point"
      || location.crs !== "svg_viewbox"
      || location.floor_id !== null
      || location.indoor_space_id !== null
    ) continue;
    const key = `${location.entityType}:${location.entityId}`;
    const list = candidates.get(key) ?? [];
    list.push(location);
    candidates.set(key, list);
  }
  // 校车站点的锚点只有上车 / 下车两种角色（LocationEditor 里就是这么限定的），
  // 上车点优先：站牌图钉指的是候车的地方。
  const rolePriority = new Map([
    ["primary_display", 0],
    ["service_position", 1],
    ["boarding_point", 1],
    ["centroid", 2],
    ["alighting_point", 2],
    ["main_entrance", 3],
    ["other", 4],
  ]);
  const result = new Map<string, ReleaseLocation>();
  for (const [key, list] of candidates) {
    list.sort((left, right) =>
      right.isPrimary - left.isPrimary
      || (rolePriority.get(left.role) ?? 100) - (rolePriority.get(right.role) ?? 100)
      || left.id.localeCompare(right.id),
    );
    result.set(key, list[0]);
  }
  return result;
}

function locationsByEntity(manifest: ReleaseManifest): Map<string, ReleaseLocation[]> {
  const result = new Map<string, ReleaseLocation[]>();
  for (const location of manifest.locations) {
    const key = `${location.entityType}:${location.entityId}`;
    const locations = result.get(key) ?? [];
    locations.push(location);
    result.set(key, locations);
  }
  for (const locations of result.values()) {
    locations.sort((left, right) => right.isPrimary - left.isPrimary || left.id.localeCompare(right.id));
  }
  return result;
}

function releasedBuildingFromLocations(
  locations: ReleaseLocation[] | undefined,
  buildingIds: Set<string>,
  buildingByFloor: Map<string, string>,
): string | null {
  for (const location of locations ?? []) {
    if (location.building_place_id && buildingIds.has(location.building_place_id)) {
      return location.building_place_id;
    }
    const floorBuildingId = location.floor_id ? buildingByFloor.get(location.floor_id) : undefined;
    if (floorBuildingId && buildingIds.has(floorBuildingId)) return floorBuildingId;
  }
  return null;
}

function releasedBuildingInPlaceChain(
  placeId: string | null,
  placeById: Map<string, ReleasePlace>,
  entityLocations: Map<string, ReleaseLocation[]>,
  buildingIds: Set<string>,
  buildingByFloor: Map<string, string>,
): string | null {
  const visited = new Set<string>();
  let currentId = placeId;
  while (currentId) {
    if (visited.has(currentId)) {
      throw contractError(`place hierarchy contains a cycle at ${currentId}`);
    }
    visited.add(currentId);
    const place = placeById.get(currentId);
    if (!place) return null;
    if (buildingIds.has(place.id)) return place.id;
    const anchoredBuildingId = releasedBuildingFromLocations(
      entityLocations.get(`place:${place.id}`),
      buildingIds,
      buildingByFloor,
    );
    if (anchoredBuildingId) return anchoredBuildingId;
    currentId = place.parentPlaceId;
  }
  return null;
}

function campusFromLocations(
  locations: ReleaseLocation[] | undefined,
  campusIdByMapVersion: Map<string, string>,
): string | null {
  for (const location of locations ?? []) {
    if (location.campus_id) return location.campus_id;
    const campusId = location.map_version_id ? campusIdByMapVersion.get(location.map_version_id) : undefined;
    if (campusId) return campusId;
  }
  return null;
}

function campusInPlaceChain(
  placeId: string | null,
  placeById: Map<string, ReleasePlace>,
  entityLocations: Map<string, ReleaseLocation[]>,
  campusIdByMapVersion: Map<string, string>,
): string | null {
  const visited = new Set<string>();
  let currentId = placeId;
  while (currentId) {
    if (visited.has(currentId)) {
      throw contractError(`place hierarchy contains a cycle at ${currentId}`);
    }
    visited.add(currentId);
    const place = placeById.get(currentId);
    if (!place) return null;
    if (place.campusId) return place.campusId;
    const locationCampusId = campusFromLocations(
      entityLocations.get(`place:${place.id}`),
      campusIdByMapVersion,
    );
    if (locationCampusId) return locationCampusId;
    currentId = place.parentPlaceId;
  }
  return null;
}

function pointOf(location: ReleaseLocation): MapPoiPoint {
  if (!location.geometry_json) throw contractError(`point location ${location.id} has no geometry`);
  let geometry: { type?: unknown; coordinates?: unknown };
  try {
    geometry = JSON.parse(location.geometry_json) as { type?: unknown; coordinates?: unknown };
  } catch {
    throw contractError(`point location ${location.id} contains invalid geometry JSON`);
  }
  if (
    geometry.type !== "Point"
    || !Array.isArray(geometry.coordinates)
    || geometry.coordinates.length !== 2
    || geometry.coordinates.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
  ) {
    throw contractError(`point location ${location.id} must contain a finite GeoJSON Point`);
  }
  return { x: geometry.coordinates[0] as number, y: geometry.coordinates[1] as number };
}

function campusOfPoint(
  location: ReleaseLocation,
  fallbackCampusId: string | null,
  campusById: Map<string, CampusConfig>,
  campusByMapVersion: Map<string, CampusConfig>,
  label: string,
): CampusConfig {
  const fromMap = location.map_version_id ? campusByMapVersion.get(location.map_version_id) : undefined;
  if (location.map_version_id && !fromMap) {
    throw contractError(`${label} point ${location.id} uses a map version outside campus maps`);
  }
  const campusId = location.campus_id ?? fallbackCampusId;
  const fromCampus = campusId ? campusById.get(campusId) : undefined;
  const campus = fromMap ?? fromCampus;
  if (!campus) throw contractError(`${label} point ${location.id} does not identify a released campus map`);
  if (fromMap && fromCampus && fromMap.id !== fromCampus.id) {
    throw contractError(`${label} point ${location.id} has conflicting campus and map version`);
  }
  return campus;
}

function directFilterGroups(
  manifest: ReleaseManifest,
  member: { placeKindId?: string; facilityTypeId?: string; merchant?: boolean },
): FilterKey[] {
  return manifest.mapFilters
    .filter((filter) =>
      (member.placeKindId ? filter.placeKindIds.includes(member.placeKindId) : false)
      || (member.facilityTypeId ? filter.facilityTypeIds.includes(member.facilityTypeId) : false)
      || (member.merchant ? filter.includesMerchants : false),
    )
    .map((filter) => filter.key);
}

function filterGroups(
  manifest: ReleaseManifest,
  place: ReleasePlace,
  facilityTypeIds: Set<string>,
  hasMerchants: boolean,
): FilterKey[] {
  return manifest.mapFilters
    .filter((filter) =>
      filter.placeKindIds.includes(place.kindId) ||
      filter.facilityTypeIds.some((id) => facilityTypeIds.has(id)) ||
      (filter.includesMerchants && hasMerchants),
    )
    .map((filter) => filter.key);
}

/** Build the map model and enforce every rendering relationship in the release. */
export function buildMapBuildings(
  manifest: ReleaseManifest,
  campuses: CampusConfig[],
): MapBuilding[] {
  const campusByMapVersion = new Map(campuses.map((campus) => [campus.mapVersionId, campus]));
  const footprintByPlace = new Map<string, ReleaseLocation>();
  const navigationByPlace = new Map<string, ReleaseLocation>();
  for (const location of manifest.locations) {
    if (location.entityType !== "place") continue;
    if (location.role === "footprint") {
      if (footprintByPlace.has(location.entityId)) {
        throw contractError(`building ${location.entityId} has multiple footprint locations`);
      }
      footprintByPlace.set(location.entityId, location);
    }
    if (location.role === "navigation_target" && location.isPrimary === 1) {
      if (navigationByPlace.has(location.entityId)) {
        throw contractError(`place ${location.entityId} has multiple primary navigation locations`);
      }
      navigationByPlace.set(location.entityId, location);
    }
  }

  const facilityTypeIdsByPlace = new Map<string, Set<string>>();
  for (const facility of manifest.facilities) {
    if (!facility.hostPlaceId) continue;
    const ids = facilityTypeIdsByPlace.get(facility.hostPlaceId) ?? new Set<string>();
    ids.add(facility.facilityTypeId);
    facilityTypeIdsByPlace.set(facility.hostPlaceId, ids);
  }
  const merchantsByPlace = groupMerchantsByPlace(manifest.merchants);

  return manifest.places
    .filter((place) => place.isBuilding)
    .map((place) => {
      const footprint = footprintByPlace.get(place.id);
      if (!footprint) throw contractError(`building ${place.id} has no footprint location`);
      if (!footprint.map_feature_id || !footprint.map_version_id || !footprint.sourceElementId) {
        throw contractError(
          `building ${place.id} footprint must include mapFeatureId, mapVersionId and sourceElementId`,
        );
      }
      const campus = campusByMapVersion.get(footprint.map_version_id);
      if (!campus) {
        throw contractError(
          `building ${place.id} footprint references map version ${footprint.map_version_id} outside campus maps`,
        );
      }
      if (place.campusId !== campus.id) {
        throw contractError(
          `building ${place.id} campus ${place.campusId} conflicts with footprint map ${footprint.map_version_id}`,
        );
      }
      const nav = navigationByPlace.get(place.id);
      const merchants = merchantsByPlace.get(place.id) ?? [];
      return {
        id: place.id,
        poiKey: place.id,
        revisionId: place.revisionId,
        entityType: "building" as const,
        entityId: place.id,
        mapFeatureId: footprint.map_feature_id,
        mapVersionId: footprint.map_version_id,
        sourceElementId: footprint.sourceElementId,
        markerPoint: null,
        markerIconKey: null,
        name: place.displayName,
        campusKey: campus.key,
        campusLabel: campus.label,
        kindId: place.kindId,
        kindName: place.kindName,
        filterGroups: filterGroups(
          manifest,
          place,
          facilityTypeIdsByPlace.get(place.id) ?? new Set<string>(),
          merchants.length > 0,
        ),
        detail: detailOf(place),
        navigationUrls: nav ? navigationUrls(navPoint(nav, place.displayName)) : null,
        facilities: releaseFacilitiesForPlace(manifest, place.id),
        merchants,
        facilityOperationalStatus: null,
        visibility: DEFAULT_POINT_VISIBILITY,
      };
    });
}

/** Build independent POIs. Any entity bound to a building stays inside that building's detail. */
export function buildMapPointPois(
  manifest: ReleaseManifest,
  campuses: CampusConfig[],
): MapPoi[] {
  const points = primaryPointLocations(manifest);
  const entityLocations = locationsByEntity(manifest);
  const campusById = new Map(campuses.map((campus) => [campus.id, campus]));
  const campusByMapVersion = new Map(campuses.map((campus) => [campus.mapVersionId, campus]));
  const campusIdByMapVersion = new Map(campuses.map((campus) => [campus.mapVersionId, campus.id]));
  const navigation = new Map<string, ReleaseLocation>();
  for (const location of manifest.locations) {
    if (location.role !== "navigation_target") continue;
    const key = `${location.entityType}:${location.entityId}`;
    if (navigation.has(key)) throw contractError(`${key} has multiple navigation locations`);
    navigation.set(key, location);
  }
  const typeById = facilityTypesById(manifest);
  const placeById = new Map(manifest.places.map((place) => [place.id, place]));
  const buildingIds = new Set(manifest.places.filter((place) => place.isBuilding).map((place) => place.id));
  const buildingByFloor = new Map(manifest.floors.map((floor) => [floor.id, floor.buildingPlaceId]));
  const merchantsByPlace = groupMerchantsByPlace(manifest.merchants);
  const result: MapPoi[] = [];

  for (const place of manifest.places) {
    if (place.isBuilding) continue;
    const location = points.get(`place:${place.id}`);
    if (!location) continue;
    const buildingPlaceId = releasedBuildingInPlaceChain(
      place.id,
      placeById,
      entityLocations,
      buildingIds,
      buildingByFloor,
    );
    if (buildingPlaceId) continue;
    const campus = campusOfPoint(
      location,
      campusInPlaceChain(place.id, placeById, entityLocations, campusIdByMapVersion),
      campusById,
      campusByMapVersion,
      `place ${place.id}`,
    );
    const nav = navigation.get(`place:${place.id}`);
    const facilities = releaseFacilitiesForPlace(manifest, place.id);
    const merchants = merchantsByPlace.get(place.id) ?? [];
    result.push({
      id: `place:${place.id}`,
      poiKey: `place:${place.id}`,
      revisionId: place.revisionId,
      entityType: "place",
      entityId: place.id,
      mapFeatureId: null,
      mapVersionId: null,
      sourceElementId: null,
      markerPoint: pointOf(location),
      markerIconKey: place.kindId === "transit_stop"
        ? "bus"
        : place.kindId === "sports_venue"
          ? "sports"
          : place.kindId === "service_place"
            ? "service"
            : "generic",
      name: place.displayName,
      campusKey: campus.key,
      campusLabel: campus.label,
      kindId: place.kindId,
      kindName: place.kindName,
      filterGroups: filterGroups(
        manifest,
        place,
        new Set(manifest.facilities.filter((facility) => facility.hostPlaceId === place.id).map((facility) => facility.facilityTypeId)),
        merchants.length > 0,
      ),
      detail: detailOf(place),
      navigationUrls: nav ? navigationUrls(navPoint(nav, place.displayName)) : null,
      facilities,
      merchants,
      facilityOperationalStatus: null,
      visibility: DEFAULT_POINT_VISIBILITY,
    });
  }

  for (const facility of manifest.facilities) {
    const location = points.get(`facility:${facility.id}`);
    if (!location) continue;
    const buildingPlaceId = releasedBuildingFromLocations(
      entityLocations.get(`facility:${facility.id}`),
      buildingIds,
      buildingByFloor,
    ) ?? (facility.floorId ? buildingByFloor.get(facility.floorId) ?? null : null)
      ?? releasedBuildingInPlaceChain(
        facility.hostPlaceId,
        placeById,
        entityLocations,
        buildingIds,
        buildingByFloor,
      );
    if (buildingPlaceId) continue;
    const hostCampusId = campusInPlaceChain(
      facility.hostPlaceId,
      placeById,
      entityLocations,
      campusIdByMapVersion,
    );
    const campus = campusOfPoint(location, hostCampusId, campusById, campusByMapVersion, `facility ${facility.id}`);
    const type = typeById.get(facility.facilityTypeId);
    if (!type) throw contractError(`facility ${facility.id} references missing facility type ${facility.facilityTypeId}`);
    const nav = navigation.get(`facility:${facility.id}`);
    result.push({
      id: `facility:${facility.id}`,
      poiKey: `facility:${facility.id}`,
      revisionId: facility.revisionId,
      entityType: "facility",
      entityId: facility.id,
      mapFeatureId: null,
      mapVersionId: null,
      sourceElementId: null,
      markerPoint: pointOf(location),
      markerIconKey: type.iconKey,
      name: facility.displayName,
      campusKey: campus.key,
      campusLabel: campus.label,
      kindId: facility.facilityTypeId,
      kindName: type.name,
      filterGroups: directFilterGroups(manifest, { facilityTypeId: facility.facilityTypeId }),
      detail: facilityDetail(facility),
      navigationUrls: nav ? navigationUrls(navPoint(nav, facility.displayName)) : null,
      facilities: [],
      merchants: [],
      facilityOperationalStatus: facility.operationalStatus,
      visibility: facilityVisibility(facility),
    });
  }

  for (const merchant of manifest.merchants) {
    const location = points.get(`merchant_outlet:${merchant.id}`);
    if (!location) continue;
    const buildingPlaceId = releasedBuildingFromLocations(
      entityLocations.get(`merchant_outlet:${merchant.id}`),
      buildingIds,
      buildingByFloor,
    ) ?? (merchant.floorId ? buildingByFloor.get(merchant.floorId) ?? null : null)
      ?? releasedBuildingInPlaceChain(
        merchant.hostPlaceId,
        placeById,
        entityLocations,
        buildingIds,
        buildingByFloor,
      );
    if (buildingPlaceId) continue;
    const hostCampusId = campusInPlaceChain(
      merchant.hostPlaceId,
      placeById,
      entityLocations,
      campusIdByMapVersion,
    );
    const campus = campusOfPoint(location, hostCampusId, campusById, campusByMapVersion, `merchant ${merchant.id}`);
    const normalized = normalizeMerchant(merchant);
    const nav = navigation.get(`merchant_outlet:${merchant.id}`);
    result.push({
      id: `merchant:${merchant.id}`,
      poiKey: `merchant:${merchant.id}`,
      revisionId: merchant.revisionId,
      entityType: "merchant",
      entityId: merchant.id,
      mapFeatureId: null,
      mapVersionId: null,
      sourceElementId: null,
      markerPoint: pointOf(location),
      markerIconKey: "store",
      name: merchant.displayName,
      campusKey: campus.key,
      campusLabel: campus.label,
      kindId: "merchant_outlet",
      kindName: merchant.businessType?.trim() || "商户",
      filterGroups: directFilterGroups(manifest, { merchant: true }),
      detail: merchantDetail(normalized),
      navigationUrls: nav ? navigationUrls(navPoint(nav, merchant.displayName)) : null,
      facilities: [],
      merchants: [],
      facilityOperationalStatus: null,
      visibility: DEFAULT_POINT_VISIBILITY,
    });
  }

  // 校车站点：标过上/下车点就自己出图钉，不必再依附一个地点。
  //
  // 这里刻意不像上面三种那样「绑到楼宇就跳过」。地点/设施/商户绑楼宇意味着它在
  // 楼内，已经由楼宇详情呈现；而站点绑地点只是借用照片与联系方式，候车位置本身
  // 仍是楼外一个独立的点。管理员既然在校区图上标了它，就是要这个图钉。
  for (const stop of manifest.transit.stops) {
    const location = points.get(`transit_stop:${stop.id}`);
    if (!location) continue;
    const campus = campusOfPoint(
      location,
      stop.campus_id ?? campusInPlaceChain(stop.place_id, placeById, entityLocations, campusIdByMapVersion),
      campusById,
      campusByMapVersion,
      `transit stop ${stop.id}`,
    );
    const nav = navigation.get(`transit_stop:${stop.id}`);
    result.push({
      id: `transit_stop:${stop.id}`,
      poiKey: `transit_stop:${stop.id}`,
      // 站点不走修订流，没有修订号；供稿据此判空。
      revisionId: null,
      entityType: "transit_stop",
      entityId: stop.id,
      mapFeatureId: null,
      mapVersionId: null,
      sourceElementId: null,
      markerPoint: pointOf(location),
      markerIconKey: "bus",
      name: stop.name,
      campusKey: campus.key,
      campusLabel: campus.label,
      kindId: "transit_stop",
      kindName: "校车站点",
      // 站点归「交通站点」筛选组：0011 里 map_filter_transit 的成员就是
      // place_kind = transit_stop，与地点侧同一个 chip。
      filterGroups: directFilterGroups(manifest, { placeKindId: "transit_stop" }),
      detail: transitStopDetail(stop, location),
      navigationUrls: nav ? navigationUrls(navPoint(nav, stop.name)) : null,
      facilities: [],
      merchants: [],
      facilityOperationalStatus: null,
      visibility: DEFAULT_POINT_VISIBILITY,
    });
  }

  return result;
}

/** Public helper for focused projection tests without loading map assets. */
export function buildMapPois(manifest: ReleaseManifest, campuses: CampusConfig[]): MapPoi[] {
  const buildings = buildMapBuildings(manifest, campuses);
  return [...buildings, ...buildMapPointPois(manifest, campuses)];
}

async function loadCampuses(
  manifest: ReleaseManifest,
  signal?: AbortSignal,
): Promise<[CampusConfig, ...CampusConfig[]]> {
  const campusMaps = manifest.maps.filter((map) => map.floor_id === null);
  const configs = await Promise.all(campusMaps.map(async (map) => {
    if (!map.campus_id || !map.campusCode || !map.campusName) {
      throw contractError(`campus map ${map.id} has incomplete campus metadata`);
    }
    const key = campusKey(map.campusCode);
    return {
      id: map.campus_id,
      key,
      label: map.campusName,
      mapVersionId: map.id,
      svgRaw: await fetchMapAssetSvg(map.id, signal),
      ...CAMPUS_DISPLAY[key],
    };
  }));
  const [firstConfig, ...remainingConfigs] = configs;
  if (!firstConfig) throw contractError("release has no campus maps");
  const keys = new Set<CampusKey>();
  for (const config of configs) {
    if (keys.has(config.key)) throw contractError(`duplicate campus map for ${config.key}`);
    keys.add(config.key);
  }
  return [firstConfig, ...remainingConfigs];
}

export interface LoadedRelease {
  releaseId: string;
  version: string;
  manifest: ReleaseManifest;
  campuses: [CampusConfig, ...CampusConfig[]];
  buildings: MapBuilding[];
  /** Campus-map entries: buildings plus independent outdoor point POIs. */
  pois: MapPoi[];
  filters: Array<{ key: FilterKey; label: string }>;
}

/** Load the active artifact and every SVG needed before exposing ready state. */
export async function loadRelease(signal?: AbortSignal): Promise<LoadedRelease> {
  const manifest = await getCurrentRelease(signal);
  const campuses = await loadCampuses(manifest, signal);
  const pois = buildMapPois(manifest, campuses);
  const buildings = pois.filter((poi): poi is MapBuilding => poi.entityType === "building");
  return {
    releaseId: manifest.release.id,
    version: manifest.release.version,
    manifest,
    campuses,
    buildings,
    pois,
    filters: manifest.mapFilters.map((filter) => ({ key: filter.key, label: filter.label })),
  };
}

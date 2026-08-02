// Release-derived map data. The active release is the only production source.

import { fetchMapAssetSvg, getCurrentRelease } from "../api/public";
import type {
  PublicPlaceFacility,
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
import { NAVIGATION_CRS } from "../../../shared/revision-contract";
import { groupMerchantsByPlace } from "./merchants";

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
    return {
      ...(row.id === undefined ? {} : { id: row.id }),
      role,
      url: row.url,
      ...(row.alt === undefined ? {} : { alt: row.alt }),
      ...(row.caption === undefined ? {} : { caption: row.caption }),
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
        mapFeatureId: footprint.map_feature_id,
        mapVersionId: footprint.map_version_id,
        sourceElementId: footprint.sourceElementId,
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
      };
    });
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
  filters: Array<{ key: FilterKey; label: string }>;
}

/** Load the active artifact and every SVG needed before exposing ready state. */
export async function loadRelease(signal?: AbortSignal): Promise<LoadedRelease> {
  const manifest = await getCurrentRelease(signal);
  const campuses = await loadCampuses(manifest, signal);
  return {
    releaseId: manifest.release.id,
    version: manifest.release.version,
    manifest,
    campuses,
    buildings: buildMapBuildings(manifest, campuses),
    filters: manifest.mapFilters.map((filter) => ({ key: filter.key, label: filter.label })),
  };
}

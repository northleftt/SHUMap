import { MapPin, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as admin from "../../lib/api/admin";
import { objectValue, oneOf, requiredBoolean } from "../../lib/dataContract";
import type { SpacesResponse } from "../adminTypes";
import { ErrorBanner, Field, GhostButton, InfoNote, Panel, SelectField, errorMessage } from "./primitives";
import {
  CANVAS_CRS,
  CampusMapCanvas,
  campusKeyOfRow,
  campusMapBinding,
  campusMapVersions,
  canvasOfGeoJson,
  canvasToolOfGeometryType,
  geoJsonOfCanvas,
  pickSingleShape,
  type CanvasGeometry,
  type CanvasTool,
} from "./CampusMapCanvas";
import type {
  GeometryType,
  LocationPrecision,
  LocationRole,
  RevisionLocationInput,
} from "../../../shared/revision-contract";
import { NAVIGATION_CRS } from "../../../shared/revision-contract";

/** 多边形、折线与平面图坐标在 origin 中无损回写；地图要素由显式字段编辑。 */
interface LocationOrigin {
  geometryType: GeometryType;
  geometry: unknown;
  crs: string | null;
  precisionLevel: LocationPrecision;
  accuracyMeters: number | null;
  sourceId: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface LocationDraft {
  id: string;
  campusId: string;
  buildingPlaceId: string;
  floorId: string;
  indoorSpaceId: string;
  role: LocationRole;
  locationHint: string;
  longitude: string;
  latitude: string;
  mapVersionId: string;
  mapFeatureId: string;
  isPrimary: boolean;
  origin?: LocationOrigin;
}

export function emptyLocation(role: LocationRole = "primary_display"): LocationDraft {
  return {
    id: crypto.randomUUID(),
    campusId: "",
    buildingPlaceId: "",
    floorId: "",
    indoorSpaceId: "",
    role,
    locationHint: "",
    longitude: "",
    latitude: "",
    mapVersionId: "",
    mapFeatureId: "",
    isPrimary: true,
  };
}

export function locationInput(row: LocationDraft): RevisionLocationInput {
  const hasLongitude = row.longitude.trim() !== "";
  const hasLatitude = row.latitude.trim() !== "";
  if (hasLongitude !== hasLatitude) throw new Error("经度和纬度必须同时填写");
  const longitude = Number(row.longitude);
  const latitude = Number(row.latitude);
  if (hasLongitude && (!Number.isFinite(longitude) || !Number.isFinite(latitude))) {
    throw new Error("经度和纬度必须是有限数字");
  }
  if (hasLongitude && (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90)) {
    throw new Error("经度或纬度超出有效范围");
  }
  const hasPoint = hasLongitude && hasLatitude;
  // 填了经纬度就以输入框为准，否则回写读进来的原始几何。
  const rawGeometry = hasPoint ? { type: "Point", coordinates: [longitude, latitude] } : row.origin?.geometry ?? null;
  const geometry = rawGeometry === null ? null : objectValue(rawGeometry, "location.geometry");
  const hasMapFeature = row.mapFeatureId !== "";
  if (hasPoint && hasMapFeature) throw new Error("经纬度与地图图形不能同时绑定");
  if (hasMapFeature && !row.mapVersionId) throw new Error("地图图形必须归属一个地图版本");
  const geometryType = hasPoint ? "Point" : row.origin?.geometryType ?? "Point";
  const crs = hasPoint ? NAVIGATION_CRS : row.origin?.crs ?? null;
  const precisionLevel = hasPoint
    ? "exact"
    : row.origin?.precisionLevel ?? (row.indoorSpaceId ? "space" : row.floorId ? "floor" : row.buildingPlaceId ? "building" : "campus");
  return {
    campusId: row.campusId || null,
    buildingPlaceId: row.buildingPlaceId || null,
    floorId: row.floorId || null,
    indoorSpaceId: row.indoorSpaceId || null,
    role: row.role,
    locationHint: row.locationHint.trim() || null,
    precisionLevel,
    geometryType,
    geometry,
    crs,
    mapVersionId: hasPoint ? null : row.mapVersionId || null,
    mapFeatureId: hasPoint ? null : row.mapFeatureId || null,
    accuracyMeters: row.origin?.accuracyMeters ?? null,
    sourceId: row.origin?.sourceId ?? null,
    validFrom: row.origin?.validFrom ?? null,
    validTo: row.origin?.validTo ?? null,
    isPrimary: row.isPrimary,
  };
}

/** 留存下来的几何同样算内容，不能因为输入框是空的就把这行丢掉。 */
function hasOriginBinding(row: LocationDraft): boolean {
  const origin = row.origin;
  if (!origin) return false;
  return origin.geometry !== null && origin.geometry !== undefined;
}

export function isLocationDraftBlank(row: LocationDraft): boolean {
  return !row.campusId
    && !row.buildingPlaceId
    && !row.floorId
    && !row.indoorSpaceId
    && !row.locationHint.trim()
    && !row.longitude.trim()
    && !row.latitude.trim()
    && !row.mapVersionId
    && !row.mapFeatureId
    && !hasOriginBinding(row);
}

export function locationDraftFromApi(raw: Record<string, unknown>, index: number): LocationDraft {
  const optionalString = (value: unknown, field: string): string => {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
    return value;
  };
  if (typeof raw.role !== "string" || !raw.role) throw new Error(`locations[${index}].role must be a non-empty string`);
  const role = oneOf(raw.role, `locations[${index}].role`, [
    "primary_display", "footprint", "centroid", "main_entrance", "accessible_entrance",
    "navigation_target", "service_position", "boarding_point", "alighting_point", "event_location",
    "impact_area", "route_shape", "other",
  ] as const);
  const isPrimary = requiredBoolean(raw.isPrimary, `locations[${index}].isPrimary`);
  const geometry = raw.geometry === undefined ? null : raw.geometry;
  const geometryObject = geometry === null ? null : objectValue(geometry, `locations[${index}].geometry`);
  const crsValue = optionalString(raw.crs, `locations[${index}].crs`);
  const crs = crsValue || null;
  const geometryType = oneOf(raw.geometryType, `locations[${index}].geometryType`, ["Point", "LineString", "Polygon", "MultiPolygon"] as const);
  if (geometryObject && (typeof geometryObject.type !== "string" || geometryObject.type !== geometryType)) {
    throw new Error(`locations[${index}].geometry type must match geometryType`);
  }
  const coordinates = geometryObject?.coordinates;
  // 经纬度输入框对应 GCJ-02 单点，其余几何由 origin 原样带回。
  const editablePoint = crs === NAVIGATION_CRS && geometryType === "Point";
  if (editablePoint && (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every((value) => typeof value === "number" && Number.isFinite(value)))) {
    throw new Error(`locations[${index}].geometry must contain one finite point`);
  }
  const mapVersionId = optionalString(raw.mapVersionId, `locations[${index}].mapVersionId`);
  const mapFeatureId = optionalString(raw.mapFeatureId, `locations[${index}].mapFeatureId`);
  const precisionLevel = oneOf(
    raw.precisionLevel,
    `locations[${index}].precisionLevel`,
    ["campus", "building", "floor", "space", "exact", "unknown"] as const,
  );
  if (mapFeatureId && !mapVersionId) {
    throw new Error(`locations[${index}].mapFeatureId requires mapVersionId`);
  }
  const accuracyMeters = raw.accuracyMeters;
  if (accuracyMeters !== undefined && accuracyMeters !== null && (typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters))) {
    throw new Error(`locations[${index}].accuracyMeters must be a finite number or null`);
  }
  const bindingId = optionalString(raw.bindingId, `locations[${index}].bindingId`);
  return {
    id: bindingId || `structure-${index}`,
    campusId: optionalString(raw.campusId, `locations[${index}].campusId`),
    buildingPlaceId: optionalString(raw.buildingPlaceId, `locations[${index}].buildingPlaceId`),
    floorId: optionalString(raw.floorId, `locations[${index}].floorId`),
    indoorSpaceId: optionalString(raw.indoorSpaceId, `locations[${index}].indoorSpaceId`),
    role,
    locationHint: optionalString(raw.locationHint, `locations[${index}].locationHint`),
    longitude: editablePoint ? String((coordinates as number[])[0]) : "",
    latitude: editablePoint ? String((coordinates as number[])[1]) : "",
    mapVersionId,
    mapFeatureId,
    isPrimary,
    origin: {
      geometryType,
      geometry: editablePoint ? null : geometry,
      crs,
      precisionLevel,
      accuracyMeters: accuracyMeters ?? null,
      sourceId: optionalString(raw.sourceId, `locations[${index}].sourceId`) || null,
      validFrom: optionalString(raw.validFrom, `locations[${index}].validFrom`) || null,
      validTo: optionalString(raw.validTo, `locations[${index}].validTo`) || null,
    },
  };
}

const ALL_ROLES = [
  "primary_display", "footprint", "centroid", "main_entrance", "accessible_entrance",
  "navigation_target", "service_position", "boarding_point", "alighting_point", "event_location",
  "impact_area", "route_shape", "other",
] as const;

const ROLE_LABELS: Record<LocationRole, string> = {
  primary_display: "主要展示位置",
  footprint: "建筑轮廓",
  centroid: "中心点",
  main_entrance: "主入口",
  accessible_entrance: "无障碍入口",
  navigation_target: "导航终点",
  service_position: "服务位置",
  boarding_point: "上车点",
  alighting_point: "下车点",
  event_location: "事件位置",
  impact_area: "影响范围",
  route_shape: "路线",
  other: "其他",
};

/**
 * 哪些用途能在校园图上画，以及各自允许的图形。
 *
 * navigation_target 缺席：0015 的触发器要求它是 GCJ02 Point，而仓库里没有
 * svg_viewbox → GCJ-02 的换算，画出来的坐标必被拒；它只能继续手填经纬度。
 * footprint 缺席：触发器要求 geometry 为空并绑定已导入的 map_feature，
 * 自由绘制的几何写不进去，只能走「地图图形」下拉。
 */
const CANVAS_TOOLS_BY_ROLE: Partial<Record<LocationRole, readonly CanvasTool[]>> = {
  primary_display: ["point"],
  centroid: ["point"],
  main_entrance: ["point"],
  accessible_entrance: ["point"],
  service_position: ["point"],
  boarding_point: ["point"],
  alighting_point: ["point"],
  event_location: ["point"],
  impact_area: ["area"],
  route_shape: ["path"],
  other: ["point", "area", "path"],
};

/** 该行是否已经存着画布画出来的几何。 */
function hasCanvasGeometry(row: LocationDraft): boolean {
  const origin = row.origin;
  return Boolean(origin && origin.crs === CANVAS_CRS && origin.geometry !== null && origin.geometry !== undefined);
}

function geometryTypeFromFeature(feature: admin.MapFeatureRow): GeometryType {
  return oneOf(feature.geometryType, `map feature ${feature.id}.geometryType`, ["Point", "LineString", "Polygon", "MultiPolygon"] as const);
}

function mapVersionLabel(version: admin.MapVersionRow, spaces: SpacesResponse): string {
  if (version.campusId) {
    const campus = spaces.campuses.find((candidate) => candidate.id === version.campusId);
    if (!campus) throw new Error(`地图版本 ${version.id} 引用了不存在的校区`);
    return `${campus.name} · ${version.versionLabel}`;
  }
  if (!version.floorId) throw new Error(`地图版本 ${version.id} 没有空间归属`);
  const floor = spaces.floors.find((candidate) => candidate.id === version.floorId);
  if (!floor) throw new Error(`地图版本 ${version.id} 引用了不存在的楼层`);
  const building = spaces.buildings.find((candidate) => candidate.placeId === floor.buildingPlaceId);
  if (!building?.displayName) throw new Error(`楼层 ${floor.id} 没有有效楼宇名称`);
  return `${building.displayName} · ${floor.displayName} · ${version.versionLabel}`;
}

export function LocationEditor({
  value,
  onChange,
  spaces,
  mapVersions,
  entityPlaceId,
  buildingCampusId,
  isBuilding,
  disabled,
  roles,
  title = "地图位置",
}: {
  value: LocationDraft[];
  onChange(rows: LocationDraft[]): void;
  spaces: SpacesResponse;
  mapVersions: admin.MapVersionRow[];
  entityPlaceId?: string | null;
  buildingCampusId?: string | null;
  isBuilding?: boolean;
  disabled?: boolean;
  /** 限定「用途」下拉的可选项。省略时给出全部角色。 */
  roles?: readonly LocationRole[];
  title?: string;
}) {
  const allowedRoles = roles ?? ALL_ROLES;
  const roleOptions = allowedRoles.map((role) => ({ value: role, label: ROLE_LABELS[role] }));
  const patch = (index: number, update: Partial<LocationDraft>) => onChange(value.map((row, i) => i === index ? { ...row, ...update } : row));
  const [featuresByVersion, setFeaturesByVersion] = useState<Record<string, admin.MapFeatureRow[]>>({});
  const [loadingVersions, setLoadingVersions] = useState<Set<string>>(new Set());
  const [featureError, setFeatureError] = useState("");
  const requestedVersions = useMemo(
    () => [...new Set(value.map((row) => row.mapVersionId).filter(Boolean))],
    [value],
  );

  useEffect(() => {
    const pending = requestedVersions.filter((mapVersionId) => !Object.hasOwn(featuresByVersion, mapVersionId));
    if (pending.length === 0) return;
    const controller = new AbortController();
    setLoadingVersions((current) => new Set([...current, ...pending]));
    setFeatureError("");
    Promise.all(pending.map(async (mapVersionId) => {
      const response = await admin.listMapFeatures(mapVersionId, controller.signal);
      return [mapVersionId, response.items] as const;
    })).then((loaded) => {
      setFeaturesByVersion((current) => ({ ...current, ...Object.fromEntries(loaded) }));
      setLoadingVersions((current) => {
        const next = new Set(current);
        pending.forEach((mapVersionId) => next.delete(mapVersionId));
        return next;
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoadingVersions((current) => {
        const next = new Set(current);
        pending.forEach((mapVersionId) => next.delete(mapVersionId));
        return next;
      });
      setFeatureError(errorMessage(error, "地图图形加载失败"));
    });
    return () => controller.abort();
  }, [featuresByVersion, requestedVersions]);

  return <Panel title="地图位置" action={<GhostButton disabled={disabled} onClick={() => onChange([...value, { ...emptyLocation(), isPrimary: value.length === 0 }])}><Plus size={14} />添加位置</GhostButton>}>
    {featureError ? <ErrorBanner message={featureError} /> : null}
    {value.length === 0 ? <InfoNote>还没有地图位置</InfoNote> : <div className="space-y-3">{value.map((row, index) => {
      const floors = spaces.floors.filter((floor) => !row.buildingPlaceId || floor.buildingPlaceId === row.buildingPlaceId);
      const indoor = spaces.spaces.filter((space) => !row.floorId || space.floorId === row.floorId);
      const versionOptions = mapVersions
        .filter((version) => version.lifecycleStatus === "ready" || version.lifecycleStatus === "published")
        .filter((version) => {
          if (row.role === "footprint") return version.floorId === null && (!row.campusId || version.campusId === row.campusId);
          if (row.floorId) return version.floorId === row.floorId;
          if (row.campusId) return version.campusId === row.campusId;
          return true;
        })
        .map((version) => ({ value: version.id, label: mapVersionLabel(version, spaces) }));
      const features = (featuresByVersion[row.mapVersionId] ?? []).filter((feature) => {
        if (feature.geometryType === null || feature.sourceElementId === null) return false;
        if (feature.footprintPlaceId !== null && feature.footprintPlaceId !== entityPlaceId) return false;
        if (row.role !== "footprint") return true;
        return (feature.geometryType === "Polygon" || feature.geometryType === "MultiPolygon")
          && (feature.kind === "building_footprint" || feature.kind === "other");
      });
      const featureOptions = features.map((feature) => ({
        value: feature.id,
        label: `${feature.label ?? feature.sourceElementId ?? feature.id} · ${feature.kind}`,
      }));
      const patchCampus = (campusId: string) => patch(index, { campusId, mapVersionId: "", mapFeatureId: "" });
      return <div className="space-y-3 rounded-xl border border-line p-3" key={row.id}>
        <div className="grid grid-cols-2 gap-2">
          <SelectField
            disabled={disabled || roleOptions.length < 2}
            label="用途"
            onChange={(role) => patch(index, { role: oneOf(role, "location.role", ALL_ROLES) })}
            options={roleOptions}
            value={row.role}
          />
          <SelectField
            disabled={disabled || isBuilding === true}
            label="校区"
            onChange={patchCampus}
            options={spaces.campuses.map((campus) => ({ value: campus.id, label: campus.name }))}
            placeholder="选择校区"
            value={isBuilding === true ? buildingCampusId ?? "" : row.campusId}
          />
          <SelectField
            disabled={disabled || isBuilding === true}
            label="楼宇"
            onChange={(buildingPlaceId) => patch(index, { buildingPlaceId, floorId: "", indoorSpaceId: "" })}
            options={spaces.buildings.map((building) => ({ value: building.placeId, label: building.displayName ?? building.placeId }))}
            placeholder={isBuilding === true ? "保存后自动绑定当前楼宇" : "不指定"}
            value={isBuilding === true ? entityPlaceId ?? "" : row.buildingPlaceId}
          />
          <SelectField disabled={disabled} label="楼层" onChange={(floorId) => patch(index, { floorId, indoorSpaceId: "" })} options={floors.map((floor) => ({ value: floor.id, label: floor.displayName }))} placeholder="不指定" value={row.floorId} />
          <SelectField disabled={disabled} label="室内空间" onChange={(indoorSpaceId) => patch(index, { indoorSpaceId })} options={indoor.map((space) => ({ value: space.id, label: space.displayName }))} placeholder="不指定" value={row.indoorSpaceId} />
          <Field disabled={disabled} label="位置说明" onChange={(locationHint) => patch(index, { locationHint })} placeholder="如 北门入口" value={row.locationHint} />
          <Field disabled={disabled || Boolean(row.mapFeatureId)} label="GCJ-02 经度（可选）" onChange={(longitude) => patch(index, { longitude })} placeholder="121.40" type="number" value={row.longitude} />
          <Field disabled={disabled || Boolean(row.mapFeatureId)} label="GCJ-02 纬度（可选）" onChange={(latitude) => patch(index, { latitude })} placeholder="31.32" type="number" value={row.latitude} />
          <SelectField
            disabled={disabled || Boolean(row.longitude.trim() || row.latitude.trim())}
            label="地图版本（可选）"
            onChange={(mapVersionId) => patch(index, { mapVersionId, mapFeatureId: "", origin: row.origin ? { ...row.origin, geometryType: "Point", geometry: null, crs: null } : undefined })}
            options={versionOptions}
            placeholder="不绑定地图图形"
            value={row.mapVersionId}
          />
          <SelectField
            disabled={disabled || !row.mapVersionId || loadingVersions.has(row.mapVersionId)}
            label="地图图形（可选）"
            onChange={(mapFeatureId) => {
              if (!mapFeatureId) {
                patch(index, { mapFeatureId, origin: row.origin ? { ...row.origin, geometryType: "Point", geometry: null, crs: null } : undefined });
                return;
              }
              const feature = features.find((candidate) => candidate.id === mapFeatureId);
              if (!feature) throw new Error(`地图图形 ${mapFeatureId} 不在所选版本中`);
              patch(index, {
                mapFeatureId,
                longitude: "",
                latitude: "",
                origin: {
                  geometryType: geometryTypeFromFeature(feature),
                  geometry: null,
                  crs: null,
                  precisionLevel: "exact",
                  accuracyMeters: row.origin?.accuracyMeters ?? null,
                  sourceId: row.origin?.sourceId ?? null,
                  validFrom: row.origin?.validFrom ?? null,
                  validTo: row.origin?.validTo ?? null,
                },
              });
            }}
            options={featureOptions}
            placeholder={loadingVersions.has(row.mapVersionId) ? "加载图形中…" : "不绑定地图图形"}
            value={row.mapFeatureId}
          />
        </div>
        <div className="flex justify-end gap-2">{!row.isPrimary ? <GhostButton disabled={disabled} onClick={() => onChange(value.map((item, i) => ({ ...item, isPrimary: i === index })))}>设为主要位置</GhostButton> : null}<GhostButton danger disabled={disabled} onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 size={14} />删除</GhostButton></div>
      </div>;
    })}</div>}
  </Panel>;
}

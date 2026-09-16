import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as admin from "../../lib/api/admin";
import { objectValue, oneOf, requiredBooleanFlag } from "../../lib/dataContract";
import type { Campus, SpacesResponse } from "../adminTypes";
import type { CampusKey } from "../../lib/types";
import { ErrorBanner, Field, GhostButton, InfoNote, Panel, SelectField, errorMessage } from "./primitives";
import {
  CANVAS_CRS,
  CampusMapCanvas,
  campusKeyOfRow,
  campusMapBinding,
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
import { applyGeoTransform, viewBoxToGcj02 } from "../../../shared/geo-transform.mjs";
import { geoTransformRecordOf } from "../../../shared/campus-geo-records.mjs";
import { deriveNavigationTarget } from "../../../shared/navigation-target.mjs";
import { CAMPUS_GEO_TRANSFORMS } from "../../lib/release/mapData";

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
  /**
   * 这一行是从楼栋轮廓自动推导出来的导航终点（见 derivedNavigationRow）。
   * 只存在于编辑态、不进库：换轮廓时跟着重算、清轮廓时一起撤掉，
   * 而人一旦手改过经纬度就摘掉此标记，之后再不自动覆盖。
   */
  derived?: boolean;
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

/**
 * 保存前的最后整理：丢掉一行都没填的草稿，并把主要位置收敛到恰好一个。
 *
 * 两步都是真实事故的修法：
 * 1. 空行不过滤会带着全空字段送进 normalizeLocationInput，被后端「必须指明空间
 *    归属 / 图形 / 几何」打成 400——用户只是点了一下「添加位置」又没用上。
 * 2. 设施编辑器有两个面板共写一个数组（楼层图的服务位置 + 楼外位置），两边各自
 *    维护 isPrimary，可能同时亮着（服务位置已是主要位置时再在楼外面板加一行，
 *    新行默认点亮），保存被「恰好一个主要位置」拒掉。撞车时保留**最后**一个主要
 *    位置（数组顺序 = 面板顺序，后动手的面板赢）；过滤完一个都没有时点亮首行，
 *    否则空着的 primary 同样过不了契约。
 */
export function finalizeLocationDrafts(drafts: LocationDraft[]): LocationDraft[] {
  const rows = drafts.filter((row) => !isLocationDraftBlank(row));
  if (rows.length === 0) return rows;
  const primaryIndexes = rows.flatMap((row, index) => (row.isPrimary ? [index] : []));
  if (primaryIndexes.length === 1) return rows;
  const keep = primaryIndexes.length > 1 ? primaryIndexes[primaryIndexes.length - 1] : 0;
  return rows.map((row, index) => (index === keep ? { ...row, isPrimary: true } : row.isPrimary ? { ...row, isPrimary: false } : row));
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
  const isPrimary = requiredBooleanFlag(raw.isPrimary, `locations[${index}].isPrimary`);
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

export const ALL_ROLES = [
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
  boarding_point: "候车点",
  alighting_point: "下车点（旧）",
  event_location: "事件位置",
  impact_area: "影响范围",
  route_shape: "路线",
  other: "其他",
};

/**
 * 哪些用途能在校园图上画，以及各自允许的图形。
 *
 * navigation_target 存库仍是 GCJ02 Point（0015 触发器不变）：画布点选的
 * svg_viewbox 坐标经该校区的 geoTransform 逆变换成经纬度回填输入框，画布上的
 * 图钉再由经纬度正向投影回来，所以它的行永远不存画布几何。
 * footprint 缺席：触发器要求 geometry 为空并绑定已导入的 map_feature，
 * 自由绘制的几何写不进去，只能走「地图图形」下拉。
 */
const CANVAS_TOOLS_BY_ROLE: Partial<Record<LocationRole, readonly CanvasTool[]>> = {
  primary_display: ["point"],
  centroid: ["point"],
  main_entrance: ["point"],
  accessible_entrance: ["point"],
  navigation_target: ["point"],
  service_position: ["point"],
  boarding_point: ["point"],
  alighting_point: ["point"],
  event_location: ["point"],
  impact_area: ["area"],
  route_shape: ["path"],
  other: ["point", "area", "path"],
};

/**
 * navigation_target 的画布图钉不从 origin 读（它不存画布几何），而是把手填/回填的
 * GCJ-02 经纬度正向投回 viewBox：管理员微调经纬度时图钉跟着动，两边永远一致。
 */
function navTargetCanvasValue(row: LocationDraft, campusKey: CampusKey): CanvasGeometry | null {
  if (row.longitude.trim() === "" || row.latitude.trim() === "") return null;
  const longitude = Number(row.longitude);
  const latitude = Number(row.latitude);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const { x, y } = applyGeoTransform(CAMPUS_GEO_TRANSFORMS[campusKey], longitude, latitude);
  return { campusKey, point: [x, y], area: null, path: null };
}

/** 该行是否已经存着画布画出来的几何。 */
function hasCanvasGeometry(row: LocationDraft): boolean {
  const origin = row.origin;
  return Boolean(origin && origin.crs === CANVAS_CRS && origin.geometry !== null && origin.geometry !== undefined);
}

/**
 * row.campusId → 画布需要的 campusKey。
 *
 * 找不到或代码不认识时返回 null（画布转而提示先选校区），不抛：位置行的校区可以
 * 一时空着，整张编辑页不该因此打不开。
 */
function canvasCampusKey(campusId: string, campuses: Campus[]): CampusKey | null {
  const row = campuses.find((candidate) => candidate.id === campusId);
  if (!row) return null;
  try {
    return campusKeyOfRow(row);
  } catch {
    return null;
  }
}

/**
 * 已存的画布几何 → 画布 value；这一行没画过东西就是 null。
 *
 * 几何类型不在当前用途允许的工具里就当没画（改了「用途」会走到这一步），
 * 否则画布会拿点的解析器去读一个多边形，直接抛在渲染里。
 */
function canvasValueOf(
  row: LocationDraft,
  campusKey: CampusKey,
  tools: readonly CanvasTool[],
): CanvasGeometry | null {
  const origin = row.origin;
  if (!origin || !hasCanvasGeometry(row)) return null;
  const tool = canvasToolOfGeometryType(origin.geometryType);
  if (!tool || !tools.includes(tool)) return null;
  return canvasOfGeoJson(origin.geometry, tool, campusKey, `位置 ${row.id} 的几何`);
}

/** 清掉这一行的画布几何，保留其余字段。 */
function withoutCanvasGeometry(row: LocationDraft): Partial<LocationDraft> {
  return {
    mapVersionId: "",
    origin: row.origin ? { ...row.origin, geometryType: "Point", geometry: null, crs: null } : undefined,
  };
}

function geometryTypeFromFeature(feature: admin.MapFeatureRow): GeometryType {
  return oneOf(feature.geometryType, `map feature ${feature.id}.geometryType`, ["Point", "LineString", "Polygon", "MultiPolygon"] as const);
}

// ---------------------------------------------------------------------------
// 楼栋轮廓 → 自动推导导航终点
//
// 为什么要自动：导航终点原先是「添加位置 + 把用途从默认的『主要展示位置』改成
// 『导航终点』 + 填坐标」三步。漏掉任何一步用户端就没有「导航到这里」按钮，而保存、
// 审核、发版全程都不报错（发版校验只校验已存在导航点的形状，从不检查缺失）。楼栋
// 选了轮廓之后代表点本来就算得出来，这一步不该靠人记。
//
// 推导出来的行标 derived，后续改轮廓会跟着重算、清空轮廓会一起撤掉；一旦人动过
// 经纬度就摘掉这个标记，之后再不自动覆盖。
// ---------------------------------------------------------------------------

/** 从已选中的 footprint 图形推导导航终点行；任何一步不成立返回 null。 */
function derivedNavigationRow(
  feature: admin.MapFeatureRow,
  campusKey: CampusKey | null,
  campusId: string,
): LocationDraft | null {
  if (!campusKey || !feature.geometryJson) return null;
  const params = geoTransformRecordOf(campusKey);
  if (!params) return null;
  let geometry: unknown;
  try {
    geometry = JSON.parse(feature.geometryJson);
  } catch {
    return null;
  }
  const derived = deriveNavigationTarget({
    geometry: geometry as { type?: string; coordinates?: unknown },
    mapVersionId: feature.mapVersionId,
    params,
  });
  if (!derived) return null;
  return {
    ...emptyLocation("navigation_target"),
    campusId,
    longitude: String(derived.longitude),
    latitude: String(derived.latitude),
    // 楼栋路径要求导航点 isPrimary===1 才渲染「导航到这里」（见
    // src/lib/release/mapData.ts buildMapBuildings），而契约要求每个实体恰好一个
    // 主要位置，所以轮廓行让位。
    isPrimary: true,
    derived: true,
    origin: {
      geometryType: "Point",
      geometry: null,
      crs: null,
      // 代表点的精度就是仿射变换的不确定度（1.4–3.2m），不是实测点，别谎报 exact。
      precisionLevel: "building",
      accuracyMeters: derived.accuracyMeters,
      sourceId: null,
      validFrom: null,
      validTo: null,
    },
  };
}

/**
 * 选中/清空 footprint 图形后重算整个 locations 数组。
 * 导出供 tests/location-editor-derived-nav.test.mjs 单测（同 campusMapVersions 的先例）。
 * @param next 新选中的图形；null 表示清空绑定
 */
export function withDerivedNavigation(
  rows: LocationDraft[],
  next: admin.MapFeatureRow | null,
  campusKey: CampusKey | null,
  campusId: string,
): LocationDraft[] {
  const navIndex = rows.findIndex((row) => row.role === "navigation_target");
  const existingNav = navIndex === -1 ? null : rows[navIndex];
  // 人工填过的导航点不动：这里只管自己推导出来的那一行。
  if (existingNav && existingNav.derived !== true) return rows;

  const derived = next === null ? null : derivedNavigationRow(next, campusKey, campusId);
  if (!derived) {
    // 清空轮廓（或推不出来）时撤掉自动行，并把主要位置还给剩下的第一行。
    if (!existingNav) return rows;
    const remaining = rows.filter((_, i) => i !== navIndex);
    return remaining.map((row, i) => ({ ...row, isPrimary: i === 0 }));
  }
  const withNav = existingNav
    ? rows.map((row, i) => (i === navIndex ? { ...derived, id: row.id } : row))
    : [...rows, derived];
  // 契约要求恰好一个主要位置，导航点占这个名额。只点亮推导的这一行：
  // 若编辑者另外手动加过第二个导航行，按 role 全点亮会同时亮两行、违反契约。
  const primaryIndex = existingNav ? navIndex : withNav.length - 1;
  return withNav.map((row, i) => ({ ...row, isPrimary: i === primaryIndex }));
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
  maxRows,
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
  /** 行数上限，达到后藏起「添加位置」。校车站点候车点 + 导航终点时会传 2。 */
  maxRows?: number;
  title?: string;
}) {
  const allowedRoles = roles ?? ALL_ROLES;
  const roleOptions = allowedRoles.map((role) => ({ value: role, label: ROLE_LABELS[role] }));
  // 校区级版本（floorId 为空）每个校区只默认放出最新一个 ready/published：
  // 历史版本留在库里是存档，继续出现在下拉里只会被人工修复时误选（宝山轮廓
  // 残留 20 条就是这么来的）。已绑定旧版本的行例外保留，否则回显成空。
  const latestCampusVersionId = useMemo(() => {
    const latest = new Map<string, admin.MapVersionRow>();
    for (const version of mapVersions) {
      if (version.floorId !== null || version.campusId === null) continue;
      if (version.lifecycleStatus !== "ready" && version.lifecycleStatus !== "published") continue;
      const current = latest.get(version.campusId);
      if (!current || version.createdAt > current.createdAt) latest.set(version.campusId, version);
    }
    return new Set([...latest.values()].map((version) => version.id));
  }, [mapVersions]);
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

  // 调用方传进来的 title 之前被硬编码的面板标题吃掉了：校车的「候车点」、
  // 设施的「楼外位置」、商户的「门店位置」都显示成「地图位置」，同一页上两块位置
  // 面板还会同名。
  const full = maxRows !== undefined && value.length >= maxRows;
  return <Panel title={title} action={full ? null : <GhostButton disabled={disabled} onClick={() => onChange([...value, { ...emptyLocation(allowedRoles[0]), isPrimary: value.length === 0 }])}><Plus size={14} />添加位置</GhostButton>}>
    {featureError ? <ErrorBanner message={featureError} /> : null}
    {value.length === 0 ? <InfoNote>还没有地图位置</InfoNote> : <div className="space-y-3">{value.map((row, index) => {
      const floors = spaces.floors.filter((floor) => !row.buildingPlaceId || floor.buildingPlaceId === row.buildingPlaceId);
      const indoor = spaces.spaces.filter((space) => !row.floorId || space.floorId === row.floorId);
      const versionOptions = mapVersions
        .filter((version) => version.lifecycleStatus === "ready" || version.lifecycleStatus === "published")
        .filter((version) => {
          if (version.id === row.mapVersionId) return true;
          if (version.floorId === null && version.campusId !== null && !latestCampusVersionId.has(version.id)) return false;
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
      // 楼宇的校区由楼宇自身决定，校区下拉是只读回显，画布得跟着那一个。
      const effectiveCampusId = isBuilding === true ? buildingCampusId ?? "" : row.campusId;
      const canvasTools = CANVAS_TOOLS_BY_ROLE[row.role] ?? null;
      const campusKey = canvasCampusKey(effectiveCampusId, spaces.campuses);
      const drawn = hasCanvasGeometry(row);
      const typedPoint = Boolean(row.longitude.trim() || row.latitude.trim());
      // 底图与地图版本在渲染前就解析好：解析失败只换成一条提示，不让画布的
      // 事件回调在保存瞬间抛出来。
      let canvasBinding: { campusId: string; mapVersionId: string } | null = null;
      let canvasBlocked = "";
      if (canvasTools && campusKey) {
        try {
          canvasBinding = campusMapBinding(campusKey, spaces.campuses, mapVersions);
        } catch (error) {
          canvasBlocked = errorMessage(error, "该校区没有可用底图");
        }
      }
      // 换校区就换了底图坐标系，旧坐标在新底图上落在别处，只能一并清掉。
      const patchCampus = (campusId: string) => patch(index, drawn
        ? { campusId, mapFeatureId: "", ...withoutCanvasGeometry(row) }
        : { campusId, mapVersionId: "", mapFeatureId: "" });
      const canvasValue = canvasTools && campusKey
        ? row.role === "navigation_target"
          ? navTargetCanvasValue(row, campusKey)
          : canvasValueOf(row, campusKey, canvasTools)
        : null;
      /** 画布产出 → 这一行的 origin。画布坐标必须与它所属的地图版本同时写库。 */
      const applyCanvas = (next: CanvasGeometry | null) => {
        if (!canvasBinding || !campusKey) return;
        const picked = pickSingleShape(canvasValue, next);
        // navigation_target 不落画布几何：viewBox 点逆变换成 GCJ-02 回填经纬度输入框，
        // 保持 0015 触发器要求的 GCJ02 Point 存储形态；清除点则同时清空经纬度。
        if (row.role === "navigation_target") {
          // 人一旦在图上挪过点，这行就归人管：摘掉 derived，之后改轮廓不再覆盖它。
          if (!picked || !picked.geometry.point) {
            patch(index, { longitude: "", latitude: "", derived: false });
            return;
          }
          const [x, y] = picked.geometry.point;
          const gcj02 = viewBoxToGcj02(CAMPUS_GEO_TRANSFORMS[campusKey], x, y);
          patch(index, {
            campusId: canvasBinding.campusId,
            mapFeatureId: "",
            longitude: String(gcj02.longitude),
            latitude: String(gcj02.latitude),
            derived: false,
          });
          return;
        }
        const shape = picked ? geoJsonOfCanvas(picked.geometry, picked.tool) : null;
        if (!shape) {
          patch(index, withoutCanvasGeometry(row));
          return;
        }
        patch(index, {
          campusId: canvasBinding.campusId,
          mapVersionId: canvasBinding.mapVersionId,
          mapFeatureId: "",
          // 图上点过就以图为准：经纬度留着会在 locationInput 里反过来盖掉画布几何。
          longitude: "",
          latitude: "",
          origin: {
            geometryType: shape.geometryType,
            geometry: shape.geometry,
            crs: CANVAS_CRS,
            precisionLevel: "exact",
            accuracyMeters: row.origin?.accuracyMeters ?? null,
            sourceId: row.origin?.sourceId ?? null,
            validFrom: row.origin?.validFrom ?? null,
            validTo: row.origin?.validTo ?? null,
          },
        });
      };
      return <div className="space-y-3 rounded-xl border border-line p-3" key={row.id}>
        <div className="grid grid-cols-2 gap-2">
          <SelectField
            disabled={disabled || roleOptions.length < 2}
            label="用途"
            onChange={(role) => {
              const next = oneOf(role, "location.role", ALL_ROLES);
              // 换了用途，图上已画的形状可能不再是这个用途允许的类型（影响范围→
              // 主要展示位置就是面变点）。留着它会把一个多边形当成展示点存出去。
              // navigation_target 虽然允许点，但它不存画布几何（只存换算后的 GCJ-02
              // 经纬度），所以切到它时一律清掉已画的画布几何，避免 svg_viewbox 坐标
              // 被当成导航终点写出去。
              const tool = row.origin ? canvasToolOfGeometryType(row.origin.geometryType) : null;
              const stillAllowed = next !== "navigation_target"
                && tool !== null && (CANVAS_TOOLS_BY_ROLE[next] ?? []).includes(tool);
              patch(index, drawn && !stillAllowed ? { role: next, ...withoutCanvasGeometry(row) } : { role: next });
            }}
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
          {/* 图上点过就锁住经纬度：两者都会落到同一处几何，留着能改必然有一个被静默丢弃。 */}
          {/* 人一改坐标就摘掉 derived：之后再动轮廓不会覆盖他的值。 */}
          <Field disabled={disabled || Boolean(row.mapFeatureId) || drawn} label="GCJ-02 经度（可选）" onChange={(longitude) => patch(index, { longitude, derived: false })} placeholder={drawn ? "已在图上标点" : "121.40"} type="number" value={row.longitude} />
          <Field disabled={disabled || Boolean(row.mapFeatureId) || drawn} label="GCJ-02 纬度（可选）" onChange={(latitude) => patch(index, { latitude, derived: false })} placeholder={drawn ? "已在图上标点" : "31.32"} type="number" value={row.latitude} />
          <SelectField
            disabled={disabled || typedPoint || drawn}
            label="地图版本（可选）"
            onChange={(mapVersionId) => patch(index, { mapVersionId, mapFeatureId: "", origin: row.origin ? { ...row.origin, geometryType: "Point", geometry: null, crs: null } : undefined })}
            options={versionOptions}
            placeholder={drawn ? "已由图上标点绑定" : "不绑定地图图形"}
            value={row.mapVersionId}
          />
          <SelectField
            disabled={disabled || !row.mapVersionId || loadingVersions.has(row.mapVersionId) || drawn}
            label="地图图形（可选）"
            onChange={(mapFeatureId) => {
              // 选中/清空轮廓时顺带重算自动导航终点（见 withDerivedNavigation）。
              // 这里不能用 patch()：推导会增删整个数组里的另一行，不只是改本行。
              const applyDerived = (rows: LocationDraft[], next: admin.MapFeatureRow | null) =>
                onChange(row.role === "footprint"
                  ? withDerivedNavigation(rows, next, campusKey, effectiveCampusId)
                  : rows);
              if (!mapFeatureId) {
                applyDerived(value.map((item, i) => i === index
                  ? { ...item, mapFeatureId, origin: item.origin ? { ...item.origin, geometryType: "Point" as GeometryType, geometry: null, crs: null } : undefined }
                  : item), null);
                return;
              }
              const feature = features.find((candidate) => candidate.id === mapFeatureId);
              if (!feature) throw new Error(`地图图形 ${mapFeatureId} 不在所选版本中`);
              applyDerived(value.map((item, i) => i === index
                ? {
                    ...item,
                    mapFeatureId,
                    longitude: "",
                    latitude: "",
                    origin: {
                      geometryType: geometryTypeFromFeature(feature),
                      geometry: null,
                      crs: null,
                      precisionLevel: "exact" as LocationPrecision,
                      accuracyMeters: item.origin?.accuracyMeters ?? null,
                      sourceId: item.origin?.sourceId ?? null,
                      validFrom: item.origin?.validFrom ?? null,
                      validTo: item.origin?.validTo ?? null,
                    },
                  }
                : item), feature);
            }}
            options={featureOptions}
            placeholder={loadingVersions.has(row.mapVersionId) ? "加载图形中…" : "不绑定地图图形"}
            value={row.mapFeatureId}
          />
        </div>

        {/* 校区图选点：这是唯一能产出 svg_viewbox 坐标的入口，也就是让这处位置
            真正出现在用户端地图上的那一步。手填的 GCJ-02 经纬度只喂导航链接，
            渲染层不认，所以两者并列摆着而不是互相替代。
            navigation_target 例外：它的存库形态就是 GCJ-02 经纬度，画布选点逆变换
            后直接回填经纬度输入框，因此经纬度已填时画布照常展示（图钉由经纬度投影）。 */}
        {canvasTools === null ? null : !campusKey ? (
          <InfoNote>先选校区，才能在校园图上标点。</InfoNote>
        ) : canvasBlocked ? (
          <InfoNote tone="warning">{canvasBlocked}</InfoNote>
        ) : typedPoint && row.role !== "navigation_target" ? (
          <InfoNote>已手填经纬度。清空经纬度后可改为在校园图上标点，那样才会在地图上出现图钉。</InfoNote>
        ) : row.mapFeatureId ? (
          <InfoNote>已绑定导入的地图图形，不需要再标点。</InfoNote>
        ) : (
          <div className="space-y-2 rounded-lg bg-page p-3">
            <p className="text-aux text-sub">{row.role === "navigation_target"
              ? "在校园图上选导航终点（自动换算为 GCJ-02 经纬度，可再微调）"
              : "在校园图上标点（决定是否在地图上出现）"}</p>
            <CampusMapCanvas
              campuses={spaces.campuses}
              campusKey={campusKey}
              disabled={disabled}
              height="h-[360px]"
              labels={{ point: ROLE_LABELS[row.role] }}
              mapVersions={mapVersions}
              onChange={applyCanvas}
              tools={canvasTools}
              value={canvasValue}
            />
          </div>
        )}

        <div className="flex justify-end gap-2">{!row.isPrimary ? <GhostButton disabled={disabled} onClick={() => onChange(value.map((item, i) => ({ ...item, isPrimary: i === index })))}>设为主要位置</GhostButton> : null}<GhostButton danger disabled={disabled} onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 size={14} />删除</GhostButton></div>
      </div>;
    })}</div>}
  </Panel>;
}

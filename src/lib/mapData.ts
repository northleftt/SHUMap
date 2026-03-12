import baoshanSvg from "../../地图/宝山本部地图.svg?raw";
import jiadingSvg from "../../地图/嘉定校区地图.svg?raw";
import yanchangSvg from "../../地图/延长校区地图.svg?raw";
import rawBuildings from "../../data/campus-buildings.picked.json";
import type {
  CampusConfig,
  CampusKey,
  FilterKey,
  MapBuilding,
  PoiDetailData,
  RawBuilding,
} from "./types";

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

function normalizePoiDetail(detail?: Partial<PoiDetailData>): PoiDetailData {
  return {
    typeLabel: detail?.typeLabel ?? "",
    facilityNotes: detail?.facilityNotes ?? "",
    organization: detail?.organization ?? "",
    openHours: detail?.openHours ?? "",
    phone: detail?.phone ?? "",
    accessMethod: detail?.accessMethod ?? "",
    coverImageUrl: detail?.coverImageUrl ?? "",
    galleryImageUrl: detail?.galleryImageUrl ?? "",
    hasPrinter: detail?.hasPrinter ?? null,
    hasElevator: detail?.hasElevator ?? null,
    hasVendingMachine: detail?.hasVendingMachine ?? null,
    hasPowerBank: detail?.hasPowerBank ?? null,
    hasParking: detail?.hasParking ?? null,
  };
}

function getCampusKey(campus: string): CampusKey {
  if (campus.includes("宝山")) return "baoshan";
  if (campus.includes("嘉定")) return "jiading";
  return "yanchang";
}

function buildAmapUrl(building: RawBuilding) {
  const navigation = building.navigation;
  if (!navigation?.longitude || !navigation.latitude) {
    return null;
  }

  const name = encodeURIComponent(
    navigation.mapDisplayName || `${building.campus} ${building.name}`,
  );
  return `https://uri.amap.com/navigation?to=${navigation.longitude},${navigation.latitude},${name}&mode=car&policy=1&src=SHUMap&coordinate=gaode&callnative=0`;
}

function getFilterGroups(building: RawBuilding): FilterKey[] {
  const detail = normalizePoiDetail(building.detail);
  const groups = new Set<FilterKey>();

  switch (building.category) {
    case "dorm":
      groups.add("dorm");
      break;
    case "canteen":
      groups.add("canteen");
      groups.add("commercial");
      break;
    case "library":
      groups.add("library");
      groups.add("printing");
      break;
    case "other":
      groups.add("commercial");
      groups.add("parking");
      break;
    case "building":
    default: {
      const normalizedName = building.name.toLowerCase();
      if (/[a-z]\s*楼|教学|实验|学院|馆/.test(normalizedName) || /楼/.test(building.name)) {
        groups.add("teaching");
      }
      if (/行政|办公|中心|伟长/.test(building.name)) {
        groups.add("office");
      }
      if (groups.size === 0) {
        groups.add("teaching");
      }
      break;
    }
  }

  if (detail.hasPrinter === true) {
    groups.add("printing");
  }
  if (detail.hasPowerBank === true) {
    groups.add("powerBank");
  }
  if (detail.hasParking === true) {
    groups.add("parking");
  }

  return Array.from(groups);
}

export const buildings: MapBuilding[] = (rawBuildings as RawBuilding[]).map((building) => {
  const campusKey = getCampusKey(building.campus);
  return {
    ...building,
    detail: normalizePoiDetail(building.detail),
    campusKey,
    campusLabel: building.campus,
    poiKey: `${campusKey}:${building.svgElementId}`,
    filterGroups: getFilterGroups(building),
    amapUrl: buildAmapUrl(building),
  };
});

export function getBuildingsByCampus(campusKey: CampusKey) {
  return buildings.filter((building) => building.campusKey === campusKey);
}

export function getCampusByLabel(label: string) {
  return campusConfigs.find((campus) => campus.label === label) ?? campusConfigs[0];
}

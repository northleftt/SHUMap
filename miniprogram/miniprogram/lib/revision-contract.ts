export type JsonObject = Record<string, unknown>;

export type LocationRole =
  | "primary_display"
  | "footprint"
  | "centroid"
  | "main_entrance"
  | "accessible_entrance"
  | "navigation_target"
  | "service_position"
  | "boarding_point"
  | "alighting_point"
  | "event_location"
  | "impact_area"
  | "route_shape"
  | "other";

export type GeometryType = "Point" | "LineString" | "Polygon" | "MultiPolygon";
export type LocationPrecision = "campus" | "building" | "floor" | "space" | "exact" | "unknown";
export const NAVIGATION_CRS = "GCJ02" as const;

export interface RevisionLocationInput {
  campusId: string | null;
  buildingPlaceId: string | null;
  floorId: string | null;
  indoorSpaceId: string | null;
  role: LocationRole;
  geometryType: GeometryType;
  geometry: JsonObject | null;
  crs: string | null;
  mapVersionId: string | null;
  mapFeatureId: string | null;
  locationHint: string | null;
  precisionLevel: LocationPrecision;
  accuracyMeters: number | null;
  sourceId: string | null;
  validFrom: string | null;
  validTo: string | null;
  isPrimary: boolean;
}

export interface RevisionMediaItem {
  id?: string;
  role: "cover" | "gallery";
  url: string;
  alt?: string;
  caption?: string;
  floorLevelCode?: string;
}

export interface PlaceFact {
  id?: string;
  label: string;
  value: string;
}

export interface PlaceContent extends JsonObject {
  detail: JsonObject & {
    facts: PlaceFact[];
    media: RevisionMediaItem[];
  };
  address?: string;
}

export interface PlaceBuildingStructure {
  buildingCode: string | null;
  managingOrganizationId: string | null;
  publicAccessLevel: "public" | "restricted" | "private" | "unknown";
}

export interface PlaceStructure {
  kindId: string;
  campusId: string | null;
  parentPlaceId: string | null;
  stableCode: string | null;
  aliases: string[];
  building: PlaceBuildingStructure | null;
  locations: RevisionLocationInput[];
}

export interface PlaceRevisionWrite {
  displayName: string;
  summary: string | null;
  description: string | null;
  content: PlaceContent;
  sourceId: string | null;
  structure: PlaceStructure;
}

export interface FacilityContent extends JsonObject {
  media?: RevisionMediaItem[];
  fee?: string;
  locationDescription?: string;
  note?: string;
}

export interface FacilityStructure {
  facilityTypeId: string;
  hostPlaceId: string | null;
  floorId: string | null;
  indoorSpaceId: string | null;
  quantity: number | null;
  operationalStatus: "available" | "partially_available" | "unavailable" | "unknown";
  locations: RevisionLocationInput[];
}

export interface FacilityRevisionWrite {
  displayName: string;
  serviceHours: { text: string } | null;
  content: FacilityContent;
  sourceId: string | null;
  structure: FacilityStructure;
}

export interface MerchantMenuItemWrite {
  name: string;
  price?: string;
  description?: string;
}

export interface MerchantContent extends JsonObject {
  media?: RevisionMediaItem[];
  avgPrice?: string;
  stallCode?: string;
  summary?: string;
  menu?: MerchantMenuItemWrite[];
}

export interface MerchantStructure {
  organizationId: string | null;
  hostPlaceId: string;
  floorId: string | null;
  indoorSpaceId: string | null;
  locations: RevisionLocationInput[];
}

export interface MerchantRevisionWrite {
  displayName: string;
  businessType: string | null;
  openingHours: { text: string } | null;
  contact: { phone: string } | null;
  content: MerchantContent;
  sourceId: string | null;
  structure: MerchantStructure;
}

export const PERMISSIONS = [
  "read:admin",
  "write:content",
  "write:maps",
  "write:transit",
  "review:content",
  "publish:release",
  "rollback:release",
  "manage:users",
] as const;

export type Permission = (typeof PERMISSIONS)[number] | "*";

export type EditorialStatus = "draft" | "in_review" | "approved" | "rejected" | "superseded";
export type GeometryType = "Point" | "LineString" | "Polygon";
export type EntityLocationType =
  | "place"
  | "facility"
  | "merchant_outlet"
  | "operational_event"
  | "campaign"
  | "transit_stop";

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

export interface SessionPrincipal {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  permissions: Permission[];
}

export interface LocationInput {
  campusId?: string | null;
  buildingPlaceId?: string | null;
  floorId?: string | null;
  indoorSpaceId?: string | null;
  role: LocationRole;
  geometryType?: GeometryType | null;
  geometry?: unknown;
  crs?: string | null;
  mapVersionId?: string | null;
  mapFeatureId?: string | null;
  locationHint?: string | null;
  precisionLevel?: "campus" | "building" | "floor" | "space" | "exact" | "unknown";
  accuracyMeters?: number | null;
  sourceId?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
}

export interface PlaceRevisionInput {
  displayName: string;
  summary?: string | null;
  description?: string | null;
  content?: Record<string, unknown>;
  sourceId?: string | null;
}

export interface FacilityRevisionInput {
  displayName: string;
  serviceHours?: unknown;
  content?: Record<string, unknown>;
  sourceId?: string | null;
}

export interface ReleaseManifest {
  schemaVersion: 2;
  release: {
    id: string;
    version: string;
    createdAt: string;
    artifactSha256?: string;
  };
  campuses: unknown[];
  places: unknown[];
  facilities: unknown[];
  merchants: unknown[];
  maps: unknown[];
  locations: unknown[];
  /** lifecycle_status='active' 的全部楼层（客户端楼层视图不再需要绕过 release）。 */
  floors: unknown[];
  /** facility_types 的 id/code/name/category/iconKey，供客户端做 id → code 映射。 */
  facilityTypes: unknown[];
  transit: {
    stops: unknown[];
    routes: unknown[];
    patterns: unknown[];
    patternStops: unknown[];
    calendars: unknown[];
    exceptions: unknown[];
    trips: unknown[];
    stopTimes: unknown[];
  };
  searchDocuments: unknown[];
  generatedAt: string;
}

export interface QueueJobMessage {
  jobId: string;
  jobType: "map_import" | "floor_import" | "media_process" | "search_build" | "release_build" | "garbage_collect";
}

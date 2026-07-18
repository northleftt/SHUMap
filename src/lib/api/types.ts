// Types mirroring the v2 Worker public/admin contracts.
// Sources of truth: worker/domain/types.ts (ReleaseManifest), worker/modules/releases.ts
// (candidate builder + search documents), worker/modules/public.ts (endpoint payloads).

// ---------------------------------------------------------------------------
// Release manifest (GET /api/public/releases/current | /releases/:id)
// ---------------------------------------------------------------------------

export interface ReleaseCampus {
  id: string;
  code: string;
  name: string;
  timezone: string;
}

/** Place row after normalizeJsonFields: *_json columns become parsed objects sans the Json suffix. */
export interface ReleasePlace {
  id: string;
  kindId: string;
  campusId: string | null;
  parentPlaceId: string | null;
  lifecycleStatus: string;
  revisionId: string;
  displayName: string;
  summary: string | null;
  description: string | null;
  content: Record<string, unknown> | null;
  contentHash: string;
}

export interface ReleaseFacility {
  id: string;
  facilityTypeId: string;
  hostPlaceId: string | null;
  floorId: string | null;
  indoorSpaceId: string | null;
  operationalStatus: string;
  quantity: number | null;
  revisionId: string;
  displayName: string;
  serviceHours: unknown;
  content: Record<string, unknown> | null;
  contentHash: string;
  visibilityPolicy: unknown;
}

export interface ReleaseMerchant {
  id: string;
  organizationId: string | null;
  hostPlaceId: string | null;
  floorId: string | null;
  indoorSpaceId: string | null;
  revisionId: string;
  displayName: string;
  businessType: string | null;
  openingHours: unknown;
  contact: unknown;
  content: Record<string, unknown> | null;
  contentHash: string;
}

/** Map version row joined with asset checksum/key. Columns are snake_case (no normalization applied). */
export interface ReleaseMapVersion {
  id: string;
  campus_id: string | null;
  floor_id: string | null;
  version_label: string;
  coordinate_space_type: string;
  coordinate_space_json?: string | null;
  lifecycle_status: string;
  checksum: string;
  assetKey: string;
  [column: string]: unknown;
}

/** entity_locations joined with location_anchors. Anchor columns are snake_case; el.* are camelCase aliases. */
export interface ReleaseLocation {
  entityType: string;
  entityId: string;
  role: string;
  isPrimary: number;
  // location_anchors columns (la.*)
  id: string;
  campus_id: string | null;
  building_place_id: string | null;
  floor_id: string | null;
  indoor_space_id: string | null;
  geometry_type: string | null;
  geometry_json: string | null;
  crs: string | null;
  map_version_id: string | null;
  map_feature_id: string | null;
  location_hint: string | null;
  precision_level: string | null;
  accuracy_meters: number | null;
  verification_status: string | null;
  [column: string]: unknown;
}

export interface ReleaseTransit {
  stops: TransitStop[];
  routes: TransitRoute[];
  patterns: unknown[];
  patternStops: unknown[];
  calendars: unknown[];
  exceptions: unknown[];
  trips: unknown[];
  stopTimes: unknown[];
}

export interface TransitStop {
  id: string;
  place_id: string | null;
  campus_id: string | null;
  code: string | null;
  name: string;
  status: string;
  [column: string]: unknown;
}

export interface TransitRoute {
  id: string;
  code: string | null;
  name: string;
  operator_id: string | null;
  status: string;
  [column: string]: unknown;
}

export type MapTarget =
  | { type: "locationAnchor"; id: string }
  | { type: "place"; id: string }
  | { type: "facility"; id: string }
  | { type: "merchant_outlet"; id: string }
  | { type: string; id: string };

export interface SearchDocument {
  documentType: "place" | "facility" | "merchant_outlet" | string;
  entityId: string;
  title: string;
  subtitle: string | null;
  normalizedText: string;
  pinyin: string | null;
  campusId: string | null;
  buildingPlaceId: string | null;
  floorId: string | null;
  facets: Array<string>;
  mapTarget: MapTarget | null;
  rankingWeight: number;
}

export interface ReleaseManifest {
  schemaVersion: 2;
  release: { id: string; version: string; createdAt: string; artifactSha256?: string };
  campuses: ReleaseCampus[];
  places: ReleasePlace[];
  facilities: ReleaseFacility[];
  merchants: ReleaseMerchant[];
  maps: ReleaseMapVersion[];
  locations: ReleaseLocation[];
  transit: ReleaseTransit;
  searchDocuments: SearchDocument[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// GET /api/public/search
// ---------------------------------------------------------------------------

export interface SearchResult {
  type: string;
  id: string;
  title: string;
  subtitle: string | null;
  campusId: string | null;
  buildingPlaceId: string | null;
  floorId: string | null;
  facets: string[];
  mapTarget: MapTarget | null;
  rankingWeight: number;
}

export interface SearchResponse {
  query: string;
  releaseId?: string;
  results: SearchResult[];
}

// ---------------------------------------------------------------------------
// GET /api/public/places/:id
// ---------------------------------------------------------------------------

export interface PublicPlaceName {
  language: string;
  name: string;
  nameType: string;
}

export interface PublicPlaceLocation {
  role: string;
  isPrimary: number;
  id: string;
  campus_id: string | null;
  building_place_id: string | null;
  floor_id: string | null;
  indoor_space_id: string | null;
  geometry_type: string | null;
  geometry_json: string | null;
  crs: string | null;
  map_version_id: string | null;
  map_feature_id: string | null;
  location_hint: string | null;
  precision_level: string | null;
  [column: string]: unknown;
}

export interface PublicPlaceFacility {
  id: string;
  typeCode: string;
  typeName: string;
  displayName: string;
  operationalStatus: string;
  floorId: string | null;
}

export interface PublicPlaceResponse {
  releaseId: string;
  place: {
    id: string;
    kindId: string;
    campusId: string | null;
    lifecycleStatus: string;
    displayName: string;
    summary: string | null;
    description: string | null;
    content: Record<string, unknown>;
  };
  names: PublicPlaceName[];
  locations: PublicPlaceLocation[];
  facilities: PublicPlaceFacility[];
}

export interface PublicPlaceListItem {
  id: string;
  kindId: string;
  campusId: string | null;
  displayName: string;
  summary: string | null;
}

export interface PublicPlaceListResponse {
  releaseId: string | null;
  items: PublicPlaceListItem[];
}

// ---------------------------------------------------------------------------
// GET /api/public/transit/journeys
// ---------------------------------------------------------------------------

export interface Journey {
  tripId: string;
  routeId: string;
  routeName: string;
  patternId: string;
  bookingPolicy: string;
  bookingUrl: string | null;
  departureTime: string;
  /** null when the source only carries departure times. */
  arrivalTime: string | null;
  fromSequence: number;
  toSequence: number;
}

export interface JourneysResponse {
  date: string;
  timezone: string;
  journeys: Journey[];
}

// ---------------------------------------------------------------------------
// Operations & campaigns (GET /api/public/operations | /campaigns)
// ---------------------------------------------------------------------------

export interface OperationalEvent {
  id: string;
  eventType: string;
  severity: "info" | "warning" | "critical" | string;
  editorialStatus: string;
  operationalStatus: string;
  title: string;
  description: string | null;
  startsAt: string;
  expectedEndsAt: string | null;
  autoExpireAt: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalEventsResponse {
  items: OperationalEvent[];
}

export interface Campaign {
  id: string;
  title: string;
  summary: string | null;
  editorialStatus: string;
  lifecycleStatus: string;
  startsAt: string;
  endsAt: string;
  audienceJson: string | null;
  placementsJson: string | null;
}

export interface CampaignsResponse {
  items: Campaign[];
}

// ---------------------------------------------------------------------------
// POST /api/public/submissions
// ---------------------------------------------------------------------------

export type SubmissionTargetType =
  | "place"
  | "facility"
  | "merchant_outlet"
  | "transit_stop"
  | "new_place";

export interface SubmissionInput {
  targetType: SubmissionTargetType;
  targetId?: string | null;
  baseRevisionId?: string | null;
  payload: Record<string, unknown>;
  submitterName?: string | null;
  submitterContact?: string | null;
}

export interface SubmissionResult {
  id: string;
  status: string;
}

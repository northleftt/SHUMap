// v2 admin domain types. These mirror the admin API payloads in worker/modules/*.
// The legacy POI/marker/overview model has been removed.

export type AdminSection =
  | "dashboard"
  | "spaces"
  | "places"
  | "facilities"
  | "merchants"
  | "maps"
  | "operations"
  | "transit"
  | "submissions"
  | "releases";

export type Severity = "ok" | "warning" | "error" | "info";

export type EditorialStatus = "draft" | "in_review" | "approved" | "rejected" | "superseded";

// ---------------------------------------------------------------------------
// Spaces + reference data (GET /api/admin/spaces, /api/admin/reference-data)
// ---------------------------------------------------------------------------

export interface Campus {
  id: string;
  code: string;
  name: string;
  timezone: string;
  status: string;
}

export interface Building {
  placeId: string;
  buildingCode: string | null;
  managingOrganizationId: string | null;
  publicAccessLevel: string;
  displayName: string | null;
  campusId: string | null;
}

export interface Floor {
  id: string;
  buildingPlaceId: string;
  levelCode: string;
  levelOrder: number;
  displayName: string;
  isPublic: number;
  lifecycleStatus: string;
}

export interface IndoorSpace {
  id: string;
  floorId: string;
  parentSpaceId: string | null;
  spaceType: string;
  stableCode: string | null;
  displayName: string;
  lifecycleStatus: string;
}

export interface SpacesResponse {
  campuses: Campus[];
  buildings: Building[];
  floors: Floor[];
  spaces: IndoorSpace[];
}

export interface Organization {
  id: string;
  name: string;
  kind: string;
  status: string;
  [column: string]: unknown;
}

export interface DataSource {
  id: string;
  source_type: string;
  title: string;
  reliability: string;
  [column: string]: unknown;
}

export interface FacilityType {
  id: string;
  category: string;
  name: string;
  [column: string]: unknown;
}

export interface PlaceKind {
  id: string;
  name: string;
  sort_order: number;
  [column: string]: unknown;
}

export interface ReferenceDataResponse {
  organizations: Organization[];
  sources: DataSource[];
  facilityTypes: FacilityType[];
  placeKinds: PlaceKind[];
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export interface PlaceListItem {
  id: string;
  kindId: string;
  campusId: string | null;
  parentPlaceId: string | null;
  stableCode: string | null;
  lifecycleStatus: string;
  currentRevisionId: string | null;
  displayName: string | null;
  summary: string | null;
  editorialStatus: EditorialStatus | null;
  updatedAt: string;
}

export interface PlaceRevision {
  id: string;
  place_id: string;
  revision_no: number;
  editorial_status: EditorialStatus;
  display_name: string;
  summary: string | null;
  description: string | null;
  created_at: string;
  [column: string]: unknown;
}

export interface PlaceDetailResponse {
  place: Record<string, unknown>;
  revisions: PlaceRevision[];
  names: Array<Record<string, unknown>>;
  locations: Array<Record<string, unknown>>;
  floors: Array<Record<string, unknown>>;
}

export interface FacilityDetailResponse {
  facility: Record<string, unknown>;
  revisions: Array<Record<string, unknown>>;
  locations: Array<Record<string, unknown>>;
}

export interface MerchantDetailResponse {
  merchant: Record<string, unknown>;
  revisions: Array<Record<string, unknown>>;
  locations: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Facilities + merchants
// ---------------------------------------------------------------------------

export interface FacilityListItem {
  id: string;
  facilityTypeId?: string;
  hostPlaceId?: string | null;
  operationalStatus?: string;
  displayName?: string | null;
  editorialStatus?: EditorialStatus | null;
  [column: string]: unknown;
}

export interface MerchantListItem {
  id: string;
  organizationId?: string | null;
  hostPlaceId?: string | null;
  displayName?: string | null;
  businessType?: string | null;
  editorialStatus?: EditorialStatus | null;
  [column: string]: unknown;
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

export interface MapVersion {
  id: string;
  campusId: string | null;
  floorId: string | null;
  versionLabel: string;
  coordinateSpaceType: string;
  lifecycleStatus: string;
  createdAt: string;
  featureCount: number;
}

// ---------------------------------------------------------------------------
// Operations + campaigns
// ---------------------------------------------------------------------------

export interface OperationalEventRow {
  id: string;
  eventType: string;
  severity: string;
  editorialStatus: EditorialStatus;
  operationalStatus: string;
  title: string;
  description: string | null;
  startsAt: string;
  expectedEndsAt: string | null;
  autoExpireAt: string | null;
  createdAt: string;
  [column: string]: unknown;
}

export interface CampaignRow {
  id: string;
  title: string;
  summary: string | null;
  editorialStatus: EditorialStatus;
  lifecycleStatus: string;
  startsAt: string;
  endsAt: string;
  [column: string]: unknown;
}

// ---------------------------------------------------------------------------
// Transit
// ---------------------------------------------------------------------------

export interface TransitResponse {
  stops: Array<Record<string, unknown>>;
  routes: Array<Record<string, unknown>>;
  patterns: Array<Record<string, unknown>>;
  calendars: Array<Record<string, unknown>>;
  trips: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

export interface SubmissionRow {
  id: string;
  targetType: string;
  targetId: string | null;
  baseRevisionId: string | null;
  payloadJson: string;
  submitterName: string | null;
  submitterContact: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
}

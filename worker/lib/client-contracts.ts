import { HttpError } from "./http";

export type ClientContract = "legacy" | "map-2026-09";
export interface ContractPolicy {
  status: "supported" | "deprecated" | "retired";
  successor?: ClientContract;
  sunset?: string;
}
/** Change lifecycle explicitly; dates alone never disable deployed clients. */
export const CLIENT_CONTRACTS: Record<ClientContract, ContractPolicy> = {
  legacy: { status: "supported", successor: "map-2026-09" },
  "map-2026-09": { status: "supported" },
};
export const LATEST_CONTRACT: ClientContract = "map-2026-09";
export function resolveClientContract(request?: Request, policies: Record<ClientContract, ContractPolicy> = CLIENT_CONTRACTS): ClientContract {
  const values = request ? new URL(request.url).searchParams.getAll("contract") : [];
  const value = values.length ? values[0] : "legacy";
  if (values.length > 1 || !Object.hasOwn(policies, value)) {
    throw new HttpError(400, "unsupported_client_contract", "Unsupported client contract", { supported: Object.keys(policies).filter(k => policies[k as ClientContract].status !== "retired") });
  }
  const contract = value as ClientContract;
  if (policies[contract].status === "retired") throw new HttpError(410, "client_contract_retired", "Please update your client", { successor: policies[contract].successor ?? LATEST_CONTRACT });
  return contract;
}
export function contractHeaders(contract: ClientContract): Record<string, string> {
  const policy = CLIENT_CONTRACTS[contract];
  return {
    "x-shumap-contract": contract,
    "x-shumap-contract-status": policy.status,
    ...(policy.status === "deprecated" ? { deprecation: "true" } : {}),
    ...(policy.sunset ? { sunset: policy.sunset } : {}),
  };
}

// Fixed allowlists are the wire contracts. Never spread future canonical fields
// into an already-published contract. Free-form content remains its existing JSON extension point.
const fields = {
  root: "schemaVersion release campuses places facilities merchants maps locations floors facilityTypes mapFilters transit searchDocuments generatedAt",
  release: "id version createdAt",
  campuses: "id code name timezone",
  places: "id kindId kindName campusId parentPlaceId lifecycleStatus revisionId displayName summary description contentHash isBuilding content aliases",
  facilities: "id facilityTypeId hostPlaceId floorId indoorSpaceId operationalStatus quantity revisionId displayName contentHash facilityTypeStatus serviceHours content visibilityPolicy",
  merchants: "id organizationId hostPlaceId floorId indoorSpaceId revisionId displayName businessType contentHash openingHours contact content",
  maps: "id campus_id floor_id map_asset_id parent_version_id version_label coordinate_space_type coordinate_space_json parser_version lifecycle_status created_by created_at checksum assetKey campusCode campusName",
  locations: "entityType entityId role isPrimary id campus_id building_place_id floor_id indoor_space_id geometry_type geometry_json crs map_version_id map_feature_id location_hint precision_level accuracy_meters source_id verification_status verified_by verified_at valid_from valid_to created_at updated_at sourceElementId featureKind",
  floors: "id buildingPlaceId levelCode levelOrder displayName isPublic",
  facilityTypes: "id code name category iconKey status",
  mapFilters: "id key label sortOrder placeKindIds facilityTypeIds includesMerchants",
  stops: "id place_id campus_id code name status created_at updated_at marker_size",
  searchDocuments: "documentType entityId title subtitle normalizedText pinyin campusId buildingPlaceId floorId facets mapTarget rankingWeight",
} as const;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid canonical release object");
  return value as Record<string, unknown>;
}
function pick(value: unknown, keys: string): Record<string, unknown> {
  const source = record(value);
  return Object.fromEntries(keys.split(" ").filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
}
function rows(value: unknown, keys: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Invalid canonical release array");
  return value.map(row => pick(row, keys));
}
export function projectReleaseManifest(value: unknown, contract: ClientContract): Record<string, unknown> {
  const canonical = record(value);
  if (canonical.schemaVersion !== 2) throw new Error("Unsupported canonical schema; add a contract adapter before changing storage schema");
  const result = pick(canonical, fields.root);
  result.release = pick(canonical.release, fields.release);
  for (const name of ["campuses", "places", "facilities", "merchants", "maps", "locations", "facilityTypes", "mapFilters", "searchDocuments"] as const) result[name] = rows(canonical[name], fields[name]);
  result.floors = rows(canonical.floors, fields.floors + (contract === "map-2026-09" ? " imageUrl" : ""));
  for (const name of ["facilities", "merchants"] as const) {
    for (const row of result[name] as Record<string, unknown>[]) {
      if (!Object.hasOwn(row, "indoorSpaceId")) row.indoorSpaceId = null;
      for (const key of ["serviceHours", "openingHours", "contact"]) if (row[key] != null) row[key] = pick(row[key], key === "contact" ? "phone" : "text");
    }
  }
  for (const row of result.locations as Record<string, unknown>[]) if (!Object.hasOwn(row, "indoor_space_id")) row.indoor_space_id = null;
  for (const row of result.searchDocuments as Record<string, unknown>[]) row.mapTarget = pick(row.mapTarget, "type id");
  result.transit = { stops: rows(record(canonical.transit).stops, fields.stops) };
  return result;
}

/**
 * Vite's /api proxy reads the currently published remote release. Preview the
 * two local Jiading additions until a new release containing them is published.
 * Production builds never call this module.
 */
import additions from "../../../data/campus-buildings.additions.json";
import type { ReleaseLocation, ReleaseManifest, ReleasePlace, SearchDocument } from "../api/types";

const EXPECTED_MAP_VERSION = "mapver_088fbbc69ce6448393850eafa85c78ae";
const BUILDINGS = [
  { svgElementId: "waiyu_building", slug: "waiyu-building", featureOrder: 35, revisionId: "prev_7c1b3145c6d46cc73625e6fb", contentHash: "3ae03a2bebf8a5ea0612868274cb3a90c67e8bc1c728246e071a5ee6b6490d8c" },
  { svgElementId: "microelectronic_B_building", slug: "microelectronic-b-building", featureOrder: 36, revisionId: "prev_b88992b885fc9f6c7b3bff44", contentHash: "0359a2afd47d82c1ceea97e80f3336d287816f29f01a8b0722ab690f4c5d7b1c" },
] as const;

export function withLocalBuildingAdditions(manifest: ReleaseManifest): ReleaseManifest {
  const jiadingMap = manifest.maps.find((map) => map.campusCode === "jiading" && map.floor_id === null);
  // The feature order and SVG element IDs below belong to this exact map.
  if (jiadingMap?.id !== EXPECTED_MAP_VERSION) return manifest;

  const places: ReleasePlace[] = [];
  const locations: ReleaseLocation[] = [];
  const searchDocuments: SearchDocument[] = [];
  for (const building of BUILDINGS) {
    const addition = additions.find((item) => item.svgElementId === building.svgElementId);
    if (!addition) continue;
    const id = `place_jiading_${building.slug}`;
    if (manifest.places.some((place) => place.id === id)) continue;

    const anchorId = `anchor_local_${building.svgElementId}`;
    const now = manifest.release.createdAt;
    places.push({
      id,
      kindId: "building",
      kindName: "建筑",
      isBuilding: true,
      campusId: "campus_jiading",
      parentPlaceId: null,
      lifecycleStatus: "active",
      revisionId: building.revisionId,
      displayName: addition.name,
      summary: null,
      description: null,
      content: { detail: { facts: [], media: [] }, address: addition.navigation.address },
      contentHash: building.contentHash,
      aliases: [],
    });
    locations.push({
      entityType: "place",
      entityId: id,
      role: "footprint",
      isPrimary: 0,
      id: anchorId,
      campus_id: "campus_jiading",
      building_place_id: id,
      floor_id: null,
      indoor_space_id: null,
      geometry_type: "Polygon",
      geometry_json: null,
      crs: null,
      map_version_id: jiadingMap.id,
      map_feature_id: `feature_${jiadingMap.id}_${building.featureOrder}`,
      sourceElementId: building.svgElementId,
      featureKind: "building_footprint",
      location_hint: null,
      precision_level: "exact",
      accuracy_meters: null,
      source_id: "source_campus_maps",
      verification_status: "verified",
      verified_by: null,
      verified_at: now,
      valid_from: now,
      valid_to: null,
      created_at: now,
      updated_at: now,
    });
    searchDocuments.push({
      documentType: "place",
      entityId: id,
      title: addition.name,
      subtitle: null,
      normalizedText: addition.name.toLowerCase(),
      pinyin: null,
      campusId: "campus_jiading",
      buildingPlaceId: id,
      floorId: null,
      facets: ["place", "building"],
      mapTarget: { type: "locationAnchor", id: anchorId },
      rankingWeight: 10,
    });
  }
  if (places.length === 0) return manifest;
  return {
    ...manifest,
    places: [...manifest.places, ...places],
    locations: [...manifest.locations, ...locations],
    searchDocuments: [...manifest.searchDocuments, ...searchDocuments],
  };
}

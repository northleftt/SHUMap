import type { ReleaseManifest, SessionPrincipal } from "../domain/types";
import type { DurableObjectState, Env } from "../types/cloudflare";
import { all, first } from "../lib/db";
import { HttpError, json, readJson } from "../lib/http";
import { isoNow, jsonString, makeId, parseJson, requiredString, sha256 } from "../lib/values";
import { normalizeSearchText } from "./places";

interface ReleaseRequest {
  version: string;
  summary?: string;
  reason?: string;
  mapVersionIds?: string[];
}

interface ReleaseRow {
  id: string;
  version: string;
  schema_version: number;
  status: string;
  artifact_key: string | null;
  artifact_sha256: string | null;
  created_at: string;
}

export class ReleaseCoordinator {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.state.blockConcurrencyWhile(async () => {
        const url = new URL(request.url);
        const actorUserId = request.headers.get("x-shumap-user-id");
        if (!actorUserId) throw new HttpError(401, "unauthorized", "Missing release actor");
        if (request.method === "POST" && url.pathname === "/release") {
          return this.publish(request, actorUserId);
        }
        const rollback = url.pathname.match(/^\/rollback\/([^/]+)$/);
        if (request.method === "POST" && rollback) {
          return this.rollback(request, actorUserId, decodeURIComponent(rollback[1]));
        }
        throw new HttpError(404, "not_found", "Release coordinator route does not exist");
      });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status });
      console.error(error);
      return json({ error: { code: "internal_error", message: "Release operation failed" } }, { status: 500 });
    }
  }

  private async publish(request: Request, actorUserId: string): Promise<Response> {
    const body = await readJson<ReleaseRequest>(request);
    const version = requiredString(body.version, "version", 100);
    const duplicate = await first<{ id: string }>(this.env.DB, "select id from releases where version=?", [version]);
    if (duplicate) throw new HttpError(409, "duplicate_version", "Release version already exists");
    const releaseId = makeId("release");
    const now = isoNow();
    await this.env.DB.prepare(
      `insert into releases(id,version,schema_version,status,summary,created_by,created_at) values(?,?,2,'validating',?,?,?)`,
    ).bind(releaseId, version, body.summary ?? null, actorUserId, now).run();

    try {
      const candidate = await buildCandidate(this.env, releaseId, version, now, body.mapVersionIds ?? []);
      const validation = validateCandidate(candidate);
      await this.env.DB.prepare("update releases set validation_report_json=?,validated_at=?,status=? where id=?")
        .bind(jsonString(validation), isoNow(), validation.valid ? "ready" : "validation_failed", releaseId).run();
      if (!validation.valid) {
        return json({ id: releaseId, status: "validation_failed", validation }, { status: 422 });
      }

      await this.env.DB.prepare("update releases set status='publishing' where id=?").bind(releaseId).run();
      const serialized = JSON.stringify(candidate.manifest);
      const artifactHash = await sha256(serialized);
      const artifactKey = `release/artifacts/${releaseId}/manifest.${artifactHash}.json`;
      await this.env.SHUMAP_BUCKET.put(artifactKey, serialized, {
        httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { releaseId, version, sha256: artifactHash },
      });
      const stored = await this.env.SHUMAP_BUCKET.get(artifactKey);
      if (!stored || (await sha256(await stored.text())) !== artifactHash) throw new Error("Release artifact verification failed");

      const previous = await first<{ id: string }>(this.env.DB, "select id from releases where status='active'");
      const statements = [];
      if (previous) statements.push(this.env.DB.prepare("update releases set status='superseded' where id=?").bind(previous.id));
      statements.push(this.env.DB.prepare(
        "update releases set status='active',artifact_key=?,artifact_sha256=?,activated_at=?,supersedes_release_id=? where id=?",
      ).bind(artifactKey, artifactHash, isoNow(), previous?.id ?? null, releaseId));
      statements.push(this.env.DB.prepare(
        "insert into release_activations(id,from_release_id,to_release_id,action,actor_user_id,reason,created_at) values(?,?,?,'publish',?,?,?)",
      ).bind(makeId("activation"), previous?.id ?? null, releaseId, actorUserId, body.reason ?? null, isoNow()));
      // 激活即发布：本次 release 选中的 map version 从 'ready' 提升为 'published'，
      // 否则没有任何代码路径写入 'published'（jobs.ts 导入只写 'ready'）。
      for (const map of candidate.maps as Array<Record<string, unknown>>) {
        statements.push(this.env.DB.prepare(
          "update map_versions set lifecycle_status='published' where id=? and lifecycle_status='ready'",
        ).bind(String(map.id)));
      }
      await this.env.DB.batch(statements);
      await this.env.RELEASE_KV.put("current_release_v2", releaseId);
      return json({ id: releaseId, version, status: "active", artifactSha256: artifactHash, validation }, { status: 201 });
    } catch (error) {
      await this.env.DB.prepare("update releases set status='failed',validation_report_json=? where id=?")
        .bind(jsonString({ valid: false, errors: [error instanceof Error ? error.message : "Unknown release error"] }), releaseId).run();
      throw error;
    }
  }

  private async rollback(request: Request, actorUserId: string, targetReleaseId: string): Promise<Response> {
    const body = await readJson<{ reason?: string }>(request);
    const target = await first<ReleaseRow>(
      this.env.DB,
      "select id,version,schema_version,status,artifact_key,artifact_sha256,created_at from releases where id=? and status in ('active','superseded')",
      [targetReleaseId],
    );
    if (!target?.artifact_key || !target.artifact_sha256) throw new HttpError(404, "not_found", "Rollback target is unavailable");
    if (target.schema_version !== 2) throw new HttpError(409, "incompatible_release", "Rollback target uses an incompatible schema");
    const object = await this.env.SHUMAP_BUCKET.get(target.artifact_key);
    if (!object || (await sha256(await object.text())) !== target.artifact_sha256) {
      throw new HttpError(409, "invalid_artifact", "Rollback target artifact failed verification");
    }
    const current = await first<{ id: string }>(this.env.DB, "select id from releases where status='active'");
    if (current?.id === targetReleaseId) return json({ id: targetReleaseId, status: "active", unchanged: true });
    await this.env.DB.batch([
      ...(current ? [this.env.DB.prepare("update releases set status='superseded' where id=?").bind(current.id)] : []),
      this.env.DB.prepare("update releases set status='active',activated_at=? where id=?").bind(isoNow(), targetReleaseId),
      this.env.DB.prepare(
        "insert into release_activations(id,from_release_id,to_release_id,action,actor_user_id,reason,created_at) values(?,?,?,'rollback',?,?,?)",
      ).bind(makeId("activation"), current?.id ?? null, targetReleaseId, actorUserId, body.reason ?? null, isoNow()),
    ]);
    await this.env.RELEASE_KV.put("current_release_v2", targetReleaseId);
    return json({ id: targetReleaseId, status: "active", rolledBackFrom: current?.id ?? null });
  }
}

async function buildCandidate(env: Env, releaseId: string, version: string, createdAt: string, requestedMapVersionIds: string[]) {
  const [campuses, places, facilities, merchants, locations, maps, stops, routes, patterns, patternStops, calendars, exceptions, trips, stopTimes] = await Promise.all([
    all(env.DB, "select id,code,name,timezone from campuses where status='active' order by code"),
    all<Record<string, unknown>>(env.DB, `select p.id,p.kind_id as kindId,p.campus_id as campusId,p.parent_place_id as parentPlaceId,p.lifecycle_status as lifecycleStatus,
      r.id as revisionId,r.display_name as displayName,r.summary,r.description,r.content_json as contentJson,r.content_hash as contentHash
      from places p join place_revisions r on r.id=p.current_revision_id where p.lifecycle_status<>'retired' and r.editorial_status='approved'`),
    all<Record<string, unknown>>(env.DB, `select f.id,f.facility_type_id as facilityTypeId,f.host_place_id as hostPlaceId,f.floor_id as floorId,f.indoor_space_id as indoorSpaceId,
      f.operational_status as operationalStatus,f.quantity,r.id as revisionId,r.display_name as displayName,r.service_hours_json as serviceHoursJson,
      r.content_json as contentJson,r.content_hash as contentHash,t.visibility_policy_json as visibilityPolicyJson
      from facility_instances f join facility_revisions r on r.id=f.current_revision_id join facility_types t on t.id=f.facility_type_id
      where f.lifecycle_status='active' and r.editorial_status='approved'`),
    all<Record<string, unknown>>(env.DB, `select m.id,m.organization_id as organizationId,m.host_place_id as hostPlaceId,m.floor_id as floorId,m.indoor_space_id as indoorSpaceId,
      r.id as revisionId,r.display_name as displayName,r.business_type as businessType,r.opening_hours_json as openingHoursJson,r.contact_json as contactJson,
      r.content_json as contentJson,r.content_hash as contentHash
      from merchant_outlets m join merchant_revisions r on r.id=m.current_revision_id where m.lifecycle_status<>'retired' and r.editorial_status='approved'`),
    all(env.DB, `select el.entity_type as entityType,el.entity_id as entityId,el.role,el.is_primary as isPrimary,la.*
      from entity_locations el join location_anchors la on la.id=el.anchor_id where el.valid_to is null and (la.valid_to is null or la.valid_to>?)`, [isoNow()]),
    requestedMapVersionIds.length
      ? all(env.DB, `select mv.*,ma.checksum,me.object_key as assetKey from map_versions mv join map_assets ma on ma.id=mv.map_asset_id join media_assets me on me.id=ma.media_asset_id where mv.id in (${requestedMapVersionIds.map(() => "?").join(",")}) and mv.lifecycle_status in ('ready','published')`, requestedMapVersionIds)
      // 默认发布：每个 campus / floor 取最新的 ready 或 published 版本。
      // 导入产出的版本是 'ready'（jobs.ts），只有发布激活才会把它们提升为 'published'。
      : all(env.DB, `select mv.*,ma.checksum,me.object_key as assetKey from map_versions mv
           join map_assets ma on ma.id=mv.map_asset_id join media_assets me on me.id=ma.media_asset_id
          where mv.lifecycle_status in ('ready','published')
            and mv.id=(select mv2.id from map_versions mv2
                        where mv2.lifecycle_status in ('ready','published')
                          and coalesce(mv2.campus_id,'')=coalesce(mv.campus_id,'')
                          and coalesce(mv2.floor_id,'')=coalesce(mv.floor_id,'')
                        order by mv2.created_at desc,mv2.id desc limit 1)`),
    all(env.DB, "select * from transit_stops where status='active'"), all(env.DB, "select * from transit_routes where status='active'"),
    all(env.DB, "select * from transit_patterns"), all(env.DB, "select * from transit_pattern_stops order by pattern_id,stop_sequence"),
    all(env.DB, "select * from service_calendars"), all(env.DB, "select * from service_calendar_exceptions"),
    all(env.DB, "select * from transit_trips where status='active'"), all(env.DB, "select * from transit_stop_times order by trip_id,stop_sequence"),
  ]);

  const searchDocuments = buildSearchDocuments(releaseId, places, facilities, merchants, locations);
  const manifest: ReleaseManifest = {
    schemaVersion: 2,
    release: { id: releaseId, version, createdAt },
    campuses,
    places: places.map(normalizeJsonFields), facilities: facilities.map(normalizeJsonFields), merchants: merchants.map(normalizeJsonFields),
    maps, locations,
    transit: { stops, routes, patterns, patternStops, calendars, exceptions, trips, stopTimes },
    searchDocuments,
    generatedAt: isoNow(),
  };

  const itemStatements = [];
  for (const [entityType, records] of [["place", places], ["facility", facilities], ["merchant_outlet", merchants]] as const) {
    for (const record of records) {
      itemStatements.push(env.DB.prepare("insert into release_items(release_id,entity_type,entity_id,revision_id,item_hash) values(?,?,?,?,?)")
        .bind(releaseId, entityType, String(record.id), String(record.revisionId), String(record.contentHash)));
    }
  }
  for (const map of maps) itemStatements.push(env.DB.prepare("insert into release_map_versions(release_id,map_version_id) values(?,?)").bind(releaseId, String((map as Record<string, unknown>).id)));
  for (const doc of searchDocuments) itemStatements.push(env.DB.prepare(
    `insert into search_documents(release_id,document_type,entity_id,title,subtitle,normalized_text,pinyin,campus_id,building_place_id,floor_id,facets_json,map_target_json,ranking_weight)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(releaseId, doc.documentType, doc.entityId, doc.title, doc.subtitle, doc.normalizedText, doc.pinyin, doc.campusId, doc.buildingPlaceId, doc.floorId, jsonString(doc.facets), jsonString(doc.mapTarget), doc.rankingWeight));
  if (itemStatements.length) await env.DB.batch(itemStatements);
  return { manifest, places, facilities, merchants, maps, locations, searchDocuments };
}

function validateCandidate(candidate: Awaited<ReturnType<typeof buildCandidate>>) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!candidate.maps.length) errors.push("At least one published or explicitly selected map version is required");
  const mapIds = new Set(candidate.maps.map((map) => String((map as Record<string, unknown>).id)));
  const placeIds = new Set(candidate.places.map((place) => String(place.id)));
  for (const facility of candidate.facilities) {
    if (facility.hostPlaceId && !placeIds.has(String(facility.hostPlaceId))) errors.push(`Facility ${facility.id} refers to an unpublished host place`);
  }
  for (const location of candidate.locations as Array<Record<string, unknown>>) {
    if (location.map_version_id && !mapIds.has(String(location.map_version_id))) {
      warnings.push(`Location ${location.id} uses a map version outside this release`);
    }
  }
  if (!candidate.places.length) warnings.push("Release has no approved places");
  return { valid: errors.length === 0, errors, warnings, counts: {
    places: candidate.places.length, facilities: candidate.facilities.length, merchants: candidate.merchants.length,
    maps: candidate.maps.length, locations: candidate.locations.length, searchDocuments: candidate.searchDocuments.length,
  } };
}

function buildSearchDocuments(
  releaseId: string,
  places: Array<Record<string, unknown>>,
  facilities: Array<Record<string, unknown>>,
  merchants: Array<Record<string, unknown>>,
  locations: unknown[],
) {
  const primaryLocation = new Map<string, Record<string, unknown>>();
  for (const raw of locations as Array<Record<string, unknown>>) {
    if (Number(raw.isPrimary) === 1) primaryLocation.set(`${raw.entityType}:${raw.entityId}`, raw);
  }
  return [
    ...places.map((record) => document(releaseId, "place", record, primaryLocation.get(`place:${record.id}`), 10)),
    ...facilities.map((record) => document(releaseId, "facility", record, primaryLocation.get(`facility:${record.id}`), 8)),
    ...merchants.map((record) => document(releaseId, "merchant_outlet", record, primaryLocation.get(`merchant_outlet:${record.id}`), 7)),
  ];
}

function document(_releaseId: string, type: string, record: Record<string, unknown>, location: Record<string, unknown> | undefined, weight: number) {
  const title = String(record.displayName ?? record.id);
  return {
    documentType: type, entityId: String(record.id), title,
    subtitle: location?.location_hint ? String(location.location_hint) : null,
    normalizedText: normalizeSearchText(`${title} ${record.summary ?? ""} ${record.businessType ?? ""}`), pinyin: null,
    campusId: String(record.campusId ?? location?.campus_id ?? "") || null,
    buildingPlaceId: String(record.hostPlaceId ?? location?.building_place_id ?? "") || null,
    floorId: String(record.floorId ?? location?.floor_id ?? "") || null,
    facets: [type, record.kindId, record.facilityTypeId, record.businessType].filter(Boolean),
    mapTarget: location ? { type: "locationAnchor", id: location.id } : { type, id: record.id },
    rankingWeight: weight,
  };
}

function normalizeJsonFields(record: Record<string, unknown>) {
  const result: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(result)) {
    if (key.endsWith("Json") && typeof value === "string") {
      result[key.slice(0, -4)] = parseJson(value, null);
      delete result[key];
    }
  }
  return result;
}

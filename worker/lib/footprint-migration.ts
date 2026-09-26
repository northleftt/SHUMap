import type { PlaceRevisionWrite } from "../../shared/revision-contract";
import type { Env } from "../types/cloudflare";
import { all, first } from "./db";
import { HttpError } from "./http";

/** Resolve a stale draft through recorded feature lineage before applying its structure. */
export async function migrateRevisionFootprint(env: Env, revision: PlaceRevisionWrite): Promise<void> {
  if (!revision.structure.building) return;
  const footprint = revision.structure.locations.find((location) => location.role === "footprint");
  if (!footprint?.mapFeatureId || !footprint.mapVersionId || !footprint.campusId) return;
  const target = await first<{ id: string }>(env.DB,
    `select id from map_versions where campus_id=? and floor_id is null
       and lifecycle_status in ('ready','published') order by created_at desc,id desc limit 1`,
    [footprint.campusId]);
  if (!target || target.id === footprint.mapVersionId) return;
  const source = await first<{ id: string }>(env.DB,
    `select mf.id from map_features mf join map_versions mv on mv.id=mf.map_version_id
      where mf.id=? and mv.id=? and mv.campus_id=? and mv.floor_id is null`,
    [footprint.mapFeatureId, footprint.mapVersionId, footprint.campusId]);
  if (!source) throw new HttpError(400, "validation_error", "建筑轮廓与原地图版本或校区不匹配");

  const edges = await all<{ fromId: string; toId: string; versionId: string; geometryType: string | null }>(env.DB,
    `select m.from_feature_id as fromId,m.to_feature_id as toId,
            dst.map_version_id as versionId,json_extract(dst.geometry_json,'$.type') as geometryType
       from map_feature_mappings m
       join map_features src on src.id=m.from_feature_id
       join map_versions src_mv on src_mv.id=src.map_version_id
       join map_features dst on dst.id=m.to_feature_id
       join map_versions dst_mv on dst_mv.id=dst.map_version_id
      where src_mv.campus_id=? and dst_mv.campus_id=?
        and src_mv.floor_id is null and dst_mv.floor_id is null
        and (m.mapping_status='confirmed' or (m.mapping_status='automatic' and m.confidence=1))`,
    [footprint.campusId, footprint.campusId]);
  const visited = new Set<string>();
  let featureId = footprint.mapFeatureId;
  while (!visited.has(featureId)) {
    visited.add(featureId);
    const next = edges.filter((edge) => edge.fromId === featureId);
    if (next.length !== 1) break;
    const edge = next[0];
    if (edge.versionId === target.id) {
      if (edge.geometryType !== "Polygon" && edge.geometryType !== "MultiPolygon") break;
      footprint.mapVersionId = target.id;
      footprint.mapFeatureId = edge.toId;
      footprint.geometryType = edge.geometryType;
      return;
    }
    featureId = edge.toId;
  }
  throw new HttpError(409, "footprint_migration_required",
    "建筑轮廓的地图版本已更新，缺少唯一可信的图形映射，请在地点编辑页选择当前地图的轮廓后重新提交。",
    { mapFeatureId: footprint.mapFeatureId, currentMapVersionId: footprint.mapVersionId, targetMapVersionId: target.id });
}

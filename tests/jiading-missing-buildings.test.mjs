import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDir = path.join(root, "migrations-v2");
const repairName = "0038_jiading_missing_buildings.sql";
const mapVersionId = "mapver_088fbbc69ce6448393850eafa85c78ae";

test("Jiading map repair publishes both missing teaching buildings with clickable footprints", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  for (const name of fs.readdirSync(migrationDir).filter((name) => name.endsWith(".sql") && name < repairName).sort()) {
    db.exec(fs.readFileSync(path.join(migrationDir, name), "utf8"));
  }

  db.prepare(`insert into map_versions(id,campus_id,map_asset_id,version_label,coordinate_space_type,
      coordinate_space_json,parser_version,lifecycle_status,created_at)
    values(?,'campus_jiading','map_asset_campus_jiading','嘉20260824','svg_viewbox',
      '{"x":0,"y":0,"width":466,"height":362}','svg-geometry-v3','published',datetime('now'))`)
    .run(mapVersionId);
  for (const [order, sourceElementId] of [[35, "waiyu_building"], [36, "microelectronic_B_building"]]) {
    db.prepare(`insert into map_features(id,map_version_id,source_element_id,feature_kind,geometry_json)
      values(?,?,?,'other','{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}')`)
      .run(`feature_${mapVersionId}_${order}`, mapVersionId, sourceElementId);
  }

  db.exec(fs.readFileSync(path.join(migrationDir, repairName), "utf8"));
  const buildings = db.prepare(`
    select p.id,p.kind_id as kindId,r.display_name as name,r.content_json as contentJson,
           r.structure_json as structureJson,r.content_hash as contentHash,
           mf.source_element_id as sourceElementId,mf.feature_kind as featureKind,
           c.key as filterKey
      from places p
      join place_revisions r on r.id=p.current_revision_id
      join buildings b on b.place_id=p.id
      join entity_locations el on el.entity_type='place' and el.entity_id=p.id and el.role='footprint'
      join location_anchors la on la.id=el.anchor_id
      join map_features mf on mf.id=la.map_feature_id and mf.map_version_id=la.map_version_id
      join map_filter_members member on member.place_kind_id=p.kind_id
      join map_filter_categories c on c.id=member.category_id
     where p.id in ('place_jiading_waiyu-building','place_jiading_microelectronic-b-building')
     order by p.id
  `).all();
  assert.deepEqual(buildings.map(({ id, kindId, name, sourceElementId, featureKind, filterKey }) =>
    ({ id, kindId, name, sourceElementId, featureKind, filterKey })), [
    { id: "place_jiading_microelectronic-b-building", kindId: "building", name: "微电子B楼", sourceElementId: "microelectronic_B_building", featureKind: "building_footprint", filterKey: "teaching" },
    { id: "place_jiading_waiyu-building", kindId: "building", name: "数字系外语楼", sourceElementId: "waiyu_building", featureKind: "building_footprint", filterKey: "teaching" },
  ]);
  for (const building of buildings) {
    assert.equal(building.contentHash, crypto.createHash("sha256").update(
      `${building.name}\n\n\n${building.contentJson}\n${building.structureJson}`,
    ).digest("hex"));
  }
  assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
  db.close();
});

pragma foreign_keys = on;

-- Field testing through the admin console and the volunteer collection form left
-- three rows in shapes that no current code path can produce. 0011 canonicalized
-- the 121 seeded places and their 122 revisions from an explicit map; these rows
-- were created after that map was generated, so they were not in it.
--
-- Every value written below is either derived from the relational rows 0011
-- already made canonical, or copied verbatim from the row being rewritten. Each
-- rewrite is gated on the exact pre-state it expects: if a row does not match,
-- the migration aborts rather than overwriting content it cannot account for.

create table field_test_residue_guard (
  valid integer not null check (valid=1)
);

-- 1. floors.level_code
--
-- POST /api/admin/floors takes level_code as free text (worker/modules/spaces.ts
-- requiredString with no format check), so a floor created by hand kept the
-- Chinese label the collection form had produced. formatFloorDisplayName and
-- floorOrderOf in worker/modules/reviews.ts only accept F<n>/B<n>, and the
-- floor a review creates from the same collection document would be 'F1', so
-- 'F1' is the value this row would carry had it gone through review.
insert into field_test_residue_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from floors
 where level_code not glob 'F[0-9]*'
   and level_code not glob 'B[0-9]*'
   and level_code<>'一层';

update floors
   set level_code='F1',
       level_order=1,
       display_name='1 层',
       updated_at=datetime('now')
 where level_code='一层'
   and level_order=0
   and not exists (
     select 1 from floors other
      where other.building_place_id=floors.building_place_id
        and other.level_code='F1'
   );

-- 2. place_revisions.structure_json
--
-- 0009 added structure_json with a '{}' default, and 0011 filled it for every
-- revision in its map. Two revisions created during field testing are not in
-- that map, so they still hold '{}'. The admin place editor reads structure
-- strictly (src/admin/pages/PlaceEditorPage.tsx requires structure.kindId), so
-- '{}' makes those places impossible to open.
--
-- 3. place_revisions.content_json
--
-- One of the two also carries the pre-taxonomy content keys the old seed wrote
-- (legacyCategory / legacySvgElementId) plus two keys an earlier collection
-- review added (collectionFloors / collectionSubmissionId). None of the four is
-- read by any current code path, and the flat detail fields they sit beside
-- (typeLabel, openHours, hasPrinter, …) were all empty or null — the real values
-- are already in detail.facts, which is what the current contract reads.
--
-- Both rows are rewritten together because content_hash covers content_json and
-- structure_json jointly: sha256(displayName\nsummary\ndescription\ncontent\nstructure),
-- per worker/modules/places.ts and worker/modules/submissions.ts. The hashes
-- below were computed with that formula over the exact literals written here,
-- and verified against a revision 0011 canonicalized itself.

insert into field_test_residue_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from place_revisions
 where (
     structure_json='{}'
     or json_type(structure_json,'$.kindId') is null
     or json_type(content_json,'$.legacyCategory') is not null
     or json_type(content_json,'$.legacySvgElementId') is not null
     or json_type(content_json,'$.collectionFloors') is not null
     or json_type(content_json,'$.collectionSubmissionId') is not null
   )
   and id not in (
     'prev_1b55c3caa5dc4bd98010e05fa4024545',
     'prev_f7300c41aaea4098ba76a1597b4c7b76'
   );

update place_revisions
   set content_json='{"detail":{"facts":[{"label":"开放时间","value":"测试"},{"label":"联系电话","value":"110101195306153019"},{"label":"所属单位","value":"习近平思想研究院"}],"media":[{"role":"cover","url":"/api/public/media/media_77137d828e504abda59cac94b4f4ca32","alt":"","caption":"用户提供"}]},"address":"上海市宝山区上大路99号 上海大学宝山校区 A楼"}',
       structure_json='{"kindId":"building","campusId":"campus_baoshan","parentPlaceId":null,"stableCode":"building-a","aliases":[],"building":{"buildingCode":"building-a","managingOrganizationId":null,"publicAccessLevel":"unknown"},"locations":[{"campusId":"campus_baoshan","buildingPlaceId":"place_baoshan_building-a","role":"navigation_target","geometryType":"Point","geometry":{"type":"Point","coordinates":[121.39552,31.313513]},"crs":"GCJ02","locationHint":"上海市宝山区上大路99号 上海大学宝山校区 A楼","precisionLevel":"exact","sourceId":"source_campus_maps","isPrimary":true},{"campusId":"campus_baoshan","buildingPlaceId":"place_baoshan_building-a","role":"footprint","geometryType":"Polygon","mapVersionId":"map_version_campus_baoshan","mapFeatureId":"map_feature_baoshan_building_A","precisionLevel":"exact","sourceId":"source_campus_maps","isPrimary":false}]}',
       content_hash='f080034a424b3dcf4e937d409282833a54b15d1ced3fc349fa25991d4aa95c7f'
 where id='prev_1b55c3caa5dc4bd98010e05fa4024545'
   and content_hash='d6984d4f0c68ced60bb07981c270c20cde9f7d3f2c23b0f4032c7667be131d10'
   and display_name='A 楼'
   and summary is null
   and description is null;

update place_revisions
   set content_json='{"detail":{"facts":[],"media":[]}}',
       structure_json='{"kindId":"residence","campusId":"campus_jiading","parentPlaceId":null,"stableCode":">","aliases":[],"building":null,"locations":[]}',
       content_hash='26c14671363a69d5b099e72f2f3d868f7925849d3bd608949c85282d3c4ef450'
 where id='prev_f7300c41aaea4098ba76a1597b4c7b76'
   and content_hash='66a1fb398da01a92b4b001adbc13c283187a8e1d292d071d48acccddc0289042'
   and display_name='test'
   and summary is null
   and description is null
   and content_json='{}';

-- Final contracts. These hold on a database that never saw the residue as well,
-- so the migration is a no-op wherever the rows do not exist.
insert into field_test_residue_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from floors
 where (level_code not glob 'F[0-9]*' and level_code not glob 'B[0-9]*')
    or substr(level_code,2) glob '*[^0-9]*'
    or level_code<>substr(level_code,1,1)||cast(substr(level_code,2) as integer);

insert into field_test_residue_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from place_revisions
 where structure_json='{}'
    or json_type(structure_json,'$.kindId') is not 'text'
    or json_type(content_json,'$.detail') is not 'object'
    or json_type(content_json,'$.detail.facts') is not 'array'
    or json_type(content_json,'$.detail.media') is not 'array'
    or json_type(content_json,'$.legacyCategory') is not null
    or json_type(content_json,'$.legacySvgElementId') is not null;

insert into field_test_residue_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from place_revisions
 where json_type(content_json,'$.collectionFloors') is not null
    or json_type(content_json,'$.collectionSubmissionId') is not null;

-- structure_json.kindId must agree with the relational kind it describes.
insert into field_test_residue_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from place_revisions r
  join places p on p.id=r.place_id
 where json_extract(r.structure_json,'$.kindId')<>p.kind_id;

drop table field_test_residue_guard;

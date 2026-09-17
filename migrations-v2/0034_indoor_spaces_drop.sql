-- 0034_indoor_spaces_drop.sql — 删除 indoor_spaces 及其引用列
--
-- 盘查（2026-09-06）确认：indoor_spaces 表 0 行，设施/商户/锚点的
-- indoor_space_id 引用计数全 0 —— 楼内空间从未真正启用，随楼层图改造一并拆除。
--
--   · facility_instances / merchant_outlets：列级 FK 可以直接 drop column；
--   · location_anchors：表级 CHECK 引用了 indoor_space_id，SQLite 拒绝 drop
--     这种列，只能按 0011 的老办法重建表（备份引用行 → 换表 → 恢复），
--     重建后表级 CHECK 去掉 indoor_space_id 析取项；
--   · 重建会带走表上的 7 个触发器，逐一重建 —— 其中 footprint 契约两个
--     触发器里的 indoor_space_id 子句随列一起删掉，其余逐字保留；
--   · 最后 drop indoor_spaces。
--
-- release manifest 的 facilities/merchants/locations 仍然输出 indoorSpaceId
-- （恒为 null）：已发布的小程序按 exactObject 白名单校验，这个键要留到旧版
-- 客户端自然消亡后才能从契约里拿掉（与 0027 marker_size 的口径一致）。

pragma foreign_keys = on;

alter table facility_instances drop column indoor_space_id;
alter table merchant_outlets drop column indoor_space_id;

-- location_anchors 重建。引用它的行先备份清空，避免换表时 ON DELETE 动作牵连。
create table entity_location_spaces_migration as
select * from entity_locations;
create table transit_pattern_anchor_spaces_migration as
select id,route_anchor_id from transit_patterns where route_anchor_id is not null;

delete from entity_locations;
update transit_patterns set route_anchor_id=null where route_anchor_id is not null;

create table location_anchors_new (
  id text primary key,
  campus_id text references campuses(id) on delete restrict,
  building_place_id text references buildings(place_id) on delete restrict,
  floor_id text references floors(id) on delete restrict,
  role text not null check (role in ('primary_display','footprint','centroid','main_entrance','accessible_entrance','navigation_target','service_position','boarding_point','alighting_point','event_location','impact_area','route_shape','other')),
  geometry_type text not null check (geometry_type in ('Point','LineString','Polygon','MultiPolygon')),
  geometry_json text check (geometry_json is null or json_valid(geometry_json)),
  crs text,
  map_version_id text references map_versions(id) on delete restrict,
  map_feature_id text references map_features(id) on delete restrict,
  location_hint text,
  precision_level text not null default 'unknown' check (precision_level in ('campus','building','floor','space','exact','unknown')),
  accuracy_meters real,
  source_id text references data_sources(id) on delete set null,
  verification_status text not null default 'unverified' check (verification_status in ('unverified','reviewed','verified','rejected')),
  verified_by text references users(id) on delete set null,
  verified_at text,
  valid_from text,
  valid_to text,
  created_at text not null,
  updated_at text not null,
  check (geometry_json is not null or map_feature_id is not null or building_place_id is not null or floor_id is not null),
  check (map_feature_id is null or map_version_id is not null)
);

insert into location_anchors_new(
  id,campus_id,building_place_id,floor_id,role,geometry_type,
  geometry_json,crs,map_version_id,map_feature_id,location_hint,precision_level,
  accuracy_meters,source_id,verification_status,verified_by,verified_at,valid_from,
  valid_to,created_at,updated_at
)
select id,campus_id,building_place_id,floor_id,role,geometry_type,
       geometry_json,crs,map_version_id,map_feature_id,location_hint,precision_level,
       accuracy_meters,source_id,verification_status,verified_by,verified_at,valid_from,
       valid_to,created_at,updated_at
  from location_anchors;

-- 依赖 location_anchors 的旁表触发器（entity_locations / map_features 上的 7 个）
-- 在旧表删除后会成为悬空引用，拖垮下一条 DDL，先摘掉，换表后逐字重建。
drop trigger protect_footprint_feature_contract_update;
drop trigger require_entity_location_role_match_insert;
drop trigger require_entity_location_role_match_update;
drop trigger require_footprint_binding_owner_insert;
drop trigger require_footprint_binding_owner_update;
drop trigger require_unique_active_feature_footprint_insert;
drop trigger require_unique_active_feature_footprint_update;

drop table location_anchors;
alter table location_anchors_new rename to location_anchors;
create index idx_anchor_building_floor on location_anchors(building_place_id, floor_id, role);
create index idx_anchor_map on location_anchors(map_version_id, role);

-- 触发器重建。footprint 契约里的 indoor_space_id 子句随列删除；其余逐字保留。
CREATE TRIGGER protect_anchor_role_binding_update
before update of role on location_anchors
when new.role<>old.role and exists (
  select 1 from entity_locations binding
   where binding.anchor_id=old.id and binding.role<>new.role
)
BEGIN
  select raise(abort,'anchor role must match every entity location binding');
END;

CREATE TRIGGER protect_footprint_anchor_owner_update
before update of role,building_place_id on location_anchors
when new.role='footprint' and exists (
  select 1 from entity_locations binding
   where binding.anchor_id=old.id
     and (binding.entity_type<>'place' or binding.entity_id<>new.building_place_id)
)
BEGIN
  select raise(abort,'footprint anchor must preserve its binding owner');
END;

CREATE TRIGGER require_footprint_anchor_contract_insert
before insert on location_anchors
when new.role='footprint'
BEGIN
  select raise(abort,'footprint anchor must reference a canonical campus building feature')
    WHERE new.campus_id is null
    or new.building_place_id is null
    or new.floor_id is not null
    or new.geometry_type not in ('Polygon','MultiPolygon')
    or new.geometry_json is not null
    or new.crs is not null
    or new.map_version_id is null
    or new.map_feature_id is null
    or not exists (
      select 1 from buildings building join places place on place.id=building.place_id
       where building.place_id=new.building_place_id and place.campus_id=new.campus_id
    )
    or not exists (
      select 1
        from map_features feature
        join map_versions version on version.id=feature.map_version_id
       where feature.id=new.map_feature_id
         and feature.map_version_id=new.map_version_id
         and feature.feature_kind='building_footprint'
         and feature.source_element_id is not null
         and json_extract(feature.geometry_json,'$.type')=new.geometry_type
         and version.floor_id is null
         and version.campus_id=new.campus_id
    );
END;

CREATE TRIGGER require_footprint_anchor_contract_update
before update of role,campus_id,building_place_id,floor_id,geometry_type,
                 geometry_json,crs,map_version_id,map_feature_id on location_anchors
when new.role='footprint'
BEGIN
  select raise(abort,'footprint anchor must reference a canonical campus building feature')
    WHERE new.campus_id is null
    or new.building_place_id is null
    or new.floor_id is not null
    or new.geometry_type not in ('Polygon','MultiPolygon')
    or new.geometry_json is not null
    or new.crs is not null
    or new.map_version_id is null
    or new.map_feature_id is null
    or not exists (
      select 1 from buildings building join places place on place.id=building.place_id
       where building.place_id=new.building_place_id and place.campus_id=new.campus_id
    )
    or not exists (
      select 1
        from map_features feature
        join map_versions version on version.id=feature.map_version_id
       where feature.id=new.map_feature_id
         and feature.map_version_id=new.map_version_id
         and feature.feature_kind='building_footprint'
         and feature.source_element_id is not null
         and json_extract(feature.geometry_json,'$.type')=new.geometry_type
         and version.floor_id is null
         and version.campus_id=new.campus_id
    );
END;

CREATE TRIGGER require_navigation_anchor_contract_insert
before insert on location_anchors
when new.role='navigation_target'
BEGIN
  select raise(abort,'navigation target must be a valid GCJ02 Point')
    WHERE new.geometry_type<>'Point'
    or new.geometry_json is null
    or json_extract(new.geometry_json,'$.type') is not 'Point'
    or json_type(new.geometry_json,'$.coordinates') is not 'array'
    or json_array_length(new.geometry_json,'$.coordinates')<>2
    or coalesce(json_type(new.geometry_json,'$.coordinates[0]'),'') not in ('integer','real')
    or coalesce(json_type(new.geometry_json,'$.coordinates[1]'),'') not in ('integer','real')
    or json_extract(new.geometry_json,'$.coordinates[0]') not between -180 and 180
    or json_extract(new.geometry_json,'$.coordinates[1]') not between -90 and 90
    or new.crs is not 'GCJ02';
END;

CREATE TRIGGER require_navigation_anchor_contract_update
before update of role,geometry_type,geometry_json,crs on location_anchors
when new.role='navigation_target'
BEGIN
  select raise(abort,'navigation target must be a valid GCJ02 Point')
    WHERE new.geometry_type<>'Point'
    or new.geometry_json is null
    or json_extract(new.geometry_json,'$.type') is not 'Point'
    or json_type(new.geometry_json,'$.coordinates') is not 'array'
    or json_array_length(new.geometry_json,'$.coordinates')<>2
    or coalesce(json_type(new.geometry_json,'$.coordinates[0]'),'') not in ('integer','real')
    or coalesce(json_type(new.geometry_json,'$.coordinates[1]'),'') not in ('integer','real')
    or json_extract(new.geometry_json,'$.coordinates[0]') not between -180 and 180
    or json_extract(new.geometry_json,'$.coordinates[1]') not between -90 and 90
    or new.crs is not 'GCJ02';
END;

CREATE TRIGGER validate_anchor_map_feature_insert
before insert on location_anchors
when new.map_feature_id is not null
BEGIN
  select raise(abort,'anchor map feature must belong to its map version')
    WHERE not exists (
    select 1 from map_features f
     where f.id=new.map_feature_id and f.map_version_id=new.map_version_id
  );
END;

CREATE TRIGGER validate_anchor_map_feature_update
before update of map_feature_id,map_version_id on location_anchors
when new.map_feature_id is not null
BEGIN
  select raise(abort,'anchor map feature must belong to its map version')
    WHERE not exists (
    select 1 from map_features f
     where f.id=new.map_feature_id and f.map_version_id=new.map_version_id
  );
END;

-- 旁表触发器逐字重建（不引用 indoor_space_id，无需改动）。
CREATE TRIGGER protect_footprint_feature_contract_update
before update of map_version_id,source_element_id,feature_kind,geometry_json on map_features
when exists (
  select 1 from location_anchors anchor
   where anchor.map_feature_id=old.id and anchor.role='footprint' and anchor.valid_to is null
)
BEGIN
  select raise(abort,'active footprint feature must preserve its canonical contract')
    WHERE new.feature_kind<>'building_footprint'
    or new.source_element_id is null
    or json_extract(new.geometry_json,'$.type') not in ('Polygon','MultiPolygon')
    or exists (
      select 1 from location_anchors anchor
       where anchor.map_feature_id=old.id and anchor.role='footprint' and anchor.valid_to is null
         and (
           anchor.map_version_id<>new.map_version_id
           or anchor.geometry_type<>json_extract(new.geometry_json,'$.type')
         )
    );
END;

CREATE TRIGGER require_entity_location_role_match_insert
before insert on entity_locations
BEGIN
  select raise(abort,'entity location role must match anchor role')
    WHERE not exists (
    select 1 from location_anchors anchor
     where anchor.id=new.anchor_id and anchor.role=new.role
  );
END;

CREATE TRIGGER require_entity_location_role_match_update
before update of anchor_id,role on entity_locations
BEGIN
  select raise(abort,'entity location role must match anchor role')
    WHERE not exists (
    select 1 from location_anchors anchor
     where anchor.id=new.anchor_id and anchor.role=new.role
  );
END;

CREATE TRIGGER require_footprint_binding_owner_insert
before insert on entity_locations
when new.role='footprint'
BEGIN
  select raise(abort,'footprint binding must belong to its anchor building')
    WHERE new.entity_type<>'place' or not exists (
    select 1 from location_anchors anchor
     where anchor.id=new.anchor_id and anchor.building_place_id=new.entity_id
  );
END;

CREATE TRIGGER require_footprint_binding_owner_update
before update of entity_type,entity_id,anchor_id,role on entity_locations
when new.role='footprint'
BEGIN
  select raise(abort,'footprint binding must belong to its anchor building')
    WHERE new.entity_type<>'place' or not exists (
    select 1 from location_anchors anchor
     where anchor.id=new.anchor_id and anchor.building_place_id=new.entity_id
  );
END;

CREATE TRIGGER require_unique_active_feature_footprint_insert
before insert on entity_locations
when new.valid_to is null and new.role='footprint'
BEGIN
  select raise(abort,'map feature already has an active footprint binding')
    WHERE exists (
    select 1
      from entity_locations binding
      join location_anchors current_anchor on current_anchor.id=binding.anchor_id
      join location_anchors new_anchor on new_anchor.id=new.anchor_id
     where binding.valid_to is null and binding.role='footprint'
       and current_anchor.map_feature_id=new_anchor.map_feature_id
  );
END;

CREATE TRIGGER require_unique_active_feature_footprint_update
before update of anchor_id,role,valid_to on entity_locations
when new.valid_to is null and new.role='footprint'
BEGIN
  select raise(abort,'map feature already has an active footprint binding')
    WHERE exists (
    select 1
      from entity_locations binding
      join location_anchors current_anchor on current_anchor.id=binding.anchor_id
      join location_anchors new_anchor on new_anchor.id=new.anchor_id
     where binding.id<>old.id and binding.valid_to is null and binding.role='footprint'
       and current_anchor.map_feature_id=new_anchor.map_feature_id
  );
END;

-- 恢复引用行
insert into entity_locations(
  id,entity_type,entity_id,anchor_id,role,is_primary,valid_from,valid_to,created_at
)
select id,entity_type,entity_id,anchor_id,role,is_primary,valid_from,valid_to,created_at
  from entity_location_spaces_migration;
update transit_patterns
   set route_anchor_id=(
     select saved.route_anchor_id
       from transit_pattern_anchor_spaces_migration saved
      where saved.id=transit_patterns.id
   )
 where id in (select id from transit_pattern_anchor_spaces_migration);

drop table transit_pattern_anchor_spaces_migration;
drop table entity_location_spaces_migration;

drop table indoor_spaces;

pragma foreign_keys = on;

-- Public navigation links consume GCJ-02 coordinates directly. Enforce the
-- complete navigation anchor contract at the canonical storage boundary.
create trigger require_navigation_anchor_contract_insert
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

create trigger require_navigation_anchor_contract_update
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

-- The binding role is part of the spatial assertion and must agree with the
-- referenced anchor, otherwise release filtering can observe two meanings.
create trigger require_entity_location_role_match_insert
before insert on entity_locations
BEGIN
  select raise(abort,'entity location role must match anchor role')
    WHERE not exists (
    select 1 from location_anchors anchor
     where anchor.id=new.anchor_id and anchor.role=new.role
  );
END;

create trigger require_entity_location_role_match_update
before update of anchor_id,role on entity_locations
BEGIN
  select raise(abort,'entity location role must match anchor role')
    WHERE not exists (
    select 1 from location_anchors anchor
     where anchor.id=new.anchor_id and anchor.role=new.role
  );
END;

create trigger protect_anchor_role_binding_update
before update of role on location_anchors
when new.role<>old.role and exists (
  select 1 from entity_locations binding
   where binding.anchor_id=old.id and binding.role<>new.role
)
BEGIN
  select raise(abort,'anchor role must match every entity location binding');
END;

create unique index idx_entity_locations_one_active_footprint
  on entity_locations(entity_type,entity_id,role)
  where valid_to is null and role='footprint';

create unique index idx_entity_locations_one_active_navigation_target
  on entity_locations(entity_type,entity_id,role)
  where valid_to is null and role='navigation_target';

drop index idx_entity_locations_one_primary;
create unique index idx_entity_locations_one_primary
  on entity_locations(entity_type,entity_id)
  where is_primary=1 and valid_to is null;

create trigger require_footprint_binding_owner_insert
before insert on entity_locations
when new.role='footprint'
BEGIN
  select raise(abort,'footprint binding must belong to its anchor building')
    WHERE new.entity_type<>'place' or not exists (
    select 1 from location_anchors anchor
     where anchor.id=new.anchor_id and anchor.building_place_id=new.entity_id
  );
END;

create trigger require_footprint_binding_owner_update
before update of entity_type,entity_id,anchor_id,role on entity_locations
when new.role='footprint'
BEGIN
  select raise(abort,'footprint binding must belong to its anchor building')
    WHERE new.entity_type<>'place' or not exists (
    select 1 from location_anchors anchor
     where anchor.id=new.anchor_id and anchor.building_place_id=new.entity_id
  );
END;

create trigger require_unique_active_feature_footprint_insert
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

create trigger require_unique_active_feature_footprint_update
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

create trigger require_footprint_anchor_contract_insert
before insert on location_anchors
when new.role='footprint'
BEGIN
  select raise(abort,'footprint anchor must reference a canonical campus building feature')
    WHERE new.campus_id is null
    or new.building_place_id is null
    or new.floor_id is not null
    or new.indoor_space_id is not null
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

create trigger require_footprint_anchor_contract_update
before update of role,campus_id,building_place_id,floor_id,indoor_space_id,geometry_type,
                 geometry_json,crs,map_version_id,map_feature_id on location_anchors
when new.role='footprint'
BEGIN
  select raise(abort,'footprint anchor must reference a canonical campus building feature')
    WHERE new.campus_id is null
    or new.building_place_id is null
    or new.floor_id is not null
    or new.indoor_space_id is not null
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

create trigger protect_footprint_anchor_owner_update
before update of role,building_place_id on location_anchors
when new.role='footprint' and exists (
  select 1 from entity_locations binding
   where binding.anchor_id=old.id
     and (binding.entity_type<>'place' or binding.entity_id<>new.building_place_id)
)
BEGIN
  select raise(abort,'footprint anchor must preserve its binding owner');
END;

create trigger protect_footprint_feature_contract_update
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

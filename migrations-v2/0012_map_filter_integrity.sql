pragma foreign_keys = on;

-- Every live place resolves through its kind to one active map-filter chip.
create trigger require_place_active_map_filter_insert
before insert on places
when new.lifecycle_status <> 'retired'
begin
  select case when not exists (
    select 1
      from map_filter_members m
      join map_filter_categories c on c.id=m.category_id and c.active=1
     where m.place_kind_id=new.kind_id
  ) then raise(abort,'place kind must belong to an active map filter') end;
end;

create trigger require_place_active_map_filter_update
before update of kind_id,lifecycle_status on places
when new.lifecycle_status <> 'retired'
begin
  select case when not exists (
    select 1
      from map_filter_members m
      join map_filter_categories c on c.id=m.category_id and c.active=1
     where m.place_kind_id=new.kind_id
  ) then raise(abort,'place kind must belong to an active map filter') end;
end;

-- A live facility additionally requires an enabled type.
create trigger require_facility_active_map_filter_insert
before insert on facility_instances
when new.lifecycle_status <> 'retired'
begin
  select case when not exists (
    select 1
      from facility_types t
      join map_filter_members m on m.facility_type_id=t.id
      join map_filter_categories c on c.id=m.category_id and c.active=1
     where t.id=new.facility_type_id and t.status='active'
  ) then raise(abort,'facility type must be enabled and belong to an active map filter') end;
end;

create trigger require_facility_active_map_filter_update
before update of facility_type_id,lifecycle_status on facility_instances
when new.lifecycle_status <> 'retired'
begin
  select case when not exists (
    select 1
      from facility_types t
      join map_filter_members m on m.facility_type_id=t.id
      join map_filter_categories c on c.id=m.category_id and c.active=1
     where t.id=new.facility_type_id and t.status='active'
  ) then raise(abort,'facility type must be enabled and belong to an active map filter') end;
end;

-- Merchant outlets share one explicit member in the same taxonomy.
create trigger require_merchant_active_map_filter_insert
before insert on merchant_outlets
when new.lifecycle_status <> 'retired'
begin
  select case when not exists (
    select 1
      from map_filter_members m
      join map_filter_categories c on c.id=m.category_id and c.active=1
     where m.includes_merchants=1
  ) then raise(abort,'merchants must belong to an active map filter') end;
end;

create trigger require_merchant_active_map_filter_update
before update of lifecycle_status on merchant_outlets
when new.lifecycle_status <> 'retired'
begin
  select case when not exists (
    select 1
      from map_filter_members m
      join map_filter_categories c on c.id=m.category_id and c.active=1
     where m.includes_merchants=1
  ) then raise(abort,'merchants must belong to an active map filter') end;
end;

-- New and re-enabled facility types must already be attached to an active chip.
-- The API creates a disabled row, creates its member, then enables the row in one batch.
create trigger require_facility_type_active_map_filter_insert
before insert on facility_types
when new.status='active'
begin
  select case when not exists (
    select 1
      from map_filter_members m
      join map_filter_categories c on c.id=m.category_id and c.active=1
     where m.facility_type_id=new.id
  ) then raise(abort,'active facility type must belong to an active map filter') end;
end;

create trigger require_facility_type_active_map_filter_update
before update of status on facility_types
when new.status='active' and old.status<>'active'
begin
  select case when not exists (
    select 1
      from map_filter_members m
      join map_filter_categories c on c.id=m.category_id and c.active=1
     where m.facility_type_id=new.id
  ) then raise(abort,'active facility type must belong to an active map filter') end;
end;

-- A chip carrying live objects or an enabled facility type cannot be hidden.
create trigger protect_used_map_filter_deactivation
before update of active on map_filter_categories
when old.active=1 and new.active=0
begin
  select case when exists (
    select 1
      from map_filter_members m
      join places p on p.kind_id=m.place_kind_id and p.lifecycle_status<>'retired'
     where m.category_id=old.id
    union all
    select 1
      from map_filter_members m
      join facility_types t on t.id=m.facility_type_id
      left join facility_instances f on f.facility_type_id=t.id and f.lifecycle_status<>'retired'
     where m.category_id=old.id and (t.status='active' or f.id is not null)
    union all
    select 1
      from map_filter_members m
      join merchant_outlets o on o.lifecycle_status<>'retired'
     where m.category_id=old.id and m.includes_merchants=1
  ) then raise(abort,'map filter with live members cannot be deactivated') end;
end;

-- Moving a live target into an inactive chip would break the same invariant.
create trigger protect_used_map_filter_member_move
before update of category_id on map_filter_members
when new.category_id<>old.category_id
begin
  select case when not exists (
    select 1 from map_filter_categories c where c.id=new.category_id and c.active=1
  ) and (
    exists(select 1 from places p where p.kind_id=old.place_kind_id and p.lifecycle_status<>'retired')
    or exists(
      select 1 from facility_types t
      left join facility_instances f on f.facility_type_id=t.id and f.lifecycle_status<>'retired'
      where t.id=old.facility_type_id and (t.status='active' or f.id is not null)
    )
    or (old.includes_merchants=1 and exists(select 1 from merchant_outlets o where o.lifecycle_status<>'retired'))
  ) then raise(abort,'live map filter member cannot move to an inactive map filter') end;
end;

create trigger protect_used_map_filter_member_delete
before delete on map_filter_members
begin
  select case when
    exists(select 1 from places p where p.kind_id=old.place_kind_id and p.lifecycle_status<>'retired')
    or exists(
      select 1 from facility_types t
      left join facility_instances f on f.facility_type_id=t.id and f.lifecycle_status<>'retired'
      where t.id=old.facility_type_id and (t.status='active' or f.id is not null)
    )
    or (old.includes_merchants=1 and exists(select 1 from merchant_outlets o where o.lifecycle_status<>'retired'))
  then raise(abort,'live map filter member cannot be deleted') end;
end;

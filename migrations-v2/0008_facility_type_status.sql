pragma foreign_keys = on;

-- 0001 created facility_types as a pure reference table with no lifecycle column,
-- so there was no way to retire a tag. facility_instances.facility_type_id is
-- `on delete restrict`, which means a type that is already referenced can never be
-- deleted physically -- "remove the canteen tag" has to mean "stop offering it for
-- new data" while existing instances keep rendering.
--
-- status='disabled' expresses exactly that: the type disappears from the pickers
-- (admin facility form, volunteer collection form, public facility-type endpoint)
-- but every existing facility_instance keeps its type and keeps being published.
-- Physical DELETE stays available only while the type has zero instances.
alter table facility_types add column status text not null default 'active'
  check (status in ('active', 'disabled'));

-- The pickers read "active types" on nearly every relevant request, and the
-- detail view counts instances per type.
create index idx_facility_types_status on facility_types(status, category, name);
create index idx_facility_instances_type on facility_instances(facility_type_id);

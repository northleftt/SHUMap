pragma foreign_keys = on;

-- Field collection is an authenticated, deliberately narrow capability. A
-- volunteer can use the collection application without admin-console access.
update roles
   set permissions_json='["collect:data"]'
 where id='volunteer';

-- Ownership follows the account so a volunteer can continue a draft on a
-- second device. device_id remains as collection provenance.
alter table collection_tasks add column assignee_user_id text references users(id) on delete restrict;
create index idx_collection_tasks_assignee on collection_tasks(assignee_user_id, updated_at desc);

-- Structural edits travel with the editorial revision. Applying an approved
-- revision updates entity structure, aliases, and locations atomically.
alter table place_revisions add column structure_json text not null default '{}'
  check (json_valid(structure_json));
alter table facility_revisions add column structure_json text not null default '{}'
  check (json_valid(structure_json));
alter table merchant_revisions add column structure_json text not null default '{}'
  check (json_valid(structure_json));

-- New entities begin as non-public skeletons. Their first approved revision
-- activates them atomically.
alter table places add column approval_pending integer not null default 0 check (approval_pending in (0,1));
alter table facility_instances add column approval_pending integer not null default 0 check (approval_pending in (0,1));
alter table merchant_outlets add column approval_pending integer not null default 0 check (approval_pending in (0,1));

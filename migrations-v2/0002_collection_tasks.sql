pragma foreign_keys = on;

create table collection_tasks (
  building_place_id text primary key references places(id) on delete cascade,
  device_id text not null,
  assignee_name text not null,
  status text not null check (status in ('collecting','submitted','accepted','needs_recollection')),
  payload_json text not null default '{}' check (json_valid(payload_json)),
  lock_expires_at text,
  submission_id text references content_submissions(id) on delete set null,
  created_at text not null,
  updated_at text not null,
  submitted_at text,
  reviewed_at text
);

create index idx_collection_tasks_status on collection_tasks(status, updated_at desc);
create index idx_collection_tasks_device on collection_tasks(device_id, updated_at desc);

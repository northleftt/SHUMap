pragma foreign_keys = on;

create table public_rate_limits (
  key text primary key,
  request_count integer not null,
  window_started_at text not null,
  updated_at text not null
);

create index idx_public_rate_limits_updated on public_rate_limits(updated_at);

create table analytics_events (
  id text primary key,
  event_type text not null check (event_type in ('map_view','poi_view')),
  campus text,
  place_id text,
  place_name text,
  metadata_json text not null default '{}' check (json_valid(metadata_json)),
  created_at text not null
);

create index idx_analytics_events_created on analytics_events(created_at desc);
create index idx_analytics_events_type on analytics_events(event_type, created_at desc);

create trigger prevent_duplicate_submission_reviews
before insert on submission_reviews
when exists (select 1 from submission_reviews where submission_id=new.submission_id)
begin
  select raise(abort, 'submission already reviewed');
end;

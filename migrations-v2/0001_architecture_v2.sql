-- SHUMap Architecture v2
-- This schema is intentionally self-contained. It targets a fresh D1 database.
pragma foreign_keys = on;

-- Identity, access and audit -------------------------------------------------
create table roles (
  id text primary key,
  name text not null unique,
  permissions_json text not null check (json_valid(permissions_json)),
  created_at text not null
);

create table users (
  id text primary key,
  email text not null unique collate nocase,
  display_name text not null,
  password_hash text not null,
  status text not null default 'active' check (status in ('active','disabled')),
  token_version integer not null default 1,
  created_at text not null,
  updated_at text not null
);

create table user_roles (
  user_id text not null references users(id) on delete cascade,
  role_id text not null references roles(id) on delete restrict,
  primary key (user_id, role_id)
);

create table sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at text not null,
  last_seen_at text not null,
  revoked_at text,
  created_at text not null
);
create index idx_sessions_user on sessions(user_id, expires_at);

create table audit_events (
  id text primary key,
  actor_user_id text references users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  request_id text,
  reason text,
  before_json text check (before_json is null or json_valid(before_json)),
  after_json text check (after_json is null or json_valid(after_json)),
  created_at text not null
);
create index idx_audit_entity on audit_events(entity_type, entity_id, created_at desc);
create index idx_audit_actor on audit_events(actor_user_id, created_at desc);

-- Provenance and media ------------------------------------------------------
create table organizations (
  id text primary key,
  name text not null,
  kind text not null default 'department',
  contact_json text check (contact_json is null or json_valid(contact_json)),
  status text not null default 'active' check (status in ('active','retired')),
  created_at text not null,
  updated_at text not null
);

create table data_sources (
  id text primary key,
  source_type text not null check (source_type in ('official','survey','import','community','derived')),
  title text not null,
  organization_id text references organizations(id) on delete set null,
  url text,
  license text,
  obtained_at text,
  reliability text not null default 'unknown' check (reliability in ('authoritative','reviewed','unverified','unknown')),
  metadata_json text check (metadata_json is null or json_valid(metadata_json)),
  created_at text not null
);

create table media_assets (
  id text primary key,
  bucket_scope text not null check (bucket_scope in ('quarantine','private','public','release','backup')),
  object_key text not null unique,
  original_name text,
  content_type text not null,
  byte_size integer not null check (byte_size >= 0),
  sha256 text not null,
  status text not null check (status in ('quarantined','approved','rejected','published','deleted')),
  source_id text references data_sources(id) on delete set null,
  uploaded_by text references users(id) on delete set null,
  created_at text not null,
  approved_at text
);
create index idx_media_status on media_assets(status, created_at);

-- Campus, place and indoor space -------------------------------------------
create table campuses (
  id text primary key,
  code text not null unique,
  name text not null,
  timezone text not null default 'Asia/Shanghai',
  status text not null default 'active' check (status in ('active','retired')),
  created_at text not null,
  updated_at text not null
);

create table place_kinds (
  id text primary key,
  name text not null,
  sort_order integer not null default 100,
  is_searchable integer not null default 1 check (is_searchable in (0,1))
);

create table places (
  id text primary key,
  kind_id text not null references place_kinds(id) on delete restrict,
  campus_id text references campuses(id) on delete restrict,
  parent_place_id text references places(id) on delete restrict,
  stable_code text,
  lifecycle_status text not null default 'active' check (lifecycle_status in ('planned','active','temporarily_closed','retired')),
  current_revision_id text,
  created_at text not null,
  updated_at text not null,
  retired_at text,
  unique(campus_id, stable_code)
);
create index idx_places_campus_kind on places(campus_id, kind_id, lifecycle_status);
create index idx_places_parent on places(parent_place_id);

create table place_revisions (
  id text primary key,
  place_id text not null references places(id) on delete cascade,
  revision_no integer not null check (revision_no > 0),
  editorial_status text not null check (editorial_status in ('draft','in_review','approved','rejected','superseded')),
  display_name text not null,
  summary text,
  description text,
  content_json text not null default '{}' check (json_valid(content_json)),
  source_id text references data_sources(id) on delete set null,
  based_on_revision_id text references place_revisions(id) on delete set null,
  content_hash text not null,
  created_by text references users(id) on delete set null,
  created_at text not null,
  submitted_at text,
  reviewed_by text references users(id) on delete set null,
  reviewed_at text,
  review_note text,
  unique(place_id, revision_no)
);
create index idx_place_revisions_state on place_revisions(editorial_status, created_at);

create table place_names (
  id text primary key,
  place_id text not null references places(id) on delete cascade,
  language text not null default 'zh-CN',
  name text not null,
  normalized_name text not null,
  name_type text not null check (name_type in ('primary','alias','former','short','english')),
  is_searchable integer not null default 1 check (is_searchable in (0,1)),
  unique(place_id, language, name, name_type)
);
create index idx_place_names_normalized on place_names(normalized_name);

create table buildings (
  place_id text primary key references places(id) on delete cascade,
  building_code text,
  managing_organization_id text references organizations(id) on delete set null,
  public_access_level text not null default 'unknown' check (public_access_level in ('public','restricted','private','unknown'))
);

create table floors (
  id text primary key,
  building_place_id text not null references buildings(place_id) on delete cascade,
  level_code text not null,
  level_order real not null,
  display_name text not null,
  is_public integer not null default 1 check (is_public in (0,1)),
  lifecycle_status text not null default 'active' check (lifecycle_status in ('active','closed','retired')),
  created_at text not null,
  updated_at text not null,
  unique(building_place_id, level_code)
);
create index idx_floors_building_order on floors(building_place_id, level_order);

create table indoor_spaces (
  id text primary key,
  floor_id text not null references floors(id) on delete cascade,
  parent_space_id text references indoor_spaces(id) on delete restrict,
  space_type text not null check (space_type in ('room','zone','corridor','entrance','stair','elevator','service_area','other')),
  stable_code text,
  display_name text not null,
  lifecycle_status text not null default 'active' check (lifecycle_status in ('active','closed','retired')),
  created_at text not null,
  updated_at text not null,
  unique(floor_id, stable_code)
);
create index idx_spaces_floor on indoor_spaces(floor_id, space_type);

-- Versioned map assets and spatial assertions -------------------------------
create table map_assets (
  id text primary key,
  asset_type text not null check (asset_type in ('campus_svg','floor_svg','floor_image','geojson','source_cad','source_bim','source_pdf')),
  media_asset_id text not null references media_assets(id) on delete restrict,
  checksum text not null,
  metadata_json text not null default '{}' check (json_valid(metadata_json)),
  created_at text not null
);

create table map_versions (
  id text primary key,
  campus_id text references campuses(id) on delete restrict,
  floor_id text references floors(id) on delete restrict,
  map_asset_id text not null references map_assets(id) on delete restrict,
  parent_version_id text references map_versions(id) on delete set null,
  version_label text not null,
  coordinate_space_type text not null check (coordinate_space_type in ('svg_viewbox','normalized_image','local_metric','geographic')),
  coordinate_space_json text not null check (json_valid(coordinate_space_json)),
  parser_version text,
  lifecycle_status text not null check (lifecycle_status in ('draft','ready','published','archived','rejected')),
  created_by text references users(id) on delete set null,
  created_at text not null,
  check ((campus_id is not null and floor_id is null) or (campus_id is null and floor_id is not null))
);
create index idx_map_versions_campus on map_versions(campus_id, lifecycle_status, created_at desc);
create index idx_map_versions_floor on map_versions(floor_id, lifecycle_status, created_at desc);

create table map_features (
  id text primary key,
  map_version_id text not null references map_versions(id) on delete cascade,
  stable_feature_key text,
  source_element_id text,
  feature_kind text not null check (feature_kind in ('building_footprint','road','path','entrance','room','label','water','green','area','other')),
  geometry_json text check (geometry_json is null or json_valid(geometry_json)),
  bbox_json text check (bbox_json is null or json_valid(bbox_json)),
  shape_hash text,
  label text,
  metadata_json text not null default '{}' check (json_valid(metadata_json)),
  unique(map_version_id, source_element_id)
);
create index idx_map_features_key on map_features(stable_feature_key);

create table map_feature_mappings (
  from_feature_id text not null references map_features(id) on delete cascade,
  to_feature_id text not null references map_features(id) on delete cascade,
  mapping_status text not null check (mapping_status in ('automatic','confirmed','rejected')),
  confidence real,
  confirmed_by text references users(id) on delete set null,
  confirmed_at text,
  primary key(from_feature_id, to_feature_id)
);

create table location_anchors (
  id text primary key,
  campus_id text references campuses(id) on delete restrict,
  building_place_id text references buildings(place_id) on delete restrict,
  floor_id text references floors(id) on delete restrict,
  indoor_space_id text references indoor_spaces(id) on delete restrict,
  role text not null check (role in ('primary_display','footprint','centroid','main_entrance','accessible_entrance','navigation_target','service_position','boarding_point','alighting_point','event_location','impact_area','route_shape','other')),
  geometry_type text not null check (geometry_type in ('Point','LineString','Polygon')),
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
  check (geometry_json is not null or map_feature_id is not null or building_place_id is not null or floor_id is not null or indoor_space_id is not null),
  check (map_feature_id is null or map_version_id is not null)
);
create index idx_anchor_building_floor on location_anchors(building_place_id, floor_id, role);
create index idx_anchor_map on location_anchors(map_version_id, role);

create table entity_locations (
  id text primary key,
  entity_type text not null check (entity_type in ('place','facility','merchant_outlet','operational_event','campaign','transit_stop')),
  entity_id text not null,
  anchor_id text not null references location_anchors(id) on delete cascade,
  role text not null,
  is_primary integer not null default 0 check (is_primary in (0,1)),
  valid_from text,
  valid_to text,
  created_at text not null,
  unique(entity_type, entity_id, anchor_id, role)
);
create index idx_entity_locations_entity on entity_locations(entity_type, entity_id, role);
create unique index idx_entity_locations_one_primary on entity_locations(entity_type, entity_id) where is_primary = 1;

-- Facilities and merchants --------------------------------------------------
create table facility_types (
  id text primary key,
  code text not null unique,
  name text not null,
  category text not null,
  icon_key text,
  visibility_policy_json text not null check (json_valid(visibility_policy_json)),
  verification_interval_days integer,
  created_at text not null,
  updated_at text not null
);

create table facility_instances (
  id text primary key,
  facility_type_id text not null references facility_types(id) on delete restrict,
  host_place_id text references places(id) on delete restrict,
  floor_id text references floors(id) on delete restrict,
  indoor_space_id text references indoor_spaces(id) on delete restrict,
  lifecycle_status text not null default 'active' check (lifecycle_status in ('planned','active','retired')),
  operational_status text not null default 'unknown' check (operational_status in ('available','partially_available','unavailable','unknown')),
  quantity integer check (quantity is null or quantity > 0),
  current_revision_id text,
  last_verified_at text,
  next_verification_due_at text,
  created_at text not null,
  updated_at text not null
);
create index idx_facilities_host on facility_instances(host_place_id, facility_type_id, lifecycle_status);
create index idx_facilities_due on facility_instances(next_verification_due_at);

create table facility_revisions (
  id text primary key,
  facility_id text not null references facility_instances(id) on delete cascade,
  revision_no integer not null check (revision_no > 0),
  editorial_status text not null check (editorial_status in ('draft','in_review','approved','rejected','superseded')),
  display_name text not null,
  service_hours_json text check (service_hours_json is null or json_valid(service_hours_json)),
  content_json text not null default '{}' check (json_valid(content_json)),
  source_id text references data_sources(id) on delete set null,
  based_on_revision_id text references facility_revisions(id) on delete set null,
  content_hash text not null,
  created_by text references users(id) on delete set null,
  created_at text not null,
  submitted_at text,
  reviewed_by text references users(id) on delete set null,
  reviewed_at text,
  review_note text,
  unique(facility_id, revision_no)
);

create table merchant_outlets (
  id text primary key,
  organization_id text references organizations(id) on delete set null,
  host_place_id text references places(id) on delete restrict,
  floor_id text references floors(id) on delete restrict,
  indoor_space_id text references indoor_spaces(id) on delete restrict,
  lifecycle_status text not null default 'active' check (lifecycle_status in ('planned','active','temporarily_closed','retired')),
  current_revision_id text,
  created_at text not null,
  updated_at text not null
);

create table merchant_revisions (
  id text primary key,
  outlet_id text not null references merchant_outlets(id) on delete cascade,
  revision_no integer not null check (revision_no > 0),
  editorial_status text not null check (editorial_status in ('draft','in_review','approved','rejected','superseded')),
  display_name text not null,
  business_type text,
  opening_hours_json text check (opening_hours_json is null or json_valid(opening_hours_json)),
  contact_json text check (contact_json is null or json_valid(contact_json)),
  content_json text not null default '{}' check (json_valid(content_json)),
  source_id text references data_sources(id) on delete set null,
  content_hash text not null,
  created_by text references users(id) on delete set null,
  created_at text not null,
  submitted_at text,
  reviewed_by text references users(id) on delete set null,
  reviewed_at text,
  review_note text,
  unique(outlet_id, revision_no)
);

-- Operational events and campaigns ----------------------------------------
create table operational_events (
  id text primary key,
  event_type text not null,
  severity text not null check (severity in ('info','warning','critical')),
  editorial_status text not null check (editorial_status in ('draft','in_review','approved','rejected')),
  operational_status text not null check (operational_status in ('scheduled','active','resolved','cancelled','expired')),
  title text not null,
  description text,
  starts_at text not null,
  expected_ends_at text,
  resolved_at text,
  auto_expire_at text,
  source_id text references data_sources(id) on delete set null,
  responsible_organization_id text references organizations(id) on delete set null,
  last_verified_at text,
  created_by text references users(id) on delete set null,
  reviewed_by text references users(id) on delete set null,
  created_at text not null,
  updated_at text not null
);
create index idx_events_active on operational_events(operational_status, starts_at, auto_expire_at);

create table operational_event_targets (
  event_id text not null references operational_events(id) on delete cascade,
  target_type text not null check (target_type in ('place','floor','space','facility','merchant_outlet','transit_stop','transit_route','transit_trip','map_feature')),
  target_id text not null,
  impact_type text not null default 'affected',
  primary key(event_id, target_type, target_id)
);

create table operational_event_updates (
  id text primary key,
  event_id text not null references operational_events(id) on delete cascade,
  status text not null,
  message text not null,
  created_by text references users(id) on delete set null,
  created_at text not null
);

create table campaigns (
  id text primary key,
  title text not null,
  summary text,
  editorial_status text not null check (editorial_status in ('draft','in_review','approved','rejected')),
  lifecycle_status text not null check (lifecycle_status in ('scheduled','active','ended','cancelled')),
  starts_at text not null,
  ends_at text not null,
  audience_json text not null default '{}' check (json_valid(audience_json)),
  placements_json text not null default '[]' check (json_valid(placements_json)),
  created_by text references users(id) on delete set null,
  reviewed_by text references users(id) on delete set null,
  created_at text not null,
  updated_at text not null
);

create table campaign_items (
  id text primary key,
  campaign_id text not null references campaigns(id) on delete cascade,
  item_type text not null check (item_type in ('rich_text','place','facility','transit_route','route','external_link','action')),
  target_id text,
  content_json text not null default '{}' check (json_valid(content_json)),
  sort_order integer not null default 100
);

-- Transit -------------------------------------------------------------------
create table transit_stops (
  id text primary key,
  place_id text references places(id) on delete restrict,
  campus_id text references campuses(id) on delete restrict,
  code text unique,
  name text not null,
  status text not null default 'active' check (status in ('active','temporarily_closed','retired')),
  created_at text not null,
  updated_at text not null
);

create table transit_routes (
  id text primary key,
  code text unique,
  name text not null,
  operator_id text references organizations(id) on delete set null,
  status text not null default 'active' check (status in ('active','suspended','retired')),
  created_at text not null,
  updated_at text not null
);

create table transit_patterns (
  id text primary key,
  route_id text not null references transit_routes(id) on delete cascade,
  direction_id integer not null check (direction_id in (0,1)),
  name text not null,
  route_anchor_id text references location_anchors(id) on delete set null,
  unique(route_id, direction_id, name)
);

create table transit_pattern_stops (
  pattern_id text not null references transit_patterns(id) on delete cascade,
  stop_id text not null references transit_stops(id) on delete restrict,
  stop_sequence integer not null check (stop_sequence >= 0),
  pickup_type text not null default 'regular' check (pickup_type in ('regular','reservation_only','none')),
  dropoff_type text not null default 'regular' check (dropoff_type in ('regular','none')),
  primary key(pattern_id, stop_sequence),
  unique(pattern_id, stop_id, stop_sequence)
);

create table service_calendars (
  id text primary key,
  name text not null,
  timezone text not null default 'Asia/Shanghai',
  valid_from text not null,
  valid_to text not null,
  monday integer not null check (monday in (0,1)),
  tuesday integer not null check (tuesday in (0,1)),
  wednesday integer not null check (wednesday in (0,1)),
  thursday integer not null check (thursday in (0,1)),
  friday integer not null check (friday in (0,1)),
  saturday integer not null check (saturday in (0,1)),
  sunday integer not null check (sunday in (0,1)),
  source_id text references data_sources(id) on delete set null
);

create table service_calendar_exceptions (
  calendar_id text not null references service_calendars(id) on delete cascade,
  service_date text not null,
  exception_type text not null check (exception_type in ('added','removed')),
  label text,
  primary key(calendar_id, service_date)
);

create table transit_trips (
  id text primary key,
  pattern_id text not null references transit_patterns(id) on delete cascade,
  service_calendar_id text not null references service_calendars(id) on delete restrict,
  public_label text,
  booking_policy text not null default 'not_required' check (booking_policy in ('required','optional','not_required')),
  booking_url text,
  status text not null default 'active' check (status in ('active','cancelled','retired')),
  source_id text references data_sources(id) on delete set null
);

create table transit_stop_times (
  trip_id text not null references transit_trips(id) on delete cascade,
  stop_id text not null references transit_stops(id) on delete restrict,
  stop_sequence integer not null check (stop_sequence >= 0),
  arrival_time text,
  departure_time text,
  primary key(trip_id, stop_sequence)
);
create index idx_stop_times_stop on transit_stop_times(stop_id, departure_time);

create table transit_alerts (
  id text primary key,
  target_type text not null check (target_type in ('route','pattern','stop','trip')),
  target_id text not null,
  title text not null,
  description text,
  severity text not null check (severity in ('info','warning','critical')),
  starts_at text not null,
  ends_at text,
  status text not null check (status in ('scheduled','active','resolved','cancelled')),
  source_id text references data_sources(id) on delete set null,
  created_at text not null
);

-- Review, contribution and verification -----------------------------------
create table content_submissions (
  id text primary key,
  target_type text not null check (target_type in ('place','facility','merchant_outlet','transit_stop','new_place')),
  target_id text,
  base_revision_id text,
  payload_json text not null check (json_valid(payload_json)),
  submitter_name text,
  submitter_contact text,
  status text not null default 'pending' check (status in ('pending','in_review','accepted','partially_accepted','rejected','withdrawn')),
  created_at text not null,
  reviewed_at text
);

create table submission_media (
  submission_id text not null references content_submissions(id) on delete cascade,
  media_asset_id text not null references media_assets(id) on delete restrict,
  primary key(submission_id, media_asset_id)
);

create table submission_reviews (
  id text primary key,
  submission_id text not null references content_submissions(id) on delete cascade,
  reviewer_id text not null references users(id) on delete restrict,
  decision text not null check (decision in ('accept','partial','reject')),
  field_decisions_json text not null default '{}' check (json_valid(field_decisions_json)),
  note text,
  produced_revision_type text,
  produced_revision_id text,
  created_at text not null
);

create table verification_records (
  id text primary key,
  entity_type text not null,
  entity_id text not null,
  revision_id text,
  verification_type text not null,
  result text not null check (result in ('verified','needs_update','rejected','unreachable')),
  evidence_media_id text references media_assets(id) on delete set null,
  note text,
  verified_by text references users(id) on delete set null,
  verified_at text not null,
  next_due_at text
);
create index idx_verification_due on verification_records(next_due_at, entity_type);

-- Immutable releases and search read model ---------------------------------
create table releases (
  id text primary key,
  version text not null unique,
  schema_version integer not null,
  status text not null check (status in ('draft','validating','validation_failed','ready','publishing','active','superseded','failed')),
  summary text,
  artifact_key text,
  artifact_sha256 text,
  validation_report_json text check (validation_report_json is null or json_valid(validation_report_json)),
  created_by text references users(id) on delete set null,
  created_at text not null,
  validated_at text,
  activated_at text,
  supersedes_release_id text references releases(id) on delete set null
);
create unique index idx_one_active_release on releases(status) where status = 'active';

create table release_items (
  release_id text not null references releases(id) on delete cascade,
  entity_type text not null,
  entity_id text not null,
  revision_id text,
  item_hash text not null,
  primary key(release_id, entity_type, entity_id)
);
create index idx_release_items_entity on release_items(entity_type, entity_id);

create table release_map_versions (
  release_id text not null references releases(id) on delete cascade,
  map_version_id text not null references map_versions(id) on delete restrict,
  primary key(release_id, map_version_id)
);

create table release_activations (
  id text primary key,
  from_release_id text references releases(id) on delete set null,
  to_release_id text not null references releases(id) on delete restrict,
  action text not null check (action in ('publish','rollback')),
  actor_user_id text references users(id) on delete set null,
  reason text,
  created_at text not null
);

create table search_documents (
  release_id text not null references releases(id) on delete cascade,
  document_type text not null,
  entity_id text not null,
  title text not null,
  subtitle text,
  normalized_text text not null,
  pinyin text,
  campus_id text references campuses(id) on delete restrict,
  building_place_id text references buildings(place_id) on delete restrict,
  floor_id text references floors(id) on delete restrict,
  facets_json text not null default '[]' check (json_valid(facets_json)),
  map_target_json text check (map_target_json is null or json_valid(map_target_json)),
  ranking_weight real not null default 1,
  primary key(release_id, document_type, entity_id)
);
create index idx_search_release_campus on search_documents(release_id, campus_id, document_type);

-- Asynchronous jobs ---------------------------------------------------------
create table jobs (
  id text primary key,
  job_type text not null check (job_type in ('map_import','floor_import','media_process','search_build','release_build','garbage_collect')),
  idempotency_key text not null unique,
  status text not null check (status in ('queued','running','waiting_review','succeeded','failed','cancelled')),
  payload_json text not null check (json_valid(payload_json)),
  result_json text check (result_json is null or json_valid(result_json)),
  error_message text,
  attempt_count integer not null default 0,
  created_by text references users(id) on delete set null,
  created_at text not null,
  started_at text,
  finished_at text
);
create index idx_jobs_status on jobs(status, created_at);

-- Deferred circular references that SQLite cannot declare before tables exist.
create trigger validate_place_current_revision
before update of current_revision_id on places
when new.current_revision_id is not null
begin
  select case when not exists (
    select 1 from place_revisions r where r.id = new.current_revision_id and r.place_id = new.id and r.editorial_status = 'approved'
  ) then raise(abort, 'current place revision must be an approved revision of the same place') end;
end;

create trigger validate_facility_current_revision
before update of current_revision_id on facility_instances
when new.current_revision_id is not null
begin
  select case when not exists (
    select 1 from facility_revisions r where r.id = new.current_revision_id and r.facility_id = new.id and r.editorial_status = 'approved'
  ) then raise(abort, 'current facility revision must be an approved revision of the same facility') end;
end;

create trigger validate_merchant_current_revision
before update of current_revision_id on merchant_outlets
when new.current_revision_id is not null
begin
  select case when not exists (
    select 1 from merchant_revisions r where r.id = new.current_revision_id and r.outlet_id = new.id and r.editorial_status = 'approved'
  ) then raise(abort, 'current merchant revision must be an approved revision of the same outlet') end;
end;

-- Canonical roles and taxonomies -------------------------------------------
insert into roles(id, name, permissions_json, created_at) values
  ('viewer','Viewer','["read:admin"]',datetime('now')),
  ('content_editor','Content editor','["read:admin","write:content"]',datetime('now')),
  ('map_editor','Map editor','["read:admin","write:maps"]',datetime('now')),
  ('transit_editor','Transit editor','["read:admin","write:transit"]',datetime('now')),
  ('reviewer','Reviewer','["read:admin","review:content"]',datetime('now')),
  ('publisher','Publisher','["read:admin","publish:release","rollback:release"]',datetime('now')),
  ('owner','Owner','["*"]',datetime('now'));

insert into place_kinds(id, name, sort_order) values
  ('building','建筑',10),('outdoor_area','室外区域',20),('service_place','服务地点',30),
  ('transit_stop','交通站点',40),('sports_venue','运动场馆',50),('residence','宿舍',60),('other','其他',900);

insert into campuses(id, code, name, timezone, status, created_at, updated_at) values
  ('campus_baoshan','baoshan','宝山校区','Asia/Shanghai','active',datetime('now'),datetime('now')),
  ('campus_jiading','jiading','嘉定校区','Asia/Shanghai','active',datetime('now'),datetime('now')),
  ('campus_yanchang','yanchang','延长校区','Asia/Shanghai','active',datetime('now'),datetime('now'));

insert into facility_types(id, code, name, category, icon_key, visibility_policy_json, verification_interval_days, created_at, updated_at) values
  ('facility_type_printer','printer','打印服务','service','printer','{"searchable":true,"filterable":true,"campusDefault":false,"buildingSummary":true,"floorDefault":false,"showOnSearch":true,"showOnFilter":true,"showWhenUnavailable":true}',90,datetime('now'),datetime('now')),
  ('facility_type_study_area','study_area','自习区域','study','desk','{"searchable":true,"filterable":true,"campusDefault":false,"buildingSummary":true,"floorDefault":true,"showOnSearch":true,"showOnFilter":true,"showWhenUnavailable":true}',30,datetime('now'),datetime('now')),
  ('facility_type_restroom','restroom','卫生间','amenity','restroom','{"searchable":true,"filterable":true,"campusDefault":false,"buildingSummary":true,"floorDefault":true,"showOnSearch":true,"showOnFilter":true,"showWhenUnavailable":true}',90,datetime('now'),datetime('now')),
  ('facility_type_drinking_water','drinking_water','饮水点','amenity','water','{"searchable":true,"filterable":true,"campusDefault":false,"buildingSummary":true,"floorDefault":true,"showOnSearch":true,"showOnFilter":true,"showWhenUnavailable":true}',60,datetime('now'),datetime('now')),
  ('facility_type_elevator','elevator','电梯','navigation','elevator','{"searchable":true,"filterable":false,"campusDefault":false,"buildingSummary":true,"floorDefault":true,"showOnSearch":true,"showOnFilter":false,"showWhenUnavailable":true}',30,datetime('now'),datetime('now')),
  ('facility_type_vending','vending_machine','自动售货机','commercial','vending','{"searchable":true,"filterable":true,"campusDefault":false,"buildingSummary":true,"floorDefault":false,"showOnSearch":true,"showOnFilter":true,"showWhenUnavailable":true}',60,datetime('now'),datetime('now')),
  ('facility_type_power_bank','power_bank','充电宝','commercial','battery','{"searchable":true,"filterable":true,"campusDefault":false,"buildingSummary":true,"floorDefault":false,"showOnSearch":true,"showOnFilter":true,"showWhenUnavailable":true}',60,datetime('now'),datetime('now')),
  ('facility_type_charging','charging_station','充电桩','transport','charging','{"searchable":true,"filterable":true,"campusDefault":true,"buildingSummary":true,"floorDefault":false,"showOnSearch":true,"showOnFilter":true,"showWhenUnavailable":true}',30,datetime('now'),datetime('now')),
  ('facility_type_service_center','service_center','一站式服务中心','service','service','{"searchable":true,"filterable":true,"campusDefault":true,"buildingSummary":true,"floorDefault":true,"showOnSearch":true,"showOnFilter":true,"showWhenUnavailable":true}',30,datetime('now'),datetime('now'));

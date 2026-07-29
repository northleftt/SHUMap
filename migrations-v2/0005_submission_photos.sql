pragma foreign_keys = on;

-- User photo chain: submission_media already exists (0001) but was never used.
-- Ordering + provenance columns are needed so review surfaces can render the
-- pictures in the order the contributor picked them, and so a later cleanup job
-- can find quarantined uploads by age.
alter table submission_media add column sort_order integer not null default 0;
alter table submission_media add column role text not null default 'evidence';
alter table submission_media add column created_at text not null default '1970-01-01T00:00:00.000Z';

create index idx_submission_media_submission on submission_media(submission_id, sort_order);
create index idx_submission_media_asset on submission_media(media_asset_id);

-- Anonymous quarantine uploads are looked up by scope+status when reviewing and
-- when a cleanup task eventually sweeps unreferenced objects.
create index idx_media_assets_scope on media_assets(bucket_scope, status, created_at);

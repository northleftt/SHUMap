-- Explicit, renewable read leases for assets referenced by previously published releases.
-- A lease never overrides media approval/revocation or release publication status.
create table release_asset_leases (
  release_id text primary key references releases(id) on delete cascade,
  expires_at text not null,
  reason text not null,
  updated_at text not null
);
insert into release_asset_leases(release_id, expires_at, reason, updated_at)
select id, strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days'),
  'client-contract rollout baseline', strftime('%Y-%m-%dT%H:%M:%fZ','now')
from releases where status='active';

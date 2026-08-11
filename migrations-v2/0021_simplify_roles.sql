pragma foreign_keys = on;

-- Role set is slimmed to three tiers: volunteer (write-only collection),
-- admin (every back-office capability except account management), and owner
-- (full wildcard, the only holder of manage:users). Permission strings and
-- every endpoint gate stay untouched — only the role rows change, so the
-- admin console's role dropdown (driven by this table) collapses to the
-- three surviving options on its own.
insert into roles(id, name, permissions_json, created_at) values
  ('admin','Admin','["read:admin","write:content","write:maps","write:transit","review:content","publish:release","rollback:release"]',datetime('now'))
on conflict(id) do update set
  name=excluded.name,
  permissions_json=excluded.permissions_json;

-- Fold members of the retired fine-grained roles into admin. INSERT OR
-- IGNORE keeps the (user_id, role_id) primary key intact when an account
-- held several of the old roles at once.
insert or ignore into user_roles(user_id, role_id)
  select user_id, 'admin' from user_roles
 where role_id in ('viewer','content_editor','map_editor','transit_editor','reviewer','publisher');

delete from user_roles
 where role_id in ('viewer','content_editor','map_editor','transit_editor','reviewer','publisher');

delete from roles
 where id in ('viewer','content_editor','map_editor','transit_editor','reviewer','publisher');

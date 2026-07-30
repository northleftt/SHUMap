pragma foreign_keys = on;

-- 0001 seeded viewer/content_editor/map_editor/transit_editor/reviewer/publisher/owner
-- but no role for the field volunteers who fill in collection tasks. The collection
-- task endpoints (/api/public/collection-tasks/*) are device-scoped and need no
-- session at all, and `PERMISSIONS` in worker/domain/types.ts has no collect/submit
-- entry, so the honest minimum that still lets a volunteer sign in to the console
-- and read the surfaces they contribute to is read:admin. Deliberately no
-- write:content / review:content: volunteer work lands as a submission that an
-- editor reviews.
insert or ignore into roles(id, name, permissions_json, created_at)
values ('volunteer', 'Volunteer', '["read:admin"]', datetime('now'));

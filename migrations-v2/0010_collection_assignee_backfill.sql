pragma foreign_keys = on;

-- 0009 added collection_tasks.assignee_user_id and ownership checks moved from
-- device_id to assignee_user_id.  Rows created before 0009 have a NULL owner, so
-- `assignee_user_id = :userId` never matches and the original volunteer cannot
-- resume the draft: the building stays locked until lock_expires_at passes (24h).
--
-- Backfilling the real owner is not possible, and matching on assignee_name would
-- be wrong rather than merely imprecise:
--   * Before 0009 the collection endpoints were unauthenticated (/api/public/...)
--     and assignee_name was free text taken straight from the request body, so it
--     is not an account identifier at all and need not correspond to any user.
--   * users.display_name carries no unique constraint, so even an exact hit can
--     match several accounts.
--   * A wrong hit is worse than no hit: it would hand an unrelated account write
--     access to a stranger's draft and to the submission created from it.
-- device_id is the only genuine ownership signal from that era and there is no
-- device -> user mapping to join through.
--
-- So: do not invent an owner.  Release the stale lock instead, which turns a
-- 24h wait into an immediate re-claim.  The next claim (authenticated) writes a
-- real assignee_user_id and the row rejoins the 0009 ownership model.  Collected
-- payload_json is left untouched — re-claiming resumes the existing draft rather
-- than starting over, because the claim upsert only rewrites ownership columns.
--
-- lock_expires_at is set to a past instant, not NULL: the claim upsert re-takes a
-- foreign row via `lock_expires_at <= excluded.updated_at`, and NULL would make
-- that comparison NULL (never true), leaving the row permanently unclaimable.
-- Timestamps are compared as ISO-8601 strings, so a 1970 literal sorts before any
-- real value.
update collection_tasks
   set lock_expires_at='1970-01-01T00:00:00.000Z',
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 where assignee_user_id is null
   and status='collecting';

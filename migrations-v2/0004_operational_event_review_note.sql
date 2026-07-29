-- Operational event review decisions need to keep the reviewer's note, the same way
-- place / facility / merchant revisions do (review_note on *_revisions).
alter table operational_events add column reviewed_at text;
alter table operational_events add column review_note text;

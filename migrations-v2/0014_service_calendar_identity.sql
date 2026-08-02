pragma foreign_keys = on;

create table service_calendar_identity_migration (
  old_id text primary key,
  new_id text not null unique,
  canonical_name text not null
);

insert into service_calendar_identity_migration(old_id,new_id,canonical_name) values
  ('calendar_legacy_weekday','calendar_2025-2026_weekday','2025-2026 工作日'),
  ('calendar_legacy_weekend','calendar_2025-2026_weekend','2025-2026 周末'),
  ('calendar_legacy_holiday','calendar_2025-2026_holiday','2025-2026 节假日'),
  ('calendar_legacy_winterBreak','calendar_2025-2026_winterBreak','2025-2026 寒假'),
  ('calendar_legacy_summerBreak','calendar_2025-2026_summerBreak','2025-2026 暑假');

-- If both identities exist, they must already describe the same calendar. This
-- makes the merge deterministic and prevents a pre-existing canonical row from
-- silently replacing different schedule semantics.
create table service_calendar_identity_guard (
  valid integer not null check (valid=1)
);

insert into service_calendar_identity_guard(valid)
select CASE when count(*)=0 then 1 else 0 END
  from service_calendar_identity_migration m
  join service_calendars old_calendar on old_calendar.id=m.old_id
  join service_calendars canonical on canonical.id=m.new_id
 where old_calendar.timezone<>canonical.timezone
    or old_calendar.valid_from<>canonical.valid_from
    or old_calendar.valid_to<>canonical.valid_to
    or old_calendar.monday<>canonical.monday
    or old_calendar.tuesday<>canonical.tuesday
    or old_calendar.wednesday<>canonical.wednesday
    or old_calendar.thursday<>canonical.thursday
    or old_calendar.friday<>canonical.friday
    or old_calendar.saturday<>canonical.saturday
    or old_calendar.sunday<>canonical.sunday
    or old_calendar.source_id is not canonical.source_id;

-- A pre-governance smoke record used a stable id with a retired marker only in
-- its display name. Its exact dates and seven-day schedule identify the row
-- without deriving calendar semantics from mutable text.
insert into service_calendar_identity_guard(valid)
select CASE when count(*)=0 then 1 else 0 END
  from service_calendars calendar
 where calendar.id='cal_weekday'
   and instr(lower(calendar.name),'legacy')>0
   and not (
     calendar.name='legacy weekday'
     and calendar.timezone='Asia/Shanghai'
     and calendar.valid_from='2026-01-01'
     and calendar.valid_to='2026-12-31'
     and calendar.monday=1
     and calendar.tuesday=1
     and calendar.wednesday=1
     and calendar.thursday=1
     and calendar.friday=1
     and calendar.saturday=1
     and calendar.sunday=1
     and calendar.source_id is null
   );

update service_calendars
   set name='2026 每日'
 where id='cal_weekday'
   and name='legacy weekday';

-- The guard above proved that any already-present canonical row is identical to
-- the row it supersedes, so skipping it here loses nothing. Stated as an
-- explicit not-exists rather than "or ignore" so a genuinely unexpected
-- conflict still fails loudly.
insert into service_calendars(
  id,name,timezone,valid_from,valid_to,monday,tuesday,wednesday,thursday,friday,saturday,sunday,source_id
)
select m.new_id,m.canonical_name,c.timezone,c.valid_from,c.valid_to,c.monday,c.tuesday,c.wednesday,
       c.thursday,c.friday,c.saturday,c.sunday,c.source_id
  from service_calendars c join service_calendar_identity_migration m on m.old_id=c.id
 where not exists (select 1 from service_calendars canonical where canonical.id=m.new_id);

insert into service_calendar_exceptions(calendar_id,service_date,exception_type,label)
select m.new_id,e.service_date,e.exception_type,e.label
  from service_calendar_exceptions e join service_calendar_identity_migration m on m.old_id=e.calendar_id
 where not exists (
   select 1 from service_calendar_exceptions canonical
    where canonical.calendar_id=m.new_id and canonical.service_date=e.service_date
 );

insert into service_calendar_identity_guard(valid)
select CASE when count(*)=0 then 1 else 0 END
  from service_calendar_exceptions e
  join service_calendar_identity_migration m on m.old_id=e.calendar_id
  join service_calendar_exceptions canonical
    on canonical.calendar_id=m.new_id and canonical.service_date=e.service_date
 where e.exception_type<>canonical.exception_type
    or e.label is not canonical.label;

update transit_trips
   set service_calendar_id=(
     select m.new_id from service_calendar_identity_migration m where m.old_id=transit_trips.service_calendar_id
   )
 where service_calendar_id in (select old_id from service_calendar_identity_migration);

delete from service_calendar_exceptions
 where calendar_id in (select old_id from service_calendar_identity_migration);

delete from service_calendars
 where id in (select old_id from service_calendar_identity_migration);

insert into service_calendar_identity_guard(valid)
select CASE when count(*)=0 then 1 else 0 END
  from service_calendars
 where instr(lower(id),'legacy')>0
    or instr(lower(name),'legacy')>0;

drop table service_calendar_identity_guard;
drop table service_calendar_identity_migration;

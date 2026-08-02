pragma foreign_keys = on;

create table submission_contract_guard (
  valid integer not null check (valid=1)
);

-- The public feedback form used this exact two-field payload before the
-- discriminant was introduced. Any other shape is left untouched and rejected
-- below so the migration never discards unknown content.
update content_submissions
   set payload_json=json_object(
     'submissionKind','feedback',
     'feedbackType',json_extract(payload_json,'$.feedbackType'),
     'description',trim(json_extract(payload_json,'$.description'))
   )
 where json_type(payload_json)='object'
   and json_type(payload_json,'$.submissionKind') is null
   and json_type(payload_json,'$.feedbackType')='text'
   and json_type(payload_json,'$.description')='text'
   and (select count(*) from json_each(payload_json))=2
   and not exists (
     select 1 from json_each(payload_json)
      where key not in ('feedbackType','description')
   );

update content_submissions
   set payload_json=json_set(
     payload_json,
     '$.description',trim(json_extract(payload_json,'$.description'))
   )
 where json_extract(payload_json,'$.submissionKind')='feedback'
   and json_type(payload_json,'$.description')='text';

-- A collection document has the same five keys whether it is still an editable
-- task or an submitted payload, so both sides get the same normalization. A key
-- that was never written has one lossless reading: nothing was provided at that
-- scope. Anything else present under these keys is left alone and rejected by
-- the contract guards below.
update content_submissions
   set payload_json=json_set(payload_json,'$.collection.openHours','')
 where json_extract(payload_json,'$.submissionKind')='collection'
   and json_type(payload_json,'$.collection.openHours') is null;
update content_submissions
   set payload_json=json_set(payload_json,'$.collection.phone','')
 where json_extract(payload_json,'$.submissionKind')='collection'
   and json_type(payload_json,'$.collection.phone') is null;
update content_submissions
   set payload_json=json_set(payload_json,'$.collection.organization','')
 where json_extract(payload_json,'$.submissionKind')='collection'
   and json_type(payload_json,'$.collection.organization') is null;
update content_submissions
   set payload_json=json_set(payload_json,'$.collection.floors',json('[]'))
 where json_extract(payload_json,'$.submissionKind')='collection'
   and json_type(payload_json,'$.collection.floors') is null;
update content_submissions
   set payload_json=json_set(payload_json,'$.collection.photoMediaIds',json('[]'))
 where json_extract(payload_json,'$.submissionKind')='collection'
   and json_type(payload_json,'$.collection.photoMediaIds') is null;

update collection_tasks set payload_json=json_set(payload_json,'$.openHours','')
 where json_type(payload_json,'$.openHours') is null;
update collection_tasks set payload_json=json_set(payload_json,'$.phone','')
 where json_type(payload_json,'$.phone') is null;
update collection_tasks set payload_json=json_set(payload_json,'$.organization','')
 where json_type(payload_json,'$.organization') is null;
update collection_tasks set payload_json=json_set(payload_json,'$.floors',json('[]'))
 where json_type(payload_json,'$.floors') is null;
update collection_tasks set payload_json=json_set(payload_json,'$.photoMediaIds',json('[]'))
 where json_type(payload_json,'$.photoMediaIds') is null;

-- New writes store trimmed text. Trimming historical free-text fields preserves
-- their content while making stored and request-time normalization identical.
update content_submissions
   set payload_json=json_set(
     payload_json,
     '$.collection.openHours',trim(json_extract(payload_json,'$.collection.openHours')),
     '$.collection.phone',trim(json_extract(payload_json,'$.collection.phone')),
     '$.collection.organization',trim(json_extract(payload_json,'$.collection.organization'))
   )
 where json_extract(payload_json,'$.submissionKind')='collection'
   and json_type(payload_json,'$.collection.openHours')='text'
   and json_type(payload_json,'$.collection.phone')='text'
   and json_type(payload_json,'$.collection.organization')='text';

update collection_tasks
   set payload_json=json_set(
     payload_json,
     '$.openHours',trim(json_extract(payload_json,'$.openHours')),
     '$.phone',trim(json_extract(payload_json,'$.phone')),
     '$.organization',trim(json_extract(payload_json,'$.organization'))
   )
 where json_type(payload_json,'$.openHours')='text'
   and json_type(payload_json,'$.phone')='text'
   and json_type(payload_json,'$.organization')='text';

-- Today's writers (worker/lib/submission-contracts.ts levelCode and
-- CollectionFormPage normalizeLevelCode) accept only /^F?(\d{1,3})$/ and
-- /^B(\d{1,2})$/, but stored data predates them: the suffix form "1F" is
-- present in collection_tasks today. Prefix, bare-number, and suffix forms all
-- converge on F<n>/B<n>. Anything outside those five shapes is left unchanged
-- so the guard below rejects it rather than guessing at its meaning.
update content_submissions
   set payload_json=json_set(
     payload_json,
     '$.collection.floors',
     (
       select json_group_array(json(
         json_set(
           json_set(
             f.value,
             '$.photoMediaIds',
             case
               when json_type(f.value,'$.photoMediaIds') is null then json('[]')
               else json_extract(f.value,'$.photoMediaIds')
             end
           ),
           '$.id',
           case
             when json_type(f.value,'$.id')='text' then trim(json_extract(f.value,'$.id'))
             else json_extract(f.value,'$.id')
           end,
           '$.levelCode',
           case
             when upper(trim(json_extract(f.value,'$.levelCode'))) glob 'B[0-9]*'
              and substr(upper(trim(json_extract(f.value,'$.levelCode'))),2) not glob '*[^0-9]*'
              and length(substr(upper(trim(json_extract(f.value,'$.levelCode'))),2)) between 1 and 2
             then 'B'||cast(substr(upper(trim(json_extract(f.value,'$.levelCode'))),2) as integer)
             when upper(trim(json_extract(f.value,'$.levelCode'))) glob 'F[0-9]*'
              and substr(upper(trim(json_extract(f.value,'$.levelCode'))),2) not glob '*[^0-9]*'
              and length(substr(upper(trim(json_extract(f.value,'$.levelCode'))),2)) between 1 and 3
             then 'F'||cast(substr(upper(trim(json_extract(f.value,'$.levelCode'))),2) as integer)
             when upper(trim(json_extract(f.value,'$.levelCode'))) glob '[0-9]*'
              and upper(trim(json_extract(f.value,'$.levelCode'))) not glob '*[^0-9]*'
              and length(upper(trim(json_extract(f.value,'$.levelCode')))) between 1 and 3
             then 'F'||cast(upper(trim(json_extract(f.value,'$.levelCode'))) as integer)
             when upper(trim(json_extract(f.value,'$.levelCode'))) glob '[0-9]*F'
              and substr(upper(trim(json_extract(f.value,'$.levelCode'))),1,
                         length(upper(trim(json_extract(f.value,'$.levelCode'))))-1) not glob '*[^0-9]*'
              and length(upper(trim(json_extract(f.value,'$.levelCode')))) between 2 and 4
             then 'F'||cast(substr(upper(trim(json_extract(f.value,'$.levelCode'))),1,
                                  length(upper(trim(json_extract(f.value,'$.levelCode'))))-1) as integer)
             when upper(trim(json_extract(f.value,'$.levelCode'))) glob '[0-9]*B'
              and substr(upper(trim(json_extract(f.value,'$.levelCode'))),1,
                         length(upper(trim(json_extract(f.value,'$.levelCode'))))-1) not glob '*[^0-9]*'
              and length(upper(trim(json_extract(f.value,'$.levelCode')))) between 2 and 3
             then 'B'||cast(substr(upper(trim(json_extract(f.value,'$.levelCode'))),1,
                                  length(upper(trim(json_extract(f.value,'$.levelCode'))))-1) as integer)
             when trim(json_extract(f.value,'$.levelCode'))='一层' then 'F1'
             else json_extract(f.value,'$.levelCode')
           end,
           '$.note',
           case
             when json_type(f.value,'$.note')='text' then trim(json_extract(f.value,'$.note'))
             else json_extract(f.value,'$.note')
           end,
           '$.facilities',
           case
             when json_type(f.value,'$.facilities')='array' then (
               select json_group_array(json(
                 json_set(
                   facility.value,
                   '$.id',case
                     when json_type(facility.value,'$.id')='text'
                     then trim(json_extract(facility.value,'$.id'))
                     else json_extract(facility.value,'$.id')
                   end,
                   '$.typeCode',case
                     when json_type(facility.value,'$.typeCode')='text'
                     then trim(json_extract(facility.value,'$.typeCode'))
                     else json_extract(facility.value,'$.typeCode')
                   end,
                   '$.name',case
                     when json_type(facility.value,'$.name')='text'
                     then trim(json_extract(facility.value,'$.name'))
                     else json_extract(facility.value,'$.name')
                   end,
                   '$.locationText',case
                     when json_type(facility.value,'$.locationText')='text'
                     then trim(json_extract(facility.value,'$.locationText'))
                     else json_extract(facility.value,'$.locationText')
                   end
                 )
               ))
               from json_each(f.value,'$.facilities') facility
             )
             else json_extract(f.value,'$.facilities')
           end
         )
       ))
       from json_each(payload_json,'$.collection.floors') f
     )
   )
 where json_extract(payload_json,'$.submissionKind')='collection'
   and json_type(payload_json,'$.collection.floors')='array'
   and not exists (
     select 1 from json_each(payload_json,'$.collection.floors') where type<>'object'
   );

update collection_tasks
   set payload_json=json_set(
     payload_json,
     '$.floors',
     (
       select json_group_array(json(
         json_set(
           json_set(
             f.value,
             '$.photoMediaIds',
             case
               when json_type(f.value,'$.photoMediaIds') is null then json('[]')
               else json_extract(f.value,'$.photoMediaIds')
             end
           ),
           '$.id',
           case
             when json_type(f.value,'$.id')='text' then trim(json_extract(f.value,'$.id'))
             else json_extract(f.value,'$.id')
           end,
           '$.levelCode',
           case
             when upper(trim(json_extract(f.value,'$.levelCode'))) glob 'B[0-9]*'
              and substr(upper(trim(json_extract(f.value,'$.levelCode'))),2) not glob '*[^0-9]*'
              and length(substr(upper(trim(json_extract(f.value,'$.levelCode'))),2)) between 1 and 2
             then 'B'||cast(substr(upper(trim(json_extract(f.value,'$.levelCode'))),2) as integer)
             when upper(trim(json_extract(f.value,'$.levelCode'))) glob 'F[0-9]*'
              and substr(upper(trim(json_extract(f.value,'$.levelCode'))),2) not glob '*[^0-9]*'
              and length(substr(upper(trim(json_extract(f.value,'$.levelCode'))),2)) between 1 and 3
             then 'F'||cast(substr(upper(trim(json_extract(f.value,'$.levelCode'))),2) as integer)
             when upper(trim(json_extract(f.value,'$.levelCode'))) glob '[0-9]*'
              and upper(trim(json_extract(f.value,'$.levelCode'))) not glob '*[^0-9]*'
              and length(upper(trim(json_extract(f.value,'$.levelCode')))) between 1 and 3
             then 'F'||cast(upper(trim(json_extract(f.value,'$.levelCode'))) as integer)
             when upper(trim(json_extract(f.value,'$.levelCode'))) glob '[0-9]*F'
              and substr(upper(trim(json_extract(f.value,'$.levelCode'))),1,
                         length(upper(trim(json_extract(f.value,'$.levelCode'))))-1) not glob '*[^0-9]*'
              and length(upper(trim(json_extract(f.value,'$.levelCode')))) between 2 and 4
             then 'F'||cast(substr(upper(trim(json_extract(f.value,'$.levelCode'))),1,
                                  length(upper(trim(json_extract(f.value,'$.levelCode'))))-1) as integer)
             when upper(trim(json_extract(f.value,'$.levelCode'))) glob '[0-9]*B'
              and substr(upper(trim(json_extract(f.value,'$.levelCode'))),1,
                         length(upper(trim(json_extract(f.value,'$.levelCode'))))-1) not glob '*[^0-9]*'
              and length(upper(trim(json_extract(f.value,'$.levelCode')))) between 2 and 3
             then 'B'||cast(substr(upper(trim(json_extract(f.value,'$.levelCode'))),1,
                                  length(upper(trim(json_extract(f.value,'$.levelCode'))))-1) as integer)
             when trim(json_extract(f.value,'$.levelCode'))='一层' then 'F1'
             else json_extract(f.value,'$.levelCode')
           end,
           '$.note',
           case
             when json_type(f.value,'$.note')='text' then trim(json_extract(f.value,'$.note'))
             else json_extract(f.value,'$.note')
           end,
           '$.facilities',
           case
             when json_type(f.value,'$.facilities')='array' then (
               select json_group_array(json(
                 json_set(
                   facility.value,
                   '$.id',case
                     when json_type(facility.value,'$.id')='text'
                     then trim(json_extract(facility.value,'$.id'))
                     else json_extract(facility.value,'$.id')
                   end,
                   '$.typeCode',case
                     when json_type(facility.value,'$.typeCode')='text'
                     then trim(json_extract(facility.value,'$.typeCode'))
                     else json_extract(facility.value,'$.typeCode')
                   end,
                   '$.name',case
                     when json_type(facility.value,'$.name')='text'
                     then trim(json_extract(facility.value,'$.name'))
                     else json_extract(facility.value,'$.name')
                   end,
                   '$.locationText',case
                     when json_type(facility.value,'$.locationText')='text'
                     then trim(json_extract(facility.value,'$.locationText'))
                     else json_extract(facility.value,'$.locationText')
                   end
                 )
               ))
               from json_each(f.value,'$.facilities') facility
             )
             else json_extract(f.value,'$.facilities')
           end
         )
       ))
       from json_each(payload_json,'$.floors') f
     )
   )
 where json_type(payload_json,'$.floors')='array'
   and not exists (
     select 1 from json_each(payload_json,'$.floors') where type<>'object'
   );

-- Both branches recover the revision the contributor actually saw. A reviewed
-- submission records it authoritatively on the revision its review produced.
-- Otherwise it is the revision that was published on the target at the moment
-- the submission was created — not whichever revision happens to be current
-- when this migration runs, which would be a different fact. A submission whose
-- predecessor cannot be recovered either way stays null and fails the guard
-- below rather than being given a plausible substitute.
update content_submissions
   set base_revision_id=coalesce(
     (
       select produced.based_on_revision_id
         from submission_reviews sr
         join place_revisions produced
           on sr.produced_revision_type='place' and produced.id=sr.produced_revision_id
        where sr.submission_id=content_submissions.id
     ),
     (
       select r.id
         from place_revisions r
        where r.place_id=content_submissions.target_id
          and r.editorial_status in ('approved','superseded')
          and r.created_at<=content_submissions.created_at
        order by r.created_at desc,r.id desc limit 1
     )
   )
 where target_type='place'
   and base_revision_id is null;

-- Facility codes are stable identities in collection documents. Older admin
-- code allowed a type to be deleted while a draft still referenced its code.
-- Creation audits contain the exact identity and display metadata written by
-- that API, so a referenced-but-deleted type can be restored from its own
-- audit trail rather than reinvented.
--
-- Chip membership is the one thing the audit trail cannot supply: audits
-- written before the unified taxonomy carry no mapFilterCategoryId, so there
-- is no recorded chip to restore. The guard below therefore admits only types
-- whose recorded category is 'other', which is the one category that maps
-- unambiguously onto the 'other' chip. Anything else aborts the migration and
-- has to be reattached deliberately instead of guessed here.
create table collection_referenced_facility_codes (
  code text primary key
);

insert or ignore into collection_referenced_facility_codes(code)
select trim(json_extract(facility.value,'$.typeCode'))
  from collection_tasks ct
  join json_each(ct.payload_json,'$.floors') floor
  join json_each(floor.value,'$.facilities') facility
 where json_type(facility.value,'$.typeCode')='text';

insert or ignore into collection_referenced_facility_codes(code)
select trim(json_extract(facility.value,'$.typeCode'))
  from content_submissions cs
  join json_each(cs.payload_json,'$.collection.floors') floor
  join json_each(floor.value,'$.facilities') facility
 where json_extract(cs.payload_json,'$.submissionKind')='collection'
   and json_type(facility.value,'$.typeCode')='text';

create table deleted_collection_facility_types (
  id text primary key,
  code text not null unique,
  name text not null,
  category text not null,
  icon_key text,
  verification_interval_days integer,
  status text not null,
  created_at text not null,
  deleted_at text not null
);

insert into deleted_collection_facility_types(
  id,code,name,category,icon_key,verification_interval_days,status,created_at,deleted_at
)
select created.entity_id,
       json_extract(created.after_json,'$.code'),
       json_extract(deleted_audit.before_json,'$.name'),
       json_extract(created.after_json,'$.category'),
       json_extract(created.after_json,'$.iconKey'),
       json_extract(created.after_json,'$.verificationIntervalDays'),
       json_extract(deleted_audit.before_json,'$.status'),
       created.created_at,
       deleted_audit.created_at
  from audit_events created
  join collection_referenced_facility_codes referenced
    on referenced.code=json_extract(created.after_json,'$.code')
  join audit_events deleted_audit
    on deleted_audit.id=(
      select deleted.id
        from audit_events deleted
       where deleted.action='facility_type.delete'
         and deleted.entity_type='facility_type'
         and deleted.entity_id=created.entity_id
         and deleted.created_at>=created.created_at
       order by deleted.created_at desc,deleted.id desc limit 1
    )
 where created.action='facility_type.create'
   and created.entity_type='facility_type'
   and not exists(select 1 from facility_types ft where ft.code=referenced.code)
   and created.id=(
     select candidate.id
       from audit_events candidate
      where candidate.action='facility_type.create'
        and candidate.entity_type='facility_type'
        and json_extract(candidate.after_json,'$.code')=referenced.code
      order by candidate.created_at desc,candidate.id desc limit 1
   );

insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from collection_referenced_facility_codes referenced
 where not exists(select 1 from facility_types ft where ft.code=referenced.code)
   and not exists(
     select 1 from deleted_collection_facility_types deleted
      where deleted.code=referenced.code
        and length(trim(deleted.id))>0
        and length(trim(deleted.name)) between 1 and 50
        and deleted.category='other'
        and (deleted.icon_key is null or length(trim(deleted.icon_key)) between 1 and 50)
        and (
          deleted.verification_interval_days is null
          or deleted.verification_interval_days between 1 and 3650
        )
        and deleted.status in ('active','disabled')
        and deleted.deleted_at is not null
   );

insert into facility_types(
  id,code,name,category,icon_key,visibility_policy_json,
  verification_interval_days,status,created_at,updated_at
)
select deleted.id,deleted.code,trim(deleted.name),deleted.category,deleted.icon_key,
       '{"searchable":true,"filterable":true,"campusDefault":false,"buildingSummary":true,"floorDefault":false,"showOnSearch":true,"showOnFilter":true,"showWhenUnavailable":true}',
       deleted.verification_interval_days,'disabled',deleted.created_at,deleted.deleted_at
  from deleted_collection_facility_types deleted
 where not exists(select 1 from facility_types ft where ft.code=deleted.code);

insert into map_filter_members(
  id,category_id,place_kind_id,facility_type_id,includes_merchants,sort_order,created_at
)
select 'map_filter_member_'||deleted.id,'map_filter_other',null,deleted.id,0,1000,deleted.created_at
  from deleted_collection_facility_types deleted
 where exists(select 1 from facility_types ft where ft.id=deleted.id and ft.code=deleted.code)
   and not exists(select 1 from map_filter_members member where member.facility_type_id=deleted.id);

update facility_types
   set status='active'
 where id in (
   select deleted.id from deleted_collection_facility_types deleted where deleted.status='active'
 );

-- Validate the two top-level contracts before expanding nested rows.
insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from content_submissions cs
 where json_type(cs.payload_json) is not 'object'
    or cs.target_type='place' and (
      cs.target_id is null
      or cs.base_revision_id is null
      or not exists (
        select 1 from place_revisions r
         where r.id=cs.base_revision_id
           and r.place_id=cs.target_id
           and r.editorial_status in ('approved','superseded')
      )
    )
    or cs.target_type<>'place' and cs.base_revision_id is not null
    or json_type(cs.payload_json,'$.submissionKind') is not 'text'
    or json_extract(cs.payload_json,'$.submissionKind') not in ('feedback','collection')
    or json_extract(cs.payload_json,'$.submissionKind')='feedback' and (
      (select count(*) from json_each(cs.payload_json))<>3
      or exists (
        select 1 from json_each(cs.payload_json)
         where key not in ('submissionKind','feedbackType','description')
      )
      or json_type(cs.payload_json,'$.feedbackType') is not 'text'
      or json_extract(cs.payload_json,'$.feedbackType') not in ('correction','new_place','shuttle','other')
      or json_type(cs.payload_json,'$.description') is not 'text'
      or json_extract(cs.payload_json,'$.description')<>trim(json_extract(cs.payload_json,'$.description'))
      or length(json_extract(cs.payload_json,'$.description')) not between 1 and 2000
      or json_extract(cs.payload_json,'$.feedbackType')='new_place'
         and (cs.target_type<>'new_place' or cs.target_id is not null)
      or json_extract(cs.payload_json,'$.feedbackType')='shuttle'
         and (
           cs.target_type<>'transit_stop'
           or cs.target_id is null
           or not exists(select 1 from transit_stops s where s.id=cs.target_id)
         )
      or json_extract(cs.payload_json,'$.feedbackType') in ('correction','other')
         and (cs.target_type<>'place' or cs.target_id is null)
    )
    or json_extract(cs.payload_json,'$.submissionKind')='collection' and (
      cs.target_type<>'place'
      or (select count(*) from json_each(cs.payload_json))<>2
      or exists (
        select 1 from json_each(cs.payload_json)
         where key not in ('submissionKind','collection')
      )
      or json_type(cs.payload_json,'$.collection') is not 'object'
      or (select count(*) from json_each(cs.payload_json,'$.collection'))<>5
      or exists (
        select 1 from json_each(cs.payload_json,'$.collection')
         where key not in ('openHours','phone','organization','floors','photoMediaIds')
      )
      or json_type(cs.payload_json,'$.collection.openHours') is not 'text'
      or json_extract(cs.payload_json,'$.collection.openHours')<>trim(json_extract(cs.payload_json,'$.collection.openHours'))
      or length(json_extract(cs.payload_json,'$.collection.openHours'))>200
      or json_type(cs.payload_json,'$.collection.phone') is not 'text'
      or json_extract(cs.payload_json,'$.collection.phone')<>trim(json_extract(cs.payload_json,'$.collection.phone'))
      or length(json_extract(cs.payload_json,'$.collection.phone'))>100
      or json_type(cs.payload_json,'$.collection.organization') is not 'text'
      or json_extract(cs.payload_json,'$.collection.organization')<>trim(json_extract(cs.payload_json,'$.collection.organization'))
      or length(json_extract(cs.payload_json,'$.collection.organization'))>200
      or json_type(cs.payload_json,'$.collection.floors') is not 'array'
      or json_array_length(cs.payload_json,'$.collection.floors')>40
      or json_type(cs.payload_json,'$.collection.photoMediaIds') is not 'array'
      or json_array_length(cs.payload_json,'$.collection.photoMediaIds')>3
      or (
        length(json_extract(cs.payload_json,'$.collection.openHours'))=0
        and length(json_extract(cs.payload_json,'$.collection.phone'))=0
        and length(json_extract(cs.payload_json,'$.collection.organization'))=0
        and json_array_length(cs.payload_json,'$.collection.floors')=0
        and json_array_length(cs.payload_json,'$.collection.photoMediaIds')=0
      )
    );

insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from collection_tasks ct
 where json_type(ct.payload_json) is not 'object'
    or (select count(*) from json_each(ct.payload_json))<>5
    or exists (
      select 1 from json_each(ct.payload_json)
       where key not in ('openHours','phone','organization','floors','photoMediaIds')
    )
    or json_type(ct.payload_json,'$.openHours') is not 'text'
    or json_extract(ct.payload_json,'$.openHours')<>trim(json_extract(ct.payload_json,'$.openHours'))
    or length(json_extract(ct.payload_json,'$.openHours'))>200
    or json_type(ct.payload_json,'$.phone') is not 'text'
    or json_extract(ct.payload_json,'$.phone')<>trim(json_extract(ct.payload_json,'$.phone'))
    or length(json_extract(ct.payload_json,'$.phone'))>100
    or json_type(ct.payload_json,'$.organization') is not 'text'
    or json_extract(ct.payload_json,'$.organization')<>trim(json_extract(ct.payload_json,'$.organization'))
    or length(json_extract(ct.payload_json,'$.organization'))>200
    or json_type(ct.payload_json,'$.floors') is not 'array'
    or json_array_length(ct.payload_json,'$.floors')>40
    or json_type(ct.payload_json,'$.photoMediaIds') is not 'array'
    or json_array_length(ct.payload_json,'$.photoMediaIds')>3;

create table collection_contract_documents (
  document_key text primary key,
  submission_id text,
  collection_json text not null check (json_valid(collection_json))
);

insert into collection_contract_documents(document_key,submission_id,collection_json)
select 'submission:'||cs.id,cs.id,json_extract(cs.payload_json,'$.collection')
  from content_submissions cs
 where json_extract(cs.payload_json,'$.submissionKind')='collection';

insert into collection_contract_documents(document_key,submission_id,collection_json)
select 'task:'||ct.building_place_id,null,ct.payload_json from collection_tasks ct;

create table collection_contract_floors (
  document_key text not null,
  floor_index integer not null,
  value_type text not null,
  floor_json text,
  primary key(document_key,floor_index)
);

insert into collection_contract_floors(document_key,floor_index,value_type,floor_json)
select d.document_key,f.key,f.type,case when f.type='object' then f.value else null end
  from collection_contract_documents d,json_each(d.collection_json,'$.floors') f;

insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from collection_contract_floors f
 where f.value_type<>'object'
    or json_type(f.floor_json) is not 'object'
    or (select count(*) from json_each(f.floor_json))<>5
    or exists (
      select 1 from json_each(f.floor_json)
       where key not in ('id','levelCode','note','facilities','photoMediaIds')
    )
    or json_type(f.floor_json,'$.id') is not 'text'
    or json_extract(f.floor_json,'$.id')<>trim(json_extract(f.floor_json,'$.id'))
    or length(json_extract(f.floor_json,'$.id')) not between 1 and 100
    or json_type(f.floor_json,'$.levelCode') is not 'text'
    or (
      json_extract(f.floor_json,'$.levelCode') not glob 'F[0-9]*'
      and json_extract(f.floor_json,'$.levelCode') not glob 'B[0-9]*'
    )
    or substr(json_extract(f.floor_json,'$.levelCode'),2) glob '*[^0-9]*'
    or length(substr(json_extract(f.floor_json,'$.levelCode'),2)) not between 1 and
       case when json_extract(f.floor_json,'$.levelCode') like 'B%' then 2 else 3 end
    or json_extract(f.floor_json,'$.levelCode')<>
       substr(json_extract(f.floor_json,'$.levelCode'),1,1)||
       cast(substr(json_extract(f.floor_json,'$.levelCode'),2) as integer)
    or json_type(f.floor_json,'$.note') is not 'text'
    or json_extract(f.floor_json,'$.note')<>trim(json_extract(f.floor_json,'$.note'))
    or length(json_extract(f.floor_json,'$.note'))>500
    or json_type(f.floor_json,'$.facilities') is not 'array'
    or json_array_length(f.floor_json,'$.facilities')>80
    or json_type(f.floor_json,'$.photoMediaIds') is not 'array'
    or json_array_length(f.floor_json,'$.photoMediaIds')>2;

insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from (
    select document_key,json_extract(floor_json,'$.id') as identity
      from collection_contract_floors group by document_key,identity having count(*)>1
    union all
    select document_key,json_extract(floor_json,'$.levelCode')
      from collection_contract_floors group by document_key,json_extract(floor_json,'$.levelCode') having count(*)>1
  );

create table collection_contract_facilities (
  document_key text not null,
  floor_index integer not null,
  facility_index integer not null,
  value_type text not null,
  facility_json text,
  primary key(document_key,floor_index,facility_index)
);

insert into collection_contract_facilities(
  document_key,floor_index,facility_index,value_type,facility_json
)
select f.document_key,f.floor_index,facility.key,facility.type,
       case when facility.type='object' then facility.value else null end
  from collection_contract_floors f,json_each(f.floor_json,'$.facilities') facility;

insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from collection_contract_facilities f
 where f.value_type<>'object'
    or json_type(f.facility_json) is not 'object'
    or (select count(*) from json_each(f.facility_json))<>4
    or exists (
      select 1 from json_each(f.facility_json)
       where key not in ('id','typeCode','name','locationText')
    )
    or json_type(f.facility_json,'$.id') is not 'text'
    or json_extract(f.facility_json,'$.id')<>trim(json_extract(f.facility_json,'$.id'))
    or length(json_extract(f.facility_json,'$.id')) not between 1 and 100
    or json_type(f.facility_json,'$.typeCode') is not 'text'
    or json_extract(f.facility_json,'$.typeCode')<>trim(json_extract(f.facility_json,'$.typeCode'))
    or length(json_extract(f.facility_json,'$.typeCode')) not between 1 and 50
    or not exists (
      select 1 from facility_types ft where ft.code=json_extract(f.facility_json,'$.typeCode')
    )
    or json_type(f.facility_json,'$.name') is not 'text'
    or json_extract(f.facility_json,'$.name')<>trim(json_extract(f.facility_json,'$.name'))
    or length(json_extract(f.facility_json,'$.name'))>200
    or json_type(f.facility_json,'$.locationText') is not 'text'
    or json_extract(f.facility_json,'$.locationText')<>trim(json_extract(f.facility_json,'$.locationText'))
    or length(json_extract(f.facility_json,'$.locationText'))>500;

insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from (
    select document_key,json_extract(facility_json,'$.id') as identity
      from collection_contract_facilities group by document_key,identity having count(*)>1
    union all
    select document_key,json_array(
             json_extract(facility_json,'$.typeCode'),
             json_extract(facility_json,'$.name'),
             json_extract(facility_json,'$.locationText')
           )
      from collection_contract_facilities
     group by document_key,floor_index,
              json_extract(facility_json,'$.typeCode'),
              json_extract(facility_json,'$.name'),
              json_extract(facility_json,'$.locationText')
    having count(*)>1
  );

create table collection_contract_photos (
  document_key text not null,
  submission_id text,
  photo_scope text not null,
  floor_index integer,
  photo_index integer not null,
  value_type text not null,
  media_id,
  unique(document_key,photo_scope,floor_index,photo_index)
);

insert into collection_contract_photos(
  document_key,submission_id,photo_scope,floor_index,photo_index,value_type,media_id
)
select d.document_key,d.submission_id,'entrance',null,p.key,p.type,p.value
  from collection_contract_documents d,json_each(d.collection_json,'$.photoMediaIds') p;

insert into collection_contract_photos(
  document_key,submission_id,photo_scope,floor_index,photo_index,value_type,media_id
)
select f.document_key,d.submission_id,'floor',f.floor_index,p.key,p.type,p.value
  from collection_contract_floors f
  join collection_contract_documents d on d.document_key=f.document_key
  join json_each(f.floor_json,'$.photoMediaIds') p;

insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from collection_contract_photos p
 where p.value_type<>'text'
    or length(p.media_id)<>38
    or lower(p.media_id) not glob 'media_[0-9a-f]*'
    or substr(lower(p.media_id),7) glob '*[^0-9a-f]*';

insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from (
    select document_key,media_id
      from collection_contract_photos group by document_key,media_id having count(*)>1
    union all
    select document_key,''
      from collection_contract_photos group by document_key having count(*)>12
  );

-- Once submitted, JSON references and relational media links are the same set.
insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from content_submissions cs
 where json_extract(cs.payload_json,'$.submissionKind')='collection'
   and (
     exists (
       select 1 from collection_contract_photos p
        where p.submission_id=cs.id
          and not exists (
            select 1 from submission_media sm
             where sm.submission_id=cs.id and sm.media_asset_id=p.media_id
          )
     )
     or exists (
       select 1 from submission_media sm
        where sm.submission_id=cs.id
          and not exists (
            select 1 from collection_contract_photos p
             where p.submission_id=cs.id and p.media_id=sm.media_asset_id
          )
     )
   );

create table submission_expected_review_fields (
  submission_id text not null,
  field_key text not null,
  primary key(submission_id,field_key)
);

-- One insert per expected field. D1 caps a compound SELECT at five terms, so
-- these stay separate statements rather than one UNION ALL chain.
insert into submission_expected_review_fields(submission_id,field_key)
select cs.id,'description' from content_submissions cs
 where json_extract(cs.payload_json,'$.submissionKind')='feedback';

insert into submission_expected_review_fields(submission_id,field_key)
select cs.id,'collection.openHours' from content_submissions cs
 where json_extract(cs.payload_json,'$.submissionKind')='collection'
   and length(json_extract(cs.payload_json,'$.collection.openHours'))>0;

insert into submission_expected_review_fields(submission_id,field_key)
select cs.id,'collection.phone' from content_submissions cs
 where json_extract(cs.payload_json,'$.submissionKind')='collection'
   and length(json_extract(cs.payload_json,'$.collection.phone'))>0;

insert into submission_expected_review_fields(submission_id,field_key)
select cs.id,'collection.organization' from content_submissions cs
 where json_extract(cs.payload_json,'$.submissionKind')='collection'
   and length(json_extract(cs.payload_json,'$.collection.organization'))>0;

insert into submission_expected_review_fields(submission_id,field_key)
select cs.id,'collection.floors' from content_submissions cs
 where json_extract(cs.payload_json,'$.submissionKind')='collection'
   and json_array_length(cs.payload_json,'$.collection.floors')>0;

insert into submission_expected_review_fields(submission_id,field_key)
select cs.id,'photos' from content_submissions cs
 where cs.target_type='place'
   and (
     json_extract(cs.payload_json,'$.submissionKind')='feedback'
       and exists(select 1 from submission_media sm where sm.submission_id=cs.id)
     or json_extract(cs.payload_json,'$.submissionKind')='collection'
       and json_array_length(cs.payload_json,'$.collection.photoMediaIds')>0
   );

-- Accept and reject determine every field uniformly. An empty partial decision
-- cannot be reconstructed and is intentionally rejected by the final guard.
-- json_group_object returns '{}' over zero rows, so a submission with no
-- expected fields keeps its empty object without a fallback branch.
update submission_reviews
   set field_decisions_json=(
     select json_group_object(
       e.field_key,
       case when submission_reviews.decision='accept' then 'adopt' else 'skip' end
     )
       from submission_expected_review_fields e
      where e.submission_id=submission_reviews.submission_id
   )
 where field_decisions_json='{}'
   and decision in ('accept','reject');

-- An earlier review UI wrote the payload discriminant into the decision map
-- alongside the real field keys. 'submissionKind' names no reviewable field, so
-- its decision carries no information and removing it is lossless. Only that
-- one key is removable: any other unexpected key would be a decision about
-- something this migration cannot identify, so it aborts instead.
insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from submission_reviews sr
  join json_each(sr.field_decisions_json) d
 where d.key<>'submissionKind'
   and not exists (
     select 1 from submission_expected_review_fields e
      where e.submission_id=sr.submission_id and e.field_key=d.key
   );

update submission_reviews
   set field_decisions_json=json_remove(field_decisions_json,'$.submissionKind')
 where json_type(field_decisions_json,'$.submissionKind') is not null
   and not exists (
     select 1 from submission_expected_review_fields e
      where e.submission_id=submission_reviews.submission_id
        and e.field_key='submissionKind'
   );

insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from submission_reviews sr
  join content_submissions cs on cs.id=sr.submission_id
 where json_type(sr.field_decisions_json) is not 'object'
    or (select count(*) from json_each(sr.field_decisions_json))<>
       (select count(*) from submission_expected_review_fields e where e.submission_id=sr.submission_id)
    or (select count(*) from json_each(sr.field_decisions_json))<>
       (select count(distinct key) from json_each(sr.field_decisions_json))
    or exists (
      select 1 from json_each(sr.field_decisions_json) d
       where d.value not in ('adopt','skip')
          or not exists (
            select 1 from submission_expected_review_fields e
             where e.submission_id=sr.submission_id and e.field_key=d.key
          )
    )
    or exists (
      select 1 from submission_expected_review_fields e
       where e.submission_id=sr.submission_id
         and not exists (
           select 1 from json_each(sr.field_decisions_json) d where d.key=e.field_key
         )
    )
    or sr.decision='accept' and exists (
      select 1 from json_each(sr.field_decisions_json) where value<>'adopt'
    )
    or sr.decision='reject' and exists (
      select 1 from json_each(sr.field_decisions_json) where value<>'skip'
    )
    or sr.decision='partial' and (
      not exists(select 1 from json_each(sr.field_decisions_json) where value='adopt')
      or not exists(select 1 from json_each(sr.field_decisions_json) where value='skip')
    )
    or sr.decision='accept' and cs.status<>'accepted'
    or sr.decision='partial' and cs.status<>'partially_accepted'
    or sr.decision='reject' and cs.status<>'rejected'
    or cs.reviewed_at is null;

insert into submission_contract_guard(valid)
select case when count(*)=0 then 1 else 0 end
  from content_submissions cs
 where cs.status in ('accepted','partially_accepted','rejected')
   and not exists(select 1 from submission_reviews sr where sr.submission_id=cs.id);

drop table submission_expected_review_fields;
drop table collection_contract_photos;
drop table collection_contract_facilities;
drop table collection_contract_floors;
drop table collection_contract_documents;
drop table deleted_collection_facility_types;
drop table collection_referenced_facility_codes;
drop table submission_contract_guard;

-- Collection documents retain their facility identity for their full lifetime.
create trigger protect_collection_facility_type_delete
before delete on facility_types
begin
  select case when exists (
    select 1
      from collection_tasks ct
      join json_each(ct.payload_json,'$.floors') floor
      join json_each(floor.value,'$.facilities') facility
     where json_extract(facility.value,'$.typeCode')=old.code
    union all
    select 1
      from content_submissions cs
      join json_each(cs.payload_json,'$.collection.floors') floor
      join json_each(floor.value,'$.facilities') facility
     where json_extract(cs.payload_json,'$.submissionKind')='collection'
       and json_extract(facility.value,'$.typeCode')=old.code
  ) then raise(abort,'facility type is referenced by collection data') end;
end;

create trigger protect_facility_type_code_update
before update of code on facility_types
when new.code<>old.code
begin
  select raise(abort,'facility type code is immutable');
end;

-- Active collection workflows retain an enabled choice through review.
-- Completed reviews keep disabled types as immutable history.
create trigger protect_active_collection_facility_type_disable
before update of status on facility_types
when old.status='active' and new.status='disabled'
begin
  select case when exists (
    select 1
      from collection_tasks ct
      join json_each(ct.payload_json,'$.floors') floor
      join json_each(floor.value,'$.facilities') facility
     where ct.status in ('collecting','submitted','needs_recollection')
       and json_extract(facility.value,'$.typeCode')=old.code
    union all
    select 1
      from content_submissions cs
      join json_each(cs.payload_json,'$.collection.floors') floor
      join json_each(floor.value,'$.facilities') facility
     where cs.status in ('pending','in_review')
       and json_extract(cs.payload_json,'$.submissionKind')='collection'
       and json_extract(facility.value,'$.typeCode')=old.code
  ) then raise(abort,'active collection workflow requires an active facility type') end;
end;

create trigger require_collection_task_facility_types_insert
before insert on collection_tasks
when new.status in ('collecting','needs_recollection')
begin
  select case when exists (
    select 1
      from json_each(new.payload_json,'$.floors') floor
      join json_each(floor.value,'$.facilities') facility
     where not exists (
       select 1 from facility_types type
        where type.code=json_extract(facility.value,'$.typeCode') and type.status='active'
     )
  ) then raise(abort,'editable collection data requires active facility types') end;
end;

create trigger require_collection_task_facility_types_update
before update of payload_json,status on collection_tasks
when new.status in ('collecting','needs_recollection')
begin
  select case when exists (
    select 1
      from json_each(new.payload_json,'$.floors') floor
      join json_each(floor.value,'$.facilities') facility
     where not exists (
       select 1 from facility_types type
        where type.code=json_extract(facility.value,'$.typeCode') and type.status='active'
     )
  ) then raise(abort,'editable collection data requires active facility types') end;
end;

create trigger require_collection_submission_facility_types_insert
before insert on content_submissions
when json_extract(new.payload_json,'$.submissionKind')='collection'
begin
  select case when exists (
    select 1
     from json_each(new.payload_json,'$.collection.floors') floor
      join json_each(floor.value,'$.facilities') facility
     where not exists (
       select 1 from facility_types type
        where type.code=json_extract(facility.value,'$.typeCode') and type.status='active'
     )
  ) then raise(abort,'collection submission requires active facility types') end;
end;

create trigger require_collection_submission_facility_types_update
before update of payload_json on content_submissions
when json_extract(new.payload_json,'$.submissionKind')='collection'
begin
  select case when exists (
    select 1
     from json_each(new.payload_json,'$.collection.floors') floor
      join json_each(floor.value,'$.facilities') facility
     where not exists (
       select 1 from facility_types type
        where type.code=json_extract(facility.value,'$.typeCode')
          and (
            new.status not in ('pending','in_review')
            or type.status='active'
          )
     )
  ) then raise(abort,'active collection submission requires active facility types') end;
end;

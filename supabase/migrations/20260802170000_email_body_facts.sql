-- Email-based upload, Stage 3: capturing an email's own body text as a
-- sourced-fact record, separate from however any attachment gets routed.
--
-- source_type is a plain text column with a CHECK constraint (confirmed
-- directly, not assumed — no hard Postgres enum type involved, so this is
-- a trivial constraint swap, none of the transactional quirks a real enum
-- type would have in some PG versions). Adds 'email' as its own distinct
-- value rather than reusing 'letter' — a physically-written letter and an
-- auto-parsed modern email are both prose, but meaningfully different
-- kinds of source; collapsing them would be a false grouping the moment
-- anyone filters/browses facts by source type later.
alter table public.facts drop constraint facts_source_type_check;
alter table public.facts add constraint facts_source_type_check
  check (source_type = any (array['firsthand', 'secondhand', 'document', 'letter', 'chart', 'conflict', 'email']::text[]));

-- is_email_body_note distinguishes this new kind of documents row (the
-- email's own body text, stored as a real .txt file per the Stage 3
-- investigation's recommendation — keeps "every document row is backed
-- by a real, viewable file" true with no special case) from a normal
-- uploaded document. Necessary, not optional: interviewee_person_id and
-- parent_document_id (the existing discriminators used everywhere else
-- this table is queried) are BOTH null for this new kind of row too,
-- exactly like a plain uploaded document — without a new column, these
-- rows would silently show up in /documents' normal list and viewer,
-- which expect a flat CandidatePerson[] candidate_people shape, not this
-- new kind's { people, facts, anecdotes } shape. That's the exact same
-- class of bug a past incident already hit once for interview rows
-- reaching /documents unfiltered (see CLAUDE.md's Audio Interview
-- architecture notes) — a new explicit column here, not a fragile
-- inference from existing ones.
alter table public.documents add column is_email_body_note boolean not null default false;

-- fork_family(): carry is_email_body_note through on the documents copy
-- (a plain boolean, no id remapping needed) — omitting it from the
-- column list would silently reset every forked email-body-note row back
-- to false, misclassifying it as a normal document in the new family.
-- Every other section of this function is byte-for-byte unchanged from
-- the email_subject migration — CREATE OR REPLACE requires the full
-- body, not a partial edit.
create or replace function public.fork_family(source_family_id uuid, new_name text)
returns table(
  forked_family_id uuid,
  forked_family_name text,
  person_id_map jsonb,
  fact_id_map jsonb,
  anecdote_id_map jsonb,
  document_id_map jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid;
  trimmed_name text;
  target_family_id uuid;
begin
  caller_id := auth.uid();
  if caller_id is null then
    raise exception 'Not authenticated';
  end if;
  if not is_family_member(source_family_id) then
    raise exception 'Not a member of the family being forked';
  end if;

  trimmed_name := trim(new_name);
  if trimmed_name = '' then
    raise exception 'Family name is required';
  end if;

  insert into families (name, created_by)
  values (trimmed_name, caller_id)
  returning id into target_family_id;

  insert into family_members (family_id, user_id, role, is_active)
  values (target_family_id, caller_id, 'owner', false);

  update family_members set is_active = false
  where user_id = caller_id and family_id <> target_family_id;
  update family_members set is_active = true
  where user_id = caller_id and family_id = target_family_id;

  -- people
  create temporary table _ff_person_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  insert into _ff_person_map (old_id, new_id)
  select id, gen_random_uuid() from people where people.family_id = source_family_id;

  insert into people (id, family_id, name, is_placeholder, birth_estimate, death_estimate, notes, is_root, created_at, first_name, preferred_name, last_name, married_name, gender, aliases)
  select m.new_id, target_family_id, p.name, p.is_placeholder, p.birth_estimate, p.death_estimate, p.notes, p.is_root, p.created_at, p.first_name, p.preferred_name, p.last_name, p.married_name, p.gender, p.aliases
  from people p
  join _ff_person_map m on m.old_id = p.id;

  -- unions
  create temporary table _ff_union_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  insert into _ff_union_map (old_id, new_id)
  select id, gen_random_uuid() from unions where unions.family_id = source_family_id;

  insert into unions (id, family_id, parent1_id, parent2_id, note, created_at)
  select um.new_id, target_family_id, pm1.new_id, pm2.new_id, u.note, u.created_at
  from unions u
  join _ff_union_map um on um.old_id = u.id
  left join _ff_person_map pm1 on pm1.old_id = u.parent1_id
  left join _ff_person_map pm2 on pm2.old_id = u.parent2_id;

  -- union_children
  insert into union_children (union_id, child_id)
  select um.new_id, pm.new_id
  from union_children uc
  join _ff_union_map um on um.old_id = uc.union_id
  join _ff_person_map pm on pm.old_id = uc.child_id;

  -- documents
  create temporary table _ff_document_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  insert into _ff_document_map (old_id, new_id)
  select id, gen_random_uuid() from documents where documents.family_id = source_family_id;

  insert into documents (id, family_id, file_path, document_type, uploaded_by, transcription_raw, recorded_at, status, filename, candidate_people, kind, parent_document_id, audio_start_seconds, audio_end_seconds, interviewee_person_id, interview_summary, prompt_text, gap_person_id, extraction_error, source, submitted_by_name, submitted_by_email, email_subject, is_email_body_note)
  select
    dm.new_id, target_family_id,
    target_family_id || '/' || substring(d.file_path from position('/' in d.file_path) + 1),
    d.document_type, d.uploaded_by, d.transcription_raw, d.recorded_at, d.status, d.filename,
    d.candidate_people, d.kind, dm_parent.new_id,
    d.audio_start_seconds, d.audio_end_seconds, pm_interviewee.new_id,
    d.interview_summary, d.prompt_text, pm_gap.new_id, d.extraction_error,
    d.source, d.submitted_by_name, d.submitted_by_email, d.email_subject, d.is_email_body_note
  from documents d
  join _ff_document_map dm on dm.old_id = d.id
  left join _ff_document_map dm_parent on dm_parent.old_id = d.parent_document_id
  left join _ff_person_map pm_interviewee on pm_interviewee.old_id = d.interviewee_person_id
  left join _ff_person_map pm_gap on pm_gap.old_id = d.gap_person_id;

  -- facts
  create temporary table _ff_fact_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  insert into _ff_fact_map (old_id, new_id)
  select id, gen_random_uuid() from facts where facts.family_id = source_family_id;

  insert into facts (id, person_id, field, value, source_type, source_ref, contributor_id, confidence, recorded_at, family_id, document_id)
  select fam.new_id, pm.new_id, f.field, f.value, f.source_type, f.source_ref, f.contributor_id, f.confidence, f.recorded_at, target_family_id, dm.new_id
  from facts f
  join _ff_fact_map fam on fam.old_id = f.id
  join _ff_person_map pm on pm.old_id = f.person_id
  left join _ff_document_map dm on dm.old_id = f.document_id;

  -- anecdotes
  create temporary table _ff_anecdote_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  insert into _ff_anecdote_map (old_id, new_id)
  select id, gen_random_uuid() from anecdotes where anecdotes.family_id = source_family_id;

  insert into anecdotes (id, person_id, contributor_id, who_told_it, story_text, recorded_at, family_id, document_id)
  select am.new_id, pm.new_id, a.contributor_id, a.who_told_it, a.story_text, a.recorded_at, target_family_id, dm.new_id
  from anecdotes a
  join _ff_anecdote_map am on am.old_id = a.id
  join _ff_person_map pm on pm.old_id = a.person_id
  left join _ff_document_map dm on dm.old_id = a.document_id;

  -- document_people
  insert into document_people (document_id, person_id)
  select dm.new_id, pm.new_id
  from document_people dp
  join _ff_document_map dm on dm.old_id = dp.document_id
  join _ff_person_map pm on pm.old_id = dp.person_id;

  -- events
  create temporary table _ff_event_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  insert into _ff_event_map (old_id, new_id)
  select id, gen_random_uuid() from events where events.family_id = source_family_id;

  insert into events (id, event_type, date_estimate, location, notes, created_at, family_id)
  select em.new_id, e.event_type, e.date_estimate, e.location, e.notes, e.created_at, target_family_id
  from events e
  join _ff_event_map em on em.old_id = e.id;

  -- event_people
  insert into event_people (event_id, person_id, role)
  select em.new_id, pm.new_id, ep.role
  from event_people ep
  join _ff_event_map em on em.old_id = ep.event_id
  join _ff_person_map pm on pm.old_id = ep.person_id;

  -- photos (storage_path already points at the correct NEW location even
  -- though the bytes haven't been physically copied there yet — the
  -- caller does that immediately after this function returns, same
  -- pattern documents already uses)
  create temporary table _ff_photo_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  insert into _ff_photo_map (old_id, new_id)
  select id, gen_random_uuid() from photos where photos.family_id = source_family_id;

  insert into photos (id, storage_path, original_filename, caption, taken_at, uploaded_by, created_at, family_id, source, submitted_by_name, submitted_by_email)
  select
    phm.new_id,
    target_family_id || '/' || substring(ph.storage_path from position('/' in ph.storage_path) + 1),
    ph.original_filename, ph.caption, ph.taken_at, ph.uploaded_by, ph.created_at, target_family_id,
    ph.source, ph.submitted_by_name, ph.submitted_by_email
  from photos ph
  join _ff_photo_map phm on phm.old_id = ph.id;

  -- photo_tags
  insert into photo_tags (id, photo_id, person_id, x_position, y_position, created_at, tagged_by)
  select gen_random_uuid(), phm.new_id, pm.new_id, pt.x_position, pt.y_position, pt.created_at, pt.tagged_by
  from photo_tags pt
  join _ff_photo_map phm on phm.old_id = pt.photo_id
  join _ff_person_map pm on pm.old_id = pt.person_id;

  -- interview_gap_no_info
  insert into interview_gap_no_info (family_id, interviewee_person_id, gap_person_id, segment_document_id)
  select target_family_id, pm1.new_id, pm2.new_id, dm.new_id
  from interview_gap_no_info gi
  join _ff_person_map pm1 on pm1.old_id = gi.interviewee_person_id
  join _ff_person_map pm2 on pm2.old_id = gi.gap_person_id
  left join _ff_document_map dm on dm.old_id = gi.segment_document_id
  where gi.family_id = source_family_id;

  return query
  select
    target_family_id,
    trimmed_name,
    coalesce((select jsonb_object_agg(old_id::text, new_id::text) from _ff_person_map), '{}'::jsonb),
    coalesce((select jsonb_object_agg(old_id::text, new_id::text) from _ff_fact_map), '{}'::jsonb),
    coalesce((select jsonb_object_agg(old_id::text, new_id::text) from _ff_anecdote_map), '{}'::jsonb),
    coalesce((select jsonb_object_agg(old_id::text, new_id::text) from _ff_document_map), '{}'::jsonb);
end;
$$;

grant execute on function public.fork_family(uuid, text) to authenticated;

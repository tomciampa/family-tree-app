-- Stage 3, part 1: Storage RLS was never scoped by family — it had the
-- exact same "any authenticated user" blanket policy Stage 0 fixed for
-- every public-schema table, just never touched. Both document uploads
-- and interview recordings already namespace their paths by family
-- (`${familyId}/${uuid}-filename}`, confirmed in documents/actions.ts and
-- record-interview-flow.tsx, and verified against all 21 real objects in
-- the bucket), but nothing enforced it — any authenticated user could
-- list/download/overwrite/delete any family's files directly via the
-- Storage API, bypassing the public-schema RLS entirely.
--
-- Deliberately scoped to is_family_member() (ANY real membership), not
-- is_active_family_member() (Stage 2's active-only check used for the
-- public-schema data tables) — forking needs simultaneous read access to
-- the source family's files and write access to the new family's files
-- in the same operation, and only one family can ever be "active" at a
-- time. Unlike the data tables, nothing in this app does an unfiltered
-- Storage listing that active-only scoping was protecting against (every
-- Storage call already targets one explicit, already-known path) — so
-- there's no equivalent leak risk in using the broader check here.
create or replace function public.family_id_from_storage_path(object_name text)
returns uuid
language plpgsql
immutable
set search_path = public
as $$
begin
  return (regexp_match(object_name, '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/'))[1]::uuid;
exception when others then
  return null;
end;
$$;

drop policy "logged in users can do everything on documents bucket" on storage.objects;

create policy "family members can access their family's documents bucket objects"
on storage.objects
for all
to authenticated
using (
  bucket_id = 'documents'
  and family_id_from_storage_path(name) is not null
  and is_family_member(family_id_from_storage_path(name))
)
with check (
  bucket_id = 'documents'
  and family_id_from_storage_path(name) is not null
  and is_family_member(family_id_from_storage_path(name))
);

-- Stage 3, part 2: fork an existing family into a new, fully independent
-- one. Deep-copies every family-scoped row with fresh IDs and fully
-- remapped foreign keys — including the ones buried inside
-- documents.candidate_people JSONB (matches[].personId,
-- resolution.personId/factId, written.factId/anecdoteId), which the SQL
-- layer deliberately does NOT try to fix — walking arbitrary nested JSON
-- correctly in PL/pgSQL is exactly the kind of thing that's easy to get
-- subtly wrong and hard to verify. Instead this returns full old->new ID
-- maps (person/fact/anecdote/document) as JSONB, and the caller (a
-- TypeScript server action, see app/settings/actions.ts) does the JSONB
-- remap with real type-checked logic, then writes the corrected
-- candidate_people back with a plain UPDATE. Same split of
-- responsibility for the actual file bytes: this function computes each
-- copied document's new file_path (same random-uuid+filename suffix,
-- new family's folder) but never touches Storage itself — the caller
-- does the physical storage.copy() once it has the real path pairs.
--
-- contributors is deliberately not copied (not in the confirmed scope,
-- and empty/unreferenced in every current real row — verified: zero
-- non-null contributor_id/uploaded_by values anywhere before writing
-- this). Any contributor_id/uploaded_by column is carried through
-- unchanged, which is only safe because it's always null today; if this
-- table is ever populated, forking would need revisiting.
--
-- Every temp table and PL/pgSQL variable name here is deliberately
-- chosen to never collide with a real column name anywhere referenced in
-- this function (the exact bug hit twice in Stage 1's migrations, in
-- RETURNS TABLE columns specifically) — and every statement below was
-- verified directly via role-simulated SQL before any application code
-- was written against it.
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

  -- Bootstrap: same pattern as create_family() (Stage 2) — a families row
  -- nobody is a member of yet can't satisfy the ordinary
  -- is_family_member()-scoped RLS for a plain insert, so this has to
  -- happen inside this same SECURITY DEFINER function.
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

  -- documents (candidate_people copied as-is for now — the caller
  -- overwrites it with the properly remapped version; file_path already
  -- points at the correct NEW location even though the bytes haven't
  -- been physically copied there yet, which the caller does immediately
  -- after this function returns, before the fork is ever shown to anyone)
  create temporary table _ff_document_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  insert into _ff_document_map (old_id, new_id)
  select id, gen_random_uuid() from documents where documents.family_id = source_family_id;

  insert into documents (id, family_id, file_path, document_type, uploaded_by, transcription_raw, recorded_at, status, filename, candidate_people, kind, parent_document_id, audio_start_seconds, audio_end_seconds, interviewee_person_id, interview_summary, prompt_text, gap_person_id, extraction_error)
  select
    dm.new_id, target_family_id,
    target_family_id || '/' || substring(d.file_path from position('/' in d.file_path) + 1),
    d.document_type, d.uploaded_by, d.transcription_raw, d.recorded_at, d.status, d.filename,
    d.candidate_people, d.kind, dm_parent.new_id,
    d.audio_start_seconds, d.audio_end_seconds, pm_interviewee.new_id,
    d.interview_summary, d.prompt_text, pm_gap.new_id, d.extraction_error
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

  -- photos
  create temporary table _ff_photo_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  insert into _ff_photo_map (old_id, new_id)
  select id, gen_random_uuid() from photos where photos.family_id = source_family_id;

  insert into photos (id, file_path, caption, date_estimate, event_id, uploaded_by, created_at, family_id)
  select
    phm.new_id,
    target_family_id || '/' || substring(ph.file_path from position('/' in ph.file_path) + 1),
    ph.caption, ph.date_estimate, em.new_id, ph.uploaded_by, ph.created_at, target_family_id
  from photos ph
  join _ff_photo_map phm on phm.old_id = ph.id
  left join _ff_event_map em on em.old_id = ph.event_id;

  -- photo_tags
  insert into photo_tags (photo_id, person_id)
  select phm.new_id, pm.new_id
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

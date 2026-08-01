-- Photos feature, Stage 1: schema + storage + basic upload only (no
-- tagging UI, no gallery yet). photos/photo_tags already existed as early
-- scaffolding (same era as the dead `contributors` table) but with a
-- different shape (file_path/event_id/date_estimate, no spatial tagging)
-- and zero rows — altered in place rather than replaced, since two real
-- consumers already reference the old columns by name: the person
-- dossier's photo list (app/people/[id]/page.tsx) and fork_family()'s
-- Storage-copy logic (app/settings/actions.ts), both updated below/in the
-- same commit as this migration. Zero data-migration risk: confirmed 0
-- rows in both tables before writing this.

-- photos: rename/restructure to the new spec. storage_path replaces
-- file_path (same column, renamed — no data to lose). original_filename
-- is the real, unsanitized display name, kept separate from the
-- sanitized storage key (see lib/sanitize-filename.ts) specifically so a
-- name like "Società Anonima di Navigazione.jpg" still displays correctly
-- even though its storage key can't contain the accented characters
-- (Supabase Storage's InvalidKey rejection — confirmed directly against
-- the real API in an earlier investigation — covers non-ASCII broadly,
-- not just accents: Cyrillic and CJK are rejected identically). taken_at
-- is a real date, not the old free-text date_estimate. event_id and
-- date_estimate are dropped — the "events" concept they pointed at was
-- never built out, and neither is part of this feature's actual spec.
alter table public.photos rename column file_path to storage_path;
alter table public.photos add column original_filename text;
alter table public.photos alter column original_filename set not null;
alter table public.photos add column taken_at date;
alter table public.photos drop column date_estimate;
alter table public.photos drop column event_id;
alter table public.photos alter column family_id set not null;

-- uploaded_by previously referenced the dead `contributors` table (never
-- populated by any app code, confirmed — same gap documents.uploaded_by
-- still has, left alone as out of scope here) — repointed at auth.users
-- directly so this new table's uploaded_by is actually meaningful and
-- gets populated by the real upload action.
alter table public.photos drop constraint photos_uploaded_by_fkey;
alter table public.photos
  add constraint photos_uploaded_by_fkey
  foreign key (uploaded_by) references auth.users(id) on delete set null;

-- photo_tags: add a real surrogate primary key (was just a composite
-- (photo_id, person_id) with nothing else) plus the spatial position
-- Stage 2's tagging UI will need. x_position/y_position are 0.0-1.0
-- floats (percentage of image width/height, not pixels), nullable for
-- now since Stage 1 never writes a row here at all — enforced in range
-- once set, not required to be set.
alter table public.photo_tags drop constraint photo_tags_pkey;
alter table public.photo_tags add column id uuid not null default gen_random_uuid();
alter table public.photo_tags add primary key (id);
alter table public.photo_tags add column x_position double precision;
alter table public.photo_tags add column y_position double precision;
alter table public.photo_tags add column created_at timestamptz not null default now();
alter table public.photo_tags
  add constraint photo_tags_x_position_range check (x_position is null or (x_position >= 0 and x_position <= 1));
alter table public.photo_tags
  add constraint photo_tags_y_position_range check (y_position is null or (y_position >= 0 and y_position <= 1));

-- RLS on both tables already correctly scoped via is_active_family_member
-- (photos directly, photo_tags via a join back to its parent photo) —
-- confirmed against the live policies before writing this migration,
-- unchanged by anything above since neither policy references a column
-- being altered.

-- New, separate Storage bucket for photos — not reusing the documents
-- bucket, so the two pipelines stay cleanly namespaced. Same access
-- pattern as the existing documents bucket policy: family_id_from_storage_path
-- (already bucket-agnostic, just parses the "${familyId}/..." prefix) plus
-- is_family_member() (broader "any real membership" check, matching the
-- documents bucket's own policy — forking needs simultaneous read/write
-- across two families, which is exactly why that policy already uses the
-- broader check instead of is_active_family_member()).
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

create policy "family members can access their family's photos bucket objects"
on storage.objects
for all
to authenticated
using (
  bucket_id = 'photos'
  and family_id_from_storage_path(name) is not null
  and is_family_member(family_id_from_storage_path(name))
)
with check (
  bucket_id = 'photos'
  and family_id_from_storage_path(name) is not null
  and is_family_member(family_id_from_storage_path(name))
);

-- fork_family(): update the photos/photo_tags sections to the new column
-- names (storage_path/original_filename, no event_id/date_estimate; x/y
-- position + created_at now copied through on photo_tags). Every other
-- section of this function is byte-for-byte unchanged from the Stage 3
-- migration — Postgres requires the full body for CREATE OR REPLACE, not
-- a partial edit.
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

  -- photos (storage_path already points at the correct NEW location even
  -- though the bytes haven't been physically copied there yet — the
  -- caller does that immediately after this function returns, same
  -- pattern documents already uses)
  create temporary table _ff_photo_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  insert into _ff_photo_map (old_id, new_id)
  select id, gen_random_uuid() from photos where photos.family_id = source_family_id;

  insert into photos (id, storage_path, original_filename, caption, taken_at, uploaded_by, created_at, family_id)
  select
    phm.new_id,
    target_family_id || '/' || substring(ph.storage_path from position('/' in ph.storage_path) + 1),
    ph.original_filename, ph.caption, ph.taken_at, ph.uploaded_by, ph.created_at, target_family_id
  from photos ph
  join _ff_photo_map phm on phm.old_id = ph.id;

  -- photo_tags
  insert into photo_tags (id, photo_id, person_id, x_position, y_position, created_at)
  select gen_random_uuid(), phm.new_id, pm.new_id, pt.x_position, pt.y_position, pt.created_at
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

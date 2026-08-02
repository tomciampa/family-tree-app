-- Exact-duplicate detection for documents and photos, across all three
-- upload paths (web document upload, web photo upload, email intake).
--
-- content_hash is a SHA-256 hex digest of the file's ORIGINAL bytes — for
-- the email path specifically, hashed in the Cloudflare Worker BEFORE any
-- compression happens (see cloudflare-worker/email-intake.ts's rawBytes,
-- hashed ahead of the compressImage() call), so a since-compressed
-- emailed photo still matches an identical original uploaded via the
-- website. duplicate_of_id points at the earliest existing row with the
-- same hash in the same family, set by application code at insert time
-- (not a trigger — the "which existing row is the original" lookup
-- already needs the family scope and table context application code
-- already has on hand; a trigger would just be re-deriving the same
-- thing with less context).
--
-- Deliberately excludes interview segments/sessions and email-body-note
-- rows from this feature's scope — they aren't "the same file uploaded
-- twice" candidates the way a photo or document attachment is. Every
-- upload-path write site is responsible for only ever looking up/setting
-- these columns for plain documents (interviewee_person_id and
-- parent_document_id both null, is_email_body_note false) or photos.
--
-- Backfilled for the 32 pre-existing rows (13 documents, 19 photos) via a
-- one-time script hashing each row's CURRENTLY STORED bytes — for the 11
-- pre-existing email-sourced photos, this is a final (possibly
-- compressed) hash, not an original one, since the true original bytes
-- were never persisted anywhere. This is a known, narrow, historical-only
-- asymmetry (see CLAUDE.md): it can only cause a missed duplicate match
-- between an old compressed email photo and a newly-uploaded original of
-- the same photo, never between any two rows created after this shipped.
-- Accepted as-is, no further mitigation.
alter table public.documents add column content_hash text;
alter table public.documents add column duplicate_of_id uuid references public.documents(id) on delete set null;

alter table public.photos add column content_hash text;
alter table public.photos add column duplicate_of_id uuid references public.photos(id) on delete set null;

-- Speeds up the family-scoped hash lookup every upload path does on
-- insert (`where family_id = ? and content_hash = ?`).
create index documents_family_content_hash_idx on public.documents (family_id, content_hash) where content_hash is not null;
create index photos_family_content_hash_idx on public.photos (family_id, content_hash) where content_hash is not null;

-- fork_family(): carry content_hash straight through (a plain value, no
-- remapping needed) and remap duplicate_of_id through the same document/
-- photo id maps already built for every other self/cross-referencing
-- column (see parent_document_id's dm_parent join in the documents
-- insert below — photos never had a self-referencing column before this,
-- so photos gets the same left-join-against-its-own-map pattern applied
-- for the first time). Every other section of this function is
-- byte-for-byte unchanged from the email_body_facts migration —
-- CREATE OR REPLACE requires the full body, not a partial edit.
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

  insert into documents (id, family_id, file_path, document_type, uploaded_by, transcription_raw, recorded_at, status, filename, candidate_people, kind, parent_document_id, audio_start_seconds, audio_end_seconds, interviewee_person_id, interview_summary, prompt_text, gap_person_id, extraction_error, source, submitted_by_name, submitted_by_email, email_subject, is_email_body_note, content_hash, duplicate_of_id)
  select
    dm.new_id, target_family_id,
    target_family_id || '/' || substring(d.file_path from position('/' in d.file_path) + 1),
    d.document_type, d.uploaded_by, d.transcription_raw, d.recorded_at, d.status, d.filename,
    d.candidate_people, d.kind, dm_parent.new_id,
    d.audio_start_seconds, d.audio_end_seconds, pm_interviewee.new_id,
    d.interview_summary, d.prompt_text, pm_gap.new_id, d.extraction_error,
    d.source, d.submitted_by_name, d.submitted_by_email, d.email_subject, d.is_email_body_note,
    d.content_hash, dm_dup.new_id
  from documents d
  join _ff_document_map dm on dm.old_id = d.id
  left join _ff_document_map dm_parent on dm_parent.old_id = d.parent_document_id
  left join _ff_person_map pm_interviewee on pm_interviewee.old_id = d.interviewee_person_id
  left join _ff_person_map pm_gap on pm_gap.old_id = d.gap_person_id
  left join _ff_document_map dm_dup on dm_dup.old_id = d.duplicate_of_id;

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

  insert into photos (id, storage_path, original_filename, caption, taken_at, uploaded_by, created_at, family_id, source, submitted_by_name, submitted_by_email, content_hash, duplicate_of_id)
  select
    phm.new_id,
    target_family_id || '/' || substring(ph.storage_path from position('/' in ph.storage_path) + 1),
    ph.original_filename, ph.caption, ph.taken_at, ph.uploaded_by, ph.created_at, target_family_id,
    ph.source, ph.submitted_by_name, ph.submitted_by_email,
    ph.content_hash, phm_dup.new_id
  from photos ph
  join _ff_photo_map phm on phm.old_id = ph.id
  left join _ff_photo_map phm_dup on phm_dup.old_id = ph.duplicate_of_id;

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

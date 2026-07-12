-- Tracks whether a document has been matched to a person yet. General
-- uploads (from /documents) start unmatched; per-person uploads (from the
-- tree's Add fact flow) are matched at creation time since they're already
-- linked via document_people.
alter table public.documents
  add column status text not null default 'pending_match'
    check (status in ('pending_match', 'matched', 'no_match'));

-- Original filename, for display — file_path is a storage key
-- (family-scoped, uuid-prefixed) rather than something human-readable.
alter table public.documents
  add column filename text;

-- Existing documents (all created via the per-person flow, so already
-- linked to someone) are matched by definition.
update public.documents set status = 'matched';

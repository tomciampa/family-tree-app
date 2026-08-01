-- documents.uploaded_by still referenced the dead `contributors` table
-- (0 rows, confirmed) — the same gap the Stage 1 photos migration
-- explicitly called out and fixed for photos.uploaded_by, but left
-- "out of scope" for documents at the time. Populating it (see
-- uploadDocument/createInterviewSession in the same commit as this
-- migration, for the homepage Getting Started checklist) surfaced the
-- gap for real: every insert with a non-null uploaded_by failed with
-- "violates foreign key constraint documents_uploaded_by_fkey", caught
-- live during Getting Started verification. Repointed at auth.users
-- directly, same as photos.uploaded_by already is.
alter table public.documents drop constraint documents_uploaded_by_fkey;
alter table public.documents
  add constraint documents_uploaded_by_fkey
  foreign key (uploaded_by) references auth.users(id) on delete set null;

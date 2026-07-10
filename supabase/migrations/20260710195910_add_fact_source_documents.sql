-- Link a fact to the source document it was extracted from (e.g. an
-- uploaded PDF). Nullable — most facts are still entered by hand with no
-- document behind them. Uses the documents/document_people tables that
-- already existed in the schema but weren't wired into the app yet.
alter table public.facts
  add column document_id uuid references public.documents(id) on delete set null;

-- Storage bucket for uploaded source documents (PDFs now; audio later).
-- Private — access goes through the app's server actions, not public URLs.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- Match the same simple "any authenticated user" access pattern already
-- used on every other table in this single-family app.
create policy "logged in users can do everything on documents bucket"
on storage.objects
for all
to authenticated
using (auth.role() = 'authenticated' and bucket_id = 'documents')
with check (auth.role() = 'authenticated' and bucket_id = 'documents');

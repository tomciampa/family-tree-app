-- Stage 1 of FamilySearch integration: one OAuth connection per family,
-- so Stage 2's record matching can look up a token server-side without
-- depending on which browser session originally connected it. Sandbox
-- (Integration environment) access tokens only live ~24h for now — no
-- refresh_token column yet since offline_access hasn't been requested
-- from FamilySearch (see project notes); add one when that's in place.
create table public.familysearch_connection (
  family_id uuid primary key references public.families(id) on delete cascade,
  fs_user_id text not null,
  fs_display_name text not null,
  access_token text not null,
  token_expires_at timestamptz not null,
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz not null default now()
);

alter table public.familysearch_connection enable row level security;

-- Same simple "any authenticated user" access pattern already used on
-- every other table in this single-family app.
create policy "logged in users can do everything on familysearch_connection"
on public.familysearch_connection
for all
to authenticated
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');

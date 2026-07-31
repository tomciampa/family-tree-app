-- Platform-level admin flag, distinct from family_members.role (owner/member),
-- which is a per-family concept and orthogonal to this. No public.profiles
-- table existed before this — deliberately minimal, not a full user-profile
-- mirror: just the one flag this needs. A user with no row here is not an
-- admin (the safe default), so only admin accounts ever get a row.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A user may read only their own row (to check their own admin status
-- client/server-side via the normal RLS-scoped client) — never anyone
-- else's. No insert/update/delete policy for authenticated at all: nothing
-- in the app ever lets a user grant themselves admin. The one admin row
-- below is inserted directly via this migration (effectively a superuser
-- write), and any future promotion has to go through the same path, not
-- a client-reachable action.
create policy "users can read their own profile"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

insert into public.profiles (id, is_platform_admin)
values ('e6e42c6b-ed78-4926-a30c-62470cf3d30e', true);

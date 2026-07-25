-- Stage 1: invite/join an existing family.
--
-- family_invites is a single-use, expiring token that lets a current
-- family member hand someone a link to join. The row itself is only ever
-- readable/writable by existing members of that family (same
-- is_family_member() pattern as every other table, per Stage 0) — the
-- /join/[code] flow, which by definition is used by someone who is NOT
-- yet a member, goes through the two SECURITY DEFINER functions below
-- instead, each scoped to exactly one invite (looked up by its own
-- unguessable code), never a broad table read.
create table public.family_invites (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  code text not null unique,
  created_by uuid not null references auth.users(id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_at timestamptz,
  used_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.family_invites enable row level security;

create policy "family members can access their family's invites"
on public.family_invites
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

create index family_invites_family_id_idx on public.family_invites (family_id);

-- Read-only preview for the /join/[code] page, before the visitor has
-- necessarily done anything — callable by anon (page loads pre-login) and
-- authenticated alike. Deliberately returns only what the confirmation
-- screen needs (family name + a status), never the row itself, so a
-- guess-the-code attempt can't enumerate other invites or leak anything
-- beyond "this specific code is/isn't valid right now."
create or replace function public.get_invite_preview(invite_code text)
returns table(status text, family_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
begin
  select fi.family_id, fi.used_at, fi.expires_at, f.name as family_name
  into inv
  from family_invites fi
  join families f on f.id = fi.family_id
  where fi.code = invite_code;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if inv.used_at is not null then
    return query select 'used'::text, inv.family_name;
    return;
  end if;

  if inv.expires_at < now() then
    return query select 'expired'::text, inv.family_name;
    return;
  end if;

  if auth.uid() is not null and exists (
    select 1 from family_members fm
    where fm.family_id = inv.family_id and fm.user_id = auth.uid()
  ) then
    return query select 'already_member'::text, inv.family_name;
    return;
  end if;

  return query select 'valid'::text, inv.family_name;
end;
$$;

grant execute on function public.get_invite_preview(text) to authenticated, anon;

-- The actual join action. Requires auth.uid() (the page only ever shows a
-- confirm button once logged in, but this is enforced here too, not just
-- trusted from the UI). Single-use is enforced by the UPDATE itself: only
-- one concurrent caller can flip used_at from null to non-null, so there's
-- no separate check-then-act race window between validating the code and
-- consuming it. Works identically whether this is the caller's first
-- family_members row ever or an additional one — nothing here assumes
-- single-family membership.
create or replace function public.redeem_family_invite(invite_code text)
returns table(status text, family_id uuid, family_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_family_id uuid;
  fam_name text;
begin
  if auth.uid() is null then
    return query select 'not_authenticated'::text, null::uuid, null::text;
    return;
  end if;

  update family_invites
  set used_at = now(), used_by = auth.uid()
  where code = invite_code
    and used_at is null
    and expires_at > now()
  returning family_invites.family_id into claimed_family_id;

  if claimed_family_id is null then
    if exists (select 1 from family_invites where code = invite_code and used_at is not null) then
      return query select 'used'::text, null::uuid, null::text;
    elsif exists (select 1 from family_invites where code = invite_code) then
      return query select 'expired'::text, null::uuid, null::text;
    else
      return query select 'not_found'::text, null::uuid, null::text;
    end if;
    return;
  end if;

  select name into fam_name from families where id = claimed_family_id;

  insert into family_members (family_id, user_id, role)
  values (claimed_family_id, auth.uid(), 'member')
  on conflict (family_id, user_id) do nothing;

  return query select 'joined'::text, claimed_family_id, fam_name;
end;
$$;

grant execute on function public.redeem_family_invite(text) to authenticated;

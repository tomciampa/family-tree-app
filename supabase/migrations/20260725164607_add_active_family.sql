-- Stage 2: "active family" concept. getFamilyId() previously did
-- `select id from families limit 1` with no ordering and no real
-- filtering beyond whatever RLS happened to let through — for a user in
-- more than one family (impossible before Stage 1's invite flow, and
-- Stage 2's own family-creation flow) this returns an arbitrary,
-- implementation-dependent row (confirmed empirically: consistently
-- returned whichever family Postgres's default scan order favored, with
-- no ordering guarantee behind that). is_active tracks a deliberate,
-- user-controlled choice instead.
alter table public.family_members add column is_active boolean not null default false;

-- Backfill: every existing row becomes its owner's active family (each
-- real user today has exactly one row, so this is a no-op choice for
-- them — zero behavior change). Uses row_number() rather than assuming
-- one row per user so this migration is still correct if that's ever not
-- true by the time it runs.
with ranked as (
  select family_id, user_id,
    row_number() over (partition by user_id order by joined_at) as rn
  from public.family_members
)
update public.family_members fm
set is_active = true
from ranked r
where fm.family_id = r.family_id and fm.user_id = r.user_id and r.rn = 1;

-- Enforced at the DB level, not just app logic — every writer that
-- changes is_active (create_family and redeem_family_invite below) does
-- so via two sequential statements (clear others, then set the one
-- target true) specifically so this constraint is never evaluated against
-- a transiently-inconsistent multi-active state within a single UPDATE.
create unique index family_members_one_active_per_user
on public.family_members (user_id)
where is_active;

-- Mirrors redeem_family_invite's shape (see the Stage 1 migrations) for
-- the same reason: creating a family requires inserting a `families` row
-- nobody is a member of yet, which the ordinary is_family_member()-scoped
-- RLS policy can never allow for a plain authenticated INSERT — bootstrap
-- access has to come from a SECURITY DEFINER function, not a relaxed
-- policy.
--
-- Naming note (a real bug hit twice in the Stage 1 migrations): a
-- RETURNS TABLE column that happens to share a name with a real table
-- column is ambiguous in unqualifiable contexts (ON CONFLICT's column
-- list) and even in some qualifiable ones once burned once already isn't
-- worth re-risking — every OUT parameter and local variable name here is
-- deliberately something no table in this function touches uses as a
-- column name, and every SQL statement below was verified directly
-- (`select * from create_family(...)` under a role-simulated authenticated
-- session) before any application code was written against it.
create or replace function public.create_family(new_name text)
returns table(created_family_id uuid, created_family_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
  trimmed_name text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  trimmed_name := trim(new_name);
  if trimmed_name = '' then
    raise exception 'Family name is required';
  end if;

  insert into families (name, created_by)
  values (trimmed_name, auth.uid())
  returning id into inserted_id;

  insert into family_members (family_id, user_id, role, is_active)
  values (inserted_id, auth.uid(), 'owner', false);

  update family_members
  set is_active = false
  where user_id = auth.uid() and family_id <> inserted_id;

  update family_members
  set is_active = true
  where user_id = auth.uid() and family_id = inserted_id;

  return query select inserted_id, trimmed_name;
end;
$$;

grant execute on function public.create_family(text) to authenticated;

-- Updated (not a new function) so joining a family via invite also makes
-- it the active one — otherwise "Go to the family tree" after a
-- successful join would silently land the visitor on whichever OTHER
-- family happened to still be marked active, not the one they just
-- joined. Same two-statement clear-then-set pattern as create_family, and
-- otherwise byte-for-byte the same logic already verified in Stage 1
-- (single-use claim, same-caller idempotency, membership-first status
-- checks in get_invite_preview are untouched).
create or replace function public.redeem_family_invite(invite_code text)
returns table(status text, family_id uuid, family_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_family_id uuid;
  fam_name text;
  existing record;
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
    select fi.family_id, fi.used_by, fi.used_at, fi.expires_at
    into existing
    from family_invites fi
    where fi.code = invite_code;

    if existing.family_id is not null and existing.used_by = auth.uid() then
      select f.name into fam_name from families f where f.id = existing.family_id;
      return query select 'joined'::text, existing.family_id, fam_name;
      return;
    end if;

    if existing.used_at is not null then
      return query select 'used'::text, null::uuid, null::text;
    elsif existing.family_id is not null then
      return query select 'expired'::text, null::uuid, null::text;
    else
      return query select 'not_found'::text, null::uuid, null::text;
    end if;
    return;
  end if;

  select name into fam_name from families where id = claimed_family_id;

  insert into family_members (family_id, user_id, role, is_active)
  values (claimed_family_id, auth.uid(), 'member', false)
  on conflict on constraint family_members_pkey do nothing;

  update family_members
  set is_active = false
  where family_members.user_id = auth.uid() and family_members.family_id <> claimed_family_id;

  update family_members
  set is_active = true
  where family_members.user_id = auth.uid() and family_members.family_id = claimed_family_id;

  return query select 'joined'::text, claimed_family_id, fam_name;
end;
$$;

-- Real gap found during Stage 2 verification, not anticipated up front:
-- is_family_member() (Stage 0) means "has a family_members row for this
-- family at all" — that was the correct and only meaning needed when
-- every user belonged to exactly one family, but it does NOT mean "this
-- is the family I'm currently working in." Every read across the app
-- (tree, documents, interviews, settings — ~150 call sites) queries its
-- table with no explicit family_id filter, relying entirely on RLS to
-- scope results to "the current family." Confirmed live: after a second
-- family existed and was made active, /tree still rendered the FIRST
-- family's people — not because the wrong family was picked (getFamilyId()
-- resolved correctly, verified directly), but because RLS was still
-- letting the plain `people` SELECT through for BOTH families the caller
-- is a member of, and the newly-active one happened to be empty, so the
-- merged result looked identical to "just the old family."
--
-- Fixing this by adding `.eq("family_id", familyId)` to ~150 call sites
-- would be exactly the wider refactor Stage 2 was scoped to avoid, and
-- would still leave every *future* query one missed filter away from the
-- same leak. Fixing it once in RLS is both smaller and strictly safer.
--
-- is_family_member() itself is deliberately left unchanged (still "any
-- real membership, active or not") — family_members' own policy depends
-- on that broader meaning so a user can always see their OWN inactive
-- membership rows (needed by getFamilyId()'s fallback path, and by any
-- future switcher UI); tightening it there would make a user's inactive
-- families invisible even to themselves. is_active_family_member() is
-- the new, stricter check, swapped in only for the tables that hold
-- actual family data — never for families/family_members/family_invites.
create or replace function public.is_active_family_member(target_family_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from family_members
    where family_members.family_id = target_family_id
      and family_members.user_id = auth.uid()
      and family_members.is_active = true
  );
$$;

grant execute on function public.is_active_family_member(uuid) to authenticated;

drop policy "family members can access their family's people" on public.people;
create policy "family members can access their active family's people"
on public.people for all to authenticated
using (is_active_family_member(family_id)) with check (is_active_family_member(family_id));

drop policy "family members can access their family's unions" on public.unions;
create policy "family members can access their active family's unions"
on public.unions for all to authenticated
using (is_active_family_member(family_id)) with check (is_active_family_member(family_id));

drop policy "family members can access their family's contributors" on public.contributors;
create policy "family members can access their active family's contributors"
on public.contributors for all to authenticated
using (is_active_family_member(family_id)) with check (is_active_family_member(family_id));

drop policy "family members can access their family's facts" on public.facts;
create policy "family members can access their active family's facts"
on public.facts for all to authenticated
using (is_active_family_member(family_id)) with check (is_active_family_member(family_id));

drop policy "family members can access their family's anecdotes" on public.anecdotes;
create policy "family members can access their active family's anecdotes"
on public.anecdotes for all to authenticated
using (is_active_family_member(family_id)) with check (is_active_family_member(family_id));

drop policy "family members can access their family's documents" on public.documents;
create policy "family members can access their active family's documents"
on public.documents for all to authenticated
using (is_active_family_member(family_id)) with check (is_active_family_member(family_id));

drop policy "family members can access their family's events" on public.events;
create policy "family members can access their active family's events"
on public.events for all to authenticated
using (is_active_family_member(family_id)) with check (is_active_family_member(family_id));

drop policy "family members can access their family's photos" on public.photos;
create policy "family members can access their active family's photos"
on public.photos for all to authenticated
using (is_active_family_member(family_id)) with check (is_active_family_member(family_id));

drop policy "family members can access their family's familysearch connectio" on public.familysearch_connection;
create policy "family members can access their active family's familysearch connectio"
on public.familysearch_connection for all to authenticated
using (is_active_family_member(family_id)) with check (is_active_family_member(family_id));

drop policy "family members can access their family's interview gap records" on public.interview_gap_no_info;
create policy "family members can access their active family's interview gap records"
on public.interview_gap_no_info for all to authenticated
using (is_active_family_member(family_id)) with check (is_active_family_member(family_id));

drop policy "family members can access their family's union_children" on public.union_children;
create policy "family members can access their active family's union_children"
on public.union_children for all to authenticated
using (exists (select 1 from public.unions u where u.id = union_children.union_id and is_active_family_member(u.family_id)))
with check (exists (select 1 from public.unions u where u.id = union_children.union_id and is_active_family_member(u.family_id)));

drop policy "family members can access their family's document_people" on public.document_people;
create policy "family members can access their active family's document_people"
on public.document_people for all to authenticated
using (exists (select 1 from public.documents d where d.id = document_people.document_id and is_active_family_member(d.family_id)))
with check (exists (select 1 from public.documents d where d.id = document_people.document_id and is_active_family_member(d.family_id)));

drop policy "family members can access their family's photo_tags" on public.photo_tags;
create policy "family members can access their active family's photo_tags"
on public.photo_tags for all to authenticated
using (exists (select 1 from public.photos p where p.id = photo_tags.photo_id and is_active_family_member(p.family_id)))
with check (exists (select 1 from public.photos p where p.id = photo_tags.photo_id and is_active_family_member(p.family_id)));

drop policy "family members can access their family's event_people" on public.event_people;
create policy "family members can access their active family's event_people"
on public.event_people for all to authenticated
using (exists (select 1 from public.events e where e.id = event_people.event_id and is_active_family_member(e.family_id)))
with check (exists (select 1 from public.events e where e.id = event_people.event_id and is_active_family_member(e.family_id)));

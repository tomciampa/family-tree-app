-- Stage 0: scope every RLS policy to family membership.
--
-- Every table previously had exactly one blanket policy —
-- "logged in users can do everything on <table>", USING/WITH CHECK
-- (auth.role() = 'authenticated') — meaning any authenticated user, in
-- any family, could read and write every row in every table. This
-- replaces each of those with a policy scoped to real family_members
-- rows, via a shared is_family_member() helper.
--
-- is_family_member() is SECURITY DEFINER so it bypasses RLS on
-- family_members while evaluating — this is the standard Supabase
-- pattern for a membership check used inside that same membership
-- table's own policy (see family_members' policy below), and avoids the
-- planner re-resolving the same subquery once per row per table.
create or replace function public.is_family_member(target_family_id uuid)
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
  );
$$;

grant execute on function public.is_family_member(uuid) to authenticated;

-- Every policy on family_members itself is evaluated through
-- is_family_member() too, not a bespoke rule — a user can read/update
-- rows in a family they already have a family_members row in, and
-- (deliberately, per Stage 0 scope) can never INSERT a fresh row into a
-- family they aren't already a member of. There is no invite/join flow
-- yet (that's Stage 1) and none of today's real users should be
-- grandfathered in through this migration — see the "not just
-- authenticated" tables below for the same reasoning applied uniformly.
create index if not exists family_members_user_id_idx on public.family_members (user_id);

-- ---------------------------------------------------------------------
-- Tables that carry family_id directly.
-- ---------------------------------------------------------------------

drop policy if exists "logged in users can do everything on families" on public.families;
create policy "family members can access their family"
on public.families
for all
to authenticated
using (is_family_member(id))
with check (is_family_member(id));

drop policy if exists "logged in users can do everything on family_members" on public.family_members;
create policy "family members can access their family's membership rows"
on public.family_members
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

drop policy if exists "logged in users can do everything on people" on public.people;
create policy "family members can access their family's people"
on public.people
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

drop policy if exists "logged in users can do everything on unions" on public.unions;
create policy "family members can access their family's unions"
on public.unions
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

drop policy if exists "logged in users can do everything on contributors" on public.contributors;
create policy "family members can access their family's contributors"
on public.contributors
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

drop policy if exists "logged in users can do everything on facts" on public.facts;
create policy "family members can access their family's facts"
on public.facts
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

drop policy if exists "logged in users can do everything on anecdotes" on public.anecdotes;
create policy "family members can access their family's anecdotes"
on public.anecdotes
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

drop policy if exists "logged in users can do everything on documents" on public.documents;
create policy "family members can access their family's documents"
on public.documents
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

drop policy if exists "logged in users can do everything on events" on public.events;
create policy "family members can access their family's events"
on public.events
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

drop policy if exists "logged in users can do everything on photos" on public.photos;
create policy "family members can access their family's photos"
on public.photos
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

drop policy if exists "logged in users can do everything on familysearch_connection" on public.familysearch_connection;
create policy "family members can access their family's familysearch connection"
on public.familysearch_connection
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

drop policy if exists "logged in users can do everything on interview_gap_no_info" on public.interview_gap_no_info;
create policy "family members can access their family's interview gap records"
on public.interview_gap_no_info
for all
to authenticated
using (is_family_member(family_id))
with check (is_family_member(family_id));

-- ---------------------------------------------------------------------
-- Junction/child tables with no family_id of their own — scoped via a
-- join to whichever parent row carries it.
-- ---------------------------------------------------------------------

drop policy if exists "logged in users can do everything on union_children" on public.union_children;
create policy "family members can access their family's union_children"
on public.union_children
for all
to authenticated
using (
  exists (
    select 1 from public.unions u
    where u.id = union_children.union_id and is_family_member(u.family_id)
  )
)
with check (
  exists (
    select 1 from public.unions u
    where u.id = union_children.union_id and is_family_member(u.family_id)
  )
);

drop policy if exists "logged in users can do everything on document_people" on public.document_people;
create policy "family members can access their family's document_people"
on public.document_people
for all
to authenticated
using (
  exists (
    select 1 from public.documents d
    where d.id = document_people.document_id and is_family_member(d.family_id)
  )
)
with check (
  exists (
    select 1 from public.documents d
    where d.id = document_people.document_id and is_family_member(d.family_id)
  )
);

drop policy if exists "logged in users can do everything on photo_tags" on public.photo_tags;
create policy "family members can access their family's photo_tags"
on public.photo_tags
for all
to authenticated
using (
  exists (
    select 1 from public.photos p
    where p.id = photo_tags.photo_id and is_family_member(p.family_id)
  )
)
with check (
  exists (
    select 1 from public.photos p
    where p.id = photo_tags.photo_id and is_family_member(p.family_id)
  )
);

drop policy if exists "logged in users can do everything on event_people" on public.event_people;
create policy "family members can access their family's event_people"
on public.event_people
for all
to authenticated
using (
  exists (
    select 1 from public.events e
    where e.id = event_people.event_id and is_family_member(e.family_id)
  )
)
with check (
  exists (
    select 1 from public.events e
    where e.id = event_people.event_id and is_family_member(e.family_id)
  )
);

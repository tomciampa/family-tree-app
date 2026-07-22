-- "Which person in the tree is this logged-in user?" — settled at
-- /settings via "This is me". Nullable: leaving it unset (never having
-- opened Settings, or explicitly choosing "I'm not in the tree yet") must
-- never break anything that reads it. ON DELETE SET NULL rather than
-- CASCADE — family_members doesn't own the person, deleting that person
-- from the tree should just unlink, not remove the membership.
alter table family_members
  add column linked_person_id uuid references people(id) on delete set null;

-- family_members had zero policies despite RLS being enabled, so no
-- authenticated user could read or write it at all — nothing queried this
-- table before now. Same single-family-trust pattern already used on
-- people/unions/etc. ("logged in users can do everything on <table>").
create policy "logged in users can do everything on family_members"
  on family_members
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

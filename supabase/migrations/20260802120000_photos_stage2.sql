-- Photos Stage 2: enforce that a photo_tags row can never cross a family
-- boundary. Nothing prevented this before — photo_tags' own RLS only
-- checks the caller is an active member of the *photo's* family, never
-- that person_id itself belongs to that same family (a user in more than
-- one family, a stale picker, or a future bug could otherwise tag a
-- photo with someone from an entirely different family, silently). A
-- plain CHECK constraint can't reference another table, so this needs a
-- trigger — matches this app's existing preference for enforcing real
-- invariants at the DB layer rather than trusting the UI alone (see the
-- x_position/y_position range checks from Stage 1).
create or replace function public.enforce_photo_tag_same_family()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  photo_family_id uuid;
  person_family_id uuid;
begin
  select family_id into photo_family_id from photos where id = new.photo_id;
  select family_id into person_family_id from people where id = new.person_id;

  if photo_family_id is null or person_family_id is null then
    raise exception 'photo_tags: photo or person not found';
  end if;

  if photo_family_id <> person_family_id then
    raise exception 'photo_tags: person must belong to the same family as the photo';
  end if;

  return new;
end;
$$;

create trigger photo_tags_same_family_check
  before insert or update on public.photo_tags
  for each row
  execute function public.enforce_photo_tag_same_family();

-- A LIMIT 10 turned out to actively hide the correct match in families
-- with several same-surname people: enough weak false-positive matches
-- (shared surname trigrams) can outscore the real match and push it out
-- of the top 10 entirely. At this scale (~70 people per family) there's
-- no real need to limit — let the caller's classification logic see
-- everything above the floor.
create or replace function match_people_by_name(
  search_name text,
  target_family_id uuid,
  min_similarity real default 0.2
)
returns table (
  id uuid,
  name text,
  birth_estimate text,
  death_estimate text,
  similarity real
)
language sql
stable
as $$
  select p.id, p.name, p.birth_estimate, p.death_estimate,
         similarity(p.name, search_name) as similarity
  from people p
  where p.family_id = target_family_id
    and similarity(p.name, search_name) >= min_similarity
  order by similarity desc
  limit 50;
$$;

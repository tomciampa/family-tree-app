-- Fuzzy name matching for document-candidate-to-person matching (stage 3).
create extension if not exists pg_trgm;

-- Exposed as an RPC since PostgREST filters can't call similarity()
-- directly. Scoped to one family; returns anyone above min_similarity,
-- highest first, for the caller to classify (single high-confidence match,
-- multiple possible matches, or none).
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
  limit 10;
$$;

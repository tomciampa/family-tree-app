-- Standardized identity fields for the dossier's Facts tab. All nullable
-- and additive — the existing `name` column is untouched and keeps being
-- used everywhere it already is (tree cards, search, etc).
alter table people
  add column first_name text,
  add column preferred_name text,
  add column last_name text,
  add column married_name text,
  add column gender text,
  add column aliases text;

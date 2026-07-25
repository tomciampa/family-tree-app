-- Persists a segment's extraction/match failure so it's durably
-- distinguishable from "never attempted" — candidate_people staying null
-- looked identical either way, which made a real auto-chain concurrency
-- failure (investigated 2026-07-24: 5 of 6 segments in a fresh interview
-- silently never got extracted) impossible to diagnose after the fact —
-- no error was ever visible once the page reloaded and the ephemeral
-- client-side error state was gone. Cleared back to null on any
-- subsequent successful extraction/match write for the same segment.
alter table public.documents
  add column extraction_error text;

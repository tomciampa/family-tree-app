-- Holds AI-extracted candidate people mentioned in a document (name +
-- whatever context might help disambiguate/match them later: their
-- relation to the document's subject, any dates, other notes like a
-- patronymic). This is proposal data only, not a link to a real person —
-- matching candidates against actual people in the tree is a later stage.
-- An array of { name, relation, dates, note } objects, all string | null
-- except name.
alter table public.documents
  add column candidate_people jsonb;

-- A short, human-readable category ("Death Certificate", "Letter",
-- "Funeral Card", etc.) for the document viewer modal's prominent type
-- label. Nullable and lazily populated — classified once via the AI
-- Gateway the first time a document is opened in the viewer, then cached
-- here so it isn't re-classified on every subsequent view.
alter table documents
  add column kind text;

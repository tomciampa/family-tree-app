-- Sources an anecdote back to the specific document (e.g. an interview
-- segment, or in the future a letter/document) it was drawn from — mirrors
-- facts.document_id exactly, which anecdotes have lacked since day one.
alter table public.anecdotes
  add column document_id uuid references public.documents(id) on delete set null;

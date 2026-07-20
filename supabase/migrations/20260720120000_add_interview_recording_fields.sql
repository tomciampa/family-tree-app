-- Audio interview support (Stage 1: recording and saving only, no
-- transcription/segmentation yet). A "session" is one documents row for
-- the raw recording, with interviewee_person_id set. Later stages will
-- split a session's transcript into topical segments — each segment will
-- be its own documents row pointing back at the session via
-- parent_document_id, with audio_start_seconds/audio_end_seconds marking
-- its slice of the session's audio. Both nullable now since nothing
-- creates segments yet.
alter table public.documents
  add column parent_document_id uuid references public.documents(id) on delete cascade,
  add column audio_start_seconds numeric,
  add column audio_end_seconds numeric,
  add column interviewee_person_id uuid references public.people(id) on delete set null;

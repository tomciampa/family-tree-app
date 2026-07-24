-- A short, AI-generated one-line summary of what an interview session
-- actually covered (e.g. "Conversation with Jeff Ciampa about his immediate
-- family"), shown by default on /interviews so a recording doesn't have to
-- be expanded just to see roughly what's in it. Only meaningful on parent
-- interview session rows (interviewee_person_id set, parent_document_id
-- null) — segments never get one. Generated once from the segments' Q&A
-- transcripts (see generateInterviewSummary in interviews/actions.ts) and
-- cached here, same pattern as transcription_raw.
alter table public.documents
  add column interview_summary text;

-- The exact prompt text actually spoken/shown for an interview segment
-- (see createInterviewSegments in interviews/actions.ts). Stage 1-3's
-- gap-aware prompts are generated per-session and per-interviewee, so
-- unlike the original fixed INTERVIEW_PROMPTS, a segment's "kind" label
-- (e.g. "Hugo (Maternal Grandfather)") no longer reliably maps back to a
-- known prompt via a static lookup by label. Storing the real prompt text
-- directly on the segment row lets transcribeInterviewSegments and
-- extractCandidatesFromSegment read it straight from the row instead,
-- regardless of whether this segment used a fixed or gap-based prompt.
-- Nullable: segments created before this column existed simply fall back
-- to the old static-lookup-by-label behavior (see formatSegmentTranscript).
alter table public.documents
  add column prompt_text text;

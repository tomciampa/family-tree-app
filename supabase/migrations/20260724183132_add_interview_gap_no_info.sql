-- Stage 5: which real gap-based person a given interview segment was
-- actually about — set at session-prompt time (see buildGapAwarePrompts /
-- record-interview-flow.tsx), read back after transcription to know which
-- specific person to mark in interview_gap_no_info below. Nullable — a
-- fixed-prompt segment (Parents/Grandparents/etc, or any segment recorded
-- before this existed) simply isn't about one specific gap person.
alter table public.documents
  add column gap_person_id uuid references public.people(id) on delete set null;

-- Records that a specific interviewee, when specifically asked about a
-- specific relative, gave no real information (an "I don't know" or
-- equivalent — see the AI-judged detection in transcribeInterviewSegments).
-- Deliberately narrow: this is a per-(interviewee, gap person) pair, never
-- global. It must never be read as "this gap is resolved" — a different
-- relative can and should still be asked about the exact same
-- under-documented person in their own future interview; only the exact
-- interviewee named here is ever skipped for the exact gap person named
-- here (see the exclusion filter in lib/gap-analysis.ts).
create table public.interview_gap_no_info (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references public.families(id) on delete cascade,
  interviewee_person_id uuid not null references public.people(id) on delete cascade,
  gap_person_id uuid not null references public.people(id) on delete cascade,
  segment_document_id uuid references public.documents(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (interviewee_person_id, gap_person_id)
);

alter table public.interview_gap_no_info enable row level security;

-- Same simple "any authenticated user" access pattern already used on
-- every other table in this single-family app.
create policy "logged in users can do everything on interview_gap_no_info"
on public.interview_gap_no_info
for all
to authenticated
using (auth.role() = 'authenticated')
with check (auth.role() = 'authenticated');

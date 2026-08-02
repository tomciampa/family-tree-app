@AGENTS.md

# Family Tree App — Project Context

## Stack
- Next.js (App Router) + Supabase (Postgres, Auth, Storage) + Vercel
- Tree UI: `family-chart` (github.com/donatso/family-chart) — chosen deliberately over a
  hand-rolled renderer after repeated generational-alignment and multi-marriage bugs in an
  earlier custom implementation. Don't rebuild layout logic by hand; check family-chart's
  docs/source first (https://donatso.github.io/family-chart/) before assuming something
  needs custom code.

## Data model (see schema.sql / migrations)
- `people`, `unions` (parent1_id, parent2_id), `union_children` — a union can have 0-2
  parents and any number of children (siblings supported).
- `facts` — sourced claims about a person. Every fact has `source_type`
  (firsthand/secondhand/document/letter/chart/conflict) and a `source_ref`. Facts are
  append-only / never silently overwritten — conflicting info from different sources is
  preserved, not resolved automatically (e.g. a real spelling conflict: "Martinghetti" per
  family chart vs. "Martignetti" per an Italian death certificate — both are kept).
- `anecdotes` — freeform stories, attributed to who told them.
- `documents` / `document_people` — uploaded source files (certificates, letters, funeral
  cards), linked to the people they mention. Has a `status` column
  (pending_match/matched/no_match).
- `families` / `family_members` — multi-family seam added early, on purpose, while tables
  were empty (cheap then, expensive to retrofit later). No longer single-family only — see
  "Multi-User / Multi-Family" below for the full invite/create/fork/switch system built on
  top of this seam. Any new write still just needs the current family_id, via `getFamilyId()`.

## Document pipeline (all 4 stages built and verified on real data)
Upload (`/documents`, decoupled from any person) → AI extraction via Vercel AI Gateway
(classifies FAMILY vs ADMINISTRATIVE roles, e.g. correctly excludes a certificate's
registrar/notary from family-matching) → relationship-aware fuzzy matching against existing
`people` (uses real recorded relationships in `unions`/`union_children` as a much stronger
signal than name-string similarity alone — this was a real, verified fix; pure name matching
confused unrelated same-named people) → manual confirm/reject review queue before anything
writes to `facts`/`document_people`. Never auto-write a match without human confirmation.
The relationship signal covers spouse/parent/child and siblings (shared-parent detection via
`union_children`) — this matcher (`matchFamilyCandidates` in `documents/actions.ts`) is shared
between document extraction and interview extraction, not duplicated per pipeline.

As of 2026-07-24, Extract → Match auto-chains immediately after upload — no manual clicks
needed for the normal flow. `documents-view.tsx` just calls the existing
`extractCandidatesFromDocument` then (if any family candidates came back)
`matchCandidatesForDocument` actions in sequence right after `uploadDocument` succeeds,
showing a "Processing…" pill (with a spinner) for the few real seconds this takes — two
sequential AI Gateway calls. Deliberately no new job/queue infrastructure, just chaining the
same actions the manual buttons already called. Those buttons (Extract/Re-extract, Match)
remain, now as fallback/retry only — e.g. if extraction fails on an unsupported file type,
that same clear error state surfaces and the manual buttons are still there to retry. See
"Deletion (documents & interviews)" below for the delete button added alongside them.

Document review workspace (`documents/[id]/document-review.tsx`): the embedded tree preview
pane uses its own shallower ancestry depth (`ancestryDepth={1}`) than the main `/tree` page's
default (`DEFAULT_ANCESTRY_DEPTH = 2` in `family-tree.tsx`) — enough to see immediate context
around a candidate without the full page's deeper default rendering. It also supports directly
confirming whoever the pane is currently centered on as the match ("Use [Name] as match for
'[candidate]'"), calling the exact same `confirmCandidateMatch` action the resolution pane's own
radio-button Confirm button uses — an alternate path to one write, not a second one.

Relationship-signal matching notes (`applyRelationshipSignal` in `documents/actions.ts`):
- A manually-confirmed match (via the search override, for a candidate the matcher could never
  resolve by name — e.g. a document that only ever calls its subject "Grandpa") now counts as a
  valid anchor for boosting other candidates in the same document, and takes priority over an
  algorithmic match when picking the main anchor. It didn't originally — re-matching after a
  manual confirmation used to be a no-op for the document's remaining candidates, since the
  anchor search only looked at algorithmic `high_confidence` matches.
- `classifyRelationType` must correctly distinguish grandparent/grandchild relations from
  parent/child, not lump them together. A past bug matched "grandmother"/"grandfather" as
  "mother"/"father" via a careless substring check (`/father|mother|parent/` matches the
  "mother" inside "grandmother"), silently checking one generation too shallow — the
  grandparent-specific regex must run first.
- A genuinely wrong fact was once written to real data from a bad manual match (a "Mother" fact
  landed on the actual father, from a misclick during manual review) — manual confirmations
  deserve the same scrutiny as automated ones, not more trust by default just because a human
  clicked it.
- This tree has real name collisions — e.g. 3 different people all named "Anthony Ciampa" (a
  grandfather, and a grandson later named after him, plus an unrelated third). Always resolve a
  specific person by relationship/`personId`, never by name string alone — this matters most for
  anything that persists state per-person (e.g. gap-tracking, see Audio Interview architecture
  below), where a name-based mixup would silently misattribute state to the wrong actual person.

## File-type handling pattern
A registry-based approach — one `Record<mimeType, ...>` map, one entry per supported type — is
the established convention for handling different file types, now used in two places:
`TEXT_EXTRACTORS` in `document-text-extraction.ts` (turns a non-image file's bytes into
extractable text — e.g. `.docx` via the `mammoth` package, which unzips the file and pulls the
actual paragraph text out of its XML parts) and `documentTypeLabel` in `documents.ts` (a
human-readable badge label for a document's MIME type). Adding a new supported type means
adding one entry, not a new parallel special-case branch wherever that type needs handling.

Unsupported/unmapped types should always fail *clearly* — a visible error message — rather than
silently producing an empty or broken state. This was a real bug once: an uploaded `.docx`'s
raw bytes, decoded as if they were plain text, produced mostly null bytes; the model
"successfully" transcribed that as nothing, leaving `candidate_people` at `[]` with no error
anywhere — which silently hid the entire review-matches UI (see `hasFamilyCandidates` in
`documents-view.tsx`) rather than showing anything was wrong. `hasTextExtractor`/
`isVisionCapable` are now checked *before* ever downloading the file, so an unsupported type
fails fast with a real error instead.

## Standard field names (Vital Details)
`STANDARD_FIELD_LABELS`/`STANDARD_FIELD_LABEL` (`tree/constants.ts`) is the single canonical
source for the seven Vital Details fields (Birth Date, Birth Place, Death Date, Death Place,
Cause of Death, Occupation, Places Lived) that `person-identity.tsx`'s `findFactValue` looks up
by exact (case-insensitive) match. Before this existed, document extraction's
`factFieldForRelation` and interview extraction's freeform fact schema each independently
guessed at these label strings — they only agreed by coincidence (e.g. Matt Ciampa's
"Occupation" fact matched by luck, but his interview-derived birth date was written as "Birth"
rather than "Birth Date" and silently never appeared in Vital Details, even though the fact was
real and fully confirmed). Both writers now import from this registry instead of hardcoding
their own guess. Interview extraction's fact schema also now explicitly splits a single
statement that bundles more than one standard field (e.g. "born in Portsmouth, New Hampshire on
December 14, 1987") into separate fact entries — one Birth Date, one Birth Place — rather than
merging them under one field. Any future extraction/writing code touching these seven fields
must use this shared registry, not a new independent guess.

A one-time backfill (2026-07-25) corrected 17 existing facts across 11 people that predated this
fix, using the same AI-based standard-field extraction already used by the dossier's manual
"Parse into standardized fields" tool. Deliberately conservative: it only ever adds a new
canonical fact (never mutates/deletes the original, matching facts' append-only convention), and
skips a person entirely for a given canonical field if they already have one from any source —
this correctly left Vincenzo Ciampa untouched, since his birth/death/occupation facts had
already been fixed by hand via the manual Parse tool before this backfill ran.

## Tree rendering approach (settled after 3 rounds of real bugs — don't rebuild from scratch)
`family-chart` natively renders only the "main" (focused) person's full blood-line ancestry,
uncollapsible, plus their siblings (`setShowSiblingsOfMain(true)`, `setAncestryDepth(1)` so
deeper ancestry doesn't auto-render). A separate supplementary overlay handles expanding
either parent's own ancestor chain independently and simultaneously (tracked as a Set, so
father's and mother's sides can both be open at once) — this is what lets you see e.g. both
Bob's parents and Peggy's parents expanded together without one collapsing the other.
Important edge case already fixed once: before drawing an overlay card for a parent, check
whether that person is already natively rendered elsewhere in the current view (main's blood
line, or another already-expanded overlay) — otherwise you get a duplicate card drawn on top
of the real one. Also watch for two separately-expanded overlays sharing a common ancestor
(same duplicate risk). The ▲/▼ toggle only appears on immediate-parent cards, not main or
siblings. As of 2026-07-25, clicking any card's body recenters the tree on that person — not
just siblings. (Siblings-only was a deliberate 2026-07-12 trade-off; later found to be an
unwanted restriction rather than an intended limit, and removed. If you find another note
elsewhere describing sibling-only recentering as current behavior, it's stale — update it too.)

Double-clicking a card opens its dossier — a separate mechanism from the single-click recenter
above, distinguished via a timed click handler rather than a native `dblclick` listener (see
`pendingCardClickRef` in `family-tree.tsx`). As of 2026-07-25, this double-click no longer also
zooms the tree: family-chart binds d3-zoom's full default listener set onto its canvas with no
opt-out, including `dblclick.zoom` (zoom-in-on-double-click) — a completely separate mechanism
from the click handler above, but the real browser `dblclick` event still bubbled to it
regardless, so opening the dossier via double-click also zoomed the canvas in on top of it.
There's no fluent Chart API to opt out of this, so it's blocked with a capture-phase `dblclick`
listener on the app's own container that stops the event before it reaches d3's bubble-phase
listener — applied everywhere on the canvas, not just cards, since double-click-to-zoom isn't a
documented feature anything here relies on and the app already has a dedicated fit-to-screen
button.

## Design
The redesign to a clean, Apple-inspired light/neutral aesthetic — whites and light grays, dark
neutral text, a blue accent for primary actions/links, soft layered shadows, generous rounded
corners — is **complete**. It fully replaced the earlier "archival paper" direction (warm
cream/parchment, sepia/ledger-green accents). Don't reintroduce cream/parchment/sepia tones
thinking you're honoring a still-current preference — that palette is gone on purpose, not
missed.

One exception found after this note was originally written (and since fixed, 2026-07-22):
`FactList`/`DocumentList` (`fact-list.tsx`/`document-list.tsx`) keep an unused `archival` theme
variant alongside `plain`/`neutral` — dead code, never selected by any caller, kept on purpose
per its own comment in case the parchment look is wanted again — but it still had the old
palette's literal hex values (`#efe6d2`, `#c9b896`, `#6b5c45`, `#a97b52`) hardcoded rather than
referencing tokens. Converted to reference the same tokens `neutral` uses, so no raw archival
hex remains anywhere in the app even though the (still-unused) `archival` variant name and
structure are kept. If you find more of these, they're leftover pre-redesign literals, not an
intentional exception — convert them the same way.

As of 2026-07-23, the redesign covers every surface — including the home page (three primary
action cards for View Family Tree / Record a Memory / Upload a Document, plus a Supabase-style
collapsible icon sidebar for secondary links: hover or keyboard focus expands it on desktop,
always-expanded as a plain list on mobile touch devices since hover doesn't exist there) and
the dossier/PersonPanel/DocumentViewerModal noted below.

The app also has full dark-mode support that follows system preference — built into
`design-tokens.css` from Stage 1 (a complete separate palette: near-black page background,
layered dark surfaces, brightened accent/system colors), not a stale leftover of the old
archival theme. This is intentional, not a bug: if a page reads as "dark," check the viewer's
OS/browser color-scheme setting before assuming a regression or a stale deployment — this
already caused one real moment of confusion mid-session.

`src/app/design-tokens.css` is the source of truth: a full token system (color, typography,
spacing, radius, elevation, motion) as namespaced CSS custom properties (`--color-*`,
`--font-*`, `--space-*`, `--radius-*`, `--shadow-*`, `--duration-*`/`--ease-*`). Every surface
now uses these tokens — tree, dossier, PersonPanel, DocumentViewerModal, the documents/
interviews list pages, and their 3-pane review workspaces. Use these tokens rather than
inventing new colors, spacing, or shadow values ad hoc. If touching tree UI colors, go through
family-chart's own theming API (CSS custom properties, not ad hoc per-element overrides)
pointed at these tokens, not new one-off hex values.

The underlying reasoning hasn't changed even though the palette has: primary users include
elderly, non-technical family members, so legibility and clarity take priority over
trendiness within the palette.

Conventions established during the rollout, worth following for any new surface:
- Reuse the `neutral` theme variant already built into `FactList`/`AnecdoteList`/`DocumentList`
  (see `fact-list.tsx`) rather than writing new one-off styling for facts/stories/documents
  lists — that's what it's there for.
- Status pills (`pending_match`/`matched`/`no_match`, `high_confidence`/`multiple_matches`/
  `no_match`, etc.) map onto the semantic `--color-warning-*`/`--color-success-*` tokens (and
  `--color-bg-surface-alt`/`--color-text-secondary` for the neutral/no-match case) — that's
  their intended use case, not a one-off choice.
- Verify a visual-only change via `git diff`: every changed line should be a className/style
  value, never a handler, state, or prop change. When a change sits near an action that writes
  real data (starting/stopping a recording, confirming a batch match) and no disposable test
  account exists to safely trigger it live, verify via that same diff — that the handler itself
  is byte-for-byte untouched — rather than actually triggering the action against real data.

## Audio Interview architecture (fully built: 3-phase UI refresh + 5-stage gap-aware prompting)
Interview recordings and their per-question segments are stored as rows in the same
`documents` table used for uploaded certificates/letters — not a separate table — tagged via
`interviewee_person_id` (the parent recording) and `parent_document_id` (each segment). This
was a deliberate Stage 1 choice to reuse existing storage/RLS/schema rather than add a parallel
model, but it already caused a real bug once: the `/documents` list page didn't exclude
interview rows, and an interview segment's `candidate_people` is shaped as an `{ facts, people,
anecdotes }` extraction object rather than the `CandidatePerson[]` the documents page expects —
crashing the page the moment an interview row reached it (fixed by filtering on
`interviewee_person_id`/`parent_document_id` being null). Any new query against `documents`
that isn't interview-aware should filter these out explicitly. Flagged as a candidate for
splitting into its own table/model if this keeps causing friction.

Structural note worth remembering: it's the **segments** (child `documents` rows via
`parent_document_id`), not the parent session row, that actually own `document_people`/
`facts`/`anecdotes` links and `interview_gap_no_info` rows — `confirmInterviewBatch` always
sources writes to `document_id: segment.id`, never the parent session's. Any code operating on
"this interview's linked data" (deletion, impact-checking, dashboards, etc.) has to traverse
via segment ids, not the parent session id, or it'll silently find nothing.

As of 2026-07-24, Transcribe → Extract → Match auto-chains after Stop Recording — same pattern
as the document pipeline above, no new job/queue infrastructure, just calling the existing
`transcribeInterviewSegments` (session-level, batch) then per-segment
`extractCandidatesFromSegment`/`matchCandidatesForSegment` in sequence. `interviews-view.tsx`
auto-expands the freshly-recorded session so the person who just stopped recording can
actually watch it happen, with a "Processing…" state shown at both the session level (still
transcribing) and per-segment (that segment's own extract/match still running). Manual
Transcribe/Extract/Match buttons remain as fallback/retry only. Fixed one real bug building
this: the "Review & confirm →" link's `hasExtraction` check was derived from `InterviewItem`'s
own `segments` state, but only each `SegmentPanel` child ever learned about its own new
extraction result — that never flowed back up, so the link could stay hidden even after
extraction genuinely finished. Segments now report extraction status upward via a callback
(mirrors how per-segment "still processing" status is reported upward too) instead of the
parent silently trusting stale local state.

Transcription uses `openai/whisper-1` specifically, not `gpt-4o-transcribe` or
`gpt-4o-mini-transcribe` — the newer models are more accurate but silently return no timestamps
at all when timestamp granularities are requested, and word-level timestamps are what's needed
to slice one continuous session recording into its per-question segments. See the comment in
`interviews/actions.ts` above the transcription calls before changing the model.

Batch confirmation (`confirmInterviewBatch`) is idempotent — already-resolved people and
already-written facts/anecdotes are tracked via `resolution`/`written` markers persisted back
onto each segment's own `candidate_people`, so re-running it (e.g. after extracting a segment
added later) never duplicates data.

Real incident (found and fixed 2026-07-25): `transcribeInterviewSegments` writes every
segment's transcript in one batch update, and each `SegmentPanel`'s auto-extract effect fired
the moment its own transcript appeared — so a batch update fired every segment's
`extractCandidatesFromSegment` concurrently, a thundering herd against the AI Gateway. Only
the first request reliably succeeded; the rest silently never completed, with nothing to show
for it since failures only ever lived in ephemeral React state — indistinguishable from "never
attempted" the moment the page reloaded, which cost real time to diagnose (see "Working
conventions" below for the general lesson). Fixed two ways: `InterviewItem` now owns a serial
queue (`autoQueue`/`activeAutoSegmentId`) so only one segment's extract→match chain runs at a
time, advancing only once the current one genuinely settles (success or failure); and
`documents.extraction_error` persists a failure durably, surfaced as a visible "Extraction
failed — Retry" state that survives a reload, instead of only `error` component state.

### Narration (Phase 1)
Interview prompts are read aloud via the browser's built-in `SpeechSynthesis` API.
`lib/speech-voices.ts` explicitly resolves and sets a voice every time — investigated real
`getVoices()` output first (properly handling that the list loads asynchronously via the
`voiceschanged` event) rather than guessing a name from memory or leaving `utterance.voice`
unset and hoping the device's own default sounds good. Recording is deliberately deferred until
narration finishes speaking — reuses one `pause()`/`resume()` mechanism everywhere a prompt gets
(re)spoken (advancing to the next question, repeating the current one, and the manual Pause
button all go through the same path, not separate ad hoc timing). Fully user-configurable: a
Settings-level default (`family_members.narration_enabled`, `family_members.interview_voice_uri`)
plus a visible session-local override checkbox right on the recording screen that deliberately
does **not** write back to that saved default — the person actually being interviewed is often
not the account holder, so a one-off in-session change shouldn't silently change their settings.

### Segment boundary precision
Segment boundaries are stored from a separate `performance.now()`-based precise clock — **not**
the once-per-second integer state driving the on-screen `0:00` timer display. Conflating the two
caused a real bug: a boundary could land up to ~999ms off from the true click instant, which was
enough to misattribute a word to the wrong segment at a transition even though
`pause()`/`resume()` themselves fire right on time (confirmed by directly measuring
`MediaRecorder.pause()`/`resume()` latency against a known audio signal, not just reasoning about
it). Never read the display timer's value as a boundary; always read the precise clock.

### Transcripts (Phase 2)
Each segment's transcript is stored as `Q: <prompt>\nA: <answer>` — the question text is always
the actual known prompt (the fixed list in `prompts.ts`, or an AI-generated gap-based prompt —
see below), never inferred from the audio itself. Extraction (`extractCandidatesFromSegment`)
strips the `Q: ` prefix back off before analysis, so it only ever mines the answer for
facts/anecdotes/people, never the question text.

### /interviews list (Phase 3)
Each recording is collapsed by default, showing a short AI-generated one-line summary (e.g.
"Conversation with Jeff Ciampa about his family history...") instead of the full player up
front — cached on `documents.interview_summary`, generated once and auto-backfilled the first
time an already-fully-transcribed interview (old or new) renders with none yet. Expanding
reveals the complete existing audio player + segment transcripts, unchanged.

### Gap-aware prompting (`lib/gap-analysis.ts`, `lib/genealogical-distance.ts`, `lib/gap-prompts.ts`)
Before generating a session's prompts, `findGaps(personId)` analyzes the interviewee and their
close relatives (parents, grandparents, siblings, spouse, children) for what's genuinely
missing, then `genealogicalDistance` ranks candidates by hop-count over the same
relationship-graph helpers the relationship-signal matcher itself uses
(`lib/relationship-graph.ts`, extracted out so both share one implementation rather than a
second traversal). This is a **weighted** shortest path (parent/child/spouse = 1 hop,
sibling/grandparent/grandchild = 2, since those are already two-edge compositions) via Dijkstra,
not plain BFS — mixed edge weights need shortest-first expansion, not FIFO order, or a longer
chain can get finalized before a shorter direct edge is even considered. Ranking sorts severity
tier first, distance only as a tiebreaker within a tier — by construction, not a blended score,
so a major gap two hops away always outranks a trivial gap one hop away regardless of how any
blend constant might be tuned.

Two categories of gap, with genuinely different closing rules:
- **Structural/factual** (birth date, death date, occupation, birthplace) — one ground truth.
  Closes for good the moment *anyone's* fact records it, regardless of who.
- **Subjective/anecdotal** (personality, memories, stories — including the `anecdotes` table) —
  multiple people's perspectives are all independently valuable. One person's account does
  *not* close this the way one occupation fact does; severity only softens gradually as more
  accounts accumulate (real but gradual diminishing returns), never a hard "resolved" flag.

When an interviewee gives no real information about a specific gap-person — an AI-judged
"I don't know", extending the exact same judgment already used for a literally-empty answer —
that's recorded in `interview_gap_no_info`, narrowly scoped to **exactly** that
(interviewee, gap-person) pair, by real `personId` rather than name (see the "Anthony Ciampa"
name-collision note above — this is exactly the kind of per-person state a name mixup would
corrupt). This must never suppress the gap globally or for a different relative's own future
interview — verified live: marking one interviewee's "no info" about a grandmother correctly
excluded that grandmother from their own next session, while a different, genealogically-close
sibling's session still included her normally.

Whenever there are no real (major/critical) gaps for an interviewee — a first interview with no
data yet, or a genuinely well-documented family — session generation falls back to the original
fixed 6 prompts, completely unchanged (verified byte-for-byte identical against the fixed list,
not just "close enough"). The feature can only ever add value on top of today's interview,
never produce a worse or emptier one.

### Segment context in the document/source viewer modal
As of 2026-07-25, `DocumentViewerModal` shows real interview context for a source that's an
interview segment (has `parent_document_id`), instead of the raw internal `kind` label (e.g.
"MATT CIAMPA (SIBLING)"). Built deterministically from data already on hand — the parent
session's real `interviewee_person_id` → name and `recorded_at`, plus the segment's own `kind`
— rather than a new AI call: `lib/interview-topic.ts` maps the 6 fixed prompt topics (Parents,
Grandparents, Siblings, Spouse, Children, Closing thoughts) to natural phrases via a small
registry (same pattern as `documentTypeLabel`), with a "about Name (relation)" fallback for
gap-based segment labels, e.g. "7/24 interview with Thomas Ciampa — about Matt Ciampa (their
sibling)". Uses "their" rather than "his"/"her" — consistent with there being no gender data
anywhere in this app (see the Suggested Connections note below). Regular (non-interview)
documents are unaffected: same AI-classified `kind` badge and filename caption as before.

## Deletion (documents & interviews)
Both pipelines support deleting an item — `/documents`/`documents/[id]` and
`/interviews`/`interviews/[id]` all have a Delete button. One shared dialog component,
`DeleteWithImpactButton` (`src/components/delete-with-impact-button.tsx`), backs all of them;
`DeleteDocumentButton`/`DeleteInterviewButton` are thin pipeline-specific wrappers that just
supply their own impact-check/delete server actions and dialog title, not parallel copies of
the dialog itself.

Two-tier warning, always the same shape: a plain "This cannot be undone" shown every time, plus
a visually distinct (bold text, red border, red-tinted background — not just longer text in the
same style) escalated warning naming exact linked fact/anecdote counts and person names,
rendered only when `getDocumentDeleteImpact`/`getInterviewDeleteImpact` finds real linked data.
An empty/unprocessed item only ever shows the standard warning. Impact is fetched fresh every
time the dialog opens rather than trusted from a stale prop, since resolving a candidate can
create new facts/anecdotes right up until the moment of deletion.

Deletes cascade in dependency order, investigated from the real schema rather than assumed —
this differs between the two pipelines specifically because of the segment-ownership note
above:
- Documents: `facts` → `anecdotes` → `document_people` → the document row → the Storage file.
- Interviews (`deleteInterview` in `interviews/actions.ts`): `facts` → `anecdotes` →
  `document_people` → `interview_gap_no_info` → segment rows → the parent session row → the
  Storage file — all of the first four keyed by segment ids, not the session id. The session
  and every one of its segments share one Storage object (segments are just labeled
  time-ranges of the same recording, see "Segment boundary precision" above), so it's removed
  once at the end, not once per segment.

In both pipelines the Storage file is removed *last*, after every DB row is gone — a failure
there just leaves a harmless orphaned blob, not a document row pointing at a file that no
longer exists. Deleting an interview never touches the interviewee's own `people` row (a
person can have other interviews/documents/facts unrelated to the one being deleted) — if a
test/placeholder person genuinely has nothing else linked after their interview is deleted,
that's a separate manual step via the tree's own person-delete UI (`deletePerson` in
`tree/actions.ts`, exposed on a loose person's card in the "Not yet connected to the tree"
list), not something the interview delete cascades into automatically.

## Email-based upload intake
Family members can email photos/documents straight into the app: each family gets a unique
upload address (`families.email_upload_token`, shown in Settings), a Cloudflare Email Worker
(`cloudflare-worker/email-intake.ts`) parses the inbound email and POSTs a shared JSON shape to
`/api/email-intake` (`route.ts`), authenticated by a shared secret header plus the family token
found *in* the payload — never an `auth.users` session, since there is no browser on this path at
all (`uploaded_by` is always left null; honest provenance goes in `source`/`submitted_by_name`/
`submitted_by_email` instead — display fields only, never authentication). Image attachments
route to `photos`, everything else to `documents`, auto-chaining the same extract→match actions
the manual buttons call, exactly like the interactive upload flow.

As of 2026-08-02, an email's *body text* is also captured as its own sourced-fact record,
separate from however any attachment routes — a photo emailed in with "here's Jeff, born
November 29th" now produces both the photo AND a standalone fact candidate for Jeff's birth
date, regardless of whether an attachment was present at all. Deliberately NOT folded into the
existing document/photo tables' own workflows:
- `documents.is_email_body_note` (boolean) discriminates these rows from ordinary uploaded
  documents — same crash-risk class as interview rows (`candidate_people` shaped as
  `{people,facts,anecdotes}`, not `CandidatePerson[]`), so every plain-document query
  (`/documents` list, `documents/[id]`'s viewer, `getting-started.ts`, `admin-stats.ts`) needed
  its own explicit exclusion, not just the interview one. `documents/[id]/page.tsx` redirects to
  `/email-notes/[id]` if it lands on one by a stale link; `tree/actions.ts`'s
  `getDocumentForViewer` (the fact-source viewer modal) renders it fine — it's a real `.txt`
  file — but skips `classifyDocumentKind`'s AI call (tuned for certificates/letters, not
  emails) in favor of a fixed "Email" kind.
- New `facts.source_type` value `'email'` — not reused `'letter'`; a physically-written letter
  and an auto-parsed modern email are meaningfully different kinds of source even though both
  are prose.
- Extraction (`app/api/email-intake/email-body-extraction.ts`) is anchor-free like document
  extraction (nobody is "already known" the way an interview's interviewee is), but produces
  interview-shaped `facts[]`/`anecdotes[]` per mentioned person (field/value/confidence/quote,
  `STANDARD_FIELD_LABELS`-aware) via `makeCandidateFactSchema`/`resolveAbout`, now split out of
  `interviews/actions.ts` into `interviews/extraction-schema.ts` so both callers share them
  without duplication. The extraction prompt is given the email's own reference date (the
  `Date:` header, threaded through the Worker payload and stored on `recorded_at` — not
  webhook-receipt time) and told to resolve unambiguous relative expressions ("yesterday",
  "when he turned 40 in 2019") into absolute dates, leaving genuinely ambiguous ones ("a while
  back") unresolved rather than guessed. A resolved-relative-date fact carries a
  `dateInferenceNote` that gets folded into `source_ref` at write time (e.g. "email from Jane
  Doe, 2026-07-15 — date inferred from relative reference 'yesterday'") — `confidence` stays
  untouched, since it's purely about whether the sender hedged the claim itself, a separate
  concern.
- The webhook computes `cleanEmailBody(bodyText)` exactly once and reuses that single result for
  both the photo-caption decision and the "is there enough here to create a note at all"
  decision, so the two can never drift apart on what counts as meaningful content. A forwarded
  email whose body reduces to just a mail-client signature (e.g. "Sent from my iPhone") creates
  no note. The Worker no longer hard-rejects a zero-attachment email either — only an email with
  neither attachments nor body text bounces now, since a body-only email is genuinely useful to
  this feature.
- Its own review surface, `/email-notes/[id]` (`email-notes/actions.ts` +
  `[id]/email-note-review.tsx`), mirrors the interview review page's layout (multi-fact-per-
  person, not document-review's one-candidate-one-fact shape) rather than reusing it, and lands
  in the homepage's "Tasks pending your review" list (`getPendingReview`) alongside documents
  and interviews via the same unresolved-count convention.
- Real bug caught by live verification (not just typecheck): `confirmEmailNoteBatch` initially
  looked up resolution decisions by a `${documentId}:${index}` key copied from
  `confirmInterviewBatch`'s per-segment pattern, but the client (`email-note-review.tsx`) only
  ever sends plain `${index}` — there's just one document per review page here, no segment loop
  — so every confirmed candidate silently fell through to "skipped" with zero facts written, no
  error anywhere. Fixed by keying on plain index, matching what the client actually sends.

### Image compression: a real production incident, root-caused and fixed (2026-08-02)
The email path's photo compression (`cloudflare-worker/image-compression.ts`) had never actually
succeeded for a real >1MB photo in production, despite being described as verified — Stage 1's
verification ran `compressImage` directly in Node (confirmed via a leftover test artifact's
timestamp predating the Worker's first-ever deployment by 56 minutes), and Node has no CPU-time
or memory ceiling the way the real Workers isolate does. The first real large-photo emails
(sent during the exact-duplicate-detection work above) crashed consistently — "Exceeded CPU
Limit" or a WASM "Error: unreachable" trap — and confirmed every one of the 11 real production
email-sourced photos had always been under 1MB, meaning this code path had silently never run
for real before.

Root-caused, not guessed at: upgrading the Cloudflare account to Workers Paid (and even adding
an explicit `[limits] cpu_ms = 30000` to `wrangler.toml`) did **not** fix it — ruling out CPU
time as the actual bottleneck, since real local timing showed the whole decode+resize+encode
pipeline completing in ~1-2 seconds. The real cause, found by instrumenting the exact same code
locally with `process.memoryUsage()`: `@jsquash/resize` alone was responsible for the majority
of peak memory — resizing a decoded 1800x1400 image (already ~76MB resident after decode alone)
peaked at 214MB during the resize call itself, and a 4000x3000 image peaked over 500MB. Workers
has a **fixed 128MB isolate memory ceiling that the paid plan does not raise** (unlike CPU time,
a hard platform constant) — even modest, realistic photo dimensions were nowhere close to
fitting.

Fixed by replacing `@jsquash/resize` entirely with a small hand-written box-average downscale
(`boxDownscale` in `image-compression.ts`) operating directly on the decoded `ImageData` —
averages every source pixel under each output pixel, deliberately not a fancier interpolation
(quality is a non-goal here, see below). Allocates exactly one destination buffer instead of
whatever `@jsquash/resize`'s WASM internals were doing; measured at ~10MB of additional memory
for the same 1800x1400 case instead of 130MB+. One fewer WASM module to compile/instantiate at
Worker startup too — `initCodecs` no longer takes a `resize` module, and the package is removed
from `package.json` entirely. Real end-to-end testing after this fix (real deployed Worker, not
Node) confirmed every previously-crashing size — from 1800x1400 up to a real 4000x3000/7.3MB
file — now compresses and lands successfully.

Alongside this, `compressImage`'s old 4-attempt iterative quality/resolution search (2000px/q75
→ 2000px/q45 → 1200px/q60 → 800px/q40) was replaced with a single fixed pass — `TARGET_MAX_DIMENSION
= 1600`, `TARGET_QUALITY = 40` — since this app prioritizes "don't lose the photo" over fidelity
and there's no reason to pay for three lower-compression attempts a phone photo will essentially
never need. This didn't turn out to be the actual fix for the crash (memory, not CPU time, was),
but it's a real, worthwhile simplification kept regardless — a quarter of the worst-case work for
the same outcome.

## Exact-duplicate detection (documents & photos)
`documents`/`photos` both carry `content_hash` (SHA-256 hex) and a self-referencing
`duplicate_of_id`, set at insert time across all three upload paths (web document upload, web
photo upload, email intake) — never a trigger, since the "which existing row is the original"
lookup already needs the family scope and table context application code already has on hand.
`src/lib/content-hash.ts` (`sha256Hex`/`findDuplicateId`) is shared by the two web upload
actions and the email webhook's own insert of both; the Cloudflare Worker can't import that
module (separate bundler/runtime) so it has its own `cloudflare-worker/content-hash.ts` doing
the same SHA-256-hex computation via Web Crypto — a deterministic standard algorithm, so hashes
from either side are directly comparable.

The email path hashes an attachment's **original** bytes (`rawBytes` in
`cloudflare-worker/email-intake.ts`), before `compressImage()` ever runs, and threads that hash
through the webhook payload as `originalContentHash` — deliberately not re-hashing whatever
ends up in Storage, so a since-compressed emailed photo still matches an identical original
uploaded via the website (which never compresses). Web uploads have no compression step at all,
so hashing right before the Storage `.upload()` call is already an original-bytes hash there.

Behavior differs sharply by path, not by table: a **web** upload (document or photo) always goes
through silently regardless of a hash match — `duplicate_of_id` is set for later reference, but
never a warning or a block. An **email** upload still creates the row as normal either way, but
a match surfaces as a "possible duplicate" item in the homepage's "Tasks pending your review"
list (`getPendingReview`'s `possibleDuplicates`), linking to `/documents/[id]` (a banner added to
the existing `document-review.tsx`, next to the `DeleteDocumentButton` already there) or to the
new `/photos/compare/[id]` (photos had no per-item page at all before this — a deliberately
minimal side-by-side/stacked view: each photo's upload date, source, and submitted-by info if
emailed, no other comparison tooling, with `DeletePhotoButton` — now `redirectTo`-capable like
`DeleteDocumentButton`/`DeleteInterviewButton` — on the newer, flagged photo only).

Backfilled (2026-08-02) for the 32 pre-existing rows (13 documents, all web-sourced so never
compressed; 19 photos, 11 of them email-sourced) by downloading and hashing each row's
currently-stored bytes — spot-checked against `shasum -a 256` directly on a downloaded file to
confirm the algorithm/encoding matches exactly. This backfill has one honest, accepted
limitation: for the 11 pre-existing email-sourced photos, only the current (possibly already
compressed) bytes could be hashed — the true original bytes were never persisted anywhere and
are gone. A web upload today that's byte-identical to one of those photos' true originals won't
be caught as a duplicate against that specific old row. Historical-only and narrow (at most 11
rows, further narrowed by which were actually large enough to trigger compression); any two rows
created after this shipped always compare consistently. No further mitigation planned.

Deliberately excludes interview segments/sessions and email-body-note rows from this feature's
scope entirely — they aren't "the same file uploaded twice" candidates the way a photo or
document attachment is. Every lookup/write site scopes documents to
`interviewee_person_id`/`parent_document_id` both null and `is_email_body_note` false, same
established exclusion pattern used everywhere else this table needed it.

## Home page dashboard
`/` shows a "Tasks pending your review" section (`src/lib/pending-review.ts`) right after the
welcome header — the first thing surfaced after signing in. It reuses the exact same
`documents`/`people` queries and unresolved-candidate logic `/documents` and `/interviews`
already compute per row (`documents-view.tsx`'s `unresolvedCount`, `confirmInterviewBatch`'s
`resolution`/`written` markers) rather than a new tracking table or status column. Since both
pipelines now auto-process up to the review step (see above), anything this surfaces is
genuinely waiting on a human decision, never still mid-pipeline. Each item links straight to
its review screen (`/documents/[id]` or `/interviews/[id]`).

As of 2026-07-26, this authenticated dashboard is only what a *logged-in* visitor to `/` sees.
An anonymous visitor now gets a real public landing page instead of the old `redirect("/login")`
— three options in plain language: start a new tree from scratch (deep-links into `/login`'s
signup form via `?mode=signup`), join a family via a manually-entered invite code, or log in.
The manual code-entry piece (`src/components/join-by-code-form.tsx`) is deliberately a thin
wrapper: it extracts a code from either a bare code or a full pasted invite URL and hands off
entirely to `/join/[code]`'s existing validation (`get_invite_preview`, error states for
not-found/used/expired) — it doesn't duplicate any of that logic. That's the pattern to follow
for any future new entry point into an existing flow: route into the flow's own page rather than
reimplementing its checks. A direct `/join/[code]` link still bypasses this landing page
entirely, as before.

## Suggested Connections
`src/lib/suggested-connections.ts` resolves loose/unconnected people (most often someone
extracted from an interview with no `unions`/`union_children` row yet) into one-click "Connect"
suggestions on the tree, by walking fact-based relation chains — e.g. resolving "maternal
grandfather of Maxine" by walking from Maxine through her recorded mother's recorded father.
Conservative by construction: an unrecognized relation type, an anchor name that doesn't match
a real person, or a hop that can't be walked (a parent-role fact is missing) simply produces no
suggestion rather than a guess.

There is no gender data anywhere in this app (`people.gender` is never populated by anything) —
this resolver, like the relationship-signal matcher in the document pipeline above, relies
entirely on the "Mother"/"Father" fact field convention instead.

## Auth-to-person linking
`family_members.linked_person_id` maps a logged-in account to their own real person record in
the tree, set via `/settings` ("This is me"). `/tree` centers on this person by default when
set (see `defaultMainPersonId` in `family-tree.tsx`), falling back to the existing "most
descendants" heuristic (`pickDefaultMain`) otherwise — e.g. before the user has ever opened
Settings, or if they explicitly chose "I'm not in the tree yet."

`family_members` initially had RLS *enabled* but zero actual policies — meaning nothing could
read or write it at all, not that it was open. Nothing had queried the table before this
feature, so the gap stayed silent until this linking column actually needed real access. Worth
double-checking a real policy exists (not just RLS being turned on) on any new table going
forward, since this kind of gap fails silently rather than throwing something obviously wrong.

## Multi-User / Multi-Family (all 5 stages complete)
Building on the "Data model" note above: this app is no longer single-family only. An account
can belong to any number of families — joined via invite, created fresh, or forked from an
existing one — with exactly one marked "active" at a time.

Every table's RLS now scopes to real family membership via `is_family_member()`, not just
"authenticated" — this was a genuine security gap that got fixed, not just a feature added.
Before this work, any logged-in user could read and write every row in every table in the
database, regardless of which family it belonged to.

Critical distinction, easy to get wrong again: `is_family_member()` means "has any membership
row for this family," not "this is my active family." For the 13 real-data tables (`people`,
`unions`, `union_children`, `facts`, `anecdotes`, `documents`, `document_people`, `events`,
`event_people`, `photos`, `photo_tags`, `familysearch_connection`, `interview_gap_no_info`),
RLS instead uses a separate, stricter `is_active_family_member()` — a user belonging to two
families must only ever see their currently-active one, never both merged together in the same
query. The 3 meta tables (`families`, `family_members`, `family_invites`) deliberately keep the
broader `is_family_member()` check, since the switcher and `getFamilyId()`'s own fallback logic
need to see a user's own *inactive* membership rows too — tightening those to active-only would
make a user's other families invisible even to themselves.

`family_members.is_active` (enforced unique per user via a partial index) is the single source
of truth for which family is currently in view. `getFamilyId()` (`lib/family.ts`) reads it
directly — any new feature that needs "which family is this for" must go through
`getFamilyId()`, never assume a user has exactly one `family_members` row.

Three bootstrap RPCs — `create_family`, `redeem_family_invite`, `fork_family` — are all
`SECURITY DEFINER` for the same underlying reason: each has to insert a `families`/
`family_members` row for a family the user isn't a member of *yet*, which ordinary
`is_family_member()`-scoped RLS can never allow for a plain authenticated insert (the very row
that would grant membership doesn't exist until the insert being attempted creates it). Any
future "give this user access to a family they don't have yet" feature needs the same pattern,
not a relaxed policy.

Storage (`storage.objects`) is a *separate* access-control layer from the `public` schema — it
was missed in the initial RLS pass and had to be fixed separately, scoped by the
`${familyId}/...` path prefix upload code already used by convention but that nothing had ever
actually enforced. Any future Storage-touching feature should not assume the public-schema RLS
work automatically covers file access — check `storage.objects`'s own policies explicitly.

`fork_family()` deep-copies an entire family (people/unions/facts/anecdotes/documents/
interviews) into a fully independent new one — physically duplicated Storage files, not shared
references, with every foreign key remapped to fresh ids. Deliberately does **not** remap the
ids buried inside `documents.candidate_people` JSONB in PL/pgSQL — arbitrary nested JSON
manipulation is the wrong job for that layer. It's handled in TypeScript instead
(`lib/fork-family-remap.ts`), using old→new id maps the RPC returns. A dangling/unmappable
reference found during a fork (e.g. a candidate resolution pointing at a person or fact that no
longer exists) is dropped back to "needs review," never left half-remapped or silently corrupt.

Fork's validation of `candidate_people` was the first code ever to check those references for
staleness, and it surfaced 3 real pre-existing dangling references already sitting silently
broken in production data (a person + fact deleted at some point after extraction, with nothing
having ever re-checked the reference since) — worth remembering that this kind of defensive
validation can surface genuinely pre-existing, unrelated data-quality issues, not just prove
the new feature itself works.

### Email infrastructure
Real magic-link/OTP delivery now goes through custom SMTP via Mailtrap, on the real domain
`talkthroughhistory.com` (DNS — SPF/DKIM/DMARC — managed via Cloudflare, configured in
Supabase's Auth SMTP settings, verified end-to-end with a real login). This replaces Supabase's
shared default sender, which has its own rate limits and a shared reputation pool with every
other Supabase project using it — that shared-sender limit, not anything specific to this
project, was most of why auth-flow testing was so rate-limit-constrained across this work (see
"Working conventions" below for the rule that exists because of it).

### Email+password login (plus password reset — the auth chapter is now complete)
Email+password is now the primary form on `/login`, alongside the original magic link (kept as
an "email me a login link instead" toggle, not removed). Both auth methods thread through the
exact same invite-code redirect logic (`?next=` → `/auth/callback`) — verified working for both
paths into an invited family, not just magic link as it was before this work.

Password reset (`resetPasswordForEmail`) reuses that same `/auth/callback` PKCE mechanism as
everything else — no new callback logic needed. The only real requirement was pointing the
recovery email's redirect at a dedicated `/reset-password` page instead of the app root, forcing
a new password to actually be set before landing back in the app (otherwise a clicked recovery
link would just sign someone in without ever changing anything, defeating the point of "reset").
Always shows an identical message whether or not the email matches a real account — anti-
enumeration, consistent with signup's own existing behavior investigated as part of this work.

Working convention reinforced by this work: GoTrue (Supabase's auth server) writes a placeholder
password hash to every account regardless of auth method — seeing a non-empty
`encrypted_password` on a magic-link-only account is expected and not evidence of a real
credential existing. If this ever looks alarming again, verify by attempting an actual login
with the suspected password (not just inspecting the column) before treating it as a real issue.

`/login?error=auth_failed` now shows a clear "that link didn't work" message — previously
silently dropped visitors on a blank-looking form, which read as broken/confusing once the
page's default view became a real password form rather than an obvious "we'll email you a link"
placeholder.

## Working conventions
- **Always verify with a real browser test before committing**, not just typecheck/build —
  use a disposable test account/session, never real user data, for destructive or
  auth-dependent testing.
- **For a feature that needs real writes to verify (not just RLS/read checks), create a
  throwaway `families` row and temporarily flip the real account's `family_members.is_active`
  to it** (multi-family membership already supports this — see "Multi-User / Multi-Family"),
  rather than writing test data into the real family tree. Restore the real family's
  `is_active` and delete every test row by exact id (facts → document_people → documents →
  Storage objects → people → family_members → families) when done — confirmed this session
  (2026-08-02) for the email-body-facts feature, and it's what actually caught a real bug (see
  "Email-based upload intake" above) that SQL-only simulation wouldn't have, since the bug was
  in a Server Action only reachable through a real request context (`requireUser()`'s
  `cookies()` call throws outside one — plain functions taking an injected `supabase` client,
  like `matchEmailNoteCandidatesWith`, don't have this problem and can be called directly from a
  script instead). A saved `.auth/session.json` can go stale between sessions; if so, ask the
  user to log in in a visible (non-headless) Playwright-launched browser window and save a fresh
  one — don't try to self-authenticate as them via the admin API's `generateLink` even though it
  never sends a real email, since that routes around them explicitly doing it themselves.
- **Reuse a saved auth session before requesting a new magic link.** Login is Supabase
  magic-link OTP with no service-role key available locally, so verifying anything
  auth-dependent means asking the user to click an emailed link — and Supabase rate-limits
  repeat magic-link requests to the same address, so requesting a fresh one every time a
  verification is needed burns through that limit fast. Before asking for a new login, check
  for `.auth/session.json` (gitignored, never commit — it's a live session) and try it first
  via Playwright's `storageState`. Only request a fresh magic link if no saved session exists
  or the saved one is actually rejected/expired. After a successful login, save it with
  `context.storageState({ path: ".auth/session.json" })` before closing the browser, so the
  next verification task can reuse it.
- **Never attempt a real magic-link/OTP send to a fabricated or synthetic address during
  testing — non-negotiable.** This actually happened twice (testing invite-join and
  create-family flows) and contributed to a real Supabase bounce-rate warning that threatened
  to restrict all email sending for the project — i.e. break login for every real user, not
  just break a test. Always use SQL-role-simulation instead for testing auth-dependent flows
  (impersonate the target user's JWT claims — `set role authenticated; set request.jwt.claims
  = '{"sub":"<uuid>","role":"authenticated"}';` — then run real queries/RPCs against the real
  RLS policies); this has been proven correct and sufficient for verifying RLS, invite/join,
  and fork behavior without a single real auth flow. If a literal end-to-end email round trip
  is ever genuinely necessary, it must go to a real, reachable `+alias` address on an inbox
  actually controlled (e.g. `thomas.ciampa+test@gmail.com` — Gmail ignores the `+suffix`, so
  it delivers to the real inbox) — never a made-up address — and only after explicitly asking
  first. Deleting a synthetic `auth.users` row afterward does not undo an email that was
  already sent to it.
- When a bug report's stated cause might be wrong, investigate and report the *actual* root
  cause before fixing — don't build a fix for the wrong problem. (Real example: a reported
  "expand/collapse inconsistency" turned out not to be a data-fetching depth bug at all, but
  a structural limitation of family-chart's single-main-person ancestry model.)
- Big or risky changes: stage the work, verify each stage, wait for confirmation before the
  next.
- **Serialize concurrent AI Gateway calls fired from a batch update; persist failure state,
  don't leave it only in component state.** A batch DB write (e.g. transcribing every segment
  of an interview at once) that triggers per-item effects can fire all of them concurrently —
  a thundering herd where only the first request reliably succeeds and the rest silently never
  complete. If failures only live in ephemeral UI state, "never attempted" and "failed" become
  indistinguishable the moment the page reloads, which is a real, costly-to-diagnose dead end
  (see the 2026-07-25 interview auto-extraction incident under "Audio Interview architecture").
  Any future feature firing multiple AI Gateway calls off a batch update should serialize them
  (a queue, not concurrent effects) and persist failures to a DB column with a visible retry
  affordance, not just a component-local error string.
- Public GitHub repo — this holds real family data. Be careful about what gets committed
  (no service-role keys, no `.env.local` secrets); flag anything sensitive before committing.
- **A one-time data backfill is a legitimate part of a root-cause fix, not scope creep** — e.g.
  correcting existing facts written under an old, buggy field-naming convention once the writer
  itself is fixed (see "Standard field names" above). Two rules make it safe: never create a
  duplicate of a canonical value a person already has from another source (dedup before
  inserting), and never fabricate a value to fit a near-miss pattern — if the source text
  doesn't actually state the claimed standard field (e.g. a fact labeled "Death" that's actually
  about signing a letter, not a real death date), leave it alone rather than forcing a match.
- A signup attempt against an already-registered, confirmed email silently no-ops via Supabase's
  `signUp()` — anti-enumeration behavior, not a bug — returning a same-shaped but fake success
  response instead of an error. The reliable way to detect this case is checking for an empty
  `identities: []` array on the response (a genuinely new signup always has at least one real
  identity); confirmed directly against the raw GoTrue endpoint for both an existing and a
  genuinely new account before trusting it, rather than assuming the heuristic from memory.
  `/login`'s signup form now surfaces a clear "you already have an account" message based on this
  signal (2026-07-27). The separate forgot-password path deliberately stays fully generic
  regardless of whether the email exists — anti-enumeration only matters where a visitor could be
  probing an email that isn't theirs, not where they already typed and know the exact email
  they're claiming.

## Known follow-ups (already on the todo list — don't rebuild without checking first)
- Splitting interviews out of the shared `documents` table into their own model — see "Audio
  Interview architecture" above for why this keeps causing friction.
- Linking a person's interviews to their dossier (currently only documents show there).

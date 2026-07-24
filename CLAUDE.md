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
  were empty (cheap then, expensive to retrofit later). Currently single-family only — do
  NOT build multi-family switching/invite UI unless explicitly asked; just make sure new
  rows get the current family_id.

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
siblings; clicking a parent's card body does NOT recenter (only siblings do).

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

## Home page dashboard
`/` shows a "Tasks pending your review" section (`src/lib/pending-review.ts`) right after the
welcome header — the first thing surfaced after signing in. It reuses the exact same
`documents`/`people` queries and unresolved-candidate logic `/documents` and `/interviews`
already compute per row (`documents-view.tsx`'s `unresolvedCount`, `confirmInterviewBatch`'s
`resolution`/`written` markers) rather than a new tracking table or status column. Since both
pipelines now auto-process up to the review step (see above), anything this surfaces is
genuinely waiting on a human decision, never still mid-pipeline. Each item links straight to
its review screen (`/documents/[id]` or `/interviews/[id]`).

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

## Working conventions
- **Always verify with a real browser test before committing**, not just typecheck/build —
  use a disposable test account/session, never real user data, for destructive or
  auth-dependent testing.
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
- When a bug report's stated cause might be wrong, investigate and report the *actual* root
  cause before fixing — don't build a fix for the wrong problem. (Real example: a reported
  "expand/collapse inconsistency" turned out not to be a data-fetching depth bug at all, but
  a structural limitation of family-chart's single-main-person ancestry model.)
- Big or risky changes: stage the work, verify each stage, wait for confirmation before the
  next.
- Public GitHub repo — this holds real family data. Be careful about what gets committed
  (no service-role keys, no `.env.local` secrets); flag anything sensitive before committing.

## Known follow-ups (already on the todo list — don't rebuild without checking first)
- Splitting interviews out of the shared `documents` table into their own model — see "Audio
  Interview architecture" above for why this keeps causing friction.
- Linking a person's interviews to their dossier (currently only documents show there).

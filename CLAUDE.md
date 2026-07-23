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

## Audio Interview architecture
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

Transcription uses `openai/whisper-1` specifically, not `gpt-4o-transcribe` or
`gpt-4o-mini-transcribe` — the newer models are more accurate but silently return no timestamps
at all when timestamp granularities are requested, and word-level timestamps are what's needed
to slice one continuous session recording into its per-question segments. See the comment in
`interviews/actions.ts` above the transcription calls before changing the model.

Batch confirmation (`confirmInterviewBatch`) is idempotent — already-resolved people and
already-written facts/anecdotes are tracked via `resolution`/`written` markers persisted back
onto each segment's own `candidate_people`, so re-running it (e.g. after extracting a segment
added later) never duplicates data.

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

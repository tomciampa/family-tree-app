import { z } from "zod";
import { candidatePersonSchema } from "./candidate-schema";
import {
  makeCandidateFactSchema,
  makeCandidateAnecdoteSchema,
  resolveAbout,
  type AboutRef,
} from "@/app/interviews/extraction-schema";

// Split out from actions.ts for the same reason candidate-schema.ts
// already is (a "use server" file can only export async functions).
// Mirrors interviews/extraction-schema.ts's own makeCandidateFactSchema
// usage and email-body-extraction.ts's — the "about" description is the
// one piece that genuinely differs per caller. Anchor-free, like the
// email-body case: a document has no equivalent of an interview's known
// interviewee, everyone mentioned is just another entry in `people`.
const ABOUT_DESCRIPTION =
  "Exactly matches the name of one of the people listed in `people` — whoever this fact is about.";

// No dateInferenceNote extension (unlike email's own use of
// makeCandidateFactSchema) — that exists specifically to resolve relative
// time expressions ("yesterday", "last week") against an email's own
// Date: header as a reliable reference point. A document (a certificate,
// letter, memorial card) has no equivalent reliable "reference date" to
// resolve a relative expression against, so this stays the plain base
// shape.
export const documentCandidateFactSchema = makeCandidateFactSchema(ABOUT_DESCRIPTION);
export const documentCandidateAnecdoteSchema = makeCandidateAnecdoteSchema(ABOUT_DESCRIPTION);

export type DocumentCandidateFact = z.infer<typeof documentCandidateFactSchema> & {
  aboutRef: AboutRef;
  written?: { factId: string };
};
export type DocumentCandidateAnecdote = z.infer<typeof documentCandidateAnecdoteSchema> & {
  aboutRef: AboutRef;
  written?: { anecdoteId: string };
};

// The extraction schema's own people[] entries are typed generically as
// P (CandidatePerson before matching, CandidateWithMatch after) so this
// same type serves both the raw generateObject result and the persisted,
// matched-and-resolved candidate_people column — exactly how
// EmailNoteExtraction's own `people` field is typed in
// email-body-extraction.ts.
//
// Deliberately named `people`, not `candidates` — lib/fork-family-remap.ts's
// remapCandidatePeople dispatches on Array.isArray(raw) (the old plain
// CandidatePerson[] shape) vs. an object with a `people` key (interview/
// email's shape); it reads `extraction.people` by that exact name. Naming
// this field anything else would make a forked family silently lose every
// candidate on a pending document — confirmed by reading that dispatch
// directly, not assumed. Keeping this key name identical to
// InterviewExtraction/EmailNoteExtraction also means fork's remap needs
// zero changes to support documents.
export type DocumentExtraction<P> = {
  people: P[];
  facts: DocumentCandidateFact[];
  anecdotes: DocumentCandidateAnecdote[];
};

// A plain document's stored candidate_people predates this file's
// facts[]/anecdotes[] extraction for 14 real pre-existing rows (extracted
// before this feature shipped): it's still the bare old CandidatePerson[]
// shape, not { people, facts, anecdotes }. lib/fork-family-remap.ts's
// remapCandidatePeople already had to dispatch on Array.isArray(raw) for
// exactly this reason — this mirrors that same normalization for every
// other reader of a document's candidate_people, so `extraction.people`
// is never accessed on a bare array (undefined.filter/.some crash; this
// took production's homepage down once already, see pending-review.ts).
export function normalizeDocumentExtraction<P>(raw: unknown): DocumentExtraction<P> {
  if (raw == null) return { people: [], facts: [], anecdotes: [] };
  if (Array.isArray(raw)) return { people: raw as P[], facts: [], anecdotes: [] };
  const extraction = raw as Partial<DocumentExtraction<P>>;
  return {
    people: extraction.people ?? [],
    facts: extraction.facts ?? [],
    anecdotes: extraction.anecdotes ?? [],
  };
}

export function attachAboutRefs<P extends { name: string }>(
  people: P[],
  facts: z.infer<typeof documentCandidateFactSchema>[],
  anecdotes: z.infer<typeof documentCandidateAnecdoteSchema>[],
): { facts: DocumentCandidateFact[]; anecdotes: DocumentCandidateAnecdote[] } {
  return {
    facts: facts.map((f) => ({ ...f, aboutRef: resolveAbout(f.about, people) })),
    anecdotes: anecdotes.map((a) => ({ ...a, aboutRef: resolveAbout(a.about, people) })),
  };
}

// Facts/anecdotes-only extraction — no `people`/`rawText`, used by
// documents/actions.ts's reextractFactsForResolvedDocument to backfill
// facts[]/anecdotes[] onto a document whose people[] identity matching is
// already correct, without re-running (and risking overwriting) any of
// it. See CLAUDE.md's shape-migration incident note for why this exists.
export const documentFactsOnlyExtractionSchema = z.object({
  facts: z
    .array(documentCandidateFactSchema)
    .describe(
      "Discrete factual claims: names, dates, places, occupations, and other concrete details. " +
        "Only about a person already named in the provided list — never introduce a new person.",
    ),
  anecdotes: z
    .array(documentCandidateAnecdoteSchema)
    .describe(
      "Narrative material that doesn't reduce to a discrete claim — stories, memories, " +
        "characterizations, letters' reminiscences.",
    ),
});

// Same job as attachAboutRefs above, plus one addition: if `about`
// resolves to a person whose exact name is shared by more than one entry
// in `people` (e.g. a document with two different candidates both named
// "Anthony", only one of them actually matched to a real person), that's
// a real name collision this app has been burned by before (see
// CLAUDE.md's "Anthony Ciampa" name-collision note) — never silently pick
// one. Produces an "ambiguous" ref instead, which stays unwritten until a
// human picks the right one via resolveAmbiguousAttribution. Kept
// separate from attachAboutRefs (used by the live fresh-extraction
// pipeline) rather than changing that function's behavior for every
// caller — this narrower ambiguity check only matters for reprocessing an
// already-resolved document's fixed, known people[] list.
export function attachFactsOnlyAboutRefs<P extends { name: string }>(
  people: P[],
  facts: z.infer<typeof documentCandidateFactSchema>[],
  anecdotes: z.infer<typeof documentCandidateAnecdoteSchema>[],
): { facts: DocumentCandidateFact[]; anecdotes: DocumentCandidateAnecdote[] } {
  function resolve(about: string): AboutRef {
    const base = resolveAbout(about, people);
    if (base.type !== "person") return base;
    const targetName = people[base.index].name.trim().toLowerCase();
    const duplicates = people
      .map((p, index) => ({ index, name: p.name }))
      .filter((p) => p.name.trim().toLowerCase() === targetName);
    if (duplicates.length > 1) {
      return { type: "ambiguous", raw: about, candidates: duplicates };
    }
    return base;
  }
  return {
    facts: facts.map((f) => ({ ...f, aboutRef: resolve(f.about) })),
    anecdotes: anecdotes.map((a) => ({ ...a, aboutRef: resolve(a.about) })),
  };
}

export const documentExtractionSchema = z.object({
  rawText: z.string().describe("The full transcribed text content of the document"),
  people: z
    .array(candidatePersonSchema)
    .describe("Every person named in the document, not just its main subject"),
  facts: z
    .array(documentCandidateFactSchema)
    .describe(
      "Discrete factual claims: names, dates, places, occupations, and other concrete details. " +
        "Don't duplicate a person's name/relation here — that's already captured in `people`.",
    ),
  anecdotes: z
    .array(documentCandidateAnecdoteSchema)
    .describe(
      "Narrative material that doesn't reduce to a discrete claim — stories, memories, " +
        "characterizations, letters' reminiscences.",
    ),
});

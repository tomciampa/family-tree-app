import { z } from "zod";
import { STANDARD_FIELD_LABELS } from "@/app/tree/constants";

// Split out from interviews/actions.ts (a "use server" file, which can
// only export async functions — not these schema objects or the plain
// resolveAbout function) — same reasoning as documents/candidate-schema.ts's
// own split. Originally interview-only; now also reused by the
// email-intake webhook's body-text extraction (see
// app/api/email-intake/email-body-extraction.ts), which needs the exact
// same "discrete field/value facts + narrative anecdotes, each attributed
// to a specific person" shape but has no equivalent of an interview's
// known interviewee to anchor against — every person mentioned in an
// email is just someone in `people`, nobody is "already known" the way
// an interviewee is. makeCandidateFactSchema/makeCandidateAnecdoteSchema
// take the one piece of text that actually differs between the two
// callers (how to describe what `about` can match) as a parameter, so
// the STANDARD_FIELD_LABELS-aware instructions — the part actually worth
// keeping in sync — stay written once, not duplicated.
export function makeCandidateFactSchema(aboutDescription: string) {
  return z.object({
    about: z.string().describe(aboutDescription),
    field: z
      .string()
      .describe(
        "Short label for the kind of fact. If this states one of the standard genealogy " +
          `fields — ${STANDARD_FIELD_LABELS.join(", ")} — use that EXACT label, character for ` +
          "character (e.g. 'Birth Date', never 'Birth' or 'Born'). If a single statement gives " +
          "more than one of these (e.g. 'born in Portsmouth, New Hampshire on December 14, " +
          "1987' states both a Birth Place and a Birth Date), emit a SEPARATE fact entry per " +
          "standard field, each with only that one piece of information as its value — never " +
          "merge multiple standard fields into one combined value. For anything that isn't one " +
          "of those standard fields, use a short freeform label instead, e.g. 'Education', " +
          "'Military Service', 'Marriage'.",
      ),
    value: z.string().describe("The factual claim itself, stated concisely"),
    confidence: z
      .string()
      .nullable()
      .describe(
        "If the person hedged (e.g. 'I think', 'I'm not sure', 'maybe', 'I guess') capture that hedge briefly here, e.g. 'uncertain' or 'not sure'. Null if stated plainly and confidently. This is ONLY about whether the person themselves hedged the claim — never used to flag a computed/inferred value (e.g. a relative date resolved against a reference timestamp); that's a separate concern, noted in source_ref instead once this fact is actually written.",
      ),
    quote: z.string().describe("The verbatim sentence(s) this fact is drawn from"),
  });
}

export function makeCandidateAnecdoteSchema(aboutDescription: string) {
  return z.object({
    about: z.string().describe(aboutDescription),
    storyText: z.string().describe("The narrative story itself, as told — not a discrete factual claim"),
    quote: z.string().describe("The verbatim excerpt this anecdote is drawn from"),
  });
}

// Resolves which person a fact/anecdote's "about" name refers to, by exact
// (then partial, e.g. "Karen" for "Karen Dubois") match against a known
// anchor's name (an interview's interviewee — optional, since not every
// caller has one) or one of the extraction's own people. Resolved once at
// extraction time and stable afterward, since matching only enriches each
// people[] entry in place, never reorders it.
export type AboutRef =
  | { type: "interviewee" }
  | { type: "person"; index: number; name: string }
  // Matches more than one same-named person entry — e.g. a document with
  // two different candidates both named "Anthony", only one of them
  // resolved to a real person. Only ever produced by
  // documents/document-extraction-schema.ts's attachFactsOnlyAboutRefs
  // (the narrow reprocessing pipeline), never by resolveAbout itself —
  // never silently guessed, a human must pick one (see
  // resolveAmbiguousAttribution in documents/actions.ts) before this can
  // become a "person" ref and be written.
  | { type: "ambiguous"; raw: string; candidates: { index: number; name: string }[] }
  | { type: "unresolved"; raw: string };

// The "interviewee" variant is never produced when anchorName is omitted
// (the email-body caller's case — there's no equivalent "already known"
// person) — kept as the existing literal name rather than renamed to
// something more generic, since that name is already pattern-matched in
// 3 files across the interview review UI and renaming it for a caller
// that never even produces it isn't worth that risk.
export function resolveAbout(
  about: string,
  people: { name: string }[],
  anchorName?: string | null,
): AboutRef {
  const normalize = (s: string) => s.trim().toLowerCase();
  if (anchorName && normalize(about) === normalize(anchorName)) return { type: "interviewee" };

  const exactIndex = people.findIndex((p) => normalize(p.name) === normalize(about));
  if (exactIndex >= 0) return { type: "person", index: exactIndex, name: people[exactIndex].name };

  const partialIndex = people.findIndex(
    (p) =>
      normalize(p.name).includes(normalize(about)) || normalize(about).includes(normalize(p.name)),
  );
  if (partialIndex >= 0) {
    return { type: "person", index: partialIndex, name: people[partialIndex].name };
  }

  return { type: "unresolved", raw: about };
}

// Shared display helper — previously duplicated per review page
// (email-note-review.tsx had its own copy before this). "interviewee" is
// unreachable for any caller that never produces it (see resolveAbout's
// own comment) but must still typecheck since AboutRef is shared.
export function aboutLabel(aboutRef: AboutRef, intervieweeName?: string): string {
  if (aboutRef.type === "person") return aboutRef.name;
  if (aboutRef.type === "ambiguous") return `${aboutRef.raw} (ambiguous)`;
  if (aboutRef.type === "unresolved") return `${aboutRef.raw} (unresolved)`;
  return intervieweeName ?? "interviewee";
}

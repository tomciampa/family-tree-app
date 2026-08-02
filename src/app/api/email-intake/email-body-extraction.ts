import { generateObject } from "ai";
import { z } from "zod";
import { candidatePersonSchema, type CandidatePerson } from "@/app/documents/candidate-schema";
import type { CandidateWithMatch, SupabaseClient } from "@/app/documents/actions";
import {
  makeCandidateFactSchema,
  makeCandidateAnecdoteSchema,
  resolveAbout,
  type AboutRef,
} from "@/app/interviews/extraction-schema";

// Not a "use server" file — unlike interviews/actions.ts and
// documents/actions.ts, nothing here needs to be callable directly from a
// client component (the only caller of extractEmailBodyCandidates is the
// email-intake webhook route, a plain server-side Route Handler; the new
// /email-notes review surface's own "use server" actions file wraps a
// manual retry around this same function rather than exporting it
// itself). That also means the schema objects below can be exported
// directly, same reasoning as documents/candidate-schema.ts.
//
// The "about" description is anchor-free, like documents/actions.ts's own
// extraction — an email has no equivalent of an interview's known
// interviewee to anchor against. Everyone mentioned, including the
// sender if they're named, is just another entry in `people`.
const ABOUT_DESCRIPTION =
  "Exactly matches the name of one of the people listed in `people` — whoever this fact is about.";

export const emailCandidateFactSchema = makeCandidateFactSchema(ABOUT_DESCRIPTION).extend({
  dateInferenceNote: z
    .string()
    .nullable()
    .describe(
      "If `value` states or implies a date that had to be computed from a RELATIVE time " +
        "expression in the email (e.g. \"yesterday\", \"last week\", \"when he turned 40 in " +
        "2019\") resolved against this email's own reference date, briefly note that inference " +
        "here in this exact shape: \"date inferred from relative reference '<the original " +
        "phrase>'\". Null if `value` already states an absolute date directly (no relative " +
        "expression involved). If a relative expression is too vague to resolve confidently " +
        "(e.g. \"a while back\", \"years ago\"), do NOT guess a specific date — leave the date " +
        "out of `value` (or state it in the same vague terms the email used) and leave this " +
        "field null.",
    ),
});

export const emailCandidateAnecdoteSchema = makeCandidateAnecdoteSchema(
  "Exactly matches the name of one of the people listed in `people` — whoever this story centers on.",
);

const emailBodyExtractionSchema = z.object({
  people: z
    .array(candidatePersonSchema)
    .describe("Everyone mentioned in this email, including the sender if they're named."),
  facts: z
    .array(emailCandidateFactSchema)
    .describe(
      "Discrete factual claims: names, dates, places, occupations, and other concrete details. " +
        "Don't duplicate a person's name/relation here — that's already captured in `people`.",
    ),
  anecdotes: z
    .array(emailCandidateAnecdoteSchema)
    .describe(
      "Narrative material that doesn't reduce to a discrete claim — stories, memories, " +
        "characterizations.",
    ),
});

export type EmailCandidateFact = z.infer<typeof emailCandidateFactSchema> & {
  aboutRef: AboutRef;
  written?: { factId: string };
};
export type EmailCandidateAnecdote = z.infer<typeof emailCandidateAnecdoteSchema> & {
  aboutRef: AboutRef;
  written?: { anecdoteId: string };
};

// Deliberately structurally identical to interviews/actions.ts's own
// InterviewExtraction ({ people, facts, anecdotes }) — not a coincidence.
// lib/fork-family-remap.ts's remapCandidatePeople dispatches on
// Array.isArray(raw) (documents' plain CandidatePerson[] shape) vs
// typeof raw === "object" (this shape), and its object branch already
// knows how to walk people/facts/anecdotes generically. Keeping this
// shape identical means fork_family's remap works on email-note rows
// with zero changes to that file.
export type EmailNoteExtraction = {
  people: (CandidatePerson | CandidateWithMatch)[];
  facts: EmailCandidateFact[];
  anecdotes: EmailCandidateAnecdote[];
};

function formatReferenceDate(recordedAt: string | null): string {
  if (!recordedAt) return "unknown";
  const d = new Date(recordedAt);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

// Extracts candidate people/facts/anecdotes from an email-body-note
// document's cleaned body text (stored in transcription_raw, same column
// documents/interviews use for their own extractable text) and writes the
// result back onto the row — same shape of function as
// extractCandidatesFromDocument/extractCandidatesFromSegment. Takes an
// already-resolved supabase client rather than calling requireUser()
// itself, since its one real caller (the email-intake webhook) has no
// user session at all; a future manual "Retry" action on the review
// surface passes its own requireUser()-derived client the same way
// extractCandidatesFromDocument's override parameter does.
export async function extractEmailBodyCandidates(
  supabase: SupabaseClient,
  documentId: string,
): Promise<{ error: string } | { extraction: EmailNoteExtraction }> {
  const { data: document, error: fetchError } = await supabase
    .from("documents")
    .select("transcription_raw, recorded_at")
    .eq("id", documentId)
    .single();
  if (fetchError || !document) {
    return { error: fetchError?.message ?? "Email note not found." };
  }
  if (!document.transcription_raw || !document.transcription_raw.trim()) {
    return { error: "No email body text to extract from." };
  }

  const referenceDate = formatReferenceDate(document.recorded_at);

  let result;
  try {
    result = await generateObject({
      model: "anthropic/claude-sonnet-5",
      schema: emailBodyExtractionSchema,
      messages: [
        {
          role: "user",
          content: [
            "This is the cleaned body text of an email sent to a family history app's email-in " +
              "address, so a family member can casually report genealogy-relevant information " +
              "without visiting the app.",
            `This email's own reference date (when it was sent) is ${referenceDate}. Resolve any ` +
              "unambiguous relative time expression in the text (\"yesterday\", \"last week\", " +
              "\"when he turned 40 in 2019\") into an absolute date computed against this " +
              "reference date, and flag that computation via dateInferenceNote on the fact. " +
              "Leave genuinely ambiguous expressions (\"a while back\", \"years ago\") " +
              "unresolved rather than guessing.",
            "",
            "Extract:",
            "1. Everyone mentioned by name, including the sender if named. For each, capture " +
              "their name, relation (if stated), roleCategory ('family' for anyone personally " +
              "connected to whoever the email is about, 'administrative' for anyone with no " +
              "personal relation — rare in an email, but keep the distinction), and any dates or " +
              "disambiguating notes.",
            "2. Discrete factual claims — names, dates, places, occupations, relationships, or " +
              "other concrete details. Attribute each to exactly who it's about.",
            "3. Narrative anecdotes — stories, characterizations, and color that don't reduce to " +
              "a discrete factual claim. Attribute each to who the story centers on.",
            "",
            "Email body:",
            document.transcription_raw,
          ].join("\n"),
        },
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed.";
    // Same durable-failure convention as extractCandidatesFromSegment —
    // this route has no live browser tab to show an ephemeral error in.
    await supabase.from("documents").update({ extraction_error: message }).eq("id", documentId);
    return { error: message };
  }

  const people = result.object.people;
  const facts = result.object.facts.map((f) => ({
    ...f,
    aboutRef: resolveAbout(f.about, people),
  }));
  const anecdotes = result.object.anecdotes.map((a) => ({
    ...a,
    aboutRef: resolveAbout(a.about, people),
  }));

  const extraction: EmailNoteExtraction = { people, facts, anecdotes };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: extraction, extraction_error: null })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  return { extraction };
}

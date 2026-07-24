"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { transcribe, generateObject, generateText } from "ai";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";
import { matchFamilyCandidates, type CandidateWithMatch } from "@/app/documents/actions";
import {
  candidatePersonSchema,
  factFieldForRelation,
  type CandidatePerson,
} from "@/app/documents/candidate-schema";
import { addFirstPerson } from "@/app/tree/actions";
import { INTERVIEW_PROMPTS } from "./prompts";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return supabase;
}

// Called after the browser has already uploaded the recorded audio
// straight to Storage (see record-interview-flow.tsx) — recordings can run
// long, and routing the raw bytes through a Server Action would hit
// next.config.ts's 10MB body limit (see documents-view.tsx's comment on
// the same limit). This just writes the resulting metadata row.
export async function createInterviewSession({
  filePath,
  filename,
  mimeType,
  intervieweePersonId,
}: {
  filePath: string;
  filename: string;
  mimeType: string;
  intervieweePersonId: string;
}): Promise<{ error: string } | { documentId: string }> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { data, error } = await supabase
    .from("documents")
    .insert({
      file_path: filePath,
      filename,
      document_type: mimeType || null,
      kind: "Interview Recording",
      family_id: familyId,
      interviewee_person_id: intervieweePersonId,
      // Already linked to its subject via interviewee_person_id, so it
      // never needs the pending_match candidate-matching workflow that
      // general /documents uploads go through.
      status: "matched",
    })
    .select("id")
    .single();

  if (error) {
    await supabase.storage.from("documents").remove([filePath]);
    return { error: error.message };
  }

  revalidatePath("/interviews");
  return { documentId: data.id };
}

// Called right after createInterviewSession, once per "Next question" /
// stop boundary recorded during the guided flow (see
// record-interview-flow.tsx). Segments share the parent's file_path
// rather than getting their own extracted audio clip — they're just a
// labeled [audio_start_seconds, audio_end_seconds) slice of the same
// session recording, per the plan already laid out in the Stage 1
// migration's comment.
export async function createInterviewSegments({
  parentDocumentId,
  filePath,
  mimeType,
  segments,
}: {
  parentDocumentId: string;
  filePath: string;
  mimeType: string;
  segments: { label: string; startSeconds: number; endSeconds: number }[];
}): Promise<{ error: string } | { count: number }> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const validSegments = segments.filter((s) => s.endSeconds > s.startSeconds);
  if (validSegments.length === 0) return { count: 0 };

  const { error } = await supabase.from("documents").insert(
    validSegments.map((s) => ({
      file_path: filePath,
      filename: s.label,
      document_type: mimeType || null,
      // Reuses the same "short human-readable category" field a regular
      // document's kind uses (e.g. "Death Certificate") — here it's the
      // prompt this segment answers, rather than adding a parallel column.
      kind: s.label,
      family_id: familyId,
      parent_document_id: parentDocumentId,
      audio_start_seconds: s.startSeconds,
      audio_end_seconds: s.endSeconds,
      status: "matched",
    })),
  );
  if (error) return { error: error.message };

  revalidatePath("/interviews");
  return { count: validSegments.length };
}

// Speech-to-text via the same AI Gateway already used for document OCR
// (extractCandidatesFromDocument in app/documents/actions.ts) — no new
// provider account or credentials needed, just a transcription-typed
// model routed through the same AI_GATEWAY_API_KEY. Stores the result on
// transcription_raw, the same column document OCR text already lives in,
// rather than adding a parallel column. Idempotent like that OCR path:
// if a transcript already exists, it's returned as-is rather than
// re-run and overwritten — segmentation/extraction (Stage 3/4) will read
// this field, and re-transcribing on every click would be wasteful and
// could silently change text something downstream already used.
export async function transcribeInterviewSession(
  documentId: string,
): Promise<{ error: string } | { transcript: string }> {
  const supabase = await requireUser();

  const { data: document, error: fetchError } = await supabase
    .from("documents")
    .select("file_path, transcription_raw")
    .eq("id", documentId)
    .single();
  if (fetchError || !document) {
    return { error: fetchError?.message ?? "Recording not found." };
  }

  if (document.transcription_raw) {
    return { transcript: document.transcription_raw };
  }

  const { data: fileBlob, error: downloadError } = await supabase.storage
    .from("documents")
    .download(document.file_path);
  if (downloadError || !fileBlob) {
    return { error: downloadError?.message ?? "Could not download recording." };
  }
  const bytes = new Uint8Array(await fileBlob.arrayBuffer());

  let result;
  try {
    result = await transcribe({
      model: "openai/gpt-4o-transcribe",
      audio: bytes,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Transcription failed." };
  }

  const { error: updateError } = await supabase
    .from("documents")
    .update({ transcription_raw: result.text })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  revalidatePath("/interviews");
  return { transcript: result.text };
}

// Transcribes every not-yet-transcribed segment of a guided-interview
// session in one pass.
//
// Investigated whether the full-session transcript could just be sliced at
// our recorded segment boundaries instead of touching audio again: OpenAI's
// gpt-4o-transcribe / gpt-4o-mini-transcribe (used above for the
// full-session transcript, for their better accuracy) silently return no
// timing data at all — verified empirically, requesting
// timestampGranularities against both returns `segments: []` every time,
// which matches OpenAI's own API not supporting verbose_json/timestamps on
// those newer models. whisper-1 does support it. The tradeoff: whisper-1's
// raw accuracy is a step below gpt-4o-transcribe (in testing it misheard
// "Ciampa" as "Chanta" on one take). Acceptable for this stage — nothing
// downstream reads this text yet.
//
// Punctuation: requesting both "word" and "segment" granularities in one
// call silently collapses to segment-only (verified empirically) — the AI
// SDK doesn't expose both from a single whisper-1 request the way OpenAI's
// own verbose_json response can. So this makes two calls: one for
// punctuated, sentence-length "segment" phrases (the primary source of
// each answer's text), one for "word" timestamps (used only to figure out
// which recorded [start, end) window a phrase belongs to, and to split the
// rare phrase that straddles one of our boundaries).
// Segment transcripts are stored (and shown) as "Q: <prompt>\nA: <answer>" —
// Phase 1 already speaks this exact prompt text aloud at the segment
// boundary, so persisting it alongside the answer makes a segment coherent
// to read back on its own, even if the interviewee never repeated the
// question themselves. No prompt lookup match (segment.kind not found in
// INTERVIEW_PROMPTS, shouldn't normally happen) just falls back to the bare
// answer rather than storing a broken "Q: undefined" line.
function formatSegmentTranscript(kind: string | null, answer: string): string {
  const promptText = INTERVIEW_PROMPTS.find((p) => p.label === kind)?.prompt;
  return promptText ? `Q: ${promptText}\nA: ${answer}` : answer;
}

// Reverses formatSegmentTranscript — extraction (extractCandidatesFromSegment
// below) must only ever see the interviewee's actual answer, never the
// question text itself (which is generic prompt wording, not something to
// mine for facts/anecdotes/people). Segments transcribed before this format
// existed have no "Q: "/"A: " prefix at all, so the regex simply doesn't
// match and the whole string passes through unchanged.
function answerOnly(transcriptionRaw: string): string {
  const match = transcriptionRaw.match(/^Q: .*\nA: ([\s\S]*)$/);
  return match ? match[1] : transcriptionRaw;
}

export async function transcribeInterviewSegments(
  parentDocumentId: string,
): Promise<{ error: string } | { segments: { id: string; transcript: string }[] }> {
  const supabase = await requireUser();

  const [
    { data: parent, error: parentError },
    { data: segments, error: segmentsError },
  ] = await Promise.all([
    supabase.from("documents").select("file_path").eq("id", parentDocumentId).single(),
    supabase
      .from("documents")
      .select("id, kind, audio_start_seconds, audio_end_seconds, transcription_raw")
      .eq("parent_document_id", parentDocumentId)
      .order("audio_start_seconds", { ascending: true }),
  ]);
  if (parentError || !parent) {
    return { error: parentError?.message ?? "Recording not found." };
  }
  if (segmentsError || !segments || segments.length === 0) {
    return { error: segmentsError?.message ?? "No segments to transcribe." };
  }

  const allSegments = segments;
  const alreadyDone = allSegments
    .filter((s) => s.transcription_raw)
    .map((s) => ({ id: s.id, transcript: s.transcription_raw! }));
  const pending = allSegments.filter((s) => !s.transcription_raw);
  if (pending.length === 0) return { segments: alreadyDone };

  const { data: fileBlob, error: downloadError } = await supabase.storage
    .from("documents")
    .download(parent.file_path);
  if (downloadError || !fileBlob) {
    return { error: downloadError?.message ?? "Could not download recording." };
  }
  const bytes = new Uint8Array(await fileBlob.arrayBuffer());

  let phraseResult, wordResult;
  try {
    [phraseResult, wordResult] = await Promise.all([
      transcribe({
        model: "openai/whisper-1",
        audio: bytes,
        providerOptions: { openai: { timestampGranularities: ["segment"] } },
      }),
      transcribe({
        model: "openai/whisper-1",
        audio: bytes,
        providerOptions: { openai: { timestampGranularities: ["word"] } },
      }),
    ]);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Transcription failed." };
  }
  const phrases = phraseResult.segments;
  const words = wordResult.segments;

  // segment boundaries (audio_start/end_seconds) are the ground truth —
  // this only decides how to render text given those boundaries, never
  // adjusts them.
  function segmentAt(time: number) {
    return allSegments.find(
      (s) => time >= (s.audio_start_seconds ?? 0) && time < (s.audio_end_seconds ?? Infinity),
    );
  }

  const textById = new Map<string, string[]>(allSegments.map((s) => [s.id, []]));

  for (const phrase of phrases) {
    const phraseWords = words.filter(
      (w) => w.startSecond >= phrase.startSecond && w.startSecond < phrase.endSecond,
    );
    // A phrase's own reported start/end can include leading/trailing
    // silence padding, which makes phrases that actually sit cleanly on
    // one side of a boundary look like they straddle it. Its constituent
    // words' start times (reliable — unlike word *end* times, which can
    // blow out across a pause, e.g. a word timestamped as lasting 8+
    // seconds after a hesitation) are a tighter, more honest bound.
    const effectiveStart = phraseWords[0]?.startSecond ?? phrase.startSecond;
    const effectiveEnd = phraseWords[phraseWords.length - 1]?.startSecond ?? phrase.endSecond;
    const startSeg = segmentAt(effectiveStart);
    const endSeg = segmentAt(effectiveEnd);

    if (startSeg && startSeg === endSeg) {
      textById.get(startSeg.id)?.push(phrase.text.trim());
      continue;
    }
    // Genuinely straddles one of our recorded boundaries — most often
    // because the interviewee kept talking a beat past the "Next
    // question" click. Fall back to raw per-word assignment so each half
    // still lands in the right segment, at the cost of punctuation for
    // just this handful of words.
    for (const w of phraseWords) {
      const seg = segmentAt(w.startSecond);
      if (seg) textById.get(seg.id)?.push(w.text);
    }
  }

  const updates = pending.map((s) => {
    const text = (textById.get(s.id) ?? []).join(" ").replace(/\s+/g, " ").trim();
    const answer = text || "(no speech detected in this segment)";
    return { id: s.id, transcript: formatSegmentTranscript(s.kind, answer) };
  });

  for (const u of updates) {
    const { error: updateError } = await supabase
      .from("documents")
      .update({ transcription_raw: u.transcript })
      .eq("id", u.id);
    if (updateError) return { error: updateError.message };
  }

  revalidatePath("/interviews");
  return { segments: [...alreadyDone, ...updates] };
}

// Phase 3: a short, one-line summary of what an interview actually
// covered, shown by default on /interviews so a recording doesn't have to
// be expanded to see roughly what's in it (e.g. "Conversation with Jeff
// Ciampa about his immediate family"). Generated once from the segments'
// own "Q: <prompt>\nA: <answer>" transcripts (Phase 2) — an AI one-liner
// reads far more naturally here than a templated list of segment labels
// would (tried both; a list of prompt names is closer to a table of
// contents than an actual summary, and barely differs between two
// interviews with the same person since the prompts are fixed) — then
// cached on the parent row's interview_summary column, same
// generate-once pattern transcription_raw already uses. Idempotent: a
// summary that already exists is returned as-is rather than regenerated.
export async function generateInterviewSummary(
  parentDocumentId: string,
): Promise<{ error: string } | { summary: string }> {
  const supabase = await requireUser();

  const { data: parent, error: parentError } = await supabase
    .from("documents")
    .select("interviewee_person_id, interview_summary")
    .eq("id", parentDocumentId)
    .single();
  if (parentError || !parent) {
    return { error: parentError?.message ?? "Recording not found." };
  }
  if (parent.interview_summary) {
    return { summary: parent.interview_summary };
  }
  if (!parent.interviewee_person_id) {
    return { error: "This isn't an interview session." };
  }

  const { data: interviewee, error: intervieweeError } = await supabase
    .from("people")
    .select("name")
    .eq("id", parent.interviewee_person_id)
    .single();
  if (intervieweeError || !interviewee) {
    return { error: intervieweeError?.message ?? "Interviewee not found." };
  }

  const { data: segments, error: segmentsError } = await supabase
    .from("documents")
    .select("kind, audio_start_seconds, transcription_raw")
    .eq("parent_document_id", parentDocumentId)
    .order("audio_start_seconds", { ascending: true });
  if (segmentsError) return { error: segmentsError.message };

  const transcribed = (segments ?? []).filter((s) => s.transcription_raw);
  if (transcribed.length === 0) {
    return { error: "Transcribe at least one answer before generating a summary." };
  }

  const transcriptText = transcribed
    .map((s) => `[${s.kind ?? "Segment"}]\n${s.transcription_raw}`)
    .join("\n\n");

  let result;
  try {
    result = await generateText({
      model: "anthropic/claude-sonnet-5",
      messages: [
        {
          role: "user",
          content: [
            `This is a guided oral-history interview with ${interviewee.name}, made up of several Q&A exchanges below, one per topic.`,
            `Write ONE single sentence (under ~30 words) that summarizes the WHOLE conversation across ALL topics combined — never one sentence per topic. Even though multiple topics were covered below, you must compress them into one combined sentence (e.g. list the topics briefly, or name the throughline), not a separate sentence for each. It should be specific enough to read differently from a summary of a different conversation with ${interviewee.name}, not a generic description. Start with something like "Conversation with ${interviewee.name} about...". Output plain text only: exactly one sentence, no line breaks, no quotes, no markdown, no trailing period required.`,
            "",
            transcriptText,
          ].join("\n"),
        },
      ],
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Summary generation failed." };
  }

  // Collapses to a single line regardless — belt-and-suspenders in case the
  // model ever ignores the single-sentence instruction above and produces
  // one line per topic, so the collapsed /interviews view never renders a
  // multi-paragraph "summary" no matter what comes back.
  const summary = result.text.replace(/\s+/g, " ").trim();
  if (!summary) return { error: "Summary generation returned nothing." };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ interview_summary: summary })
    .eq("id", parentDocumentId);
  if (updateError) return { error: updateError.message };

  revalidatePath("/interviews");
  return { summary };
}

const interviewCandidateFactSchema = z.object({
  about: z
    .string()
    .describe(
      "Exactly matches either the interviewee's own name or the exact name of one of the people listed in `people` — whoever this fact is about.",
    ),
  field: z
    .string()
    .describe(
      "Short label for the kind of fact, e.g. 'Birthplace', 'Occupation', 'Birth', 'Death', 'Marriage'",
    ),
  value: z.string().describe("The factual claim itself, stated concisely"),
  confidence: z
    .string()
    .nullable()
    .describe(
      "If the interviewee hedged (e.g. 'I think', 'I'm not sure', 'maybe', 'I guess') capture that hedge briefly here, e.g. 'uncertain' or 'not sure'. Null if stated plainly and confidently.",
    ),
  quote: z
    .string()
    .describe("The verbatim sentence(s) from the transcript this fact is drawn from"),
});

const interviewCandidateAnecdoteSchema = z.object({
  about: z
    .string()
    .describe(
      "Exactly matches either the interviewee's own name or the exact name of one of the people listed in `people` — whoever this story centers on.",
    ),
  storyText: z
    .string()
    .describe("The narrative story itself, as told — not a discrete factual claim"),
  quote: z
    .string()
    .describe("The verbatim excerpt from the transcript this anecdote is drawn from"),
});

const interviewExtractionSchema = z.object({
  people: z
    .array(candidatePersonSchema)
    .describe(
      "Every OTHER person mentioned in this segment — never the interviewee themselves, since they're already known.",
    ),
  facts: z
    .array(interviewCandidateFactSchema)
    .describe(
      "Discrete factual claims: names, dates, places, occupations, and other concrete details. Don't duplicate a person's name/relation here — that's already captured in `people`.",
    ),
  anecdotes: z
    .array(interviewCandidateAnecdoteSchema)
    .describe(
      "Narrative material that doesn't reduce to a discrete claim — stories, how people met, memorable moments, characterizations.",
    ),
});

// Resolves which person a fact/anecdote's "about" name refers to, by exact
// (then partial, e.g. "Karen" for "Karen Dubois") match against the
// interviewee's own name or one of this segment's extracted people —
// resolved once at extraction time and stable afterward, since matching
// (matchCandidatesForSegment) only enriches each people[] entry in place,
// never reorders it.
export type AboutRef =
  | { type: "interviewee" }
  | { type: "person"; index: number; name: string }
  | { type: "unresolved"; raw: string };

function resolveAbout(
  about: string,
  intervieweeName: string,
  people: { name: string }[],
): AboutRef {
  const normalize = (s: string) => s.trim().toLowerCase();
  if (normalize(about) === normalize(intervieweeName)) return { type: "interviewee" };

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

export type InterviewCandidateFact = z.infer<typeof interviewCandidateFactSchema> & {
  aboutRef: AboutRef;
  // Set once confirmInterviewBatch actually writes this to `facts` — lets
  // re-running the batch (e.g. after a later segment gets extracted) skip
  // what's already been written instead of duplicating it.
  written?: { factId: string };
};
export type InterviewCandidateAnecdote = z.infer<typeof interviewCandidateAnecdoteSchema> & {
  aboutRef: AboutRef;
  written?: { anecdoteId: string };
};

export type InterviewExtraction = {
  people: (CandidatePerson | CandidateWithMatch)[];
  facts: InterviewCandidateFact[];
  anecdotes: InterviewCandidateAnecdote[];
};

// Resolves a segment's interviewee via its parent session — segments never
// carry interviewee_person_id themselves (see createInterviewSegments'
// comment: it's a parent-session-only field).
async function getIntervieweePersonId(
  supabase: Awaited<ReturnType<typeof requireUser>>,
  parentDocumentId: string | null,
): Promise<{ error: string } | { intervieweePersonId: string }> {
  if (!parentDocumentId) {
    return { error: "This isn't an interview segment (no parent session)." };
  }

  const { data: parent, error: parentError } = await supabase
    .from("documents")
    .select("interviewee_person_id")
    .eq("id", parentDocumentId)
    .single();
  if (parentError || !parent?.interviewee_person_id) {
    return { error: parentError?.message ?? "This interview has no recorded interviewee." };
  }

  return { intervieweePersonId: parent.interviewee_person_id };
}

// Reuses the exact document-extraction pipeline (same candidatePersonSchema,
// same AI Gateway model) applied to a segment's transcript instead of a
// document's OCR text — plus the interviewee is passed in as a known
// relationship anchor rather than left for the AI to guess at, and the
// extraction additionally separates discrete factual claims from narrative
// material, matching the fact/anecdote distinction the rest of the app
// already uses.
export async function extractCandidatesFromSegment(
  segmentDocumentId: string,
): Promise<{ error: string } | { extraction: InterviewExtraction }> {
  const supabase = await requireUser();

  const { data: segment, error: segmentError } = await supabase
    .from("documents")
    .select("parent_document_id, kind, transcription_raw")
    .eq("id", segmentDocumentId)
    .single();
  if (segmentError || !segment) {
    return { error: segmentError?.message ?? "Segment not found." };
  }
  const anchor = await getIntervieweePersonId(supabase, segment.parent_document_id);
  if ("error" in anchor) return anchor;
  const { intervieweePersonId } = anchor;
  if (!segment.transcription_raw) {
    return { error: "Transcribe this segment before extracting." };
  }

  const { data: interviewee, error: intervieweeError } = await supabase
    .from("people")
    .select("name")
    .eq("id", intervieweePersonId)
    .single();
  if (intervieweeError || !interviewee) {
    return { error: intervieweeError?.message ?? "Interviewee not found." };
  }

  const promptText = INTERVIEW_PROMPTS.find((p) => p.label === segment.kind)?.prompt;

  let result;
  try {
    result = await generateObject({
      model: "anthropic/claude-sonnet-5",
      schema: interviewExtractionSchema,
      messages: [
        {
          role: "user",
          content: [
            `This is a transcript of one segment of a guided oral-history interview with ${interviewee.name}.`,
            promptText ? `This segment answers the prompt: "${promptText}"` : "",
            "",
            `Extract:`,
            `1. Every OTHER person mentioned — never ${interviewee.name} themselves, since they're already known. For each, capture their name, their relation to ${interviewee.name} (e.g. "father", "sister", "spouse"), and roleCategory: "family" for anyone personally connected to ${interviewee.name}, "administrative" for anyone mentioned with no personal relation. Include any dates or disambiguating notes.`,
            `2. Discrete factual claims — names, dates, places, occupations, relationships, or other concrete details. Attribute each to exactly who it's about (${interviewee.name} or one of the people above). If ${interviewee.name} hedges ("I think", "I'm not sure", "maybe", "I guess"), capture that hedge in confidence instead of stating the claim as certain or dropping it.`,
            `3. Narrative anecdotes — stories, characterizations, and color that don't reduce to a discrete factual claim (how people met, a memorable moment, a personality description). Attribute each to who the story centers on.`,
            "",
            "Transcript:",
            answerOnly(segment.transcription_raw),
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Extraction failed." };
  }

  const people = result.object.people;
  const facts = result.object.facts.map((f) => ({
    ...f,
    aboutRef: resolveAbout(f.about, interviewee.name, people),
  }));
  const anecdotes = result.object.anecdotes.map((a) => ({
    ...a,
    aboutRef: resolveAbout(a.about, interviewee.name, people),
  }));

  const extraction: InterviewExtraction = { people, facts, anecdotes };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: extraction })
    .eq("id", segmentDocumentId);
  if (updateError) return { error: updateError.message };

  revalidatePath("/interviews");
  return { extraction };
}

// Same relationship-signal matching document candidates go through
// (matchFamilyCandidates, shared with app/documents/actions.ts) — except
// the anchor is passed explicitly as the interviewee_person_id rather than
// inferred from a "deceased/self/subject" candidate, since who this
// segment is about is already known structurally, not guessed at.
export async function matchCandidatesForSegment(
  segmentDocumentId: string,
): Promise<{ error: string } | { extraction: InterviewExtraction }> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { data: segment, error: segmentError } = await supabase
    .from("documents")
    .select("parent_document_id, candidate_people")
    .eq("id", segmentDocumentId)
    .single();
  if (segmentError || !segment) {
    return { error: segmentError?.message ?? "Segment not found." };
  }
  const anchor = await getIntervieweePersonId(supabase, segment.parent_document_id);
  if ("error" in anchor) return anchor;
  const { intervieweePersonId } = anchor;

  const extraction = segment.candidate_people as unknown as InterviewExtraction | null;
  if (!extraction) return { error: "Extract candidates before matching." };

  const matched = await matchFamilyCandidates(
    supabase,
    familyId,
    extraction.people as CandidatePerson[],
    intervieweePersonId,
  );
  if ("error" in matched) return matched;

  const updatedExtraction: InterviewExtraction = { ...extraction, people: matched.results };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: updatedExtraction })
    .eq("id", segmentDocumentId);
  if (updateError) return { error: updateError.message };

  revalidatePath("/interviews");
  return { extraction: updatedExtraction };
}

function relationFactValue(candidate: CandidatePerson, intervieweeName: string): string {
  const parts = [candidate.dates, candidate.note].filter((v): v is string => !!v);
  const base = candidate.relation
    ? `${intervieweeName}'s ${candidate.relation}, per interview`
    : `Named in interview with ${intervieweeName}`;
  return parts.length > 0 ? `${base} · ${parts.join(" · ")}` : base;
}

export type PersonResolutionInput =
  | { action: "confirm"; personId: string }
  | { action: "create"; name: string }
  | { action: "skip" };

export type BatchConfirmSummary = {
  peopleConfirmed: number;
  peopleCreated: number;
  peopleSkipped: number;
  factsWritten: number;
  anecdotesWritten: number;
};

// The one write path for this whole feature — nothing before this touches
// facts, anecdotes, document_people, or creates a person. Processes every
// segment of a session in one pass: resolves each people[] candidate the
// caller made a decision for (confirm/create/skip — an unresolved
// multiple_matches candidate with no decision is treated as skip, same as
// leaving a document candidate unresolved), then writes every fact/
// anecdote whose "about" resolves to a real person (the interviewee
// directly, or a candidate that just got confirmed/created), each sourced
// to its own segment's document_id — not the parent session's, since
// that's the whole reason segments exist. Idempotent: already-resolved
// people and already-written facts/anecdotes (tracked via `resolution` /
// `written` markers persisted back onto the segment's own candidate_people)
// are skipped, so re-running this — e.g. after extracting a segment that
// was added later — never duplicates data.
export async function confirmInterviewBatch(
  parentDocumentId: string,
  resolutions: Record<string, PersonResolutionInput>,
): Promise<{ error: string } | { summary: BatchConfirmSummary }> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const anchor = await getIntervieweePersonId(supabase, parentDocumentId);
  if ("error" in anchor) return anchor;
  const { intervieweePersonId } = anchor;

  const { data: interviewee, error: intervieweeError } = await supabase
    .from("people")
    .select("name")
    .eq("id", intervieweePersonId)
    .single();
  if (intervieweeError || !interviewee) {
    return { error: intervieweeError?.message ?? "Interviewee not found." };
  }

  const { data: segments, error: segmentsError } = await supabase
    .from("documents")
    .select("id, kind, candidate_people")
    .eq("parent_document_id", parentDocumentId)
    .order("audio_start_seconds", { ascending: true });
  if (segmentsError || !segments) {
    return { error: segmentsError?.message ?? "Could not load segments." };
  }

  const summary: BatchConfirmSummary = {
    peopleConfirmed: 0,
    peopleCreated: 0,
    peopleSkipped: 0,
    factsWritten: 0,
    anecdotesWritten: 0,
  };

  for (const segment of segments) {
    const extraction = segment.candidate_people as unknown as InterviewExtraction | null;
    if (!extraction) continue;

    const people = [...extraction.people] as CandidateWithMatch[];
    // Index into this segment's own people[] -> the real person it
    // resolved to, for this segment's facts/anecdotes to look up below.
    const resolvedPersonId = new Map<number, string>();

    for (let i = 0; i < people.length; i++) {
      const candidate = people[i];
      if (candidate.resolution) {
        if (candidate.resolution.personId) {
          resolvedPersonId.set(i, candidate.resolution.personId);
        }
        continue;
      }

      const decision = resolutions[`${segment.id}:${i}`];
      if (!decision || decision.action === "skip") {
        people[i] = { ...candidate, resolution: { action: "skipped" } };
        summary.peopleSkipped++;
        continue;
      }

      let personId: string;
      if (decision.action === "create") {
        const created = await addFirstPerson(decision.name);
        if ("error" in created) return { error: created.error };
        personId = created.personId;
        summary.peopleCreated++;
      } else {
        personId = decision.personId;
        summary.peopleConfirmed++;
      }

      const { error: linkError } = await supabase
        .from("document_people")
        .insert({ document_id: segment.id, person_id: personId });
      if (linkError && linkError.code !== "23505") return { error: linkError.message };

      // A base "who is this person" fact, same as document confirmation
      // always writes — the interview's own richer facts[] below cover
      // everything else, but relation-to-interviewee only ever lives in
      // this candidate's own `relation` field otherwise.
      const { error: factError } = await supabase.from("facts").insert({
        person_id: personId,
        field: factFieldForRelation(candidate.relation),
        value: relationFactValue(candidate, interviewee.name),
        source_type: "firsthand",
        source_ref: `${interviewee.name} interview — ${segment.kind ?? "segment"}`,
        document_id: segment.id,
        family_id: familyId,
        recorded_at: new Date().toISOString(),
      });
      if (factError) return { error: factError.message };
      summary.factsWritten++;

      people[i] = {
        ...candidate,
        resolution: {
          action: decision.action === "create" ? "created" : "confirmed",
          personId,
        },
      };
      resolvedPersonId.set(i, personId);
    }

    function resolveTargetPersonId(aboutRef: AboutRef): string | undefined {
      if (aboutRef.type === "interviewee") return intervieweePersonId;
      if (aboutRef.type === "person") return resolvedPersonId.get(aboutRef.index);
      return undefined;
    }

    const facts = [...extraction.facts];
    for (let j = 0; j < facts.length; j++) {
      const fact = facts[j];
      if (fact.written) continue;
      const personId = resolveTargetPersonId(fact.aboutRef);
      if (!personId) continue;

      const { data: inserted, error: factError } = await supabase
        .from("facts")
        .insert({
          person_id: personId,
          field: fact.field,
          value: fact.value,
          confidence: fact.confidence,
          source_type: "firsthand",
          source_ref: `${interviewee.name} interview — ${segment.kind ?? "segment"}`,
          document_id: segment.id,
          family_id: familyId,
          recorded_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (factError || !inserted) return { error: factError?.message ?? "Could not save fact." };

      facts[j] = { ...fact, written: { factId: inserted.id } };
      summary.factsWritten++;
    }

    const anecdotes = [...extraction.anecdotes];
    for (let k = 0; k < anecdotes.length; k++) {
      const anecdote = anecdotes[k];
      if (anecdote.written) continue;
      const personId = resolveTargetPersonId(anecdote.aboutRef);
      if (!personId) continue;

      const { data: inserted, error: anecdoteError } = await supabase
        .from("anecdotes")
        .insert({
          person_id: personId,
          story_text: anecdote.storyText,
          who_told_it: interviewee.name,
          document_id: segment.id,
          family_id: familyId,
          recorded_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (anecdoteError || !inserted) {
        return { error: anecdoteError?.message ?? "Could not save anecdote." };
      }

      anecdotes[k] = { ...anecdote, written: { anecdoteId: inserted.id } };
      summary.anecdotesWritten++;
    }

    const updatedExtraction: InterviewExtraction = { people, facts, anecdotes };
    const { error: updateError } = await supabase
      .from("documents")
      .update({ candidate_people: updatedExtraction })
      .eq("id", segment.id);
    if (updateError) return { error: updateError.message };
  }

  revalidatePath("/interviews");
  revalidatePath("/tree");
  return { summary };
}

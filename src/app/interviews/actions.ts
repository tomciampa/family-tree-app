"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { transcribe } from "ai";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";

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
      .select("id, audio_start_seconds, audio_end_seconds, transcription_raw")
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
    return { id: s.id, transcript: text || "(no speech detected in this segment)" };
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

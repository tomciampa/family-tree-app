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
// those newer models. whisper-1 does support it, down to the word level.
// That makes "one whisper-1 call with word timestamps, then group words by
// which recorded [start, end) window they fall in" the practical choice
// over the fallback (extracting each segment's own audio slice via ffmpeg
// and transcribing each individually) — one API call total regardless of
// segment count, and no audio-processing binary to bundle into a Vercel
// function. The tradeoff: whisper-1's raw accuracy is a step below
// gpt-4o-transcribe (in testing it mis-heard "Ciampa" as "Chanta" on one
// take), and word-level output drops inter-word punctuation. Both are
// acceptable for this stage — nothing downstream reads this text yet.
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

  const alreadyDone = segments
    .filter((s) => s.transcription_raw)
    .map((s) => ({ id: s.id, transcript: s.transcription_raw! }));
  const pending = segments.filter((s) => !s.transcription_raw);
  if (pending.length === 0) return { segments: alreadyDone };

  const { data: fileBlob, error: downloadError } = await supabase.storage
    .from("documents")
    .download(parent.file_path);
  if (downloadError || !fileBlob) {
    return { error: downloadError?.message ?? "Could not download recording." };
  }
  const bytes = new Uint8Array(await fileBlob.arrayBuffer());

  let result;
  try {
    result = await transcribe({
      model: "openai/whisper-1",
      audio: bytes,
      providerOptions: { openai: { timestampGranularities: ["word"] } },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Transcription failed." };
  }
  const words = result.segments;

  const updates = pending.map((s) => {
    const start = s.audio_start_seconds ?? 0;
    const end = s.audio_end_seconds ?? Infinity;
    const text = words
      .filter((w) => w.startSecond >= start && w.startSecond < end)
      .map((w) => w.text)
      .join(" ")
      .trim();
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

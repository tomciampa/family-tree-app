"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";
import { addFirstPerson } from "@/app/tree/actions";
import { matchFamilyCandidates } from "@/app/documents/actions";
import type { CandidateWithMatch } from "@/app/documents/actions";
import { factFieldForRelation, type CandidatePerson } from "@/app/documents/candidate-schema";
import {
  extractEmailBodyCandidates,
  type EmailNoteExtraction,
} from "@/app/api/email-intake/email-body-extraction";
import type { AboutRef } from "@/app/interviews/extraction-schema";
import type { PersonResolutionInput, BatchConfirmSummary } from "@/app/interviews/actions";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return supabase;
}

type SupabaseClient = Awaited<ReturnType<typeof requireUser>>;

// Manual retry, for the review page's fallback button — the webhook
// already calls extractEmailBodyCandidates directly (with its own
// service-role client) as part of its own auto-chain, same pattern as
// documents/interviews auto-chaining right after upload/recording.
export async function reExtractEmailNote(
  documentId: string,
): Promise<{ error: string } | { extraction: EmailNoteExtraction }> {
  const supabase = await requireUser();
  return extractEmailBodyCandidates(supabase, documentId);
}

// Anchor-free, same as matchCandidatesForDocument — there's no known
// "already in the tree" person for an email the way an interview has its
// interviewee, so every candidate is matched purely on name/date/
// relationship signal.
export async function matchEmailNoteCandidates(
  documentId: string,
): Promise<{ error: string } | { extraction: EmailNoteExtraction }> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();
  return matchEmailNoteCandidatesWith(supabase, familyId, documentId);
}

export async function matchEmailNoteCandidatesWith(
  supabase: SupabaseClient,
  familyId: string,
  documentId: string,
): Promise<{ error: string } | { extraction: EmailNoteExtraction }> {
  const { data: document, error: fetchError } = await supabase
    .from("documents")
    .select("candidate_people")
    .eq("id", documentId)
    .single();
  if (fetchError || !document) {
    return { error: fetchError?.message ?? "Email note not found." };
  }

  const extraction = document.candidate_people as unknown as EmailNoteExtraction | null;
  if (!extraction) return { error: "Extract candidates before matching." };

  const matched = await matchFamilyCandidates(supabase, familyId, extraction.people as CandidatePerson[]);
  if ("error" in matched) {
    await supabase.from("documents").update({ extraction_error: matched.error }).eq("id", documentId);
    return matched;
  }

  const updatedExtraction: EmailNoteExtraction = { ...extraction, people: matched.results };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: updatedExtraction, extraction_error: null })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  revalidatePath(`/email-notes/${documentId}`);
  return { extraction: updatedExtraction };
}

function relationFactValue(candidate: CandidatePerson, sourceLabel: string): string {
  const parts = [candidate.dates, candidate.note].filter((v): v is string => !!v);
  const base = candidate.relation
    ? `${candidate.relation}, per ${sourceLabel}`
    : `Named in ${sourceLabel}`;
  return parts.length > 0 ? `${base} · ${parts.join(" · ")}` : base;
}

function formatDateLabel(recordedAt: string | null): string {
  if (!recordedAt) return "unknown date";
  const d = new Date(recordedAt);
  if (Number.isNaN(d.getTime())) return "unknown date";
  return d.toISOString().slice(0, 10);
}

// Builds the source_ref every fact/anecdote/base-identity fact from this
// email gets, e.g. "email from Jane Doe, 2026-07-15" — optionally with a
// trailing " — date inferred from relative reference 'yesterday'" clause
// when the extraction flagged a computed date (see dateInferenceNote in
// email-body-extraction.ts). Deliberately never touches `confidence`,
// which stays purely about whether the sender hedged the claim itself.
function buildSourceRef(
  submittedByName: string | null,
  submittedByEmail: string | null,
  dateLabel: string,
  dateInferenceNote?: string | null,
): string {
  const who = submittedByName || submittedByEmail || "unknown sender";
  const base = `email from ${who}, ${dateLabel}`;
  return dateInferenceNote ? `${base} — ${dateInferenceNote}` : base;
}

// The one write path for the email-body-note pipeline — mirrors
// confirmInterviewBatch's shape (resolve each people[] candidate the
// caller made a decision for, then write every fact/anecdote whose
// "about" resolves to a real person) but for a single document rather
// than looping over an interview's segments, since an email-body-note
// row has no children of its own. Idempotent the same way: already-
// resolved people and already-written facts/anecdotes are tracked via
// `resolution`/`written` markers persisted back onto candidate_people, so
// re-running this never duplicates data.
export async function confirmEmailNoteBatch(
  documentId: string,
  resolutions: Record<string, PersonResolutionInput>,
): Promise<{ error: string } | { summary: BatchConfirmSummary }> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { data: document, error: fetchError } = await supabase
    .from("documents")
    .select("candidate_people, submitted_by_name, submitted_by_email, recorded_at")
    .eq("id", documentId)
    .single();
  if (fetchError || !document) {
    return { error: fetchError?.message ?? "Email note not found." };
  }

  const extraction = document.candidate_people as unknown as EmailNoteExtraction | null;
  const summary: BatchConfirmSummary = {
    peopleConfirmed: 0,
    peopleCreated: 0,
    peopleSkipped: 0,
    factsWritten: 0,
    anecdotesWritten: 0,
  };
  if (!extraction) return { summary };

  const dateLabel = formatDateLabel(document.recorded_at);
  const sourceLabel = `email, ${dateLabel}`;
  const baseSourceRef = buildSourceRef(document.submitted_by_name, document.submitted_by_email, dateLabel);

  const people = [...extraction.people] as CandidateWithMatch[];
  const resolvedPersonId = new Map<number, string>();

  for (let i = 0; i < people.length; i++) {
    const candidate = people[i];
    if (candidate.resolution) {
      if (candidate.resolution.personId) {
        resolvedPersonId.set(i, candidate.resolution.personId);
      }
      continue;
    }

    const decision = resolutions[`${documentId}:${i}`];
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
      .insert({ document_id: documentId, person_id: personId });
    if (linkError && linkError.code !== "23505") return { error: linkError.message };

    const { error: factError } = await supabase.from("facts").insert({
      person_id: personId,
      field: factFieldForRelation(candidate.relation),
      value: relationFactValue(candidate, sourceLabel),
      source_type: "email",
      source_ref: baseSourceRef,
      document_id: documentId,
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
        source_type: "email",
        source_ref: buildSourceRef(
          document.submitted_by_name,
          document.submitted_by_email,
          dateLabel,
          fact.dateInferenceNote,
        ),
        document_id: documentId,
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
        who_told_it: document.submitted_by_name || document.submitted_by_email || "unknown sender",
        document_id: documentId,
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

  const updatedExtraction: EmailNoteExtraction = { people, facts, anecdotes };
  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: updatedExtraction })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  revalidatePath(`/email-notes/${documentId}`);
  revalidatePath("/tree");
  revalidatePath("/");
  return { summary };
}

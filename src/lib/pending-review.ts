import type { createClient } from "@/lib/supabase/server";
import type { CandidateWithMatch } from "@/app/documents/actions";
import { normalizeDocumentExtraction, type DocumentExtraction } from "@/app/documents/document-extraction-schema";
import type { InterviewExtraction } from "@/app/interviews/actions";
import type { EmailNoteExtraction } from "@/app/api/email-intake/email-body-extraction";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type PendingDocumentItem = {
  id: string;
  filename: string | null;
  unresolvedCount: number;
  totalCount: number;
};

export type PendingInterviewItem = {
  id: string;
  intervieweeName: string;
  unresolvedCount: number;
};

export type PendingEmailNoteItem = {
  id: string;
  senderName: string | null;
  senderEmail: string | null;
  unresolvedCount: number;
};

// A possible exact-duplicate flagged for review — only ever surfaced for
// email-sourced uploads (see content_hash_dedup migration): a web upload
// with a matching hash is let through silently, no review item at all.
export type PendingDuplicateItem = {
  id: string;
  kind: "document" | "photo";
  label: string | null;
  originalUploadedAt: string | null;
  reviewHref: string;
};

export type PendingReview = {
  documents: PendingDocumentItem[];
  interviews: PendingInterviewItem[];
  emailNotes: PendingEmailNoteItem[];
  possibleDuplicates: PendingDuplicateItem[];
};

// Central "what's waiting on a human decision" view — reuses the exact
// same `documents` rows and unresolved-candidate check /documents and
// /interviews already compute per row (documents-view.tsx's
// unresolvedCount, confirmInterviewBatch's resolution/written markers),
// just applied across every row instead of one. No new status column or
// tracking table; both pipelines already auto-process up to this point
// (see documents' auto-extract+match and interviews' auto-transcribe+
// extract+match), so "pending" here always means genuinely waiting on a
// person, never still mid-pipeline.
export async function getPendingReview(
  supabase: SupabaseClient,
): Promise<PendingReview> {
  const [
    { data: plainDocuments },
    { data: sessions },
    { data: segments },
    { data: emailNoteRows },
    { data: people },
    { data: duplicateDocuments },
    { data: duplicatePhotos },
  ] = await Promise.all([
    supabase
      .from("documents")
      .select("id, filename, candidate_people")
      .is("interviewee_person_id", null)
      .is("parent_document_id", null)
      // Excludes email-body-note rows (their candidate_people is a
      // {people,facts,anecdotes} extraction with different submitted_by_*
      // display fields, handled separately below) — needs its own
      // exclusion since the two null checks above don't distinguish this
      // case. See documents/page.tsx's identical filter.
      .eq("is_email_body_note", false),
    supabase
      .from("documents")
      .select("id, interviewee_person_id")
      .not("interviewee_person_id", "is", null),
    supabase
      .from("documents")
      .select("id, parent_document_id, candidate_people")
      .not("parent_document_id", "is", null),
    supabase
      .from("documents")
      .select("id, submitted_by_name, submitted_by_email, candidate_people")
      .eq("is_email_body_note", true),
    supabase.from("people").select("id, name"),
    // Possible-duplicate documents (see content_hash_dedup migration) —
    // only email-sourced ones are ever surfaced; a web upload records
    // duplicate_of_id too but is never flagged (see uploadDocument).
    supabase
      .from("documents")
      .select("id, filename, duplicate_of_id")
      .eq("source", "email")
      .not("duplicate_of_id", "is", null)
      .is("interviewee_person_id", null)
      .is("parent_document_id", null)
      .eq("is_email_body_note", false),
    supabase
      .from("photos")
      .select("id, original_filename, duplicate_of_id")
      .eq("source", "email")
      .not("duplicate_of_id", "is", null),
  ]);

  const peopleById = new Map((people ?? []).map((p) => [p.id, p.name]));

  const documents: PendingDocumentItem[] = [];
  for (const doc of plainDocuments ?? []) {
    // candidate_people is now { people, facts, anecdotes } for plain
    // documents too (previously a bare CandidatePerson[] — see the
    // document-extraction facts/anecdotes feature). Counted here by
    // candidates only, same as before: resolving a candidate always
    // writes its own attributed facts/anecdotes as part of that same
    // action (confirmCandidateMatch/createPersonForCandidate), so once
    // every family candidate is resolved there's nothing left pending —
    // a fact/anecdote only stays permanently unwritten if its candidate
    // was skipped or its aboutRef never resolved, both final states, not
    // "still pending".
    const extraction = normalizeDocumentExtraction<CandidateWithMatch>(doc.candidate_people);
    const familyCandidates = extraction.people.filter(
      (c) => c.roleCategory === "family",
    );
    const unresolvedCount = familyCandidates.filter(
      (c) => !c.resolution,
    ).length;
    if (unresolvedCount > 0) {
      documents.push({
        id: doc.id,
        filename: doc.filename,
        unresolvedCount,
        totalCount: familyCandidates.length,
      });
    }
  }

  type SegmentRow = NonNullable<typeof segments>[number];
  const segmentsByParent = new Map<string, SegmentRow[]>();
  for (const seg of segments ?? []) {
    if (!seg.parent_document_id) continue;
    const list = segmentsByParent.get(seg.parent_document_id) ?? [];
    list.push(seg);
    segmentsByParent.set(seg.parent_document_id, list);
  }

  const interviews: PendingInterviewItem[] = [];
  for (const session of sessions ?? []) {
    const sessionSegments = segmentsByParent.get(session.id) ?? [];
    let unresolvedCount = 0;
    let hasExtraction = false;
    for (const seg of sessionSegments) {
      const extraction =
        seg.candidate_people as unknown as InterviewExtraction | null;
      if (!extraction) continue;
      hasExtraction = true;
      unresolvedCount += extraction.people.filter(
        (p) =>
          p.roleCategory === "family" &&
          !("resolution" in p && p.resolution),
      ).length;
      unresolvedCount += extraction.facts.filter((f) => !f.written).length;
      unresolvedCount += extraction.anecdotes.filter((a) => !a.written).length;
    }
    if (hasExtraction && unresolvedCount > 0) {
      interviews.push({
        id: session.id,
        intervieweeName: session.interviewee_person_id
          ? (peopleById.get(session.interviewee_person_id) ?? "Unknown")
          : "Unknown",
        unresolvedCount,
      });
    }
  }

  // Same unresolved-counting shape as the interview loop above — an
  // email-body-note row's candidate_people is the same
  // {people, facts, anecdotes} extraction, just with a single flat batch
  // instead of per-segment ones.
  const emailNotes: PendingEmailNoteItem[] = [];
  for (const note of emailNoteRows ?? []) {
    const extraction = note.candidate_people as unknown as EmailNoteExtraction | null;
    if (!extraction) continue;
    let unresolvedCount = extraction.people.filter(
      (p) => p.roleCategory === "family" && !("resolution" in p && p.resolution),
    ).length;
    unresolvedCount += extraction.facts.filter((f) => !f.written).length;
    unresolvedCount += extraction.anecdotes.filter((a) => !a.written).length;
    if (unresolvedCount > 0) {
      emailNotes.push({
        id: note.id,
        senderName: note.submitted_by_name,
        senderEmail: note.submitted_by_email,
        unresolvedCount,
      });
    }
  }

  // The "uploaded on [date]" message needs the ORIGINAL row's own date,
  // not the duplicate's — one follow-up batch fetch per table for
  // whichever original ids are actually referenced, rather than an N+1
  // query per flagged item.
  const originalDocIds = [...new Set((duplicateDocuments ?? []).map((d) => d.duplicate_of_id!))];
  const originalPhotoIds = [...new Set((duplicatePhotos ?? []).map((p) => p.duplicate_of_id!))];
  const [{ data: originalDocs }, { data: originalPhotos }] = await Promise.all([
    originalDocIds.length > 0
      ? supabase.from("documents").select("id, recorded_at").in("id", originalDocIds)
      : Promise.resolve({ data: [] as { id: string; recorded_at: string | null }[] }),
    originalPhotoIds.length > 0
      ? supabase.from("photos").select("id, created_at").in("id", originalPhotoIds)
      : Promise.resolve({ data: [] as { id: string; created_at: string | null }[] }),
  ]);
  const originalDocDateById = new Map((originalDocs ?? []).map((d) => [d.id, d.recorded_at]));
  const originalPhotoDateById = new Map((originalPhotos ?? []).map((p) => [p.id, p.created_at]));

  const possibleDuplicates: PendingDuplicateItem[] = [
    ...(duplicateDocuments ?? []).map((d) => ({
      id: d.id,
      kind: "document" as const,
      label: d.filename,
      originalUploadedAt: originalDocDateById.get(d.duplicate_of_id!) ?? null,
      reviewHref: `/documents/${d.id}`,
    })),
    ...(duplicatePhotos ?? []).map((p) => ({
      id: p.id,
      kind: "photo" as const,
      label: p.original_filename,
      originalUploadedAt: originalPhotoDateById.get(p.duplicate_of_id!) ?? null,
      reviewHref: `/photos/compare/${p.id}`,
    })),
  ];

  return { documents, interviews, emailNotes, possibleDuplicates };
}

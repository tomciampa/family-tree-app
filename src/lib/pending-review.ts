import type { createClient } from "@/lib/supabase/server";
import type { CandidatePerson } from "@/app/documents/documents-view";
import type { InterviewExtraction } from "@/app/interviews/actions";

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

export type PendingReview = {
  documents: PendingDocumentItem[];
  interviews: PendingInterviewItem[];
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
    { data: people },
  ] = await Promise.all([
    supabase
      .from("documents")
      .select("id, filename, candidate_people")
      .is("interviewee_person_id", null)
      .is("parent_document_id", null),
    supabase
      .from("documents")
      .select("id, interviewee_person_id")
      .not("interviewee_person_id", "is", null),
    supabase
      .from("documents")
      .select("id, parent_document_id, candidate_people")
      .not("parent_document_id", "is", null),
    supabase.from("people").select("id, name"),
  ]);

  const peopleById = new Map((people ?? []).map((p) => [p.id, p.name]));

  const documents: PendingDocumentItem[] = [];
  for (const doc of plainDocuments ?? []) {
    const candidates = (doc.candidate_people ??
      []) as unknown as CandidatePerson[];
    const familyCandidates = candidates.filter(
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

  return { documents, interviews };
}

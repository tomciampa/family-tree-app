import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId, buildPersonSummaries } from "@/lib/family";
import { getSignedDocumentUrls } from "@/lib/documents";
import { InterviewsView, type InterviewRow, type SegmentRow } from "./interviews-view";
import type { InterviewExtraction } from "./actions";

export default async function InterviewsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const familyId = await getFamilyId();

  const [
    { data: sessions, error },
    { data: allSegments },
    { data: people },
    { data: unions },
    { data: unionChildren },
  ] = await Promise.all([
    supabase
      .from("documents")
      .select(
        "id, filename, file_path, recorded_at, interviewee_person_id, transcription_raw",
      )
      .not("interviewee_person_id", "is", null)
      .order("recorded_at", { ascending: false }),
    supabase
      .from("documents")
      .select(
        "id, parent_document_id, kind, audio_start_seconds, audio_end_seconds, transcription_raw, candidate_people",
      )
      .not("parent_document_id", "is", null)
      .order("audio_start_seconds", { ascending: true }),
    supabase.from("people").select("*"),
    supabase.from("unions").select("*"),
    supabase.from("union_children").select("*"),
  ]);

  const urlByPath = await getSignedDocumentUrls(
    supabase,
    (sessions ?? []).map((s) => s.file_path),
  );
  const peopleById = new Map((people ?? []).map((p) => [p.id, p]));
  const segmentsByParent = new Map<string, SegmentRow[]>();
  for (const seg of allSegments ?? []) {
    if (!seg.parent_document_id) continue;
    const list = segmentsByParent.get(seg.parent_document_id) ?? [];
    list.push({
      ...seg,
      candidate_people: seg.candidate_people as unknown as InterviewExtraction | null,
    });
    segmentsByParent.set(seg.parent_document_id, list);
  }
  const sessionsWithDetails: InterviewRow[] = (sessions ?? []).map((s) => ({
    ...s,
    intervieweeName: s.interviewee_person_id
      ? (peopleById.get(s.interviewee_person_id)?.name ?? "Unknown")
      : "Unknown",
    playUrl: urlByPath.get(s.file_path) ?? null,
    segments: segmentsByParent.get(s.id) ?? [],
  }));

  const personSummaries = Object.fromEntries(
    buildPersonSummaries(people ?? [], unions ?? [], unionChildren ?? []),
  );

  return (
    <main className="flex min-h-screen flex-col gap-6 p-8 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-[length:var(--font-size-heading-2)] leading-[var(--line-height-heading-2)] font-semibold">
          Interviews
        </h1>
        <Link
          href="/"
          className="text-sm text-[color:var(--color-text-secondary)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
        >
          Home
        </Link>
      </div>

      {error && (
        <p className="mx-auto text-sm text-[color:var(--color-error)]">{error.message}</p>
      )}

      {!error && (
        <InterviewsView
          sessions={sessionsWithDetails}
          people={people ?? []}
          personSummaries={personSummaries}
          familyId={familyId}
        />
      )}
    </main>
  );
}

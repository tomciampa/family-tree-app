import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSignedDocumentUrls } from "@/lib/documents";
import { buildPersonSummaries } from "@/lib/family";
import type { InterviewExtraction } from "../actions";
import { InterviewReview, type ReviewSegment } from "./interview-review";

export default async function InterviewReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [
    { data: session, error },
    { data: segments, error: segmentsError },
    { data: people },
    { data: unions },
    { data: unionChildren },
  ] = await Promise.all([
    supabase
      .from("documents")
      .select("id, filename, file_path, recorded_at, interviewee_person_id")
      .eq("id", id)
      .single(),
    supabase
      .from("documents")
      .select(
        "id, kind, audio_start_seconds, audio_end_seconds, transcription_raw, candidate_people",
      )
      .eq("parent_document_id", id)
      .order("audio_start_seconds", { ascending: true }),
    supabase.from("people").select("*"),
    supabase.from("unions").select("*"),
    supabase.from("union_children").select("*"),
  ]);

  if (error || !session || segmentsError) {
    notFound();
  }

  const urlByPath = await getSignedDocumentUrls(supabase, [session.file_path]);
  const audioUrl = urlByPath.get(session.file_path) ?? null;

  const intervieweeName =
    (people ?? []).find((p) => p.id === session.interviewee_person_id)?.name ?? "Unknown";

  const reviewSegments: ReviewSegment[] = (segments ?? []).map((s) => ({
    ...s,
    extraction: s.candidate_people as unknown as InterviewExtraction | null,
  }));

  const personSummaries = Object.fromEntries(
    buildPersonSummaries(people ?? [], unions ?? [], unionChildren ?? []),
  );

  return (
    <main className="flex min-h-screen flex-col gap-4 p-6 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <Link
          href="/interviews"
          className="text-sm text-[color:var(--color-text-secondary)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
        >
          ← Interviews
        </Link>
        <Link
          href="/"
          className="text-sm text-[color:var(--color-text-secondary)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
        >
          Home
        </Link>
      </div>

      <InterviewReview
        parentId={session.id}
        intervieweeName={intervieweeName}
        audioUrl={audioUrl}
        segments={reviewSegments}
        people={people ?? []}
        unions={unions ?? []}
        unionChildren={unionChildren ?? []}
        personSummaries={personSummaries}
      />
    </main>
  );
}

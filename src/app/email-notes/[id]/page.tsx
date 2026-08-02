import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { buildPersonSummaries } from "@/lib/family";
import type { EmailNoteExtraction } from "@/app/api/email-intake/email-body-extraction";
import { EmailNoteReview } from "./email-note-review";

export default async function EmailNoteReviewPage({
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
    { data: note, error },
    { data: people },
    { data: unions },
    { data: unionChildren },
  ] = await Promise.all([
    supabase
      .from("documents")
      .select(
        "id, recorded_at, submitted_by_name, submitted_by_email, email_subject, transcription_raw, candidate_people, extraction_error, is_email_body_note",
      )
      .eq("id", id)
      .single(),
    supabase.from("people").select("*"),
    supabase.from("unions").select("*"),
    supabase.from("union_children").select("*"),
  ]);

  // Symmetric with documents/[id]/page.tsx's redirect the other way — a
  // stale/guessed link to a normal document's id must never render here,
  // since this page assumes the { people, facts, anecdotes } extraction
  // shape rather than CandidatePerson[].
  if (error || !note || !note.is_email_body_note) {
    notFound();
  }

  const extraction = note.candidate_people as unknown as EmailNoteExtraction | null;
  const personSummaries = Object.fromEntries(
    buildPersonSummaries(people ?? [], unions ?? [], unionChildren ?? []),
  );

  return (
    <main className="flex min-h-screen flex-col gap-4 p-6 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <Link
          href="/"
          className="text-sm text-[color:var(--color-text-secondary)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
        >
          ← Home
        </Link>
      </div>

      <EmailNoteReview
        documentId={note.id}
        senderName={note.submitted_by_name}
        senderEmail={note.submitted_by_email}
        subject={note.email_subject}
        recordedAt={note.recorded_at}
        bodyText={note.transcription_raw}
        extraction={extraction}
        extractionError={note.extraction_error}
        people={people ?? []}
        unions={unions ?? []}
        unionChildren={unionChildren ?? []}
        personSummaries={personSummaries}
      />
    </main>
  );
}

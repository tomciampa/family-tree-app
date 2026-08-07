import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSignedDocumentUrls } from "@/lib/documents";
import { buildPersonSummaries } from "@/lib/family";
import { DocumentReview } from "./document-review";
import type { CandidateWithMatch } from "../actions";
import type { DocumentExtraction } from "../document-extraction-schema";

export default async function DocumentReviewPage({
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
    { data: document, error },
    { data: people },
    { data: unions },
    { data: unionChildren },
  ] = await Promise.all([
    supabase
      .from("documents")
      .select(
        "id, filename, file_path, document_type, status, recorded_at, candidate_people, transcription_raw, is_email_body_note, duplicate_of_id",
      )
      .eq("id", id)
      .single(),
    supabase.from("people").select("*"),
    supabase.from("unions").select("*"),
    supabase.from("union_children").select("*"),
  ]);

  if (error || !document) {
    notFound();
  }

  // An email-body-note row's candidate_people is now the same
  // { people, facts, anecdotes } shape this page itself expects (see the
  // document-extraction facts/anecdotes feature) — the redirect below is
  // no longer about a shape mismatch, but the row itself has different
  // columns (submitted_by_name/submitted_by_email, no file_path/
  // document_type the same way) and its own dedicated review page/layout
  // (email-note-review.tsx). Redirect there instead of rendering the
  // wrong UI on a stale/guessed link.
  if (document.is_email_body_note) {
    redirect(`/email-notes/${id}`);
  }

  const urlByPath = await getSignedDocumentUrls(supabase, [document.file_path]);
  const viewUrl = urlByPath.get(document.file_path) ?? null;

  // Possible-duplicate banner (see content_hash_dedup migration) — only
  // ever meaningful here for an email-sourced document (a web upload's
  // duplicate_of_id is recorded but never surfaced anywhere in the UI).
  let duplicateOf: { id: string; filename: string | null; recordedAt: string | null } | null = null;
  if (document.duplicate_of_id) {
    const { data: original } = await supabase
      .from("documents")
      .select("id, filename, recorded_at")
      .eq("id", document.duplicate_of_id)
      .maybeSingle();
    if (original) {
      duplicateOf = { id: original.id, filename: original.filename, recordedAt: original.recorded_at };
    }
  }

  const personSummaries = Object.fromEntries(
    buildPersonSummaries(people ?? [], unions ?? [], unionChildren ?? []),
  );

  return (
    <main className="flex min-h-screen flex-col gap-4 p-6 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <Link
          href="/documents"
          className="text-sm text-[color:var(--color-text-secondary)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
        >
          ← Documents
        </Link>
        <Link
          href="/"
          className="text-sm text-[color:var(--color-text-secondary)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
        >
          Home
        </Link>
      </div>

      <DocumentReview
        doc={{
          ...document,
          candidate_people: document.candidate_people as unknown as DocumentExtraction<CandidateWithMatch> | null,
          viewUrl,
        }}
        duplicateOf={duplicateOf}
        people={people ?? []}
        unions={unions ?? []}
        unionChildren={unionChildren ?? []}
        personSummaries={personSummaries}
      />
    </main>
  );
}

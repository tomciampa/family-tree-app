import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSignedDocumentUrls } from "@/lib/documents";
import { buildPersonSummaries } from "@/lib/family";
import { DocumentReview } from "./document-review";
import type { CandidatePerson } from "../documents-view";

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
        "id, filename, file_path, document_type, status, recorded_at, candidate_people, transcription_raw",
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

  const urlByPath = await getSignedDocumentUrls(supabase, [document.file_path]);
  const viewUrl = urlByPath.get(document.file_path) ?? null;

  const personSummaries = Object.fromEntries(
    buildPersonSummaries(people ?? [], unions ?? [], unionChildren ?? []),
  );

  return (
    <main className="flex min-h-screen flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <Link href="/documents" className="text-sm text-gray-500 underline">
          ← Documents
        </Link>
        <Link href="/" className="text-sm text-gray-500 underline">
          Home
        </Link>
      </div>

      <DocumentReview
        doc={{
          ...document,
          candidate_people: document.candidate_people as unknown as CandidatePerson[] | null,
          viewUrl,
        }}
        people={people ?? []}
        unions={unions ?? []}
        unionChildren={unionChildren ?? []}
        personSummaries={personSummaries}
      />
    </main>
  );
}

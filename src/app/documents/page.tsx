import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSignedDocumentUrls } from "@/lib/documents";
import { DocumentsView, type DocumentRow } from "./documents-view";

export default async function DocumentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: documents, error } = await supabase
    .from("documents")
    .select("id, filename, file_path, status, recorded_at, candidate_people")
    // Interview recordings/segments live in this same table (see
    // interviews/actions.ts) but shape candidate_people as an
    // { facts, people, anecdotes } extraction object rather than this
    // page's CandidatePerson[] — they're never candidates for the
    // document-matching workflow (already linked via
    // interviewee_person_id/parent_document_id), so exclude them here
    // rather than in every consumer of this query's result.
    .is("interviewee_person_id", null)
    .is("parent_document_id", null)
    .order("recorded_at", { ascending: false });

  const urlByPath = await getSignedDocumentUrls(
    supabase,
    (documents ?? []).map((d) => d.file_path),
  );
  const documentsWithUrls = (documents ?? []).map((d) => ({
    ...d,
    viewUrl: urlByPath.get(d.file_path) ?? null,
  }));

  return (
    <main className="flex min-h-screen flex-col gap-6 p-8">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-2xl font-semibold">Documents</h1>
        <Link href="/" className="text-sm text-gray-500 underline">
          Home
        </Link>
      </div>

      {error && (
        <p className="mx-auto text-sm text-red-500">{error.message}</p>
      )}

      {!error && (
        <DocumentsView documents={documentsWithUrls as unknown as DocumentRow[]} />
      )}
    </main>
  );
}

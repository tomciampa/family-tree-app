import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSignedDocumentUrls } from "@/lib/documents";
import { buildPersonSummaries } from "@/lib/family";
import { DocumentsView, type DocumentRow } from "./documents-view";

export default async function DocumentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [
    { data: documents, error },
    { data: people },
    { data: unions },
    { data: unionChildren },
  ] = await Promise.all([
    supabase
      .from("documents")
      .select("id, filename, file_path, status, recorded_at, candidate_people")
      .order("recorded_at", { ascending: false }),
    supabase.from("people").select("*"),
    supabase.from("unions").select("*"),
    supabase.from("union_children").select("*"),
  ]);

  const urlByPath = await getSignedDocumentUrls(
    supabase,
    (documents ?? []).map((d) => d.file_path),
  );
  const documentsWithUrls = (documents ?? []).map((d) => ({
    ...d,
    viewUrl: urlByPath.get(d.file_path) ?? null,
  }));

  // Candidate matches only carry a personId/personName — this gives the
  // review UI enough context (dates, recorded parents/spouse) to actually
  // tell same-named people apart, reusing data already fetched here rather
  // than adding new columns to candidate_people itself.
  const personSummaries = Object.fromEntries(
    buildPersonSummaries(people ?? [], unions ?? [], unionChildren ?? []),
  );

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
        <DocumentsView
          documents={documentsWithUrls as unknown as DocumentRow[]}
          personSummaries={personSummaries}
        />
      )}
    </main>
  );
}

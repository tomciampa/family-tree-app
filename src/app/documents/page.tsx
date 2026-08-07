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
    // interviews/actions.ts) — they're never candidates for the
    // document-matching workflow (already linked via
    // interviewee_person_id/parent_document_id), so exclude them here
    // rather than in every consumer of this query's result. (Their
    // candidate_people is the same { people, facts, anecdotes } shape
    // plain documents now also use — this exclusion is about them being a
    // structurally different kind of row, not a JSON-shape mismatch
    // anymore.)
    .is("interviewee_person_id", null)
    .is("parent_document_id", null)
    // Email-body-note rows (see the email_body_facts migration) also live
    // here with both of the above null — a different kind of row (its own
    // review page, different display columns) needing its own explicit
    // exclusion since interviewee_person_id/parent_document_id being null
    // doesn't distinguish this case.
    .eq("is_email_body_note", false)
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
    <main className="flex min-h-screen flex-col gap-6 p-8 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-[length:var(--font-size-heading-2)] leading-[var(--line-height-heading-2)] font-semibold">
          Documents
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
        <DocumentsView documents={documentsWithUrls as unknown as DocumentRow[]} />
      )}
    </main>
  );
}

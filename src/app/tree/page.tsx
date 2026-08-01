import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSignedDocumentUrls } from "@/lib/documents";
import { buildPersonSummaries, getFamilyId } from "@/lib/family";
import { TreeView } from "./tree-view";
import { AddFirstPersonForm } from "./add-first-person-form";
import type { PersonPhoto } from "./person-dossier";

export default async function TreePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const familyId = await getFamilyId();

  const [
    { data: people, error: peopleError },
    { data: unions, error: unionsError },
    { data: unionChildren, error: unionChildrenError },
    { data: facts, error: factsError },
    { data: anecdotes, error: anecdotesError },
    { data: documentLinks, error: documentLinksError },
    { data: photoLinks, error: photoLinksError },
    { data: membership },
  ] = await Promise.all([
    supabase.from("people").select("*").order("created_at"),
    supabase.from("unions").select("*").order("created_at"),
    supabase.from("union_children").select("*"),
    supabase.from("facts").select("*").order("recorded_at"),
    supabase.from("anecdotes").select("*").order("recorded_at"),
    supabase
      .from("document_people")
      .select("person_id, documents(id, filename, file_path, document_type)"),
    supabase
      .from("photo_tags")
      .select("person_id, photos(id, storage_path, original_filename, caption)"),
    // Not part of the `error` union below — a missing/failed lookup here
    // should never block rendering the tree, just fall through to
    // pickDefaultMain's existing behavior (see FamilyTree's own comment).
    supabase
      .from("family_members")
      .select("linked_person_id")
      .eq("family_id", familyId)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  const error =
    peopleError ??
    unionsError ??
    unionChildrenError ??
    factsError ??
    anecdotesError ??
    documentLinksError ??
    photoLinksError;

  const urlByPath = await getSignedDocumentUrls(
    supabase,
    (documentLinks ?? [])
      .map((l) => l.documents?.file_path)
      .filter((p): p is string => !!p),
  );
  const personDocuments = (documentLinks ?? [])
    .filter((l) => l.documents)
    .map((l) => ({
      personId: l.person_id,
      id: l.documents!.id,
      filename: l.documents!.filename,
      documentType: l.documents!.document_type,
      viewUrl: urlByPath.get(l.documents!.file_path) ?? null,
    }));

  // Own separate signed-url fetch, same reasoning as photos/page.tsx —
  // photos live in their own "photos" bucket, not "documents", so
  // getSignedDocumentUrls (hardcoded to that bucket) doesn't apply here.
  const photoPaths = (photoLinks ?? [])
    .map((l) => l.photos?.storage_path)
    .filter((p): p is string => !!p);
  let photoUrlByPath = new Map<string, string>();
  if (photoPaths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("photos")
      .createSignedUrls([...new Set(photoPaths)], 3600);
    if (signed) {
      photoUrlByPath = new Map(
        signed
          .filter((s): s is typeof s & { signedUrl: string; path: string } => !!s.signedUrl && !!s.path)
          .map((s) => [s.path, s.signedUrl]),
      );
    }
  }
  const personPhotos: (PersonPhoto & { personId: string })[] = (photoLinks ?? [])
    .filter((l) => l.photos)
    .map((l) => ({
      personId: l.person_id,
      id: l.photos!.id,
      originalFilename: l.photos!.original_filename,
      caption: l.photos!.caption,
      viewUrl: photoUrlByPath.get(l.photos!.storage_path) ?? null,
    }));

  // For the "search for an existing person instead of creating a new
  // one" option in the add-relative forms — same disambiguating context
  // (dates, current relationships) the document-matching review already
  // uses, and the same safety-check data (does this person already have
  // recorded parents?) those forms need before linking someone in as a
  // child a second time.
  const personSummaries = Object.fromEntries(
    buildPersonSummaries(people ?? [], unions ?? [], unionChildren ?? []),
  );

  return (
    <main className="flex min-h-screen flex-col gap-6 p-8">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between">
        <h1 className="text-2xl font-semibold">Family Tree</h1>
        <Link href="/" className="text-sm text-gray-500 underline">
          Home
        </Link>
      </div>

      {error && (
        <p className="mx-auto text-sm text-red-500">{error.message}</p>
      )}

      {!error && people && people.length === 0 && <AddFirstPersonForm />}

      {!error && people && people.length > 0 && (
        <TreeView
          people={people}
          unions={unions ?? []}
          unionChildren={unionChildren ?? []}
          facts={facts ?? []}
          anecdotes={anecdotes ?? []}
          personDocuments={personDocuments}
          personPhotos={personPhotos}
          personSummaries={personSummaries}
          defaultMainPersonId={membership?.linked_person_id ?? null}
        />
      )}
    </main>
  );
}

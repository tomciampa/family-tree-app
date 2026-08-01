import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PhotosView, type PhotoRow } from "./photos-view";

export default async function PhotosPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: photos, error } = await supabase
    .from("photos")
    .select("id, storage_path, original_filename, caption, taken_at, created_at")
    .order("created_at", { ascending: false });

  // Deliberately not reusing lib/documents.ts's getSignedDocumentUrls —
  // it's hardcoded to the "documents" bucket, and photos live in their
  // own separate "photos" bucket (see the Stage 1 migration). A small,
  // dedicated fetch here rather than widening that shared helper's
  // surface for six existing call sites that don't need it.
  const paths = (photos ?? []).map((p) => p.storage_path);
  let urlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("photos")
      .createSignedUrls(paths, 3600);
    if (signed) {
      urlByPath = new Map(
        signed
          .filter((s): s is typeof s & { signedUrl: string; path: string } => !!s.signedUrl && !!s.path)
          .map((s) => [s.path, s.signedUrl]),
      );
    }
  }

  const photosWithUrls: PhotoRow[] = (photos ?? []).map((p) => ({
    ...p,
    viewUrl: urlByPath.get(p.storage_path) ?? null,
  }));

  return (
    <main className="flex min-h-screen flex-col gap-6 p-8 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between">
        <h1 className="text-[length:var(--font-size-heading-2)] leading-[var(--line-height-heading-2)] font-semibold">
          Photos
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

      {!error && <PhotosView photos={photosWithUrls} />}
    </main>
  );
}

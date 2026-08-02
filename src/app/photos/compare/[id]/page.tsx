import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PhotoCompareView, type ComparePhoto } from "./photo-compare-view";

export default async function PhotoComparePage({
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

  const { data: newPhoto, error } = await supabase
    .from("photos")
    .select("id, storage_path, original_filename, created_at, source, submitted_by_name, submitted_by_email, duplicate_of_id")
    .eq("id", id)
    .single();

  // This page only exists to review a flagged possible duplicate — a
  // stale/guessed link to a photo with no duplicate_of_id has nothing to
  // compare against.
  if (error || !newPhoto || !newPhoto.duplicate_of_id) {
    notFound();
  }

  const { data: originalPhoto } = await supabase
    .from("photos")
    .select("id, storage_path, original_filename, created_at, source, submitted_by_name, submitted_by_email")
    .eq("id", newPhoto.duplicate_of_id)
    .maybeSingle();

  if (!originalPhoto) {
    notFound();
  }

  const { data: signed } = await supabase.storage
    .from("photos")
    .createSignedUrls([newPhoto.storage_path, originalPhoto.storage_path], 3600);
  const urlByPath = new Map(
    (signed ?? [])
      .filter((s): s is typeof s & { signedUrl: string; path: string } => !!s.signedUrl && !!s.path)
      .map((s) => [s.path, s.signedUrl]),
  );

  const original: ComparePhoto = { ...originalPhoto, viewUrl: urlByPath.get(originalPhoto.storage_path) ?? null };
  const candidate: ComparePhoto = { ...newPhoto, viewUrl: urlByPath.get(newPhoto.storage_path) ?? null };

  return (
    <main className="flex min-h-screen flex-col gap-4 p-6 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <Link
          href="/photos"
          className="text-sm text-[color:var(--color-text-secondary)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
        >
          ← Photos
        </Link>
        <Link
          href="/"
          className="text-sm text-[color:var(--color-text-secondary)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
        >
          Home
        </Link>
      </div>

      <PhotoCompareView original={original} candidate={candidate} />
    </main>
  );
}

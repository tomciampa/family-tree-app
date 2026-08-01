"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";
import { sanitizeFilenameForStorageKey } from "@/lib/sanitize-filename";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

type UploadPhotoResult = { error: string } | { id: string };

// Stage 1 only: sanitize, upload, insert a row. No tagging, no gallery —
// those are separate later stages. Storage key is deliberately built from
// a sanitized filename (see sanitize-filename.ts — the same "Invalid key"
// gap confirmed against the documents pipeline in an earlier
// investigation, fixed here from the start rather than inherited),
// original_filename keeps the real name for display regardless of what
// the storage key had to become.
export async function uploadPhoto(formData: FormData): Promise<UploadPhotoResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "No file provided." };

  const { supabase, user } = await requireUser();
  const familyId = await getFamilyId();

  const bytes = new Uint8Array(await file.arrayBuffer());
  const safeName = sanitizeFilenameForStorageKey(file.name);
  const storagePath = `${familyId}/${crypto.randomUUID()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from("photos")
    .upload(storagePath, bytes, { contentType: file.type || undefined });
  if (uploadError) return { error: uploadError.message };

  const { data: inserted, error: insertError } = await supabase
    .from("photos")
    .insert({
      family_id: familyId,
      storage_path: storagePath,
      original_filename: file.name,
      uploaded_by: user.id,
    })
    .select("id")
    .single();
  if (insertError || !inserted) {
    await supabase.storage.from("photos").remove([storagePath]);
    return { error: insertError?.message ?? "Failed to save photo." };
  }

  revalidatePath("/photos");
  return { id: inserted.id };
}

type AddPhotoTagResult = { error: string } | { id: string };

// x/y are 0.0-1.0 (percentage of the displayed image's width/height at
// click time — see photo-lightbox.tsx), not pixels, so a tag stays
// correctly positioned regardless of what size the image renders at
// later. person_id is trusted to already be scoped to the active family
// (PersonSearch here is only ever given that family's people — see
// photos-view.tsx), but the same-family invariant is also enforced at
// the DB layer regardless (Stage 2 migration's trigger) — never trust a
// client-picked id alone for something a stale UI state or a future bug
// could get wrong.
export async function addPhotoTag(
  photoId: string,
  personId: string,
  xPosition: number,
  yPosition: number,
): Promise<AddPhotoTagResult> {
  const { supabase } = await requireUser();

  const { data: inserted, error } = await supabase
    .from("photo_tags")
    .insert({
      photo_id: photoId,
      person_id: personId,
      x_position: xPosition,
      y_position: yPosition,
    })
    .select("id")
    .single();
  if (error || !inserted) {
    return { error: error?.message ?? "Failed to save tag." };
  }

  revalidatePath("/photos");
  return { id: inserted.id };
}

// Deletable by any active member of the photo's family, not just whoever
// uploaded it — matches the existing convention documents/interviews
// deletion already uses (deleteDocument/deleteInterview check only
// family-scoped RLS, never uploaded_by), not a stricter new rule
// introduced just for photos.
export async function removePhotoTag(tagId: string): Promise<{ error: string } | { success: true }> {
  const { supabase } = await requireUser();

  const { error } = await supabase.from("photo_tags").delete().eq("id", tagId);
  if (error) return { error: error.message };

  revalidatePath("/photos");
  return { success: true };
}

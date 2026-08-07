"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";
import { sanitizeFilenameForStorageKey } from "@/lib/sanitize-filename";
import { sha256Hex, findDuplicateId } from "@/lib/content-hash";
import { isHeicFile, convertHeicToJpeg, replaceExtensionWithJpg, HeicConversionError } from "@/lib/heic-convert";

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

  const originalBytes = new Uint8Array(await file.arrayBuffer());
  let bytes: Uint8Array = originalBytes;
  let filename = file.name;
  let contentType: string | null = file.type || null;

  // Convert HEIC/HEIF to JPEG before it's ever stored — most browsers
  // besides Safari can't render HEIC in an <img> tag at all (confirmed
  // directly for this app: a real HEIC file served through the gallery's
  // plain <img src> fails to load in real Chrome), so an unconverted HEIC
  // photo would silently land as a permanently broken image with no error
  // anywhere. Same conversion the email-intake path already applies to
  // emailed photos — see heic-convert.ts.
  if (isHeicFile(file.type || null, file.name)) {
    try {
      bytes = await convertHeicToJpeg(originalBytes);
    } catch (err) {
      return {
        error:
          err instanceof HeicConversionError
            ? err.message
            : `Could not convert HEIC file: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
    filename = replaceExtensionWithJpg(file.name);
    contentType = "image/jpeg";
  }

  const safeName = sanitizeFilenameForStorageKey(filename);
  const storagePath = `${familyId}/${crypto.randomUUID()}-${safeName}`;

  // Exact-duplicate detection (see content_hash_dedup migration) — hashed
  // from the ORIGINAL bytes the user picked, never the HEIC-converted
  // ones, so this stays the same "original bytes" hash the email path's
  // originalContentHash already uses — see the matching comment in
  // documents/actions.ts's uploadDocument for why hashing the converted
  // bytes instead would silently break cross-path duplicate matching for
  // every HEIC file.
  const contentHash = sha256Hex(originalBytes);
  const duplicateOfId = await findDuplicateId(supabase, "photos", familyId, contentHash);

  const { error: uploadError } = await supabase.storage
    .from("photos")
    .upload(storagePath, bytes, { contentType: contentType || undefined });
  if (uploadError) return { error: uploadError.message };

  const { data: inserted, error: insertError } = await supabase
    .from("photos")
    .insert({
      family_id: familyId,
      storage_path: storagePath,
      original_filename: filename,
      uploaded_by: user.id,
      content_hash: contentHash,
      duplicate_of_id: duplicateOfId,
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
  const { supabase, user } = await requireUser();

  const { data: inserted, error } = await supabase
    .from("photo_tags")
    .insert({
      photo_id: photoId,
      person_id: personId,
      x_position: xPosition,
      y_position: yPosition,
      tagged_by: user.id,
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

export type PhotoDeleteImpact = { tagCount: number; personNames: string[] };

// Same "fetch fresh every time the dialog opens" reasoning as
// getDocumentDeleteImpact/getInterviewDeleteImpact — a tag could be
// added or removed at any point right up until the delete click.
export async function getPhotoDeleteImpact(
  photoId: string,
): Promise<{ error: string } | { impact: PhotoDeleteImpact }> {
  const { supabase } = await requireUser();

  const { data: tags, error } = await supabase
    .from("photo_tags")
    .select("people(name)")
    .eq("photo_id", photoId);
  if (error) return { error: error.message };

  const personNames = (tags ?? [])
    .map((t) => t.people?.name)
    .filter((n): n is string => !!n);

  return { impact: { tagCount: tags?.length ?? 0, personNames } };
}

// Storage object removed last, after the DB row is gone — same order
// deleteDocument/deleteInterview already use, so a failure partway
// through leaves at worst a harmless orphaned blob, never a DB row
// pointing at a file that no longer exists. photo_tags rows cascade
// automatically (photo_tags_photo_id_fkey is ON DELETE CASCADE, added in
// the Stage 1 migration) — no manual cleanup needed here.
export async function deletePhoto(photoId: string): Promise<{ error: string } | { success: true }> {
  const { supabase } = await requireUser();

  const { data: photo, error: fetchError } = await supabase
    .from("photos")
    .select("storage_path")
    .eq("id", photoId)
    .single();
  if (fetchError || !photo) {
    return { error: fetchError?.message ?? "Photo not found." };
  }

  const { error: deleteError } = await supabase.from("photos").delete().eq("id", photoId);
  if (deleteError) return { error: deleteError.message };

  await supabase.storage.from("photos").remove([photo.storage_path]);

  revalidatePath("/photos");
  return { success: true };
}

export async function updatePhotoCaption(
  photoId: string,
  caption: string | null,
): Promise<{ error: string } | { success: true }> {
  const { supabase } = await requireUser();

  const trimmed = caption?.trim() || null;
  const { error } = await supabase.from("photos").update({ caption: trimmed }).eq("id", photoId);
  if (error) return { error: error.message };

  revalidatePath("/photos");
  return { success: true };
}

// takenAt is a plain "YYYY-MM-DD" string (an <input type="date">'s native
// value shape) or null to clear it — never a Date object, so there's no
// timezone-shifting round trip between the browser and a date column.
export async function updatePhotoTakenAt(
  photoId: string,
  takenAt: string | null,
): Promise<{ error: string } | { success: true }> {
  const { supabase } = await requireUser();

  const { error } = await supabase.from("photos").update({ taken_at: takenAt }).eq("id", photoId);
  if (error) return { error: error.message };

  revalidatePath("/photos");
  return { success: true };
}

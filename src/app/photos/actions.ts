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

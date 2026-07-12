"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return supabase;
}

export async function uploadDocument(formData: FormData) {
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "No file provided." };

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const bytes = new Uint8Array(await file.arrayBuffer());
  const storagePath = `${familyId}/${crypto.randomUUID()}-${file.name}`;

  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, bytes, { contentType: file.type || undefined });
  if (uploadError) return { error: uploadError.message };

  const { error: insertError } = await supabase.from("documents").insert({
    file_path: storagePath,
    filename: file.name,
    document_type: file.type || null,
    family_id: familyId,
    status: "pending_match",
  });
  if (insertError) {
    await supabase.storage.from("documents").remove([storagePath]);
    return { error: insertError.message };
  }

  revalidatePath("/documents");
  return {};
}

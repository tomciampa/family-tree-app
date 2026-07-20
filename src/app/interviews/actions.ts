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

// Called after the browser has already uploaded the recorded audio
// straight to Storage (see record-interview-flow.tsx) — recordings can run
// long, and routing the raw bytes through a Server Action would hit
// next.config.ts's 10MB body limit (see documents-view.tsx's comment on
// the same limit). This just writes the resulting metadata row.
export async function createInterviewSession({
  filePath,
  filename,
  mimeType,
  intervieweePersonId,
}: {
  filePath: string;
  filename: string;
  mimeType: string;
  intervieweePersonId: string;
}): Promise<{ error: string } | { documentId: string }> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { data, error } = await supabase
    .from("documents")
    .insert({
      file_path: filePath,
      filename,
      document_type: mimeType || null,
      kind: "Interview Recording",
      family_id: familyId,
      interviewee_person_id: intervieweePersonId,
      // Already linked to its subject via interviewee_person_id, so it
      // never needs the pending_match candidate-matching workflow that
      // general /documents uploads go through.
      status: "matched",
    })
    .select("id")
    .single();

  if (error) {
    await supabase.storage.from("documents").remove([filePath]);
    return { error: error.message };
  }

  revalidatePath("/interviews");
  return { documentId: data.id };
}

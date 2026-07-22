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
  return { supabase, user };
}

// personId: null means "I'm not in the tree yet" — explicitly clears the
// link rather than leaving it ambiguous with "never set". Upserts on
// (family_id, user_id), the table's actual primary key, so this works
// whether or not a family_members row already exists for this user.
export async function setLinkedPerson(
  personId: string | null,
): Promise<{ error: string } | { ok: true }> {
  const { supabase, user } = await requireUser();
  const familyId = await getFamilyId();

  const { error } = await supabase
    .from("family_members")
    .upsert(
      { family_id: familyId, user_id: user.id, linked_person_id: personId },
      { onConflict: "family_id,user_id" },
    );
  if (error) return { error: error.message };

  revalidatePath("/settings");
  revalidatePath("/tree");
  return { ok: true };
}

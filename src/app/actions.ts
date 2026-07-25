"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

// Shared by both entry points Stage 2 asks for — the home page's
// zero-family state (a brand-new signup with no invite code) and
// Settings' "start a second family" — rather than two copies of the same
// action. Goes through the create_family() RPC (see the Stage 2
// migration) since a brand-new families row has no members yet, which
// the ordinary is_family_member()-scoped RLS policy can never let a
// plain authenticated INSERT satisfy; that bootstrap step has to happen
// inside a SECURITY DEFINER function. create_family also marks the new
// family active (deactivating any others), which is why every page that
// depends on the active family needs revalidating here, not just /tree.
export async function createFamily(
  name: string,
): Promise<{ error: string } | { familyId: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const trimmed = name.trim();
  if (!trimmed) return { error: "Family name is required." };

  const { data, error } = await supabase
    .rpc("create_family", { new_name: trimmed })
    .single();
  if (error) return { error: error.message };

  revalidatePath("/");
  revalidatePath("/tree");
  revalidatePath("/settings");
  return { familyId: data.created_family_id };
}

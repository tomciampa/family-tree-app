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

export async function addFirstPerson(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Name is required." };

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { error } = await supabase
    .from("people")
    .insert({ name: trimmed, family_id: familyId });

  if (error) return { error: error.message };

  revalidatePath("/tree");
  return {};
}

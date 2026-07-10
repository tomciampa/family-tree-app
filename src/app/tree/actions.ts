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

export async function addParents(
  childId: string,
  parent1Name: string,
  parent2Name: string,
) {
  const p1Name = parent1Name.trim();
  const p2Name = parent2Name.trim();
  if (!p1Name) return { error: "First parent's name is required." };

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { data: parent1, error: parent1Error } = await supabase
    .from("people")
    .insert({ name: p1Name, family_id: familyId })
    .select("id")
    .single();
  if (parent1Error || !parent1) {
    return { error: parent1Error?.message ?? "Could not create first parent." };
  }

  const { data: parent2, error: parent2Error } = await supabase
    .from("people")
    .insert(
      p2Name
        ? { name: p2Name, family_id: familyId }
        : { name: "Unknown", family_id: familyId, is_placeholder: true },
    )
    .select("id")
    .single();
  if (parent2Error || !parent2) {
    return { error: parent2Error?.message ?? "Could not create second parent." };
  }

  const { data: union, error: unionError } = await supabase
    .from("unions")
    .insert({ parent1_id: parent1.id, parent2_id: parent2.id, family_id: familyId })
    .select("id")
    .single();
  if (unionError || !union) {
    return { error: unionError?.message ?? "Could not create union." };
  }

  const { error: unionChildError } = await supabase
    .from("union_children")
    .insert({ union_id: union.id, child_id: childId });
  if (unionChildError) return { error: unionChildError.message };

  revalidatePath("/tree");
  return {};
}

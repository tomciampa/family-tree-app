"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";
import { FACT_SOURCE_TYPES } from "./constants";

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

export async function addSibling(personId: string, siblingName: string) {
  const trimmed = siblingName.trim();
  if (!trimmed) return { error: "Sibling's name is required." };

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { data: existingLink, error: linkError } = await supabase
    .from("union_children")
    .select("union_id")
    .eq("child_id", personId)
    .limit(1)
    .maybeSingle();
  if (linkError) return { error: linkError.message };
  if (!existingLink) {
    return { error: "This person doesn't have parents recorded yet." };
  }

  const { data: sibling, error: siblingError } = await supabase
    .from("people")
    .insert({ name: trimmed, family_id: familyId })
    .select("id")
    .single();
  if (siblingError || !sibling) {
    return { error: siblingError?.message ?? "Could not create sibling." };
  }

  const { error: unionChildError } = await supabase
    .from("union_children")
    .insert({ union_id: existingLink.union_id, child_id: sibling.id });
  if (unionChildError) return { error: unionChildError.message };

  revalidatePath("/tree");
  return {};
}

export async function addSpouseAndChild(
  personId: string,
  spouseName: string,
  childName: string,
) {
  const spouseTrimmed = spouseName.trim();
  if (!spouseTrimmed) return { error: "Spouse's name is required." };
  const childTrimmed = childName.trim();

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { data: spouse, error: spouseError } = await supabase
    .from("people")
    .insert({ name: spouseTrimmed, family_id: familyId })
    .select("id")
    .single();
  if (spouseError || !spouse) {
    return { error: spouseError?.message ?? "Could not create spouse." };
  }

  const { data: union, error: unionError } = await supabase
    .from("unions")
    .insert({ parent1_id: personId, parent2_id: spouse.id, family_id: familyId })
    .select("id")
    .single();
  if (unionError || !union) {
    return { error: unionError?.message ?? "Could not create union." };
  }

  if (childTrimmed) {
    const { data: child, error: childError } = await supabase
      .from("people")
      .insert({ name: childTrimmed, family_id: familyId })
      .select("id")
      .single();
    if (childError || !child) {
      return { error: childError?.message ?? "Could not create child." };
    }

    const { error: unionChildError } = await supabase
      .from("union_children")
      .insert({ union_id: union.id, child_id: child.id });
    if (unionChildError) return { error: unionChildError.message };
  }

  revalidatePath("/tree");
  return {};
}

export async function addAnotherChild(unionId: string, childName: string) {
  const trimmed = childName.trim();
  if (!trimmed) return { error: "Child's name is required." };

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { data: child, error: childError } = await supabase
    .from("people")
    .insert({ name: trimmed, family_id: familyId })
    .select("id")
    .single();
  if (childError || !child) {
    return { error: childError?.message ?? "Could not create child." };
  }

  const { error: unionChildError } = await supabase
    .from("union_children")
    .insert({ union_id: unionId, child_id: child.id });
  if (unionChildError) return { error: unionChildError.message };

  revalidatePath("/tree");
  return {};
}

export async function addFact(
  personId: string,
  field: string,
  value: string,
  sourceType: string,
  sourceRef: string,
) {
  const fieldTrimmed = field.trim();
  const valueTrimmed = value.trim();
  if (!fieldTrimmed) return { error: "Field is required." };
  if (!valueTrimmed) return { error: "Value is required." };
  if (!FACT_SOURCE_TYPES.includes(sourceType as (typeof FACT_SOURCE_TYPES)[number])) {
    return { error: "Invalid source type." };
  }

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { error } = await supabase.from("facts").insert({
    person_id: personId,
    field: fieldTrimmed,
    value: valueTrimmed,
    source_type: sourceType,
    source_ref: sourceRef.trim() || null,
    family_id: familyId,
    recorded_at: new Date().toISOString(),
  });
  if (error) return { error: error.message };

  revalidatePath("/tree");
  return {};
}

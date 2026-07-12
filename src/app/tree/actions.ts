"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { generateObject } from "ai";
import { z } from "zod";
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

export async function addFirstPerson(
  name: string,
): Promise<{ error: string } | { personId: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Name is required." };

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { data, error } = await supabase
    .from("people")
    .insert({ name: trimmed, family_id: familyId })
    .select("id")
    .single();

  if (error) return { error: error.message };

  revalidatePath("/tree");
  return { personId: data.id };
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

export async function updatePersonName(personId: string, newName: string) {
  const trimmed = newName.trim();
  if (!trimmed) return { error: "Name is required." };

  const supabase = await requireUser();

  const { error } = await supabase
    .from("people")
    .update({ name: trimmed })
    .eq("id", personId);
  if (error) return { error: error.message };

  revalidatePath("/tree");
  return {};
}

export async function deletePerson(personId: string) {
  const supabase = await requireUser();

  // Remove this person as a listed child anywhere — their birth parents'
  // union itself is left intact, since it's still a valid record of that
  // relationship even with one fewer child listed.
  const { error: childUnlinkError } = await supabase
    .from("union_children")
    .delete()
    .eq("child_id", personId);
  if (childUnlinkError) return { error: childUnlinkError.message };

  // Unions where this person is a parent: if the union has children, keep
  // it (with just this person's parent slot cleared) so those children
  // don't lose their parent record. If it has no children, the union is
  // meaningless once this person is gone, so drop it entirely rather than
  // leaving an orphaned one- or zero-parent row behind.
  const { data: unionsAsParent, error: unionsError } = await supabase
    .from("unions")
    .select("id, parent1_id, parent2_id")
    .or(`parent1_id.eq.${personId},parent2_id.eq.${personId}`);
  if (unionsError) return { error: unionsError.message };

  for (const union of unionsAsParent ?? []) {
    const { count, error: countError } = await supabase
      .from("union_children")
      .select("*", { count: "exact", head: true })
      .eq("union_id", union.id);
    if (countError) return { error: countError.message };

    if (count && count > 0) {
      const remainingParentId =
        union.parent1_id === personId ? union.parent2_id : union.parent1_id;
      const { error: updateError } = await supabase
        .from("unions")
        .update({ parent1_id: remainingParentId, parent2_id: null })
        .eq("id", union.id);
      if (updateError) return { error: updateError.message };
    } else {
      const { error: deleteUnionError } = await supabase
        .from("unions")
        .delete()
        .eq("id", union.id);
      if (deleteUnionError) return { error: deleteUnionError.message };
    }
  }

  const { error: factsError } = await supabase
    .from("facts")
    .delete()
    .eq("person_id", personId);
  if (factsError) return { error: factsError.message };

  const { error: anecdotesError } = await supabase
    .from("anecdotes")
    .delete()
    .eq("person_id", personId);
  if (anecdotesError) return { error: anecdotesError.message };

  const { error: personError } = await supabase
    .from("people")
    .delete()
    .eq("id", personId);
  if (personError) return { error: personError.message };

  revalidatePath("/tree");
  return {};
}

export async function addFact(
  personId: string,
  field: string,
  value: string,
  sourceType: string,
  sourceRef: string,
  documentId?: string | null,
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
    document_id: documentId ?? null,
    family_id: familyId,
    recorded_at: new Date().toISOString(),
  });
  if (error) return { error: error.message };

  revalidatePath("/tree");
  return {};
}

type ExtractFactResult =
  | { error: string }
  | {
      documentId: string;
      field: string;
      value: string;
      sourceType: string;
      sourceRef: string;
    };

export async function extractFactFromDocument(
  personId: string,
  formData: FormData,
): Promise<ExtractFactResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "No file provided." };
  if (file.type !== "application/pdf") {
    return { error: "Only PDF files are supported right now." };
  }

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const bytes = new Uint8Array(await file.arrayBuffer());
  const storagePath = `${familyId}/${crypto.randomUUID()}-${file.name}`;

  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, bytes, { contentType: file.type });
  if (uploadError) return { error: uploadError.message };

  let extracted;
  try {
    const result = await generateObject({
      model: "anthropic/claude-sonnet-5",
      schema: z.object({
        field: z
          .string()
          .describe(
            "Short label for what this fact records, e.g. 'Death', 'Birth', 'Occupation', 'Immigration'",
          ),
        value: z
          .string()
          .describe(
            "The specific fact value in plain text, e.g. a date, place, or description",
          ),
        sourceType: z
          .enum(FACT_SOURCE_TYPES)
          .describe("How this fact is documented — this is a scanned document, so usually 'document'"),
        sourceRef: z
          .string()
          .describe(
            "Human-readable reference for the document, e.g. 'Death certificate, filed 1954, Suffolk County'",
          ),
        rawText: z
          .string()
          .describe("The full transcribed text content of the document"),
      }),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "This is a genealogy source document (e.g. a certificate, letter, or record). Extract the single most important fact it documents, along with the full transcribed text.",
            },
            { type: "file", data: bytes, mediaType: "application/pdf", filename: file.name },
          ],
        },
      ],
    });
    extracted = result.object;
  } catch (err) {
    await supabase.storage.from("documents").remove([storagePath]);
    return { error: err instanceof Error ? err.message : "Extraction failed." };
  }

  const { data: document, error: documentError } = await supabase
    .from("documents")
    .insert({
      file_path: storagePath,
      filename: file.name,
      document_type: "pdf",
      transcription_raw: extracted.rawText,
      family_id: familyId,
      status: "matched",
    })
    .select("id")
    .single();
  if (documentError || !document) {
    await supabase.storage.from("documents").remove([storagePath]);
    return { error: documentError?.message ?? "Could not save document record." };
  }

  const { error: linkError } = await supabase
    .from("document_people")
    .insert({ document_id: document.id, person_id: personId });
  if (linkError) return { error: linkError.message };

  return {
    documentId: document.id,
    field: extracted.field,
    value: extracted.value,
    sourceType: extracted.sourceType,
    sourceRef: extracted.sourceRef,
  };
}

export async function addStory(
  personId: string,
  storyText: string,
  whoToldIt: string,
) {
  const textTrimmed = storyText.trim();
  if (!textTrimmed) return { error: "Story text is required." };

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { error: insertError } = await supabase.from("anecdotes").insert({
    person_id: personId,
    story_text: textTrimmed,
    who_told_it: whoToldIt.trim() || null,
    family_id: familyId,
    recorded_at: new Date().toISOString(),
  });
  if (insertError) return { error: insertError.message };

  revalidatePath("/tree");
  return {};
}

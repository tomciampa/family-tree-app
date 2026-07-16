"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { generateObject } from "ai";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";
import { getSignedDocumentUrls } from "@/lib/documents";
import { FACT_SOURCE_TYPES, STANDARD_FIELD_KEYS } from "./constants";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return supabase;
}

type SupabaseClient = Awaited<ReturnType<typeof requireUser>>;

// Every "add relative" form offers this choice for each person slot:
// create a brand-new person (the original behavior), or search for and
// link an already-existing one instead — most often someone added via
// document matching who has no union/union_children row yet, so they only
// show up in the tree's "not yet connected" list with no way to actually
// place them.
export type PersonRef =
  | { mode: "new"; name: string }
  | { mode: "existing"; personId: string };

// The one safety check this needs: linking an existing person in as
// somebody's CHILD (sibling, another child, or the child slot of add
// spouse & child) when they already have a recorded set of parents
// elsewhere would silently give them a second, conflicting set. Returns a
// warning to surface via confirm() instead of writing anything; the
// caller re-invokes with confirmed=true once the user's OK'd it.
async function checkExistingChildSafety(
  supabase: SupabaseClient,
  existingPersonId: string,
  confirmed: boolean,
): Promise<{ warning: string } | null> {
  if (confirmed) return null;
  const { data } = await supabase
    .from("union_children")
    .select("union_id")
    .eq("child_id", existingPersonId)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    warning:
      "This person already has recorded parents elsewhere in the tree. Adding them here will give them a second, conflicting set of parents — continue anyway?",
  };
}

// Explicit return type on the four "add relative" actions below —
// without it, TypeScript's inferred return type across several `return
// {error:...}` / `return {warning:...}` / `return {}` statements doesn't
// narrow cleanly with `"error" in result` on the caller side.
type LinkResult = { error: string } | { warning: string } | Record<string, never>;

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
  parent1: PersonRef,
  parent2: PersonRef | null,
): Promise<LinkResult> {
  if (parent1.mode === "new" && !parent1.name.trim()) {
    return { error: "First parent's name is required." };
  }
  if (parent1.mode === "existing" && !parent1.personId) {
    return { error: "Select an existing person for the first parent." };
  }
  if (parent2?.mode === "existing" && !parent2.personId) {
    return { error: "Select an existing person for the second parent." };
  }

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  let parent1Id: string;
  if (parent1.mode === "existing") {
    parent1Id = parent1.personId;
  } else {
    const { data, error } = await supabase
      .from("people")
      .insert({ name: parent1.name.trim(), family_id: familyId })
      .select("id")
      .single();
    if (error || !data) {
      return { error: error?.message ?? "Could not create first parent." };
    }
    parent1Id = data.id;
  }

  // Second parent left blank (no PersonRef at all, or "new" with an empty
  // name) falls back to the same placeholder the original single-parent
  // flow always has.
  let parent2Id: string;
  if (parent2?.mode === "existing") {
    parent2Id = parent2.personId;
  } else {
    const name = parent2?.mode === "new" ? parent2.name.trim() : "";
    const { data, error } = await supabase
      .from("people")
      .insert(
        name
          ? { name, family_id: familyId }
          : { name: "Unknown", family_id: familyId, is_placeholder: true },
      )
      .select("id")
      .single();
    if (error || !data) {
      return { error: error?.message ?? "Could not create second parent." };
    }
    parent2Id = data.id;
  }

  const { data: union, error: unionError } = await supabase
    .from("unions")
    .insert({ parent1_id: parent1Id, parent2_id: parent2Id, family_id: familyId })
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

export async function addSibling(
  personId: string,
  sibling: PersonRef,
  confirmed = false,
): Promise<LinkResult> {
  if (sibling.mode === "new" && !sibling.name.trim()) {
    return { error: "Sibling's name is required." };
  }
  if (sibling.mode === "existing" && !sibling.personId) {
    return { error: "Select an existing person." };
  }

  const supabase = await requireUser();

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

  let siblingId: string;
  if (sibling.mode === "existing") {
    const warning = await checkExistingChildSafety(
      supabase,
      sibling.personId,
      confirmed,
    );
    if (warning) return warning;
    siblingId = sibling.personId;
  } else {
    const familyId = await getFamilyId();
    const { data, error } = await supabase
      .from("people")
      .insert({ name: sibling.name.trim(), family_id: familyId })
      .select("id")
      .single();
    if (error || !data) return { error: error?.message ?? "Could not create sibling." };
    siblingId = data.id;
  }

  const { error: unionChildError } = await supabase
    .from("union_children")
    .insert({ union_id: existingLink.union_id, child_id: siblingId });
  if (unionChildError) {
    if (unionChildError.code === "23505") {
      return { error: "That person is already recorded as a child of these parents." };
    }
    return { error: unionChildError.message };
  }

  revalidatePath("/tree");
  return {};
}

export async function addSpouseAndChild(
  personId: string,
  spouse: PersonRef,
  child: PersonRef | null,
  confirmed = false,
): Promise<LinkResult> {
  if (spouse.mode === "new" && !spouse.name.trim()) {
    return { error: "Spouse's name is required." };
  }
  if (spouse.mode === "existing" && !spouse.personId) {
    return { error: "Select an existing person for the spouse." };
  }
  if (child?.mode === "existing" && !child.personId) {
    return { error: "Select an existing person for the child." };
  }

  const supabase = await requireUser();
  const familyId = await getFamilyId();

  let spouseId: string;
  if (spouse.mode === "existing") {
    spouseId = spouse.personId;
  } else {
    const { data, error } = await supabase
      .from("people")
      .insert({ name: spouse.name.trim(), family_id: familyId })
      .select("id")
      .single();
    if (error || !data) return { error: error?.message ?? "Could not create spouse." };
    spouseId = data.id;
  }

  // An existing spouse might already be married to this person elsewhere
  // in the data (e.g. picked from search after being added by some other
  // flow) — reuse that union instead of creating a duplicate marriage.
  const { data: existingUnion } = await supabase
    .from("unions")
    .select("id")
    .or(
      `and(parent1_id.eq.${personId},parent2_id.eq.${spouseId}),and(parent1_id.eq.${spouseId},parent2_id.eq.${personId})`,
    )
    .maybeSingle();

  let unionId: string;
  if (existingUnion) {
    unionId = existingUnion.id;
  } else {
    const { data: union, error: unionError } = await supabase
      .from("unions")
      .insert({ parent1_id: personId, parent2_id: spouseId, family_id: familyId })
      .select("id")
      .single();
    if (unionError || !union) {
      return { error: unionError?.message ?? "Could not create union." };
    }
    unionId = union.id;
  }

  if (child?.mode === "existing") {
    const warning = await checkExistingChildSafety(
      supabase,
      child.personId,
      confirmed,
    );
    if (warning) return warning;

    const { error: unionChildError } = await supabase
      .from("union_children")
      .insert({ union_id: unionId, child_id: child.personId });
    if (unionChildError) {
      if (unionChildError.code === "23505") {
        return { error: "That person is already recorded as a child of these parents." };
      }
      return { error: unionChildError.message };
    }
  } else if (child?.mode === "new" && child.name.trim()) {
    const { data: childData, error: childError } = await supabase
      .from("people")
      .insert({ name: child.name.trim(), family_id: familyId })
      .select("id")
      .single();
    if (childError || !childData) {
      return { error: childError?.message ?? "Could not create child." };
    }

    const { error: unionChildError } = await supabase
      .from("union_children")
      .insert({ union_id: unionId, child_id: childData.id });
    if (unionChildError) return { error: unionChildError.message };
  }

  revalidatePath("/tree");
  return {};
}

export async function addAnotherChild(
  unionId: string,
  child: PersonRef,
  confirmed = false,
): Promise<LinkResult> {
  if (child.mode === "new" && !child.name.trim()) {
    return { error: "Child's name is required." };
  }
  if (child.mode === "existing" && !child.personId) {
    return { error: "Select an existing person." };
  }

  const supabase = await requireUser();

  let childId: string;
  if (child.mode === "existing") {
    const warning = await checkExistingChildSafety(
      supabase,
      child.personId,
      confirmed,
    );
    if (warning) return warning;
    childId = child.personId;
  } else {
    const familyId = await getFamilyId();
    const { data, error } = await supabase
      .from("people")
      .insert({ name: child.name.trim(), family_id: familyId })
      .select("id")
      .single();
    if (error || !data) return { error: error?.message ?? "Could not create child." };
    childId = data.id;
  }

  const { error: unionChildError } = await supabase
    .from("union_children")
    .insert({ union_id: unionId, child_id: childId });
  if (unionChildError) {
    if (unionChildError.code === "23505") {
      return { error: "That person is already recorded as a child of these parents." };
    }
    return { error: unionChildError.message };
  }

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

// Standardized identity fields, separate from the free-text `name` column
// that tree cards/search have always used and keep using — these are
// purely additive metadata surfaced in the dossier's Facts tab. All six are
// nullable, so an empty string in the form is stored as null rather than "".
export type PersonIdentityFields = {
  firstName: string;
  preferredName: string;
  lastName: string;
  marriedName: string;
  gender: string;
  aliases: string;
};

export async function updatePersonIdentity(
  personId: string,
  fields: PersonIdentityFields,
) {
  const supabase = await requireUser();

  const { error } = await supabase
    .from("people")
    .update({
      first_name: fields.firstName.trim() || null,
      preferred_name: fields.preferredName.trim() || null,
      last_name: fields.lastName.trim() || null,
      married_name: fields.marriedName.trim() || null,
      gender: fields.gender.trim() || null,
      aliases: fields.aliases.trim() || null,
    })
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

type ExtractedFact = { field: string; value: string };

type ExtractFactResult =
  | { error: string }
  | {
      documentId: string;
      facts: ExtractedFact[];
      sourceType: string;
      sourceRef: string;
    };

// Shared by both AI Gateway call sites that pull these standard fields out
// of free text — a new document being processed (extractFactFromDocument)
// and retroactively re-parsing an already-recorded fact whose text merges
// several of these together (parseFactsIntoStandardFields). Every field is
// independently nullable: source text rarely documents all seven, and
// guessing at one that isn't actually there is worse than leaving it blank.
const standardFieldsShape = {
  birthDate: z
    .string()
    .nullable()
    .describe("The person's birth date exactly as recorded, or null if not stated"),
  birthPlace: z
    .string()
    .nullable()
    .describe("The person's birth place, or null if not stated"),
  deathDate: z
    .string()
    .nullable()
    .describe("The person's death date exactly as recorded, or null if not stated"),
  deathPlace: z
    .string()
    .nullable()
    .describe("The person's death place, or null if not stated"),
  causeOfDeath: z
    .string()
    .nullable()
    .describe("Cause of death, or null if not stated"),
  occupation: z
    .string()
    .nullable()
    .describe("The person's occupation, or null if not stated"),
  placesLived: z
    .string()
    .nullable()
    .describe(
      "Place(s) the person is recorded as having lived, or null if not stated",
    ),
};

export type ParsedStandardFields = {
  [K in (typeof STANDARD_FIELD_KEYS)[number][0]]: string | null;
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
        ...standardFieldsShape,
        otherFacts: z
          .array(
            z.object({
              field: z
                .string()
                .describe(
                  "Short label for a notable fact that doesn't fit the standard categories above, e.g. 'Immigration', 'Military Service'",
                ),
              value: z.string().describe("The fact value in plain text"),
            }),
          )
          .describe(
            "Any other notable facts this document documents that aren't one of the standard categories above",
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
              text: "This is a genealogy source document (e.g. a certificate, letter, or record). Extract the standard fields it documents (birth/death date & place, cause of death, occupation, places lived) as separate values rather than merging them into one blob — leave any not stated as null. Put anything notable that doesn't fit those categories in otherFacts. Also transcribe the full text.",
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

  const facts: ExtractedFact[] = [];
  for (const [key, label] of STANDARD_FIELD_KEYS) {
    const value = extracted[key];
    if (value && value.trim()) facts.push({ field: label, value: value.trim() });
  }
  for (const other of extracted.otherFacts) {
    if (other.field.trim() && other.value.trim()) {
      facts.push({ field: other.field.trim(), value: other.value.trim() });
    }
  }

  return {
    documentId: document.id,
    facts,
    sourceType: extracted.sourceType,
    sourceRef: extracted.sourceRef,
  };
}

type ParseFactsResult = { error: string } | { parsed: ParsedStandardFields };

// Retroactively re-derives standardized fields from an existing fact (or
// facts) whose text merges several of them together, e.g. one "Death" fact
// covering birth date, death date, and occupation in prose — the exact gap
// that leaves every standardized slot showing "not recorded" even though
// the data is right there. Read-only: this never writes anything itself,
// it only returns candidate values for the dossier to show for review —
// the caller decides what to keep and saves each one via the ordinary
// addFact, same as any other fact. The source fact(s) are never modified.
export async function parseFactsIntoStandardFields(
  facts: { field: string; value: string }[],
): Promise<ParseFactsResult> {
  await requireUser();
  if (facts.length === 0) return { error: "No facts to parse." };

  const text = facts.map((f) => `${f.field}: ${f.value}`).join("\n");

  try {
    const result = await generateObject({
      model: "anthropic/claude-sonnet-5",
      schema: z.object(standardFieldsShape),
      messages: [
        {
          role: "user",
          content: `The following are existing genealogy facts recorded about one person, which may merge several details together in prose (e.g. one fact covering both a birth date and a cause of death). Pull out any of these standard fields it states, leaving anything not stated as null. Don't guess at a value that isn't actually there.\n\n${text}`,
        },
      ],
    });
    return { parsed: result.object };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Parsing failed." };
  }
}

type DocumentForViewer = {
  viewUrl: string | null;
  transcriptionRaw: string | null;
  documentType: string | null;
  filename: string | null;
  kind: string | null;
};

type GetDocumentForViewerResult = { error: string } | DocumentForViewer;

// Classifies a document's "kind" — a short, human-readable category like
// "Death Certificate" or "Letter" — the first time it's opened in the
// viewer modal (see fact-list.tsx's source badge), then caches it on the
// row so later views don't re-classify. Neither documents.document_type
// (just a MIME type) nor a fact's source_type (almost everything in real
// data is "document" regardless of whether the underlying source was an
// official record or someone's letter) can tell these apart — this is
// the one signal that actually can, since it reads what the document
// itself says rather than how it happened to get labeled upstream.
async function classifyDocumentKind(
  supabase: SupabaseClient,
  documentId: string,
  transcriptionRaw: string | null,
): Promise<string | null> {
  if (!transcriptionRaw || !transcriptionRaw.trim()) return null;

  try {
    const result = await generateObject({
      model: "anthropic/claude-sonnet-5",
      schema: z.object({
        kind: z
          .string()
          .describe(
            "A short, human-readable category for this genealogy source document, e.g. 'Death Certificate', 'Birth Certificate', 'Marriage Certificate', 'Funeral Card', 'Letter', 'Family Tree Chart', 'Photo', 'Immigration Record'. Title Case, 1-4 words.",
          ),
      }),
      messages: [
        {
          role: "user",
          content: `Classify this genealogy source document's category based on its transcribed content:\n\n${transcriptionRaw}`,
        },
      ],
    });
    const kind = result.object.kind.trim();
    if (!kind) return null;

    await supabase.from("documents").update({ kind }).eq("id", documentId);
    return kind;
  } catch {
    // Classification is a nice-to-have for the viewer's header label, not
    // essential to viewing the document itself — fail soft rather than
    // blocking the whole viewer over it.
    return null;
  }
}

export async function getDocumentForViewer(
  documentId: string,
): Promise<GetDocumentForViewerResult> {
  const supabase = await requireUser();

  const { data: document, error } = await supabase
    .from("documents")
    .select("file_path, filename, document_type, transcription_raw, kind")
    .eq("id", documentId)
    .single();
  if (error || !document) {
    return { error: error?.message ?? "Document not found." };
  }

  const urlByPath = await getSignedDocumentUrls(supabase, [document.file_path]);
  const viewUrl = urlByPath.get(document.file_path) ?? null;

  const kind =
    document.kind ??
    (await classifyDocumentKind(supabase, documentId, document.transcription_raw));

  return {
    viewUrl,
    transcriptionRaw: document.transcription_raw,
    documentType: document.document_type,
    filename: document.filename,
    kind,
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

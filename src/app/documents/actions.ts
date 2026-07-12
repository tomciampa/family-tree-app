"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { generateObject } from "ai";
import { z } from "zod";
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

const candidatePersonSchema = z.object({
  name: z.string().describe("The person's name as written in the document"),
  relation: z
    .string()
    .nullable()
    .describe(
      "This person's role in the document relative to its main subject, e.g. 'deceased', 'spouse', 'father', 'informant'",
    ),
  roleCategory: z
    .enum(["family", "administrative"])
    .describe(
      "'family' for anyone related to or personally connected with the document's subject (spouse, parent, child, sibling, etc.). 'administrative' for anyone present only in an official/procedural capacity — the informant, registrar, witness, clergy, notary, doctor who signed a certificate, etc. — who has no personal relation to the subject.",
    ),
  dates: z
    .string()
    .nullable()
    .describe("Any date(s) associated with this person in the document"),
  note: z
    .string()
    .nullable()
    .describe(
      "Any other disambiguating detail about this person, e.g. a patronymic like 'fu Luigi' (daughter of the late Luigi), a maiden name, or a place",
    ),
});

type ExtractCandidatesResult =
  | { error: string }
  | { candidates: z.infer<typeof candidatePersonSchema>[] };

export async function extractCandidatesFromDocument(
  documentId: string,
): Promise<ExtractCandidatesResult> {
  const supabase = await requireUser();

  const { data: document, error: fetchError } = await supabase
    .from("documents")
    .select("file_path, filename, document_type, transcription_raw")
    .eq("id", documentId)
    .single();
  if (fetchError || !document) {
    return { error: fetchError?.message ?? "Document not found." };
  }

  const { data: fileBlob, error: downloadError } = await supabase.storage
    .from("documents")
    .download(document.file_path);
  if (downloadError || !fileBlob) {
    return { error: downloadError?.message ?? "Could not download document." };
  }
  const bytes = new Uint8Array(await fileBlob.arrayBuffer());

  const isImageOrPdf =
    document.document_type === "application/pdf" ||
    (document.document_type?.startsWith("image/") ?? false);

  let result;
  try {
    result = await generateObject({
      model: "anthropic/claude-sonnet-5",
      schema: z.object({
        rawText: z
          .string()
          .describe("The full transcribed text content of the document"),
        candidates: z
          .array(candidatePersonSchema)
          .describe(
            "Every person named in the document, not just its main subject",
          ),
      }),
      messages: [
        {
          role: "user",
          content: isImageOrPdf
            ? [
                {
                  type: "text",
                  text: "This is a genealogy source document (e.g. a certificate, letter, or record), possibly a scanned image. Transcribe its full text, then list every person it names — not just the main subject. Many documents (e.g. death certificates) also name a spouse or parent (family) as well as an informant, registrar, witness, or clergy member (administrative) — classify each person's roleCategory accordingly so administrative names aren't confused with family.",
                },
                {
                  type: "file",
                  data: bytes,
                  mediaType: document.document_type ?? "application/octet-stream",
                  filename: document.filename ?? undefined,
                },
              ]
            : [
                {
                  type: "text",
                  text: `This is a genealogy source document. Transcribe its full text, then list every person it names — not just the main subject. Classify each person's roleCategory as 'family' (related to or personally connected with the subject) or 'administrative' (an informant, registrar, witness, clergy member, etc. with no personal relation).\n\nDocument content:\n${new TextDecoder().decode(bytes)}`,
                },
              ],
        },
      ],
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Extraction failed." };
  }

  const { error: updateError } = await supabase
    .from("documents")
    .update({
      transcription_raw: document.transcription_raw ?? result.object.rawText,
      candidate_people: result.object.candidates,
    })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  revalidatePath("/documents");
  return { candidates: result.object.candidates };
}

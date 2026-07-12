"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { generateObject } from "ai";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";
import { addFirstPerson } from "@/app/tree/actions";

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

type CandidatePerson = z.infer<typeof candidatePersonSchema>;

export type PersonMatch = {
  personId: string;
  personName: string;
  score: number;
  dateSignal: "overlap" | "conflict" | null;
  relationSignal?: boolean;
};

export type CandidateResolution = {
  action: "confirmed" | "created" | "skipped";
  personId?: string;
  factId?: string;
};

export type CandidateWithMatch = CandidatePerson & {
  matchStatus: "high_confidence" | "multiple_matches" | "no_match";
  matches: PersonMatch[];
  resolution?: CandidateResolution;
};

function extractYears(text: string | null): number[] {
  if (!text) return [];
  const found = text.match(/\b(1[5-9]\d{2}|20\d{2})\b/g);
  return found ? found.map(Number) : [];
}

const HIGH_CONFIDENCE_THRESHOLD = 0.5;
// A single score crossing the threshold isn't enough on its own — with
// several same-surname people, a runner-up can be close behind, meaning
// the "clear winner" is really just the least-ambiguous guess among a
// cluster of similarly-weak candidates. Require it to clearly lead the
// field, not just clear the bar.
const HIGH_CONFIDENCE_MARGIN = 0.15;
const MATCH_FLOOR = 0.2;
const DATE_OVERLAP_BONUS = 0.15;
const DATE_CONFLICT_PENALTY = 0.2;
// An existing recorded relationship (this candidate already IS the
// anchor's spouse/parent/child in the tree) is a much stronger signal
// than any amount of name-string similarity — comfortably above anything
// a same-surname coincidence could produce, but short of the 1.0 reserved
// for an exact name match.
const RELATIONSHIP_MATCH_SCORE = 0.95;

function classifyRelationType(
  relation: string | null,
): "spouse" | "parent" | "child" | null {
  if (!relation) return null;
  const r = relation.toLowerCase();
  if (/spouse|wife|husband|married/.test(r)) return "spouse";
  if (/father|mother|parent/.test(r)) return "parent";
  if (/son|daughter|child/.test(r)) return "child";
  return null;
}

function isMainSubjectRelation(relation: string | null): boolean {
  if (!relation) return false;
  return /deceased|self|subject|newborn/i.test(relation);
}

type SupabaseClient = Awaited<ReturnType<typeof requireUser>>;

async function getRealSpouseIds(
  supabase: SupabaseClient,
  personId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("unions")
    .select("parent1_id, parent2_id")
    .or(`parent1_id.eq.${personId},parent2_id.eq.${personId}`);
  return (data ?? [])
    .map((u) => (u.parent1_id === personId ? u.parent2_id : u.parent1_id))
    .filter((id): id is string => !!id);
}

async function getRealParentIds(
  supabase: SupabaseClient,
  personId: string,
): Promise<string[]> {
  const { data: links } = await supabase
    .from("union_children")
    .select("union_id")
    .eq("child_id", personId);
  if (!links || links.length === 0) return [];

  const { data: unions } = await supabase
    .from("unions")
    .select("parent1_id, parent2_id")
    .in(
      "id",
      links.map((l) => l.union_id),
    );
  const ids: string[] = [];
  for (const u of unions ?? []) {
    if (u.parent1_id) ids.push(u.parent1_id);
    if (u.parent2_id) ids.push(u.parent2_id);
  }
  return ids;
}

async function getRealChildIds(
  supabase: SupabaseClient,
  personId: string,
): Promise<string[]> {
  const { data: unions } = await supabase
    .from("unions")
    .select("id")
    .or(`parent1_id.eq.${personId},parent2_id.eq.${personId}`);
  if (!unions || unions.length === 0) return [];

  const { data: links } = await supabase
    .from("union_children")
    .select("child_id")
    .in(
      "union_id",
      unions.map((u) => u.id),
    );
  return (links ?? []).map((l) => l.child_id);
}

function reclassify(matches: PersonMatch[]): CandidateWithMatch["matchStatus"] {
  matches.sort((a, b) => b.score - a.score);
  const [top, runnerUp] = matches;
  if (!top) return "no_match";
  const isClearWinner =
    top.score >= HIGH_CONFIDENCE_THRESHOLD &&
    (!runnerUp || top.score - runnerUp.score >= HIGH_CONFIDENCE_MARGIN);
  return isClearWinner ? "high_confidence" : "multiple_matches";
}

// Boosts (or adds) a match for anyone who is ALREADY recorded, in the tree,
// as having the relationship to the anchor that the document says they
// have — e.g. the document calls them "spouse of Vincenzo" and they're
// literally Vincenzo's spouse in the unions table. This is far more
// reliable than name similarity alone, which can't tell a maiden name or
// an Anglicized name from an unrelated same-surname coincidence.
async function applyRelationshipSignal(
  supabase: SupabaseClient,
  results: CandidateWithMatch[],
): Promise<void> {
  const familyCandidates = results.filter((r) => r.roleCategory === "family");
  const resolvedAnchors = familyCandidates.filter(
    (r) => r.matchStatus === "high_confidence" && r.matches.length > 0,
  );
  if (resolvedAnchors.length === 0) return;

  const mainSubject =
    resolvedAnchors.find((r) => isMainSubjectRelation(r.relation)) ??
    [...resolvedAnchors].sort(
      (a, b) => b.matches[0].score - a.matches[0].score,
    )[0];
  const anchorId = mainSubject.matches[0].personId;

  for (const candidate of familyCandidates) {
    if (candidate === mainSubject) continue;
    const relType = classifyRelationType(candidate.relation);
    if (!relType) continue;

    const realRelatedIds =
      relType === "spouse"
        ? await getRealSpouseIds(supabase, anchorId)
        : relType === "parent"
          ? await getRealParentIds(supabase, anchorId)
          : await getRealChildIds(supabase, anchorId);
    if (realRelatedIds.length === 0) continue;

    // Only boost matches this candidate's own name search already turned
    // up — never inject a real-related person with zero name corroboration.
    // "parent" covers both father and mother (no gender data to tell them
    // apart), and a person can have more than one real spouse or child, so
    // realRelatedIds is often a set, not a single answer: without an
    // existing name-based match to anchor it to a specific candidate,
    // there's no reliable way to know which real relative belongs to
    // which document candidate. Recording the wrong one confidently would
    // be worse than leaving it ambiguous.
    let boosted = false;
    for (const match of candidate.matches) {
      if (realRelatedIds.includes(match.personId)) {
        match.score = Math.max(match.score, RELATIONSHIP_MATCH_SCORE);
        match.relationSignal = true;
        boosted = true;
      }
    }
    if (!boosted) continue;

    candidate.matchStatus = reclassify(candidate.matches);
  }
}

type MatchCandidatesResult =
  | { error: string }
  | { candidates: CandidateWithMatch[] };

export async function matchCandidatesForDocument(
  documentId: string,
): Promise<MatchCandidatesResult> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const { data: document, error: fetchError } = await supabase
    .from("documents")
    .select("candidate_people")
    .eq("id", documentId)
    .single();
  if (fetchError || !document) {
    return { error: fetchError?.message ?? "Document not found." };
  }

  const candidates = (document.candidate_people ??
    []) as unknown as CandidatePerson[];

  const results: CandidateWithMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.roleCategory !== "family") {
      // Administrative roles (registrar, witness, clergy, etc.) are never
      // people to match or create in the tree.
      results.push({ ...candidate, matchStatus: "no_match", matches: [] });
      continue;
    }

    const { data: rows, error: rpcError } = await supabase.rpc(
      "match_people_by_name",
      {
        search_name: candidate.name,
        target_family_id: familyId,
        min_similarity: MATCH_FLOOR,
      },
    );
    if (rpcError) return { error: rpcError.message };

    const candidateYears = extractYears(candidate.dates);
    const matches: PersonMatch[] = (rows ?? []).map((row) => {
      const personYears = [
        ...extractYears(row.birth_estimate),
        ...extractYears(row.death_estimate),
      ];
      let score = row.similarity;
      let dateSignal: PersonMatch["dateSignal"] = null;
      if (candidateYears.length > 0 && personYears.length > 0) {
        const overlap = candidateYears.some((y) => personYears.includes(y));
        if (overlap) {
          score = Math.min(1, score + DATE_OVERLAP_BONUS);
          dateSignal = "overlap";
        } else {
          score = Math.max(0, score - DATE_CONFLICT_PENALTY);
          dateSignal = "conflict";
        }
      }
      return {
        personId: row.id,
        personName: row.name,
        score,
        dateSignal,
      };
    });
    const matchStatus = reclassify(matches);

    results.push({ ...candidate, matchStatus, matches });
  }

  // Second pass: for candidates the name-similarity pass left ambiguous
  // (or ranked low), check whether they already have the recorded
  // relationship the document describes to another candidate that DID
  // resolve confidently — a much stronger signal than name text alone.
  await applyRelationshipSignal(supabase, results);

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: results })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  revalidatePath("/documents");
  return { candidates: results };
}

function factFieldForRelation(relation: string | null): string {
  if (!relation) return "Document";
  const r = relation.toLowerCase();
  if (r.includes("deceas")) return "Death";
  if (r.includes("birth") || r === "newborn") return "Birth";
  return relation.replace(/\b\w/g, (c) => c.toUpperCase());
}

function factValueForCandidate(candidate: CandidatePerson): string {
  const parts = [candidate.dates, candidate.note].filter(
    (v): v is string => !!v,
  );
  if (parts.length > 0) return parts.join(" · ");
  return candidate.relation
    ? `Named as ${candidate.relation} in this document`
    : "Named in this document";
}

// After any resolution action, check whether every family candidate on
// this document now has a resolution (confirmed, created, or explicitly
// skipped) — if so, the document is done and moves out of pending_match.
async function maybeMarkDocumentMatched(
  supabase: SupabaseClient,
  documentId: string,
  candidates: CandidateWithMatch[],
) {
  const familyCandidates = candidates.filter((c) => c.roleCategory === "family");
  const allResolved =
    familyCandidates.length > 0 &&
    familyCandidates.every((c) => !!c.resolution);
  if (allResolved) {
    await supabase
      .from("documents")
      .update({ status: "matched" })
      .eq("id", documentId);
  }
}

async function loadCandidates(
  supabase: SupabaseClient,
  documentId: string,
): Promise<
  | { error: string }
  | { filename: string | null; candidates: CandidateWithMatch[] }
> {
  const { data: document, error } = await supabase
    .from("documents")
    .select("filename, candidate_people")
    .eq("id", documentId)
    .single();
  if (error || !document) {
    return { error: error?.message ?? "Document not found." };
  }
  return {
    filename: document.filename,
    candidates: (document.candidate_people ??
      []) as unknown as CandidateWithMatch[],
  };
}

type ResolveResult = { error: string } | { candidates: CandidateWithMatch[] };

// Links the document to an existing person (a suggested match the user
// confirmed, or one they picked from the multiple_matches alternatives)
// and records a fact on that person sourced from this document. Nothing
// is written until this is explicitly called — matching alone never
// touches document_people or facts.
export async function confirmCandidateMatch(
  documentId: string,
  candidateIndex: number,
  personId: string,
): Promise<ResolveResult> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const loaded = await loadCandidates(supabase, documentId);
  if ("error" in loaded) return loaded;
  const { filename, candidates } = loaded;
  const candidate = candidates[candidateIndex];
  if (!candidate) return { error: "Candidate not found." };

  const { error: linkError } = await supabase
    .from("document_people")
    .insert({ document_id: documentId, person_id: personId });
  if (linkError && linkError.code !== "23505") {
    // 23505 = already linked (unique violation) — fine, not an error here.
    return { error: linkError.message };
  }

  const { data: fact, error: factError } = await supabase
    .from("facts")
    .insert({
      person_id: personId,
      field: factFieldForRelation(candidate.relation),
      value: factValueForCandidate(candidate),
      source_type: "document",
      source_ref: filename ?? "uploaded document",
      document_id: documentId,
      family_id: familyId,
      recorded_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (factError || !fact) {
    return { error: factError?.message ?? "Could not create fact." };
  }

  candidates[candidateIndex] = {
    ...candidate,
    resolution: { action: "confirmed", personId, factId: fact.id },
  };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: candidates })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  await maybeMarkDocumentMatched(supabase, documentId, candidates);

  revalidatePath("/documents");
  revalidatePath("/tree");
  return { candidates };
}

// For no_match candidates, or when the user rejects every suggested
// match — creates a brand-new person via the same addFirstPerson action
// the tree's own "+ Add first person" flow uses (no separate person-
// creation code path), then links and records a fact exactly like
// confirming an existing match does.
export async function createPersonForCandidate(
  documentId: string,
  candidateIndex: number,
  name: string,
): Promise<ResolveResult> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const loaded = await loadCandidates(supabase, documentId);
  if ("error" in loaded) return loaded;
  const { filename, candidates } = loaded;
  const candidate = candidates[candidateIndex];
  if (!candidate) return { error: "Candidate not found." };

  const created = await addFirstPerson(name);
  if ("error" in created) return { error: created.error };
  const personId = created.personId;

  const { error: linkError } = await supabase
    .from("document_people")
    .insert({ document_id: documentId, person_id: personId });
  if (linkError && linkError.code !== "23505") {
    return { error: linkError.message };
  }

  const { data: fact, error: factError } = await supabase
    .from("facts")
    .insert({
      person_id: personId,
      field: factFieldForRelation(candidate.relation),
      value: factValueForCandidate(candidate),
      source_type: "document",
      source_ref: filename ?? "uploaded document",
      document_id: documentId,
      family_id: familyId,
      recorded_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (factError || !fact) {
    return { error: factError?.message ?? "Could not create fact." };
  }

  candidates[candidateIndex] = {
    ...candidate,
    resolution: { action: "created", personId, factId: fact.id },
  };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: candidates })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  await maybeMarkDocumentMatched(supabase, documentId, candidates);

  revalidatePath("/documents");
  revalidatePath("/tree");
  return { candidates };
}

export async function skipCandidateResolution(
  documentId: string,
  candidateIndex: number,
): Promise<ResolveResult> {
  const supabase = await requireUser();

  const loaded = await loadCandidates(supabase, documentId);
  if ("error" in loaded) return loaded;
  const { candidates } = loaded;
  const candidate = candidates[candidateIndex];
  if (!candidate) return { error: "Candidate not found." };

  candidates[candidateIndex] = {
    ...candidate,
    resolution: { action: "skipped" },
  };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: candidates })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  await maybeMarkDocumentMatched(supabase, documentId, candidates);

  revalidatePath("/documents");
  return { candidates };
}

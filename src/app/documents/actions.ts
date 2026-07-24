"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { generateObject } from "ai";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";
import { addFirstPerson } from "@/app/tree/actions";
import {
  candidatePersonSchema,
  factFieldForRelation,
  type CandidatePerson,
} from "./candidate-schema";
import {
  isVisionCapable,
  hasTextExtractor,
  extractPlainText,
} from "@/lib/document-text-extraction";
import {
  getRealSpouseIds,
  getRealParentIds,
  getRealChildIds,
  getRealSiblingIds,
  getRealGrandparentIds,
  getRealGrandchildIds,
} from "@/lib/relationship-graph";
import { classifyRelationType } from "@/lib/relation-classification";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return supabase;
}

type UploadDocumentResult = { error: string } | { id: string };

export async function uploadDocument(
  formData: FormData,
): Promise<UploadDocumentResult> {
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

  const { data: inserted, error: insertError } = await supabase
    .from("documents")
    .insert({
      file_path: storagePath,
      filename: file.name,
      document_type: file.type || null,
      family_id: familyId,
      status: "pending_match",
    })
    .select("id")
    .single();
  if (insertError || !inserted) {
    await supabase.storage.from("documents").remove([storagePath]);
    return { error: insertError?.message ?? "Failed to save document." };
  }

  revalidatePath("/documents");
  return { id: inserted.id };
}

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

  const canUseVision = isVisionCapable(document.document_type);
  const canExtractText = hasTextExtractor(document.document_type);
  // Checked before ever downloading the file — an unsupported type should
  // fail fast and clearly, not silently reach the model with nothing
  // usable to read (the bug this replaces: a .docx's raw bytes decoded as
  // if they were plain text produced mostly null bytes, which the model
  // "successfully" transcribed as nothing, leaving candidate_people at []
  // with no error anywhere — see hasFamilyCandidates in documents-view.tsx
  // for why that specific shape hides the whole review-matches UI rather
  // than showing anything was wrong).
  if (!canUseVision && !canExtractText) {
    return {
      error: `Unsupported file type (${document.document_type ?? "unknown"}) — text extraction isn't available for this kind of file yet.`,
    };
  }

  const { data: fileBlob, error: downloadError } = await supabase.storage
    .from("documents")
    .download(document.file_path);
  if (downloadError || !fileBlob) {
    return { error: downloadError?.message ?? "Could not download document." };
  }
  const bytes = new Uint8Array(await fileBlob.arrayBuffer());

  let content;
  if (canUseVision) {
    content = [
      {
        type: "text" as const,
        text: "This is a genealogy source document (e.g. a certificate, letter, or record), possibly a scanned image. Transcribe its full text, then list every person it names — not just the main subject. Many documents (e.g. death certificates) also name a spouse or parent (family) as well as an informant, registrar, witness, or clergy member (administrative) — classify each person's roleCategory accordingly so administrative names aren't confused with family.",
      },
      {
        type: "file" as const,
        data: bytes,
        mediaType: document.document_type ?? "application/octet-stream",
        filename: document.filename ?? undefined,
      },
    ];
  } else {
    let plainText: string;
    try {
      // document.document_type is guaranteed non-null here: canExtractText
      // (hasTextExtractor) already checked it above, and canUseVision is
      // false in this branch.
      plainText = await extractPlainText(document.document_type!, bytes);
    } catch (err) {
      return {
        error: `Couldn't read this document's text: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
    content = [
      {
        type: "text" as const,
        text: `This is a genealogy source document. Transcribe its full text, then list every person it names — not just the main subject. Classify each person's roleCategory as 'family' (related to or personally connected with the subject) or 'administrative' (an informant, registrar, witness, clergy member, etc. with no personal relation).\n\nDocument content:\n${plainText}`,
      },
    ];
  }

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
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Extraction failed." };
  }

  const { error: updateError } = await supabase
    .from("documents")
    .update({
      // A fresh non-empty transcript always wins — `??` previously only
      // replaced a null/undefined value, which meant a stale "" from a
      // once-broken extraction (e.g. a file type the model couldn't
      // actually read) was treated as "already has a value worth
      // keeping" and preserved forever, even after a later re-extract
      // produced the real text.
      transcription_raw: result.object.rawText || document.transcription_raw,
      candidate_people: result.object.candidates,
    })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}`);
  return { candidates: result.object.candidates };
}

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

function isMainSubjectRelation(relation: string | null): boolean {
  if (!relation) return false;
  return /deceased|self|subject|newborn/i.test(relation);
}

export type SupabaseClient = Awaited<ReturnType<typeof requireUser>>;

function reclassify(matches: PersonMatch[]): CandidateWithMatch["matchStatus"] {
  matches.sort((a, b) => b.score - a.score);
  const [top, runnerUp] = matches;
  if (!top) return "no_match";
  const isClearWinner =
    top.score >= HIGH_CONFIDENCE_THRESHOLD &&
    (!runnerUp || top.score - runnerUp.score >= HIGH_CONFIDENCE_MARGIN);
  return isClearWinner ? "high_confidence" : "multiple_matches";
}

// A candidate someone has already resolved (search-override confirm, or a
// "create new person" match) is a strictly stronger anchor signal than an
// algorithmic name match — a human looked at it — so it must outrank any
// matchStatus-based candidate when picking the anchor below. Returns
// undefined for anything not yet resolvable at all.
function anchorPersonId(candidate: CandidateWithMatch): string | undefined {
  return (
    candidate.resolution?.personId ??
    (candidate.matchStatus === "high_confidence"
      ? candidate.matches[0]?.personId
      : undefined)
  );
}

function anchorConfidence(candidate: CandidateWithMatch): number {
  if (candidate.resolution?.personId) return Infinity;
  return candidate.matches[0]?.score ?? -Infinity;
}

// Boosts (or adds) a match for anyone who is ALREADY recorded, in the tree,
// as having the relationship to the anchor that the document says they
// have — e.g. the document calls them "spouse of Vincenzo" and they're
// literally Vincenzo's spouse in the unions table. This is far more
// reliable than name similarity alone, which can't tell a maiden name or
// an Anglicized name from an unrelated same-surname coincidence.
// explicitAnchorId lets a caller that already knows its real subject (e.g.
// interview extraction, which is always anchored on the known
// interviewee_person_id — see matchInterviewSegmentCandidates in
// app/interviews/actions.ts) skip the inference step entirely, which is
// both unnecessary work and a source of error when the real anchor is
// already known rather than guessed from the candidates themselves.
async function applyRelationshipSignal(
  supabase: SupabaseClient,
  results: CandidateWithMatch[],
  explicitAnchorId?: string,
): Promise<void> {
  const familyCandidates = results.filter((r) => r.roleCategory === "family");

  let anchorId: string;
  let mainSubject: CandidateWithMatch | undefined;
  if (explicitAnchorId) {
    anchorId = explicitAnchorId;
  } else {
    // Includes both already-confirmed candidates (e.g. a "Grandpa" that
    // couldn't auto-match by name and needed a manual search-override
    // confirm) and algorithmic high-confidence matches — a re-match after
    // a manual confirmation should be able to use that confirmation as an
    // anchor for the document's still-pending candidates, not just re-run
    // name search from scratch against the same unmatchable text.
    const resolvedAnchors = familyCandidates.filter(
      (r) => anchorPersonId(r) !== undefined,
    );
    if (resolvedAnchors.length === 0) return;

    mainSubject =
      resolvedAnchors.find((r) => isMainSubjectRelation(r.relation)) ??
      [...resolvedAnchors].sort(
        (a, b) => anchorConfidence(b) - anchorConfidence(a),
      )[0];
    anchorId = anchorPersonId(mainSubject)!;
  }

  for (const candidate of familyCandidates) {
    if (candidate === mainSubject) continue;
    const relType = classifyRelationType(candidate.relation);
    if (!relType) continue;

    let realRelatedIds: string[];
    switch (relType) {
      case "spouse":
        realRelatedIds = await getRealSpouseIds(supabase, anchorId);
        break;
      case "parent":
        realRelatedIds = await getRealParentIds(supabase, anchorId);
        break;
      case "grandparent":
        realRelatedIds = await getRealGrandparentIds(supabase, anchorId);
        break;
      case "child":
        realRelatedIds = await getRealChildIds(supabase, anchorId);
        break;
      case "grandchild":
        realRelatedIds = await getRealGrandchildIds(supabase, anchorId);
        break;
      case "sibling":
        realRelatedIds = await getRealSiblingIds(supabase, anchorId);
        break;
    }
    if (realRelatedIds.length === 0) continue;

    // Only boost matches this candidate's own name search already turned
    // up — never inject a real-related person with zero name corroboration.
    // "parent" covers both father and mother (no gender data to tell them
    // apart), "sibling" covers both sister and brother, and a person can
    // have more than one real spouse/child/sibling, so realRelatedIds is
    // often a set, not a single answer: without an existing name-based
    // match to anchor it to a specific candidate, there's no reliable way
    // to know which real relative belongs to which document candidate.
    // Recording the wrong one confidently would be worse than leaving it
    // ambiguous.
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

// Shared by document matching (below) and interview segment matching (see
// matchInterviewSegmentCandidates in app/interviews/actions.ts) — one
// name-similarity + date + relationship-signal pipeline, not two. Pass
// explicitAnchorId when the caller already knows its real subject (an
// interview's interviewee_person_id) rather than needing it inferred from
// a "deceased/self/subject" candidate the way a document's own text does.
export async function matchFamilyCandidates(
  supabase: SupabaseClient,
  familyId: string,
  candidates: CandidatePerson[],
  explicitAnchorId?: string,
): Promise<{ error: string } | { results: CandidateWithMatch[] }> {
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
  // relationship to the anchor — a much stronger signal than name text
  // alone.
  await applyRelationshipSignal(supabase, results, explicitAnchorId);

  return { results };
}

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

  const matched = await matchFamilyCandidates(supabase, familyId, candidates);
  if ("error" in matched) return matched;
  const results = matched.results;

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: results })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}`);
  return { candidates: results };
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
  revalidatePath(`/documents/${documentId}`);
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
  revalidatePath(`/documents/${documentId}`);
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
  revalidatePath(`/documents/${documentId}`);
  return { candidates };
}

export type DocumentDeleteImpact = {
  factCount: number;
  anecdoteCount: number;
  personNames: string[];
};

// Checked before showing the delete confirmation dialog — a document with
// nothing linked yet should only ever show the standard "cannot be undone"
// warning, not the escalated one.
export async function getDocumentDeleteImpact(
  documentId: string,
): Promise<{ error: string } | { impact: DocumentDeleteImpact }> {
  const supabase = await requireUser();

  const [{ data: facts, error: factsError }, { data: anecdotes, error: anecdotesError }] =
    await Promise.all([
      supabase
        .from("facts")
        .select("person_id, people(name)")
        .eq("document_id", documentId),
      supabase
        .from("anecdotes")
        .select("person_id, people(name)")
        .eq("document_id", documentId),
    ]);
  if (factsError) return { error: factsError.message };
  if (anecdotesError) return { error: anecdotesError.message };

  const personNames = new Set<string>();
  for (const row of facts ?? []) {
    if (row.people?.name) personNames.add(row.people.name);
  }
  for (const row of anecdotes ?? []) {
    if (row.people?.name) personNames.add(row.people.name);
  }

  return {
    impact: {
      factCount: facts?.length ?? 0,
      anecdoteCount: anecdotes?.length ?? 0,
      personNames: Array.from(personNames),
    },
  };
}

export async function deleteDocument(
  documentId: string,
): Promise<{ error: string } | { success: true }> {
  const supabase = await requireUser();

  const { data: document, error: fetchError } = await supabase
    .from("documents")
    .select("file_path")
    .eq("id", documentId)
    .single();
  if (fetchError || !document) {
    return { error: fetchError?.message ?? "Document not found." };
  }

  // Cascade-delete linked rows explicitly rather than relying on the
  // facts/anecdotes document_id FK's `on delete set null` — that would
  // silently orphan (unsource) those rows instead of actually removing
  // them, which is what deleting a document is supposed to do to any data
  // that came from it.
  const { error: factsError } = await supabase
    .from("facts")
    .delete()
    .eq("document_id", documentId);
  if (factsError) return { error: factsError.message };

  const { error: anecdotesError } = await supabase
    .from("anecdotes")
    .delete()
    .eq("document_id", documentId);
  if (anecdotesError) return { error: anecdotesError.message };

  const { error: linksError } = await supabase
    .from("document_people")
    .delete()
    .eq("document_id", documentId);
  if (linksError) return { error: linksError.message };

  const { error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId);
  if (deleteError) return { error: deleteError.message };

  // Storage cleanup last, and not treated as fatal: if this fails after
  // the DB rows are already gone, the result is a harmless orphaned blob,
  // not a document row pointing at a file that no longer exists.
  await supabase.storage.from("documents").remove([document.file_path]);

  revalidatePath("/documents");
  revalidatePath("/tree");
  return { success: true };
}

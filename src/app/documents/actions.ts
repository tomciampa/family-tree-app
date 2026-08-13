"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { generateObject } from "ai";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";
import { addFirstPerson } from "@/app/tree/actions";
import {
  factFieldForRelation,
  type CandidatePerson,
} from "./candidate-schema";
import {
  documentExtractionSchema,
  documentFactsOnlyExtractionSchema,
  attachAboutRefs,
  attachFactsOnlyAboutRefs,
  normalizeDocumentExtraction,
  type DocumentExtraction,
  type DocumentCandidateFact,
  type DocumentCandidateAnecdote,
} from "./document-extraction-schema";
import type { AboutRef } from "@/app/interviews/extraction-schema";
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
import { sha256Hex, findDuplicateId } from "@/lib/content-hash";
import { isHeicFile, convertHeicToJpeg, replaceExtensionWithJpg, HeicConversionError } from "@/lib/heic-convert";

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
  // uploaded_by previously went unpopulated here (see the Stage 1 photos
  // migration's comment on the same historical gap) — now set so the
  // homepage "Getting Started" checklist's "Uploaded a Document" item is
  // actually computable per-user, not just for photos.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const originalBytes = new Uint8Array(await file.arrayBuffer());
  let bytes: Uint8Array = originalBytes;
  let filename = file.name;
  let documentType: string | null = file.type || null;

  // Convert HEIC/HEIF to JPEG before it's ever stored — same reasoning
  // and same conversion this app's email-intake path already applies:
  // isVisionCapable() treats any image/* as vision-capable and sends
  // document_type straight through to the AI Gateway call as the vision
  // mediaType, but Claude's vision API doesn't accept image/heic (a real
  // production error, not hypothetical — see heic-convert.ts). Converted
  // here, before storage, rather than only at extraction time, so a
  // downloaded/re-viewed HEIC document is never silently unopenable
  // either — see documents.ts's getSignedDocumentUrls and the fact-source
  // viewer modal, both of which just point a plain link/<img> at whatever
  // is actually in Storage.
  if (isHeicFile(file.type || null, file.name)) {
    try {
      bytes = await convertHeicToJpeg(originalBytes);
    } catch (err) {
      return {
        error:
          err instanceof HeicConversionError
            ? err.message
            : `Could not convert HEIC file: ${err instanceof Error ? err.message : "unknown error"}`,
      };
    }
    filename = replaceExtensionWithJpg(file.name);
    documentType = "image/jpeg";
  }

  const storagePath = `${familyId}/${crypto.randomUUID()}-${filename}`;

  // Exact-duplicate detection (see content_hash_dedup migration) — hashed
  // from the ORIGINAL bytes the user picked, never the HEIC-converted
  // ones, so this stays the same "original bytes" hash the email path's
  // originalContentHash already uses (see email-intake.ts: the Worker
  // hashes rawBytes before compressImage() ever runs, specifically so a
  // since-compressed emailed photo still matches an identical original
  // uploaded via the website). Hashing the converted JPEG here instead
  // would silently break that cross-path match for every HEIC file —
  // confirmed as a real regression while verifying this feature, not
  // hypothetical. A web upload always goes through silently regardless
  // of the result — duplicate_of_id is just recorded for later
  // reference, never a warning or a block.
  const contentHash = sha256Hex(originalBytes);
  const duplicateOfId = await findDuplicateId(supabase, "documents", familyId, contentHash);

  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, bytes, { contentType: documentType || undefined });
  if (uploadError) return { error: uploadError.message };

  const { data: inserted, error: insertError } = await supabase
    .from("documents")
    .insert({
      file_path: storagePath,
      filename: filename,
      document_type: documentType,
      family_id: familyId,
      status: "pending_match",
      uploaded_by: user?.id ?? null,
      content_hash: contentHash,
      duplicate_of_id: duplicateOfId,
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
  | { extraction: DocumentExtraction<CandidatePerson> };

// override lets a caller with no user session (the email-intake webhook —
// see app/api/email-intake/route.ts) supply an already-authorized client
// (service-role, since there's no cookie session to derive one from)
// instead of going through requireUser(). Every existing caller omits
// this and gets the exact same behavior as before.
export async function extractCandidatesFromDocument(
  documentId: string,
  override?: { supabase: SupabaseClient },
): Promise<ExtractCandidatesResult> {
  const supabase = override?.supabase ?? (await requireUser());

  const { data: document, error: fetchError } = await supabase
    .from("documents")
    .select("file_path, filename, document_type, transcription_raw, status")
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
        text: [
          "This is a genealogy source document (e.g. a certificate, letter, or record), possibly a scanned image. Transcribe its full text, then extract:",
          "1. Every person it names, not just the main subject. Many documents (e.g. death certificates) also name a spouse or parent (family) as well as an informant, registrar, witness, or clergy member (administrative) — classify each person's roleCategory accordingly so administrative names aren't confused with family.",
          "2. Discrete factual claims — dates, places, occupations, and other concrete details stated about a specific person. Don't duplicate a person's name/relation here, that's already captured in step 1. If a single statement gives more than one standard field (e.g. a table row listing both a birth date and birthplace), emit a separate fact entry per field.",
          "3. Narrative anecdotes — stories, characterizations, and color that don't reduce to a discrete factual claim (e.g. a letter's reminiscences).",
        ].join("\n"),
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
        text: [
          "This is a genealogy source document. Transcribe its full text, then extract:",
          "1. Every person it names, not just the main subject. Classify each person's roleCategory as 'family' (related to or personally connected with the subject) or 'administrative' (an informant, registrar, witness, clergy member, etc. with no personal relation).",
          "2. Discrete factual claims — dates, places, occupations, and other concrete details stated about a specific person. Don't duplicate a person's name/relation here, that's already captured in step 1. If a single statement gives more than one standard field (e.g. a table row listing both a birth date and birthplace), emit a separate fact entry per field.",
          "3. Narrative anecdotes — stories, characterizations, and color that don't reduce to a discrete factual claim.",
          "",
          "Document content:",
          plainText,
        ].join("\n"),
      },
    ];
  }

  let result;
  try {
    result = await generateObject({
      model: "anthropic/claude-sonnet-5",
      schema: documentExtractionSchema,
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Extraction failed." };
  }

  // A document with zero family candidates has nothing for matchCandidatesForDocument
  // to ever act on — hasFamilyCandidates in documents-view.tsx stays false forever,
  // which hides the Match button and the review link alike. Before this, nothing
  // ever moved status off "pending_match" in that case (maybeMarkDocumentMatched
  // only fires once every family candidate is resolved, which can't happen with
  // zero of them), leaving a correct, completed extraction stuck showing "pending
  // match" with only a Re-extract loop forever. Routes to the "no_match" status the
  // UI already has styling for (documents-view.tsx's statusStyles) but never
  // assigned anywhere. Deliberately narrow: only ever sets status here, never
  // touches it when family candidates ARE found — that path's behavior (stays
  // whatever it already was, only maybeMarkDocumentMatched moves it to "matched")
  // is unchanged.
  //
  // Also guarded on the document's *prior* status being "pending_match" — the
  // Extract/Re-extract button (documents-view.tsx) is never gated by status, so
  // it's reachable on an already-"matched" document too. Re-extracting one fully
  // overwrites candidate_people with a fresh, unresolved list either way (a
  // pre-existing behavior, not new here), but this fix must not compound that by
  // also downgrading a real "matched" document back to "no_match" just because
  // this particular re-run happened to find zero family candidates — only a
  // document that was still waiting (pending_match) should ever be moved to
  // no_match by this.
  const hasFamilyCandidates = result.object.people.some(
    (c) => c.roleCategory === "family",
  );
  const shouldMarkNoMatch = !hasFamilyCandidates && document.status === "pending_match";

  const { facts, anecdotes } = attachAboutRefs(
    result.object.people,
    result.object.facts,
    result.object.anecdotes,
  );
  const extraction: DocumentExtraction<CandidatePerson> = {
    people: result.object.people,
    facts,
    anecdotes,
  };

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
      candidate_people: extraction,
      status: shouldMarkNoMatch ? "no_match" : undefined,
    })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}`);
  return { extraction };
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

// A candidate as the document review UI actually observes it — which may
// not have gone through matching yet (extractCandidatesFromDocument's own
// result, right after Extract but before anyone's clicked Match or
// manually confirmed). Unlike CandidateWithMatch itself, whose
// matchStatus/matches are always populated (matchFamilyCandidates always
// sets them for every result it returns), this stays a distinct, looser
// type rather than making CandidateWithMatch's own fields optional —
// email/interview review pages rely on CandidateWithMatch staying strict,
// since they only ever render an already-matched candidate (gated by
// their own isCandidateWithMatch check before a row renders at all).
// Documents' own review UI has always supported showing a not-yet-matched
// candidate inline instead (see document-review.tsx's "not_matched"
// fallback), so it needs this looser shape. Both CandidatePerson and
// CandidateWithMatch are structurally assignable to this type, so a
// single client-side state value can hold either.
export type CandidateForReview = CandidatePerson & {
  matchStatus?: CandidateWithMatch["matchStatus"];
  matches?: PersonMatch[];
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

// Shared by matchCandidatesForDocument (below) and
// matchEmailNoteCandidatesWith (app/email-notes/actions.ts) — both read a
// { people, facts, anecdotes } extraction off candidate_people, re-run
// matching on just the people[] identity array, and write the matched
// results back while leaving facts/anecdotes untouched. Previously
// duplicated near-verbatim between the two call sites; factored out once
// documents adopted the same extraction shape email-notes already used,
// rather than becoming a third copy.
export async function matchExtractionCandidates<
  E extends { people: CandidatePerson[] },
>(
  supabase: SupabaseClient,
  familyId: string,
  documentId: string,
  extraction: E,
): Promise<{ error: string } | { extraction: E }> {
  const matched = await matchFamilyCandidates(supabase, familyId, extraction.people);
  if ("error" in matched) return matched;

  const updatedExtraction: E = { ...extraction, people: matched.results };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: updatedExtraction })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  return { extraction: updatedExtraction };
}

// Same override escape hatch as extractCandidatesFromDocument above, for
// the same reason (the email-intake webhook has no user session to derive
// a client or familyId from).
export async function matchCandidatesForDocument(
  documentId: string,
  override?: { supabase: SupabaseClient; familyId: string },
): Promise<{ error: string } | { extraction: DocumentExtraction<CandidateWithMatch> }> {
  const supabase = override?.supabase ?? (await requireUser());
  const familyId = override?.familyId ?? (await getFamilyId());

  const { data: document, error: fetchError } = await supabase
    .from("documents")
    .select("candidate_people")
    .eq("id", documentId)
    .single();
  if (fetchError || !document) {
    return { error: fetchError?.message ?? "Document not found." };
  }

  const extraction = normalizeDocumentExtraction<CandidatePerson>(document.candidate_people);
  const matched = await matchExtractionCandidates(supabase, familyId, documentId, extraction);
  if ("error" in matched) return matched;

  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}`);
  return { extraction: matched.extraction as DocumentExtraction<CandidateWithMatch> };
}

// Deliberately unchanged (per the confirmed decision) even though facts[]
// now separately captures any real structured info dates/note might
// contain — still joins them into this one relation-level fact's value,
// same as before. Not deduplicated against the new structured facts:
// that risks silently dropping real extracted info if the AI put
// something in dates/note that it didn't also emit as a distinct fact.
// Some visible overlap on a well-extracted document (e.g. both "Child:
// 2/21/65 · Born Cambridge..." and a separate "Birth Date"/"Birth Place")
// is the accepted, safer tradeoff.
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
  people: CandidateWithMatch[],
) {
  const familyCandidates = people.filter((c) => c.roleCategory === "family");
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

async function loadExtraction(
  supabase: SupabaseClient,
  documentId: string,
): Promise<
  | { error: string }
  | { filename: string | null; extraction: DocumentExtraction<CandidateWithMatch> }
> {
  const { data: document, error } = await supabase
    .from("documents")
    .select("filename, candidate_people")
    .eq("id", documentId)
    .single();
  if (error || !document) {
    return { error: error?.message ?? "Document not found." };
  }
  const extraction = normalizeDocumentExtraction<CandidateWithMatch>(document.candidate_people);
  return { filename: document.filename, extraction };
}

type ResolveResult = { error: string } | { extraction: DocumentExtraction<CandidateWithMatch> };

type ReextractFactsResult =
  | { error: string }
  | { facts: DocumentCandidateFact[]; anecdotes: DocumentCandidateAnecdote[] };

// Narrow, facts/anecdotes-only re-extraction for a document whose people[]
// identity matching is already correct — built for the 14 real documents
// extracted before this app's facts[]/anecdotes[] feature shipped (see
// CLAUDE.md's shape-migration incident note). Deliberately does NOT call
// extractCandidatesFromDocument, which always overwrites candidate_people
// with a fresh, unresolved people[] list — that would destroy every real
// confirmed match. This only ever appends to facts[]/anecdotes[]; people[]
// (and therefore every resolution), document_people, and status are read
// but never written here.
//
// Reuses the document's own already-saved transcription_raw rather than
// re-downloading/re-running vision OCR on the original file: the existing
// identity matches were built against that exact transcript, so keeping
// the source text axis stable for this facts-only pass avoids a second
// OCR pass introducing any drift from what was actually reviewed.
//
// override mirrors extractCandidatesFromDocument's own — lets a
// script-driven reprocessing run (no browser session) supply an
// already-authorized client. No familyId is needed here since this never
// writes to facts/anecdotes/family-scoped tables itself — see
// saveNewFactsForResolvedCandidate below for the actual write, which
// always goes through a real user session.
export async function reextractFactsForResolvedDocument(
  documentId: string,
  override?: { supabase: SupabaseClient },
): Promise<ReextractFactsResult> {
  const supabase = override?.supabase ?? (await requireUser());

  const { data: document, error: fetchError } = await supabase
    .from("documents")
    .select("transcription_raw, candidate_people")
    .eq("id", documentId)
    .single();
  if (fetchError || !document) {
    return { error: fetchError?.message ?? "Document not found." };
  }
  if (!document.transcription_raw) {
    return { error: "No saved transcript to extract from — run Extract first." };
  }

  const existingExtraction = normalizeDocumentExtraction<CandidateWithMatch>(
    document.candidate_people,
  );
  const knownNames = existingExtraction.people.map((p) => p.name);

  let result;
  try {
    result = await generateObject({
      model: "anthropic/claude-sonnet-5",
      schema: documentFactsOnlyExtractionSchema,
      messages: [
        {
          role: "user",
          content: [
            "This is the transcript of a genealogy source document. The people already identified in it are:",
            knownNames.map((n) => `- ${n}`).join("\n"),
            "",
            "Extract only:",
            "1. Discrete factual claims — dates, places, occupations, and other concrete details stated about one of the people listed above. If a single statement gives more than one standard field (e.g. a birth date and birthplace together), emit a separate fact entry per field. Only attribute a fact to a name from the list above — never introduce a new person.",
            "2. Narrative anecdotes — stories, characterizations, and color that don't reduce to a discrete factual claim.",
            "",
            "Document transcript:",
            document.transcription_raw,
          ].join("\n"),
        },
      ],
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Extraction failed." };
  }

  const { facts: newFacts, anecdotes: newAnecdotes } = attachFactsOnlyAboutRefs(
    existingExtraction.people,
    result.object.facts,
    result.object.anecdotes,
  );

  // Additive only — never drops/replaces whatever facts[]/anecdotes[] this
  // document already had (always empty for these legacy rows today, but
  // stays correct if this is ever re-run on a document that already has
  // some).
  const updatedExtraction: DocumentExtraction<CandidateWithMatch> = {
    people: existingExtraction.people,
    facts: [...existingExtraction.facts, ...newFacts],
    anecdotes: [...existingExtraction.anecdotes, ...newAnecdotes],
  };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: updatedExtraction })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}`);
  return { facts: newFacts, anecdotes: newAnecdotes };
}

// Writes every not-yet-written fact/anecdote whose aboutRef resolves to
// candidateIndex, marking each written:{...} so a later re-extract or
// re-confirm never duplicates them — the same idempotent convention
// confirmEmailNoteBatch already established for its own batch write,
// applied per-candidate here since documents resolve identity one
// candidate at a time (immediately, on its own Confirm/Skip button —
// including the tree-hover "confirm from tree" path) rather than via one
// deferred batch submit the way email/interview review does.
async function writeAttributedFactsAndAnecdotes(
  supabase: SupabaseClient,
  familyId: string,
  documentId: string,
  sourceRef: string,
  personId: string,
  candidateIndex: number,
  facts: DocumentCandidateFact[],
  anecdotes: DocumentCandidateAnecdote[],
): Promise<
  | { error: string }
  | { facts: DocumentCandidateFact[]; anecdotes: DocumentCandidateAnecdote[] }
> {
  function targetsThisCandidate(aboutRef: AboutRef): boolean {
    return aboutRef.type === "person" && aboutRef.index === candidateIndex;
  }

  const nextFacts = [...facts];
  for (let i = 0; i < nextFacts.length; i++) {
    const fact = nextFacts[i];
    if (fact.written || !targetsThisCandidate(fact.aboutRef)) continue;

    const { data: inserted, error } = await supabase
      .from("facts")
      .insert({
        person_id: personId,
        field: fact.field,
        value: fact.value,
        confidence: fact.confidence,
        source_type: "document",
        source_ref: sourceRef,
        document_id: documentId,
        family_id: familyId,
        recorded_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !inserted) return { error: error?.message ?? "Could not save fact." };
    nextFacts[i] = { ...fact, written: { factId: inserted.id } };
  }

  const nextAnecdotes = [...anecdotes];
  for (let i = 0; i < nextAnecdotes.length; i++) {
    const anecdote = nextAnecdotes[i];
    if (anecdote.written || !targetsThisCandidate(anecdote.aboutRef)) continue;

    const { data: inserted, error } = await supabase
      .from("anecdotes")
      .insert({
        person_id: personId,
        story_text: anecdote.storyText,
        // Documents have no equivalent of an interview's interviewee or an
        // email's sender to name as "who told it" — the document itself is
        // the source, same as source_ref on the facts written above.
        who_told_it: sourceRef,
        document_id: documentId,
        family_id: familyId,
        recorded_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !inserted) return { error: error?.message ?? "Could not save anecdote." };
    nextAnecdotes[i] = { ...anecdote, written: { anecdoteId: inserted.id } };
  }

  return { facts: nextFacts, anecdotes: nextAnecdotes };
}

// Links the document to an existing person (a suggested match the user
// confirmed, or one they picked from the multiple_matches alternatives),
// records the usual relation-level fact on that person, and now also
// writes every structured fact/anecdote this document's extraction
// attributed to this specific candidate. Nothing is written until this is
// explicitly called — matching alone never touches document_people or
// facts.
export async function confirmCandidateMatch(
  documentId: string,
  candidateIndex: number,
  personId: string,
  override?: { supabase: SupabaseClient; familyId: string },
): Promise<ResolveResult> {
  const supabase = override?.supabase ?? (await requireUser());
  const familyId = override?.familyId ?? (await getFamilyId());

  const loaded = await loadExtraction(supabase, documentId);
  if ("error" in loaded) return loaded;
  const { filename, extraction } = loaded;
  const candidate = extraction.people[candidateIndex];
  if (!candidate) return { error: "Candidate not found." };
  const sourceRef = filename ?? "uploaded document";

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
      source_ref: sourceRef,
      document_id: documentId,
      family_id: familyId,
      recorded_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (factError || !fact) {
    return { error: factError?.message ?? "Could not create fact." };
  }

  const attributed = await writeAttributedFactsAndAnecdotes(
    supabase,
    familyId,
    documentId,
    sourceRef,
    personId,
    candidateIndex,
    extraction.facts,
    extraction.anecdotes,
  );
  if ("error" in attributed) return attributed;

  const people = [...extraction.people];
  people[candidateIndex] = {
    ...candidate,
    resolution: { action: "confirmed", personId, factId: fact.id },
  };
  const updatedExtraction: DocumentExtraction<CandidateWithMatch> = {
    people,
    facts: attributed.facts,
    anecdotes: attributed.anecdotes,
  };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: updatedExtraction })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  await maybeMarkDocumentMatched(supabase, documentId, people);

  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}`);
  revalidatePath("/tree");
  return { extraction: updatedExtraction };
}

// For no_match candidates, or when the user rejects every suggested
// match — creates a brand-new person via the same addFirstPerson action
// the tree's own "+ Add first person" flow uses (no separate person-
// creation code path), then links and records facts exactly like
// confirming an existing match does.
export async function createPersonForCandidate(
  documentId: string,
  candidateIndex: number,
  name: string,
): Promise<ResolveResult> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const loaded = await loadExtraction(supabase, documentId);
  if ("error" in loaded) return loaded;
  const { filename, extraction } = loaded;
  const candidate = extraction.people[candidateIndex];
  if (!candidate) return { error: "Candidate not found." };
  const sourceRef = filename ?? "uploaded document";

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
      source_ref: sourceRef,
      document_id: documentId,
      family_id: familyId,
      recorded_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (factError || !fact) {
    return { error: factError?.message ?? "Could not create fact." };
  }

  const attributed = await writeAttributedFactsAndAnecdotes(
    supabase,
    familyId,
    documentId,
    sourceRef,
    personId,
    candidateIndex,
    extraction.facts,
    extraction.anecdotes,
  );
  if ("error" in attributed) return attributed;

  const people = [...extraction.people];
  people[candidateIndex] = {
    ...candidate,
    resolution: { action: "created", personId, factId: fact.id },
  };
  const updatedExtraction: DocumentExtraction<CandidateWithMatch> = {
    people,
    facts: attributed.facts,
    anecdotes: attributed.anecdotes,
  };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: updatedExtraction })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  await maybeMarkDocumentMatched(supabase, documentId, people);

  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}`);
  revalidatePath("/tree");
  return { extraction: updatedExtraction };
}

// Deliberately never writes any fact/anecdote attributed to this
// candidate — same as an aboutRef that never resolves to anyone. If a
// later re-extract or a different candidate's own confirm doesn't pick
// them up either, they just stay visibly unresolved in the review UI.
export async function skipCandidateResolution(
  documentId: string,
  candidateIndex: number,
): Promise<ResolveResult> {
  const supabase = await requireUser();

  const loaded = await loadExtraction(supabase, documentId);
  if ("error" in loaded) return loaded;
  const { extraction } = loaded;
  const candidate = extraction.people[candidateIndex];
  if (!candidate) return { error: "Candidate not found." };

  const people = [...extraction.people];
  people[candidateIndex] = {
    ...candidate,
    resolution: { action: "skipped" },
  };
  const updatedExtraction: DocumentExtraction<CandidateWithMatch> = {
    ...extraction,
    people,
  };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: updatedExtraction })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  await maybeMarkDocumentMatched(supabase, documentId, people);

  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}`);
  return { extraction: updatedExtraction };
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

// Writes whatever new, not-yet-written facts/anecdotes an already-resolved
// candidate has accumulated (e.g. from reextractFactsForResolvedDocument
// above) — the one case document-review.tsx's per-candidate Confirm
// button never covered, since that always paired identity confirmation
// with a fact write in the same action. This candidate's identity/
// resolution is completely untouched here; only
// writeAttributedFactsAndAnecdotes runs, against the personId it already
// has.
export async function saveNewFactsForResolvedCandidate(
  documentId: string,
  candidateIndex: number,
): Promise<ResolveResult> {
  const supabase = await requireUser();
  const familyId = await getFamilyId();

  const loaded = await loadExtraction(supabase, documentId);
  if ("error" in loaded) return loaded;
  const { filename, extraction } = loaded;
  const candidate = extraction.people[candidateIndex];
  if (!candidate?.resolution?.personId) {
    return { error: "This candidate isn't linked to a person yet." };
  }
  const sourceRef = filename ?? "uploaded document";

  const attributed = await writeAttributedFactsAndAnecdotes(
    supabase,
    familyId,
    documentId,
    sourceRef,
    candidate.resolution.personId,
    candidateIndex,
    extraction.facts,
    extraction.anecdotes,
  );
  if ("error" in attributed) return attributed;

  const updatedExtraction: DocumentExtraction<CandidateWithMatch> = {
    ...extraction,
    facts: attributed.facts,
    anecdotes: attributed.anecdotes,
  };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: updatedExtraction })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}`);
  revalidatePath("/tree");
  return { extraction: updatedExtraction };
}

// Lets a human pick which of several same-named candidates an ambiguous
// fact/anecdote (see attachFactsOnlyAboutRefs) actually belongs to — never
// guessed automatically, per the real "Anthony Ciampa"-style name-
// collision risk this app has already been burned by once. Only updates
// the aboutRef in candidate_people; still requires its own explicit Save
// (saveNewFactsForResolvedCandidate above) before anything is written to
// facts/anecdotes.
export async function resolveAmbiguousAttribution(
  documentId: string,
  kind: "fact" | "anecdote",
  itemIndex: number,
  chosenCandidateIndex: number,
): Promise<ResolveResult> {
  const supabase = await requireUser();

  const loaded = await loadExtraction(supabase, documentId);
  if ("error" in loaded) return loaded;
  const { extraction } = loaded;

  const items = kind === "fact" ? extraction.facts : extraction.anecdotes;
  const item = items[itemIndex];
  if (!item || item.aboutRef.type !== "ambiguous") {
    return { error: "This item isn't ambiguous (or doesn't exist)." };
  }
  const chosen = item.aboutRef.candidates.find((c) => c.index === chosenCandidateIndex);
  if (!chosen) return { error: "Not one of the people this could belong to." };

  const resolvedItem = { ...item, aboutRef: { type: "person" as const, index: chosen.index, name: chosen.name } };
  const updatedExtraction: DocumentExtraction<CandidateWithMatch> =
    kind === "fact"
      ? {
          ...extraction,
          facts: extraction.facts.map((f, i) => (i === itemIndex ? (resolvedItem as DocumentCandidateFact) : f)),
        }
      : {
          ...extraction,
          anecdotes: extraction.anecdotes.map((a, i) =>
            i === itemIndex ? (resolvedItem as DocumentCandidateAnecdote) : a,
          ),
        };

  const { error: updateError } = await supabase
    .from("documents")
    .update({ candidate_people: updatedExtraction })
    .eq("id", documentId);
  if (updateError) return { error: updateError.message };

  revalidatePath(`/documents/${documentId}`);
  return { extraction: updatedExtraction };
}

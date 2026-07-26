"use server";

import { randomBytes } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";
import type { Json } from "@/lib/supabase/database.types";
import { remapCandidatePeople, newFilePathFor, type IdMap } from "@/lib/fork-family-remap";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

// personId: null means "I'm not in the tree yet" — explicitly clears the
// link rather than leaving it ambiguous with "never set". Upserts on
// (family_id, user_id), the table's actual primary key, so this works
// whether or not a family_members row already exists for this user.
export async function setLinkedPerson(
  personId: string | null,
): Promise<{ error: string } | { ok: true }> {
  const { supabase, user } = await requireUser();
  const familyId = await getFamilyId();

  const { error } = await supabase
    .from("family_members")
    .upsert(
      { family_id: familyId, user_id: user.id, linked_person_id: personId },
      { onConflict: "family_id,user_id" },
    );
  if (error) return { error: error.message };

  revalidatePath("/settings");
  revalidatePath("/tree");
  return { ok: true };
}

// voiceURI: null means "no preference" — explicitly clears any saved
// choice rather than leaving it ambiguous with "never set", same as
// setLinkedPerson's personId handling above. Interview narration falls
// back to the app's own improved default (see lib/speech-voices.ts) either
// way, so clearing this never breaks narration.
export async function setInterviewVoice(
  voiceURI: string | null,
): Promise<{ error: string } | { ok: true }> {
  const { supabase, user } = await requireUser();
  const familyId = await getFamilyId();

  const { error } = await supabase
    .from("family_members")
    .upsert(
      { family_id: familyId, user_id: user.id, interview_voice_uri: voiceURI },
      { onConflict: "family_id,user_id" },
    );
  if (error) return { error: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

// Whether interview prompts get read aloud at all. Defaults to true (see
// the narration_enabled column's own default) so existing behavior is
// preserved for everyone until they explicitly opt out.
export async function setNarrationEnabled(
  enabled: boolean,
): Promise<{ error: string } | { ok: true }> {
  const { supabase, user } = await requireUser();
  const familyId = await getFamilyId();

  const { error } = await supabase
    .from("family_members")
    .upsert(
      { family_id: familyId, user_id: user.id, narration_enabled: enabled },
      { onConflict: "family_id,user_id" },
    );
  if (error) return { error: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

// The code itself is generated here, in application code, rather than in
// SQL — same convention as other unguessable-identifier generation
// elsewhere in the app (e.g. storage paths via crypto.randomUUID()).
// base64url keeps it URL-safe with no encoding needed in the shareable
// link; 24 random bytes is 192 bits, comfortably unguessable for a
// single-use, 7-day-expiring token. The absolute URL is built client-side
// (window.location.origin) by the caller, same as the login page already
// does for its own emailRedirectTo — this action only returns the code.
export async function createFamilyInvite(): Promise<
  { error: string } | { code: string }
> {
  const { supabase, user } = await requireUser();
  const familyId = await getFamilyId();

  const code = randomBytes(24).toString("base64url");

  const { error } = await supabase.from("family_invites").insert({
    family_id: familyId,
    code,
    created_by: user.id,
  });
  if (error) return { error: error.message };

  revalidatePath("/settings");
  return { code };
}

// Real counts for the "Fork this family" confirmation dialog, fetched
// fresh every time it opens — same convention as DeleteWithImpactButton's
// impact check, since this is exactly the kind of number a stale prop
// could get wrong.
export async function getForkPreview(): Promise<
  | { error: string }
  | {
      familyName: string;
      counts: { people: number; documents: number; facts: number; anecdotes: number; events: number };
    }
> {
  const { supabase } = await requireUser();
  const familyId = await getFamilyId();

  const [{ data: family, error: familyError }, people, documents, facts, anecdotes, events] =
    await Promise.all([
      supabase.from("families").select("name").eq("id", familyId).single(),
      supabase.from("people").select("id", { count: "exact", head: true }).eq("family_id", familyId),
      supabase.from("documents").select("id", { count: "exact", head: true }).eq("family_id", familyId),
      supabase.from("facts").select("id", { count: "exact", head: true }).eq("family_id", familyId),
      supabase.from("anecdotes").select("id", { count: "exact", head: true }).eq("family_id", familyId),
      supabase.from("events").select("id", { count: "exact", head: true }).eq("family_id", familyId),
    ]);
  if (familyError) return { error: familyError.message };

  return {
    familyName: family.name,
    counts: {
      people: people.count ?? 0,
      documents: documents.count ?? 0,
      facts: facts.count ?? 0,
      anecdotes: anecdotes.count ?? 0,
      events: events.count ?? 0,
    },
  };
}

export type ForkFamilyResult = { error: string } | { familyId: string; familyName: string; warnings: string[] };

// Deep-copies the caller's active family into a brand-new, independent
// one via the fork_family() RPC (see the Stage 3 migration), then does
// the two things that RPC deliberately leaves to TypeScript:
//   1. Physically duplicating each document/photo's Storage bytes —
//      Postgres has no way to touch Storage object bytes from inside a
//      SQL function.
//   2. Remapping the old ids buried inside documents.candidate_people
//      JSONB (see lib/fork-family-remap.ts for why this isn't attempted
//      in PL/pgSQL).
//
// Every old document/photo file_path must be fetched BEFORE calling the
// RPC: fork_family() marks the new family active as part of the same
// transaction, and after that a plain RLS-scoped documents/photos query
// filtered to the OLD family id returns nothing (Stage 2's active-family-
// only RLS on those tables) — Storage access itself stays scoped by "any
// membership" (see the migration's storage RLS comment), so only this one
// specific table read needs to happen up front.
export async function forkFamily(newName: string): Promise<ForkFamilyResult> {
  const { supabase } = await requireUser();
  const sourceFamilyId = await getFamilyId();

  const trimmed = newName.trim();
  if (!trimmed) return { error: "Family name is required." };

  const [{ data: oldDocuments, error: oldDocsError }, { data: oldPhotos, error: oldPhotosError }] =
    await Promise.all([
      supabase.from("documents").select("id, file_path, candidate_people").eq("family_id", sourceFamilyId),
      supabase.from("photos").select("id, file_path").eq("family_id", sourceFamilyId),
    ]);
  if (oldDocsError) return { error: oldDocsError.message };
  if (oldPhotosError) return { error: oldPhotosError.message };

  const { data: forked, error: forkError } = await supabase
    .rpc("fork_family", { source_family_id: sourceFamilyId, new_name: trimmed })
    .single();
  if (forkError) return { error: forkError.message };

  const newFamilyId = forked.forked_family_id;
  const personIdMap = (forked.person_id_map ?? {}) as IdMap;
  const factIdMap = (forked.fact_id_map ?? {}) as IdMap;
  const anecdoteIdMap = (forked.anecdote_id_map ?? {}) as IdMap;
  const documentIdMap = (forked.document_id_map ?? {}) as IdMap;

  const warnings: string[] = [];

  // Storage copy — deduplicated by unique old file_path, since interview
  // segments all share their parent session's exact file_path (confirmed
  // against real data: one recording, one Storage object, N segment rows
  // all pointing at it). Without deduping, an N-segment interview would
  // trigger N redundant copies of the same bytes to the same destination.
  const uniqueOldPaths = new Set<string>();
  for (const d of oldDocuments ?? []) uniqueOldPaths.add(d.file_path);
  for (const p of oldPhotos ?? []) uniqueOldPaths.add(p.file_path);

  const copyResults = await Promise.allSettled(
    [...uniqueOldPaths].map(async (oldPath) => {
      const newPath = newFilePathFor(oldPath, newFamilyId);
      const { error } = await supabase.storage.from("documents").copy(oldPath, newPath);
      if (error) throw new Error(`${oldPath}: ${error.message}`);
    }),
  );
  for (const result of copyResults) {
    if (result.status === "rejected") {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      warnings.push(`File copy failed for ${message}`);
    }
  }

  // candidate_people remap — photos have no such field, only documents do.
  const oldDocsById = new Map((oldDocuments ?? []).map((d) => [d.id, d]));
  for (const [oldId, newId] of Object.entries(documentIdMap)) {
    const oldDoc = oldDocsById.get(oldId);
    if (!oldDoc || oldDoc.candidate_people === null) continue;

    const remapped = remapCandidatePeople(
      oldDoc.candidate_people,
      personIdMap,
      factIdMap,
      anecdoteIdMap,
      warnings,
      `document ${oldId}`,
    );

    const { error: updateError } = await supabase
      .from("documents")
      .update({ candidate_people: remapped as Json })
      .eq("id", newId);
    if (updateError) {
      warnings.push(`Could not save remapped data for document ${oldId} → ${newId}: ${updateError.message}`);
    }
  }

  revalidatePath("/");
  revalidatePath("/tree");
  revalidatePath("/settings");
  revalidatePath("/documents");
  revalidatePath("/interviews");

  return { familyId: newFamilyId, familyName: forked.forked_family_name, warnings };
}

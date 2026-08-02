import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./supabase/database.types";

// Exact-duplicate detection for documents and photos (see the
// content_hash_dedup migration) — shared by all three upload paths' Next.js-
// side code (web document upload, web photo upload, and the email-intake
// webhook's own insert of both). The Cloudflare Worker can't import this
// module (separate bundler/runtime — see cloudflare-worker/email-intake.ts's
// own local sha256Hex), but SHA-256 is a deterministic standard algorithm,
// so a hex digest computed there via Web Crypto and one computed here via
// Node's crypto module are directly comparable for the same bytes.
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type DedupTable = "documents" | "photos";

// Finds the earliest existing row with the same content_hash in the same
// family — the "original" a new duplicate points back at via
// duplicate_of_id. Scoped to plain rows only for documents (interview
// segments/sessions and email-body-notes are excluded from this feature
// entirely, same as the rest of the app treats them as a structurally
// different kind of row — see the migration comment). Returns null for a
// null/empty hash (nothing to compare) or when no match exists — both
// mean "not a duplicate," not an error.
export async function findDuplicateId(
  supabase: SupabaseClient<Database>,
  table: DedupTable,
  familyId: string,
  hash: string | null,
): Promise<string | null> {
  if (!hash) return null;

  if (table === "documents") {
    const { data } = await supabase
      .from("documents")
      .select("id")
      .eq("family_id", familyId)
      .eq("content_hash", hash)
      .is("interviewee_person_id", null)
      .is("parent_document_id", null)
      .eq("is_email_body_note", false)
      .order("recorded_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    return data?.id ?? null;
  }

  const { data } = await supabase
    .from("photos")
    .select("id")
    .eq("family_id", familyId)
    .eq("content_hash", hash)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

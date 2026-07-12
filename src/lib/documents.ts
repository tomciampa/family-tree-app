import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// Short-lived on purpose — the "documents" Storage bucket is private, and a
// signed URL is a bearer credential for as long as it's valid. Long enough
// to view a file after a page load without re-fetching, short enough that
// it isn't effectively a permanent public link.
const SIGNED_URL_TTL_SECONDS = 300;

export async function getSignedDocumentUrls(
  supabase: SupabaseClient<Database>,
  filePaths: string[],
): Promise<Map<string, string>> {
  const uniquePaths = [...new Set(filePaths)];
  if (uniquePaths.length === 0) return new Map();

  const { data, error } = await supabase.storage
    .from("documents")
    .createSignedUrls(uniquePaths, SIGNED_URL_TTL_SECONDS);
  if (error || !data) return new Map();

  const urlByPath = new Map<string, string>();
  for (const entry of data) {
    if (entry.path && entry.signedUrl) urlByPath.set(entry.path, entry.signedUrl);
  }
  return urlByPath;
}

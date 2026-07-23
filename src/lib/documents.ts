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

// Splits transcription text around a needle so it can be wrapped in
// <mark> — shared by the document review workspace (needle = a candidate
// person's extracted name, set by hovering a match) and the document
// viewer modal opened from a fact's source badge (needle = that fact's
// own value). A needle that doesn't appear anywhere in the text is a
// silent no-op (single unmatched chunk returned) rather than an error —
// expected for facts whose value is a paraphrase of the source rather
// than a verbatim excerpt.
export function splitWithHighlight(text: string, needle: string | null) {
  if (!needle || !needle.trim()) return [{ text, match: false }];
  const escaped = needle.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) => ({ text: part, match: i % 2 === 1 }));
}

// One entry per MIME type this app knows a friendly label for — mirrors
// the TEXT_EXTRACTORS registry in document-text-extraction.ts: adding a
// new supported type means adding one entry here, not a new special case
// wherever a document's type is displayed. Image subtypes (image/jpeg,
// image/png, image/heic, ...) are handled by the startsWith("image/")
// check in documentTypeLabel below instead of being enumerated here,
// matching the same convention isVisionCapable and the viewer modal
// already use to recognize an image.
const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "Word Document",
  "text/plain": "Text File",
  "text/markdown": "Markdown File",
};

// A raw MIME type (e.g.
// "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
// means nothing to a non-technical user — never show one directly. Falls
// back to the file extension (still concrete and readable) rather than
// "Document" whenever one's available, so an unmapped type at least
// reads as e.g. "XLS" instead of a generic label.
export function documentTypeLabel(
  documentType: string | null,
  filename?: string | null,
): string {
  if (documentType) {
    if (documentType in DOCUMENT_TYPE_LABELS) {
      return DOCUMENT_TYPE_LABELS[documentType];
    }
    if (documentType.startsWith("image/")) return "Image";
  }
  const dotIndex = filename?.lastIndexOf(".") ?? -1;
  const extension = dotIndex > 0 ? filename!.slice(dotIndex + 1) : null;
  return extension ? extension.toUpperCase() : "Document";
}

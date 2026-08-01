// Supabase Storage rejects any object key containing a non-ASCII
// character with a hard "InvalidKey" error — confirmed directly against
// the real API in an earlier investigation (an accented filename like
// "Società Anonima di Navigazione.jpg" fails; the same test against
// Cyrillic and CJK filenames failed identically, so this isn't just an
// accents problem). Neither documents/actions.ts nor tree/actions.ts
// sanitize the filename before using it in a storage key — that gap is
// still open there. This is deliberately scoped to the photos upload
// path only; it doesn't touch either of those.
//
// Diacritics (é, ñ, à, ü, ...) are transliterated to their closest ASCII
// base letter via Unicode NFKD decomposition (splits a precomposed
// character into base + combining mark) followed by stripping the
// combining marks — "café" becomes "cafe", not "caf". Scripts with no
// ASCII equivalent (Cyrillic, CJK, etc.) can't be transliterated this
// way and are simply dropped; the extension is preserved separately so a
// fully non-Latin basename still ends up with a valid, non-empty key
// (falling back to "file") rather than an empty or extension-only one.
export function sanitizeFilenameForStorageKey(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  const hasExt = lastDot > 0 && lastDot < filename.length - 1;
  const base = hasExt ? filename.slice(0, lastDot) : filename;
  const ext = hasExt ? filename.slice(lastDot) : "";

  // NFKD splits "à" into "a" + a combining grave accent (U+0300); the
  // ASCII-range strip right after removes that combining mark along with
  // every other non-ASCII codepoint in one pass, so no separate
  // diacritic-specific regex is needed.
  const asciiBase = base.normalize("NFKD").replace(/[^\x20-\x7E]/g, "");
  const safeBase = asciiBase
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "");

  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "");

  return (safeBase || "file") + safeExt;
}

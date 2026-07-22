import mammoth from "mammoth";

// One entry per non-vision file type this app can pull real text out of.
// Vision-capable formats (images, PDF) are handled separately —
// isVisionCapable below — since those are sent straight to the model as a
// file attachment rather than pre-extracted to text here.
//
// Adding a new supported format (.xlsx, .pptx, whatever comes up next)
// means adding one entry here, not a new parallel branch in
// extractCandidatesFromDocument. Anything not registered here and not
// vision-capable is unsupported — see hasTextExtractor — and
// extractCandidatesFromDocument reports that clearly instead of silently
// feeding the model garbage.
const TEXT_EXTRACTORS: Record<string, (bytes: Uint8Array) => Promise<string>> = {
  "text/plain": async (bytes) => new TextDecoder().decode(bytes),
  "text/markdown": async (bytes) => new TextDecoder().decode(bytes),
  // A .docx is a zip archive of XML parts, not plain text — decoding its
  // raw bytes directly (the bug this registry replaces) produced mostly
  // null bytes and replacement characters, not the document's real
  // content. mammoth unzips it and pulls the actual paragraph text out of
  // word/document.xml.
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    async (bytes) => {
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return value;
    },
};

export function isVisionCapable(documentType: string | null): boolean {
  return (
    documentType === "application/pdf" ||
    (documentType?.startsWith("image/") ?? false)
  );
}

export function hasTextExtractor(documentType: string | null): boolean {
  return !!documentType && documentType in TEXT_EXTRACTORS;
}

export async function extractPlainText(
  documentType: string,
  bytes: Uint8Array,
): Promise<string> {
  const extractor = TEXT_EXTRACTORS[documentType];
  if (!extractor) {
    throw new Error(`No text extractor registered for "${documentType}".`);
  }
  return extractor(bytes);
}

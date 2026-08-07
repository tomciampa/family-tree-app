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

// HEIC/HEIF explicitly excluded even though it's an image/* type: Claude's
// vision API doesn't accept image/heic as a mediaType (a real production
// error, not hypothetical — see heic-convert.ts). New uploads never reach
// here as HEIC any more (uploadDocument converts to JPEG before storage),
// but excluding it here too means a pre-existing document stuck with
// document_type=image/heic from before that fix (or the email path, which
// converts before this function ever sees the type) fails with this
// function's own clear "unsupported file type" message instead of a raw,
// confusing API error surfacing from generateObject.
const NON_VISION_IMAGE_TYPES = new Set(["image/heic", "image/heif"]);

export function isVisionCapable(documentType: string | null): boolean {
  if (!documentType) return false;
  if (NON_VISION_IMAGE_TYPES.has(documentType.toLowerCase())) return false;
  return documentType === "application/pdf" || documentType.startsWith("image/");
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

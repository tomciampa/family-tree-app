import sharp from "sharp";

// HEIC/HEIF -> JPEG conversion for the two direct web upload paths
// (documents/actions.ts's uploadDocument, photos/actions.ts's uploadPhoto).
// The email-intake path (cloudflare-worker/image-compression.ts) already
// does this same conversion, for two independent reasons that both apply
// here too: (1) most browsers besides Safari can't render HEIC in an
// <img> tag at all — confirmed directly for this app, not assumed: a real
// HEIC file served through a plain <img src> in real Chrome fails to load
// (broken-image icon, onerror fires) — and (2) this app's vision-based
// document extraction (isVisionCapable in document-text-extraction.ts
// treats any image/* as vision-capable and hands document_type straight
// through as the AI Gateway call's mediaType) sends the raw bytes to
// Claude with no conversion step, and Claude's vision API doesn't accept
// image/heic — a real production error, not hypothetical.
//
// Decode: libheif-js, the same package (and the same underlying decode
// call shape — HeifDecoder().decode(bytes), then image.display() into an
// ImageData-shaped buffer) the Cloudflare Worker already uses. Reused
// deliberately rather than reimplemented. Notably *simpler* here than in
// the Worker: the Worker needs the low-level libheif-wasm/libheif.js
// factory plus a hand-written instantiateWasm + a static .wasm import,
// specifically because Workers has no filesystem — its own comment
// explains the nodejs_compat flag is only needed so esbuild can resolve
// the unconditional require("fs")/require("path") calls buried in
// libheif-js's Emscripten glue, calls that are never actually reached at
// Workers runtime. In a real Node runtime (this app's server actions all
// run in Node, never Edge), that Node branch *is* reached — confirmed
// directly: plain `require("libheif-js")` decodes a real HEIC file with
// zero manual WASM bootstrapping, since the glue code locates and reads
// libheif.wasm itself via fs relative to __dirname. So this file uses
// libheif-js's default Node entrypoint directly, not the Worker's
// low-level factory/instantiateWasm path — that machinery exists only to
// work around a constraint (no filesystem) this app's runtime doesn't have.
//
// Encode: sharp, not the Worker's jSquash WASM JPEG encoder. sharp is
// already a real dependency here (Next.js itself pulls it in for image
// optimization) and needs no WASM bootstrapping of its own. Confirmed
// directly that sharp can't replace libheif-js for the *decode* side even
// though its libvips build reports a heif version — a real HEIC (HEVC-
// compressed) file fails with "Support for this compression format has
// not been built in", since prebuilt libvips binaries exclude the HEVC
// codec plugin for patent-licensing reasons. So this is genuinely a
// decode-with-libheif-js, encode-with-sharp split, not a sharp-only
// shortcut.
const HEIC_MIME_TYPES = new Set(["image/heic", "image/heif"]);

export function isHeicFile(contentType: string | null, filename: string | null): boolean {
  if (contentType && HEIC_MIME_TYPES.has(contentType.toLowerCase())) return true;
  // Fallback to extension: some browsers/OSes send a generic
  // application/octet-stream (or no type at all) for HEIC files picked
  // via a plain <input type="file">, rather than a proper image/heic —
  // the extension is the only reliable signal in that case.
  const ext = filename?.toLowerCase().match(/\.(heic|heif)$/)?.[1];
  return !!ext;
}

// Defensive cap only — not a quality/size feature. Real-world phone
// photos (iPhone default ~4032x3024, ~12MP) decode+encode in ~2s and
// ~400MB peak RSS, comfortably fine for a Vercel Node function. A
// pathological 36MP HEIC (a macOS desktop wallpaper used for testing this)
// took ~11s and ~950MB RSS to decode+encode at full resolution — still
// not a *failure*, but this cap exists so a genuinely extreme upload
// (the same real, accepted 48MP+ edge case already documented for the
// email path) degrades to a bounded, still-viewable JPEG rather than
// risking a function timeout/OOM on an unbounded decode. Deliberately
// much more generous than the email path's TARGET_MAX_DIMENSION=1600 —
// there's no attachment-size constraint here, and this app otherwise
// never compresses/resizes web-uploaded images.
const MAX_DIMENSION = 6000;

export class HeicConversionError extends Error {}

export async function convertHeicToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  // Lazily required (Node-only, CommonJS) rather than a static top-level
  // import: libheif-js's package "main" resolves to its Emscripten glue,
  // which does its filesystem-based wasm loading as an import-time side
  // effect — fine in this server-only module, but keeping it inside the
  // function makes that side effect obviously scoped to only the code
  // path that actually needs it.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const libheif = require("libheif-js") as {
    HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] };
  };

  let images: HeifImage[];
  try {
    images = new libheif.HeifDecoder().decode(bytes);
  } catch (err) {
    throw new HeicConversionError(
      `Could not decode HEIC/HEIF file: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
  if (images.length === 0) {
    throw new HeicConversionError("No images found in HEIC/HEIF file.");
  }

  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();

  // libheif-js's display() callback wants a real ImageData-shaped object
  // (a .data/.width/.height record it writes decoded pixels into) — same
  // minimal polyfill shape image-compression.ts uses in the Worker,
  // needed here too since this is a plain Node module, not a browser.
  const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
  const decoded = await new Promise<{ data: Uint8ClampedArray; width: number; height: number }>(
    (resolve, reject) => {
      image.display(target, (result) => {
        if (!result) {
          reject(new HeicConversionError("HEIC/HEIF decoding failed."));
          return;
        }
        resolve(result as { data: Uint8ClampedArray; width: number; height: number });
      });
    },
  );

  const buffer = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
  let pipeline = sharp(buffer, { raw: { width: decoded.width, height: decoded.height, channels: 4 } });
  if (Math.max(decoded.width, decoded.height) > MAX_DIMENSION) {
    pipeline = pipeline.resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  try {
    const jpeg = await pipeline.jpeg({ quality: 90 }).toBuffer();
    return new Uint8Array(jpeg);
  } catch (err) {
    throw new HeicConversionError(
      `Could not encode converted image: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
}

interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    callback: (result: { data: Uint8ClampedArray; width: number; height: number } | null) => void,
  ): void;
}

// filename.replace pattern matches the Worker's own convention exactly
// (cloudflare-worker/email-intake.ts) — same reasoning: the extension
// must follow the content once it's genuinely a different format, or the
// filename lies about what's actually stored.
export function replaceExtensionWithJpg(filename: string): string {
  return filename.replace(/\.[^./]*$/, "") + ".jpg";
}

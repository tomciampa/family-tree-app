import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode";
import encodeJpeg, { init as initJpegEncode } from "@jsquash/jpeg/encode";
import decodePng, { init as initPngDecode } from "@jsquash/png/decode";
import resize, { initResize } from "@jsquash/resize";
import libheifFactory from "libheif-js/libheif-wasm/libheif.js";
import { MAX_ATTACHMENT_BYTES } from "./size-limits";

// libheif-js has no shipped types for its hand-written high-level
// wrapper (HeifDecoder/HeifImage) — only for the low-level generated
// Emscripten bindings underneath it. Typed here to just what's actually
// used, confirmed against a real decode of a real HEIC file (see this
// feature's HEIC investigation notes) rather than guessed from docs.
interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(
    imageData: ImageData,
    callback: (result: ImageData | null) => void,
  ): void;
}
interface HeifNamespace {
  HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] };
}
type LibheifFactoryOptions = {
  instantiateWasm: (
    imports: WebAssembly.Imports,
    callback: (instance: WebAssembly.Instance) => void,
  ) => WebAssembly.Exports;
};

// Every jSquash codec here needs its compiled WASM handed to it
// explicitly via its own init() — their *default* self-init path
// (used automatically if init() is never called) does
// `fetch(new URL('./codec.wasm', import.meta.url))`, which only works
// against a real http(s) same-origin asset. Confirmed by actually
// running this: under plain Node it fails outright ("fetch failed",
// since Node's fetch doesn't support file:// URLs), and the real
// Cloudflare Workers runtime has no filesystem and no same-origin static
// asset to fetch either — so the default path was never going to work in
// *either* target environment, only in a browser. initCodecs below must
// be called once, with each codec's real compiled WebAssembly.Module,
// before compressImage is ever used. Where those Modules come from is
// deliberately NOT this file's concern — the real Worker gets them from
// static .wasm imports (Wrangler's documented, bundler-native way to
// ship a .wasm file with a Worker), while local Node verification gets
// them via fs.readFileSync + WebAssembly.compile — see each caller.
// libheif-js's own init works differently from jSquash's — one factory
// call (with an instantiateWasm override, the same Emscripten pattern
// jSquash's codecs use internally) produces one long-lived namespace
// object with HeifDecoder on it, rather than a per-function init(). The
// result is cached here, the same "initialize once, reuse across every
// decode call" shape as the jSquash codecs.
let heifNamespace: HeifNamespace | null = null;

export async function initCodecs(wasm: {
  jpegDecode: WebAssembly.Module;
  jpegEncode: WebAssembly.Module;
  pngDecode: WebAssembly.Module;
  resize: WebAssembly.Module;
  heicDecode: WebAssembly.Module;
}): Promise<void> {
  const factory = libheifFactory as unknown as (
    opts: LibheifFactoryOptions,
  ) => Promise<HeifNamespace>;
  const [, , , , heif] = await Promise.all([
    initJpegDecode(wasm.jpegDecode),
    initJpegEncode(wasm.jpegEncode),
    initPngDecode(wasm.pngDecode),
    initResize(wasm.resize),
    factory({
      instantiateWasm: (imports, callback) => {
        const instance = new WebAssembly.Instance(wasm.heicDecode, imports);
        callback(instance);
        return instance.exports;
      },
    }),
  ]);
  heifNamespace = heif;
}

// jSquash's own .d.ts files reference the standard DOM ImageData type,
// which isn't in this project's lib (no "dom" — this is a Workers
// runtime, not a browser). Declared globally here to match, alongside
// the real runtime polyfill below (jSquash needs both: the type for
// tsc, the actual constructor for the WASM code to run against).
declare global {
  interface ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }
  var ImageData: { new (data: Uint8ClampedArray, width: number, height?: number): ImageData };
}

// sharp (the obvious first choice — it's what the main Next.js app would
// reach for) needs native libvips bindings and cannot run in the V8
// isolate sandbox Cloudflare Workers use — confirmed via investigation,
// not assumed. jSquash (WASM builds of the same codecs Squoosh uses:
// MozJPEG here) is the real, documented alternative that actually runs
// in Workers. Re-encodes everything as JPEG regardless of input format —
// this app explicitly prioritizes having the content at all over
// preserving original fidelity/format, and normalizing the output format
// keeps the size-targeting logic below simple (one quality knob, not a
// format-specific one per codec).
//
// @jsquash/resize's ImageData construction requires the browser/DOM
// ImageData constructor, which exists in neither the Workers runtime nor
// plain Node by default (confirmed via investigation) — polyfilled here
// with the minimal shape jSquash actually touches (data/width/height).
// Registered once, defensively (only if not already present), since this
// module is imported both by the real Worker and by local Node test
// scripts that exercise this same code directly.
if (typeof (globalThis as unknown as { ImageData?: unknown }).ImageData === "undefined") {
  class ImageDataPolyfill {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height?: number) {
      this.data = data;
      this.width = width;
      this.height = height ?? data.length / 4 / width;
    }
  }
  (globalThis as unknown as { ImageData: unknown }).ImageData = ImageDataPolyfill;
}

// Formats this Stage can decode: jSquash (JPEG/PNG) plus libheif-js
// (HEIC/HEIF — the real-world case this matters most for, since it's
// iPhone's default photo format and iPhones are most of what actually
// emails a photo in). An image/* attachment in any other format
// (webp/gif/etc.) simply can't be compressed by this Stage — reported as
// a real, honest limitation rather than a silently-wrong "compression
// succeeded" for a format that was never actually decoded.
const DECODABLE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/heic", "image/heif"]);
const HEIC_TYPES = new Set(["image/heic", "image/heif"]);

export function isCompressibleImageType(contentType: string): boolean {
  return DECODABLE_TYPES.has(contentType.toLowerCase());
}

// Unlike JPEG/PNG (fine to upload byte-for-byte unchanged when already
// small), HEIC/HEIF needs to go through decode+re-encode regardless of
// size — most browsers (everything except Safari) can't render HEIC at
// all, so a "small enough, skip compression" HEIC file would still land
// as a broken, unviewable image in the gallery. The size tiers in
// size-limits.ts are purely about byte count and don't know about this;
// callers (email-intake.ts) check this separately.
export function isHeicType(contentType: string): boolean {
  return HEIC_TYPES.has(contentType.toLowerCase());
}

async function decodeHeic(bytes: ArrayBuffer): Promise<ImageData> {
  if (!heifNamespace) throw new Error("HEIC decoder not initialized — call initCodecs first.");
  const images = heifNamespace.HeifDecoder
    ? new heifNamespace.HeifDecoder().decode(new Uint8Array(bytes))
    : [];
  if (images.length === 0) throw new Error("No images found in HEIC/HEIF file.");
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  const target = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
  return new Promise<ImageData>((resolve, reject) => {
    image.display(target, (result) => {
      if (!result) {
        reject(new Error("HEIC/HEIF decoding failed."));
        return;
      }
      resolve(result);
    });
  });
}

async function decode(contentType: string, bytes: ArrayBuffer): Promise<ImageData> {
  const type = contentType.toLowerCase();
  if (type === "image/png") return decodePng(bytes);
  if (HEIC_TYPES.has(type)) return decodeHeic(bytes);
  return decodeJpeg(bytes);
}

// Bounded, deterministic attempt sequence — not an open-ended search.
// Resolution reduction does most of the real work for a typical
// oversized phone photo (a 12MP original re-encoded at the same
// resolution and even low quality is often still >1MB just from raw
// pixel entropy); quality reduction fine-tunes within each resolution
// step. Gives up after these 4 attempts rather than looping arbitrarily
// — an image that still can't fit under MAX_ATTACHMENT_BYTES after a
// resize to 800px on its longest side at quality 40 is a genuinely
// pathological case (or the polyfill/codec silently failed), not one
// more retry away from succeeding.
const ATTEMPTS: { maxDimension: number; quality: number }[] = [
  { maxDimension: 2000, quality: 75 },
  { maxDimension: 2000, quality: 45 },
  { maxDimension: 1200, quality: 60 },
  { maxDimension: 800, quality: 40 },
];

function scaledDimensions(width: number, height: number, maxDimension: number) {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height };
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// `kind` lets callers pick an accurate rejection message instead of
// collapsing every failure into one generic string — found as a real
// bug while building this: email-intake.ts originally mapped every
// !compressed.ok case (unsupported format, corrupt/undecodable file, OR
// genuinely too large even after max compression) to the exact same
// "too large" bounce message, even though this function already knew
// which one actually happened. "unsupported-format" and "decode-failed"
// are both genuinely different from "too-large" from the sender's point
// of view — a sender whose HEIC photo was rejected because of some other
// format entirely shouldn't be told "make it smaller", and a corrupted
// file isn't a size problem at all.
export type CompressResult =
  | { ok: true; bytes: ArrayBuffer; contentType: "image/jpeg" }
  | { ok: false; kind: "unsupported-format" | "decode-failed" | "too-large"; reason: string };

export async function compressImage(
  contentType: string,
  bytes: ArrayBuffer,
): Promise<CompressResult> {
  if (!isCompressibleImageType(contentType)) {
    return {
      ok: false,
      kind: "unsupported-format",
      reason: `Unsupported image format for compression: ${contentType} (only JPEG, PNG, and HEIC/HEIF can be compressed in this stage).`,
    };
  }

  let image: ImageData;
  try {
    image = await decode(contentType, bytes);
  } catch (err) {
    return {
      ok: false,
      kind: "decode-failed",
      reason: `Could not decode image: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  for (const attempt of ATTEMPTS) {
    const { width, height } = scaledDimensions(image.width, image.height, attempt.maxDimension);
    const resized =
      width === image.width && height === image.height
        ? image
        : await resize(image, { width, height });
    const encoded = await encodeJpeg(resized, { quality: attempt.quality });
    if (encoded.byteLength <= MAX_ATTACHMENT_BYTES) {
      return { ok: true, bytes: encoded, contentType: "image/jpeg" };
    }
  }

  return {
    ok: false,
    kind: "too-large",
    reason: `Image is too large to compress under the size limit even at reduced quality/resolution.`,
  };
}

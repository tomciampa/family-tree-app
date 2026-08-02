// Workers-side counterpart to src/lib/content-hash.ts's sha256Hex — can't
// import that module directly (separate bundler/runtime, same reason
// worker-entry.ts's WASM bootstrap is split out — see email-intake.ts's
// top comment), but SHA-256 is a deterministic standard algorithm, so a
// hex digest computed here via Web Crypto and one computed on the Next.js
// side via Node's crypto module are directly comparable for the same
// bytes.
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

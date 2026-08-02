// Real numbers this feature's size handling is built from — confirmed
// from actual docs, not guessed (see the Stage 1 follow-up investigation
// notes):
//
// - Vercel Functions (the runtime /api/email-intake actually runs on)
//   hard-cap request body size at 4.5 MB, platform-enforced, not
//   configurable — https://vercel.com/docs/functions/limitations
//   ("Request body size" section, confirmed current as of this
//   investigation). Exceeding it returns 413 FUNCTION_PAYLOAD_TOO_LARGE
//   *before* our route handler code ever runs — which is exactly why
//   compression has to happen here, in the Worker, before the POST, not
//   in the webhook route. Compressing after the body already failed to
//   arrive would be pointless.
// - This webhook's JSON payload carries each attachment as base64, which
//   inflates raw bytes by 4/3 (~1.333x). One email can carry multiple
//   attachments sharing that single 4.5 MB body — already demonstrated
//   working for a real 3-attachment payload.
//
// Working backward from the real 4.5 MB cap with a deliberate safety
// margin (own target body budget of 4 MB, not 4.5 — leaves headroom for
// JSON structural overhead, header bytes, and simple margin-for-error):
// 4 MB / 1.333 ≈ 3 MB of raw attachment bytes is the absolute most this
// webhook should ever try to send in one request. TOTAL_RAW_BUDGET_BYTES
// below is set well under even that (2.5 MB), specifically so a normal
// multi-photo email (2-3 attachments) fits reliably, not just a single
// one right at the edge.
export const MAX_ATTACHMENT_BYTES = 1_000_000; // 1 MB — small-tier ceiling AND the compression target for the medium tier
export const MAX_COMPRESSIBLE_INPUT_BYTES = 20_000_000; // 20 MB — covers virtually any real phone photo; beyond this, don't even attempt compression (Worker CPU/memory safety, not a real-world size)
export const TOTAL_RAW_BUDGET_BYTES = 2_500_000; // 2.5 MB — aggregate ceiling across every attachment in one email combined, post-compression

export type SizeTier = "small" | "needs-compression" | "too-large";

export function classifySize(rawBytes: number, isImage: boolean): SizeTier {
  if (rawBytes <= MAX_ATTACHMENT_BYTES) return "small";
  // Non-images have no compression tier at all (see the Stage 1
  // follow-up investigation: no simple, reliable compression exists for
  // arbitrary document types the way it does for photos) — anything over
  // the small-tier ceiling is simply too large.
  if (!isImage) return "too-large";
  if (rawBytes > MAX_COMPRESSIBLE_INPUT_BYTES) return "too-large";
  return "needs-compression";
}

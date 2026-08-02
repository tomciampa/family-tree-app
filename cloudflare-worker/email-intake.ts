import PostalMime from "postal-mime";
import { classifySize, TOTAL_RAW_BUDGET_BYTES } from "./size-limits";
import { compressImage, isHeicType } from "./image-compression";

// Cloudflare Email Worker for the email-based upload feature, Stage 1.
// Written and committed for version control now; NOT deployed yet —
// deployment (wrangler login, wrangler deploy, wiring up Cloudflare Email
// Routing's catch-all rule on the intake subdomain) is a manual step for
// afterward, per the Step 1 DNS investigation's recommendation to use a
// dedicated subdomain (e.g. uploads.talkthroughhistory.com) rather than
// the root domain.
//
// Flow: Cloudflare Email Routing delivers the raw inbound email to
// worker-entry.ts's email() handler -> postal-mime parses it -> the
// family token is read from the recipient address's own local-part (the
// part before @) -> the parsed email (sender, subject, attachments) is
// POSTed as JSON to the Next.js app's /api/email-intake route,
// authenticated with the same shared secret that route requires. This
// Worker does no family lookup of its own and trusts nothing about the
// token beyond its *format* — the real lookup (does this token belong to
// a real family?) only ever happens once, in the webhook itself, against
// the real database. Duplicating that check here would just be a second
// place that check could drift out of sync with the real one.
//
// Deliberately separate from worker-entry.ts (the actual `main` in
// wrangler.toml): that file's only job is the Workers-specific WASM
// bootstrap (static .wasm imports, only resolvable inside Wrangler's own
// bundler — confirmed by trying to import this logic directly in plain
// Node, which crashed immediately trying to parse raw WASM bytes as JS).
// Splitting it out means this file — the actual email-handling logic —
// can be exercised directly in Node against real parsed emails and a
// real local webhook, with codecs initialized the Node-equivalent way
// (fs + WebAssembly.compile instead of a static import). See the size-tier
// verification notes for this feature for how that's actually run.
// handleEmail assumes its caller has already made sure the image codecs
// are initialized (worker-entry.ts does this for the real deployment;
// local test scripts do the equivalent before calling this directly).

export interface Env {
  EMAIL_INTAKE_URL: string; // e.g. "https://talkthroughhistory.com/api/email-intake"
  EMAIL_INTAKE_SECRET: string; // must match the Next.js app's EMAIL_INTAKE_SECRET exactly
}

// Matches families.email_upload_token's actual shape (see the migration:
// gen_random_uuid() with dashes stripped) — 32 lowercase hex characters.
// Checked before ever attempting to parse/forward the email, so a
// clearly-bogus recipient address (typo, spam, an old/rotated token)
// bounces immediately with a clean SMTP-level rejection instead of
// costing a parse + an HTTP round trip that was always going to fail the
// same way, just later and less clearly.
const TOKEN_FORMAT = /^[0-9a-f]{32}$/;

function extractToken(recipient: string): string | null {
  const localPart = recipient.split("@")[0]?.trim().toLowerCase();
  if (!localPart) return null;
  return TOKEN_FORMAT.test(localPart) ? localPart : null;
}

// Workers don't have Node's Buffer available by default. btoa() only
// accepts a binary string, and spreading a large Uint8Array directly into
// String.fromCharCode blows the call stack for any real-sized attachment
// (a phone photo is routinely several MB) — chunking keeps each call well
// under that limit regardless of attachment size.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function handleEmail(message: ForwardableEmailMessage, env: Env) {
  const token = extractToken(message.to);
  if (!token) {
    // Cleanly bounces the message at the SMTP level with this reason —
    // Cloudflare Email Routing's own mechanism for "this Worker
    // deliberately doesn't want this message", distinct from a silent
    // drop. Never forwarded to the webhook at all: an unparseable
    // recipient can't possibly resolve to a real family, so there's
    // nothing useful the webhook could do with it either.
    message.setReject("Invalid upload address — no valid family token found.");
    return;
  }

  let parsed;
  try {
    parsed = await PostalMime.parse(message.raw);
  } catch (err) {
    message.setReject("Could not parse this email.");
    console.error("email-intake worker: postal-mime parse failed", err);
    return;
  }

  if (parsed.attachments.length === 0) {
    // Nothing for the webhook to do with a text-only email — reject
    // clearly rather than silently accepting and forwarding an empty
    // payload the webhook's own schema would just reject anyway.
    message.setReject("No attachments found — this address only accepts photo/document uploads.");
    return;
  }

  // Size preflight, all attachments, before building or sending
  // anything: Vercel's real 4.5 MB request body cap (see size-limits.ts)
  // is enforced by the platform before /api/email-intake's own code ever
  // runs, so compression has to happen here, and rejection has to happen
  // before the POST, not after a partial one. message.setReject bounces
  // the *entire* email at the SMTP level — there's no way to accept some
  // attachments and reject others within one message — so if any single
  // attachment can't be made to fit (or the combined total can't), the
  // whole email bounces with a specific reason, and nothing is ever sent
  // to the webhook. Nothing gets written to the DB in that case, since
  // the webhook never even receives a request.
  const preparedAttachments: { filename: string; contentType: string; bytes: ArrayBuffer }[] = [];
  let runningTotal = 0;
  for (const attachment of parsed.attachments) {
    const filename = attachment.filename || "attachment";
    const contentType = attachment.mimeType || "application/octet-stream";
    const rawBytes = attachment.content as ArrayBuffer;
    const isImage = contentType.toLowerCase().startsWith("image/");
    const tier = classifySize(rawBytes.byteLength, isImage);

    let finalBytes = rawBytes;
    let finalContentType = contentType;

    if (tier === "too-large") {
      message.setReject(
        `"${filename}" is too large to upload by email — try uploading it directly on the website instead.`,
      );
      return;
    }

    // HEIC/HEIF always needs decode+re-encode regardless of size tier —
    // unlike JPEG/PNG, most browsers besides Safari can't render HEIC at
    // all, so a "small enough to skip compression" HEIC file would still
    // land as a broken, unviewable image otherwise.
    if (tier === "needs-compression" || isHeicType(contentType)) {
      const compressed = await compressImage(contentType, rawBytes);
      if (!compressed.ok) {
        console.error(`email-intake worker: compression failed for "${filename}" (${compressed.kind}): ${compressed.reason}`);
        // Distinct, accurate bounce reasons per failure kind — a real
        // bug caught building this: every failure here used to collapse
        // into the same generic "too large" message regardless of why
        // compressImage actually failed (see CompressResult's own
        // comment in image-compression.ts).
        const humanReason =
          compressed.kind === "unsupported-format"
            ? `"${filename}" is in a format that isn't supported for email upload — try uploading it directly on the website instead.`
            : compressed.kind === "decode-failed"
              ? `"${filename}" couldn't be read (it may be corrupted) — try uploading it directly on the website instead.`
              : `"${filename}" is too large to upload by email — try uploading it directly on the website instead.`;
        message.setReject(humanReason);
        return;
      }
      finalBytes = compressed.bytes;
      finalContentType = compressed.contentType;
    }

    runningTotal += finalBytes.byteLength;
    if (runningTotal > TOTAL_RAW_BUDGET_BYTES) {
      message.setReject(
        "These attachments are too large combined to upload by email — try uploading them directly on the website instead, or send fewer per email.",
      );
      return;
    }

    // If the content type changed (compression always re-encodes as
    // JPEG, regardless of the original format), the filename's own
    // extension needs to follow it — caught for real while verifying
    // this feature: a converted HEIC photo landed with the real,
    // genuinely viewable JPEG bytes correctly served as
    // content-type: image/jpeg, but was still displayed and stored
    // under its original "IMG_0001.heic" name, which would mislead
    // anyone looking at the filename (in the gallery UI or directly in
    // Storage) about what the file actually is.
    const finalFilename =
      finalContentType !== contentType ? filename.replace(/\.[^./]*$/, "") + ".jpg" : filename;

    preparedAttachments.push({ filename: finalFilename, contentType: finalContentType, bytes: finalBytes });
  }

  const payload = {
    token,
    from: {
      name: parsed.from?.name || null,
      email: parsed.from?.address || null,
    },
    subject: parsed.subject || null,
    attachments: preparedAttachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      contentBase64: arrayBufferToBase64(a.bytes),
    })),
  };

  let response: Response;
  try {
    response = await fetch(env.EMAIL_INTAKE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-email-intake-secret": env.EMAIL_INTAKE_SECRET,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // A transient network failure talking to the webhook is the one
    // case genuinely worth a generic bounce rather than a specific
    // reason — the sender did nothing wrong, but Email Routing has no
    // retry mechanism of its own, so leaving the message unacknowledged
    // isn't an option either.
    console.error("email-intake worker: fetch to webhook failed", err);
    message.setReject("Upload service temporarily unavailable — please try again shortly.");
    return;
  }

  if (!response.ok) {
    // Surfaces the webhook's own rejection (e.g. an unknown/rotated
    // token that merely *looked* well-formed) as a clean bounce too,
    // rather than swallowing it — same "reject clearly, never silently
    // succeed" principle the webhook itself follows.
    const bodyText = await response.text().catch(() => "");
    console.error(`email-intake worker: webhook rejected (${response.status}): ${bodyText}`);
    message.setReject("This upload address is no longer valid.");
  }
}

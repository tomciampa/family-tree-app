import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { sanitizeFilenameForStorageKey } from "@/lib/sanitize-filename";
import { deriveEmailCaption, truncateCaption } from "./clean-email-body";
import {
  extractCandidatesFromDocument,
  matchCandidatesForDocument,
} from "@/app/documents/actions";

// Intake endpoint for the email-based upload feature. Nothing here is
// user-session-authenticated — there is no browser, no cookies, no signed-
// in account on this path at all. The (not-yet-deployed) Cloudflare
// Worker in cloudflare-worker/email-intake.ts is the only intended
// caller: it parses a raw inbound email, resolves the family from the
// recipient address's local-part, and POSTs the shared JSON shape below
// with this route's shared-secret header attached. Authorization here is
// entirely the shared secret plus a valid family token found *in* the
// payload — never an auth.users session, which is why every write below
// uses the service-role client (RLS has nothing to check against, since
// there's no authenticated user to scope it to) and why uploaded_by is
// always left null (see the migration this shipped with for why that's
// correct, not a bug: honest provenance goes in
// source/submitted_by_name/submitted_by_email instead, which are display
// fields only, never treated as authentication).
const SECRET_HEADER = "x-email-intake-secret";

const payloadSchema = z.object({
  token: z.string().min(1),
  from: z.object({
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  }),
  subject: z.string().nullable().optional(),
  bodyText: z.string().nullable().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        contentType: z.string().min(1),
        contentBase64: z.string().min(1),
      }),
    )
    .min(1),
});

type AttachmentResult =
  | { filename: string; status: "photo"; id: string }
  | { filename: string; status: "document"; id: string; extractionError: string | null }
  | { filename: string; status: "error"; error: string };

export async function POST(request: Request) {
  const providedSecret = request.headers.get(SECRET_HEADER);
  const expectedSecret = process.env.EMAIL_INTAKE_SECRET;
  // Both branches of this check are deliberate: an unconfigured secret
  // must fail closed (reject everything), never silently accept because
  // "nothing to compare against". Never echo providedSecret/expectedSecret
  // into a log or response either way — only whether they matched.
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
    console.error("email-intake: rejected, missing or invalid shared secret");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { token, from, subject, bodyText, attachments } = parsed.data;

  const supabase = createAdminClient();

  // Case-insensitive on purpose — see the migration comment on
  // families.email_upload_token for why (mail clients/providers aren't
  // reliably consistent about preserving local-part case).
  const normalizedToken = token.trim().toLowerCase();
  const { data: family, error: familyError } = await supabase
    .from("families")
    .select("id")
    .eq("email_upload_token", normalizedToken)
    .maybeSingle();

  // Reject clearly and loudly rather than silently succeeding — an
  // email that can't be attributed to a real family must never end up
  // attached to the wrong one, or quietly disappear with no trace
  // anywhere that it was ever received.
  if (familyError || !family) {
    console.error(
      `email-intake: unknown family token (rejected, nothing written): ${normalizedToken}`,
    );
    return NextResponse.json({ error: "Unknown upload address" }, { status: 404 });
  }
  const familyId = family.id;

  const submittedByName = from.name?.trim() || null;
  const submittedByEmail = from.email?.trim() || null;
  const emailSubject = subject?.trim() ? truncateCaption(subject.trim()) : null;
  // Photo captions prefer the email's own body text over its subject —
  // a forwarded email's subject is very often useless noise ("Fwd: Family
  // Picture of THe Week"), while the body (once cleaned of forward/reply
  // boilerplate — see clean-email-body.ts) is usually the sender's actual
  // words about the photo. Falls back to the subject only if the body is
  // empty or reduces to nothing after cleanup, and to no caption at all
  // if both are empty — never fabricates one.
  const photoCaption = deriveEmailCaption(bodyText ?? null, subject ?? null);

  const results: AttachmentResult[] = [];
  for (const attachment of attachments) {
    try {
      const bytes = Buffer.from(attachment.contentBase64, "base64");
      const safeFilename = sanitizeFilenameForStorageKey(attachment.filename);
      const isImage = attachment.contentType.toLowerCase().startsWith("image/");
      const bucket = isImage ? "photos" : "documents";
      const storagePath = `${familyId}/${crypto.randomUUID()}-${safeFilename}`;

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(storagePath, bytes, { contentType: attachment.contentType });
      if (uploadError) {
        results.push({ filename: attachment.filename, status: "error", error: uploadError.message });
        continue;
      }

      if (isImage) {
        const { data: inserted, error: insertError } = await supabase
          .from("photos")
          .insert({
            family_id: familyId,
            storage_path: storagePath,
            original_filename: attachment.filename,
            caption: photoCaption,
            uploaded_by: null,
            source: "email",
            submitted_by_name: submittedByName,
            submitted_by_email: submittedByEmail,
          })
          .select("id")
          .single();
        if (insertError || !inserted) {
          await supabase.storage.from(bucket).remove([storagePath]);
          results.push({
            filename: attachment.filename,
            status: "error",
            error: insertError?.message ?? "Failed to save photo.",
          });
          continue;
        }
        results.push({ filename: attachment.filename, status: "photo", id: inserted.id });
        continue;
      }

      // Non-image: documents table. email_subject deliberately stays
      // subject-only, NOT switched to the body-preferring logic photos.
      // caption now uses — it's a differently-purposed field, not a
      // user-facing caption at all, just a short provenance-display
      // label (the same role an interview segment's own short label
      // already plays), shown alongside a document that also has its
      // own real extracted content (transcription_raw) and, once
      // viewed, an AI-classified kind. Photos have no equivalent —
      // caption is the *only* descriptive text a photo ever gets, which
      // is what actually justifies pulling in and cleaning the full
      // body for it.
      //
      // Goes in the dedicated email_subject column, NOT kind — kind is
      // lazily AI-classified on first view (getDocumentForViewer in
      // tree/actions.ts, via `document.kind ?? classifyDocumentKind(...)`)
      // and that classification would never run at all if kind already
      // held a truthy value from insert. Confirmed this collision for
      // real before picking email_subject instead: reusing kind wouldn't
      // have silently overwritten anything, but it would have
      // permanently blocked the real category classification for every
      // emailed-in document, leaving the raw subject line stuck as the
      // viewer's header forever. kind is left unset here on purpose so
      // classification runs normally, same as any other upload source.
      const { data: inserted, error: insertError } = await supabase
        .from("documents")
        .insert({
          family_id: familyId,
          file_path: storagePath,
          filename: attachment.filename,
          document_type: attachment.contentType || null,
          status: "pending_match",
          email_subject: emailSubject,
          uploaded_by: null,
          source: "email",
          submitted_by_name: submittedByName,
          submitted_by_email: submittedByEmail,
        })
        .select("id")
        .single();
      if (insertError || !inserted) {
        await supabase.storage.from(bucket).remove([storagePath]);
        results.push({
          filename: attachment.filename,
          status: "error",
          error: insertError?.message ?? "Failed to save document.",
        });
        continue;
      }
      const documentId = inserted.id;

      // Same two-step auto-chain a normal /documents upload triggers
      // right after uploadDocument succeeds (documents-view.tsx) — just
      // called directly here instead of from a browser, via the
      // service-role override both functions accept for exactly this
      // caller. Persisted to extraction_error on failure (cleared on
      // success) rather than left in ephemeral state, since — unlike the
      // interactive upload flow — there's no open browser tab here for a
      // component-local error to ever be seen; extraction_error is the
      // same durable-failure column the interview pipeline already
      // established for this identical "no live UI" situation.
      let extractionError: string | null = null;
      const extracted = await extractCandidatesFromDocument(documentId, { supabase });
      if ("error" in extracted) {
        extractionError = extracted.error;
      } else {
        const matched = await matchCandidatesForDocument(documentId, { supabase, familyId });
        if ("error" in matched) extractionError = matched.error;
      }
      await supabase.from("documents").update({ extraction_error: extractionError }).eq("id", documentId);

      results.push({ filename: attachment.filename, status: "document", id: documentId, extractionError });
    } catch (err) {
      results.push({
        filename: attachment.filename,
        status: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return NextResponse.json({ familyId, results });
}

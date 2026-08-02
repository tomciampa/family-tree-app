// Turns a raw email body (postal-mime's email.text — confirmed by
// actually parsing a representative forwarded email that it preserves
// the "Begin forwarded message:" block, the original headers, and any
// "Sent from my iPhone"-style signature verbatim, with zero cleanup of
// its own) into something worth showing as a photo caption. Deliberately
// simple: a handful of well-known, common patterns, not an exhaustive
// email-parsing library. Anything that doesn't match one of these
// patterns is left alone — under-stripping (leaving some boilerplate in)
// is a much smaller problem than over-stripping (accidentally eating
// real content by pattern-matching too aggressively).

// Apple Mail's "Begin forwarded message:", Gmail's
// "---------- Forwarded message ---------", and Outlook's
// "-----Original Message-----" — the three real formats checked against
// directly (not a guess at every possible mail client's wording).
const FORWARD_MARKER = /^-{2,}\s*(forwarded message|original message)\s*-{2,}$|^begin forwarded message:?$/i;

// The line immediately preceding a quoted reply, e.g.
// "On Dec 15, 2009, at 3:42 PM, John Smith wrote:" — followed by
// `>`-prefixed quoted lines, a convention consistent across virtually
// every mail client.
const REPLY_HEADER = /^on .+ wrote:$/i;

// A forwarded message's own header block (From/To/Subject/Date/Sent) —
// only matched immediately after a FORWARD_MARKER line, never on its
// own, so a genuine sentence that happens to start with one of these
// words elsewhere in the body is never mistaken for a header.
const EMAIL_HEADER_LINE = /^(from|to|cc|bcc|subject|date|sent):\s*.*/i;

// A short, fixed list of common one-line mail-client signatures — not
// an attempt to catch every possible sign-off.
const SIGNATURE_PATTERNS = [
  /^sent from my iphone$/i,
  /^sent from my ipad$/i,
  /^sent from my android(?: device)?$/i,
  /^sent from yahoo mail.*$/i,
  /^get outlook for (ios|android)$/i,
];

export const CAPTION_MAX_LENGTH = 200;

export function cleanEmailBody(raw: string): string {
  let lines = raw.replace(/\r\n/g, "\n").split("\n");

  // Strip a forwarded-message header block: the marker line, then any
  // immediately-following blank lines and From/To/Subject/Date-style
  // header lines — keep only what comes after. Only handles the
  // outermost forward; a forward-of-a-forward-of-a-forward is a rare
  // enough case that leaving its own inner marker/header lines in place
  // (rather than trying to strip every nested layer) is an acceptable,
  // honest limitation rather than a fragile recursive parser.
  const forwardIdx = lines.findIndex((l) => FORWARD_MARKER.test(l.trim()));
  if (forwardIdx !== -1) {
    let i = forwardIdx + 1;
    while (i < lines.length && lines[i].trim() === "") i++;
    while (i < lines.length && EMAIL_HEADER_LINE.test(lines[i].trim())) i++;
    lines = lines.slice(i);
  }

  // Strip a reply-chain header and the quoted (`>`-prefixed) lines that
  // follow it, wherever it appears.
  const withoutQuotes: string[] = [];
  let skippingQuote = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (REPLY_HEADER.test(trimmed)) {
      skippingQuote = true;
      continue;
    }
    if (skippingQuote) {
      if (trimmed.startsWith(">") || trimmed === "") continue;
      skippingQuote = false;
    }
    withoutQuotes.push(line);
  }
  lines = withoutQuotes;

  // Strip known one-line signatures.
  lines = lines.filter((l) => !SIGNATURE_PATTERNS.some((p) => p.test(l.trim())));

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncateCaption(text: string, maxLength = CAPTION_MAX_LENGTH): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim() + "…";
}

// Caption priority: cleaned body text if it contains anything real,
// otherwise the subject line, otherwise null (no caption at all — never
// fabricate one). Both candidates get the same length cap; a very long
// subject is just as unwelcome as a very long body in a caption field.
//
// Takes the ALREADY-cleaned body, not raw bodyText — the caller (the
// webhook route) now also uses that same cleaned result to decide
// whether to create a separate email-body-note record at all, and
// calling cleanEmailBody twice on the same raw text would risk the two
// decisions drifting apart if that function's behavior ever changes.
// Call cleanEmailBody(bodyText) once upstream and pass its result here.
export function deriveEmailCaption(
  cleanedBody: string,
  subject: string | null,
): string | null {
  if (cleanedBody) return truncateCaption(cleanedBody);

  const trimmedSubject = subject?.trim() ?? "";
  if (trimmedSubject) return truncateCaption(trimmedSubject);

  return null;
}

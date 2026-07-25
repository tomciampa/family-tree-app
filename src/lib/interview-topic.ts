// Registry pattern mirroring documentTypeLabel in lib/documents.ts — one
// entry per fixed prompt topic (INTERVIEW_PROMPTS in
// app/interviews/prompts.ts), not a parallel special-case branch wherever
// a segment's topic needs to read naturally.
const FIXED_TOPIC_PHRASES: Record<string, string> = {
  Parents: "about their parents",
  Grandparents: "about their grandparents",
  Siblings: "about their siblings",
  Spouse: "about their spouse",
  Children: "about their children",
  "Closing thoughts": "closing thoughts",
};

// Gap-based segments (buildGapAwarePrompts in gap-prompts.ts) label
// themselves as `${personName} (${relationToAnchor})`, e.g. "Hugo
// (maternal grandfather)" — already close to natural language, so the
// fallback just wraps it rather than trying to generate new phrasing.
const GAP_LABEL_PATTERN = /^(.+) \((.+)\)$/;

// No gender data exists anywhere in this app (see CLAUDE.md) — "their" is
// used deliberately instead of guessing "his"/"her" for the interviewee.
export function interviewTopicPhrase(kind: string): string {
  if (kind in FIXED_TOPIC_PHRASES) return FIXED_TOPIC_PHRASES[kind];
  const match = kind.match(GAP_LABEL_PATTERN);
  if (match) {
    const [, name, relation] = match;
    return `about ${name} (their ${relation})`;
  }
  return `about ${kind}`;
}

// "7/24", not "7/24/2026" — this is a short contextual header, not a
// record of exactly when the interview happened; the interviews list
// page already shows the full date if that's ever needed.
function formatShortInterviewDate(recordedAt: string): string {
  const date = new Date(recordedAt);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// The document viewer modal's header for an interview segment, built
// deterministically from data already on hand (the parent session's
// interviewee and recording date, the segment's own kind label) rather
// than a new AI call — e.g. "7/24 interview with Tom Ciampa — about their
// siblings."
export function buildInterviewSourceHeader(params: {
  intervieweeName: string;
  recordedAt: string | null;
  kind: string;
}): string {
  const datePrefix = params.recordedAt ? `${formatShortInterviewDate(params.recordedAt)} ` : "";
  return `${datePrefix}interview with ${params.intervieweeName} — ${interviewTopicPhrase(params.kind)}`;
}

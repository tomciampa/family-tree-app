import type { Tables } from "@/lib/supabase/database.types";

type Fact = Tables<"facts">;

// Two visual variants sharing one rendering path: "plain" matches
// PersonPanel's original inline styling exactly (so extracting this out
// changed nothing there), "archival" is for the case-file dossier's
// parchment/ink palette (see globals.css's .f3.f3-cont theme block for
// where those same tones come from).
const THEME = {
  plain: {
    container:
      "mb-4 flex flex-col gap-2 border-b border-gray-200 pb-4 dark:border-gray-800",
    label: "text-xs uppercase tracking-wide text-gray-500",
    badge:
      "rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    empty: null,
  },
  archival: {
    container: "flex flex-col gap-3",
    label: "text-xs uppercase tracking-wide text-[#6b5c45]",
    badge:
      "rounded border border-[#c9b896] bg-[#efe6d2] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#6b5c45]",
    empty: "text-sm italic text-[#6b5c45]",
  },
} as const;

export const sourceBadgeClassName = THEME.plain.badge;

export function FactList({
  facts,
  theme = "plain",
}: {
  facts: Fact[];
  theme?: keyof typeof THEME;
}) {
  const t = THEME[theme];

  if (facts.length === 0) {
    return t.empty ? <p className={t.empty}>No sourced facts recorded yet.</p> : null;
  }

  return (
    <div className={t.container}>
      {facts.map((fact) => (
        <div key={fact.id} className="flex items-start justify-between gap-2 text-sm">
          <div>
            <span className={t.label}>{fact.field}</span>
            <p>{fact.value}</p>
          </div>
          {/* Clickable regardless of source_type (document/letter/chart/
              conflict all go through the same document_id link) — opens
              the document review page in a new tab with this fact's own
              value as the highlight needle, reusing the exact transcription
              highlight/scroll mechanism built for candidate-match hovering.
              A fact with no linked document (e.g. a firsthand/secondhand
              account with nothing scanned) stays a plain, non-interactive
              badge — there's nothing to open. */}
          {fact.document_id ? (
            <a
              href={`/documents/${fact.document_id}?highlightText=${encodeURIComponent(fact.value)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`${t.badge} cursor-pointer hover:underline`}
              title="View source document"
            >
              {fact.source_type}
            </a>
          ) : (
            <span className={t.badge}>{fact.source_type}</span>
          )}
        </div>
      ))}
    </div>
  );
}

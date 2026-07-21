"use client";

import { useState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import { DocumentViewerModal } from "./document-viewer-modal";

type Fact = Tables<"facts">;

// Three visual variants sharing one rendering path: "plain" matches
// PersonPanel's original inline styling exactly (so extracting this out
// changed nothing there), "archival" was the case-file dossier's
// parchment/ink palette, and "neutral" (visual redesign stage 5) is its
// replacement — the same new design tokens the tree cards use (see
// globals.css's .f3.f3-cont theme block), via Tailwind's arbitrary-value
// syntax so these stay wired to design-tokens.css rather than duplicating
// hex values. "archival" is left in place rather than deleted even though
// nothing uses it anymore post-migration, in case it's wanted again.
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
  neutral: {
    container: "flex flex-col gap-3",
    label:
      "text-[length:var(--font-size-caption)] uppercase tracking-wide text-[color:var(--color-text-secondary)]",
    badge:
      "rounded-[var(--radius-xs)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)]",
    empty:
      "text-sm italic text-[color:var(--color-text-secondary)]",
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
  // Which fact's source badge is currently open in the viewer modal, if
  // any — null document_id was already excluded from being clickable in
  // the first place, so this is only ever set to a real, viewable fact.
  const [openFact, setOpenFact] = useState<Fact | null>(null);

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
              the document viewer modal with this fact's own value as the
              highlight needle, reusing the exact transcription
              highlight/scroll mechanism built for candidate-match
              hovering. A fact with no linked document (e.g. a
              firsthand/secondhand account with nothing scanned) stays a
              plain, non-interactive badge — there's nothing to open. */}
          {fact.document_id ? (
            <button
              type="button"
              onClick={() => setOpenFact(fact)}
              className={`${t.badge} cursor-pointer hover:underline`}
              title="View source document"
            >
              {fact.source_type}
            </button>
          ) : (
            <span className={t.badge}>{fact.source_type}</span>
          )}
        </div>
      ))}

      {openFact && openFact.document_id && (
        <DocumentViewerModal
          documentId={openFact.document_id}
          highlightText={openFact.value}
          onClose={() => setOpenFact(null)}
        />
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type DeleteImpact = {
  factCount: number;
  anecdoteCount: number;
  personNames: string[];
};

function describeLinkedData(impact: DeleteImpact) {
  const parts: string[] = [];
  if (impact.factCount > 0) {
    parts.push(
      `${impact.factCount} linked fact${impact.factCount === 1 ? "" : "s"}`,
    );
  }
  if (impact.anecdoteCount > 0) {
    parts.push(
      `${impact.anecdoteCount} linked stor${impact.anecdoteCount === 1 ? "y" : "ies"}`,
    );
  }
  return parts.join(" and ");
}

// Shared two-tier delete confirmation used by both the document pipeline
// (documents/delete-document-button.tsx) and the interview pipeline
// (interviews/delete-interview-button.tsx) — one dialog implementation,
// not a parallel copy per pipeline. Each caller supplies its own
// impact-check and delete server actions; this component only owns the
// dialog state/UI. Fetches impact fresh every time it opens (rather than
// trusting a possibly-stale prop) since resolving a candidate can create
// new facts/anecdotes at any time right up until deletion.
export function DeleteWithImpactButton({
  title,
  fetchImpact,
  onConfirmDelete,
  onDeleted,
  redirectTo,
}: {
  // Full dialog heading, e.g. `Delete "my-doc.pdf"?` or `Delete this
  // interview with Jeff Ciampa?` — phrasing differs enough between
  // pipelines that it's simplest for each caller to supply it directly.
  title: string;
  fetchImpact: () => Promise<{ error: string } | { impact: DeleteImpact }>;
  onConfirmDelete: () => Promise<{ error: string } | { success: true }>;
  // List page: remove the row locally (e.g. a no-op, relying on the
  // delete action's own revalidatePath to refresh the list).
  onDeleted?: () => void;
  // Detail page: navigate back to the list page after a successful
  // delete, when no onDeleted is given.
  redirectTo?: string;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoadingImpact, setIsLoadingImpact] = useState(false);
  const [impact, setImpact] = useState<DeleteImpact | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openDialog() {
    setError(null);
    setImpact(null);
    setIsOpen(true);
    setIsLoadingImpact(true);
    const result = await fetchImpact();
    setIsLoadingImpact(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setImpact(result.impact);
  }

  async function handleConfirmDelete() {
    setIsDeleting(true);
    setError(null);
    const result = await onConfirmDelete();
    setIsDeleting(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setIsOpen(false);
    if (onDeleted) {
      onDeleted();
    } else if (redirectTo) {
      router.push(redirectTo);
    }
  }

  const hasLinkedData =
    !!impact && (impact.factCount > 0 || impact.anecdoteCount > 0);

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs text-[color:var(--color-error)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-error-subtle-bg)]"
      >
        Delete
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isDeleting) setIsOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-5 shadow-[var(--shadow-2)]">
            <h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">
              {title}
            </h2>

            {isLoadingImpact ? (
              <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">
                Checking for linked data…
              </p>
            ) : (
              <>
                <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">
                  This cannot be undone.
                </p>

                {hasLinkedData && impact && (
                  <div className="mt-3 rounded-[var(--radius-md)] border-2 border-[color:var(--color-error)] bg-[color:var(--color-error-subtle-bg)] p-3">
                    <p className="text-base font-bold leading-snug text-[color:var(--color-error-subtle-fg)]">
                      This has {describeLinkedData(impact)} about{" "}
                      {impact.personNames.join(", ")} — deleting it will also
                      remove that data from your tree.
                    </p>
                  </div>
                )}
              </>
            )}

            {error && (
              <p className="mt-3 text-xs text-[color:var(--color-error)]">
                {error}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                disabled={isDeleting}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting || isLoadingImpact}
                className="rounded-[var(--radius-sm)] bg-[color:var(--color-error)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:opacity-90 disabled:opacity-50"
              >
                {isDeleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

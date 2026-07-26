"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { forkFamily, getForkPreview } from "@/app/settings/actions";

type Preview = Extract<Awaited<ReturnType<typeof getForkPreview>>, { counts: unknown }>;

function describeCounts(counts: Preview["counts"]) {
  const parts: string[] = [];
  if (counts.people > 0) parts.push(`${counts.people} ${counts.people === 1 ? "person" : "people"}`);
  if (counts.documents > 0) parts.push(`${counts.documents} document${counts.documents === 1 ? "" : "s"}`);
  if (counts.facts > 0) parts.push(`${counts.facts} fact${counts.facts === 1 ? "" : "s"}`);
  if (counts.anecdotes > 0) parts.push(`${counts.anecdotes} stor${counts.anecdotes === 1 ? "y" : "ies"}`);
  if (counts.events > 0) parts.push(`${counts.events} event${counts.events === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : "nothing yet";
}

// Modeled structurally on DeleteWithImpactButton (fetch real numbers every
// time the dialog opens, modal, disabled-while-pending, inline errors) but
// deliberately NOT its "this cannot be undone" framing — forking never
// touches the source family, so the copy here says so plainly instead.
export function ForkFamilyForm() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [isForking, setIsForking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  async function openDialog() {
    setError(null);
    setWarnings(null);
    setName("");
    setIsOpen(true);
    setIsLoadingPreview(true);
    const result = await getForkPreview();
    setIsLoadingPreview(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setPreview(result);
  }

  async function handleConfirm() {
    setError(null);
    setIsForking(true);
    const result = await forkFamily(name);
    setIsForking(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    if (result.warnings.length > 0) {
      // Stay on the dialog and show exactly what didn't copy cleanly,
      // rather than silently navigating away from a fork with missing
      // pieces.
      setWarnings(result.warnings);
      return;
    }
    router.push("/tree");
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="self-start rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-4 py-2 text-sm transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
      >
        Fork this family…
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isForking) setIsOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-5 shadow-[var(--shadow-2)]">
            <h2 className="text-sm font-semibold text-[color:var(--color-text-primary)]">
              Fork this family tree
            </h2>

            {isLoadingPreview ? (
              <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">
                Checking what will be copied…
              </p>
            ) : warnings ? (
              <div className="mt-3 flex flex-col gap-2">
                <p className="text-sm text-[color:var(--color-text-secondary)]">
                  Your new family tree was created, but some files didn&apos;t copy cleanly:
                </p>
                <ul className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] p-2 text-xs text-[color:var(--color-text-secondary)]">
                  {warnings.map((w, i) => (
                    <li key={i} className="break-words">
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              preview && (
                <>
                  <p className="mt-3 text-sm text-[color:var(--color-text-secondary)]">
                    This will copy everything in <strong>{preview.familyName}</strong> —{" "}
                    {describeCounts(preview.counts)} — into a brand-new, completely separate
                    family tree. Your current family tree is never modified by this, and nothing
                    stays linked between the two afterward.
                  </p>
                  <input
                    type="text"
                    required
                    autoFocus
                    placeholder="Name for the new family tree"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-3 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
                  />
                </>
              )
            )}

            {error && <p className="mt-3 text-xs text-[color:var(--color-error)]">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              {warnings ? (
                <button
                  type="button"
                  onClick={() => router.push("/tree")}
                  className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)]"
                >
                  Continue to new family tree
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setIsOpen(false)}
                    disabled={isForking}
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    disabled={isForking || isLoadingPreview || !name.trim()}
                    className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
                  >
                    {isForking ? "Forking…" : "Fork this family"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

"use client";

import { useState, useTransition } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import { deletePerson } from "./actions";
import { FactList } from "./fact-list";
import { AnecdoteList } from "./anecdote-list";
import { DocumentList, type PersonDocument } from "./document-list";
import { PersonIdentitySection } from "./person-identity";

type Person = Tables<"people">;
type Fact = Tables<"facts">;
type Anecdote = Tables<"anecdotes">;

// Display-only in the dossier — tagging itself happens from /photos'
// lightbox (see photo-lightbox.tsx), not from here. Just what the tab
// needs to render a photo the person is tagged in.
export type PersonPhoto = {
  id: string;
  viewUrl: string | null;
  originalFilename: string;
  caption: string | null;
};

type Tab = "facts" | "stories" | "documents" | "photos";

export function PersonDossier({
  person,
  facts,
  anecdotes,
  documents,
  photos,
  onClose,
}: {
  person: Person;
  facts: Fact[];
  anecdotes: Anecdote[];
  documents: PersonDocument[];
  photos: PersonPhoto[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("facts");
  const [isDeleting, startDeleting] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const tabs: { key: Tab; label: string }[] = [
    { key: "facts", label: "Facts" },
    { key: "stories", label: "Stories" },
    { key: "documents", label: "Documents" },
    { key: "photos", label: "Photos" },
  ];

  // The only delete path for an on-tree person now that family-chart's own
  // edit form (previously reachable via the card's ✎ button) is gone — see
  // tree-view.tsx's handleDeletePerson for the same pattern used for loose,
  // not-yet-connected people. Mentions exactly what's attached, same as
  // that one, plus the tree-structure note that one doesn't need (a loose
  // person has no parent/spouse/child links to lose).
  function handleDelete() {
    const hasData = facts.length + anecdotes.length + documents.length + photos.length > 0;
    const message = hasData
      ? `Delete ${person.name}? This also removes ${facts.length} fact(s), ${anecdotes.length} stor${anecdotes.length === 1 ? "y" : "ies"}, unlinks ${documents.length} document(s) and ${photos.length} photo tag(s) attached to them (the photos themselves aren't deleted), and removes them from the tree's parent/spouse/child structure. This can't be undone.`
      : `Delete ${person.name}? This also removes them from the tree's parent/spouse/child structure. This can't be undone.`;
    if (!window.confirm(message)) return;
    setDeleteError(null);
    startDeleting(async () => {
      const result = await deletePerson(person.id);
      if (result?.error) {
        setDeleteError(result.error);
        return;
      }
      onClose();
    });
  }

  return (
    <aside className="flex h-[75vh] w-full max-w-md shrink-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)] shadow-[var(--shadow-3)]">
      <div className="flex items-start justify-between gap-4 border-b border-[color:var(--color-border)] px-6 py-5">
        <div>
          <h2 className="text-[length:var(--font-size-heading-2)] leading-[var(--line-height-heading-2)] font-semibold">
            {person.is_placeholder ? `${person.name} (?)` : person.name}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
        >
          Close ✕
        </button>
      </div>

      <div className="flex border-b border-[color:var(--color-border)] px-6">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-4 py-3 text-sm font-medium transition-colors duration-[var(--duration-base)] ${
              tab === key
                ? "border-[color:var(--color-accent)] text-[color:var(--color-text-primary)]"
                : "border-transparent text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {tab === "facts" && (
          <div className="flex flex-col gap-6">
            <PersonIdentitySection person={person} facts={facts} />
            <FactList facts={facts} theme="neutral" />
          </div>
        )}
        {tab === "stories" && (
          <AnecdoteList anecdotes={anecdotes} theme="neutral" />
        )}
        {tab === "photos" && (
          <div className="flex flex-col gap-3">
            {photos.length === 0 ? (
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                No photos tagged of {person.name} yet.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {photos.map((photo) => (
                  <div key={photo.id} className="flex flex-col gap-1">
                    {photo.viewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photo.viewUrl}
                        alt={photo.originalFilename}
                        className="aspect-square w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] object-cover"
                      />
                    ) : (
                      <div className="aspect-square w-full rounded-[var(--radius-sm)] bg-[color:var(--color-bg-surface-alt)]" />
                    )}
                    {photo.caption && (
                      <span className="truncate text-xs text-[color:var(--color-text-secondary)]">
                        {photo.caption}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "documents" && (
          <DocumentList documents={documents} theme="neutral" showHeading={false} />
        )}
      </div>

      <div className="border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-surface-alt)] px-6 py-3">
        {deleteError && (
          <p className="mb-1 text-xs text-red-600">{deleteError}</p>
        )}
        <button
          type="button"
          onClick={handleDelete}
          disabled={isDeleting}
          className="text-xs text-red-600 underline hover:text-red-700 disabled:opacity-50"
        >
          {isDeleting ? "Deleting…" : "Delete this person"}
        </button>
      </div>
    </aside>
  );
}

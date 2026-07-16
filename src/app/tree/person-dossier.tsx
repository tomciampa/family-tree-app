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

type Tab = "facts" | "stories" | "documents";

export function PersonDossier({
  person,
  facts,
  anecdotes,
  documents,
  onClose,
}: {
  person: Person;
  facts: Fact[];
  anecdotes: Anecdote[];
  documents: PersonDocument[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("facts");
  const [isDeleting, startDeleting] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const tabs: { key: Tab; label: string }[] = [
    { key: "facts", label: "Facts" },
    { key: "stories", label: "Stories" },
    { key: "documents", label: "Documents" },
  ];

  // The only delete path for an on-tree person now that family-chart's own
  // edit form (previously reachable via the card's ✎ button) is gone — see
  // tree-view.tsx's handleDeletePerson for the same pattern used for loose,
  // not-yet-connected people. Mentions exactly what's attached, same as
  // that one, plus the tree-structure note that one doesn't need (a loose
  // person has no parent/spouse/child links to lose).
  function handleDelete() {
    const hasData = facts.length + anecdotes.length + documents.length > 0;
    const message = hasData
      ? `Delete ${person.name}? This also removes ${facts.length} fact(s), ${anecdotes.length} stor${anecdotes.length === 1 ? "y" : "ies"}, and unlinks ${documents.length} document(s) attached to them, and removes them from the tree's parent/spouse/child structure. This can't be undone.`
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
    <aside className="flex h-[75vh] w-full max-w-md shrink-0 flex-col overflow-hidden rounded-sm border border-[#c9b896] bg-[#f7f1e3] font-serif text-[#2b2015] shadow-xl">
      <div className="flex items-start justify-between gap-4 border-b border-[#c9b896] px-6 py-5">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[#6b5c45]">
            Case File
          </p>
          <h2 className="mt-1 text-2xl font-semibold">
            {person.is_placeholder ? `${person.name} (?)` : person.name}
          </h2>
          {deleteError && (
            <p className="mt-1 text-xs text-red-600">{deleteError}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[#c9b896] px-2 py-1 text-sm text-[#6b5c45] hover:bg-[#efe6d2]"
          >
            Close ✕
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting}
            className="text-xs text-red-600 underline hover:text-red-700 disabled:opacity-50"
          >
            {isDeleting ? "Deleting…" : "Delete this person"}
          </button>
        </div>
      </div>

      <div className="flex border-b border-[#c9b896] px-6">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
              tab === key
                ? "border-[#5c7360] text-[#2b2015]"
                : "border-transparent text-[#6b5c45] hover:text-[#2b2015]"
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
            <FactList facts={facts} theme="archival" />
          </div>
        )}
        {tab === "stories" && (
          <AnecdoteList anecdotes={anecdotes} theme="archival" />
        )}
        {tab === "documents" && (
          <DocumentList documents={documents} theme="archival" showHeading={false} />
        )}
      </div>
    </aside>
  );
}

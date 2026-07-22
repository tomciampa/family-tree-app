"use client";

import { useState, useTransition } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { PersonSearch } from "@/components/person-search";
import { setLinkedPerson } from "./actions";

type Person = Tables<"people">;

export function SettingsView({
  people,
  personSummaries,
  linkedPersonId,
}: {
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  linkedPersonId: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(linkedPersonId);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const linkedPerson = linkedPersonId
    ? (people.find((p) => p.id === linkedPersonId) ?? null)
    : null;

  function save(personId: string | null) {
    setError(null);
    setSavedMessage(null);
    startTransition(async () => {
      const result = await setLinkedPerson(personId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSavedMessage(
        personId ? "Saved." : "Cleared — you're not linked to anyone in the tree.",
      );
    });
  }

  function handleNotInTree() {
    setSelectedId(null);
    save(null);
  }

  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 shadow-[var(--shadow-2)]">
      <div>
        <h2 className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
          This is me
        </h2>
        <p className="mt-1 text-sm text-[color:var(--color-text-secondary)]">
          Link your account to your own record in the family tree. This is used to show your
          part of the tree by default when you open it.
        </p>
      </div>

      <p className="text-sm text-[color:var(--color-text-secondary)]">
        {linkedPerson ? (
          <>
            Currently linked to{" "}
            <strong className="text-[color:var(--color-text-primary)]">
              {linkedPerson.name}
            </strong>
            .
          </>
        ) : (
          "You're not linked to anyone in the tree yet."
        )}
      </p>

      <PersonSearch
        people={people}
        personSummaries={personSummaries}
        selectedId={selectedId}
        onSelect={setSelectedId}
        placeholder="Search for your name…"
      />

      {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}
      {savedMessage && (
        <p className="text-sm text-[color:var(--color-success-subtle-fg)]">{savedMessage}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => save(selectedId)}
          disabled={isPending || selectedId === linkedPersonId}
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={handleNotInTree}
          disabled={isPending || (!selectedId && !linkedPersonId)}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-4 py-2 text-sm transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
        >
          I&apos;m not in the tree yet
        </button>
      </div>
    </section>
  );
}

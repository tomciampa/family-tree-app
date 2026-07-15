"use client";

import { useState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";

type Person = Tables<"people">;

// Shared by the document-matching review workspace (search for the
// correct person when the AI matcher has nothing, or the wrong thing) and
// the tree's own "add sibling/parents/spouse & child" forms (search for
// an already-existing, possibly-unconnected person instead of creating a
// duplicate) — one search UI, not two independently-maintained ones.
export function PersonSearch({
  people,
  personSummaries,
  selectedId,
  onSelect,
  onHoverPerson,
  placeholder = "Search by name…",
}: {
  people: Person[];
  personSummaries?: Record<string, PersonSummary>;
  selectedId: string | null;
  onSelect: (personId: string) => void;
  onHoverPerson?: (personId: string, name: string) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");

  const results =
    query.trim().length > 0
      ? people
          .filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()))
          .slice(0, 20)
      : [];
  const selectedPerson = selectedId
    ? (people.find((p) => p.id === selectedId) ?? null)
    : null;

  return (
    <div className="flex flex-col gap-1">
      <input
        type="text"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="rounded border border-gray-300 px-2 py-1 text-xs text-black dark:border-gray-700 dark:bg-gray-800 dark:text-white"
      />
      {selectedPerson && (
        <p className="text-[11px] font-medium text-blue-700 dark:text-blue-400">
          Selected: {selectedPerson.name}
        </p>
      )}
      {query.trim().length > 0 && (
        <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded border border-gray-200 dark:border-gray-800">
          {results.length === 0 && (
            <p className="px-2 py-1 text-[11px] text-gray-500">
              No one matches &quot;{query}&quot;.
            </p>
          )}
          {results.map((p) => {
            const summary = personSummaries?.[p.id];
            const dates = [summary?.birthEstimate, summary?.deathEstimate]
              .filter(Boolean)
              .join(" – ");
            const isSelected = selectedId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p.id)}
                onMouseEnter={() => onHoverPerson?.(p.id, p.name)}
                aria-pressed={isSelected}
                className={`flex flex-col items-start px-2 py-1 text-left text-[11px] hover:bg-gray-50 dark:hover:bg-gray-800/60 ${
                  isSelected ? "bg-blue-100 dark:bg-blue-950/60" : ""
                }`}
              >
                <span className="font-medium text-gray-800 dark:text-gray-200">
                  {isSelected ? "✓ " : ""}
                  {p.name}
                </span>
                <span className="text-gray-500 dark:text-gray-500">
                  {dates && `${dates} · `}
                  {summary?.relationshipSummary ?? "not yet in the tree"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

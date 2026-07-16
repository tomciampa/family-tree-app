"use client";

import { useState, useTransition } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import {
  addParents,
  addSibling,
  addSpouseAndChild,
  addAnotherChild,
  type PersonRef,
} from "./actions";
import { PersonSearch } from "@/components/person-search";
import type { PersonSummary } from "@/lib/family";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;

type Relationship = "parent" | "sibling" | "spouse" | "child";

const relationshipLabels: Record<Relationship, string> = {
  parent: "Parent of",
  sibling: "Sibling of",
  spouse: "Spouse of",
  child: "Child of",
};

const inputClassName =
  "rounded border border-gray-300 px-3 py-2 text-sm text-black dark:border-gray-700 dark:bg-gray-800 dark:text-white";

// The other direction from Add parents/sibling/spouse & child on an
// anchor's own panel: those start from the anchor and search for who to
// attach, this starts from a loose, not-yet-connected person and searches
// for the anchor to attach THEM to. Same four mutations underneath either
// way — this just calls them with the loose person as the "existing"
// PersonRef instead of whatever was typed/picked on the anchor's side.
export function AttachToTreeForm({
  loosePerson,
  people,
  unions,
  personSummaries,
  onClose,
}: {
  loosePerson: Person;
  people: Person[];
  unions: UnionRow[];
  personSummaries: Record<string, PersonSummary>;
  onClose: () => void;
}) {
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [unionId, setUnionId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const otherPeople = people.filter((p) => p.id !== loosePerson.id);
  const anchor = anchorId ? (people.find((p) => p.id === anchorId) ?? null) : null;
  const anchorSummary = anchorId ? personSummaries[anchorId] : undefined;
  const anchorMarriages = anchorId
    ? unions
        .filter((u) => u.parent1_id === anchorId || u.parent2_id === anchorId)
        .map((u) => {
          const spouseId = u.parent1_id === anchorId ? u.parent2_id : u.parent1_id;
          return {
            unionId: u.id,
            spouseName: spouseId
              ? (people.find((p) => p.id === spouseId)?.name ?? "unknown spouse")
              : "unknown spouse",
          };
        })
    : [];

  // "Sibling" needs the anchor to already have recorded parents (same
  // precondition addSibling itself enforces — checked here too so the
  // option isn't offered only to error out). "Child" needs at least one
  // existing marriage to attach to, since addAnotherChild requires a
  // unionId and there's deliberately no "child with unknown second
  // parent" path in this app. "Parent" and "spouse" have no such gate.
  const canSibling = anchorId ? !!anchorSummary?.hasRecordedParents : true;
  const canChild = anchorId ? anchorMarriages.length > 0 : true;

  function resetAnchorDependentState() {
    setUnionId(null);
    setError(null);
  }

  async function runMutation(confirmed: boolean): Promise<
    { error: string } | { warning: string } | Record<string, never>
  > {
    if (!relationship || !anchorId) return { error: "Pick a relationship and person." };
    const loosePersonRef: PersonRef = { mode: "existing", personId: loosePerson.id };

    if (relationship === "parent") {
      return addParents(anchorId, loosePersonRef, null);
    }
    if (relationship === "sibling") {
      return addSibling(anchorId, loosePersonRef, confirmed);
    }
    if (relationship === "spouse") {
      return addSpouseAndChild(anchorId, loosePersonRef, null, confirmed);
    }
    if (!unionId) return { error: "Select which marriage to add this child to." };
    return addAnotherChild(unionId, loosePersonRef, confirmed);
  }

  function handleConfirm() {
    if (!relationship || !anchorId) {
      setError("Pick a relationship and search for the person to attach to.");
      return;
    }
    if (relationship === "parent" && anchorSummary?.hasRecordedParents) {
      const proceed = window.confirm(
        `${anchor?.name ?? "This person"} already has recorded parents. Adding ${loosePerson.name} as another parent will create a second, conflicting set — continue anyway?`,
      );
      if (!proceed) return;
    }

    setError(null);
    startTransition(async () => {
      const first = await runMutation(false);
      const result =
        "warning" in first
          ? window.confirm(first.warning)
            ? await runMutation(true)
            : null
          : first;
      if (!result) return;
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onClose();
    });
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/40 p-6 sm:p-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded border border-gray-300 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">Add {loosePerson.name} to the tree</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          >
            Close ✕
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-gray-500">
            {loosePerson.name} is the...
            <select
              value={relationship ?? ""}
              onChange={(e) => {
                setRelationship(e.target.value as Relationship);
                resetAnchorDependentState();
              }}
              className={inputClassName}
            >
              <option value="" disabled>
                Choose a relationship
              </option>
              {(Object.keys(relationshipLabels) as Relationship[]).map((r) => (
                <option key={r} value={r}>
                  {relationshipLabels[r]}
                </option>
              ))}
            </select>
          </label>

          {relationship && (
            <label className="flex flex-col gap-1 text-sm text-gray-500">
              ...of
              <PersonSearch
                people={otherPeople}
                personSummaries={personSummaries}
                selectedId={anchorId}
                onSelect={(id) => {
                  setAnchorId(id);
                  resetAnchorDependentState();
                }}
              />
            </label>
          )}

          {relationship === "sibling" && anchorId && !canSibling && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              {anchor?.name} doesn&apos;t have recorded parents yet — add
              parents to them first, or pick a different relationship.
            </p>
          )}

          {relationship === "child" && anchorId && !canChild && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              {anchor?.name} has no recorded marriage yet — use &quot;Spouse
              of&quot; first, or pick a different relationship.
            </p>
          )}

          {relationship === "child" && anchorMarriages.length > 1 && (
            <label className="flex flex-col gap-1 text-sm text-gray-500">
              Which marriage?
              <select
                value={unionId ?? ""}
                onChange={(e) => setUnionId(e.target.value)}
                className={inputClassName}
              >
                <option value="" disabled>
                  Choose a marriage
                </option>
                {anchorMarriages.map((m) => (
                  <option key={m.unionId} value={m.unionId}>
                    with {m.spouseName}
                  </option>
                ))}
              </select>
            </label>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={
                isPending ||
                !relationship ||
                !anchorId ||
                (relationship === "sibling" && !canSibling) ||
                (relationship === "child" &&
                  (!canChild ||
                    (anchorMarriages.length > 1 && !unionId)))
              }
              className="rounded border border-gray-300 px-3 py-2 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
            >
              {isPending ? "Saving…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useState } from "react";
import { FamilyTree } from "@/components/family-tree";
import { PersonPanel } from "./person-panel";
import type { Tables } from "@/lib/supabase/database.types";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;
type Fact = Tables<"facts">;
type Anecdote = Tables<"anecdotes">;

export function TreeView({
  people,
  unions,
  unionChildren,
  facts,
  anecdotes,
}: {
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  facts: Fact[];
  anecdotes: Anecdote[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Stable identity across re-renders — an inline arrow function here would
  // change reference every time selectedId changes, and FamilyTree's effect
  // (keyed in part on this callback) would tear down and rebuild the whole
  // chart on every click, undoing the library's own re-center-on-click.
  const handlePersonClick = useCallback(
    (person: Person) => setSelectedId(person.id),
    [],
  );

  const peopleById = new Map(people.map((p) => [p.id, p]));
  const childToUnion = new Map(
    unionChildren.map((uc) => [uc.child_id, uc.union_id]),
  );
  const selectedPerson = people.find((p) => p.id === selectedId) ?? null;

  const marriages = selectedPerson
    ? unions
        .filter(
          (u) =>
            u.parent1_id === selectedPerson.id ||
            u.parent2_id === selectedPerson.id,
        )
        .map((u) => {
          const spouseId =
            u.parent1_id === selectedPerson.id ? u.parent2_id : u.parent1_id;
          return {
            unionId: u.id,
            spouseName: spouseId ? (peopleById.get(spouseId)?.name ?? null) : null,
          };
        })
    : [];

  const personFacts = selectedPerson
    ? facts.filter((f) => f.person_id === selectedPerson.id)
    : [];

  const personAnecdotes = selectedPerson
    ? anecdotes.filter((a) => a.person_id === selectedPerson.id)
    : [];

  return (
    <>
      <FamilyTree
        people={people}
        unions={unions}
        unionChildren={unionChildren}
        onPersonClick={handlePersonClick}
      />
      {selectedPerson && (
        <PersonPanel
          person={selectedPerson}
          hasParents={childToUnion.has(selectedPerson.id)}
          marriages={marriages}
          facts={personFacts}
          anecdotes={personAnecdotes}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}

"use client";

import { useState } from "react";
import { FamilyTree } from "@/components/family-tree";
import { PersonPanel } from "./person-panel";
import type { Tables } from "@/lib/supabase/database.types";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;
type Fact = Tables<"facts">;

export function TreeView({
  people,
  unions,
  unionChildren,
  facts,
}: {
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  facts: Fact[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  return (
    <>
      <FamilyTree
        people={people}
        unions={unions}
        unionChildren={unionChildren}
        onPersonClick={(person) => setSelectedId(person.id)}
      />
      {selectedPerson && (
        <PersonPanel
          person={selectedPerson}
          hasParents={childToUnion.has(selectedPerson.id)}
          marriages={marriages}
          facts={personFacts}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}

"use client";

import { useState } from "react";
import { FamilyTree } from "@/components/family-tree";
import { PersonPanel } from "./person-panel";
import type { Tables } from "@/lib/supabase/database.types";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;

export function TreeView({
  people,
  unions,
  unionChildren,
}: {
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const childToUnion = new Map(
    unionChildren.map((uc) => [uc.child_id, uc.union_id]),
  );
  const selectedPerson = people.find((p) => p.id === selectedId) ?? null;

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
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );
}

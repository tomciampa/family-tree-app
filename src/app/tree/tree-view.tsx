"use client";

import { useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FamilyTree } from "@/components/family-tree";
import { PersonPanel } from "./person-panel";
import { PersonDossier } from "./person-dossier";
import type { PersonDocument } from "./document-list";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";

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
  personDocuments,
  personSummaries,
}: {
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  facts: Fact[];
  anecdotes: Anecdote[];
  personDocuments: PersonDocument[];
  personSummaries: Record<string, PersonSummary>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dossierId, setDossierId] = useState<string | null>(null);
  // "?highlight=<personId>" from the document candidate-match review
  // queue's "view in tree" link (see documents-view.tsx) — read once on
  // mount, since each click there opens a fresh tab/page load rather than
  // navigating within an already-open one.
  const searchParams = useSearchParams();
  const [highlightPersonId] = useState(() => searchParams.get("highlight"));
  // Stable identity across re-renders — an inline arrow function here would
  // change reference every time selectedId changes, and FamilyTree's effect
  // (keyed in part on this callback) would tear down and rebuild the whole
  // chart on every click, undoing the library's own re-center-on-click.
  const handlePersonClick = useCallback(
    (person: Person) => setSelectedId(person.id),
    [],
  );
  const handleOpenDossier = useCallback(
    (person: Person) => setDossierId(person.id),
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

  const selectedPersonDocuments = selectedPerson
    ? personDocuments.filter((d) => d.personId === selectedPerson.id)
    : [];

  const dossierPerson = people.find((p) => p.id === dossierId) ?? null;
  const dossierFacts = dossierPerson
    ? facts.filter((f) => f.person_id === dossierPerson.id)
    : [];
  const dossierAnecdotes = dossierPerson
    ? anecdotes.filter((a) => a.person_id === dossierPerson.id)
    : [];
  const dossierDocuments = dossierPerson
    ? personDocuments.filter((d) => d.personId === dossierPerson.id)
    : [];

  return (
    <>
      <FamilyTree
        people={people}
        unions={unions}
        unionChildren={unionChildren}
        onPersonClick={handlePersonClick}
        onOpenDossier={handleOpenDossier}
        highlightPersonId={highlightPersonId}
      />
      {selectedPerson && (
        <PersonPanel
          person={selectedPerson}
          hasParents={childToUnion.has(selectedPerson.id)}
          marriages={marriages}
          facts={personFacts}
          anecdotes={personAnecdotes}
          documents={selectedPersonDocuments}
          people={people}
          personSummaries={personSummaries}
          onClose={() => setSelectedId(null)}
        />
      )}
      {dossierPerson && (
        <PersonDossier
          person={dossierPerson}
          facts={dossierFacts}
          anecdotes={dossierAnecdotes}
          documents={dossierDocuments}
          onClose={() => setDossierId(null)}
        />
      )}
    </>
  );
}

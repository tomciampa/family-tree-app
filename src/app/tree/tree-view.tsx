"use client";

import { useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FamilyTree } from "@/components/family-tree";
import { PersonPanel } from "./person-panel";
import { PersonDossier } from "./person-dossier";
import { AttachToTreeForm } from "./attach-to-tree-form";
import { deletePerson } from "./actions";
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
  defaultMainPersonId,
}: {
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  facts: Fact[];
  anecdotes: Anecdote[];
  personDocuments: PersonDocument[];
  personSummaries: Record<string, PersonSummary>;
  defaultMainPersonId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dossierId, setDossierId] = useState<string | null>(null);
  const [attachingId, setAttachingId] = useState<string | null>(null);
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
  // Only used by the loose-people list's plain HTML buttons, not threaded
  // into FamilyTree's imperative chart-building effect the way
  // onPersonClick/onOpenDossier are (those go through refs specifically
  // so their identity can change without remounting the chart) — no
  // stability requirement here, useCallback is just tidiness.
  const handleAttachToTree = useCallback(
    (person: Person) => setAttachingId(person.id),
    [],
  );
  const handleDeletePerson = useCallback(
    async (person: Person) => {
      const factCount = facts.filter((f) => f.person_id === person.id).length;
      const anecdoteCount = anecdotes.filter(
        (a) => a.person_id === person.id,
      ).length;
      const docCount = personDocuments.filter(
        (d) => d.personId === person.id,
      ).length;
      const hasData = factCount + anecdoteCount + docCount > 0;
      const message = hasData
        ? `Delete ${person.name}? This also removes ${factCount} fact(s), ${anecdoteCount} stor${anecdoteCount === 1 ? "y" : "ies"}, and unlinks ${docCount} document(s) attached to them. This can't be undone.`
        : `Delete ${person.name}? This can't be undone.`;
      if (!window.confirm(message)) return;
      const result = await deletePerson(person.id);
      if (result?.error) window.alert(result.error);
    },
    [facts, anecdotes, personDocuments],
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

  const attachingPerson = people.find((p) => p.id === attachingId) ?? null;

  return (
    <>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          {/* No key tied to dossier-open state here on purpose — that used
              to force a full remount (to re-fit the chart's SVG to the
              narrower docked width), which also silently discarded main/
              coupleView/expanded-ancestry state every time the dossier
              opened or closed. FamilyTree now re-fits itself via its own
              ResizeObserver instead, so the component instance — and
              everything it's currently centered/expanded on — survives
              the dossier docking/undocking. */}
          <FamilyTree
            people={people}
            unions={unions}
            unionChildren={unionChildren}
            onPersonClick={handlePersonClick}
            onOpenDossier={handleOpenDossier}
            onAttachToTree={handleAttachToTree}
            onDeletePerson={handleDeletePerson}
            highlightPersonId={highlightPersonId}
            defaultMainPersonId={defaultMainPersonId}
          />
        </div>
        {dossierPerson && (
          <PersonDossier
            person={dossierPerson}
            facts={dossierFacts}
            anecdotes={dossierAnecdotes}
            documents={dossierDocuments}
            onClose={() => setDossierId(null)}
          />
        )}
      </div>
      {selectedPerson && (
        <PersonPanel
          person={selectedPerson}
          hasParents={childToUnion.has(selectedPerson.id)}
          marriages={marriages}
          facts={personFacts}
          allFacts={facts}
          anecdotes={personAnecdotes}
          documents={selectedPersonDocuments}
          people={people}
          unions={unions}
          unionChildren={unionChildren}
          personSummaries={personSummaries}
          onClose={() => setSelectedId(null)}
        />
      )}
      {attachingPerson && (
        <AttachToTreeForm
          loosePerson={attachingPerson}
          people={people}
          unions={unions}
          personSummaries={personSummaries}
          onClose={() => setAttachingId(null)}
        />
      )}
    </>
  );
}

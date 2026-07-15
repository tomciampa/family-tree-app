"use client";

import { useState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import { FactList } from "./fact-list";
import { AnecdoteList } from "./anecdote-list";
import { DocumentList, type PersonDocument } from "./document-list";
import { PersonIdentitySection } from "./person-identity";

type Person = Tables<"people">;
type Fact = Tables<"facts">;
type Anecdote = Tables<"anecdotes">;

type Tab = "facts" | "stories" | "documents";

// Fact "field" is a free-text string the contributor typed (see the "e.g.
// Birth, Occupation, Immigration" hint on the add-fact form), not an enum —
// so pulling out "core" facts for the at-a-glance header means matching by
// name rather than a fixed schema. A person can easily have zero of these
// (e.g. one merged "Death" fact that mentions a birth date only in its
// prose, like Vincenzo Ciampa's death-certificate fact) — the header just
// shows whatever core fields actually exist rather than forcing empty rows.
function findFactByField(facts: Fact[], field: string) {
  return facts.find((f) => f.field.trim().toLowerCase() === field);
}

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

  const birthFact = findFactByField(facts, "birth");
  const deathFact = findFactByField(facts, "death");
  const occupationFact = findFactByField(facts, "occupation");

  const summaryItems: { label: string; value: string }[] = [];
  if (birthFact) {
    summaryItems.push({ label: "Birth", value: birthFact.value });
  } else if (person.birth_estimate) {
    summaryItems.push({ label: "Born", value: person.birth_estimate });
  }
  if (deathFact) {
    summaryItems.push({ label: "Death", value: deathFact.value });
  } else if (person.death_estimate) {
    summaryItems.push({ label: "Died", value: person.death_estimate });
  }
  if (occupationFact) {
    summaryItems.push({ label: "Occupation", value: occupationFact.value });
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "facts", label: "Facts" },
    { key: "stories", label: "Stories" },
    { key: "documents", label: "Documents" },
  ];

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
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border border-[#c9b896] px-2 py-1 text-sm text-[#6b5c45] hover:bg-[#efe6d2]"
        >
          Close ✕
        </button>
      </div>

      <div className="border-b border-[#c9b896] px-6 py-4">
        {summaryItems.length > 0 ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            {summaryItems.map((item) => (
              <div key={item.label}>
                <dt className="text-xs uppercase tracking-wide text-[#6b5c45]">
                  {item.label}
                </dt>
                <dd className="text-sm">{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm italic text-[#6b5c45]">
            No summary facts recorded yet.
          </p>
        )}
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

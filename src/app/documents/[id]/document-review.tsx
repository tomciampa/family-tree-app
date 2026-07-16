"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { splitWithHighlight } from "@/lib/documents";
import { FamilyTree } from "@/components/family-tree";
import { PersonSearch } from "@/components/person-search";
import {
  extractCandidatesFromDocument,
  matchCandidatesForDocument,
  confirmCandidateMatch,
  createPersonForCandidate,
  skipCandidateResolution,
} from "../actions";
import type { CandidatePerson } from "../documents-view";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;

type ReviewDocument = {
  id: string;
  filename: string | null;
  file_path: string;
  document_type: string | null;
  status: string;
  recorded_at: string | null;
  candidate_people: CandidatePerson[] | null;
  transcription_raw: string | null;
  viewUrl: string | null;
};

const statusStyles: Record<string, string> = {
  pending_match:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  matched: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  no_match: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const matchStatusStyles: Record<string, string> = {
  high_confidence:
    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  multiple_matches:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  no_match: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const matchStatusLabels: Record<string, string> = {
  high_confidence: "matched",
  multiple_matches: "possible matches",
  no_match: "no match found",
};

function namesConflict(a: string, b: string) {
  return a.trim().toLowerCase() !== b.trim().toLowerCase();
}

export function DocumentReview({
  doc,
  people,
  unions,
  unionChildren,
  personSummaries,
}: {
  doc: ReviewDocument;
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  personSummaries: Record<string, PersonSummary>;
}) {
  const [isExtracting, setIsExtracting] = useState(false);
  const [isMatching, setIsMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidatePerson[] | null>(
    doc.candidate_people,
  );
  // Driven by hovering/focusing a match in the resolution pane — read by
  // both the embedded tree (recenter + pulse) and the transcription
  // viewer (text highlight), so one hover updates both at once.
  const [highlightPersonId, setHighlightPersonId] = useState<string | null>(
    null,
  );
  const [highlightName, setHighlightName] = useState<string | null>(null);

  const transcriptionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!highlightName) return;
    transcriptionRef.current
      ?.querySelector("mark")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlightName]);

  async function handleExtract() {
    setIsExtracting(true);
    setError(null);
    const result = await extractCandidatesFromDocument(doc.id);
    setIsExtracting(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setCandidates(result.candidates);
  }

  async function handleMatch() {
    setIsMatching(true);
    setError(null);
    const result = await matchCandidatesForDocument(doc.id);
    setIsMatching(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setCandidates(result.candidates);
  }

  function handleFocusMatch(personId: string, name: string) {
    setHighlightPersonId(personId);
    setHighlightName(name);
  }

  const familyEntries = (candidates ?? [])
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.roleCategory === "family");
  const adminEntries = (candidates ?? [])
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.roleCategory === "administrative");
  const hasFamilyCandidates = familyEntries.length > 0;

  const transcriptionParts = useMemo(
    () => splitWithHighlight(doc.transcription_raw ?? "", highlightName),
    [doc.transcription_raw, highlightName],
  );

  const isImage = doc.document_type?.startsWith("image/") ?? false;
  const isPdf = doc.document_type === "application/pdf";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-gray-200 px-4 py-3 dark:border-gray-800">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium">
            {doc.filename ?? doc.file_path}
          </h1>
          <p className="text-xs text-gray-500">
            {doc.recorded_at
              ? new Date(doc.recorded_at).toLocaleDateString()
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              statusStyles[doc.status] ?? statusStyles.pending_match
            }`}
          >
            {doc.status.replace("_", " ")}
          </span>
          <button
            type="button"
            onClick={handleExtract}
            disabled={isExtracting}
            className="rounded border border-gray-300 px-2 py-1 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
          >
            {isExtracting ? "Extracting…" : candidates ? "Re-extract" : "Extract"}
          </button>
          {hasFamilyCandidates && (
            <button
              type="button"
              onClick={handleMatch}
              disabled={isMatching}
              className="rounded border border-gray-300 px-2 py-1 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
            >
              {isMatching ? "Matching…" : "Match"}
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-3 rounded border border-gray-200 p-4 dark:border-gray-800 lg:max-h-[78vh] lg:overflow-y-auto">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Document
          </h2>
          {doc.viewUrl && isImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={doc.viewUrl}
              alt={doc.filename ?? "Document"}
              className="w-full rounded border border-gray-200 dark:border-gray-800"
            />
          )}
          {doc.viewUrl && isPdf && (
            <embed
              src={doc.viewUrl}
              type="application/pdf"
              className="h-[50vh] w-full rounded border border-gray-200 dark:border-gray-800"
            />
          )}
          {doc.viewUrl && !isImage && !isPdf && (
            <a
              href={doc.viewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline"
            >
              Open original file ↗
            </a>
          )}
          {doc.transcription_raw && (
            <div ref={transcriptionRef} className="flex flex-col gap-1">
              <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Transcription
              </h3>
              <pre className="whitespace-pre-wrap font-sans text-xs text-gray-700 dark:text-gray-300">
                {transcriptionParts.map((part, i) =>
                  part.match ? (
                    <mark
                      key={i}
                      className="rounded bg-amber-200 px-0.5 dark:bg-amber-700/60"
                    >
                      {part.text}
                    </mark>
                  ) : (
                    <span key={i}>{part.text}</span>
                  ),
                )}
              </pre>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4 rounded border border-gray-200 p-4 dark:border-gray-800 lg:max-h-[78vh] lg:overflow-y-auto">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Candidates
          </h2>
          {(!candidates || candidates.length === 0) && (
            <p className="text-sm text-gray-500">
              No candidates extracted yet — click Extract above.
            </p>
          )}
          {familyEntries.length > 0 && (
            <ul className="flex flex-col gap-4">
              {familyEntries.map(({ c, index }) => (
                <FamilyCandidateRow
                  key={index}
                  documentId={doc.id}
                  index={index}
                  candidate={c}
                  people={people}
                  personSummaries={personSummaries}
                  onUpdate={setCandidates}
                  onFocusMatch={handleFocusMatch}
                />
              ))}
            </ul>
          )}
          {adminEntries.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-600">
                Administrative (not matched as family)
              </p>
              <ul className="flex flex-col gap-1">
                {adminEntries.map(({ c, index }) => (
                  <li
                    key={index}
                    className="text-xs text-gray-400 dark:text-gray-600"
                  >
                    <span className="font-medium text-gray-500 dark:text-gray-500">
                      {c.name}
                    </span>
                    {c.relation && ` — ${c.relation}`}
                    {c.dates && ` (${c.dates})`}
                    {c.note && ` · ${c.note}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="rounded border border-gray-200 p-2 dark:border-gray-800">
          <h2 className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-gray-500">
            Tree — hover a candidate to preview
          </h2>
          <FamilyTree
            people={people}
            unions={unions}
            unionChildren={unionChildren}
            highlightPersonId={highlightPersonId}
            heightClassName="h-[70vh]"
          />
        </div>
      </div>
    </div>
  );
}

function FamilyCandidateRow({
  documentId,
  index,
  candidate,
  people,
  personSummaries,
  onUpdate,
  onFocusMatch,
}: {
  documentId: string;
  index: number;
  candidate: CandidatePerson;
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  onUpdate: (updated: CandidatePerson[]) => void;
  onFocusMatch: (personId: string, name: string) => void;
}) {
  const [selection, setSelection] = useState<string>(() =>
    candidate.matchStatus === "high_confidence" && candidate.matches?.[0]
      ? candidate.matches[0].personId
      : candidate.matches?.length
        ? ""
        : "__new__",
  );
  const [newName, setNewName] = useState(candidate.name);
  const [showAll, setShowAll] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Explicit, independent of `selection`'s value — a manually-searched
  // person can legitimately coincide with one of the matcher's own (often
  // low-ranked, not-visible-by-default) suggestions, e.g. "Bob Ciampa"
  // vs. "Robert Ciampa" scored low enough to be buried past the visible-6
  // cutoff but still present in the full matches array. Deriving "is this
  // a manual search pick" from "selection isn't in matches" broke exactly
  // then: picking such a person from search made that check false, which
  // hid the search panel and its "Selected: X" confirmation — selection
  // was still correct and Confirm still worked, but nothing on screen
  // showed it, reading as if the click had done nothing.
  const [isSearchMode, setIsSearchMode] = useState(false);

  const matches = candidate.matches ?? [];
  const visibleMatches = showAll ? matches : matches.slice(0, 6);

  async function handleConfirm() {
    setIsSaving(true);
    setError(null);
    const result =
      selection === "__new__"
        ? await createPersonForCandidate(documentId, index, newName)
        : await confirmCandidateMatch(documentId, index, selection);
    setIsSaving(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onUpdate(result.candidates);
  }

  async function handleSkip() {
    setIsSaving(true);
    setError(null);
    const result = await skipCandidateResolution(documentId, index);
    setIsSaving(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onUpdate(result.candidates);
  }

  const resolvedPerson = candidate.resolution?.personId
    ? (matches.find((m) => m.personId === candidate.resolution?.personId)
        ?.personName ??
      // A manually search-matched person (see "search for the correct
      // person" below) never appears in `matches` — look them up in the
      // full people list instead of falling through to `newName`, which
      // would otherwise still show the candidate's original extracted
      // name rather than who was actually confirmed.
      people.find((p) => p.id === candidate.resolution?.personId)?.name ??
      newName)
    : null;

  return (
    <li className="text-xs text-gray-600 dark:text-gray-400">
      <span className="font-medium text-gray-800 dark:text-gray-200">
        {candidate.name}
      </span>
      {candidate.relation && ` — ${candidate.relation}`}
      {candidate.dates && ` (${candidate.dates})`}
      {candidate.note && ` · ${candidate.note}`}

      {candidate.matchStatus && (
        <div className="mt-1 ml-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${matchStatusStyles[candidate.matchStatus]}`}
          >
            {matchStatusLabels[candidate.matchStatus]}
          </span>

          {candidate.resolution ? (
            <p className="mt-1 text-[11px] text-gray-500">
              {candidate.resolution.action === "confirmed" &&
                `Confirmed → linked to ${resolvedPerson}`}
              {candidate.resolution.action === "created" &&
                `Created new person: ${resolvedPerson}`}
              {candidate.resolution.action === "skipped" && "Skipped"}
            </p>
          ) : (
            <div className="mt-2 flex flex-col gap-1.5 rounded border border-gray-200 p-2 dark:border-gray-800">
              {visibleMatches.map((m) => {
                const summary = personSummaries[m.personId];
                const dates = [summary?.birthEstimate, summary?.deathEstimate]
                  .filter(Boolean)
                  .join(" – ");
                return (
                  <label
                    key={m.personId}
                    onMouseEnter={() => onFocusMatch(m.personId, candidate.name)}
                    className="flex items-start gap-1.5 rounded px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-800/60"
                  >
                    <input
                      type="radio"
                      name={`candidate-${documentId}-${index}`}
                      checked={!isSearchMode && selection === m.personId}
                      onChange={() => {
                        setIsSearchMode(false);
                        setSelection(m.personId);
                      }}
                      onFocus={() => onFocusMatch(m.personId, candidate.name)}
                      className="mt-0.5"
                    />
                    <span>
                      {m.personName} — {(m.score * 100).toFixed(0)}%
                      {m.relationSignal && " · existing relationship"}
                      {m.dateSignal === "overlap" && " · dates match"}
                      {m.dateSignal === "conflict" && " · dates conflict"}
                      {/* This is exactly what tells apart e.g. three
                          different "Anthony Ciampa" records — bare name +
                          score alone can't. */}
                      <span className="block text-gray-500 dark:text-gray-500">
                        {dates && `${dates} · `}
                        {summary?.relationshipSummary ?? "not yet in the tree"}
                        {" · "}
                        <span className="italic">hover to preview in tree →</span>
                      </span>
                      {namesConflict(candidate.name, m.personName) && (
                        <span className="block text-amber-600 dark:text-amber-400">
                          Extracted as &quot;{candidate.name}&quot; — existing
                          record is &quot;{m.personName}&quot;. Confirming
                          won&apos;t change the stored name.
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
              {matches.length > 6 && !showAll && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="self-start text-[11px] text-gray-500 underline"
                >
                  Show all {matches.length}
                </button>
              )}

              <label className="flex items-start gap-1.5">
                <input
                  type="radio"
                  name={`candidate-${documentId}-${index}`}
                  checked={!isSearchMode && selection === "__new__"}
                  onChange={() => {
                    setIsSearchMode(false);
                    setSelection("__new__");
                  }}
                  className="mt-0.5"
                />
                <span className="flex flex-col gap-1">
                  None of these — create a new person
                  {selection === "__new__" && (
                    <input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      className="rounded border border-gray-300 px-2 py-1 text-xs text-black dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                    />
                  )}
                </span>
              </label>

              {/* For cases the matcher can never solve on its own — e.g.
                  a document says "Grandpa Bob" with no name or
                  relationship signal pointing at his real record. Confirm
                  goes through the exact same confirmCandidateMatch call as
                  a suggested match, just with a manually-chosen personId
                  instead of one the matcher proposed.

                  The search input/results live OUTSIDE this label
                  (siblings, not children) deliberately: a <label> forwards
                  clicks to its associated control, and a nested <button>
                  inside one is exactly the kind of setup where that
                  forwarding can end up firing the radio's own onChange
                  right after a result's onClick already set a real
                  selection — silently resetting it back to the
                  "__search__" placeholder with no visible sign why. */}
              <label className="flex items-start gap-1.5">
                <input
                  type="radio"
                  name={`candidate-${documentId}-${index}`}
                  checked={isSearchMode}
                  onChange={() => {
                    setIsSearchMode(true);
                    setSelection("__search__");
                  }}
                  className="mt-0.5"
                />
                <span>None of these — search for the correct person</span>
              </label>
              {isSearchMode && (
                <div className="ml-5">
                  <PersonSearch
                    people={people}
                    personSummaries={personSummaries}
                    selectedId={selection === "__search__" ? null : selection}
                    onSelect={(id) => setSelection(id)}
                    onHoverPerson={(id) => onFocusMatch(id, candidate.name)}
                  />
                </div>
              )}

              {error && <p className="text-[11px] text-red-500">{error}</p>}

              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={isSaving || !selection || selection === "__search__"}
                  className="rounded border border-gray-300 px-2 py-1 text-[11px] hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
                >
                  {isSaving ? "Saving…" : "Confirm"}
                </button>
                <button
                  type="button"
                  onClick={handleSkip}
                  disabled={isSaving}
                  className="rounded px-2 py-1 text-[11px] text-gray-500 hover:text-gray-700 disabled:opacity-50 dark:hover:text-gray-300"
                >
                  Skip
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

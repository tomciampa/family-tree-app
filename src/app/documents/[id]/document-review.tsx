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
    "bg-[color:var(--color-warning-subtle-bg)] text-[color:var(--color-warning-subtle-fg)]",
  matched: "bg-[color:var(--color-success-subtle-bg)] text-[color:var(--color-success-subtle-fg)]",
  no_match: "bg-[color:var(--color-bg-surface-alt)] text-[color:var(--color-text-secondary)]",
};

const matchStatusStyles: Record<string, string> = {
  high_confidence:
    "bg-[color:var(--color-success-subtle-bg)] text-[color:var(--color-success-subtle-fg)]",
  multiple_matches:
    "bg-[color:var(--color-warning-subtle-bg)] text-[color:var(--color-warning-subtle-fg)]",
  no_match: "bg-[color:var(--color-bg-surface-alt)] text-[color:var(--color-text-secondary)]",
  // Distinct from no_match: "Match" simply hasn't been run yet for this
  // candidate, not that it ran and found nothing. Same neutral styling as
  // no_match — both mean "nothing automatic to show" — but a different
  // label so it doesn't read as a completed, empty-handed search.
  not_matched: "bg-[color:var(--color-bg-surface-alt)] text-[color:var(--color-text-secondary)]",
};

const matchStatusLabels: Record<string, string> = {
  high_confidence: "matched",
  multiple_matches: "possible matches",
  no_match: "no match found",
  not_matched: "not yet matched",
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
  // Which candidate row the user is currently working with — set on
  // hovering anywhere in that row (see FamilyCandidateRow's onMouseEnter
  // below), never auto-cleared, so it stays put while the mouse moves
  // over to the tree pane to click around. Lets "confirm from the tree"
  // below know which candidate to resolve, independent of whether that
  // row has any algorithmic matches to hover in the first place — the
  // no-match candidates this feature helps most (e.g. a document that
  // never gives a real name for someone) have nothing else to hover.
  const [activeCandidateIndex, setActiveCandidateIndex] = useState<
    number | null
  >(null);
  // Whoever the embedded tree pane is currently centered on, regardless
  // of how it got there (hover-driven recenter via highlightPersonId
  // below, or the user clicking/searching around inside the tree pane
  // itself) — see FamilyTree's onMainPersonChange for why this needs to
  // be separate from highlightPersonId, which only reflects the resolution
  // pane's own hover state, not anything that happens inside the tree.
  const [centeredPerson, setCenteredPerson] = useState<Person | null>(null);
  const [isConfirmingFromTree, setIsConfirmingFromTree] = useState(false);
  const [confirmFromTreeError, setConfirmFromTreeError] = useState<
    string | null
  >(null);

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

  // Confirms whoever the tree pane is currently centered on as the match
  // for the active candidate — an alternative path to the exact same
  // confirmCandidateMatch call the resolution pane's own radio-button
  // "Confirm" button makes (see FamilyCandidateRow's handleConfirm), not a
  // new write path.
  async function handleConfirmFromTree() {
    if (activeCandidateIndex === null || !centeredPerson) return;
    setIsConfirmingFromTree(true);
    setConfirmFromTreeError(null);
    const result = await confirmCandidateMatch(
      doc.id,
      activeCandidateIndex,
      centeredPerson.id,
    );
    setIsConfirmingFromTree(false);
    if ("error" in result) {
      setConfirmFromTreeError(result.error);
      return;
    }
    setCandidates(result.candidates);
  }

  const familyEntries = (candidates ?? [])
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.roleCategory === "family");
  const adminEntries = (candidates ?? [])
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.roleCategory === "administrative");
  const hasFamilyCandidates = familyEntries.length > 0;
  const activeCandidate =
    activeCandidateIndex !== null ? candidates?.[activeCandidateIndex] : null;

  const transcriptionParts = useMemo(
    () => splitWithHighlight(doc.transcription_raw ?? "", highlightName),
    [doc.transcription_raw, highlightName],
  );

  const isImage = doc.document_type?.startsWith("image/") ?? false;
  const isPdf = doc.document_type === "application/pdf";

  return (
    <div className="flex flex-col gap-4 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] px-4 py-3 shadow-[var(--shadow-1)]">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium">
            {doc.filename ?? doc.file_path}
          </h1>
          <p className="text-xs text-[color:var(--color-text-secondary)]">
            {doc.recorded_at
              ? new Date(doc.recorded_at).toLocaleDateString()
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-[var(--radius-xs)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              statusStyles[doc.status] ?? statusStyles.pending_match
            }`}
          >
            {doc.status.replace("_", " ")}
          </span>
          <button
            type="button"
            onClick={handleExtract}
            disabled={isExtracting}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
          >
            {isExtracting ? "Extracting…" : candidates ? "Re-extract" : "Extract"}
          </button>
          {hasFamilyCandidates && (
            <button
              type="button"
              onClick={handleMatch}
              disabled={isMatching}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
            >
              {isMatching ? "Matching…" : "Match"}
            </button>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-4 shadow-[var(--shadow-1)] lg:max-h-[78vh] lg:overflow-y-auto">
          <h2 className="text-[length:var(--font-size-caption)] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            Document
          </h2>
          {doc.viewUrl && isImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={doc.viewUrl}
              alt={doc.filename ?? "Document"}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)]"
            />
          )}
          {doc.viewUrl && isPdf && (
            <embed
              src={doc.viewUrl}
              type="application/pdf"
              className="h-[50vh] w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)]"
            />
          )}
          {doc.viewUrl && !isImage && !isPdf && (
            <a
              href={doc.viewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[color:var(--color-accent)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-accent-hover)]"
            >
              Open original file ↗
            </a>
          )}
          {doc.transcription_raw && (
            <div ref={transcriptionRef} className="flex flex-col gap-1">
              <h3 className="text-[length:var(--font-size-caption)] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                Transcription
              </h3>
              <pre className="whitespace-pre-wrap font-sans text-xs text-[color:var(--color-text-secondary)]">
                {transcriptionParts.map((part, i) =>
                  part.match ? (
                    <mark
                      key={i}
                      className="rounded-[var(--radius-xs)] bg-[color:var(--color-accent-subtle)] px-0.5 text-[color:var(--color-text-primary)]"
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

        <div className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-4 shadow-[var(--shadow-1)] lg:max-h-[78vh] lg:overflow-y-auto">
          <h2 className="text-[length:var(--font-size-caption)] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            Candidates
          </h2>
          {(!candidates || candidates.length === 0) && (
            <p className="text-sm text-[color:var(--color-text-secondary)]">
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
                  onActivate={setActiveCandidateIndex}
                />
              ))}
            </ul>
          )}
          {adminEntries.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-tertiary)]">
                Administrative (not matched as family)
              </p>
              <ul className="flex flex-col gap-1">
                {adminEntries.map(({ c, index }) => (
                  <li
                    key={index}
                    className="text-xs text-[color:var(--color-text-tertiary)]"
                  >
                    <span className="font-medium text-[color:var(--color-text-secondary)]">
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

        <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-2 shadow-[var(--shadow-1)]">
          <h2 className="px-2 py-1 text-[length:var(--font-size-caption)] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            Tree — hover a candidate to preview
          </h2>
          {activeCandidate && !activeCandidate.resolution && centeredPerson && (
            <div className="flex flex-col gap-1 px-2 pb-2">
              <button
                type="button"
                onClick={handleConfirmFromTree}
                disabled={isConfirmingFromTree}
                className="self-start rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-[11px] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
              >
                {isConfirmingFromTree
                  ? "Saving…"
                  : `Use ${centeredPerson.name} as match for "${activeCandidate.name}"`}
              </button>
              {confirmFromTreeError && (
                <p className="text-[11px] text-[color:var(--color-error)]">
                  {confirmFromTreeError}
                </p>
              )}
            </div>
          )}
          <FamilyTree
            people={people}
            unions={unions}
            unionChildren={unionChildren}
            highlightPersonId={highlightPersonId}
            onMainPersonChange={setCenteredPerson}
            ancestryDepth={1}
            progenyDepth={1}
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
  onActivate,
}: {
  documentId: string;
  index: number;
  candidate: CandidatePerson;
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  onUpdate: (updated: CandidatePerson[]) => void;
  onFocusMatch: (personId: string, name: string) => void;
  // Marks this row as the one "confirm from the tree pane" acts on — see
  // that button next to the tree pane. Fired on hovering anywhere in the
  // row (not just a specific match, unlike onFocusMatch above), since a
  // no-match candidate has no match to hover in the first place and this
  // still needs to work for exactly that case.
  onActivate: (index: number) => void;
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
    <li
      onMouseEnter={() => onActivate(index)}
      className="text-xs text-[color:var(--color-text-secondary)]"
    >
      <span className="font-medium text-[color:var(--color-text-primary)]">
        {candidate.name}
      </span>
      {candidate.relation && ` — ${candidate.relation}`}
      {candidate.dates && ` (${candidate.dates})`}
      {candidate.note && ` · ${candidate.note}`}

      {(() => {
        // "Match" hasn't necessarily run yet for this candidate — a
        // document that's only been extracted has matchStatus undefined
        // on every candidate, which used to hide this entire block
        // (badge, resolution text, and the manual confirm/search/skip
        // controls) even though confirming still works correctly
        // underneath (confirmCandidateMatch never required matchStatus to
        // be set). Falling back to "not_matched" here keeps the block —
        // and its controls — visible and usable in that state instead of
        // rendering nothing.
        const statusKey = candidate.matchStatus ?? "not_matched";
        return (
          <div className="mt-1 ml-2">
            <span
              className={`rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${matchStatusStyles[statusKey]}`}
            >
              {matchStatusLabels[statusKey]}
            </span>

            {candidate.resolution ? (
              <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
                {candidate.resolution.action === "confirmed" &&
                  `Confirmed → linked to ${resolvedPerson}`}
                {candidate.resolution.action === "created" &&
                  `Created new person: ${resolvedPerson}`}
                {candidate.resolution.action === "skipped" && "Skipped"}
              </p>
            ) : (
              <div className="mt-2 flex flex-col gap-1.5 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-2">
                {!candidate.matchStatus && (
                  <p className="text-[11px] italic text-[color:var(--color-text-secondary)]">
                    Not yet matched — click Match above, or confirm manually
                    below.
                  </p>
                )}
                {visibleMatches.map((m) => {
                  const summary = personSummaries[m.personId];
                  const dates = [summary?.birthEstimate, summary?.deathEstimate]
                    .filter(Boolean)
                    .join(" – ");
                  return (
                    <label
                      key={m.personId}
                      onMouseEnter={() => onFocusMatch(m.personId, candidate.name)}
                      className="flex items-start gap-1.5 rounded-[var(--radius-xs)] px-1 py-0.5 transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
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
                        <span className="block text-[color:var(--color-text-secondary)]">
                          {dates && `${dates} · `}
                          {summary?.relationshipSummary ?? "not yet in the tree"}
                          {" · "}
                          <span className="italic">hover to preview in tree →</span>
                        </span>
                        {namesConflict(candidate.name, m.personName) && (
                          <span className="block text-[color:var(--color-warning-subtle-fg)]">
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
                    className="self-start text-[11px] text-[color:var(--color-text-secondary)] underline"
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
                        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-2 py-1 text-xs text-[color:var(--color-text-primary)]"
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

                {error && <p className="text-[11px] text-[color:var(--color-error)]">{error}</p>}

                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={handleConfirm}
                    disabled={isSaving || !selection || selection === "__search__"}
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-[11px] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
                  >
                    {isSaving ? "Saving…" : "Confirm"}
                  </button>
                  <button
                    type="button"
                    onClick={handleSkip}
                    disabled={isSaving}
                    className="rounded-[var(--radius-sm)] px-2 py-1 text-[11px] text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)] disabled:opacity-50"
                  >
                    Skip
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </li>
  );
}

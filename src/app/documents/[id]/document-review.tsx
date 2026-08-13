"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { splitWithHighlight } from "@/lib/documents";
import { FamilyTree } from "@/components/family-tree";
import { PersonSearch } from "@/components/person-search";
import { FactAnecdoteLine } from "@/components/fact-anecdote-line";
import {
  extractCandidatesFromDocument,
  matchCandidatesForDocument,
  confirmCandidateMatch,
  createPersonForCandidate,
  skipCandidateResolution,
  saveNewFactsForResolvedCandidate,
  resolveAmbiguousAttribution,
  type CandidateForReview,
} from "../actions";
import type {
  DocumentExtraction,
  DocumentCandidateFact,
  DocumentCandidateAnecdote,
} from "../document-extraction-schema";
import { aboutLabel } from "@/app/interviews/extraction-schema";
import { DeleteDocumentButton } from "../delete-document-button";

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
  candidate_people: DocumentExtraction<CandidateForReview> | null;
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
  duplicateOf,
  people,
  unions,
  unionChildren,
  personSummaries,
}: {
  doc: ReviewDocument;
  // Set only when this document was flagged as a possible exact duplicate
  // (see content_hash_dedup migration) — the earlier row it matched.
  duplicateOf: { id: string; filename: string | null; recordedAt: string | null } | null;
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  personSummaries: Record<string, PersonSummary>;
}) {
  const [isExtracting, setIsExtracting] = useState(false);
  const [isMatching, setIsMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<DocumentExtraction<CandidateForReview> | null>(
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
    setExtraction(result.extraction);
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
    setExtraction(result.extraction);
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
    setExtraction(result.extraction);
  }

  const candidates = extraction?.people ?? [];
  const familyEntries = candidates
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.roleCategory === "family");
  const adminEntries = candidates
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.roleCategory === "administrative");
  const hasFamilyCandidates = familyEntries.length > 0;
  const activeCandidate =
    activeCandidateIndex !== null ? candidates[activeCandidateIndex] : null;

  // Facts/anecdotes are nested under their own candidate's card (see
  // FamilyCandidateRow below), not shown as one global cross-referenced
  // list the way email-note-review.tsx does — documents resolve identity
  // one candidate at a time, immediately, so "this fact is about the
  // candidate whose card it's nested in" needs no separate label.
  function factsFor(index: number): DocumentCandidateFact[] {
    return (extraction?.facts ?? []).filter(
      (f) => f.aboutRef.type === "person" && f.aboutRef.index === index,
    );
  }
  function anecdotesFor(index: number): DocumentCandidateAnecdote[] {
    return (extraction?.anecdotes ?? []).filter(
      (a) => a.aboutRef.type === "person" && a.aboutRef.index === index,
    );
  }
  // Facts/anecdotes whose `about` never resolved to anyone in `people` —
  // never written (nowhere to attach them), but still surfaced rather
  // than silently dropped, same as email-note-review.tsx's own
  // "(unresolved)" labeling.
  const unattributedFacts = (extraction?.facts ?? []).filter((f) => f.aboutRef.type === "unresolved");
  const unattributedAnecdotes = (extraction?.anecdotes ?? []).filter(
    (a) => a.aboutRef.type === "unresolved",
  );
  // Facts/anecdotes whose `about` matched more than one same-named
  // candidate on this document (see attachFactsOnlyAboutRefs) — kept as
  // their own original index (not the filtered array's) so
  // resolveAmbiguousAttribution can address the right entry. Never
  // guessed automatically; a human picks one below.
  const ambiguousFacts = (extraction?.facts ?? [])
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.aboutRef.type === "ambiguous");
  const ambiguousAnecdotes = (extraction?.anecdotes ?? [])
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.aboutRef.type === "ambiguous");

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
          <DeleteDocumentButton
            documentId={doc.id}
            filename={doc.filename}
            redirectTo="/documents"
          />
        </div>
      </div>

      {duplicateOf && (
        <p className="rounded-[var(--radius-sm)] border border-[color:var(--color-warning)] bg-[color:var(--color-warning-subtle-bg)] px-3 py-2 text-sm text-[color:var(--color-warning-subtle-fg)]">
          This looks identical to{" "}
          <a href={`/documents/${duplicateOf.id}`} className="underline">
            &quot;{duplicateOf.filename ?? "a document"}&quot; uploaded
            {duplicateOf.recordedAt
              ? ` on ${new Date(duplicateOf.recordedAt).toLocaleDateString()}`
              : " previously"}
          </a>{" "}
          — review, and use Delete above if this is a duplicate.
        </p>
      )}

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
          {candidates.length === 0 && (
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
                  facts={factsFor(index)}
                  anecdotes={anecdotesFor(index)}
                  people={people}
                  personSummaries={personSummaries}
                  onUpdate={setExtraction}
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
                {adminEntries.map(({ c, index }) => {
                  // Administrative-role candidates never get a resolution
                  // (no personId to link facts to — see writeAttributedFactsAndAnecdotes's
                  // targetsThisCandidate), so any fact/anecdote attributed
                  // here can never be written and has no Save button, unlike
                  // FamilyCandidateRow. Shown read-only purely so it isn't
                  // silently invisible — a real gap found reprocessing the
                  // Vincenzo Ciampa death certificate, whose registrar
                  // (an administrative role) had two real extracted facts
                  // that were correctly never-writable but weren't shown
                  // anywhere at all.
                  const adminFacts = factsFor(index);
                  const adminAnecdotes = anecdotesFor(index);
                  return (
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
                      {(adminFacts.length > 0 || adminAnecdotes.length > 0) && (
                        <div className="mt-1 ml-2 flex flex-col gap-0.5">
                          {adminFacts.map((f, i) => (
                            // included=true suppresses FactAnecdoteLine's own
                            // "will be skipped for now" suffix (that phrasing
                            // implies a pending decision — this has no
                            // decision to make, it's structurally unwritable)
                            // in favor of the explicit label below.
                            <FactAnecdoteLine key={`f-${i}`} included={true} already={false} label={f.field}>
                              {f.value}
                              <span className="italic"> · administrative — not saved to anyone&apos;s facts</span>
                            </FactAnecdoteLine>
                          ))}
                          {adminAnecdotes.map((a, i) => (
                            <FactAnecdoteLine key={`a-${i}`} included={true} already={false} label="Story">
                              {a.storyText}
                              <span className="italic"> · administrative — not saved to anyone&apos;s facts</span>
                            </FactAnecdoteLine>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {(unattributedFacts.length > 0 || unattributedAnecdotes.length > 0) && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-tertiary)]">
                Didn&apos;t resolve to a listed person
              </p>
              <div className="flex flex-col gap-0.5">
                {unattributedFacts.map((f, i) => (
                  <FactAnecdoteLine key={`f-${i}`} included={false} already={false} label={aboutLabel(f.aboutRef)}>
                    <span className="font-medium">{f.field}:</span> {f.value}
                  </FactAnecdoteLine>
                ))}
                {unattributedAnecdotes.map((a, i) => (
                  <FactAnecdoteLine key={`a-${i}`} included={false} already={false} label={aboutLabel(a.aboutRef)}>
                    {a.storyText}
                  </FactAnecdoteLine>
                ))}
              </div>
            </div>
          )}
          {(ambiguousFacts.length > 0 || ambiguousAnecdotes.length > 0) && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-warning)]">
                Could belong to more than one person — pick one
              </p>
              <div className="flex flex-col gap-2">
                {ambiguousFacts.map(({ f, i }) =>
                  f.aboutRef.type === "ambiguous" ? (
                    <AmbiguousItemRow
                      key={`amb-f-${i}`}
                      documentId={doc.id}
                      kind="fact"
                      itemIndex={i}
                      label={f.field}
                      text={f.value}
                      candidates={f.aboutRef.candidates}
                      onResolved={setExtraction}
                    />
                  ) : null,
                )}
                {ambiguousAnecdotes.map(({ a, i }) =>
                  a.aboutRef.type === "ambiguous" ? (
                    <AmbiguousItemRow
                      key={`amb-a-${i}`}
                      documentId={doc.id}
                      kind="anecdote"
                      itemIndex={i}
                      label="Story"
                      text={a.storyText}
                      candidates={a.aboutRef.candidates}
                      onResolved={setExtraction}
                    />
                  ) : null,
                )}
              </div>
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

// One ambiguous fact/anecdote (see attachFactsOnlyAboutRefs) plus a button
// per same-named candidate it could belong to — resolving just updates
// which candidate it's attributed to; still needs that candidate's own
// "Save new facts" (in FamilyCandidateRow below) before it's actually
// written.
function AmbiguousItemRow({
  documentId,
  kind,
  itemIndex,
  label,
  text,
  candidates,
  onResolved,
}: {
  documentId: string;
  kind: "fact" | "anecdote";
  itemIndex: number;
  label: string;
  text: string;
  candidates: { index: number; name: string }[];
  onResolved: (updated: DocumentExtraction<CandidateForReview>) => void;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePick(chosenIndex: number) {
    setIsSaving(true);
    setError(null);
    const result = await resolveAmbiguousAttribution(documentId, kind, itemIndex, chosenIndex);
    setIsSaving(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onResolved(result.extraction);
  }

  return (
    <div className="rounded-[var(--radius-sm)] border border-[color:var(--color-warning)] bg-[color:var(--color-warning-subtle-bg)] p-2 text-[11px]">
      <p className="text-[color:var(--color-warning-subtle-fg)]">
        <span className="font-medium">{label}:</span> {text}
      </p>
      <p className="mt-1 text-[color:var(--color-text-secondary)]">Who is this about?</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {candidates.map((c) => (
          <button
            key={c.index}
            type="button"
            disabled={isSaving}
            onClick={() => handlePick(c.index)}
            className="rounded-[var(--radius-xs)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] px-2 py-0.5 transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
          >
            {c.name}
          </button>
        ))}
      </div>
      {error && <p className="mt-1 text-[color:var(--color-error)]">{error}</p>}
    </div>
  );
}

function FamilyCandidateRow({
  documentId,
  index,
  candidate,
  facts,
  anecdotes,
  people,
  personSummaries,
  onUpdate,
  onFocusMatch,
  onActivate,
}: {
  documentId: string;
  index: number;
  candidate: CandidateForReview;
  // Pre-filtered by the parent to just this candidate's own attributed
  // entries (aboutRef.index === index) — see factsFor/anecdotesFor above.
  facts: DocumentCandidateFact[];
  anecdotes: DocumentCandidateAnecdote[];
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  onUpdate: (updated: DocumentExtraction<CandidateForReview>) => void;
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
  const [isSavingFacts, setIsSavingFacts] = useState(false);
  const [saveFactsError, setSaveFactsError] = useState<string | null>(null);
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
    onUpdate(result.extraction);
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
    onUpdate(result.extraction);
  }

  async function handleSaveNewFacts() {
    setIsSavingFacts(true);
    setSaveFactsError(null);
    const result = await saveNewFactsForResolvedCandidate(documentId, index);
    setIsSavingFacts(false);
    if ("error" in result) {
      setSaveFactsError(result.error);
      return;
    }
    onUpdate(result.extraction);
  }

  // See document-review.tsx module's own comment on the equivalent
  // mapping choice: "will be skipped for now" (included=false) is only
  // shown once this candidate was actually, explicitly skipped — while
  // still-unresolved is shown neutrally (included=true, no claim either
  // way), since "skipped" would be a false claim before the user has made
  // any decision at all.
  const factsIncluded = candidate.resolution?.action !== "skipped";

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

      {(facts.length > 0 || anecdotes.length > 0) && (
        <div className="mt-1 ml-2 flex flex-col gap-0.5">
          {facts.map((f, i) => (
            <FactAnecdoteLine key={`f-${i}`} included={factsIncluded} already={!!f.written} label={f.field}>
              {f.value}
              {f.confidence && (
                <span className="text-[color:var(--color-text-secondary)]"> ({f.confidence})</span>
              )}
            </FactAnecdoteLine>
          ))}
          {anecdotes.map((a, i) => (
            <FactAnecdoteLine key={`a-${i}`} included={factsIncluded} already={!!a.written} label="Story">
              {a.storyText}
            </FactAnecdoteLine>
          ))}
        </div>
      )}

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
              <div className="mt-1">
                <p className="text-[11px] text-[color:var(--color-text-secondary)]">
                  {candidate.resolution.action === "confirmed" &&
                    `Confirmed → linked to ${resolvedPerson}`}
                  {candidate.resolution.action === "created" &&
                    `Created new person: ${resolvedPerson}`}
                  {candidate.resolution.action === "skipped" && "Skipped"}
                </p>
                {/* Only reachable once identity is already resolved — this
                    candidate's own Confirm button (above, hidden once
                    resolved) already wrote facts alongside its identity
                    confirm. This covers facts/anecdotes added afterward,
                    e.g. by reextractFactsForResolvedDocument. Never shown
                    for a skipped candidate — nothing should be attributed
                    to someone explicitly skipped. */}
                {(() => {
                  if (candidate.resolution.action === "skipped") return null;
                  const unwrittenCount =
                    facts.filter((f) => !f.written).length +
                    anecdotes.filter((a) => !a.written).length;
                  if (unwrittenCount === 0) return null;
                  return (
                    <div className="mt-1">
                      <button
                        type="button"
                        onClick={handleSaveNewFacts}
                        disabled={isSavingFacts}
                        className="rounded-[var(--radius-xs)] border border-[color:var(--color-border)] px-1.5 py-0.5 text-[11px] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
                      >
                        {isSavingFacts
                          ? "Saving…"
                          : `Save ${unwrittenCount} new fact${unwrittenCount === 1 ? "" : "s"}`}
                      </button>
                      {saveFactsError && (
                        <p className="mt-1 text-[color:var(--color-error)]">{saveFactsError}</p>
                      )}
                    </div>
                  );
                })()}
              </div>
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

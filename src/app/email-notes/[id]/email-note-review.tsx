"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { splitWithHighlight } from "@/lib/documents";
import { FamilyTree } from "@/components/family-tree";
import { PersonSearch } from "@/components/person-search";
import type { CandidateWithMatch, PersonMatch } from "@/app/documents/actions";
import type { PersonResolutionInput, BatchConfirmSummary } from "@/app/interviews/actions";
import type { AboutRef } from "@/app/interviews/extraction-schema";
import type { EmailNoteExtraction } from "@/app/api/email-intake/email-body-extraction";
import {
  confirmEmailNoteBatch,
  reExtractEmailNote,
  matchEmailNoteCandidates,
} from "../actions";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;

const matchStatusStyles: Record<string, string> = {
  high_confidence:
    "bg-[color:var(--color-success-subtle-bg)] text-[color:var(--color-success-subtle-fg)]",
  multiple_matches:
    "bg-[color:var(--color-warning-subtle-bg)] text-[color:var(--color-warning-subtle-fg)]",
  no_match: "bg-[color:var(--color-bg-surface-alt)] text-[color:var(--color-text-secondary)]",
};

type PersonDecision = {
  included: boolean;
  mode: "confirm" | "search" | "create";
  selectedPersonId: string | null;
  newName: string;
};

type DecisionMap = Record<string, PersonDecision>;

function isCandidateWithMatch(
  c: EmailNoteExtraction["people"][number],
): c is CandidateWithMatch {
  return "matchStatus" in c;
}

// Same pre-check logic as InterviewReview's initialDecision — a
// high-confidence match starts checked and ready to go, everything else
// starts unchecked so a reviewer always makes an explicit call.
function initialDecision(candidate: CandidateWithMatch): PersonDecision {
  if (candidate.matchStatus === "high_confidence" && candidate.matches[0]) {
    return {
      included: true,
      mode: "confirm",
      selectedPersonId: candidate.matches[0].personId,
      newName: candidate.name,
    };
  }
  if (candidate.matchStatus === "no_match") {
    return { included: false, mode: "create", selectedPersonId: null, newName: candidate.name };
  }
  return { included: false, mode: "confirm", selectedPersonId: null, newName: candidate.name };
}

function buildInitialDecisions(extraction: EmailNoteExtraction | null): DecisionMap {
  const map: DecisionMap = {};
  if (!extraction) return map;
  extraction.people.forEach((candidate, index) => {
    if (!isCandidateWithMatch(candidate) || candidate.resolution) return;
    map[`${index}`] = initialDecision(candidate);
  });
  return map;
}

function resolveTargetIncluded(
  aboutRef: AboutRef,
  extraction: EmailNoteExtraction,
  decisions: DecisionMap,
): boolean {
  if (aboutRef.type !== "person") return false;
  const candidate = extraction.people[aboutRef.index];
  if (!candidate) return false;
  if (isCandidateWithMatch(candidate) && candidate.resolution) {
    return candidate.resolution.action !== "skipped";
  }
  return !!decisions[`${aboutRef.index}`]?.included;
}

function aboutLabel(aboutRef: AboutRef): string {
  if (aboutRef.type === "person") return aboutRef.name;
  if (aboutRef.type === "unresolved") return `${aboutRef.raw} (unresolved)`;
  // Email extraction never produces "interviewee" (resolveAbout is called
  // with no anchorName) — unreachable in practice, but AboutRef is a
  // shared type, so this branch must still typecheck.
  return "unresolved";
}

export function EmailNoteReview({
  documentId,
  senderName,
  senderEmail,
  subject,
  recordedAt,
  bodyText,
  extraction: initialExtraction,
  extractionError,
  people,
  unions,
  unionChildren,
  personSummaries,
}: {
  documentId: string;
  senderName: string | null;
  senderEmail: string | null;
  subject: string | null;
  recordedAt: string | null;
  bodyText: string | null;
  extraction: EmailNoteExtraction | null;
  extractionError: string | null;
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  personSummaries: Record<string, PersonSummary>;
}) {
  const router = useRouter();
  const [extraction, setExtraction] = useState(initialExtraction);
  const [decisions, setDecisions] = useState<DecisionMap>(() =>
    buildInitialDecisions(initialExtraction),
  );
  const [highlightPersonId, setHighlightPersonId] = useState<string | null>(null);
  const [highlightName, setHighlightName] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BatchConfirmSummary | null>(null);

  function updateDecision(key: string, patch: Partial<PersonDecision>) {
    setDecisions((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function handleFocusMatch(personId: string, name: string) {
    setHighlightPersonId(personId);
    setHighlightName(name);
  }

  const senderLabel = senderName || senderEmail || "unknown sender";
  const dateLabel = recordedAt ? new Date(recordedAt).toLocaleDateString() : "unknown date";

  const includedCount = Object.values(decisions).filter((d) => d.included).length;

  async function handleRetry() {
    setIsRetrying(true);
    setError(null);
    const extracted = await reExtractEmailNote(documentId);
    if ("error" in extracted) {
      setIsRetrying(false);
      setError(extracted.error);
      return;
    }
    const matched = await matchEmailNoteCandidates(documentId);
    setIsRetrying(false);
    if ("error" in matched) {
      setError(matched.error);
      return;
    }
    setExtraction(matched.extraction);
    setDecisions(buildInitialDecisions(matched.extraction));
    router.refresh();
  }

  async function handleConfirmBatch() {
    setIsConfirming(true);
    setError(null);
    const payload: Record<string, PersonResolutionInput> = {};
    for (const [key, d] of Object.entries(decisions)) {
      if (!d.included) continue;
      if (d.mode === "create") {
        const name = d.newName.trim();
        if (!name) continue;
        payload[key] = { action: "create", name };
      } else {
        if (!d.selectedPersonId) continue;
        payload[key] = { action: "confirm", personId: d.selectedPersonId };
      }
    }

    const result = await confirmEmailNoteBatch(documentId, payload);
    setIsConfirming(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setSummary(result.summary);
    router.refresh();
  }

  const familyPeople = (extraction?.people ?? [])
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.roleCategory === "family");

  return (
    <div className="flex flex-col gap-4 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] px-4 py-3 shadow-[var(--shadow-1)]">
        <div>
          <h1 className="text-sm font-medium">
            Email from {senderLabel} — {dateLabel}
          </h1>
          {subject && (
            <p className="text-xs text-[color:var(--color-text-secondary)]">Subject: {subject}</p>
          )}
          <p className="text-xs text-[color:var(--color-text-secondary)]">
            {includedCount} candidate{includedCount === 1 ? "" : "s"} checked for this batch
          </p>
        </div>
        <button
          type="button"
          onClick={handleConfirmBatch}
          disabled={isConfirming || includedCount === 0}
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-success)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:opacity-90 disabled:opacity-50"
        >
          {isConfirming ? "Confirming…" : `Confirm batch (${includedCount})`}
        </button>
      </div>

      {extractionError && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[color:var(--color-error)] bg-[color:var(--color-bg-surface)] px-3 py-2 text-sm text-[color:var(--color-error)]">
          <span>Extraction failed: {extractionError}</span>
          <button
            type="button"
            onClick={handleRetry}
            disabled={isRetrying}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-error)] px-2 py-1 text-xs font-medium hover:opacity-80 disabled:opacity-50"
          >
            {isRetrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}
      {summary && (
        <p className="rounded-[var(--radius-sm)] border border-[color:var(--color-success)] bg-[color:var(--color-success-subtle-bg)] px-3 py-2 text-sm text-[color:var(--color-success-subtle-fg)]">
          Confirmed: {summary.peopleConfirmed} linked, {summary.peopleCreated} created,{" "}
          {summary.peopleSkipped} skipped · {summary.factsWritten} facts,{" "}
          {summary.anecdotesWritten} anecdotes saved.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-4 shadow-[var(--shadow-1)] lg:max-h-[78vh] lg:overflow-y-auto">
          <h2 className="text-[length:var(--font-size-caption)] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            Email body
          </h2>
          <pre className="whitespace-pre-wrap font-sans text-xs text-[color:var(--color-text-secondary)]">
            {splitWithHighlight(bodyText ?? "", highlightName).map((part, i) =>
              part.match ? (
                <mark key={i} className="rounded-[var(--radius-xs)] bg-[color:var(--color-accent-subtle)] px-0.5 text-[color:var(--color-text-primary)]">
                  {part.text}
                </mark>
              ) : (
                <span key={i}>{part.text}</span>
              ),
            )}
          </pre>
        </div>

        <div className="flex flex-col gap-5 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-4 shadow-[var(--shadow-1)] lg:max-h-[78vh] lg:overflow-y-auto">
          <h2 className="text-[length:var(--font-size-caption)] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            Candidates
          </h2>

          {!extraction && (
            <p className="text-xs text-[color:var(--color-text-secondary)]">
              No extraction yet.{" "}
              <button type="button" onClick={handleRetry} className="underline" disabled={isRetrying}>
                {isRetrying ? "Extracting…" : "Extract now"}
              </button>
            </p>
          )}

          {extraction && familyPeople.length > 0 && (
            <ul className="flex flex-col gap-3">
              {familyPeople.map(({ c, index }) =>
                isCandidateWithMatch(c) ? (
                  <PersonCandidateRow
                    key={index}
                    index={index}
                    candidate={c}
                    decision={decisions[`${index}`]}
                    onChange={(patch) => updateDecision(`${index}`, patch)}
                    people={people}
                    personSummaries={personSummaries}
                    onFocusMatch={handleFocusMatch}
                  />
                ) : null,
              )}
            </ul>
          )}

          {extraction && extraction.facts.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <p className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-tertiary)]">
                Facts
              </p>
              {extraction.facts.map((f, i) => (
                <FactAnecdoteLine
                  key={i}
                  included={resolveTargetIncluded(f.aboutRef, extraction, decisions)}
                  already={!!f.written}
                  label={aboutLabel(f.aboutRef)}
                >
                  <span className="font-medium">{f.field}:</span> {f.value}
                  {f.confidence && (
                    <span className="text-[color:var(--color-text-secondary)]"> ({f.confidence})</span>
                  )}
                  {f.dateInferenceNote && (
                    <span className="ml-1 rounded-[var(--radius-xs)] bg-[color:var(--color-warning-subtle-bg)] px-1 py-0.5 text-[10px] text-[color:var(--color-warning-subtle-fg)]">
                      {f.dateInferenceNote}
                    </span>
                  )}
                </FactAnecdoteLine>
              ))}
            </div>
          )}

          {extraction && extraction.anecdotes.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <p className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-tertiary)]">
                Anecdotes
              </p>
              {extraction.anecdotes.map((a, i) => (
                <FactAnecdoteLine
                  key={i}
                  included={resolveTargetIncluded(a.aboutRef, extraction, decisions)}
                  already={!!a.written}
                  label={aboutLabel(a.aboutRef)}
                >
                  {a.storyText}
                </FactAnecdoteLine>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-2 shadow-[var(--shadow-1)]">
          <h2 className="px-2 py-1 text-[length:var(--font-size-caption)] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
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

function FactAnecdoteLine({
  included,
  already,
  label,
  children,
}: {
  included: boolean;
  already: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <p
      className={`text-[11px] ${
        already
          ? "text-[color:var(--color-text-tertiary)]"
          : included
            ? "text-[color:var(--color-text-secondary)]"
            : "text-[color:var(--color-text-tertiary)]"
      }`}
    >
      <span className="text-[color:var(--color-text-secondary)]">{label}</span> — {children}
      {already && <span className="italic"> · saved</span>}
      {!already && !included && <span className="italic"> · will be skipped for now</span>}
    </p>
  );
}

function PersonCandidateRow({
  index,
  candidate,
  decision,
  onChange,
  people,
  personSummaries,
  onFocusMatch,
}: {
  index: number;
  candidate: CandidateWithMatch;
  decision: PersonDecision | undefined;
  onChange: (patch: Partial<PersonDecision>) => void;
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  onFocusMatch: (personId: string, name: string) => void;
}) {
  if (candidate.resolution) {
    const resolvedName =
      (candidate.resolution.personId &&
        (candidate.matches.find((m) => m.personId === candidate.resolution?.personId)
          ?.personName ??
          people.find((p) => p.id === candidate.resolution?.personId)?.name)) ||
      candidate.name;
    return (
      <li className="text-xs text-[color:var(--color-text-secondary)]">
        <span className="font-medium text-[color:var(--color-text-secondary)]">{candidate.name}</span>
        {candidate.relation && ` — ${candidate.relation}`}
        <p className="mt-0.5 text-[11px] text-[color:var(--color-text-secondary)]">
          {candidate.resolution.action === "confirmed" && `Confirmed → linked to ${resolvedName}`}
          {candidate.resolution.action === "created" && `Created new person: ${resolvedName}`}
          {candidate.resolution.action === "skipped" && "Skipped"}
        </p>
      </li>
    );
  }

  if (!decision) return null;

  const matches = candidate.matches;
  const inputName = `person-${index}`;

  return (
    <li className="text-xs text-[color:var(--color-text-secondary)]">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={decision.included}
          onChange={(e) => onChange({ included: e.target.checked })}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium text-[color:var(--color-text-primary)]">{candidate.name}</span>
          {candidate.relation && ` — ${candidate.relation}`}
          {candidate.note && ` · ${candidate.note}`}
          <span
            className={`ml-2 rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${matchStatusStyles[candidate.matchStatus]}`}
          >
            {candidate.matchStatus === "high_confidence" && matches[0]
              ? `matches ${matches[0].personName} (${Math.round(matches[0].score * 100)}%)`
              : candidate.matchStatus === "multiple_matches"
                ? `${matches.length} possible matches`
                : "new person"}
          </span>
        </span>
      </label>

      {decision.included && (
        <div className="mt-1.5 ml-5 flex flex-col gap-1.5 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-2">
          {matches.slice(0, 6).map((m: PersonMatch) => {
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
                  name={inputName}
                  checked={decision.mode !== "search" && decision.selectedPersonId === m.personId}
                  onChange={() => onChange({ mode: "confirm", selectedPersonId: m.personId })}
                  onFocus={() => onFocusMatch(m.personId, candidate.name)}
                  className="mt-0.5"
                />
                <span>
                  {m.personName} — {(m.score * 100).toFixed(0)}%
                  {m.relationSignal && " · existing relationship"}
                  <span className="block text-[color:var(--color-text-secondary)]">
                    {dates && `${dates} · `}
                    {summary?.relationshipSummary ?? "not yet in the tree"}
                  </span>
                </span>
              </label>
            );
          })}

          <label className="flex items-start gap-1.5">
            <input
              type="radio"
              name={inputName}
              checked={decision.mode === "create"}
              onChange={() => onChange({ mode: "create" })}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-1">
              None of these — create a new person
              {decision.mode === "create" && (
                <input
                  value={decision.newName}
                  onChange={(e) => onChange({ newName: e.target.value })}
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-2 py-1 text-xs text-[color:var(--color-text-primary)]"
                />
              )}
            </span>
          </label>

          <label className="flex items-start gap-1.5">
            <input
              type="radio"
              name={inputName}
              checked={decision.mode === "search"}
              onChange={() => onChange({ mode: "search", selectedPersonId: null })}
              className="mt-0.5"
            />
            <span>None of these — search for the correct person</span>
          </label>
          {decision.mode === "search" && (
            <div className="ml-5">
              <PersonSearch
                people={people}
                personSummaries={personSummaries}
                selectedId={decision.selectedPersonId}
                onSelect={(id) => onChange({ selectedPersonId: id })}
                onHoverPerson={(id) => onFocusMatch(id, candidate.name)}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

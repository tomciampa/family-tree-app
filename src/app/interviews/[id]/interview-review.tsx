"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { splitWithHighlight } from "@/lib/documents";
import { FamilyTree } from "@/components/family-tree";
import { PersonSearch } from "@/components/person-search";
import type { CandidateWithMatch, PersonMatch } from "@/app/documents/actions";
import {
  confirmInterviewBatch,
  type InterviewExtraction,
  type AboutRef,
  type PersonResolutionInput,
  type BatchConfirmSummary,
} from "../actions";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;

export type ReviewSegment = {
  id: string;
  kind: string | null;
  audio_start_seconds: number | null;
  audio_end_seconds: number | null;
  transcription_raw: string | null;
  extraction: InterviewExtraction | null;
};

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const matchStatusStyles: Record<string, string> = {
  high_confidence:
    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  multiple_matches:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  no_match: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

type PersonDecision = {
  included: boolean;
  mode: "confirm" | "search" | "create";
  selectedPersonId: string | null;
  newName: string;
};

type DecisionMap = Record<string, PersonDecision>;

function isCandidateWithMatch(
  c: InterviewExtraction["people"][number],
): c is CandidateWithMatch {
  return "matchStatus" in c;
}

// Pre-checks exactly what the batch design calls for: a high-confidence
// match (spouse/parent/sibling via the relationship signal) is ready to
// go as-is. Everything else — ambiguous or brand new — starts unchecked,
// defaulting to the create-new-person flow when there's genuinely no
// match, but never auto-included.
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

function buildInitialDecisions(segments: ReviewSegment[]): DecisionMap {
  const map: DecisionMap = {};
  for (const segment of segments) {
    const people = segment.extraction?.people ?? [];
    people.forEach((candidate, index) => {
      if (!isCandidateWithMatch(candidate) || candidate.resolution) return;
      map[`${segment.id}:${index}`] = initialDecision(candidate);
    });
  }
  return map;
}

function resolveTargetIncluded(
  aboutRef: AboutRef,
  segment: ReviewSegment,
  decisions: DecisionMap,
): boolean {
  if (aboutRef.type === "interviewee") return true;
  if (aboutRef.type === "unresolved") return false;
  const candidate = segment.extraction?.people[aboutRef.index];
  if (!candidate) return false;
  if (isCandidateWithMatch(candidate) && candidate.resolution) {
    return candidate.resolution.action !== "skipped";
  }
  return !!decisions[`${segment.id}:${aboutRef.index}`]?.included;
}

function aboutLabel(aboutRef: AboutRef, intervieweeName: string): string {
  if (aboutRef.type === "interviewee") return intervieweeName;
  if (aboutRef.type === "person") return aboutRef.name;
  return `${aboutRef.raw} (unresolved)`;
}

export function InterviewReview({
  parentId,
  intervieweeName,
  audioUrl,
  segments,
  people,
  unions,
  unionChildren,
  personSummaries,
}: {
  parentId: string;
  intervieweeName: string;
  audioUrl: string | null;
  segments: ReviewSegment[];
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  personSummaries: Record<string, PersonSummary>;
}) {
  const router = useRouter();
  const [decisions, setDecisions] = useState<DecisionMap>(() => buildInitialDecisions(segments));
  const [highlightPersonId, setHighlightPersonId] = useState<string | null>(null);
  const [highlightName, setHighlightName] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BatchConfirmSummary | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  function updateDecision(key: string, patch: Partial<PersonDecision>) {
    setDecisions((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function handleFocusMatch(personId: string, name: string) {
    setHighlightPersonId(personId);
    setHighlightName(name);
  }

  function seekTo(seconds: number) {
    if (!audioRef.current) return;
    audioRef.current.currentTime = seconds;
    void audioRef.current.play();
  }

  const includedCount = Object.values(decisions).filter((d) => d.included).length;

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

    const result = await confirmInterviewBatch(parentId, payload);
    setIsConfirming(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setSummary(result.summary);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-gray-200 px-4 py-3 dark:border-gray-800">
        <div>
          <h1 className="text-sm font-medium">Interview with {intervieweeName}</h1>
          <p className="text-xs text-gray-500">
            {includedCount} candidate{includedCount === 1 ? "" : "s"} checked for this batch
          </p>
        </div>
        <button
          type="button"
          onClick={handleConfirmBatch}
          disabled={isConfirming || includedCount === 0}
          className="rounded bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
        >
          {isConfirming ? "Confirming…" : `Confirm batch (${includedCount})`}
        </button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      {summary && (
        <p className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300">
          Confirmed: {summary.peopleConfirmed} linked, {summary.peopleCreated} created,{" "}
          {summary.peopleSkipped} skipped · {summary.factsWritten} facts,{" "}
          {summary.anecdotesWritten} anecdotes saved.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-3 rounded border border-gray-200 p-4 dark:border-gray-800 lg:max-h-[78vh] lg:overflow-y-auto">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Recording
          </h2>
          {audioUrl ? (
            <audio ref={audioRef} controls preload="none" src={audioUrl} className="w-full">
              Your browser doesn&apos;t support audio playback.
            </audio>
          ) : (
            <p className="text-xs text-red-500">Recording unavailable right now.</p>
          )}

          <div className="flex flex-col gap-3">
            {segments.map((segment) => {
              const parts = splitWithHighlight(segment.transcription_raw ?? "", highlightName);
              return (
                <div key={segment.id} className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      segment.audio_start_seconds != null && seekTo(segment.audio_start_seconds)
                    }
                    className="self-start text-xs font-medium uppercase tracking-wide text-gray-500 hover:underline"
                  >
                    {segment.kind ?? "Segment"}
                    {segment.audio_start_seconds != null && segment.audio_end_seconds != null && (
                      <span className="font-normal text-gray-400 dark:text-gray-500">
                        {" "}
                        ({formatSeconds(segment.audio_start_seconds)}–
                        {formatSeconds(segment.audio_end_seconds)})
                      </span>
                    )}
                  </button>
                  <pre className="whitespace-pre-wrap font-sans text-xs text-gray-700 dark:text-gray-300">
                    {parts.map((part, i) =>
                      part.match ? (
                        <mark key={i} className="rounded bg-amber-200 px-0.5 dark:bg-amber-700/60">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={i}>{part.text}</span>
                      ),
                    )}
                  </pre>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-5 rounded border border-gray-200 p-4 dark:border-gray-800 lg:max-h-[78vh] lg:overflow-y-auto">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Candidates
          </h2>
          {segments.map((segment) => {
            const extraction = segment.extraction;
            if (!extraction) return null;
            const familyPeople = extraction.people
              .map((c, index) => ({ c, index }))
              .filter(({ c }) => c.roleCategory === "family");
            if (
              familyPeople.length === 0 &&
              extraction.facts.length === 0 &&
              extraction.anecdotes.length === 0
            ) {
              return null;
            }
            return (
              <div key={segment.id} className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                  {segment.kind ?? "Segment"}
                </h3>

                {familyPeople.length > 0 && (
                  <ul className="flex flex-col gap-3">
                    {familyPeople.map(({ c, index }) =>
                      isCandidateWithMatch(c) ? (
                        <PersonCandidateRow
                          key={index}
                          segmentId={segment.id}
                          index={index}
                          candidate={c}
                          decision={decisions[`${segment.id}:${index}`]}
                          onChange={(patch) =>
                            updateDecision(`${segment.id}:${index}`, patch)
                          }
                          people={people}
                          personSummaries={personSummaries}
                          onFocusMatch={handleFocusMatch}
                        />
                      ) : null,
                    )}
                  </ul>
                )}

                {extraction.facts.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-600">
                      Facts
                    </p>
                    {extraction.facts.map((f, i) => (
                      <FactAnecdoteLine
                        key={i}
                        included={resolveTargetIncluded(f.aboutRef, segment, decisions)}
                        already={!!f.written}
                        label={aboutLabel(f.aboutRef, intervieweeName)}
                      >
                        <span className="font-medium">{f.field}:</span> {f.value}
                        {f.confidence && <span className="text-gray-500"> ({f.confidence})</span>}
                      </FactAnecdoteLine>
                    ))}
                  </div>
                )}

                {extraction.anecdotes.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-600">
                      Anecdotes
                    </p>
                    {extraction.anecdotes.map((a, i) => (
                      <FactAnecdoteLine
                        key={i}
                        included={resolveTargetIncluded(a.aboutRef, segment, decisions)}
                        already={!!a.written}
                        label={aboutLabel(a.aboutRef, intervieweeName)}
                      >
                        {a.storyText}
                      </FactAnecdoteLine>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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
          ? "text-gray-400 dark:text-gray-600"
          : included
            ? "text-gray-700 dark:text-gray-300"
            : "text-gray-400 dark:text-gray-600"
      }`}
    >
      <span className="text-gray-500">{label}</span> — {children}
      {already && <span className="italic"> · saved</span>}
      {!already && !included && <span className="italic"> · will be skipped for now</span>}
    </p>
  );
}

function PersonCandidateRow({
  segmentId,
  index,
  candidate,
  decision,
  onChange,
  people,
  personSummaries,
  onFocusMatch,
}: {
  segmentId: string;
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
      <li className="text-xs text-gray-500">
        <span className="font-medium text-gray-700 dark:text-gray-300">{candidate.name}</span>
        {candidate.relation && ` — ${candidate.relation}`}
        <p className="mt-0.5 text-[11px] text-gray-500">
          {candidate.resolution.action === "confirmed" && `Confirmed → linked to ${resolvedName}`}
          {candidate.resolution.action === "created" && `Created new person: ${resolvedName}`}
          {candidate.resolution.action === "skipped" && "Skipped"}
        </p>
      </li>
    );
  }

  if (!decision) return null;

  const matches = candidate.matches;
  const inputName = `person-${segmentId}-${index}`;

  return (
    <li className="text-xs text-gray-600 dark:text-gray-400">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={decision.included}
          onChange={(e) => onChange({ included: e.target.checked })}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium text-gray-800 dark:text-gray-200">{candidate.name}</span>
          {candidate.relation && ` — ${candidate.relation}`}
          {candidate.note && ` · ${candidate.note}`}
          <span
            className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${matchStatusStyles[candidate.matchStatus]}`}
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
        <div className="mt-1.5 ml-5 flex flex-col gap-1.5 rounded border border-gray-200 p-2 dark:border-gray-800">
          {matches.slice(0, 6).map((m: PersonMatch) => {
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
                  name={inputName}
                  checked={decision.mode !== "search" && decision.selectedPersonId === m.personId}
                  onChange={() => onChange({ mode: "confirm", selectedPersonId: m.personId })}
                  onFocus={() => onFocusMatch(m.personId, candidate.name)}
                  className="mt-0.5"
                />
                <span>
                  {m.personName} — {(m.score * 100).toFixed(0)}%
                  {m.relationSignal && " · existing relationship"}
                  <span className="block text-gray-500 dark:text-gray-500">
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
                  className="rounded border border-gray-300 px-2 py-1 text-xs text-black dark:border-gray-700 dark:bg-gray-800 dark:text-white"
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

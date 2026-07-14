"use client";

import { useState } from "react";
import { useRef } from "react";
import Link from "next/link";
import {
  uploadDocument,
  extractCandidatesFromDocument,
  matchCandidatesForDocument,
  confirmCandidateMatch,
  createPersonForCandidate,
  skipCandidateResolution,
} from "./actions";
import type { PersonSummary } from "@/lib/family";

export type PersonMatch = {
  personId: string;
  personName: string;
  score: number;
  dateSignal: "overlap" | "conflict" | null;
  relationSignal?: boolean;
};

export type CandidateResolution = {
  action: "confirmed" | "created" | "skipped";
  personId?: string;
  factId?: string;
};

export type CandidatePerson = {
  name: string;
  relation: string | null;
  roleCategory: "family" | "administrative";
  dates: string | null;
  note: string | null;
  matchStatus?: "high_confidence" | "multiple_matches" | "no_match";
  matches?: PersonMatch[];
  resolution?: CandidateResolution;
};

export type DocumentRow = {
  id: string;
  filename: string | null;
  file_path: string;
  status: string;
  recorded_at: string | null;
  candidate_people: CandidatePerson[] | null;
  viewUrl: string | null;
};

const statusStyles: Record<string, string> = {
  pending_match:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  matched: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  no_match: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export function DocumentsView({
  documents,
  personSummaries,
}: {
  documents: DocumentRow[];
  personSummaries: Record<string, PersonSummary>;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function uploadFiles(files: FileList | File[]) {
    setIsUploading(true);
    setError(null);
    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.set("file", file);
      const result = await uploadDocument(formData);
      if (result?.error) {
        setError(`${file.name}: ${result.error}`);
      }
    }
    setIsUploading(false);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (e.dataTransfer.files.length > 0) {
            uploadFiles(e.dataTransfer.files);
          }
        }}
        onClick={() => fileInputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
          isDragging
            ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
            : "border-gray-300 dark:border-gray-700"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              uploadFiles(e.target.files);
              e.target.value = "";
            }
          }}
        />
        <p className="text-sm font-medium">
          Drag and drop files here, or click to browse
        </p>
        <p className="text-xs text-gray-500">
          Certificates, letters, photos, anything — they&apos;ll be matched to
          people later.
        </p>
        {isUploading && <p className="text-sm text-gray-500">Uploading…</p>}
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex flex-col gap-2">
        {documents.length === 0 && (
          <p className="text-sm text-gray-500">No documents uploaded yet.</p>
        )}
        {documents.map((doc) => (
          <DocumentItem key={doc.id} doc={doc} personSummaries={personSummaries} />
        ))}
      </div>
    </div>
  );
}

function DocumentItem({
  doc,
  personSummaries,
}: {
  doc: DocumentRow;
  personSummaries: Record<string, PersonSummary>;
}) {
  const [isExtracting, setIsExtracting] = useState(false);
  const [isMatching, setIsMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState(doc.status);
  const [candidates, setCandidates] = useState<CandidatePerson[] | null>(
    doc.candidate_people,
  );

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

  function handleCandidateUpdate(
    updated: CandidatePerson[],
    newStatus?: string,
  ) {
    setCandidates(updated);
    if (newStatus) setStatus(newStatus);
  }

  const hasFamilyCandidates =
    candidates?.some((c) => c.roleCategory === "family") ?? false;
  const familyEntries = (candidates ?? [])
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.roleCategory === "family");
  const adminEntries = (candidates ?? [])
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => c.roleCategory === "administrative");

  return (
    <div className="rounded border border-gray-200 px-4 py-3 text-sm dark:border-gray-800">
      <div className="flex items-center justify-between gap-4">
        {doc.viewUrl ? (
          <a
            href={doc.viewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate underline hover:text-gray-500"
          >
            {doc.filename ?? doc.file_path}
          </a>
        ) : (
          <span className="truncate">{doc.filename ?? doc.file_path}</span>
        )}
        <span className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            {doc.recorded_at
              ? new Date(doc.recorded_at).toLocaleDateString()
              : ""}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              statusStyles[status] ?? statusStyles.pending_match
            }`}
          >
            {status.replace("_", " ")}
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
        </span>
      </div>

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

      {candidates && candidates.length > 0 && (
        <div className="mt-2 flex flex-col gap-3 border-t border-gray-100 pt-2 dark:border-gray-800">
          {familyEntries.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                Family
              </p>
              <ul className="flex flex-col gap-3">
                {familyEntries.map(({ c, index }) => (
                  <FamilyCandidateRow
                    key={index}
                    documentId={doc.id}
                    index={index}
                    candidate={c}
                    personSummaries={personSummaries}
                    onUpdate={handleCandidateUpdate}
                  />
                ))}
              </ul>
            </div>
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
      )}
    </div>
  );
}

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

function FamilyCandidateRow({
  documentId,
  index,
  candidate,
  personSummaries,
  onUpdate,
}: {
  documentId: string;
  index: number;
  candidate: CandidatePerson;
  personSummaries: Record<string, PersonSummary>;
  onUpdate: (updated: CandidatePerson[], newStatus?: string) => void;
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
    const allResolved = result.candidates
      .filter((c) => c.roleCategory === "family")
      .every((c) => !!c.resolution);
    onUpdate(result.candidates, allResolved ? "matched" : undefined);
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
    const allResolved = result.candidates
      .filter((c) => c.roleCategory === "family")
      .every((c) => !!c.resolution);
    onUpdate(result.candidates, allResolved ? "matched" : undefined);
  }

  const resolvedPerson = candidate.resolution?.personId
    ? (matches.find((m) => m.personId === candidate.resolution?.personId)
        ?.personName ?? newName)
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
                  <label key={m.personId} className="flex items-start gap-1.5">
                    <input
                      type="radio"
                      name={`candidate-${documentId}-${index}`}
                      checked={selection === m.personId}
                      onChange={() => setSelection(m.personId)}
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
                        <Link
                          href={`/tree?highlight=${m.personId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:text-gray-700 dark:hover:text-gray-300"
                        >
                          view in tree ↗
                        </Link>
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
                  checked={selection === "__new__"}
                  onChange={() => setSelection("__new__")}
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

              {error && <p className="text-[11px] text-red-500">{error}</p>}

              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={isSaving || !selection}
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

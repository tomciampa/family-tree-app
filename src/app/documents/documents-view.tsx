"use client";

import { useState } from "react";
import { useRef } from "react";
import Link from "next/link";
import {
  uploadDocument,
  extractCandidatesFromDocument,
  matchCandidatesForDocument,
} from "./actions";

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

// Matches next.config.ts's experimental.serverActions.bodySizeLimit —
// checked client-side first so an obviously-oversized file gets instant,
// friendly feedback without a wasted round trip.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const TOO_LARGE_MESSAGE = "File too large — please keep uploads under 10MB.";

export function DocumentsView({ documents }: { documents: DocumentRow[] }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function uploadFiles(files: FileList | File[]) {
    setIsUploading(true);
    setError(null);
    for (const file of Array.from(files)) {
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(`${file.name}: ${TOO_LARGE_MESSAGE}`);
        continue;
      }
      try {
        const formData = new FormData();
        formData.set("file", file);
        const result = await uploadDocument(formData);
        if (result?.error) {
          setError(`${file.name}: ${result.error}`);
        }
      } catch (err) {
        // A Server Action whose request body gets rejected (e.g. Next's
        // body size limit applies to the raw multipart body, which is
        // slightly larger than the file itself, so a file just under our
        // client-side check above could still be rejected server-side)
        // throws instead of resolving with {error}. Catching this here —
        // per file, inside the loop — is what actually fixes the original
        // bug: without it, the throw skipped every line after it,
        // including setIsUploading(false) below, leaving the UI stuck on
        // "Uploading…" forever with no feedback.
        const message =
          err instanceof Error && /body exceeded/i.test(err.message)
            ? TOO_LARGE_MESSAGE
            : "Upload failed — please try again.";
        setError(`${file.name}: ${message}`);
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
          <DocumentItem key={doc.id} doc={doc} />
        ))}
      </div>
    </div>
  );
}

function DocumentItem({ doc }: { doc: DocumentRow }) {
  const [isExtracting, setIsExtracting] = useState(false);
  const [isMatching, setIsMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resolving candidates now happens on the /documents/[id] review page,
  // which revalidates this list on confirm/skip/create — so doc.status
  // (a fresh server prop on every navigation back here) is always
  // current; no local mutation needed.
  const status = doc.status;
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

  const familyCandidates = (candidates ?? []).filter(
    (c) => c.roleCategory === "family",
  );
  const hasFamilyCandidates = familyCandidates.length > 0;
  const unresolvedCount = familyCandidates.filter((c) => !c.resolution).length;

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

      {hasFamilyCandidates && (
        <div className="mt-2 flex items-center justify-between border-t border-gray-100 pt-2 text-xs dark:border-gray-800">
          <span className="text-gray-500">
            {unresolvedCount > 0
              ? `${unresolvedCount} of ${familyCandidates.length} candidate${familyCandidates.length === 1 ? "" : "s"} need review`
              : `All ${familyCandidates.length} candidate${familyCandidates.length === 1 ? "" : "s"} resolved`}
          </span>
          <Link
            href={`/documents/${doc.id}`}
            className="font-medium underline hover:text-gray-700 dark:hover:text-gray-300"
          >
            Review matches →
          </Link>
        </div>
      )}
    </div>
  );
}

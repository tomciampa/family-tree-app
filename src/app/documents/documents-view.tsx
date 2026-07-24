"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  uploadDocument,
  extractCandidatesFromDocument,
  matchCandidatesForDocument,
} from "./actions";
import { DeleteDocumentButton } from "./delete-document-button";

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
    "bg-[color:var(--color-warning-subtle-bg)] text-[color:var(--color-warning-subtle-fg)]",
  matched: "bg-[color:var(--color-success-subtle-bg)] text-[color:var(--color-success-subtle-fg)]",
  no_match: "bg-[color:var(--color-bg-surface-alt)] text-[color:var(--color-text-secondary)]",
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
  // Documents uploaded this session, so their DocumentItem knows to
  // auto-run extraction + matching on mount instead of waiting for a
  // manual click. Not persisted — a page reload just falls back to the
  // manual Extract/Match buttons for anything still unprocessed.
  const [autoProcessIds, setAutoProcessIds] = useState<Set<string>>(
    new Set(),
  );
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
        if ("error" in result) {
          setError(`${file.name}: ${result.error}`);
        } else {
          setAutoProcessIds((prev) => new Set(prev).add(result.id));
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
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border-2 border-dashed p-10 text-center transition-colors duration-[var(--duration-base)] ${
          isDragging
            ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-subtle)]"
            : "border-[color:var(--color-border)]"
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
        <p className="text-xs text-[color:var(--color-text-secondary)]">
          Certificates, letters, photos, anything — they&apos;ll be matched to
          people later.
        </p>
        {isUploading && <p className="text-sm text-[color:var(--color-text-secondary)]">Uploading…</p>}
      </div>

      {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}

      <div className="flex flex-col gap-2">
        {documents.length === 0 && (
          <p className="text-sm text-[color:var(--color-text-secondary)]">No documents uploaded yet.</p>
        )}
        {documents.map((doc) => (
          <DocumentItem
            key={doc.id}
            doc={doc}
            autoProcess={autoProcessIds.has(doc.id)}
          />
        ))}
      </div>
    </div>
  );
}

function DocumentItem({
  doc,
  autoProcess,
}: {
  doc: DocumentRow;
  autoProcess: boolean;
}) {
  const [isExtracting, setIsExtracting] = useState(false);
  const [isMatching, setIsMatching] = useState(false);
  const [isAutoProcessing, setIsAutoProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resolving candidates now happens on the /documents/[id] review page,
  // which revalidates this list on confirm/skip/create — so doc.status
  // (a fresh server prop on every navigation back here) is always
  // current; no local mutation needed.
  const status = doc.status;
  const [candidates, setCandidates] = useState<CandidatePerson[] | null>(
    doc.candidate_people,
  );
  const autoTriggered = useRef(false);

  async function runAutoProcess() {
    setError(null);
    setIsAutoProcessing(true);
    const extracted = await extractCandidatesFromDocument(doc.id);
    if ("error" in extracted) {
      setError(extracted.error);
      setIsAutoProcessing(false);
      return;
    }
    setCandidates(extracted.candidates);

    const hasFamily = extracted.candidates.some(
      (c) => c.roleCategory === "family",
    );
    if (hasFamily) {
      const matched = await matchCandidatesForDocument(doc.id);
      if ("error" in matched) {
        setError(matched.error);
        setIsAutoProcessing(false);
        return;
      }
      setCandidates(matched.candidates);
    }
    setIsAutoProcessing(false);
  }

  useEffect(() => {
    // Guarded on candidate_people being null (never extracted) so this
    // only fires for a genuinely fresh upload, not for older pending
    // documents that happen to remount — those still rely on the manual
    // buttons below.
    if (autoProcess && !autoTriggered.current && doc.candidate_people === null) {
      autoTriggered.current = true;
      void runAutoProcess();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoProcess]);

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
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] px-4 py-3 text-sm shadow-[var(--shadow-1)]">
      <div className="flex items-center justify-between gap-4">
        {doc.viewUrl ? (
          <a
            href={doc.viewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-secondary)]"
          >
            {doc.filename ?? doc.file_path}
          </a>
        ) : (
          <span className="truncate">{doc.filename ?? doc.file_path}</span>
        )}
        <span className="flex items-center gap-3">
          <span className="text-xs text-[color:var(--color-text-secondary)]">
            {doc.recorded_at
              ? new Date(doc.recorded_at).toLocaleDateString()
              : ""}
          </span>
          {isAutoProcessing ? (
            <span className="flex items-center gap-1.5 rounded-[var(--radius-xs)] bg-[color:var(--color-warning-subtle-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-warning-subtle-fg)]">
              <span
                aria-hidden
                className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent"
              />
              Processing…
            </span>
          ) : (
            <span
              className={`rounded-[var(--radius-xs)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                statusStyles[status] ?? statusStyles.pending_match
              }`}
            >
              {status.replace("_", " ")}
            </span>
          )}
          <button
            type="button"
            onClick={handleExtract}
            disabled={isExtracting || isAutoProcessing}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
          >
            {isExtracting ? "Extracting…" : candidates ? "Re-extract" : "Extract"}
          </button>
          {hasFamilyCandidates && (
            <button
              type="button"
              onClick={handleMatch}
              disabled={isMatching || isAutoProcessing}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
            >
              {isMatching ? "Matching…" : "Match"}
            </button>
          )}
          {/* On this list page, deleteDocument's own revalidatePath("/documents")
              already refreshes the list — no client-side navigation needed. */}
          <DeleteDocumentButton
            documentId={doc.id}
            filename={doc.filename}
            onDeleted={() => {}}
          />
        </span>
      </div>

      {error && <p className="mt-2 text-xs text-[color:var(--color-error)]">{error}</p>}

      {hasFamilyCandidates && (
        <div className="mt-2 flex items-center justify-between border-t border-[color:var(--color-border-subtle)] pt-2 text-xs">
          <span className="text-[color:var(--color-text-secondary)]">
            {unresolvedCount > 0
              ? `${unresolvedCount} of ${familyCandidates.length} candidate${familyCandidates.length === 1 ? "" : "s"} need review`
              : `All ${familyCandidates.length} candidate${familyCandidates.length === 1 ? "" : "s"} resolved`}
          </span>
          <Link
            href={`/documents/${doc.id}`}
            className="font-medium text-[color:var(--color-accent)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-accent-hover)]"
          >
            Review matches →
          </Link>
        </div>
      )}
    </div>
  );
}

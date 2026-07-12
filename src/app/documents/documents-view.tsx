"use client";

import { useRef, useState } from "react";
import { uploadDocument, extractCandidatesFromDocument } from "./actions";

export type CandidatePerson = {
  name: string;
  relation: string | null;
  roleCategory: "family" | "administrative";
  dates: string | null;
  note: string | null;
};

export type DocumentRow = {
  id: string;
  filename: string | null;
  file_path: string;
  status: string;
  recorded_at: string | null;
  candidate_people: CandidatePerson[] | null;
};

const statusStyles: Record<string, string> = {
  pending_match:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  matched: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  no_match: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export function DocumentsView({ documents }: { documents: DocumentRow[] }) {
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
        {isUploading && (
          <p className="text-sm text-gray-500">Uploading…</p>
        )}
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
  const [error, setError] = useState<string | null>(null);
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

  return (
    <div className="rounded border border-gray-200 px-4 py-3 text-sm dark:border-gray-800">
      <div className="flex items-center justify-between gap-4">
        <span className="truncate">{doc.filename ?? doc.file_path}</span>
        <span className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            {doc.recorded_at
              ? new Date(doc.recorded_at).toLocaleDateString()
              : ""}
          </span>
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
            {isExtracting
              ? "Extracting…"
              : candidates
                ? "Re-extract"
                : "Extract"}
          </button>
        </span>
      </div>

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

      {candidates && candidates.length > 0 && (
        <div className="mt-2 flex flex-col gap-3 border-t border-gray-100 pt-2 dark:border-gray-800">
          <CandidateGroup
            title="Family"
            candidates={candidates.filter((c) => c.roleCategory === "family")}
          />
          <CandidateGroup
            title="Administrative (not matched as family)"
            candidates={candidates.filter(
              (c) => c.roleCategory === "administrative",
            )}
            muted
          />
        </div>
      )}
    </div>
  );
}

function CandidateGroup({
  title,
  candidates,
  muted,
}: {
  title: string;
  candidates: CandidatePerson[];
  muted?: boolean;
}) {
  if (candidates.length === 0) return null;
  return (
    <div>
      <p
        className={`mb-1 text-[10px] font-medium uppercase tracking-wide ${
          muted ? "text-gray-400 dark:text-gray-600" : "text-gray-500"
        }`}
      >
        {title}
      </p>
      <ul className="flex flex-col gap-1">
        {candidates.map((c, i) => (
          <li
            key={i}
            className={`text-xs ${
              muted
                ? "text-gray-400 dark:text-gray-600"
                : "text-gray-600 dark:text-gray-400"
            }`}
          >
            <span
              className={`font-medium ${
                muted
                  ? "text-gray-500 dark:text-gray-500"
                  : "text-gray-800 dark:text-gray-200"
              }`}
            >
              {c.name}
            </span>
            {c.relation && ` — ${c.relation}`}
            {c.dates && ` (${c.dates})`}
            {c.note && ` · ${c.note}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

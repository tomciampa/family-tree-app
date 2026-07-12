"use client";

import { useRef, useState } from "react";
import { uploadDocument } from "./actions";

type DocumentRow = {
  id: string;
  filename: string | null;
  file_path: string;
  status: string;
  recorded_at: string | null;
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
          <div
            key={doc.id}
            className="flex items-center justify-between gap-4 rounded border border-gray-200 px-4 py-3 text-sm dark:border-gray-800"
          >
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
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

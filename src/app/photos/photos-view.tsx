"use client";

import { useRef, useState } from "react";
import { uploadPhoto } from "./actions";

export type PhotoRow = {
  id: string;
  storage_path: string;
  original_filename: string;
  caption: string | null;
  taken_at: string | null;
  created_at: string | null;
  viewUrl: string | null;
};

// Matches next.config.ts's experimental.serverActions.bodySizeLimit, same
// as documents-view.tsx's own check.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const TOO_LARGE_MESSAGE = "File too large — please keep uploads under 10MB.";

// Stage 1 only: drag-and-drop upload plus a plain, unstyled list of what's
// been uploaded so far — no tagging, no real gallery layout yet (that's a
// later stage). Visual pattern for the drop zone itself deliberately
// mirrors documents-view.tsx's, reusing the same design tokens.
export function PhotosView({ photos }: { photos: PhotoRow[] }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<PhotoRow[]>(photos);
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
        const result = await uploadPhoto(formData);
        if ("error" in result) {
          setError(`${file.name}: ${result.error}`);
        }
      } catch {
        setError(`${file.name}: Upload failed — please try again.`);
      }
    }
    setIsUploading(false);
    // Stage 1 has no signed URL for a just-uploaded photo without a full
    // reload (createSignedUrls happens server-side in page.tsx) — a
    // simple refresh is enough for now, the gallery stage will handle
    // this more smoothly.
    window.location.reload();
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
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              uploadFiles(e.target.files);
              e.target.value = "";
            }
          }}
        />
        <p className="text-sm font-medium">Drag and drop photos here, or click to browse</p>
        <p className="text-xs text-[color:var(--color-text-secondary)]">
          Tagging who&apos;s in each photo comes in a later update.
        </p>
        {isUploading && <p className="text-sm text-[color:var(--color-text-secondary)]">Uploading…</p>}
      </div>

      {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}

      {/* Plain, unstyled list for Stage 1 — a real gallery grid is a later stage. */}
      <ul className="flex flex-col gap-2">
        {uploaded.length === 0 && (
          <p className="text-sm text-[color:var(--color-text-secondary)]">No photos uploaded yet.</p>
        )}
        {uploaded.map((photo) => (
          <li
            key={photo.id}
            className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-3 text-sm"
          >
            {photo.viewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photo.viewUrl}
                alt={photo.original_filename}
                className="h-16 w-16 shrink-0 rounded-[var(--radius-sm)] object-cover"
              />
            ) : (
              <div className="h-16 w-16 shrink-0 rounded-[var(--radius-sm)] bg-[color:var(--color-bg-surface-alt)]" />
            )}
            <div className="flex flex-col">
              <span>{photo.original_filename}</span>
              {photo.caption && (
                <span className="text-xs text-[color:var(--color-text-secondary)]">{photo.caption}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

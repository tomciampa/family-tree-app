"use client";

import { useMemo, useRef, useState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import { uploadPhoto } from "./actions";
import { PhotoLightbox } from "./photo-lightbox";

export type PhotoTag = {
  id: string;
  personId: string;
  personName: string;
  x: number;
  y: number;
};

export type PhotoRow = {
  id: string;
  storage_path: string;
  original_filename: string;
  caption: string | null;
  taken_at: string | null;
  created_at: string | null;
  viewUrl: string | null;
  tags: PhotoTag[];
};

type Person = Tables<"people">;

// Matches next.config.ts's experimental.serverActions.bodySizeLimit, same
// as documents-view.tsx's own check.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const TOO_LARGE_MESSAGE = "File too large — please keep uploads under 10MB.";

// Stage 2: adds the gallery person-filter and click-to-open tagging
// (PhotoLightbox) on top of Stage 1's plain upload+list. Still no real
// gallery grid layout — same unstyled list, just now clickable.
export function PhotosView({ photos, people }: { photos: PhotoRow[]; people: Person[] }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<PhotoRow[]>(photos);
  const [filterPersonId, setFilterPersonId] = useState<string>("");
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);
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
    // Stage 1 note still applies here: no signed URL for a just-uploaded
    // photo without a full reload (createSignedUrls happens server-side).
    window.location.reload();
  }

  function handleTagsChanged(photoId: string, tags: PhotoTag[]) {
    setItems((prev) => prev.map((p) => (p.id === photoId ? { ...p, tags } : p)));
  }

  const filteredItems = useMemo(
    () =>
      filterPersonId
        ? items.filter((p) => p.tags.some((t) => t.personId === filterPersonId))
        : items,
    [items, filterPersonId],
  );

  const openPhoto = items.find((p) => p.id === openPhotoId) ?? null;

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
          Click a photo below to tag who&apos;s in it.
        </p>
        {isUploading && <p className="text-sm text-[color:var(--color-text-secondary)]">Uploading…</p>}
      </div>

      {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}

      {items.length > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-[color:var(--color-text-secondary)]">Show:</span>
          <select
            value={filterPersonId}
            onChange={(e) => setFilterPersonId(e.target.value)}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-2 py-1 text-sm text-[color:var(--color-text-primary)]"
          >
            <option value="">All photos</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Plain, unstyled list for Stage 2 — a real gallery grid is a later stage. */}
      <ul className="flex flex-col gap-2">
        {filteredItems.length === 0 && (
          <p className="text-sm text-[color:var(--color-text-secondary)]">
            {items.length === 0 ? "No photos uploaded yet." : "No photos of this person yet."}
          </p>
        )}
        {filteredItems.map((photo) => (
          <li key={photo.id}>
            <button
              type="button"
              onClick={() => setOpenPhotoId(photo.id)}
              className="flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-3 text-left text-sm transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
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
                {photo.tags.length > 0 && (
                  <span className="text-xs text-[color:var(--color-text-tertiary)]">
                    {photo.tags.map((t) => t.personName).join(", ")}
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {openPhoto && (
        <PhotoLightbox
          photo={openPhoto}
          people={people}
          onClose={() => setOpenPhotoId(null)}
          onTagsChanged={handleTagsChanged}
        />
      )}
    </div>
  );
}

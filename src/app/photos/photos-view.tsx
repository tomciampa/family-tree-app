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
type SortBy = "created_at" | "taken_at";

// Matches next.config.ts's experimental.serverActions.bodySizeLimit, same
// as documents-view.tsx's own check.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const TOO_LARGE_MESSAGE = "File too large — please keep uploads under 10MB.";

// Stage 3: delete/caption/taken_at management, plus sort-by-date on top
// of Stage 2's tagging and person filter. Still no real gallery grid —
// same unstyled list, just now sortable/groupable.
export function PhotosView({ photos, people }: { photos: PhotoRow[]; people: Person[] }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<PhotoRow[]>(photos);
  const [filterPersonId, setFilterPersonId] = useState<string>("");
  const [sortBy, setSortBy] = useState<SortBy>("created_at");
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

  function handlePhotoUpdated(photoId: string, updates: { caption?: string | null; taken_at?: string | null }) {
    setItems((prev) => prev.map((p) => (p.id === photoId ? { ...p, ...updates } : p)));
  }

  function handlePhotoDeleted(photoId: string) {
    setItems((prev) => prev.filter((p) => p.id !== photoId));
    setOpenPhotoId(null);
  }

  const filteredItems = useMemo(
    () =>
      filterPersonId
        ? items.filter((p) => p.tags.some((t) => t.personId === filterPersonId))
        : items,
    [items, filterPersonId],
  );

  // Filtering and sorting are independent and always combine — the filter
  // narrows the set first, then whichever sort is active groups/orders
  // exactly that set. Sorting by taken_at splits into a chronologically
  // sorted "dated" group plus a separate "Undated" group at the end,
  // rather than interleaving unset dates at some arbitrary position
  // (taken_at is a plain "YYYY-MM-DD" string, so lexicographic comparison
  // is already correct chronological order — no Date parsing needed).
  // Sorting by upload date never has an "undated" case (created_at is
  // always set), so it's always a single flat group.
  const groups = useMemo((): { label: string | null; items: PhotoRow[] }[] => {
    if (sortBy === "created_at") {
      const sorted = [...filteredItems].sort((a, b) => {
        const at = a.created_at ?? "";
        const bt = b.created_at ?? "";
        return bt.localeCompare(at);
      });
      return [{ label: null, items: sorted }];
    }

    const dated = filteredItems
      .filter((p) => p.taken_at)
      .sort((a, b) => (b.taken_at as string).localeCompare(a.taken_at as string));
    const undated = filteredItems.filter((p) => !p.taken_at);

    const result: { label: string | null; items: PhotoRow[] }[] = [];
    if (dated.length > 0) result.push({ label: null, items: dated });
    if (undated.length > 0) result.push({ label: "Undated", items: undated });
    return result;
  }, [filteredItems, sortBy]);

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
        <div className="flex flex-wrap items-center gap-4">
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

          <label className="flex items-center gap-2 text-sm">
            <span className="text-[color:var(--color-text-secondary)]">Sort by:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-2 py-1 text-sm text-[color:var(--color-text-primary)]"
            >
              <option value="created_at">Upload date</option>
              <option value="taken_at">Date taken</option>
            </select>
          </label>
        </div>
      )}

      {/* Plain, unstyled list for Stage 3 — a real gallery grid is a later stage. */}
      {groups.length === 0 && (
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          {items.length === 0 ? "No photos uploaded yet." : "No photos of this person yet."}
        </p>
      )}
      {groups.map((group, i) => (
        <div key={group.label ?? `group-${i}`} className="flex flex-col gap-2">
          {group.label && (
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              {group.label}
            </h2>
          )}
          <ul className="flex flex-col gap-2">
            {group.items.map((photo) => (
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
                    {photo.taken_at && (
                      <span className="text-xs text-[color:var(--color-text-tertiary)]">{photo.taken_at}</span>
                    )}
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
        </div>
      ))}

      {openPhoto && (
        <PhotoLightbox
          photo={openPhoto}
          people={people}
          onClose={() => setOpenPhotoId(null)}
          onTagsChanged={handleTagsChanged}
          onPhotoUpdated={handlePhotoUpdated}
          onDeleted={handlePhotoDeleted}
        />
      )}
    </div>
  );
}

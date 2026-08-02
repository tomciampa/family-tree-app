"use client";

import { DeletePhotoButton } from "../../delete-photo-button";

export type ComparePhoto = {
  id: string;
  storage_path: string;
  original_filename: string;
  created_at: string | null;
  source: string;
  submitted_by_name: string | null;
  submitted_by_email: string | null;
  viewUrl: string | null;
};

// Deliberately minimal, per the feature spec: just enough context for a
// quick "yes, same photo, delete this one" decision — no zoom, no
// annotation, no other comparison tooling. Side by side on desktop,
// stacked on mobile (a plain responsive grid, not a custom breakpoint
// component).
function PhotoCard({
  photo,
  label,
  deleteAffordance,
}: {
  photo: ComparePhoto;
  label: string;
  deleteAffordance?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-4 shadow-[var(--shadow-1)]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-tertiary)]">
          {label}
        </span>
        {deleteAffordance}
      </div>
      {photo.viewUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo.viewUrl}
          alt={photo.original_filename}
          className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] object-contain"
        />
      )}
      <p className="truncate text-sm font-medium">{photo.original_filename}</p>
      <p className="text-xs text-[color:var(--color-text-secondary)]">
        Uploaded {photo.created_at ? new Date(photo.created_at).toLocaleDateString() : "unknown date"} ·{" "}
        {photo.source === "email" ? "via email" : "via website"}
      </p>
      {photo.source === "email" && (
        <p className="text-xs text-[color:var(--color-text-secondary)]">
          Submitted by {photo.submitted_by_name || photo.submitted_by_email || "unknown sender"}
        </p>
      )}
    </div>
  );
}

export function PhotoCompareView({
  original,
  candidate,
}: {
  original: ComparePhoto;
  candidate: ComparePhoto;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-sm font-medium">Possible duplicate photo</h1>
        <p className="text-xs text-[color:var(--color-text-secondary)]">
          These look identical. If they are, delete the newer one below.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PhotoCard photo={original} label="Original" />
        <PhotoCard
          photo={candidate}
          label="New (possible duplicate)"
          deleteAffordance={
            <DeletePhotoButton
              photoId={candidate.id}
              filename={candidate.original_filename}
              redirectTo="/photos"
            />
          }
        />
      </div>
    </div>
  );
}

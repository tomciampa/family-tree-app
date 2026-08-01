"use client";

import { useEffect, useState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { PersonSearch } from "@/components/person-search";
import { DeletePhotoButton } from "./delete-photo-button";
import { addPhotoTag, removePhotoTag, updatePhotoCaption, updatePhotoTakenAt } from "./actions";
import type { PhotoRow, PhotoTag } from "./photos-view";

type Person = Tables<"people">;
type PendingPin = { x: number; y: number } | null;

// A blocking modal, same structural pattern as tree/document-viewer-modal.tsx
// (this app's other "stop and look at the source" surface) — not a docked
// pane, closable via ✕/backdrop click.
//
// Click-to-tag: a plain onClick on the <img> works for both mouse clicks
// and touch taps (a real DOM click event is synthesized from a tap by
// every mainstream mobile browser — verified directly against a real
// touch-emulated viewport, not just assumed) — no separate onTouchStart
// handler needed. Coordinates are normalized to 0.0-1.0 against the
// image's own rendered size at click time, so a pin's stored position
// stays correct regardless of what size the photo is later displayed at.
export function PhotoLightbox({
  photo,
  people,
  personSummaries,
  onClose,
  onTagsChanged,
  onPhotoUpdated,
  onDeleted,
}: {
  photo: PhotoRow;
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  onClose: () => void;
  onTagsChanged: (photoId: string, tags: PhotoTag[]) => void;
  onPhotoUpdated: (photoId: string, updates: { caption?: string | null; taken_at?: string | null }) => void;
  onDeleted: (photoId: string) => void;
}) {
  const [pendingPin, setPendingPin] = useState<PendingPin>(null);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which pin's name/remove label is currently shown — hover on desktop,
  // tap-to-toggle on touch (no real :hover state there), same button
  // handles both since onClick fires for a tap regardless.
  const [activeTagId, setActiveTagId] = useState<string | null>(null);

  const [captionDraft, setCaptionDraft] = useState(photo.caption ?? "");
  const [isSavingCaption, setIsSavingCaption] = useState(false);
  const [isSavingDate, setIsSavingDate] = useState(false);

  // Shared by onBlur and every close path (✕, backdrop click, Escape) —
  // closing via anything other than tabbing/clicking away from the input
  // removes it from the DOM without reliably firing a blur first (verified
  // directly: Escape previously did nothing at all here, and even once
  // wired up, unmounting the input is not guaranteed to fire blur before
  // React finishes removing it), so a caption typed and then closed via
  // Escape/backdrop was silently lost — this makes the save happen
  // explicitly on every close, not just blur.
  async function saveCaptionIfChanged() {
    const trimmed = captionDraft.trim();
    if (trimmed === (photo.caption ?? "")) return; // no real change, skip the round trip
    setIsSavingCaption(true);
    const result = await updatePhotoCaption(photo.id, trimmed || null);
    setIsSavingCaption(false);
    if ("error" in result) {
      window.alert(result.error);
      return;
    }
    onPhotoUpdated(photo.id, { caption: trimmed || null });
  }

  async function handleRequestClose() {
    await saveCaptionIfChanged();
    onClose();
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleRequestClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captionDraft]);

  async function handleTakenAtChange(value: string) {
    setIsSavingDate(true);
    const result = await updatePhotoTakenAt(photo.id, value || null);
    setIsSavingDate(false);
    if ("error" in result) {
      window.alert(result.error);
      return;
    }
    onPhotoUpdated(photo.id, { taken_at: value || null });
  }

  function handleImageClick(e: React.MouseEvent<HTMLImageElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setPendingPin({ x, y });
    setSelectedPersonId(null);
    setError(null);
    setActiveTagId(null);
  }

  async function handleConfirmTag() {
    if (!pendingPin || !selectedPersonId) return;
    setIsSaving(true);
    setError(null);
    const result = await addPhotoTag(photo.id, selectedPersonId, pendingPin.x, pendingPin.y);
    setIsSaving(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    const person = people.find((p) => p.id === selectedPersonId);
    onTagsChanged(photo.id, [
      ...photo.tags,
      {
        id: result.id,
        personId: selectedPersonId,
        personName: person?.name ?? "",
        x: pendingPin.x,
        y: pendingPin.y,
      },
    ]);
    setPendingPin(null);
    setSelectedPersonId(null);
  }

  async function handleRemoveTag(tagId: string) {
    const result = await removePhotoTag(tagId);
    if ("error" in result) {
      window.alert(result.error);
      return;
    }
    onTagsChanged(
      photo.id,
      photo.tags.filter((t) => t.id !== tagId),
    );
    setActiveTagId(null);
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 p-6 sm:p-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleRequestClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)] shadow-[var(--shadow-4)]">
        <div className="flex items-start justify-between gap-4 border-b border-[color:var(--color-border)] px-6 py-4">
          <div>
            <h2 className="text-[length:var(--font-size-heading-3)] font-semibold">
              {photo.original_filename}
            </h2>
            <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">
              Tap anywhere on the photo to tag someone.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DeletePhotoButton
              photoId={photo.id}
              filename={photo.original_filename}
              onDeleted={() => onDeleted(photo.id)}
            />
            <button
              type="button"
              onClick={handleRequestClose}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
            >
              Close ✕
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="relative w-full">
            {photo.viewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photo.viewUrl}
                alt={photo.original_filename}
                onClick={handleImageClick}
                className="w-full cursor-crosshair select-none rounded-[var(--radius-sm)] border border-[color:var(--color-border)]"
              />
            ) : (
              <div className="flex h-64 items-center justify-center rounded-[var(--radius-sm)] bg-[color:var(--color-bg-surface-alt)] text-sm text-[color:var(--color-text-secondary)]">
                Image unavailable
              </div>
            )}

            {photo.tags.map((tag) => (
              <div key={tag.id}>
                <button
                  type="button"
                  data-testid="photo-tag-pin"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Always set (never toggle) — on a mouse, onMouseEnter
                    // below has already set this pin active by the time a
                    // click's mouseup fires, so a toggle here would
                    // immediately flip it back off right as the user
                    // clicks, before "Remove" is even reachable. Setting
                    // unconditionally is correct for both input types:
                    // touch has no hover to race against, so this is just
                    // "tap reveals" there.
                    setActiveTagId(tag.id);
                  }}
                  onMouseEnter={() => setActiveTagId(tag.id)}
                  onMouseLeave={() => setActiveTagId((id) => (id === tag.id ? null : id))}
                  style={{ left: `${tag.x * 100}%`, top: `${tag.y * 100}%` }}
                  className="absolute z-10 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-[color:var(--color-accent)] shadow-[var(--shadow-2)]"
                  aria-label={tag.personName}
                >
                  <span className="sr-only">{tag.personName}</span>
                </button>
                <div
                  style={{ left: `${tag.x * 100}%`, top: `${tag.y * 100}%` }}
                  className={`pointer-events-none absolute z-20 -translate-x-1/2 translate-y-2 whitespace-nowrap rounded-[var(--radius-xs)] bg-[color:var(--color-text-primary)] px-2 py-1 text-xs font-medium text-white transition-opacity duration-[var(--duration-base)] ${
                    activeTagId === tag.id ? "opacity-100" : "opacity-0"
                  }`}
                >
                  {tag.personName}
                  {activeTagId === tag.id && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveTag(tag.id);
                      }}
                      className="pointer-events-auto ml-2 underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}

            {pendingPin && (
              <div
                style={{ left: `${pendingPin.x * 100}%`, top: `${pendingPin.y * 100}%` }}
                className="absolute z-10 h-5 w-5 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full border-2 border-white bg-[color:var(--color-warning)] shadow-[var(--shadow-2)]"
              />
            )}
          </div>

          {pendingPin && (
            <div className="mt-4 flex flex-col gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface-alt)] p-3">
              <p className="text-sm font-medium">Who is this?</p>
              <PersonSearch
                people={people}
                personSummaries={personSummaries}
                selectedId={selectedPersonId}
                onSelect={setSelectedPersonId}
                placeholder="Search for a name…"
              />
              {error && <p className="text-xs text-[color:var(--color-error)]">{error}</p>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleConfirmTag}
                  disabled={!selectedPersonId || isSaving}
                  className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
                >
                  {isSaving ? "Saving…" : "Tag this person"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPendingPin(null);
                    setSelectedPersonId(null);
                    setError(null);
                  }}
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {photo.tags.length > 0 && !pendingPin && (
            <p className="mt-3 text-xs text-[color:var(--color-text-secondary)]">
              Tagged: {photo.tags.map((t) => t.personName).join(", ")} — tap a pin to remove.
            </p>
          )}

          <div className="mt-4 flex flex-col gap-3 border-t border-[color:var(--color-border-subtle)] pt-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                Caption {isSavingCaption && "(saving…)"}
              </span>
              <input
                type="text"
                value={captionDraft}
                onChange={(e) => setCaptionDraft(e.target.value)}
                onBlur={saveCaptionIfChanged}
                placeholder="Add a caption…"
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                Taken {isSavingDate && "(saving…)"}
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={photo.taken_at ?? ""}
                  onChange={(e) => handleTakenAtChange(e.target.value)}
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
                />
                {photo.taken_at && (
                  <button
                    type="button"
                    onClick={() => handleTakenAtChange("")}
                    className="text-xs text-[color:var(--color-text-secondary)] underline underline-offset-2 hover:text-[color:var(--color-text-primary)]"
                  >
                    Clear
                  </button>
                )}
              </div>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

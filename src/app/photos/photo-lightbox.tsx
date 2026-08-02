"use client";

import { useEffect, useState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { PersonSearch } from "@/components/person-search";
import { DeletePhotoButton } from "./delete-photo-button";
import { addPhotoTag, removePhotoTag, updatePhotoCaption, updatePhotoTakenAt } from "./actions";
import type { PhotoRow, PhotoTag } from "./photos-view";

type Person = Tables<"people">;
// A pin the user has dropped this session but not yet committed via
// Save — personId starts null (just dropped, nobody assigned yet) and
// is set locally as the user picks a name. Nothing here ever touches the
// DB until Save is clicked; see handleSavePendingTags. localId is a
// client-only identifier (never sent anywhere) so multiple pending pins
// can coexist and be addressed individually before any of them has a
// real photo_tags id.
type PendingTag = { localId: string; x: number; y: number; personId: string | null };

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
//
// Tagging is batch/save-based, not per-pin: dropping a pin and picking a
// person only updates local pendingTags state (see PendingTag above) —
// nothing is written until the user clicks Save, which commits every
// pending pin that has a person assigned in one go and silently discards
// any that don't (no error, no warning — a pin with nobody assigned was
// never a real tag). This replaced an earlier per-pin "Tag this person"
// design where dropping a second pin before confirming the first
// silently lost the first selection entirely, with no way to recover it.
// Closing the lightbox (Escape/backdrop/✕) without saving discards every
// pending tag for free — they only ever live in this component's local
// state, so unmounting it is already a correct, complete discard with no
// extra code needed. That's deliberately independent of the caption's
// own save-on-close behavior below (saveCaptionIfChanged), which stays
// eager/immediate — two different behaviors for two different kinds of
// draft, coexisting in the same close handler without touching each
// other's state at all.
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
  const [pendingTags, setPendingTags] = useState<PendingTag[]>([]);
  // Which pending pin's "Who is this?" panel is currently open — at most
  // one at a time, same single-panel-at-a-time pattern the old per-pin
  // flow already used, just now addressing one of possibly several
  // pending pins instead of the one-and-only pendingPin.
  const [activePendingId, setActivePendingId] = useState<string | null>(null);
  const [isSavingBatch, setIsSavingBatch] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Which *saved* pin's name/remove label is currently shown — hover on
  // desktop, tap-to-toggle on touch (no real :hover state there), same
  // button handles both since onClick fires for a tap regardless.
  // Entirely separate from activePendingId (saved tags vs. pending ones
  // are two different concepts with two different interactions — a
  // saved tag reveals a Remove link; a pending tag reveals the
  // who-is-this picker).
  const [activeTagId, setActiveTagId] = useState<string | null>(null);

  const [captionDraft, setCaptionDraft] = useState(photo.caption ?? "");
  const [isSavingCaption, setIsSavingCaption] = useState(false);
  const [isSavingDate, setIsSavingDate] = useState(false);

  const activePendingTag = pendingTags.find((t) => t.localId === activePendingId) ?? null;

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
    // No equivalent "save pending tags" call here on purpose — see the
    // component-level comment above. Pending tags are pure local state;
    // onClose() below unmounts this component (the parent clears
    // openPhotoId), which discards them for free. Never confirmed via
    // Save, so discarding here is correct, not a bug.
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
    const localId = crypto.randomUUID();
    // Appends rather than replaces — dropping a second pin no longer
    // discards whatever was already pending on the first one (the bug
    // this redesign fixes). The new pin becomes the one being edited;
    // any earlier pending pin(s) just sit quietly, still pending.
    setPendingTags((prev) => [...prev, { localId, x, y, personId: null }]);
    setActivePendingId(localId);
    setSaveError(null);
    setActiveTagId(null);
  }

  function handleAssignPendingPerson(localId: string, personId: string | null) {
    setPendingTags((prev) => prev.map((t) => (t.localId === localId ? { ...t, personId } : t)));
  }

  function handleDiscardPendingTag(localId: string) {
    setPendingTags((prev) => prev.filter((t) => t.localId !== localId));
    setActivePendingId((id) => (id === localId ? null : id));
  }

  // Commits every pending pin that has a person assigned, in one batch;
  // any pin still unassigned is silently dropped — never saved, no
  // error, no warning, by design (confirmed decision, not an oversight —
  // a pin with nobody picked was never a real tag to begin with). A pin
  // that genuinely fails to save (a real server error, not "nobody
  // assigned") stays pending afterward instead of being discarded, so
  // the user can see the error and retry rather than silently losing it.
  async function handleSavePendingTags() {
    const assignable = pendingTags.filter((t) => t.personId);
    if (assignable.length === 0) {
      setPendingTags([]);
      setActivePendingId(null);
      return;
    }

    setIsSavingBatch(true);
    setSaveError(null);
    const newTags: PhotoTag[] = [];
    const failedLocalIds = new Set<string>();
    for (const tag of assignable) {
      const result = await addPhotoTag(photo.id, tag.personId!, tag.x, tag.y);
      if ("error" in result) {
        setSaveError(result.error);
        failedLocalIds.add(tag.localId);
        continue;
      }
      const person = people.find((p) => p.id === tag.personId);
      newTags.push({
        id: result.id,
        personId: tag.personId!,
        personName: person?.name ?? "",
        x: tag.x,
        y: tag.y,
      });
    }
    setIsSavingBatch(false);
    if (newTags.length > 0) {
      onTagsChanged(photo.id, [...photo.tags, ...newTags]);
    }
    setPendingTags((prev) => prev.filter((t) => failedLocalIds.has(t.localId)));
    setActivePendingId(null);
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
              // A single hoverable wrapper around BOTH the pin and its
              // label/Remove link — not two independently-hover-tracked
              // elements with a gap between them. That was a real,
              // confirmed-live bug (not just hard to find): the pin's own
              // hover area is a tiny 20x20px circle, and the label sits
              // just below/beside it, so moving the mouse from the pin
              // toward "Remove" left the pin's hitbox (firing
              // onMouseLeave, unmounting the conditionally-rendered
              // Remove button) before the cursor ever reached it —
              // confirmed via a real Playwright test stepping the mouse
              // from the pin toward Remove and watching it disappear by
              // the second step, every time. mouseenter/mouseleave fire
              // based on the actual DOM element the cursor is over, not
              // an ancestor's own layout box — but that only helps if the
              // label stays hit-testable throughout the transition. The
              // first attempt at this fix kept the label's pointer-events
              // conditional on activeTagId (none while "hidden"), which
              // reintroduced the exact same bug one level up: the instant
              // the cursor crossed the small visual gap between the pin's
              // bottom edge and the label's top edge, activeTagId briefly
              // went null, the label immediately became pointer-events:
              // none, and — now genuinely unhoverable — could never
              // re-fire the wrapper's mouseenter to recover, even once
              // the cursor reached exactly where the label was rendered.
              // Confirmed via the same stepped-mouse-move test: still
              // failing at every step, including ones squarely inside the
              // label's own bounding box. The label's pointer-events must
              // stay auto unconditionally so it's always a valid
              // hover-continuation target — only the Remove *button*
              // inside it is still gated on activeTagId, so an inactive,
              // invisible label still doesn't add any visible click
              // target, just a small always-hoverable strip right where
              // the pin already is.
              <div
                key={tag.id}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${tag.x * 100}%`, top: `${tag.y * 100}%` }}
                onMouseEnter={() => setActiveTagId(tag.id)}
                onMouseLeave={() => setActiveTagId((id) => (id === tag.id ? null : id))}
              >
                <button
                  type="button"
                  data-testid="photo-tag-pin"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Always set (never toggle) — on a mouse, onMouseEnter
                    // above has already set this pin active by the time a
                    // click's mouseup fires, so a toggle here would
                    // immediately flip it back off right as the user
                    // clicks, before "Remove" is even reachable. Setting
                    // unconditionally is correct for both input types:
                    // touch has no hover to race against, so this is just
                    // "tap reveals" there.
                    setActiveTagId(tag.id);
                  }}
                  className="relative z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-[color:var(--color-accent)] shadow-[var(--shadow-2)]"
                  aria-label={tag.personName}
                >
                  <span className="sr-only">{tag.personName}</span>
                </button>
                <div
                  className={`pointer-events-auto absolute left-1/2 top-full z-20 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-xs)] bg-[color:var(--color-text-primary)] px-2 py-1 text-xs font-medium text-white transition-opacity duration-[var(--duration-base)] ${
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
                      className="ml-2 underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}

            {pendingTags.map((tag) => (
              <button
                key={tag.localId}
                type="button"
                data-testid="photo-pending-pin"
                onClick={(e) => {
                  e.stopPropagation();
                  setActivePendingId(tag.localId);
                }}
                style={{ left: `${tag.x * 100}%`, top: `${tag.y * 100}%` }}
                // Pulses only while nobody's assigned yet — a quiet visual
                // cue that this pin still needs attention before Save,
                // distinct from an already-assigned-but-unsaved pin
                // (steady) and a saved tag (accent color, not warning).
                className={`absolute z-10 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[color:var(--color-warning)] shadow-[var(--shadow-2)] ${
                  tag.personId ? "" : "animate-pulse"
                }`}
                aria-label={
                  tag.personId
                    ? (people.find((p) => p.id === tag.personId)?.name ?? "Pending tag")
                    : "Pending tag — no one assigned yet"
                }
              />
            ))}
          </div>

          {activePendingTag && (
            <div className="mt-4 flex flex-col gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface-alt)] p-3">
              <p className="text-sm font-medium">Who is this?</p>
              <PersonSearch
                people={people}
                personSummaries={personSummaries}
                selectedId={activePendingTag.personId}
                onSelect={(personId) => handleAssignPendingPerson(activePendingTag.localId, personId)}
                placeholder="Search for a name…"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setActivePendingId(null)}
                  className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)]"
                >
                  Done
                </button>
                <button
                  type="button"
                  onClick={() => handleDiscardPendingTag(activePendingTag.localId)}
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
                >
                  Remove this pin
                </button>
              </div>
            </div>
          )}

          {pendingTags.length > 0 && (
            <div className="mt-4 flex flex-col gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface-alt)] p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-[color:var(--color-text-secondary)]">
                {pendingTags.filter((t) => t.personId).length} of {pendingTags.length} pending tag
                {pendingTags.length === 1 ? "" : "s"} ready to save
                {pendingTags.some((t) => !t.personId) && " — pins with no one assigned will be discarded"}.
              </p>
              <button
                type="button"
                onClick={handleSavePendingTags}
                disabled={isSavingBatch}
                className="shrink-0 rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-1.5 text-xs font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
              >
                {isSavingBatch ? "Saving…" : "Save"}
              </button>
            </div>
          )}
          {saveError && <p className="mt-2 text-xs text-[color:var(--color-error)]">{saveError}</p>}

          {photo.tags.length > 0 && !activePendingTag && (
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

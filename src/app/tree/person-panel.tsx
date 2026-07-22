"use client";

import { useMemo, useState, useTransition } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import {
  addParents,
  addSibling,
  addSpouseAndChild,
  addAnotherChild,
  addFact,
  addStory,
  extractFactFromDocument,
  type PersonRef,
} from "./actions";
import { FACT_SOURCE_TYPES } from "./constants";
import { FactList } from "./fact-list";
import { AnecdoteList } from "./anecdote-list";
import { DocumentList, type PersonDocument } from "./document-list";
import { PersonSearch } from "@/components/person-search";
import type { PersonSummary } from "@/lib/family";
import {
  findSuggestedConnections,
  type SuggestedConnection,
} from "@/lib/suggested-connections";

type Person = Tables<"people">;
type Fact = Tables<"facts">;
type Anecdote = Tables<"anecdotes">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;
type Marriage = { unionId: string; spouseName: string | null };

const inputClassName =
  "rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]";
const actionButtonClassName =
  "rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-sm transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]";
const saveButtonClassName =
  "rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-2 text-sm transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50";
const cancelButtonClassName =
  "rounded-[var(--radius-sm)] px-3 py-2 text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]";
const fieldLabelClassName = "flex flex-col gap-1 text-sm text-[color:var(--color-text-secondary)]";
const errorClassName = "text-sm text-[color:var(--color-error)]";

type ActiveForm =
  | null
  | "add-parents"
  | "add-sibling"
  | "add-spouse-child"
  | "add-fact"
  | "add-story"
  | { kind: "add-child"; unionId: string; spouseName: string | null };

// Every "add relative" form offers a choice per person slot: type a new
// name (creates a brand-new person, the original behavior) or search for
// and pick an already-existing one instead — most often someone added via
// document matching who has no union/union_children row yet, so today
// they only show up in the tree's "not yet connected" list with no way to
// actually place them.
type PersonFieldState =
  | { mode: "new"; name: string }
  | { mode: "existing"; personId: string | null };

const emptyNewField: PersonFieldState = { mode: "new", name: "" };

function toPersonRef(state: PersonFieldState): PersonRef | null {
  if (state.mode === "new") return { mode: "new", name: state.name };
  return state.personId ? { mode: "existing", personId: state.personId } : null;
}

function PersonFieldPicker({
  label,
  state,
  onChange,
  people,
  personSummaries,
  required,
  autoFocus,
}: {
  label: string;
  state: PersonFieldState;
  onChange: (state: PersonFieldState) => void;
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-sm text-[color:var(--color-text-secondary)]">
      {label}
      <div className="flex gap-4 text-xs">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={state.mode === "new"}
            onChange={() => onChange({ ...emptyNewField })}
          />
          Create new
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={state.mode === "existing"}
            onChange={() => onChange({ mode: "existing", personId: null })}
          />
          Search for existing person
        </label>
      </div>
      {state.mode === "new" ? (
        <input
          value={state.name}
          onChange={(e) => onChange({ mode: "new", name: e.target.value })}
          autoFocus={autoFocus}
          required={required}
          className={inputClassName}
        />
      ) : (
        <PersonSearch
          people={people}
          personSummaries={personSummaries}
          selectedId={state.personId}
          onSelect={(personId) => onChange({ mode: "existing", personId })}
        />
      )}
    </div>
  );
}

// The one-click alternative to manually searching — sits above each
// "Add ___" form's normal PersonFieldPicker(s), which stay as the fallback
// for anyone the resolver can't place.
function SuggestedConnectionBanner({
  suggestions,
  relationLabel,
  isPending,
  onConfirm,
}: {
  suggestions: SuggestedConnection[];
  relationLabel: string;
  isPending: boolean;
  onConfirm: () => void;
}) {
  if (suggestions.length === 0) return null;
  const names = suggestions.map((s) => s.personName).join(" & ");
  const label = suggestions.length > 1 ? `${relationLabel}s` : relationLabel;
  return (
    <div className="rounded-[var(--radius-sm)] border border-[color:var(--color-accent)] bg-[color:var(--color-accent-subtle)] p-3 text-sm">
      <p>
        <span className="font-medium">{names}</span> — connect as {label}?
      </p>
      <button
        type="button"
        onClick={onConfirm}
        disabled={isPending}
        className="mt-2 rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
      >
        {isPending ? "Connecting…" : "Connect"}
      </button>
    </div>
  );
}

export function PersonPanel({
  person,
  hasParents,
  marriages,
  facts,
  allFacts,
  anecdotes,
  documents,
  people,
  unions,
  unionChildren,
  personSummaries,
  onClose,
}: {
  person: Person;
  hasParents: boolean;
  marriages: Marriage[];
  facts: Fact[];
  allFacts: Fact[];
  anecdotes: Anecdote[];
  documents: PersonDocument[];
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  personSummaries: Record<string, PersonSummary>;
  onClose: () => void;
}) {
  const [activeForm, setActiveForm] = useState<ActiveForm>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [parent1, setParent1] = useState<PersonFieldState>(emptyNewField);
  const [parent2, setParent2] = useState<PersonFieldState>(emptyNewField);
  const [sibling, setSibling] = useState<PersonFieldState>(emptyNewField);
  const [spouse, setSpouse] = useState<PersonFieldState>(emptyNewField);
  const [spouseChild, setSpouseChild] = useState<PersonFieldState>(emptyNewField);
  const [anotherChild, setAnotherChild] = useState<PersonFieldState>(emptyNewField);
  // A document can document more than one standard field at once (e.g. a
  // death certificate documenting death date, death place, AND cause of
  // death) — an array of rows so extraction can populate several at once
  // for review, instead of forcing everything through one field/value
  // pair. Manual entry (no document) still works the same way, just with
  // one row by default.
  const [factRows, setFactRows] = useState<{ field: string; value: string }[]>(
    [{ field: "", value: "" }],
  );
  const [factSourceType, setFactSourceType] = useState<string>(
    FACT_SOURCE_TYPES[0],
  );
  const [factSourceRef, setFactSourceRef] = useState("");
  const [factDocumentId, setFactDocumentId] = useState<string | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [storyText, setStoryText] = useState("");
  const [whoToldIt, setWhoToldIt] = useState("");

  // Can't be your own parent/sibling/spouse/child.
  const otherPeople = people.filter((p) => p.id !== person.id);

  // Loose people whose own stored relation (e.g. Hugo's "maternal
  // grandfather of Maxine") resolves, by walking the real connected tree
  // from that named anchor, to exactly this person — see
  // findSuggestedConnections for how. Computed for all three buckets
  // unconditionally (cheap — a handful of loose people at most) rather
  // than only for whichever form is open, so switching between forms
  // never shows a stale suggestion. Sibling/spouse will always be empty
  // right now since no relation types map to those buckets yet — that's
  // expected, not a bug; the wiring is ready for when they do.
  const parentSuggestions = useMemo(
    () => findSuggestedConnections(person.id, "parent", people, unions, unionChildren, allFacts),
    [person.id, people, unions, unionChildren, allFacts],
  );
  const siblingSuggestions = useMemo(
    () => findSuggestedConnections(person.id, "sibling", people, unions, unionChildren, allFacts),
    [person.id, people, unions, unionChildren, allFacts],
  );
  const spouseSuggestions = useMemo(
    () => findSuggestedConnections(person.id, "spouse", people, unions, unionChildren, allFacts),
    [person.id, people, unions, unionChildren, allFacts],
  );

  function closeForm() {
    setActiveForm(null);
    setError(null);
    setParent1(emptyNewField);
    setParent2(emptyNewField);
    setSibling(emptyNewField);
    setSpouse(emptyNewField);
    setSpouseChild(emptyNewField);
    setAnotherChild(emptyNewField);
    setFactRows([{ field: "", value: "" }]);
    setFactSourceType(FACT_SOURCE_TYPES[0]);
    setFactSourceRef("");
    setFactDocumentId(null);
    setIsExtracting(false);
    setStoryText("");
    setWhoToldIt("");
  }

  async function handleDocumentUpload(file: File) {
    setIsExtracting(true);
    setError(null);
    const formData = new FormData();
    formData.set("file", file);
    const result = await extractFactFromDocument(person.id, formData);
    setIsExtracting(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setFactRows(
      result.facts.length > 0 ? result.facts : [{ field: "", value: "" }],
    );
    setFactSourceType(result.sourceType);
    setFactSourceRef(result.sourceRef);
    setFactDocumentId(result.documentId);
  }

  function handleClose() {
    closeForm();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/40 p-6 sm:p-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="w-full max-w-md rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)] shadow-[var(--shadow-3)]">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
            {person.name}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="shrink-0 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
          >
            Close ✕
          </button>
        </div>

        <FactList facts={facts} theme="neutral" />

        <AnecdoteList anecdotes={anecdotes} theme="neutral" />

        <DocumentList documents={documents} theme="neutral" />

        {activeForm === null && (
          <div className="flex flex-col gap-2">
            <p className="text-[length:var(--font-size-caption)] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              Add to this person&apos;s record
            </p>
            <div className="flex flex-wrap gap-2">
              {!hasParents && (
                <button
                  type="button"
                  onClick={() => setActiveForm("add-parents")}
                  className={actionButtonClassName}
                >
                  + Add parents
                </button>
              )}
              {hasParents && (
                <button
                  type="button"
                  onClick={() => setActiveForm("add-sibling")}
                  className={actionButtonClassName}
                >
                  + Add sibling
                </button>
              )}
              <button
                type="button"
                onClick={() => setActiveForm("add-spouse-child")}
                className={actionButtonClassName}
              >
                + Add spouse &amp; child
              </button>
              {marriages.map((marriage) => (
                <button
                  key={marriage.unionId}
                  type="button"
                  onClick={() =>
                    setActiveForm({
                      kind: "add-child",
                      unionId: marriage.unionId,
                      spouseName: marriage.spouseName,
                    })
                  }
                  className={actionButtonClassName}
                >
                  + Add another child
                  {marriage.spouseName ? ` (with ${marriage.spouseName})` : ""}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setActiveForm("add-fact")}
                className={actionButtonClassName}
              >
                + Add fact
              </button>
              <button
                type="button"
                onClick={() => setActiveForm("add-story")}
                className={actionButtonClassName}
              >
                + Add story
              </button>
            </div>
          </div>
        )}

        {activeForm === "add-parents" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const parent1Ref = toPersonRef(parent1);
              const parent2Ref = toPersonRef(parent2);
              if (!parent1Ref) {
                setError("Select an existing person, or enter a name, for the first parent.");
                return;
              }
              startTransition(async () => {
                const result = await addParents(person.id, parent1Ref, parent2Ref);
                if ("error" in result) {
                  setError(result.error);
                  return;
                }
                handleClose();
              });
            }}
            className="flex flex-col gap-3"
          >
            <SuggestedConnectionBanner
              suggestions={parentSuggestions}
              relationLabel="parent"
              isPending={isPending}
              onConfirm={() => {
                setError(null);
                startTransition(async () => {
                  const result = await addParents(
                    person.id,
                    { mode: "existing", personId: parentSuggestions[0].personId },
                    parentSuggestions[1]
                      ? { mode: "existing", personId: parentSuggestions[1].personId }
                      : null,
                  );
                  if ("error" in result) {
                    setError(result.error);
                    return;
                  }
                  handleClose();
                });
              }}
            />
            <PersonFieldPicker
              label="First parent"
              state={parent1}
              onChange={setParent1}
              people={otherPeople}
              personSummaries={personSummaries}
              required
              autoFocus
            />
            <PersonFieldPicker
              label="Second parent (leave blank if unknown)"
              state={parent2}
              onChange={setParent2}
              people={otherPeople}
              personSummaries={personSummaries}
            />

            {error && <p className={errorClassName}>{error}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className={saveButtonClassName}
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className={cancelButtonClassName}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {activeForm === "add-sibling" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const siblingRef = toPersonRef(sibling);
              if (!siblingRef) {
                setError("Select an existing person, or enter a name.");
                return;
              }
              startTransition(async () => {
                const first = await addSibling(person.id, siblingRef);
                const result =
                  "warning" in first
                    ? window.confirm(first.warning)
                      ? await addSibling(person.id, siblingRef, true)
                      : null
                    : first;
                if (!result) return;
                if ("error" in result) {
                  setError(result.error);
                  return;
                }
                handleClose();
              });
            }}
            className="flex flex-col gap-3"
          >
            <SuggestedConnectionBanner
              suggestions={siblingSuggestions}
              relationLabel="sibling"
              isPending={isPending}
              onConfirm={() => {
                setError(null);
                startTransition(async () => {
                  for (const suggestion of siblingSuggestions) {
                    const ref: PersonRef = { mode: "existing", personId: suggestion.personId };
                    const first = await addSibling(person.id, ref);
                    const result =
                      "warning" in first
                        ? window.confirm(first.warning)
                          ? await addSibling(person.id, ref, true)
                          : null
                        : first;
                    if (!result) continue;
                    if ("error" in result) {
                      setError(result.error);
                      return;
                    }
                  }
                  handleClose();
                });
              }}
            />
            <PersonFieldPicker
              label="Sibling"
              state={sibling}
              onChange={setSibling}
              people={otherPeople}
              personSummaries={personSummaries}
              required
              autoFocus
            />

            {error && <p className={errorClassName}>{error}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className={saveButtonClassName}
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className={cancelButtonClassName}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {activeForm === "add-spouse-child" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const spouseRef = toPersonRef(spouse);
              if (!spouseRef) {
                setError("Select an existing person, or enter a name, for the spouse.");
                return;
              }
              const childRef = toPersonRef(spouseChild);
              startTransition(async () => {
                const first = await addSpouseAndChild(person.id, spouseRef, childRef);
                const result =
                  "warning" in first
                    ? window.confirm(first.warning)
                      ? await addSpouseAndChild(person.id, spouseRef, childRef, true)
                      : null
                    : first;
                if (!result) return;
                if ("error" in result) {
                  setError(result.error);
                  return;
                }
                handleClose();
              });
            }}
            className="flex flex-col gap-3"
          >
            <SuggestedConnectionBanner
              suggestions={spouseSuggestions.slice(0, 1)}
              relationLabel="spouse"
              isPending={isPending}
              onConfirm={() => {
                setError(null);
                const ref: PersonRef = {
                  mode: "existing",
                  personId: spouseSuggestions[0].personId,
                };
                startTransition(async () => {
                  const first = await addSpouseAndChild(person.id, ref, null);
                  const result =
                    "warning" in first
                      ? window.confirm(first.warning)
                        ? await addSpouseAndChild(person.id, ref, null, true)
                        : null
                      : first;
                  if (!result) return;
                  if ("error" in result) {
                    setError(result.error);
                    return;
                  }
                  handleClose();
                });
              }}
            />
            <PersonFieldPicker
              label="Spouse"
              state={spouse}
              onChange={setSpouse}
              people={otherPeople}
              personSummaries={personSummaries}
              required
              autoFocus
            />
            <PersonFieldPicker
              label="First child (leave blank to add later)"
              state={spouseChild}
              onChange={setSpouseChild}
              people={otherPeople}
              personSummaries={personSummaries}
            />

            {error && <p className={errorClassName}>{error}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className={saveButtonClassName}
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className={cancelButtonClassName}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {activeForm !== null &&
          typeof activeForm === "object" &&
          activeForm.kind === "add-child" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const unionId = activeForm.unionId;
                const childRef = toPersonRef(anotherChild);
                if (!childRef) {
                  setError("Select an existing person, or enter a name.");
                  return;
                }
                startTransition(async () => {
                  const first = await addAnotherChild(unionId, childRef);
                  const result =
                    "warning" in first
                      ? window.confirm(first.warning)
                        ? await addAnotherChild(unionId, childRef, true)
                        : null
                      : first;
                  if (!result) return;
                  if ("error" in result) {
                    setError(result.error);
                    return;
                  }
                  handleClose();
                });
              }}
              className="flex flex-col gap-3"
            >
              <PersonFieldPicker
                label={`Child${activeForm.spouseName ? ` (with ${activeForm.spouseName})` : ""}`}
                state={anotherChild}
                onChange={setAnotherChild}
                people={otherPeople}
                personSummaries={personSummaries}
                required
                autoFocus
              />

              {error && <p className={errorClassName}>{error}</p>}

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={isPending}
                  className={saveButtonClassName}
                >
                  {isPending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={closeForm}
                  className={cancelButtonClassName}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

        {activeForm === "add-fact" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const rows = factRows
                .map((r) => ({ field: r.field.trim(), value: r.value.trim() }))
                .filter((r) => r.field && r.value);
              if (rows.length === 0) {
                setError("At least one field and value is required.");
                return;
              }
              startTransition(async () => {
                for (const row of rows) {
                  const result = await addFact(
                    person.id,
                    row.field,
                    row.value,
                    factSourceType,
                    factSourceRef,
                    factDocumentId,
                  );
                  if (result?.error) {
                    setError(result.error);
                    return;
                  }
                }
                handleClose();
              });
            }}
            className="flex flex-col gap-3"
          >
            <label className={fieldLabelClassName}>
              Upload a document (PDF) to auto-fill the fields below
              <input
                type="file"
                accept="application/pdf"
                disabled={isExtracting}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleDocumentUpload(file);
                }}
                className={inputClassName}
              />
            </label>
            {isExtracting && (
              <p className="text-sm text-[color:var(--color-text-secondary)]">Reading document…</p>
            )}
            {factDocumentId && !isExtracting && (
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                Extracted from document — review the fields below before saving.
              </p>
            )}
            <div className="flex flex-col gap-3">
              {factRows.map((row, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[color:var(--color-border-subtle)] p-2"
                >
                  <div className="flex items-start gap-2">
                    <label className="flex flex-1 flex-col gap-1 text-sm text-[color:var(--color-text-secondary)]">
                      Field (e.g. Birth Date, Occupation, Immigration)
                      <input
                        value={row.field}
                        onChange={(e) =>
                          setFactRows((rows) =>
                            rows.map((r, idx) =>
                              idx === i ? { ...r, field: e.target.value } : r,
                            ),
                          )
                        }
                        autoFocus={i === 0}
                        className={inputClassName}
                      />
                    </label>
                    {factRows.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setFactRows((rows) => rows.filter((_, idx) => idx !== i))
                        }
                        className="mt-5 text-sm text-[color:var(--color-text-tertiary)] transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-secondary)]"
                        aria-label="Remove this field"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <label className={fieldLabelClassName}>
                    Value
                    <input
                      value={row.value}
                      onChange={(e) =>
                        setFactRows((rows) =>
                          rows.map((r, idx) =>
                            idx === i ? { ...r, value: e.target.value } : r,
                          ),
                        )
                      }
                      className={inputClassName}
                    />
                  </label>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setFactRows((rows) => [...rows, { field: "", value: "" }])
                }
                className="self-start text-sm text-[color:var(--color-text-secondary)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
              >
                + Add another field
              </button>
            </div>
            <label className={fieldLabelClassName}>
              Source type
              <select
                value={factSourceType}
                onChange={(e) => setFactSourceType(e.target.value)}
                className={inputClassName}
              >
                {FACT_SOURCE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label className={fieldLabelClassName}>
              Source reference (who told you, or which document)
              <input
                value={factSourceRef}
                onChange={(e) => setFactSourceRef(e.target.value)}
                className={inputClassName}
              />
            </label>

            {error && <p className={errorClassName}>{error}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className={saveButtonClassName}
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className={cancelButtonClassName}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {activeForm === "add-story" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const result = await addStory(person.id, storyText, whoToldIt);
                if (result?.error) {
                  setError(result.error);
                  return;
                }
                handleClose();
              });
            }}
            className="flex flex-col gap-3"
          >
            <label className={fieldLabelClassName}>
              Story or memory
              <textarea
                value={storyText}
                onChange={(e) => setStoryText(e.target.value)}
                autoFocus
                required
                rows={4}
                className={inputClassName}
              />
            </label>
            <label className={fieldLabelClassName}>
              Who told you this?
              <input
                value={whoToldIt}
                onChange={(e) => setWhoToldIt(e.target.value)}
                className={inputClassName}
              />
            </label>

            {error && <p className={errorClassName}>{error}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className={saveButtonClassName}
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className={cancelButtonClassName}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

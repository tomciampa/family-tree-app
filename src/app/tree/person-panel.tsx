"use client";

import { useState, useTransition } from "react";
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

type Person = Tables<"people">;
type Fact = Tables<"facts">;
type Anecdote = Tables<"anecdotes">;
type Marriage = { unionId: string; spouseName: string | null };

const inputClassName =
  "rounded border border-gray-300 px-3 py-2 text-sm text-black dark:border-gray-700 dark:bg-gray-800 dark:text-white";
const actionButtonClassName =
  "rounded border border-gray-300 px-3 py-1.5 text-sm hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600";

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
    <div className="flex flex-col gap-1.5 text-sm text-gray-500">
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

export function PersonPanel({
  person,
  hasParents,
  marriages,
  facts,
  anecdotes,
  documents,
  people,
  personSummaries,
  onClose,
}: {
  person: Person;
  hasParents: boolean;
  marriages: Marriage[];
  facts: Fact[];
  anecdotes: Anecdote[];
  documents: PersonDocument[];
  people: Person[];
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
  const [factField, setFactField] = useState("");
  const [factValue, setFactValue] = useState("");
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

  function closeForm() {
    setActiveForm(null);
    setError(null);
    setParent1(emptyNewField);
    setParent2(emptyNewField);
    setSibling(emptyNewField);
    setSpouse(emptyNewField);
    setSpouseChild(emptyNewField);
    setAnotherChild(emptyNewField);
    setFactField("");
    setFactValue("");
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
    setFactField(result.field);
    setFactValue(result.value);
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
      <div className="w-full max-w-md rounded border border-gray-300 bg-white p-6 dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">{person.name}</h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          >
            Close ✕
          </button>
        </div>

        <FactList facts={facts} />

        <AnecdoteList anecdotes={anecdotes} />

        <DocumentList documents={documents} />

        {activeForm === null && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
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

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className="rounded border border-gray-300 px-3 py-2 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="rounded px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
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
            <PersonFieldPicker
              label="Sibling"
              state={sibling}
              onChange={setSibling}
              people={otherPeople}
              personSummaries={personSummaries}
              required
              autoFocus
            />

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className="rounded border border-gray-300 px-3 py-2 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="rounded px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
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

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className="rounded border border-gray-300 px-3 py-2 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="rounded px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
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

              {error && <p className="text-sm text-red-500">{error}</p>}

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded border border-gray-300 px-3 py-2 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
                >
                  {isPending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={closeForm}
                  className="rounded px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
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
              startTransition(async () => {
                const result = await addFact(
                  person.id,
                  factField,
                  factValue,
                  factSourceType,
                  factSourceRef,
                  factDocumentId,
                );
                if (result?.error) {
                  setError(result.error);
                  return;
                }
                handleClose();
              });
            }}
            className="flex flex-col gap-3"
          >
            <label className="flex flex-col gap-1 text-sm text-gray-500">
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
              <p className="text-sm text-gray-500">Reading document…</p>
            )}
            {factDocumentId && !isExtracting && (
              <p className="text-sm text-gray-500">
                Extracted from document — review the fields below before saving.
              </p>
            )}
            <label className="flex flex-col gap-1 text-sm text-gray-500">
              Field (e.g. Birth, Occupation, Immigration)
              <input
                value={factField}
                onChange={(e) => setFactField(e.target.value)}
                autoFocus
                required
                className={inputClassName}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-gray-500">
              Value
              <input
                value={factValue}
                onChange={(e) => setFactValue(e.target.value)}
                required
                className={inputClassName}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-gray-500">
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
            <label className="flex flex-col gap-1 text-sm text-gray-500">
              Source reference (who told you, or which document)
              <input
                value={factSourceRef}
                onChange={(e) => setFactSourceRef(e.target.value)}
                className={inputClassName}
              />
            </label>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className="rounded border border-gray-300 px-3 py-2 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="rounded px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
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
            <label className="flex flex-col gap-1 text-sm text-gray-500">
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
            <label className="flex flex-col gap-1 text-sm text-gray-500">
              Who told you this?
              <input
                value={whoToldIt}
                onChange={(e) => setWhoToldIt(e.target.value)}
                className={inputClassName}
              />
            </label>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isPending}
                className="rounded border border-gray-300 px-3 py-2 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="rounded px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
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

"use client";

import { useState, useTransition } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import { addParents } from "./actions";

type Person = Tables<"people">;

const inputClassName =
  "rounded border border-gray-300 px-3 py-2 text-sm text-black dark:border-gray-700 dark:bg-gray-800 dark:text-white";
const actionButtonClassName =
  "rounded border border-gray-300 px-3 py-1.5 text-sm hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600";

export function PersonPanel({
  person,
  hasParents,
  onClose,
}: {
  person: Person;
  hasParents: boolean;
  onClose: () => void;
}) {
  const [activeForm, setActiveForm] = useState<null | "add-parents">(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [parent1, setParent1] = useState("");
  const [parent2, setParent2] = useState("");

  function closeForm() {
    setActiveForm(null);
    setError(null);
    setParent1("");
    setParent2("");
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
            </div>
          </div>
        )}

        {activeForm === "add-parents" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const result = await addParents(person.id, parent1, parent2);
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
              First parent&apos;s name
              <input
                value={parent1}
                onChange={(e) => setParent1(e.target.value)}
                autoFocus
                required
                className={inputClassName}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-gray-500">
              Second parent&apos;s name (leave blank if unknown)
              <input
                value={parent2}
                onChange={(e) => setParent2(e.target.value)}
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

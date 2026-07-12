"use client";

import { useState, useTransition } from "react";
import { addFirstPerson } from "./actions";

export function AddFirstPersonForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!open) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-gray-500">No people yet.</p>
        <button
          onClick={() => setOpen(true)}
          className="rounded border border-gray-300 px-4 py-2 text-sm hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600"
        >
          + Add first person
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await addFirstPerson(name);
          if ("error" in result) {
            setError(result.error);
            return;
          }
          setName("");
          setError(null);
          setOpen(false);
        });
      }}
      className="mx-auto flex w-full max-w-xs flex-col gap-3 py-16"
    >
      <label className="flex flex-col gap-1 text-sm text-gray-500">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          required
          className="rounded border border-gray-300 px-3 py-2 text-sm text-black dark:border-gray-700 dark:bg-gray-900 dark:text-white"
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
          onClick={() => setOpen(false)}
          className="rounded px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

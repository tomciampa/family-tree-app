"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createFamily } from "@/app/actions";

// Shared by the home page's zero-family state (a brand-new signup with no
// invite code) and Settings' "create a new family" section — same form,
// same action, just different surrounding copy per `submitLabel`. Always
// navigates to /tree on success in either case: create_family() also
// makes the new family active, so /tree is genuinely the new, correctly-
// empty tree for it, not a stale view of whichever family was active
// before.
export function CreateFamilyForm({ submitLabel = "Create family" }: { submitLabel?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createFamily(name);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.push("/tree");
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <input
        type="text"
        required
        placeholder="e.g. The Ciampa Family"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
      />
      {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}
      <div>
        <button
          type="submit"
          disabled={isPending || !name.trim()}
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
        >
          {isPending ? "Creating…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

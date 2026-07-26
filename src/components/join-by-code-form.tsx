"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Deliberately does no validation of its own beyond "non-empty" — the
// actual code check (not_found/used/expired/valid) already lives in
// /join/[code]/page.tsx via the get_invite_preview RPC, with its own
// well-designed error copy. This form's only job is getting a pasted code
// or full invite URL to that route, not re-implementing its validation.
export function JoinByCodeForm() {
  const router = useRouter();
  const [code, setCode] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;

    // Someone may paste the whole link (e.g. from a text message) instead
    // of just the code — accept either.
    const afterJoin = trimmed.split("/join/")[1];
    const finalCode = afterJoin ? afterJoin.split(/[/?#]/)[0] : trimmed;

    router.push(`/join/${encodeURIComponent(finalCode)}`);
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-3">
      <input
        type="text"
        required
        placeholder="Paste your invite code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-3 py-2 text-center text-sm text-[color:var(--color-text-primary)]"
      />
      <button
        type="submit"
        disabled={!code.trim()}
        className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
      >
        Continue
      </button>
    </form>
  );
}

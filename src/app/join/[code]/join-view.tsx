"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { redeemInvite } from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  not_found: "This invite link doesn't match any active invite anymore.",
  used: "This invite was just used — it only works once.",
  expired: "This invite expired before you confirmed.",
  not_authenticated: "You need to be signed in to accept an invite.",
};

// The page.tsx server component already confirmed this code is valid and
// the visitor is authenticated before rendering this — but redeemInvite
// re-validates server-side regardless (via the redeem_family_invite RPC),
// since time can pass between page load and clicking Join (the code could
// expire, or someone else could use it first), so every state this
// component can land in is handled here too, not just the happy path.
export function JoinConfirm({ code, familyName }: { code: string; familyName: string }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<
    { kind: "error"; message: string } | { kind: "joined"; familyName: string } | null
  >(null);

  function handleConfirm() {
    startTransition(async () => {
      const outcome = await redeemInvite(code);
      if ("error" in outcome) {
        setResult({ kind: "error", message: outcome.error });
        return;
      }
      if (outcome.status === "joined") {
        setResult({ kind: "joined", familyName: outcome.familyName });
        return;
      }
      setResult({
        kind: "error",
        message: ERROR_MESSAGES[outcome.status] ?? "This invite can't be used right now.",
      });
    });
  }

  if (result?.kind === "joined") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[color:var(--color-success-subtle-fg)]">
          You&apos;re in! You&apos;ve joined {result.familyName}.
        </p>
        <Link
          href="/tree"
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)]"
        >
          Go to the family tree
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {result?.kind === "error" && (
        <p className="text-sm text-[color:var(--color-error)]">{result.message}</p>
      )}
      <button
        type="button"
        onClick={handleConfirm}
        disabled={isPending}
        className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
      >
        {isPending ? "Joining…" : `Join ${familyName}`}
      </button>
    </div>
  );
}

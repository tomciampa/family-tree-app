"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Same card shell as /login and /join/[code] — one consistent frame for
// every pre-authentication (or, here, mid-authentication) page in the app.
function ResetCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-8 text-center shadow-[var(--shadow-2)]">
        {children}
      </div>
    </main>
  );
}

export function ResetPasswordForm() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (password !== confirmPassword) {
      setError("Those passwords don't match.");
      setStatus("error");
      return;
    }

    setStatus("saving");
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(error.message);
      setStatus("error");
      return;
    }

    // Full navigation, not router.push — same reasoning as /login's own
    // post-signInWithPassword redirect: the session is already active from
    // the recovery code exchange, this just takes the now-fully-signed-in
    // visitor into the app rather than stranding them on this page.
    window.location.assign("/");
  }

  return (
    <ResetCard>
      <h1 className="text-[length:var(--font-size-heading-3)] font-semibold">
        Set a new password
      </h1>
      <p className="text-sm text-[color:var(--color-text-secondary)]">
        Choose a new password for your account.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 text-left">
        <input
          type="password"
          required
          minLength={6}
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
        />
        <input
          type="password"
          required
          minLength={6}
          placeholder="Confirm new password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
        />
        <p className="text-xs text-[color:var(--color-text-tertiary)]">At least 6 characters.</p>
        <button
          type="submit"
          disabled={status === "saving"}
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
        >
          {status === "saving" ? "Saving…" : "Set new password"}
        </button>
        {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}
      </form>
    </ResetCard>
  );
}

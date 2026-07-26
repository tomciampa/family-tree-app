"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Same card shell as /join/[code] — one consistent frame for every
// pre-authentication page in the app.
function LoginCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-8 text-center shadow-[var(--shadow-2)]">
        {children}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

// Split out so useSearchParams (which forces client-side rendering of
// everything up to the nearest Suspense boundary) only affects this piece
// rather than the whole page — per Next's own recommendation.
function LoginForm() {
  // ?next=/join/<code> — set when arriving here from the invite flow (see
  // /join/[code]/join-view.tsx), so the magic link's own redirect can
  // carry it through /auth/callback (which already reads `next`) back to
  // the exact invite the visitor started from, rather than dropping them
  // on the home page after login.
  const searchParams = useSearchParams();
  const next = searchParams.get("next");

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    const callbackUrl = new URL("/auth/callback", window.location.origin);
    if (next) callbackUrl.searchParams.set("next", next);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: callbackUrl.toString(),
      },
    });

    if (error) {
      setError(error.message);
      setStatus("error");
    } else {
      setStatus("sent");
    }
  }

  if (status === "sent") {
    return (
      <LoginCard>
        <h1 className="text-[length:var(--font-size-heading-3)] font-semibold">
          Check your email
        </h1>
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          We sent a secure sign-in link to <strong>{email}</strong>. Open it on this device to
          continue.
        </p>
      </LoginCard>
    );
  }

  return (
    <LoginCard>
      <h1 className="text-[length:var(--font-size-heading-3)] font-semibold">Sign in</h1>
      <p className="text-sm text-[color:var(--color-text-secondary)]">
        Enter your email and we&apos;ll send you a secure sign-in link — no password needed.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 text-left">
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
        />
        <button
          type="submit"
          disabled={status === "sending"}
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
        >
          {status === "sending" ? "Sending…" : "Send magic link"}
        </button>
        {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}
      </form>

      {!next && (
        <p className="text-xs text-[color:var(--color-text-tertiary)]">
          Got an invite link from a family member? Open that link directly instead of signing in
          here — it&apos;ll bring you right back to sign in and land you in the right family tree.
        </p>
      )}
    </LoginCard>
  );
}

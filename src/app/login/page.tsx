"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

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
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-2xl font-semibold">Check your email</h1>
        <p className="text-gray-500">
          We sent a magic link to <strong>{email}</strong>. Click it to sign
          in.
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-3"
      >
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-transparent"
        />
        <button
          type="submit"
          disabled={status === "sending"}
          className="rounded bg-black px-3 py-2 text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {status === "sending" ? "Sending…" : "Send magic link"}
        </button>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </form>
    </main>
  );
}

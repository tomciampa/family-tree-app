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

// Password sign-in/sign-up are now the primary path; magic link remains as
// a secondary option (toggled via `mode`), reusing the exact same
// signInWithOtp call the app already relied on exclusively before this.
type Mode = "signin" | "signup" | "magiclink" | "forgot";

// Split out so useSearchParams (which forces client-side rendering of
// everything up to the nearest Suspense boundary) only affects this piece
// rather than the whole page — per Next's own recommendation.
function LoginForm() {
  // ?next=/join/<code> — set when arriving here from the invite flow (see
  // /join/[code]/join-view.tsx), so the magic link's own redirect can
  // carry it through /auth/callback (which already reads `next`) back to
  // the exact invite the visitor started from, rather than dropping them
  // on the home page after login. The password-signup confirmation email
  // goes through the exact same /auth/callback `code` exchange as magic
  // link, so it carries `next` the same way — see callbackUrl() below.
  // Password sign-in has no email round trip, so `next` is applied with a
  // direct client-side redirect instead once signInWithPassword succeeds.
  const searchParams = useSearchParams();
  const next = searchParams.get("next");

  // ?mode=signup — set by the landing page's "Start your own family tree"
  // card, so that click lands directly on the signup form instead of the
  // default sign-in form plus one extra click.
  const initialMode = searchParams.get("mode") === "signup" ? "signup" : "signin";
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  // Surfaces /auth/callback's own `?error=auth_failed` redirect (a link that
  // was already used, expired, or otherwise failed to exchange) — previously
  // silently dropped the visitor on a plain sign-in form with no indication
  // anything had gone wrong, which was confusing now that this page's
  // default view looks like a normal password form rather than "we'll email
  // you a link".
  const [error, setError] = useState<string | null>(
    searchParams.get("error") === "auth_failed"
      ? "That link didn't work — it may have expired or already been used. Please request a new one below."
      : null,
  );

  function switchMode(nextMode: Mode) {
    setMode(nextMode);
    setStatus("idle");
    setError(null);
  }

  function callbackUrl() {
    const url = new URL("/auth/callback", window.location.origin);
    if (next) url.searchParams.set("next", next);
    return url.toString();
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setStatus("error");
      return;
    }

    // Full navigation (not router.push) so the fresh session cookie the
    // browser client just wrote is what the server/middleware sees on the
    // very next request — same reasoning as /auth/callback's own
    // server-side redirect after exchanging a code.
    window.location.assign(next ?? "/");
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: callbackUrl() },
    });

    if (error) {
      setError(error.message);
      setStatus("error");
      return;
    }

    // Supabase's signUp() deliberately doesn't error for an email that's
    // already registered and confirmed — it silently no-ops (no new account,
    // no email sent) to avoid leaking which emails exist, returning a
    // same-shaped but fake user with an empty `identities` array as the only
    // signal. A genuinely new signup always has at least one real identity
    // here. Surfacing that distinction is safe specifically in this
    // already-trying-to-sign-up context (the visitor already knows and typed
    // this exact email), unlike forgotPassword's anti-enumeration message
    // below, which must stay generic since a visitor there could be probing
    // an email that isn't theirs.
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      setError("You already have an account with this email — try signing in instead.");
      setStatus("error");
      return;
    }

    setStatus("sent");
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    const supabase = createClient();
    const url = new URL("/auth/callback", window.location.origin);
    url.searchParams.set("next", "/reset-password");
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: url.toString() });

    // Always the same message regardless of whether the email matched an
    // account, or whether the call itself errored — never let this screen
    // reveal which emails are registered (same anti-enumeration reasoning
    // as signUp's own built-in behavior, investigated earlier this stage).
    setStatus("sent");
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: callbackUrl() },
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
          {mode === "signup" ? (
            <>
              We sent a confirmation link to <strong>{email}</strong>. Open it on this device to
              finish creating your account.
            </>
          ) : mode === "forgot" ? (
            <>If an account exists for {email}, we&apos;ve sent a reset link. Open it on this device to continue.</>
          ) : (
            <>
              We sent a secure sign-in link to <strong>{email}</strong>. Open it on this device to
              continue.
            </>
          )}
        </p>
      </LoginCard>
    );
  }

  if (mode === "magiclink") {
    return (
      <LoginCard>
        <h1 className="text-[length:var(--font-size-heading-3)] font-semibold">Sign in</h1>
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          Enter your email and we&apos;ll send you a secure sign-in link — no password needed.
        </p>

        <form onSubmit={handleMagicLink} className="flex flex-col gap-3 text-left">
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

        <button
          type="button"
          onClick={() => switchMode("signin")}
          className="text-xs text-[color:var(--color-text-tertiary)] underline underline-offset-2"
        >
          or sign in with a password instead
        </button>
      </LoginCard>
    );
  }

  if (mode === "forgot") {
    return (
      <LoginCard>
        <h1 className="text-[length:var(--font-size-heading-3)] font-semibold">Reset your password</h1>
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          Enter your email and we&apos;ll send you a link to set a new password.
        </p>

        <form onSubmit={handleForgotPassword} className="flex flex-col gap-3 text-left">
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
            {status === "sending" ? "Sending…" : "Send reset link"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => switchMode("signin")}
          className="text-xs text-[color:var(--color-text-tertiary)] underline underline-offset-2"
        >
          Back to sign in
        </button>
      </LoginCard>
    );
  }

  const isSignup = mode === "signup";

  return (
    <LoginCard>
      <h1 className="text-[length:var(--font-size-heading-3)] font-semibold">
        {isSignup ? "Create an account" : "Sign in"}
      </h1>
      <p className="text-sm text-[color:var(--color-text-secondary)]">
        {isSignup
          ? "Enter your email and choose a password to get started."
          : "Enter your email and password to sign in."}
      </p>

      <form
        onSubmit={isSignup ? handleSignUp : handleSignIn}
        className="flex flex-col gap-3 text-left"
      >
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
        />
        <input
          type="password"
          required
          minLength={6}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-3 py-2 text-sm text-[color:var(--color-text-primary)]"
        />
        {isSignup && (
          <p className="text-xs text-[color:var(--color-text-tertiary)]">At least 6 characters.</p>
        )}
        {!isSignup && (
          <button
            type="button"
            onClick={() => switchMode("forgot")}
            className="self-end text-xs text-[color:var(--color-text-tertiary)] underline underline-offset-2"
          >
            Forgot your password?
          </button>
        )}
        <button
          type="submit"
          disabled={status === "sending"}
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)] disabled:opacity-50"
        >
          {status === "sending"
            ? isSignup
              ? "Creating account…"
              : "Signing in…"
            : isSignup
              ? "Create account"
              : "Sign in"}
        </button>
        {error && <p className="text-sm text-[color:var(--color-error)]">{error}</p>}
      </form>

      <button
        type="button"
        onClick={() => switchMode(isSignup ? "signin" : "signup")}
        className="text-xs text-[color:var(--color-text-tertiary)] underline underline-offset-2"
      >
        {isSignup ? "Already have an account? Sign in" : "New here? Create an account"}
      </button>

      <button
        type="button"
        onClick={() => switchMode("magiclink")}
        className="text-xs text-[color:var(--color-text-tertiary)] underline underline-offset-2"
      >
        or email me a login link instead
      </button>

      {!next && !isSignup && (
        <p className="text-xs text-[color:var(--color-text-tertiary)]">
          Got an invite link from a family member? Open that link directly instead of signing in
          here — it&apos;ll bring you right back to sign in and land you in the right family tree.
        </p>
      )}
    </LoginCard>
  );
}

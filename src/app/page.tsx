import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getPendingReview } from "@/lib/pending-review";
import { CreateFamilyForm } from "@/components/create-family-form";
import { signOut } from "./actions";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Public landing page for anonymous visitors — someone arriving with no
  // context (not a specific /join/[code] link, which bypasses this
  // entirely since that route never redirects here). Two equal-weight
  // CTAs: Log In (the existing /login flow, which already handles both
  // sign-in and signup via its own mode toggle) and Explore a Demo (a
  // stubbed-out /demo route — no real content yet, that's a separate next
  // step). Copy is placeholder-simple by design, reusing the same
  // headline/subtext this page already had, pending real marketing copy.
  if (!user) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center gap-10 p-8 text-center font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
        <div className="flex flex-col gap-3">
          <h1 className="text-[length:var(--font-size-display)] leading-[var(--line-height-display)] font-semibold">
            Your family&apos;s story, all in one place
          </h1>
          <p className="text-[length:var(--font-size-body)] text-[color:var(--color-text-secondary)]">
            Build a family tree, record memories, and keep the documents and stories that
            matter — together.
          </p>
        </div>

        <div className="flex w-full flex-col gap-4 sm:w-auto sm:flex-row sm:justify-center">
          <Link
            href="/login"
            className="rounded-[var(--radius-full)] bg-[color:var(--color-accent)] px-8 py-4 text-[length:var(--font-size-body)] font-semibold text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)]"
          >
            Log In
          </Link>
          <Link
            href="/demo"
            className="rounded-[var(--radius-full)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] px-8 py-4 text-[length:var(--font-size-body)] font-semibold text-[color:var(--color-text-primary)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
          >
            Explore a Demo
          </Link>
        </div>
      </main>
    );
  }

  // The natural landing point for Stage 2's "reachable from the login/
  // signup area" requirement: a brand-new signup with no invite code has
  // no family_members row at all, and every other page (tree, documents,
  // interviews, settings, familysearch) calls getFamilyId() unguarded and
  // throws for exactly this case. Rather than widen that fix across every
  // page, this is the one place — the actual post-login landing page —
  // that checks first and offers a way forward instead of a dead end.
  const { count: membershipCount } = await supabase
    .from("family_members")
    .select("family_id", { count: "exact", head: true })
    .eq("user_id", user.id);

  if (!membershipCount) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col items-center justify-center gap-6 p-8 text-center font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
        <div className="flex flex-col gap-2">
          <h1 className="text-[length:var(--font-size-heading-2)] leading-[var(--line-height-heading-2)] font-semibold">
            Welcome
          </h1>
          <p className="text-sm text-[color:var(--color-text-secondary)]">
            You&apos;re not part of a family tree yet. If someone sent you an invite link,
            open that instead — otherwise, start your own.
          </p>
        </div>
        <div className="w-full rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 text-left shadow-[var(--shadow-2)]">
          <CreateFamilyForm submitLabel="Create my family tree" />
        </div>
        <form action={signOut}>
          <button
            type="submit"
            className="text-sm text-[color:var(--color-text-secondary)] underline underline-offset-2"
          >
            Sign out
          </button>
        </form>
      </main>
    );
  }

  const pending = await getPendingReview(supabase);
  const totalPending = pending.documents.length + pending.interviews.length;

  const primaryLinks = [
    {
      href: "/tree",
      icon: "🌳",
      label: "View Family Tree",
      description: "See how everyone is connected, generation by generation.",
    },
    {
      href: "/interviews",
      icon: "🎙️",
      label: "Record a Memory",
      description: "Interview a relative and save their stories in their own words.",
    },
    {
      href: "/documents",
      icon: "📄",
      label: "Upload a Document",
      description: "Add certificates, letters, and photos to build the family record.",
    },
  ];

  // Secondary/account-level links, shared between the always-expanded
  // mobile list and the collapsed-by-default desktop sidebar below — one
  // place to add a link, not two.
  const secondaryLinks = [
    { href: "/documents", icon: "📁", label: "Documents library" },
    { href: "/familysearch", icon: "🔍", label: "FamilySearch" },
    { href: "/settings", icon: "⚙️", label: "Settings" },
  ];

  return (
    <>
      {/* Desktop/tablet: a Supabase-style icon rail, fixed to the
          viewport edge and collapsed by default. Hover OR keyboard focus
          (focus-within, for anyone tabbing through without a mouse)
          expands it to show labels — as an overlay via z-10, not by
          pushing page content, so the reserved sm:pl-24 on <main> below
          only ever needs to account for the permanent collapsed width. */}
      <nav
        aria-label="Account"
        className="group fixed inset-y-0 left-0 z-10 hidden w-16 flex-col overflow-hidden border-r border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] py-6 transition-[width] duration-[var(--duration-base)] ease-[var(--ease-standard)] hover:w-56 focus-within:w-56 sm:flex"
      >
        {secondaryLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="flex items-center gap-3 px-3 py-3 text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] hover:text-[color:var(--color-text-primary)]"
          >
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center text-xl"
              aria-hidden="true"
            >
              {link.icon}
            </span>
            <span className="whitespace-nowrap opacity-0 transition-opacity duration-[var(--duration-base)] group-hover:opacity-100 group-focus-within:opacity-100">
              {link.label}
            </span>
          </Link>
        ))}
        <form action={signOut}>
          <button
            type="submit"
            className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] hover:text-[color:var(--color-text-primary)]"
          >
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center text-xl"
              aria-hidden="true"
            >
              🚪
            </span>
            <span className="whitespace-nowrap opacity-0 transition-opacity duration-[var(--duration-base)] group-hover:opacity-100 group-focus-within:opacity-100">
              Sign out
            </span>
          </button>
        </form>
      </nav>

      <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-10 p-8 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)] sm:p-12 sm:pl-24">
        <div className="flex flex-col gap-2">
          <h1 className="text-[length:var(--font-size-heading-1)] leading-[var(--line-height-heading-1)] font-semibold">
            Welcome back
          </h1>
          <p className="text-[color:var(--color-text-secondary)]">
            Signed in as <strong>{user.email}</strong>
          </p>
          <p className="mt-2 text-[length:var(--font-size-body)] text-[color:var(--color-text-secondary)]">
            New here? Start by recording a memory, or explore your family tree.
          </p>
        </div>

        <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 shadow-[var(--shadow-1)]">
          <h2 className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
            Tasks pending your review
          </h2>
          {totalPending === 0 ? (
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              You&apos;re all caught up — nothing waiting on a decision right
              now.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {pending.documents.map((d) => (
                <li key={`doc-${d.id}`}>
                  <Link
                    href={`/documents/${d.id}`}
                    className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
                  >
                    <span className="truncate">
                      📄 {d.filename ?? "Untitled document"}
                    </span>
                    <span className="shrink-0 rounded-[var(--radius-xs)] bg-[color:var(--color-warning-subtle-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-warning-subtle-fg)]">
                      {d.unresolvedCount} of {d.totalCount} to review
                    </span>
                  </Link>
                </li>
              ))}
              {pending.interviews.map((i) => (
                <li key={`interview-${i.id}`}>
                  <Link
                    href={`/interviews/${i.id}`}
                    className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
                  >
                    <span className="truncate">
                      🎙️ Interview with {i.intervieweeName}
                    </span>
                    <span className="shrink-0 rounded-[var(--radius-xs)] bg-[color:var(--color-warning-subtle-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-warning-subtle-fg)]">
                      {i.unresolvedCount} item{i.unresolvedCount === 1 ? "" : "s"} to
                      review
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {primaryLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex min-h-[200px] flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 text-center shadow-[var(--shadow-2)] transition-all duration-[var(--duration-base)] hover:-translate-y-0.5 hover:shadow-[var(--shadow-3)]"
            >
              <span className="text-4xl" aria-hidden="true">
                {link.icon}
              </span>
              <span className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
                {link.label}
              </span>
              <span className="text-[length:var(--font-size-body-small)] text-[color:var(--color-text-secondary)]">
                {link.description}
              </span>
            </Link>
          ))}
        </div>

        {/* Mobile: hover doesn't exist on touch, so there's no way to
            reveal a collapsed rail's labels — always-expanded as a plain
            list instead, same links/icons/order as the desktop sidebar. */}
        <div className="flex flex-col items-start gap-1 border-t border-[color:var(--color-border-subtle)] pt-6 sm:hidden">
          {secondaryLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex items-center gap-3 rounded-[var(--radius-sm)] px-2 py-2 text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] hover:text-[color:var(--color-text-primary)]"
            >
              <span className="text-lg" aria-hidden="true">
                {link.icon}
              </span>
              {link.label}
            </Link>
          ))}
          <form action={signOut}>
            <button
              type="submit"
              className="flex items-center gap-3 rounded-[var(--radius-sm)] px-2 py-2 text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] hover:text-[color:var(--color-text-primary)]"
            >
              <span className="text-lg" aria-hidden="true">
                🚪
              </span>
              Sign out
            </button>
          </form>
        </div>
      </main>
    </>
  );
}

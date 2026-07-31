import Link from "next/link";

// Stub only — routed to from the logged-out landing page's "Explore a
// Demo" CTA (src/app/page.tsx). Building the actual demo tree content is
// a separate next step; this just needs to exist and render something
// on-brand so the link isn't a dead end.
export default function DemoPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center gap-6 p-8 text-center font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex flex-col gap-3">
        <h1 className="text-[length:var(--font-size-heading-1)] leading-[var(--line-height-heading-1)] font-semibold">
          Demo coming soon
        </h1>
        <p className="text-[length:var(--font-size-body)] text-[color:var(--color-text-secondary)]">
          We&apos;re putting together a sample family tree so you can see how it all works
          before signing up.
        </p>
      </div>
      <Link
        href="/"
        className="text-sm text-[color:var(--color-accent)] underline underline-offset-2"
      >
        ← Back home
      </Link>
    </main>
  );
}

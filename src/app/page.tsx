import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./actions";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

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

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-10 p-8 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)] sm:p-12">
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

      <div className="flex flex-col items-start gap-3 border-t border-[color:var(--color-border-subtle)] pt-6">
        <Link
          href="/documents"
          className="text-sm text-[color:var(--color-accent)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-accent-hover)]"
        >
          Documents library
        </Link>
        <Link
          href="/familysearch"
          className="text-sm text-[color:var(--color-accent)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-accent-hover)]"
        >
          FamilySearch
        </Link>
        <span className="text-sm text-[color:var(--color-text-tertiary)]">
          Settings <span className="italic">(coming soon)</span>
        </span>
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-2 text-sm transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}

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

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <h1 className="text-[length:var(--font-size-heading-1)] leading-[var(--line-height-heading-1)] font-semibold">
        Hello, world 👋
      </h1>
      <p className="text-[color:var(--color-text-secondary)]">
        Signed in as <strong>{user.email}</strong>
      </p>
      <div className="flex gap-4">
        <Link
          href="/people"
          className="text-[color:var(--color-accent)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-accent-hover)]"
        >
          View people
        </Link>
        <Link
          href="/tree"
          className="text-[color:var(--color-accent)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-accent-hover)]"
        >
          Family tree
        </Link>
        <Link
          href="/documents"
          className="text-[color:var(--color-accent)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-accent-hover)]"
        >
          Documents
        </Link>
        <Link
          href="/interviews"
          className="text-[color:var(--color-accent)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-accent-hover)]"
        >
          Record a memory
        </Link>
        <Link
          href="/familysearch"
          className="text-[color:var(--color-accent)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-accent-hover)]"
        >
          FamilySearch
        </Link>
      </div>
      <form action={signOut}>
        <button
          type="submit"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-2 transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}

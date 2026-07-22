import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId, buildPersonSummaries } from "@/lib/family";
import { SettingsView } from "./settings-view";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const familyId = await getFamilyId();

  const [
    { data: people, error: peopleError },
    { data: unions, error: unionsError },
    { data: unionChildren, error: unionChildrenError },
    { data: membership, error: membershipError },
  ] = await Promise.all([
    supabase.from("people").select("*").order("created_at"),
    supabase.from("unions").select("*"),
    supabase.from("union_children").select("*"),
    supabase
      .from("family_members")
      .select("linked_person_id")
      .eq("family_id", familyId)
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  const error = peopleError ?? unionsError ?? unionChildrenError ?? membershipError;

  const personSummaries = Object.fromEntries(
    buildPersonSummaries(people ?? [], unions ?? [], unionChildren ?? []),
  );

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 p-8 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <h1 className="text-[length:var(--font-size-heading-2)] leading-[var(--line-height-heading-2)] font-semibold">
          Settings
        </h1>
        <Link
          href="/"
          className="text-sm text-[color:var(--color-text-secondary)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
        >
          Home
        </Link>
      </div>

      {error && <p className="text-sm text-[color:var(--color-error)]">{error.message}</p>}

      {!error && (
        <SettingsView
          people={people ?? []}
          personSummaries={personSummaries}
          linkedPersonId={membership?.linked_person_id ?? null}
        />
      )}
    </main>
  );
}

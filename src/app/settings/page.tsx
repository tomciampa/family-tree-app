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
    { data: memberships, error: membershipsError },
    { data: family, error: familyError },
  ] = await Promise.all([
    supabase.from("people").select("*").order("created_at"),
    supabase.from("unions").select("*"),
    supabase.from("union_children").select("*"),
    supabase
      .from("family_members")
      .select("linked_person_id, interview_voice_uri, narration_enabled")
      .eq("family_id", familyId)
      .eq("user_id", user.id)
      .maybeSingle(),
    // Every family this account belongs to, not just the active one — the
    // switcher only renders when there's more than one, so a
    // single-family user (still the common case) sees no change here.
    supabase
      .from("family_members")
      .select("family_id, is_active, families(name)")
      .eq("user_id", user.id)
      .order("joined_at", { ascending: true }),
    // email_upload_token for the active family's own upload address —
    // see EmailUploadSettings in settings-view.tsx.
    supabase.from("families").select("email_upload_token").eq("id", familyId).single(),
  ]);

  const error =
    peopleError ?? unionsError ?? unionChildrenError ?? membershipError ?? membershipsError ?? familyError;

  const personSummaries = Object.fromEntries(
    buildPersonSummaries(people ?? [], unions ?? [], unionChildren ?? []),
  );

  const families = (memberships ?? []).map((m) => ({
    id: m.family_id,
    name: m.families?.name ?? "Untitled family",
    isActive: m.is_active,
  }));

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
          interviewVoiceURI={membership?.interview_voice_uri ?? null}
          narrationEnabled={membership?.narration_enabled ?? true}
          families={families}
          emailUploadToken={family?.email_upload_token ?? null}
        />
      )}
    </main>
  );
}

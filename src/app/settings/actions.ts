"use server";

import { randomBytes } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

// personId: null means "I'm not in the tree yet" — explicitly clears the
// link rather than leaving it ambiguous with "never set". Upserts on
// (family_id, user_id), the table's actual primary key, so this works
// whether or not a family_members row already exists for this user.
export async function setLinkedPerson(
  personId: string | null,
): Promise<{ error: string } | { ok: true }> {
  const { supabase, user } = await requireUser();
  const familyId = await getFamilyId();

  const { error } = await supabase
    .from("family_members")
    .upsert(
      { family_id: familyId, user_id: user.id, linked_person_id: personId },
      { onConflict: "family_id,user_id" },
    );
  if (error) return { error: error.message };

  revalidatePath("/settings");
  revalidatePath("/tree");
  return { ok: true };
}

// voiceURI: null means "no preference" — explicitly clears any saved
// choice rather than leaving it ambiguous with "never set", same as
// setLinkedPerson's personId handling above. Interview narration falls
// back to the app's own improved default (see lib/speech-voices.ts) either
// way, so clearing this never breaks narration.
export async function setInterviewVoice(
  voiceURI: string | null,
): Promise<{ error: string } | { ok: true }> {
  const { supabase, user } = await requireUser();
  const familyId = await getFamilyId();

  const { error } = await supabase
    .from("family_members")
    .upsert(
      { family_id: familyId, user_id: user.id, interview_voice_uri: voiceURI },
      { onConflict: "family_id,user_id" },
    );
  if (error) return { error: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

// Whether interview prompts get read aloud at all. Defaults to true (see
// the narration_enabled column's own default) so existing behavior is
// preserved for everyone until they explicitly opt out.
export async function setNarrationEnabled(
  enabled: boolean,
): Promise<{ error: string } | { ok: true }> {
  const { supabase, user } = await requireUser();
  const familyId = await getFamilyId();

  const { error } = await supabase
    .from("family_members")
    .upsert(
      { family_id: familyId, user_id: user.id, narration_enabled: enabled },
      { onConflict: "family_id,user_id" },
    );
  if (error) return { error: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

// The code itself is generated here, in application code, rather than in
// SQL — same convention as other unguessable-identifier generation
// elsewhere in the app (e.g. storage paths via crypto.randomUUID()).
// base64url keeps it URL-safe with no encoding needed in the shareable
// link; 24 random bytes is 192 bits, comfortably unguessable for a
// single-use, 7-day-expiring token. The absolute URL is built client-side
// (window.location.origin) by the caller, same as the login page already
// does for its own emailRedirectTo — this action only returns the code.
export async function createFamilyInvite(): Promise<
  { error: string } | { code: string }
> {
  const { supabase, user } = await requireUser();
  const familyId = await getFamilyId();

  const code = randomBytes(24).toString("base64url");

  const { error } = await supabase.from("family_invites").insert({
    family_id: familyId,
    code,
    created_by: user.id,
  });
  if (error) return { error: error.message };

  revalidatePath("/settings");
  return { code };
}

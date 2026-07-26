import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ResetPasswordForm } from "./reset-password-view";

// Reached only via /auth/callback?next=/reset-password after a recovery
// link's code exchange already established a real session (see
// resetPasswordForEmail's redirectTo in /login) — exchangeCodeForSession
// doesn't produce some restricted "recovery-only" session, it's a normal
// one, so a plain getUser() check is enough to guard this page the same
// way /join/[code] guards its own authenticated-only branch.
export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <ResetPasswordForm />;
}

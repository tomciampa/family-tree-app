import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// Service-role client — bypasses RLS entirely. This is the only place in
// the app that ever touches SUPABASE_SERVICE_ROLE_KEY (server-only env var,
// never NEXT_PUBLIC_-prefixed, so it can't end up in client-bundled JS).
// Deliberately separate from lib/supabase/server.ts's cookie-scoped,
// RLS-bound client, which every other server action/page uses — never call
// this without first checking the caller is a confirmed platform admin (see
// requirePlatformAdmin in lib/admin-stats.ts). No cookie/session handling
// needed here; this authenticates as the service role itself, not a user.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase service-role configuration.");
  }
  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

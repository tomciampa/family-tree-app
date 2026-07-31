import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type AdminDashboardStats = {
  totalUsers: number;
  newSignups7d: number;
  newSignups30d: number;
  totalFamilies: number;
  averageFamilySize: number;
  totalDocuments: number;
  documentsByStatus: {
    pending_match: number;
    matched: number;
    no_match: number;
  };
  totalInterviews: number;
  mostRecentlyActive: { email: string; lastSignInAt: string | null }[];
  inactive30Plus: { email: string; lastSignInAt: string | null }[];
};

// Gate for every admin data-fetch below: a normal RLS-scoped query (the
// same client every other page/action uses) against profiles, which only
// ever lets a user read their own row (see the migration's RLS policy).
// A missing row or is_platform_admin === false both correctly resolve to
// "not an admin" — the safe default, not an error. Only once this returns
// true does anything ever reach for the service-role client below.
export async function isCurrentUserPlatformAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data } = await supabase
    .from("profiles")
    .select("is_platform_admin")
    .eq("id", user.id)
    .maybeSingle();

  return data?.is_platform_admin ?? false;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// auth.users isn't exposed through the normal data API (PostgREST only
// serves the public schema) even to a service-role key — the supported way
// to read it is the Admin API's listUsers(), which this app has never
// called before. Paginated defensively (100/page) even though there are
// only a handful of users today, so this doesn't silently under-count
// once the real user base grows past one page.
async function fetchAllUsers(
  admin: ReturnType<typeof createAdminClient>,
): Promise<{ id: string; email: string | null; createdAt: string; lastSignInAt: string | null }[]> {
  const perPage = 100;
  let page = 1;
  const all: { id: string; email: string | null; createdAt: string; lastSignInAt: string | null }[] = [];
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    all.push(
      ...data.users.map((u) => ({
        id: u.id,
        email: u.email ?? null,
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at ?? null,
      })),
    );
    if (data.users.length < perPage) break;
    page += 1;
  }
  return all;
}

// Called only after isCurrentUserPlatformAdmin() has already returned true
// for this request — see requireAdminStats below, the one intended caller.
// This function itself doesn't re-check; it's not exported for direct use
// specifically so there's exactly one gate to reason about, not two places
// that could drift out of sync.
async function fetchAdminDashboardStats(): Promise<AdminDashboardStats> {
  const admin = createAdminClient();

  const users = await fetchAllUsers(admin);
  const now = Date.now();
  const newSignups7d = users.filter((u) => now - new Date(u.createdAt).getTime() <= 7 * DAY_MS).length;
  const newSignups30d = users.filter((u) => now - new Date(u.createdAt).getTime() <= 30 * DAY_MS).length;

  const sortedByLastActive = [...users].sort((a, b) => {
    const aTime = a.lastSignInAt ? new Date(a.lastSignInAt).getTime() : -Infinity;
    const bTime = b.lastSignInAt ? new Date(b.lastSignInAt).getTime() : -Infinity;
    return bTime - aTime;
  });
  const mostRecentlyActive = sortedByLastActive.slice(0, 10).map((u) => ({
    email: u.email ?? u.id,
    lastSignInAt: u.lastSignInAt,
  }));
  const inactive30Plus = users
    .filter((u) => !u.lastSignInAt || now - new Date(u.lastSignInAt).getTime() > 30 * DAY_MS)
    .map((u) => ({ email: u.email ?? u.id, lastSignInAt: u.lastSignInAt }))
    .sort((a, b) => {
      const aTime = a.lastSignInAt ? new Date(a.lastSignInAt).getTime() : -Infinity;
      const bTime = b.lastSignInAt ? new Date(b.lastSignInAt).getTime() : -Infinity;
      return aTime - bTime;
    });

  const [{ count: totalFamilies }, { count: totalMemberships }] = await Promise.all([
    admin.from("families").select("*", { count: "exact", head: true }),
    admin.from("family_members").select("*", { count: "exact", head: true }),
  ]);

  // "Documents" proper excludes interview session/segment rows, which also
  // live in this same table (see interviewee_person_id/parent_document_id
  // — the established distinguishing filter used everywhere else in the
  // app that queries this table, e.g. /interviews and /documents).
  const generalDocsFilter = (q: ReturnType<typeof admin.from>) =>
    q.is("interviewee_person_id", null).is("parent_document_id", null);

  const [
    { count: totalDocuments },
    { count: pendingMatchCount },
    { count: matchedCount },
    { count: noMatchCount },
    { count: totalInterviews },
  ] = await Promise.all([
    generalDocsFilter(admin.from("documents").select("*", { count: "exact", head: true })),
    generalDocsFilter(
      admin.from("documents").select("*", { count: "exact", head: true }).eq("status", "pending_match"),
    ),
    generalDocsFilter(
      admin.from("documents").select("*", { count: "exact", head: true }).eq("status", "matched"),
    ),
    generalDocsFilter(
      admin.from("documents").select("*", { count: "exact", head: true }).eq("status", "no_match"),
    ),
    admin
      .from("documents")
      .select("*", { count: "exact", head: true })
      .not("interviewee_person_id", "is", null),
  ]);

  const families = totalFamilies ?? 0;
  const memberships = totalMemberships ?? 0;

  return {
    totalUsers: users.length,
    newSignups7d,
    newSignups30d,
    totalFamilies: families,
    averageFamilySize: families > 0 ? memberships / families : 0,
    totalDocuments: totalDocuments ?? 0,
    documentsByStatus: {
      pending_match: pendingMatchCount ?? 0,
      matched: matchedCount ?? 0,
      no_match: noMatchCount ?? 0,
    },
    totalInterviews: totalInterviews ?? 0,
    mostRecentlyActive,
    inactive30Plus,
  };
}

// The single entry point pages should call — bundles the admin check and
// the fetch together so it's structurally impossible to call the
// service-role fetch above without the check having already passed on this
// same request. Returns null for a non-admin (or logged-out) caller;
// callers must treat null as "render nothing admin-shaped," not an error
// to recover from.
export async function requireAdminStats(): Promise<AdminDashboardStats | null> {
  const isAdmin = await isCurrentUserPlatformAdmin();
  if (!isAdmin) return null;
  return fetchAdminDashboardStats();
}

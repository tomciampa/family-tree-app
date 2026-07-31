import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdminStats } from "@/lib/admin-stats";

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-5 shadow-[var(--shadow-1)]">
      <span className="text-[length:var(--font-size-caption)] uppercase tracking-wide text-[color:var(--color-text-tertiary)]">
        {label}
      </span>
      <span className="text-[length:var(--font-size-heading-1)] leading-[var(--line-height-heading-1)] font-semibold text-[color:var(--color-text-primary)]">
        {value}
      </span>
      {sub && <span className="text-sm text-[color:var(--color-text-secondary)]">{sub}</span>}
    </div>
  );
}

// Platform-level admin only (distinct from any per-family owner/member
// role) — see requireAdminStats, which gates the service-role fetch behind
// an RLS-scoped is_platform_admin check. A non-admin or logged-out visitor
// gets a real 404 here, not a redirect or an empty admin-shaped shell —
// requireAdminStats returns null before any admin data is ever fetched, so
// there's nothing partially-admin to accidentally render either.
export default async function AdminPage() {
  const stats = await requireAdminStats();
  if (!stats) notFound();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 p-8 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <h1 className="text-[length:var(--font-size-heading-1)] leading-[var(--line-height-heading-1)] font-semibold">
          Admin Dashboard
        </h1>
        <Link
          href="/"
          className="text-sm text-[color:var(--color-text-secondary)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
        >
          Home
        </Link>
      </div>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="Total Users" value={String(stats.totalUsers)} />
        <StatCard label="New Signups (7d)" value={String(stats.newSignups7d)} />
        <StatCard label="New Signups (30d)" value={String(stats.newSignups30d)} />
        <StatCard label="Total Families" value={String(stats.totalFamilies)} />
        <StatCard
          label="Avg Family Size"
          value={stats.averageFamilySize.toFixed(1)}
          sub="members per family"
        />
        <StatCard label="Total Interviews" value={String(stats.totalInterviews)} />
      </section>

      <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 shadow-[var(--shadow-1)]">
        <h2 className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
          Documents ({stats.totalDocuments} total)
        </h2>
        <div className="flex flex-wrap gap-3">
          <span className="rounded-[var(--radius-xs)] bg-[color:var(--color-warning-subtle-bg)] px-3 py-1 text-sm font-medium text-[color:var(--color-warning-subtle-fg)]">
            Pending match: {stats.documentsByStatus.pending_match}
          </span>
          <span className="rounded-[var(--radius-xs)] bg-[color:var(--color-success-subtle-bg)] px-3 py-1 text-sm font-medium text-[color:var(--color-success-subtle-fg)]">
            Matched: {stats.documentsByStatus.matched}
          </span>
          <span className="rounded-[var(--radius-xs)] bg-[color:var(--color-bg-surface-alt)] px-3 py-1 text-sm font-medium text-[color:var(--color-text-secondary)]">
            No match: {stats.documentsByStatus.no_match}
          </span>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 shadow-[var(--shadow-1)]">
          <h2 className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
            Most recently active
          </h2>
          <ul className="flex flex-col gap-1">
            {stats.mostRecentlyActive.map((u) => (
              <li
                key={u.email}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm"
              >
                <span className="truncate text-[color:var(--color-text-primary)]">{u.email}</span>
                <span className="shrink-0 text-[color:var(--color-text-tertiary)]">
                  {formatDate(u.lastSignInAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 shadow-[var(--shadow-1)]">
          <h2 className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
            No login in 30+ days
          </h2>
          {stats.inactive30Plus.length === 0 ? (
            <p className="text-sm text-[color:var(--color-text-secondary)]">
              Everyone has signed in within the last 30 days.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {stats.inactive30Plus.map((u) => (
                <li
                  key={u.email}
                  className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm"
                >
                  <span className="truncate text-[color:var(--color-text-primary)]">{u.email}</span>
                  <span className="shrink-0 text-[color:var(--color-text-tertiary)]">
                    {formatDate(u.lastSignInAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

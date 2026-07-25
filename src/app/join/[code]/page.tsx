import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { JoinConfirm } from "./join-view";

// Card wrapper shared by every state this page can be in (error, sign-in
// prompt, confirm) — one consistent frame rather than a different layout
// per branch.
function JoinCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)]">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-8 text-center shadow-[var(--shadow-2)]">
        {children}
      </div>
    </main>
  );
}

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  not_found: {
    title: "Invite not found",
    body: "This invite link doesn't match any active invite. Ask whoever sent it for a new one.",
  },
  used: {
    title: "Invite already used",
    body: "This invite link has already been used. Ask whoever sent it for a new one if you still need access.",
  },
  expired: {
    title: "Invite expired",
    body: "This invite link has expired. Ask whoever sent it for a new one.",
  },
};

export default async function JoinPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .rpc("get_invite_preview", { invite_code: code })
    .single();

  if (error) {
    return (
      <JoinCard>
        <h1 className="text-[length:var(--font-size-heading-3)] font-semibold">
          Something went wrong
        </h1>
        <p className="text-sm text-[color:var(--color-text-secondary)]">{error.message}</p>
      </JoinCard>
    );
  }

  if (data.status !== "valid" && data.status !== "already_member") {
    const copy = ERROR_COPY[data.status ?? "not_found"] ?? ERROR_COPY.not_found;
    return (
      <JoinCard>
        <h1 className="text-[length:var(--font-size-heading-3)] font-semibold">{copy.title}</h1>
        <p className="text-sm text-[color:var(--color-text-secondary)]">{copy.body}</p>
        <Link
          href="/"
          className="text-sm text-[color:var(--color-accent)] underline underline-offset-2"
        >
          Go home
        </Link>
      </JoinCard>
    );
  }

  const familyName = data.family_name ?? "this family";

  if (data.status === "already_member") {
    return (
      <JoinCard>
        <h1 className="text-[length:var(--font-size-heading-3)] font-semibold">
          You&apos;re already in
        </h1>
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          You&apos;re already a member of <strong>{familyName}</strong>.
        </p>
        <Link
          href="/tree"
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)]"
        >
          Go to the family tree
        </Link>
      </JoinCard>
    );
  }

  if (!user) {
    return (
      <JoinCard>
        <h1 className="text-[length:var(--font-size-heading-3)] font-semibold">
          You&apos;ve been invited
        </h1>
        <p className="text-sm text-[color:var(--color-text-secondary)]">
          You&apos;ve been invited to join <strong>{familyName}</strong>. Sign in to continue —
          we&apos;ll bring you right back here.
        </p>
        <Link
          href={`/login?next=${encodeURIComponent(`/join/${code}`)}`}
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-accent-hover)]"
        >
          Sign in to continue
        </Link>
      </JoinCard>
    );
  }

  return (
    <JoinCard>
      <h1 className="text-[length:var(--font-size-heading-3)] font-semibold">
        You&apos;ve been invited
      </h1>
      <p className="text-sm text-[color:var(--color-text-secondary)]">
        You&apos;ve been invited to join <strong>{familyName}</strong>.
      </p>
      <JoinConfirm code={code} familyName={familyName} />
    </JoinCard>
  );
}

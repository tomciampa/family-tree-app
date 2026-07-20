import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getFamilyId } from "@/lib/family";

const ERROR_MESSAGES: Record<string, string> = {
  state_mismatch: "The connection attempt expired or was tampered with. Please try again.",
  connection_failed: "FamilySearch didn't confirm the connection. Please try again.",
};

export default async function FamilySearchPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const { connected, error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const familyId = await getFamilyId();
  const { data: connection } = await supabase
    .from("familysearch_connection")
    .select("fs_display_name, connected_at, token_expires_at")
    .eq("family_id", familyId)
    .maybeSingle();

  const tokenExpired = connection
    ? new Date(connection.token_expires_at) < new Date()
    : false;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">FamilySearch connection</h1>
        <Link href="/" className="text-sm text-gray-500 underline">
          Home
        </Link>
      </div>

      {connected && (
        <p className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">
          Connected to FamilySearch.
        </p>
      )}
      {error && (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {ERROR_MESSAGES[error] ?? "Something went wrong connecting to FamilySearch."}
        </p>
      )}

      {connection ? (
        <div className="flex flex-col gap-2 rounded border border-gray-300 p-4 text-sm">
          <p>
            Connected as <strong>{connection.fs_display_name}</strong>
          </p>
          <p className="text-gray-500">
            Connected {new Date(connection.connected_at).toLocaleString()}
          </p>
          <p className={tokenExpired ? "text-red-600" : "text-gray-500"}>
            {tokenExpired
              ? "Access token has expired — reconnect to refresh it."
              : `Access token valid until ${new Date(connection.token_expires_at).toLocaleString()}`}
          </p>
          <a
            href="/api/familysearch/login"
            className="mt-2 w-fit rounded border border-gray-300 px-3 py-2 underline"
          >
            Reconnect
          </a>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded border border-gray-300 p-4 text-sm">
          <p className="text-gray-500">
            Not connected yet. This uses FamilySearch&apos;s sandbox (Integration)
            environment — test data only, not your real tree.
          </p>
          <a
            href="/api/familysearch/login"
            className="w-fit rounded border border-gray-300 px-3 py-2 underline"
          >
            Connect to FamilySearch
          </a>
        </div>
      )}
    </main>
  );
}

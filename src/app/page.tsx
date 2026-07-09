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
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-3xl font-semibold">Hello, world 👋</h1>
      <p className="text-gray-500">
        Signed in as <strong>{user.email}</strong>
      </p>
      <div className="flex gap-4">
        <Link href="/people" className="underline">
          View people
        </Link>
        <Link href="/tree" className="underline">
          Family tree
        </Link>
      </div>
      <form action={signOut}>
        <button
          type="submit"
          className="rounded border border-gray-300 px-3 py-2 dark:border-gray-700"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}

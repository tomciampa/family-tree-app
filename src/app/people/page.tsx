import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function PeoplePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: people, error } = await supabase
    .from("people")
    .select("id, name, birth_estimate, death_estimate")
    .order("name");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">People</h1>
        <Link href="/" className="text-sm text-gray-500 underline">
          Home
        </Link>
      </div>

      {error && <p className="text-sm text-red-500">{error.message}</p>}

      {!error && people?.length === 0 && (
        <p className="text-gray-500">No people yet.</p>
      )}

      <ul className="flex flex-col divide-y divide-gray-200 dark:divide-gray-800">
        {people?.map((person) => (
          <li key={person.id} className="py-3">
            <Link
              href={`/people/${person.id}`}
              className="flex items-center justify-between hover:underline"
            >
              <span>{person.name}</span>
              <span className="text-sm text-gray-500">
                {person.birth_estimate ?? "?"} – {person.death_estimate ?? ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

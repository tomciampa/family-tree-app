import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TreeView } from "./tree-view";
import { AddFirstPersonForm } from "./add-first-person-form";

export default async function TreePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [
    { data: people, error: peopleError },
    { data: unions, error: unionsError },
    { data: unionChildren, error: unionChildrenError },
    { data: facts, error: factsError },
    { data: anecdotes, error: anecdotesError },
  ] = await Promise.all([
    supabase.from("people").select("*").order("created_at"),
    supabase.from("unions").select("*").order("created_at"),
    supabase.from("union_children").select("*"),
    supabase.from("facts").select("*").order("recorded_at"),
    supabase.from("anecdotes").select("*").order("recorded_at"),
  ]);

  const error =
    peopleError ?? unionsError ?? unionChildrenError ?? factsError ?? anecdotesError;

  return (
    <main className="flex min-h-screen flex-col gap-6 p-8">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between">
        <h1 className="text-2xl font-semibold">Family Tree</h1>
        <Link href="/" className="text-sm text-gray-500 underline">
          Home
        </Link>
      </div>

      {error && (
        <p className="mx-auto text-sm text-red-500">{error.message}</p>
      )}

      {!error && people && people.length === 0 && <AddFirstPersonForm />}

      {!error && people && people.length > 0 && (
        <TreeView
          people={people}
          unions={unions ?? []}
          unionChildren={unionChildren ?? []}
          facts={facts ?? []}
          anecdotes={anecdotes ?? []}
        />
      )}
    </main>
  );
}

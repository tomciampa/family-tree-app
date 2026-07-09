import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [
    { data: person },
    { data: facts },
    { data: anecdotes },
    { data: eventLinks },
    { data: photoLinks },
    { data: documentLinks },
    { data: unionsAsParent },
    { data: childOf },
  ] = await Promise.all([
    supabase.from("people").select("*").eq("id", id).single(),
    supabase
      .from("facts")
      .select("*")
      .eq("person_id", id)
      .order("field"),
    supabase
      .from("anecdotes")
      .select("*")
      .eq("person_id", id)
      .order("recorded_at"),
    supabase
      .from("event_people")
      .select("role, events(id, event_type, date_estimate, location, notes)")
      .eq("person_id", id),
    supabase
      .from("photo_tags")
      .select("photos(id, file_path, caption, date_estimate)")
      .eq("person_id", id),
    supabase
      .from("document_people")
      .select("documents(id, file_path, document_type, transcription_raw)")
      .eq("person_id", id),
    supabase
      .from("unions")
      .select(
        "id, note, parent1:people!unions_parent1_id_fkey(id, name), parent2:people!unions_parent2_id_fkey(id, name), union_children(people(id, name))",
      )
      .or(`parent1_id.eq.${id},parent2_id.eq.${id}`),
    supabase
      .from("union_children")
      .select(
        "unions(parent1:people!unions_parent1_id_fkey(id, name), parent2:people!unions_parent2_id_fkey(id, name))",
      )
      .eq("child_id", id),
  ]);

  if (!person) {
    notFound();
  }

  const parents = childOf
    ?.flatMap((link) => (link.unions ? [link.unions] : []))
    .flatMap((u) => [u.parent1, u.parent2])
    .filter((p): p is { id: string; name: string } => p !== null);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 p-8">
      <div className="flex items-center justify-between">
        <Link href="/people" className="text-sm text-gray-500 underline">
          ← People
        </Link>
      </div>

      <div>
        <h1 className="text-3xl font-semibold">{person.name}</h1>
        <p className="text-gray-500">
          {person.birth_estimate ?? "?"} – {person.death_estimate ?? ""}
        </p>
        {person.notes && <p className="mt-2 text-gray-600">{person.notes}</p>}
      </div>

      {parents && parents.length > 0 && (
        <Section title="Parents">
          <ul className="flex flex-col gap-1">
            {parents.map((p) => (
              <li key={p.id}>
                <Link href={`/people/${p.id}`} className="hover:underline">
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {unionsAsParent && unionsAsParent.length > 0 && (
        <Section title="Unions & children">
          <ul className="flex flex-col gap-3">
            {unionsAsParent.map((u) => {
              const partner =
                u.parent1?.id === id ? u.parent2 : u.parent1;
              return (
                <li key={u.id}>
                  {partner && (
                    <p>
                      With{" "}
                      <Link
                        href={`/people/${partner.id}`}
                        className="hover:underline"
                      >
                        {partner.name}
                      </Link>
                    </p>
                  )}
                  {u.note && (
                    <p className="text-sm text-gray-500">{u.note}</p>
                  )}
                  {u.union_children.length > 0 && (
                    <ul className="ml-4 list-disc">
                      {u.union_children.map(
                        (c) =>
                          c.people && (
                            <li key={c.people.id}>
                              <Link
                                href={`/people/${c.people.id}`}
                                className="hover:underline"
                              >
                                {c.people.name}
                              </Link>
                            </li>
                          ),
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {facts && facts.length > 0 && (
        <Section title="Facts">
          <ul className="flex flex-col gap-1">
            {facts.map((f) => (
              <li key={f.id}>
                <span className="font-medium">{f.field}:</span> {f.value}
                {f.confidence && (
                  <span className="ml-2 text-xs text-gray-500">
                    ({f.confidence})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {anecdotes && anecdotes.length > 0 && (
        <Section title="Anecdotes">
          <ul className="flex flex-col gap-4">
            {anecdotes.map((a) => (
              <li key={a.id}>
                <p>{a.story_text}</p>
                {a.who_told_it && (
                  <p className="text-sm text-gray-500">— {a.who_told_it}</p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {eventLinks && eventLinks.length > 0 && (
        <Section title="Events">
          <ul className="flex flex-col gap-2">
            {eventLinks.map(
              (link) =>
                link.events && (
                  <li key={link.events.id}>
                    <span className="font-medium">
                      {link.events.event_type ?? "Event"}
                    </span>{" "}
                    {link.events.date_estimate && `(${link.events.date_estimate})`}
                    {link.events.location && ` — ${link.events.location}`}
                    {link.role && (
                      <span className="ml-2 text-xs text-gray-500">
                        {link.role}
                      </span>
                    )}
                  </li>
                ),
            )}
          </ul>
        </Section>
      )}

      {photoLinks && photoLinks.length > 0 && (
        <Section title="Photos">
          <ul className="flex flex-col gap-1">
            {photoLinks.map(
              (link) =>
                link.photos && (
                  <li key={link.photos.id} className="text-sm text-gray-600">
                    {link.photos.file_path}
                    {link.photos.caption && ` — ${link.photos.caption}`}
                  </li>
                ),
            )}
          </ul>
        </Section>
      )}

      {documentLinks && documentLinks.length > 0 && (
        <Section title="Documents">
          <ul className="flex flex-col gap-1">
            {documentLinks.map(
              (link) =>
                link.documents && (
                  <li
                    key={link.documents.id}
                    className="text-sm text-gray-600"
                  >
                    {link.documents.document_type ?? "Document"}:{" "}
                    {link.documents.file_path}
                  </li>
                ),
            )}
          </ul>
        </Section>
      )}
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

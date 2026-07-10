import Link from "next/link";
import type { Tables } from "@/lib/supabase/database.types";
import styles from "./family-tree.module.css";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;

export function FamilyTree({
  people,
  unions,
  unionChildren,
  onPersonClick,
}: {
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  onPersonClick?: (person: Person) => void;
}) {
  const peopleById = new Map(people.map((p) => [p.id, p]));

  const childToUnionId = new Map<string, string>();
  for (const uc of unionChildren) {
    if (!childToUnionId.has(uc.child_id)) {
      childToUnionId.set(uc.child_id, uc.union_id);
    }
  }

  const unionsByParent = new Map<string, UnionRow[]>();
  for (const u of unions) {
    for (const parentId of [u.parent1_id, u.parent2_id]) {
      if (!parentId) continue;
      const list = unionsByParent.get(parentId) ?? [];
      list.push(u);
      unionsByParent.set(parentId, list);
    }
  }

  const childrenByUnion = new Map<string, string[]>();
  for (const uc of unionChildren) {
    const list = childrenByUnion.get(uc.union_id) ?? [];
    list.push(uc.child_id);
    childrenByUnion.set(uc.union_id, list);
  }

  const rootUnions = unions.filter((u) => {
    const parents = [u.parent1_id, u.parent2_id].filter(
      (id): id is string => id !== null,
    );
    if (parents.length === 0) return false;
    return parents.every((id) => !childToUnionId.has(id));
  });

  const touchedIds = new Set<string>();
  for (const u of unions) {
    if (u.parent1_id) touchedIds.add(u.parent1_id);
    if (u.parent2_id) touchedIds.add(u.parent2_id);
  }
  for (const uc of unionChildren) touchedIds.add(uc.child_id);
  const unplacedPeople = people.filter((p) => !touchedIds.has(p.id));

  // A union can be reachable from two different root ancestors when both
  // partners have their own recorded parents (e.g. someone who married in
  // from a documented family). Track which unions have already been drawn
  // so each one — and its descendants — renders fully only once; any later
  // path to the same union shows a plain, non-expanding card instead.
  const renderedUnionIds = new Set<string>();

  function renderChildEntries(personId: string, path: Set<string>) {
    const person = peopleById.get(personId);
    if (!person) return [];

    if (path.has(personId)) {
      return [
        <li key={personId}>
          <PersonCard person={person} onClick={onPersonClick} />
        </li>,
      ];
    }

    const ownUnions = (unionsByParent.get(personId) ?? []).filter(
      (u) => !renderedUnionIds.has(u.id),
    );
    if (ownUnions.length === 0) {
      return [
        <li key={personId}>
          <PersonCard person={person} onClick={onPersonClick} />
        </li>,
      ];
    }

    const nextPath = new Set(path).add(personId);
    return ownUnions.map((u) => {
      renderedUnionIds.add(u.id);
      return <li key={u.id}>{renderUnionNode(u, nextPath)}</li>;
    });
  }

  function renderUnionNode(union: UnionRow, path: Set<string>) {
    const p1 = union.parent1_id ? peopleById.get(union.parent1_id) : null;
    const p2 = union.parent2_id ? peopleById.get(union.parent2_id) : null;
    const childIds = childrenByUnion.get(union.id) ?? [];
    const childLis = childIds.flatMap((cid) =>
      renderChildEntries(cid, path),
    );

    return (
      <>
        <div className={styles.couple}>
          {p1 && <PersonCard person={p1} onClick={onPersonClick} />}
          {p1 && p2 && <span className={styles.marriageLink} />}
          {p2 && <PersonCard person={p2} onClick={onPersonClick} />}
          {!p1 && !p2 && (
            <span className="text-sm text-gray-400">Unknown parents</span>
          )}
        </div>
        {union.note && <p className={styles.note}>{union.note}</p>}
        {childLis.length > 0 && <ul className={styles.tree}>{childLis}</ul>}
      </>
    );
  }

  return (
    <div className={styles.wrapper}>
      {rootUnions.length > 0 && (
        <div className={styles.tree}>
          <ul>
            {rootUnions.map((u) => {
              renderedUnionIds.add(u.id);
              return <li key={u.id}>{renderUnionNode(u, new Set())}</li>;
            })}
          </ul>
        </div>
      )}

      {unplacedPeople.length > 0 && (
        <div className="mt-10 border-t border-gray-200 pt-6 dark:border-gray-800">
          <h2 className="mb-3 text-sm font-medium text-gray-500">
            Not yet connected to the tree
          </h2>
          <ul className="flex flex-wrap gap-2">
            {unplacedPeople.map((p) => (
              <li key={p.id}>
                <PersonCard person={p} onClick={onPersonClick} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PersonCard({
  person,
  onClick,
}: {
  person: Person;
  onClick?: (person: Person) => void;
}) {
  const cardClassName =
    "flex min-w-[8rem] flex-col items-center rounded border border-gray-300 bg-white px-3 py-2 text-center text-sm shadow-sm transition-colors hover:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-gray-600";
  const inner = (
    <>
      <span className="font-medium">{person.name}</span>
      <span className="text-xs text-gray-500">
        {person.birth_estimate ?? "?"}
        {" – "}
        {person.death_estimate ?? ""}
      </span>
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={() => onClick(person)} className={cardClassName}>
        {inner}
      </button>
    );
  }

  return (
    <Link href={`/people/${person.id}`} className={cardClassName}>
      {inner}
    </Link>
  );
}

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
  collapsedUnionIds = new Set<string>(),
}: {
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  onPersonClick?: (person: Person) => void;
  collapsedUnionIds?: Set<string>;
}) {
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const unionsById = new Map(unions.map((u) => [u.id, u]));

  // A child's own recorded parents (at most one incoming union per person).
  const childToUnionId = new Map<string, string>();
  for (const uc of unionChildren) {
    if (!childToUnionId.has(uc.child_id)) {
      childToUnionId.set(uc.child_id, uc.union_id);
    }
  }

  // All of a person's own unions — a person can be a parent in more than one
  // (e.g. widowed and remarried), so this is never deduped to "the first one".
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

  // Every union renders fully exactly once, wherever it's first reached —
  // whether that's a top-level anchor, someone's own marriage while
  // descending, or a spouse's birth family while ascending. Any later path
  // back to an already-rendered union is skipped (its person still shows,
  // just without re-expanding that branch again).
  const renderedUnionIds = new Set<string>();
  // Tracks every person whose own card has actually been drawn, so the
  // top-level loop below can use each person as an entry point at most
  // once (a person who is a parent in more than one union, but has no
  // recorded parents of their own, would otherwise get arbitrarily
  // promoted as "the" top-level tree for one marriage while their other
  // marriages fan off asymmetrically).
  const renderedPersonIds = new Set<string>();

  function renderParentSlot(personId: string | null, path: Set<string>) {
    if (!personId || !peopleById.has(personId)) {
      return <span className={styles.unknownParent}>Unknown</span>;
    }
    return renderPersonFanned(personId, path);
  }

  // Hiding a union's descendants must be final: mark that whole branch
  // (children, and anyone further down through their own marriages) as
  // accounted for, so the top-level fallback pass never redraws them as
  // orphaned, disconnected cards just because a collapsed ancestor union
  // kept them from being reached through the normal recursion.
  function markDescendantsHidden(union: UnionRow) {
    for (const childId of childrenByUnion.get(union.id) ?? []) {
      if (renderedPersonIds.has(childId)) continue;
      renderedPersonIds.add(childId);
      for (const childUnion of unionsByParent.get(childId) ?? []) {
        if (renderedUnionIds.has(childUnion.id)) continue;
        renderedUnionIds.add(childUnion.id);
        markDescendantsHidden(childUnion);
      }
    }
  }

  function renderUnionCouple(union: UnionRow, path: Set<string>) {
    if (collapsedUnionIds.has(union.id)) {
      markDescendantsHidden(union);
      return (
        <div className={styles.unionBlock} key={union.id}>
          <div className={styles.couple}>
            {renderParentSlot(union.parent1_id, path)}
            {union.parent1_id && union.parent2_id && (
              <span className={styles.marriageLink} />
            )}
            {renderParentSlot(union.parent2_id, path)}
          </div>
          <p className={styles.unknownParent}>(collapsed)</p>
        </div>
      );
    }

    const childIds = childrenByUnion.get(union.id) ?? [];

    return (
      <div className={styles.unionBlock} key={union.id}>
        <div className={styles.couple}>
          {renderParentSlot(union.parent1_id, path)}
          {union.parent1_id && union.parent2_id && (
            <span className={styles.marriageLink} />
          )}
          {renderParentSlot(union.parent2_id, path)}
        </div>
        {union.note && <p className={styles.note}>{union.note}</p>}
        {childIds.length > 0 && (
          <div className={styles.childrenRow}>
            {childIds.map((cid) => renderPersonFanned(cid, path))}
          </div>
        )}
      </div>
    );
  }

  function renderMarriageBranch(
    union: UnionRow,
    anchorPersonId: string,
    path: Set<string>,
  ) {
    const spouseId =
      union.parent1_id === anchorPersonId
        ? union.parent2_id
        : union.parent1_id;

    if (collapsedUnionIds.has(union.id)) {
      markDescendantsHidden(union);
      return (
        <div className={styles.marriageBranch} key={union.id}>
          <div className={styles.marriageConnectorRow}>
            <span className={styles.marriageConnectorLine} />
            {union.note && (
              <span className={styles.marriageLabel}>{union.note}</span>
            )}
            {renderParentSlot(spouseId, path)}
            <span className={styles.unknownParent}>(collapsed)</span>
          </div>
        </div>
      );
    }

    const nextPath = new Set(path);
    if (spouseId) nextPath.add(spouseId);
    const childIds = childrenByUnion.get(union.id) ?? [];

    return (
      <div className={styles.marriageBranch} key={union.id}>
        <div className={styles.marriageConnectorRow}>
          <span className={styles.marriageConnectorLine} />
          {union.note && (
            <span className={styles.marriageLabel}>{union.note}</span>
          )}
          {renderParentSlot(spouseId, path)}
        </div>
        {childIds.length > 0 && (
          <div className={styles.childrenRow}>
            {childIds.map((cid) => renderPersonFanned(cid, nextPath))}
          </div>
        )}
      </div>
    );
  }

  function renderPersonFanned(personId: string, path: Set<string>) {
    const person = peopleById.get(personId);
    if (!person) return null;

    if (path.has(personId)) {
      renderedPersonIds.add(personId);
      return (
        <div className={styles.personFanned} key={personId}>
          <PersonCard person={person} onClick={onPersonClick} />
        </div>
      );
    }

    // If this person's own birth family hasn't been drawn anywhere yet,
    // draw it now — couple plus all of their children, this person
    // included — and let this person emerge in that children row with
    // their own marriage fan intact. The renderedUnionIds guard means
    // when we reach this same person again a level down, their incoming
    // union is already claimed, so it falls through to the plain
    // card-plus-marriages case below instead of recursing forever.
    const incomingUnionId = childToUnionId.get(personId);
    const incomingUnion = incomingUnionId
      ? unionsById.get(incomingUnionId)
      : undefined;
    if (incomingUnion && !renderedUnionIds.has(incomingUnion.id)) {
      renderedUnionIds.add(incomingUnion.id);
      return renderUnionCouple(incomingUnion, path);
    }

    const nextPath = new Set(path).add(personId);
    const marriages = (unionsByParent.get(personId) ?? [])
      .filter((u) => !renderedUnionIds.has(u.id))
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));

    const marriageBranches = marriages.map((union) => {
      renderedUnionIds.add(union.id);
      return renderMarriageBranch(union, personId, nextPath);
    });

    renderedPersonIds.add(personId);
    return (
      <div className={styles.personFanned} key={personId}>
        <div className={styles.personRow}>
          <PersonCard person={person} onClick={onPersonClick} />
          {marriageBranches.length > 0 && (
            <div className={styles.marriages}>{marriageBranches}</div>
          )}
        </div>
      </div>
    );
  }

  // Every top-level tree starts from one person, not one union — a person
  // with no recorded parents but multiple marriages must be the single
  // shared anchor for all of them, fanned uniformly, rather than having
  // one marriage arbitrarily become "the" top-level couple while the rest
  // nest off it unevenly. People with no recorded parents go first so the
  // tree still reads ancestors-on-top wherever that's known; any person
  // left uncovered after that pass (unusual, but possible with imported
  // data) still gets picked up as its own tree.
  const rootPeople = people.filter((p) => !childToUnionId.has(p.id));
  const orderedTopLevelPeople = [
    ...rootPeople,
    ...people.filter((p) => !rootPeople.some((rp) => rp.id === p.id)),
  ];

  const topLevelBlocks = [];
  for (const person of orderedTopLevelPeople) {
    if (renderedPersonIds.has(person.id)) continue;
    if (!touchedIds.has(person.id)) continue; // unplaced people render separately below
    topLevelBlocks.push(renderPersonFanned(person.id, new Set()));
  }

  return (
    <div className={styles.wrapper}>
      {topLevelBlocks.length > 0 && (
        <div className={styles.forest}>{topLevelBlocks}</div>
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

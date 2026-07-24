import type { Tables } from "@/lib/supabase/database.types";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;
type Fact = Tables<"facts">;

// Interview batch confirmation (confirmInterviewBatch in
// app/interviews/actions.ts) writes a base "who is this person" fact on
// every confirmed/created candidate, always shaped like
// "<anchor name>'s <relation>, per interview" via relationFactValue —
// e.g. "Maxine Dubois's maternal grandfather, per interview". That's the
// only place relation-to-a-named-anchor data exists in this schema right
// now (people.gender is never populated by anything in the app), so it's
// what this resolver reads.
const RELATION_FACT_PATTERN = /^(.+?)'s\s+.+?,\s*per interview/i;

// Exported so other consumers of this same relation-fact convention (e.g.
// lib/gap-analysis.ts) read it identically rather than re-deriving their
// own copy of the pattern.
export function anchorNameFromFactValue(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(RELATION_FACT_PATTERN);
  return match ? match[1] : null;
}

type ParentRole = "mother" | "father";

// Only the relation types that have actually come up in real interviews
// so far (the four grandparent relations) — deliberately not trying to
// cover sibling/spouse/aunt/uncle/cousin etc. before there's a real case
// for them. `hops` is the walk from the anchor to the target; `bucket` is
// which "Add ___" form this relation is relevant to.
const RELATION_HOPS: Record<string, { hops: ParentRole[]; bucket: "parent" }> = {
  "maternal grandfather": { hops: ["mother", "father"], bucket: "parent" },
  "maternal grandmother": { hops: ["mother", "mother"], bucket: "parent" },
  "paternal grandfather": { hops: ["father", "father"], bucket: "parent" },
  "paternal grandmother": { hops: ["father", "mother"], bucket: "parent" },
};

export type ConnectionBucket = "parent" | "sibling" | "spouse";

export type SuggestedConnection = {
  personId: string;
  personName: string;
};

function touchedIds(unions: UnionRow[], unionChildren: UnionChild[]): Set<string> {
  const ids = new Set<string>();
  for (const u of unions) {
    if (u.parent1_id) ids.add(u.parent1_id);
    if (u.parent2_id) ids.add(u.parent2_id);
  }
  for (const uc of unionChildren) ids.add(uc.child_id);
  return ids;
}

// Which of personId's two recorded parents plays `role` (mother/father) —
// determined the same way, by looking for that parent's own "<child
// name>'s mother/father, per interview" fact. Without people.gender ever
// populated, this fact is the only signal available; if neither parent
// has one, the role genuinely can't be determined, and callers should
// treat that as "can't resolve" rather than guess.
function findParentByRole(
  personId: string,
  role: ParentRole,
  unions: UnionRow[],
  unionChildren: UnionChild[],
  facts: Fact[],
  peopleById: Map<string, Person>,
): string | null {
  const unionId = unionChildren.find((uc) => uc.child_id === personId)?.union_id;
  if (!unionId) return null;
  const union = unions.find((u) => u.id === unionId);
  if (!union) return null;
  const parentIds = [union.parent1_id, union.parent2_id].filter(
    (id): id is string => !!id,
  );
  const personName = peopleById.get(personId)?.name;
  if (!personName) return null;

  for (const parentId of parentIds) {
    const relationFact = facts.find(
      (f) =>
        f.person_id === parentId &&
        f.field.toLowerCase() === role &&
        anchorNameFromFactValue(f.value)?.toLowerCase() === personName.toLowerCase(),
    );
    if (relationFact) return parentId;
  }
  return null;
}

function walkParentHops(
  startId: string,
  hops: ParentRole[],
  unions: UnionRow[],
  unionChildren: UnionChild[],
  facts: Fact[],
  peopleById: Map<string, Person>,
): string | null {
  let current = startId;
  for (const role of hops) {
    const next = findParentByRole(current, role, unions, unionChildren, facts, peopleById);
    if (!next) return null;
    current = next;
  }
  return current;
}

// For a specific person (targetPersonId) and a specific "Add ___" form
// (bucket), finds loose/unconnected people whose own stored relation
// (e.g. Hugo's "maternal grandfather of Maxine") resolves — by walking
// the real, already-connected tree from the named anchor — to exactly
// targetPersonId. Conservative by construction: a relation with an
// unknown type, an anchor that isn't a real person, or a hop that can't
// be walked (missing parent-role fact) simply doesn't produce a
// suggestion, rather than guessing.
export function findSuggestedConnections(
  targetPersonId: string,
  bucket: ConnectionBucket,
  people: Person[],
  unions: UnionRow[],
  unionChildren: UnionChild[],
  facts: Fact[],
): SuggestedConnection[] {
  const touched = touchedIds(unions, unionChildren);
  const loosePeople = people.filter((p) => !touched.has(p.id) && p.id !== targetPersonId);
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const peopleByNameLower = new Map(people.map((p) => [p.name.toLowerCase(), p]));

  const suggestions: SuggestedConnection[] = [];

  for (const loose of loosePeople) {
    const looseFacts = facts.filter((f) => f.person_id === loose.id);
    for (const fact of looseFacts) {
      const anchorName = anchorNameFromFactValue(fact.value);
      if (!anchorName) continue;
      const anchor = peopleByNameLower.get(anchorName.toLowerCase());
      if (!anchor) continue;

      const relation = RELATION_HOPS[fact.field.toLowerCase()];
      if (!relation || relation.bucket !== bucket) continue;

      const hopsToParent = relation.hops.slice(0, -1);
      const relativeTo =
        hopsToParent.length === 0
          ? anchor.id
          : walkParentHops(anchor.id, hopsToParent, unions, unionChildren, facts, peopleById);

      if (relativeTo === targetPersonId) {
        suggestions.push({ personId: loose.id, personName: loose.name });
        break;
      }
    }
  }

  return suggestions;
}

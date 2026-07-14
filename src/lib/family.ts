import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;

export type PersonSummary = {
  birthEstimate: string | null;
  deathEstimate: string | null;
  relationshipSummary: string;
};

// Turns each person's recorded parents/spouses (the same unions +
// union_children rows the tree itself renders from, and the same data the
// document matcher's relationship-signal check already reads — see
// applyRelationshipSignal in app/documents/actions.ts) into one
// disambiguating line, for contexts like the candidate-match review list
// where "Anthony Ciampa" alone can refer to several different people.
// Parents take priority over spouse as the more identity-establishing
// fact; spouse is the fallback for someone with a recorded marriage but
// no recorded parents (e.g. a root ancestor); "no recorded parents" is
// the last resort for someone with neither.
export function buildPersonSummaries(
  people: Person[],
  unions: UnionRow[],
  unionChildren: UnionChild[],
): Map<string, PersonSummary> {
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const unionsById = new Map(unions.map((u) => [u.id, u]));

  // A child can only ever have one recorded set of parents in this
  // schema's normal usage — same first-wins dedup convention as
  // toF3Data() in components/family-tree.tsx, in case bad data ever put a
  // child in more than one union.
  const childToUnionId = new Map<string, string>();
  for (const uc of unionChildren) {
    if (!childToUnionId.has(uc.child_id)) {
      childToUnionId.set(uc.child_id, uc.union_id);
    }
  }

  const spousesByPerson = new Map<string, string[]>();
  for (const u of unions) {
    const parents = [u.parent1_id, u.parent2_id].filter(
      (id): id is string => !!id,
    );
    for (const id of parents) {
      const others = parents.filter((other) => other !== id);
      spousesByPerson.set(id, [...(spousesByPerson.get(id) ?? []), ...others]);
    }
  }

  const summaries = new Map<string, PersonSummary>();
  for (const person of people) {
    const unionId = childToUnionId.get(person.id);
    const union = unionId ? unionsById.get(unionId) : undefined;
    const parentNames = union
      ? [union.parent1_id, union.parent2_id]
          .filter((id): id is string => !!id)
          .map((id) => peopleById.get(id)?.name ?? "Unknown")
      : [];

    let relationshipSummary: string;
    if (parentNames.length > 0) {
      relationshipSummary = `child of ${parentNames.join(" & ")}`;
    } else {
      const spouseNames = (spousesByPerson.get(person.id) ?? [])
        .map((id) => peopleById.get(id)?.name)
        .filter((n): n is string => !!n);
      relationshipSummary =
        spouseNames.length > 0
          ? `spouse of ${spouseNames.join(" and ")}`
          : "no recorded parents";
    }

    summaries.set(person.id, {
      birthEstimate: person.birth_estimate,
      deathEstimate: person.death_estimate,
      relationshipSummary,
    });
  }
  return summaries;
}

export async function getFamilyId() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("families")
    .select("id")
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error("No family configured for this account yet.");
  }

  return data.id;
}

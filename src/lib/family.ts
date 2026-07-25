import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;

export type PersonSummary = {
  birthEstimate: string | null;
  deathEstimate: string | null;
  relationshipSummary: string;
  // Explicit boolean rather than parsing relationshipSummary's text back
  // apart — used to warn before linking an already-connected person into
  // a second, conflicting set of parents (see linkExistingChildToUnion in
  // app/tree/actions.ts).
  hasRecordedParents: boolean;
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
      hasRecordedParents: parentNames.length > 0,
    });
  }
  return summaries;
}

// Stage 2: reads the caller's deliberately-marked active family_members
// row, rather than the previous `select id from families limit 1` — with
// no ordering and no real filtering beyond whatever RLS happened to let
// through, that returned an arbitrary, implementation-dependent row for
// anyone in more than one family (confirmed empirically before Stage 2:
// consistently whichever row Postgres's default scan order favored, not
// a guaranteed or user-controlled choice). is_active is enforced unique
// per user at the DB level (see the Stage 2 migration), so this is a
// stable, deliberate choice instead.
//
// Deliberately still a zero-argument function — this is called from ~25
// places across the app, all of which already resolve their own `user`
// via getUser() before or after this call. Re-resolving it here again
// (one extra Supabase Auth round trip per call) is the cost of NOT
// threading a user/userId parameter through every one of those call
// sites — the right tradeoff for introducing active-family support
// without a wider refactor across the whole app.
export async function getFamilyId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("No family configured for this account yet.");
  }

  const { data: active } = await supabase
    .from("family_members")
    .select("family_id")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (active) return active.family_id;

  // No row is marked active — shouldn't happen for anything created
  // through create_family/redeem_family_invite (both set it explicitly),
  // but covers a family_members row from any other path. Picks any real
  // membership and marks it active, so this becomes a stable, one-time
  // fix rather than re-picking arbitrarily on every future call.
  const { data: fallback } = await supabase
    .from("family_members")
    .select("family_id")
    .eq("user_id", user.id)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!fallback) {
    throw new Error("No family configured for this account yet.");
  }

  await supabase
    .from("family_members")
    .update({ is_active: true })
    .eq("user_id", user.id)
    .eq("family_id", fallback.family_id);

  return fallback.family_id;
}

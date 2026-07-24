import { createClient } from "@/lib/supabase/server";

// Extracted from app/documents/actions.ts's relationship-signal matching
// code (applyRelationshipSignal) so lib/genealogical-distance.ts can walk
// the exact same real graph — parents/children/spouse/siblings/
// grandparents/grandchildren via unions + union_children — rather than a
// second, independently-written traversal. documents/actions.ts now
// imports these from here instead of defining its own copies.
export type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export async function getRealSpouseIds(
  supabase: SupabaseServerClient,
  personId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("unions")
    .select("parent1_id, parent2_id")
    .or(`parent1_id.eq.${personId},parent2_id.eq.${personId}`);
  return (data ?? [])
    .map((u) => (u.parent1_id === personId ? u.parent2_id : u.parent1_id))
    .filter((id): id is string => !!id);
}

export async function getRealParentIds(
  supabase: SupabaseServerClient,
  personId: string,
): Promise<string[]> {
  const { data: links } = await supabase
    .from("union_children")
    .select("union_id")
    .eq("child_id", personId);
  if (!links || links.length === 0) return [];

  const { data: unions } = await supabase
    .from("unions")
    .select("parent1_id, parent2_id")
    .in(
      "id",
      links.map((l) => l.union_id),
    );
  const ids: string[] = [];
  for (const u of unions ?? []) {
    if (u.parent1_id) ids.push(u.parent1_id);
    if (u.parent2_id) ids.push(u.parent2_id);
  }
  return ids;
}

export async function getRealChildIds(
  supabase: SupabaseServerClient,
  personId: string,
): Promise<string[]> {
  const { data: unions } = await supabase
    .from("unions")
    .select("id")
    .or(`parent1_id.eq.${personId},parent2_id.eq.${personId}`);
  if (!unions || unions.length === 0) return [];

  const { data: links } = await supabase
    .from("union_children")
    .select("child_id")
    .in(
      "union_id",
      unions.map((u) => u.id),
    );
  return (links ?? []).map((l) => l.child_id);
}

// Siblings share a recorded parent union rather than having a direct edge
// to each other — same two-hop shape as getRealParentIds (find the
// union(s) personId is a child of), just followed by every OTHER child of
// those same union(s) instead of the parents themselves.
export async function getRealSiblingIds(
  supabase: SupabaseServerClient,
  personId: string,
): Promise<string[]> {
  const { data: links } = await supabase
    .from("union_children")
    .select("union_id")
    .eq("child_id", personId);
  if (!links || links.length === 0) return [];

  const { data: siblingLinks } = await supabase
    .from("union_children")
    .select("child_id")
    .in(
      "union_id",
      links.map((l) => l.union_id),
    );
  return (siblingLinks ?? [])
    .map((l) => l.child_id)
    .filter((id) => id !== personId);
}

// One more hop than getRealParentIds in the same direction — every parent
// of every recorded parent. "paternal"/"maternal" in a relation string
// narrows which side the document means, but no gender data exists to
// filter by, so (as with getRealParentIds) both sides come back and only
// an independent name match on the candidate's own side can safely boost.
export async function getRealGrandparentIds(
  supabase: SupabaseServerClient,
  personId: string,
): Promise<string[]> {
  const parentIds = await getRealParentIds(supabase, personId);
  const grandparentIdSets = await Promise.all(
    parentIds.map((id) => getRealParentIds(supabase, id)),
  );
  return grandparentIdSets.flat();
}

// Mirror of getRealGrandparentIds, one hop further through getRealChildIds
// instead of getRealParentIds.
export async function getRealGrandchildIds(
  supabase: SupabaseServerClient,
  personId: string,
): Promise<string[]> {
  const childIds = await getRealChildIds(supabase, personId);
  const grandchildIdSets = await Promise.all(
    childIds.map((id) => getRealChildIds(supabase, id)),
  );
  return grandchildIdSets.flat();
}

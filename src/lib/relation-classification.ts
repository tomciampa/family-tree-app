// Extracted from app/documents/actions.ts's relationship-signal matching
// code so other consumers (e.g. lib/gap-prompts.ts, mapping a gap's
// relationToAnchor onto which fixed interview topic it overlaps with) can
// import the same classification rather than re-deriving their own copy.
// Lives outside documents/actions.ts specifically because that file is
// "use server" — every export from a "use server" file must itself be an
// async function (a Next.js Server Actions constraint), which a plain
// synchronous classifier like this can't satisfy.
export function classifyRelationType(
  relation: string | null,
):
  | "spouse"
  | "parent"
  | "grandparent"
  | "child"
  | "grandchild"
  | "sibling"
  | null {
  if (!relation) return null;
  const r = relation.toLowerCase();
  if (/spouse|wife|husband|married/.test(r)) return "spouse";
  // Must run before the plain parent/child checks below — "grandmother"
  // and "grandson" both contain the substrings "mother" and "son", so
  // without this ordering a grandparent/grandchild relation would be
  // silently misread as one generation closer than it actually is (the
  // relationship-signal boost would then check the anchor's direct
  // parents/children instead of grandparents/grandchildren).
  if (/grand(father|mother|parent)/.test(r)) return "grandparent";
  if (/grand(son|daughter|child)/.test(r)) return "grandchild";
  if (/father|mother|parent/.test(r)) return "parent";
  if (/son|daughter|child/.test(r)) return "child";
  if (/sister|brother|sibling/.test(r)) return "sibling";
  return null;
}

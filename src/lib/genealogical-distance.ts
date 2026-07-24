import { createClient } from "@/lib/supabase/server";
import {
  getRealParentIds,
  getRealChildIds,
  getRealSpouseIds,
  getRealSiblingIds,
  getRealGrandparentIds,
  getRealGrandchildIds,
} from "@/lib/relationship-graph";

// Hop weight per edge type — parent/child/spouse are true single edges in
// the underlying graph; sibling/grandparent/grandchild are each already a
// composition of two of those edges (through a shared parent, or through
// an intermediate parent/child), so they're worth 2 even though a single
// helper call produces them.
const HOP_WEIGHT = {
  parent: 1,
  child: 1,
  spouse: 1,
  sibling: 2,
  grandparent: 2,
  grandchild: 2,
} as const;

const DEFAULT_MAX_DEPTH = 5;

// Hop-count distance between two people over the real people/unions/
// union_children graph, reusing the exact relationship-walking helpers
// the relationship-signal matcher already relies on (see
// lib/relationship-graph.ts) rather than a second, independent traversal.
//
// This is a small-integer-weighted shortest path (edges cost 1 or 2), not
// a uniform-weight one, so a plain FIFO BFS isn't safe on its own — it can
// finalize a node's distance via a longer 1+1+1 chain before a shorter
// direct 2-weight edge (e.g. getRealGrandparentIds) to the same node is
// even considered. This runs a straightforward Dijkstra instead: always
// expand whichever un-finalized node currently has the smallest tentative
// distance, which is correct for any non-negative edge weights and simple
// to reason about at this graph's tiny size (~dozens of people).
//
// Capped at maxDepth rather than walking the whole tree — returns null
// ("too distant to be worth surfacing") once every remaining tentative
// distance would exceed it, rather than exhaustively resolving exact
// distances for genuinely far-flung relatives Stage 3 wouldn't use anyway.
export async function genealogicalDistance(
  personIdA: string,
  personIdB: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Promise<number | null> {
  if (personIdA === personIdB) return 0;

  const supabase = await createClient();

  const finalized = new Map<string, number>();
  const tentative = new Map<string, number>([[personIdA, 0]]);

  while (tentative.size > 0) {
    let currentId: string | null = null;
    let currentDist = Infinity;
    for (const [id, d] of tentative) {
      if (d < currentDist) {
        currentDist = d;
        currentId = id;
      }
    }
    if (currentId === null || currentDist > maxDepth) break;

    tentative.delete(currentId);
    if (finalized.has(currentId)) continue;
    finalized.set(currentId, currentDist);

    if (currentId === personIdB) return currentDist;
    if (currentDist >= maxDepth) continue;

    const [parents, children, spouses, siblings, grandparents, grandchildren] = await Promise.all([
      getRealParentIds(supabase, currentId),
      getRealChildIds(supabase, currentId),
      getRealSpouseIds(supabase, currentId),
      getRealSiblingIds(supabase, currentId),
      getRealGrandparentIds(supabase, currentId),
      getRealGrandchildIds(supabase, currentId),
    ]);

    const neighborGroups: Array<[string[], number]> = [
      [parents, HOP_WEIGHT.parent],
      [children, HOP_WEIGHT.child],
      [spouses, HOP_WEIGHT.spouse],
      [siblings, HOP_WEIGHT.sibling],
      [grandparents, HOP_WEIGHT.grandparent],
      [grandchildren, HOP_WEIGHT.grandchild],
    ];

    for (const [ids, weight] of neighborGroups) {
      const candidateDist = currentDist + weight;
      if (candidateDist > maxDepth) continue;
      for (const id of ids) {
        if (finalized.has(id)) continue;
        const existing = tentative.get(id);
        if (existing === undefined || candidateDist < existing) {
          tentative.set(id, candidateDist);
        }
      }
    }
  }

  return null;
}

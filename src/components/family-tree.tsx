"use client";

import { useEffect, useRef, useState } from "react";
import * as f3 from "family-chart";
import type { Data as F3Data, Datum, TreeDatum } from "family-chart";
import "family-chart/styles/family-chart.css";
import type { Tables } from "@/lib/supabase/database.types";
import { updatePersonName, deletePerson } from "@/app/tree/actions";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;

// family-chart has no notion of a "union" — a marriage is implicit from a
// shared spouse pairing, and parentage is implicit from a child listing
// both parent ids. We derive all three of its per-person relationship
// lists (parents/spouses/children) from our own unions + union_children.
function toF3Data(
  people: Person[],
  unions: UnionRow[],
  unionChildren: UnionChild[],
): F3Data {
  const unionsById = new Map(unions.map((u) => [u.id, u]));

  const childToUnionId = new Map<string, string>();
  for (const uc of unionChildren) {
    if (!childToUnionId.has(uc.child_id)) {
      childToUnionId.set(uc.child_id, uc.union_id);
    }
  }

  const spousesByPerson = new Map<string, Set<string>>();
  const childrenByPerson = new Map<string, Set<string>>();
  for (const u of unions) {
    const parents = [u.parent1_id, u.parent2_id].filter(
      (id): id is string => !!id,
    );
    for (const parentId of parents) {
      const set = spousesByPerson.get(parentId) ?? new Set<string>();
      for (const otherId of parents) {
        if (otherId !== parentId) set.add(otherId);
      }
      spousesByPerson.set(parentId, set);
    }
  }
  for (const uc of unionChildren) {
    const union = unionsById.get(uc.union_id);
    if (!union) continue;
    for (const parentId of [union.parent1_id, union.parent2_id]) {
      if (!parentId) continue;
      const set = childrenByPerson.get(parentId) ?? new Set<string>();
      set.add(uc.child_id);
      childrenByPerson.set(parentId, set);
    }
  }

  return people.map((person) => {
    const incomingUnionId = childToUnionId.get(person.id);
    const incomingUnion = incomingUnionId
      ? unionsById.get(incomingUnionId)
      : undefined;
    const parents = incomingUnion
      ? [incomingUnion.parent1_id, incomingUnion.parent2_id].filter(
          (id): id is string => !!id,
        )
      : [];

    const dates = [person.birth_estimate, person.death_estimate]
      .filter(Boolean)
      .join(" – ");

    return {
      id: person.id,
      // family-chart's own types mark data.gender as required ('M' | 'F')
      // for its default card icon; we don't collect gender, so every card
      // just falls back to the library's default icon at runtime — see
      // the "as unknown as F3Data" cast below.
      data: {
        "first name": person.is_placeholder ? `${person.name} (?)` : person.name,
        dates,
      },
      rels: {
        parents,
        spouses: [...(spousesByPerson.get(person.id) ?? [])],
        children: [...(childrenByPerson.get(person.id) ?? [])],
      },
    };
  }) as unknown as F3Data;
}

// --- Supplementary ancestor-branch overlay -----------------------------
//
// family-chart's own layout only ever traces ONE person's blood line (the
// current "main"), recursively through calculateTree's d3.hierarchy — a
// spouse attached at any generation is rendered, but their own parents
// are never traced unless they themselves become main (confirmed by
// reading family-chart's source: hierarchyGetterParents recurses purely
// via rels.parents from main, with no multi-root or "pinned branch"
// concept anywhere in the library). So showing a second, independent
// ancestor chain (e.g. Peggy's own parents while Robert stays main)
// can't be done through family-chart's own API at all.
//
// This section hand-renders that second chain instead, as plain
// absolutely-positioned DOM elements appended alongside family-chart's
// own cards inside the same #htmlSvg .cards_view div — so they inherit
// the exact same pan/zoom CSS transform family-chart already applies to
// that div (confirmed in family-chart's source: onZoomSetup applies one
// shared translate/scale to both the SVG link layer and this HTML card
// layer). We do not touch calculateTree, main_id, or any of
// family-chart's own positioning — we only read the DOM position it
// already computed for the anchor card, and add our own cards/lines from
// there. setAfterUpdate (a supported public hook) tells us when
// family-chart has re-rendered, so we can re-sync if the anchor moved.

type ParentsLookup = (personId: string) => string[];

function buildParentsLookup(
  unions: UnionRow[],
  unionChildren: UnionChild[],
): ParentsLookup {
  const childToUnionId = new Map<string, string>();
  for (const uc of unionChildren) {
    if (!childToUnionId.has(uc.child_id)) {
      childToUnionId.set(uc.child_id, uc.union_id);
    }
  }
  const unionsById = new Map(unions.map((u) => [u.id, u]));
  return (personId: string) => {
    const unionId = childToUnionId.get(personId);
    const union = unionId ? unionsById.get(unionId) : undefined;
    if (!union) return [];
    return [union.parent1_id, union.parent2_id].filter(
      (id): id is string => !!id,
    );
  };
}

type SpousesLookup = (personId: string) => string[];

function buildSpousesLookup(unions: UnionRow[]): SpousesLookup {
  const spousesByPerson = new Map<string, string[]>();
  for (const u of unions) {
    const parents = [u.parent1_id, u.parent2_id].filter(
      (id): id is string => !!id,
    );
    for (const id of parents) {
      const others = parents.filter((other) => other !== id);
      spousesByPerson.set(id, [
        ...(spousesByPerson.get(id) ?? []),
        ...others,
      ]);
    }
  }
  return (personId: string) => spousesByPerson.get(personId) ?? [];
}

// A safety cap on recursion depth, not the depth normally used — callers
// pass however many generations are actually toggled open right now (see
// countUnlockedDepth), recomputed fresh on every render as ONE unified
// proportional-width pass down to that depth. That "one unified pass"
// part is what actually matters: computing each newly-revealed generation
// as its own independent fan (an earlier version of this) recomputed
// position and "which way to grow" locally at each level, which caused a
// real bug — two different people's cards landing on the exact same
// coordinates (verified: Robert's mother May Louise and Peggy's father
// Patrick both placed at x=-625, same y). A single pass confines every
// branch's descendants to the horizontal slot already reserved for it
// (see layoutAncestors), which is what actually guarantees siblings'
// sub-trees can never collide, at any depth. Reserving width for a
// chain's full REAL depth regardless of how much is toggled open was
// tried too, and separately rejected: mostly-empty branches ballooned
// the gaps between the handful of cards actually on screen (verified:
// Robert ended up ~3000px from Jeff after reserving space for ~5 real
// generations while only 2 were drawn).
const SUPPLEMENTARY_MAX_DEPTH = 20;
const SUPPLEMENTARY_SLOT_WIDTH = 250; // matches setCardXSpacing
const SUPPLEMENTARY_LEVEL_SEP = 150; // matches setCardYSpacing
const SUPPLEMENTARY_CARD_W = 220; // matches family-chart's default card_dim
const SUPPLEMENTARY_CARD_H = 70;

function countAncestorLeaves(
  personId: string,
  getParents: ParentsLookup,
  depthBudget: number,
): number {
  if (depthBudget <= 0) return 1;
  const parents = getParents(personId);
  if (parents.length === 0) return 1;
  return parents.reduce(
    (sum, pid) => sum + countAncestorLeaves(pid, getParents, depthBudget - 1),
    0,
  );
}

// How many generations up from rootId are actually toggled open right
// now. Passed as the layout's depth budget instead of always using
// SUPPLEMENTARY_MAX_DEPTH — reserving full-depth width for a chain that's
// only 2 generations expanded so far produced huge, mostly-empty gaps
// between the handful of cards actually on screen (verified: Robert
// ended up ~3000px from Jeff after reserving width for the chain's full
// ~5 real generations, even though only Robert and Anthony were drawn).
// Recomputed fresh on every render, so the layout is always a complete,
// correctly non-overlapping pass for whatever's currently unlocked —
// growing a bit wider (and reflowing existing cards) each time one more
// generation gets toggled open, rather than pre-allocating for
// generations nobody has asked to see yet.
function countUnlockedDepth(
  personId: string,
  getParents: ParentsLookup,
  expandedIds: Set<string>,
): number {
  if (!expandedIds.has(personId)) return 0;
  const parents = getParents(personId);
  if (parents.length === 0) return 1;
  return 1 + Math.max(0, ...parents.map((pid) => countUnlockedDepth(pid, getParents, expandedIds)));
}

type AncestorPos = { id: string; x: number; y: number };
type AncestorLink = { fromId: string; toId: string; kind: "parent" | "spouse" };

// Standard proportional-width pedigree-chart layout: each person's total
// horizontal slot is split between their parents in proportion to how
// many ultimate-ancestor "leaves" sit in each parent's own sub-branch, and
// each parent's own recursion is then confined to exactly that slot
// (startCursor = px - w/2 below) — this is what guarantees two siblings'
// sub-branches can never overlap each other regardless of how deep or
// lopsided (e.g. one side's data ending sooner than the other) the chain
// gets. Computing the WHOLE tree this way in one pass (root to however
// deep the real data goes) is what makes that guarantee hold; computing
// it one newly-toggled generation at a time, independently, does not —
// see the SUPPLEMENTARY_MAX_DEPTH comment above for the bug that caused.
//
// bias matters only for the root: the anchor (e.g. Peggy) sits right next
// to their spouse (Robert), who's either main himself or another
// already-placed card — a tree centered on the anchor would extend half
// its width toward the spouse and collide with that. Anchoring the whole
// tree's near edge at the anchor's own x, growing away from the spouse
// instead, keeps the two apart.
function layoutAncestors(
  anchorId: string,
  anchorX: number,
  anchorY: number,
  getParents: ParentsLookup,
  bias: "left" | "right" | "center",
  depth: number,
): { positions: AncestorPos[]; links: AncestorLink[] } {
  const positions: AncestorPos[] = [];
  const links: AncestorLink[] = [];

  function recurse(
    personId: string,
    x: number,
    y: number,
    width: number,
    depth: number,
    startCursor: number,
  ) {
    if (depth <= 0) return;
    const parents = getParents(personId);
    if (parents.length === 0) return;

    const leafCounts = parents.map((pid) =>
      countAncestorLeaves(pid, getParents, depth - 1),
    );
    const totalLeaves = leafCounts.reduce((a, b) => a + b, 0) || 1;

    let cursor = startCursor;
    parents.forEach((pid, i) => {
      const w = width * (leafCounts[i] / totalLeaves);
      const px = cursor + w / 2;
      const py = y - SUPPLEMENTARY_LEVEL_SEP;
      cursor += w;
      positions.push({ id: pid, x: px, y: py });
      links.push({ fromId: personId, toId: pid, kind: "parent" });
      recurse(pid, px, py, w, depth - 1, px - w / 2);
    });
    if (parents.length === 2) {
      links.push({ fromId: parents[0], toId: parents[1], kind: "spouse" });
    }
  }

  const totalWidth =
    countAncestorLeaves(anchorId, getParents, depth) * SUPPLEMENTARY_SLOT_WIDTH;
  const startCursor =
    bias === "left"
      ? anchorX - totalWidth
      : bias === "right"
        ? anchorX
        : anchorX - totalWidth / 2;
  recurse(anchorId, anchorX, anchorY, totalWidth, depth, startCursor);

  return { positions, links };
}

function clearSupplementaryOverlay(container: HTMLElement) {
  container
    .querySelectorAll(".supplementary-node")
    .forEach((el) => el.remove());
}

function getCardWorldPos(
  container: HTMLElement,
  personId: string,
): { x: number; y: number } | null {
  const card = container.querySelector<HTMLElement>(
    `.card[data-id="${personId}"]`,
  );
  const cont = card?.closest<HTMLElement>(".card_cont");
  const match = cont?.style.transform.match(
    /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/,
  );
  if (!match) return null;
  return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
}

function renderSupplementaryOverlay(
  container: HTMLElement,
  expandedIds: Set<string>,
  peopleById: Map<string, Person>,
  getParents: ParentsLookup,
  getSpouses: SpousesLookup,
  onToggle: (id: string) => void,
) {
  const cardsView = container.querySelector<HTMLElement>(
    "#htmlSvg .cards_view",
  );
  if (!cardsView) return;

  clearSupplementaryOverlay(cardsView);

  // Every person this pass has drawn a supplementary card for, so a
  // second root (or a shared ancestor reached through two different
  // roots) doesn't stack a duplicate on top — combined with
  // getCardWorldPos (only ever matches real family-chart cards, never our
  // own plain-div supplementary ones) this doubles as the full "already
  // shown somewhere, don't duplicate" check from before.
  const drawnPositions = new Map<string, AncestorPos>();
  function resolvePos(id: string): { x: number; y: number } | null {
    return getCardWorldPos(container, id) ?? drawnPositions.get(id) ?? null;
  }

  // Only a native card (is_ancestry, or main's own spouse — see
  // setOnCardUpdate) is ever a "root": every other id in expandedIds is
  // itself somewhere inside a root's own tree, reached transitively via
  // the unlock check below, and doesn't need its own separate pass.
  for (const rootId of expandedIds) {
    const anchorPos = getCardWorldPos(container, rootId);
    if (!anchorPos) continue;
    const { x: anchorX, y: anchorY } = anchorPos;

    // Grow away from wherever the root's spouse is currently rendered, so
    // a father's-side tree and a mother's-side tree (or either one and
    // the root's own spouse card) diverge instead of colliding.
    let bias: "left" | "right" | "center" = "center";
    for (const spouseId of getSpouses(rootId)) {
      const spousePos = resolvePos(spouseId);
      if (spousePos) {
        bias = spousePos.x > anchorX ? "left" : "right";
        break;
      }
    }

    // Only as deep as what's actually toggled open right now (see
    // countUnlockedDepth) — but still computed as ONE unified
    // proportional-width pass down to that depth (see layoutAncestors),
    // not one newly-toggled generation at a time, which is what
    // guarantees no overlap between branches.
    const depth = Math.min(
      countUnlockedDepth(rootId, getParents, expandedIds),
      SUPPLEMENTARY_MAX_DEPTH,
    );
    const { positions, links } = layoutAncestors(
      rootId,
      anchorX,
      anchorY,
      getParents,
      bias,
      depth,
    );
    const posById = new Map(positions.map((p) => [p.id, p]));

    // A position is only actually drawn once every ancestor between it
    // and the root has itself been toggled open — i.e. the user clicked
    // through to reveal it. childOfMap answers "whose parent is this
    // position" (from the "parent" links); walking that back to the root
    // is exactly the expandedIds chain the ▲/▼ toggles build up one click
    // at a time.
    const childOfMap = new Map<string, string>();
    for (const link of links) {
      if (link.kind === "parent") childOfMap.set(link.toId, link.fromId);
    }
    function isUnlocked(id: string): boolean {
      if (id === rootId) return true;
      const childId = childOfMap.get(id);
      if (!childId) return false;
      return expandedIds.has(childId) && isUnlocked(childId);
    }
    const isVisible = (id: string) => id === rootId || isUnlocked(id);

    const getPos = (id: string) =>
      id === rootId ? { x: anchorX, y: anchorY } : posById.get(id);

    for (const link of links) {
      if (!isVisible(link.fromId) || !isVisible(link.toId)) continue;
      const from = getPos(link.fromId);
      const to = getPos(link.toId);
      if (!from || !to) continue;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const line = document.createElement("div");
      line.className = "supplementary-node";
      line.style.cssText = `position: absolute; top: 0; left: 0; width: ${length}px; height: 2px; background: var(--male-color, #5c7360); transform: translate(${from.x}px, ${from.y}px) rotate(${angle}deg); transform-origin: 0 50%; pointer-events: none;`;
      cardsView.appendChild(line);
    }

    const visiblePositions = positions.filter(
      (p) => isUnlocked(p.id) && !resolvePos(p.id),
    );
    for (const pos of visiblePositions) {
      const person = peopleById.get(pos.id);
      const name = person
        ? person.is_placeholder
          ? `${person.name} (?)`
          : person.name
        : "Unknown";

      const card = document.createElement("div");
      card.className = "supplementary-node";
      card.dataset.id = pos.id;
      card.style.cssText = `position: absolute; top: 0; left: 0; width: ${SUPPLEMENTARY_CARD_W}px; height: ${SUPPLEMENTARY_CARD_H}px; transform: translate(${pos.x - SUPPLEMENTARY_CARD_W / 2}px, ${pos.y - SUPPLEMENTARY_CARD_H / 2}px); background: var(--genderless-color, #f7f1e3); color: var(--text-color, #2b2015); border-radius: 6px; border: 1px solid rgba(43,32,21,0.35); box-shadow: 0 1px 3px rgba(0,0,0,0.15); display: flex; align-items: center; padding: 0 12px; font-size: 13px; line-height: 1.2; pointer-events: none;`;

      const label = document.createElement("span");
      label.textContent = name;
      card.appendChild(label);

      // Same "keep going deeper" toggle as native ancestor cards — see
      // the setOnCardUpdate wiring for those. A supplementary card needs
      // its own button built by hand (it's a plain div, not family-chart's
      // card template), re-enabling pointer-events just for the button
      // since the card itself stays click-through.
      if (getParents(pos.id).length > 0) {
        const isExpanded = expandedIds.has(pos.id);
        const toggleButton = document.createElement("button");
        toggleButton.type = "button";
        toggleButton.textContent = isExpanded ? "▼" : "▲";
        toggleButton.setAttribute(
          "aria-label",
          isExpanded ? `Hide ${name}'s ancestors` : `Show ${name}'s ancestors`,
        );
        toggleButton.style.cssText =
          "position: absolute; top: -6px; left: 50%; transform: translateX(-50%); " +
          "width: 22px; height: 18px; border-radius: 9px; border: none; " +
          `background: ${isExpanded ? "var(--female-color, #a97b52)" : "var(--male-color, #5c7360)"}; color: white; font-size: 9px; ` +
          "line-height: 1; cursor: pointer; display: flex; align-items: center; " +
          "justify-content: center; box-shadow: 0 1px 3px rgba(0,0,0,0.4); pointer-events: auto;";
        toggleButton.addEventListener("click", (e) => {
          e.stopPropagation();
          onToggle(pos.id);
        });
        card.appendChild(toggleButton);
      }

      cardsView.appendChild(card);
      drawnPositions.set(pos.id, pos);
    }
  }
}

function touchedIds(unions: UnionRow[], unionChildren: UnionChild[]) {
  const ids = new Set<string>();
  for (const u of unions) {
    if (u.parent1_id) ids.add(u.parent1_id);
    if (u.parent2_id) ids.add(u.parent2_id);
  }
  for (const uc of unionChildren) ids.add(uc.child_id);
  return ids;
}

// family-chart shows one connected tree at a time, centered on a "main"
// person, with no way to display several disconnected family branches
// together. Default the initial focus to whichever root ancestor (no
// recorded parents) has the most total descendants, so the first view
// covers as much of the tree as possible.
function pickDefaultMain(
  people: Person[],
  unions: UnionRow[],
  unionChildren: UnionChild[],
) {
  const childToUnionId = new Map<string, string>();
  for (const uc of unionChildren) {
    if (!childToUnionId.has(uc.child_id)) {
      childToUnionId.set(uc.child_id, uc.union_id);
    }
  }
  const childrenByParent = new Map<string, string[]>();
  const unionsById = new Map(unions.map((u) => [u.id, u]));
  for (const uc of unionChildren) {
    const union = unionsById.get(uc.union_id);
    if (!union) continue;
    for (const parentId of [union.parent1_id, union.parent2_id]) {
      if (!parentId) continue;
      const list = childrenByParent.get(parentId) ?? [];
      list.push(uc.child_id);
      childrenByParent.set(parentId, list);
    }
  }

  function countDescendants(personId: string, seen = new Set<string>()): number {
    if (seen.has(personId)) return 0;
    seen.add(personId);
    let count = 0;
    for (const childId of childrenByParent.get(personId) ?? []) {
      count += 1 + countDescendants(childId, seen);
    }
    return count;
  }

  const roots = people.filter((p) => !childToUnionId.has(p.id));
  let best: { id: string; count: number } | null = null;
  for (const root of roots) {
    const count = countDescendants(root.id);
    if (!best || count > best.count) best = { id: root.id, count };
  }
  return best?.id ?? people[0]?.id;
}

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
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof f3.createChart> | null>(null);
  const touched = touchedIds(unions, unionChildren);
  const connected = people.filter((p) => touched.has(p.id));
  const unplacedPeople = people.filter((p) => !touched.has(p.id));
  const hasConnected = connected.length > 0;

  // Read via refs inside the effects instead of listing these as
  // dependencies: an inline onPersonClick callback from the caller changes
  // identity on every render, and people/unions change identity on every
  // save (a fresh server-fetched array each time). None of that should
  // tear down the chart — see the two effects below.
  const onPersonClickRef = useRef(onPersonClick);
  onPersonClickRef.current = onPersonClick;
  const peopleByIdRef = useRef(new Map<string, Person>());
  peopleByIdRef.current = new Map(people.map((p) => [p.id, p]));
  const unionsRef = useRef(unions);
  unionsRef.current = unions;

  // The supplementary ancestor branches currently shown, independent of
  // family-chart's own "main" — see the "Supplementary ancestor-branch
  // overlay" section above for why this can't be done through
  // family-chart's own API. A Set (not a single id) so a father's-side
  // chain and a mother's-side chain can both stay expanded at once,
  // independently — the actual ask, now that main's own ancestryDepth is
  // capped to 1 (see chart setup below) so neither side is natively drawn.
  const [expandedAncestorIds, setExpandedAncestorIds] = useState<Set<string>>(
    () => new Set(),
  );
  const expandedAncestorIdsRef = useRef(expandedAncestorIds);
  expandedAncestorIdsRef.current = expandedAncestorIds;
  const getParentsRef = useRef<ParentsLookup>(() => []);
  getParentsRef.current = buildParentsLookup(unions, unionChildren);
  const getSpousesRef = useRef<SpousesLookup>(() => []);
  getSpousesRef.current = buildSpousesLookup(unions);

  // Shared by both the native-card toggle (setOnCardUpdate, below) and the
  // supplementary-card toggle (built by hand inside
  // renderSupplementaryOverlay) — one toggle implementation regardless of
  // which kind of card it's attached to, so "expand this person's
  // ancestors" behaves identically at any depth in the chain.
  const toggleExpandedRef = useRef<(id: string) => void>(() => {});
  toggleExpandedRef.current = (id: string) => {
    setExpandedAncestorIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Both the chart-creation effect (registering setAfterUpdate once) and
  // the expandedAncestorIds-change effect below need to trigger the exact
  // same re-render; kept in a ref so the afterUpdate hook (registered once
  // at chart creation) always calls the latest version.
  const syncOverlayRef = useRef<() => void>(() => {});
  syncOverlayRef.current = () => {
    const container = containerRef.current;
    if (!container) return;
    renderSupplementaryOverlay(
      container,
      expandedAncestorIdsRef.current,
      peopleByIdRef.current,
      getParentsRef.current,
      getSpousesRef.current,
      (id) => toggleExpandedRef.current(id),
    );
  };

  // Create the chart once (and only re-create if the container itself goes
  // away and comes back, e.g. the tree has no connected people yet). This
  // intentionally does NOT depend on people/unions/unionChildren — see the
  // updateData effect below, which is what keeps the chart in sync with new
  // data without tearing down and losing the current focused person.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasConnected) return;

    const unionBetween = (id1: string, id2: string) =>
      unionsRef.current.find(
        (u) =>
          (u.parent1_id === id1 && u.parent2_id === id2) ||
          (u.parent1_id === id2 && u.parent2_id === id1),
      );

    const data = toF3Data(connected, unions, unionChildren);
    const mainId = pickDefaultMain(connected, unions, unionChildren);

    const f3Chart = f3
      .createChart(container, data)
      .setCardXSpacing(250)
      .setCardYSpacing(150)
      .setOrientationVertical()
      .setSingleParentEmptyCard(false)
      // Capped to 1 (immediate parents only), not the previous 25: with
      // showSiblingsOfMain below, main is meant to be a person like Scott
      // (not one of his parents), so their own full blood ancestry going
      // up would otherwise auto-render both parents' entire chains,
      // uncollapsible and with no way to show one side without the other.
      // Both sides are handled instead by the supplementary overlay,
      // toggled independently per parent — see the "Supplementary
      // ancestor-branch overlay" section above.
      .setAncestryDepth(1)
      .setProgenyDepth(25)
      // family-chart's own documented option (calculateTree's
      // show_siblings_of_main) for exactly the "stable row" this app
      // needs: main's siblings, laid out alongside them, natively — no
      // custom sibling-rendering required. Confirmed via source
      // (setupSiblings) this only adds bare sibling cards (no spouse/
      // children of their own), which is fine; recentering onto any one
      // of them keeps the same sibling group in view, since they share
      // the same parents.
      .setShowSiblingsOfMain(true)
      .setLinkSpouseText((sp1: TreeDatum, sp2: TreeDatum) => {
        const union = unionBetween(sp1.data.id, sp2.data.id);
        return union?.note ?? "";
      });

    if (mainId) f3Chart.updateMainId(mainId);

    // family-chart only shows one connected family cluster at a time. If a
    // person is added before they're linked (by marriage) to the main
    // cluster, they'd otherwise be invisible — not in the unplaced list
    // (they do have relatives) and not reachable from the focused person.
    // A search-to-jump control covers the whole dataset regardless of
    // which cluster is currently in view.
    f3Chart.setPersonDropdown((d: { data: { "first name": string } }) => d.data["first name"]);

    const f3Card = f3Chart
      .setCardHtml()
      .setCardDisplay([["first name"], ["dates"]])
      // family-chart's own built-in indicator: shows a small icon on a
      // card whenever that person's parents, spouses, or children aren't
      // all present in the currently-rendered tree (ancestry/progeny
      // depth limits, or a not-yet-explored branch). Not a sibling count
      // specifically, but a person whose own parents aren't shown yet is
      // exactly the "there might be more here" cue we want — clicking
      // through reveals the rest, including any siblings.
      .setMiniTree(true);

    // Clicking the card itself only re-centers the tree on that person —
    // family-chart's own default click behavior, nothing more. Opening our
    // "add to this person's record" panel is a separate, explicit action
    // (the "+" button below), not something that should happen just from
    // navigating the tree.
    //
    // Exception: is_ancestry cards (with ancestryDepth capped to 1, this is
    // only ever exactly the main person's two immediate parents — everyone
    // else, including main and their siblings, has is_ancestry unset).
    // Recentering onto a parent replaces the whole view with THAT parent's
    // own sibling/spouse context, discarding the stable sibling row that
    // was the point of being here — the parent's card is only meant to be
    // explored via its own ▲ toggle (further down), never by becoming main.
    f3Card.setOnCardClick((e: MouseEvent, d: TreeDatum) => {
      if (d.is_ancestry) return;
      f3Card.onCardClickDefault(e, d);
    });

    // EditTree gives us a ready-made name-edit + delete form (slide-out
    // panel, docked via the library's own .f3-form-cont) instead of us
    // building a custom one. We only use it for editing a person's name and
    // deleting them — its own "add relative" / "remove relative"
    // sub-flows only mutate family-chart's in-memory copy, not our Supabase
    // tables, so they're disabled (setCanAdd + CSS, see globals.css) in
    // favor of the "+" button below, which is already wired to our real
    // add-relative forms.
    const f3EditTree = f3Chart
      .editTree()
      .setFields([{ type: "text", label: "Name", id: "first name" }])
      .setEditFirst(true)
      .setCanAdd(() => ({ parent: false, spouse: false, child: false }))
      .setOnSubmit(
        async (
          e: Event,
          datum: Datum,
          _applyChanges: () => void,
          postSubmit: () => void,
        ) => {
          e.preventDefault();
          const formData = new FormData(e.target as HTMLFormElement);
          const newName = String(formData.get("first name") ?? "").trim();
          if (!newName) {
            window.alert("Name is required.");
            return;
          }
          const result = await updatePersonName(datum.id, newName);
          if (result?.error) {
            window.alert(result.error);
            return;
          }
          // Don't call applyChanges() — the corrected name will arrive
          // through the normal Supabase refetch + updateData() sync below,
          // so the chart and the database never briefly disagree.
          postSubmit();
        },
      )
      .setOnDelete(
        async (
          datum: Datum,
          _deletePersonLocally: () => void,
          postSubmit: (props: unknown) => void,
        ) => {
          const label = datum.data["first name"] ?? "this person";
          if (
            !window.confirm(
              `Delete ${label}? This removes them and their relationships from the tree permanently.`,
            )
          ) {
            return;
          }
          const result = await deletePerson(datum.id);
          if (result?.error) {
            window.alert(result.error);
            return;
          }
          // The library's postSubmit for a delete already carries { delete:
          // true } internally (baked in by EditTree before calling us) —
          // see its onDelete wiring. Close the form ourselves too since
          // is_fixed (the default) otherwise leaves it open after a delete.
          postSubmit(undefined);
          f3EditTree.closeForm();
        },
      );

    // setOnCardUpdate is called every time a card's DOM is (re)rendered,
    // right after its base markup is set — the supported hook for
    // attaching extra elements without reimplementing the card template
    // ourselves. Both buttons stop propagation so they don't also trigger
    // the card's re-center click above.
    f3Card.setOnCardUpdate(function (this: HTMLElement, d: TreeDatum) {
      const cardEl = this.querySelector<HTMLElement>(".card");
      if (!cardEl) return;

      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.textContent = "+";
      addButton.setAttribute(
        "aria-label",
        `Add to ${d.data.data["first name"]}'s record`,
      );
      addButton.style.cssText =
        "position: absolute; top: -6px; right: -6px; width: 22px; height: 22px; " +
        "border-radius: 50%; border: none; background: #2563eb; color: white; " +
        "font-size: 14px; line-height: 1; cursor: pointer; display: flex; " +
        "align-items: center; justify-content: center; box-shadow: 0 1px 3px rgba(0,0,0,0.4);";
      addButton.addEventListener("click", (e) => {
        e.stopPropagation();
        const person = peopleByIdRef.current.get(d.data.id);
        if (person) onPersonClickRef.current?.(person);
      });
      cardEl.appendChild(addButton);

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.textContent = "✎";
      editButton.setAttribute(
        "aria-label",
        `Edit or delete ${d.data.data["first name"]}`,
      );
      editButton.style.cssText =
        "position: absolute; top: -6px; left: -6px; width: 22px; height: 22px; " +
        "border-radius: 50%; border: none; background: #52525b; color: white; " +
        "font-size: 12px; line-height: 1; cursor: pointer; display: flex; " +
        "align-items: center; justify-content: center; box-shadow: 0 1px 3px rgba(0,0,0,0.4);";
      editButton.addEventListener("click", (e) => {
        e.stopPropagation();
        f3EditTree.openFormWithId(d.data.id);
      });
      cardEl.appendChild(editButton);

      // Independent of family-chart's own "main" hierarchy — see the
      // "Supplementary ancestor-branch overlay" section above. Offered on
      // is_ancestry cards (with ancestryDepth capped to 1, that's exactly
      // main's two immediate parents) AND on main's own spouse (depth 0,
      // main false — family-chart never traces a spouse's own ancestry
      // natively, at any depth, so without this a card like Maxine when
      // Tom is main would have no way to reveal the Dubois side at all).
      // Deliberately NOT offered on main itself, siblings, or descendants
      // and their spouses — their own recorded parents are either already
      // shown (main, siblings) or would be redundant once shown (a
      // descendant's parents are main/main's spouse themselves).
      const isMainSpouse = d.depth === 0 && !d.data.main;
      if (
        (d.is_ancestry || isMainSpouse) &&
        getParentsRef.current(d.data.id).length > 0
      ) {
        const isExpanded = expandedAncestorIdsRef.current.has(d.data.id);
        const expandButton = document.createElement("button");
        expandButton.type = "button";
        // ▼ (open) vs ▲ (closed) so the icon itself shows current state
        // and what clicking it will do — the previous version always
        // showed ▲ regardless of state, which is why it read as inert.
        expandButton.textContent = isExpanded ? "▼" : "▲";
        expandButton.setAttribute(
          "aria-label",
          isExpanded
            ? `Hide ${d.data.data["first name"]}'s ancestors`
            : `Show ${d.data.data["first name"]}'s ancestors`,
        );
        expandButton.style.cssText =
          "position: absolute; top: -6px; left: 50%; transform: translateX(-50%); " +
          "width: 22px; height: 18px; border-radius: 9px; border: none; " +
          `background: ${isExpanded ? "var(--female-color, #a97b52)" : "var(--male-color, #5c7360)"}; color: white; font-size: 9px; ` +
          "line-height: 1; cursor: pointer; display: flex; align-items: center; " +
          "justify-content: center; box-shadow: 0 1px 3px rgba(0,0,0,0.4);";
        expandButton.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleExpandedRef.current(d.data.id);
        });
        cardEl.appendChild(expandButton);
      }
    });

    // Our own supplementary overlay isn't touched by family-chart's update
    // cycle at all, so it needs its own resync whenever family-chart
    // re-renders for any reason (new main, data change) — setAfterUpdate
    // is a supported public hook for exactly this ("run something after
    // every tree update"), not a workaround.
    //
    // Crucially, this resync can't happen synchronously inside the hook
    // itself: family-chart's own card repositioning (updateCardsHtml, in
    // its source) runs via a d3 .transition().style("transform", ...) that
    // hasn't applied its first interpolated frame yet at the moment
    // setAfterUpdate fires (both happen in the same synchronous call
    // stack, before any repaint). Reading a card's position at that instant
    // via getCardWorldPos returns its PRE-update transform — stale, not
    // the new one — with nothing to correct it afterward, since
    // setAfterUpdate only fires once per update. On a recenter that
    // actually moves the anchor card (e.g. expanding Peggy's ancestry, then
    // clicking Robert to make him main), this stranded the overlay at
    // Peggy's old on-screen position while her real card glided away to
    // its new spot — which reads exactly like "her chain disappeared" once
    // the stale spot lands somewhere unhelpful. Deferring the resync until
    // after the transition completes (using the actual transition_time
    // family-chart hands back in props, not a guessed constant) reads the
    // anchor's final settled position instead.
    f3Chart.setAfterUpdate((props?: { transition_time?: number }) => {
      const transitionTime = props?.transition_time ?? 0;
      if (transitionTime > 0) {
        window.setTimeout(() => syncOverlayRef.current(), transitionTime + 50);
      } else {
        syncOverlayRef.current();
      }
    });

    f3Chart.updateTree({ initial: true });
    chartRef.current = f3Chart;

    return () => {
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasConnected]);

  // Re-render the supplementary overlay whenever the user toggles which
  // branch(es) are expanded. (The family-chart-triggered case — main
  // changing, data changing — is covered by the setAfterUpdate hook above
  // instead, since those don't change this state at all.) A fresh Set is
  // constructed on every toggle, so reference equality alone is enough to
  // fire this on every add/remove.
  //
  // Also re-run family-chart's own updateTree: the ▲/▼ toggle button lives
  // inside setOnCardUpdate, which only re-executes when family-chart
  // itself re-renders a card — toggling our own React state alone doesn't
  // do that, so without this the icon would silently go stale after the
  // very first click (stuck on ▲ forever, regardless of actual state).
  // Nothing on screen actually moves (main and all positions are
  // unchanged), so the transition this schedules is visually a no-op; the
  // immediate syncOverlayRef call above still gives instant overlay
  // feedback rather than waiting on that transition.
  useEffect(() => {
    syncOverlayRef.current();
    chartRef.current?.updateTree({ initial: false, tree_position: "inherit" });
  }, [expandedAncestorIds]);

  // Keep the chart's data in sync with new saves via family-chart's own
  // updateData(), instead of tearing down and recreating the chart (the
  // previous approach). updateData() only resets the focused/main person if
  // that person no longer exists in the new data — otherwise it's left
  // alone, so adding a second child to Joe and Adriana while viewing them
  // keeps them in focus instead of resetting to the tree's root person.
  useEffect(() => {
    if (!chartRef.current) return;
    const data = toF3Data(connected, unions, unionChildren);
    chartRef.current.updateData(data);
    chartRef.current.updateTree({ initial: false, tree_position: "inherit" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, unions, unionChildren]);

  if (people.length === 0) return null;

  return (
    <div>
      {connected.length > 0 && (
        // Theming lives in globals.css as CSS custom properties
        // (--background-color/--text-color/--male-color/--female-color),
        // family-chart's own documented mechanism — plus a couple of
        // targeted overrides for the few elements (connector lines, the
        // mini-tree badge's icon strokes) that set an inline SVG
        // stroke="#fff" instead of using those variables. CSS always wins
        // over inline SVG presentation attributes regardless of
        // specificity, so a plain selector is enough — no !important
        // fighting needed. The f3-cont class matters too: without it,
        // family-chart's own color: var(--text-color) base rule
        // (`.f3.f3-cont`) never applies, and elements with no color of
        // their own (e.g. the search dropdown) fall back to inheriting
        // this page's default text color instead.
        <div
          ref={containerRef}
          className="f3 f3-cont h-[75vh] w-full overflow-hidden rounded-lg"
        />
      )}

      {unplacedPeople.length > 0 && (
        <div className="mt-10 border-t border-gray-200 pt-6 dark:border-gray-800">
          <h2 className="mb-3 text-sm font-medium text-gray-500">
            Not yet connected to the tree
          </h2>
          <ul className="flex flex-wrap gap-2">
            {unplacedPeople.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPersonClick?.(p)}
                  className="flex min-w-[8rem] flex-col items-center rounded border border-gray-300 bg-white px-3 py-2 text-center text-sm shadow-sm transition-colors hover:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-gray-600"
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-gray-500">
                    {p.birth_estimate ?? "?"}
                    {" – "}
                    {p.death_estimate ?? ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

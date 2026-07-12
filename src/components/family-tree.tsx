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

// Capped at 1 (direct parents only), not the 6 first tried: a deep
// multi-generation supplementary chain fans out wide enough to visually
// collide with family-chart's own rendering of the main person's blood
// ancestry, which occupies the same coordinate space with no awareness of
// this overlay at all (confirmed by testing — 1 generation doesn't
// collide, deeper ones did). Going deeper safely would mean either
// collision-avoidance against family-chart's own card positions, or
// making supplementary cards themselves independently expandable so
// depth grows one click at a time instead of all at once — real,
// separate follow-up work, not done here.
const SUPPLEMENTARY_MAX_DEPTH = 1;
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

type AncestorPos = { id: string; x: number; y: number };
type AncestorLink = { fromId: string; toId: string; kind: "parent" | "spouse" };

// Standard proportional-width pedigree-chart layout: each person's total
// horizontal slot is split between their parents in proportion to how
// many ultimate-ancestor "leaves" sit in each parent's own sub-branch —
// this is what guarantees no overlaps regardless of how deep or lopsided
// (e.g. one side's data ending sooner than the other) the chain gets.
//
// bias matters because the anchor (e.g. Peggy) sits right next to their
// spouse (Robert), who family-chart is independently rendering their own
// blood ancestry above — a fan centered on the anchor would extend half
// its width toward the spouse and collide with that. Anchoring the fan's
// near edge at the anchor's own x, growing away from the spouse instead,
// keeps the two apart.
function layoutAncestors(
  anchorId: string,
  anchorX: number,
  anchorY: number,
  getParents: ParentsLookup,
  bias: "left" | "right" | "center",
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
    countAncestorLeaves(anchorId, getParents, SUPPLEMENTARY_MAX_DEPTH) *
    SUPPLEMENTARY_SLOT_WIDTH;
  const startCursor =
    bias === "left"
      ? anchorX - totalWidth
      : bias === "right"
        ? anchorX
        : anchorX - totalWidth / 2;
  recurse(
    anchorId,
    anchorX,
    anchorY,
    totalWidth,
    SUPPLEMENTARY_MAX_DEPTH,
    startCursor,
  );

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
  expandedId: string | null,
  peopleById: Map<string, Person>,
  getParents: ParentsLookup,
  getSpouses: SpousesLookup,
) {
  const cardsView = container.querySelector<HTMLElement>(
    "#htmlSvg .cards_view",
  );
  if (!cardsView) return;

  clearSupplementaryOverlay(cardsView);
  if (!expandedId) return;

  const anchorPos = getCardWorldPos(container, expandedId);
  if (!anchorPos) return; // anchor isn't currently rendered — nothing to attach to
  const { x: anchorX, y: anchorY } = anchorPos;

  // Grow the fan away from wherever the anchor's spouse is currently
  // rendered, so it doesn't fan into the space family-chart is using for
  // the main person's own blood ancestry.
  let bias: "left" | "right" | "center" = "center";
  for (const spouseId of getSpouses(expandedId)) {
    const spousePos = getCardWorldPos(container, spouseId);
    if (spousePos) {
      bias = spousePos.x > anchorX ? "left" : "right";
      break;
    }
  }

  const { positions, links } = layoutAncestors(
    expandedId,
    anchorX,
    anchorY,
    getParents,
    bias,
  );
  if (positions.length === 0) return; // no recorded parents to show

  const getPos = (id: string) =>
    id === expandedId
      ? { x: anchorX, y: anchorY }
      : positions.find((p) => p.id === id);

  for (const link of links) {
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

  for (const pos of positions) {
    const person = peopleById.get(pos.id);
    const card = document.createElement("div");
    card.className = "supplementary-node";
    card.dataset.id = pos.id;
    card.style.cssText = `position: absolute; top: 0; left: 0; width: ${SUPPLEMENTARY_CARD_W}px; height: ${SUPPLEMENTARY_CARD_H}px; transform: translate(${pos.x - SUPPLEMENTARY_CARD_W / 2}px, ${pos.y - SUPPLEMENTARY_CARD_H / 2}px); background: var(--genderless-color, #f7f1e3); color: var(--text-color, #2b2015); border-radius: 6px; border: 1px solid rgba(43,32,21,0.35); box-shadow: 0 1px 3px rgba(0,0,0,0.15); display: flex; align-items: center; padding: 0 12px; font-size: 13px; line-height: 1.2; pointer-events: none;`;
    card.textContent = person
      ? person.is_placeholder
        ? `${person.name} (?)`
        : person.name
      : "Unknown";
    cardsView.appendChild(card);
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

  // The one supplementary ancestor branch currently shown, independent of
  // family-chart's own "main" — see the "Supplementary ancestor-branch
  // overlay" section above for why this can't be done through
  // family-chart's own API. Scoped to one at a time, matching the actual
  // feature asked for; the data structure doesn't rule out a Set later,
  // but nothing here has been built or tested for more than one.
  const [expandedAncestorId, setExpandedAncestorId] = useState<string | null>(
    null,
  );
  const expandedAncestorIdRef = useRef(expandedAncestorId);
  expandedAncestorIdRef.current = expandedAncestorId;
  const getParentsRef = useRef<ParentsLookup>(() => []);
  getParentsRef.current = buildParentsLookup(unions, unionChildren);
  const getSpousesRef = useRef<SpousesLookup>(() => []);
  getSpousesRef.current = buildSpousesLookup(unions);

  // Both the chart-creation effect (registering setAfterUpdate once) and
  // the expandedAncestorId-change effect below need to trigger the exact
  // same re-render; kept in a ref so the afterUpdate hook (registered once
  // at chart creation) always calls the latest version.
  const syncOverlayRef = useRef<() => void>(() => {});
  syncOverlayRef.current = () => {
    const container = containerRef.current;
    if (!container) return;
    renderSupplementaryOverlay(
      container,
      expandedAncestorIdRef.current,
      peopleByIdRef.current,
      getParentsRef.current,
      getSpousesRef.current,
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
      .setAncestryDepth(25)
      .setProgenyDepth(25)
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
    f3Card.setOnCardClick((e: MouseEvent, d: TreeDatum) => {
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
      // "Supplementary ancestor-branch overlay" section above. Only shown
      // for people who actually have recorded parents; toggles our own
      // hand-laid-out branch on/off, replacing whichever one (if any) was
      // previously expanded, since only one is shown at a time.
      if (getParentsRef.current(d.data.id).length > 0) {
        const expandButton = document.createElement("button");
        expandButton.type = "button";
        expandButton.textContent = "▲";
        expandButton.setAttribute(
          "aria-label",
          `Show ${d.data.data["first name"]}'s parents`,
        );
        expandButton.style.cssText =
          "position: absolute; top: -6px; left: 50%; transform: translateX(-50%); " +
          "width: 22px; height: 18px; border-radius: 9px; border: none; " +
          "background: var(--male-color, #5c7360); color: white; font-size: 9px; " +
          "line-height: 1; cursor: pointer; display: flex; align-items: center; " +
          "justify-content: center; box-shadow: 0 1px 3px rgba(0,0,0,0.4);";
        expandButton.addEventListener("click", (e) => {
          e.stopPropagation();
          setExpandedAncestorId((current) =>
            current === d.data.id ? null : d.data.id,
          );
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
  // branch is expanded. (The family-chart-triggered case — main changing,
  // data changing — is covered by the setAfterUpdate hook above instead,
  // since those don't change this state at all.)
  useEffect(() => {
    syncOverlayRef.current();
  }, [expandedAncestorId]);

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

"use client";

import { useEffect, useRef, useState } from "react";
import * as f3 from "family-chart";
import type { Data as F3Data, TreeDatum } from "family-chart";
import "family-chart/styles/family-chart.css";
import type { Tables } from "@/lib/supabase/database.types";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;

type RelativesLookup = Map<
  string,
  { parents: string[]; spouses: string[]; children: string[] }
>;

// The single source of truth for a person's REAL recorded relatives —
// used both to build family-chart's own per-node rels (toF3Data below)
// and, independently, by the mini-tree badge tooltip (see
// applyMiniTreeTooltips) to know what SHOULD be there regardless of what
// family-chart's rendering actually does with it. That distinction turned
// out to matter for real: family-chart contextually trims a rendered
// node's own d.data.rels depending on its role in the current layout (a
// sibling-of-main's own spouses/children can come back empty even though
// they're fully recorded), so the badge tooltip must NOT read it back off
// the rendered datum — it has to be computed straight from unions/
// union_children, same as this function, kept entirely independent of
// whatever the current tree layout happens to include.
function buildRelativesLookup(
  unions: UnionRow[],
  unionChildren: UnionChild[],
): RelativesLookup {
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

  const allPersonIds = new Set([
    ...childToUnionId.keys(),
    ...spousesByPerson.keys(),
    ...childrenByPerson.keys(),
  ]);
  const lookup: RelativesLookup = new Map();
  for (const personId of allPersonIds) {
    const incomingUnionId = childToUnionId.get(personId);
    const incomingUnion = incomingUnionId
      ? unionsById.get(incomingUnionId)
      : undefined;
    const parents = incomingUnion
      ? [incomingUnion.parent1_id, incomingUnion.parent2_id].filter(
          (id): id is string => !!id,
        )
      : [];
    lookup.set(personId, {
      parents,
      spouses: [...(spousesByPerson.get(personId) ?? [])],
      children: [...(childrenByPerson.get(personId) ?? [])],
    });
  }
  return lookup;
}

// family-chart has no notion of a "union" — a marriage is implicit from a
// shared spouse pairing, and parentage is implicit from a child listing
// both parent ids. We derive all three of its per-person relationship
// lists (parents/spouses/children) from our own unions + union_children.
function toF3Data(
  people: Person[],
  unions: UnionRow[],
  unionChildren: UnionChild[],
): F3Data {
  const relatives = buildRelativesLookup(unions, unionChildren);

  return people.map((person) => {
    const rels = relatives.get(person.id);
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
        parents: rels?.parents ?? [],
        spouses: rels?.spouses ?? [],
        children: rels?.children ?? [],
      },
    };
  }) as unknown as F3Data;
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

// Builds the mini-tree badge's hover text, e.g. "2 spouses, 2 children not
// shown" — only the categories that actually have something hidden, in
// genealogical order (parents, then spouses, then children), correctly
// singular/plural. Returns null when nothing's actually hidden (shouldn't
// normally happen, since the badge itself only renders when family-chart's
// own all_rels_displayed is false, but a null guard here is cheap insurance
// against the two calculations ever disagreeing).
function describeHiddenRelatives(hidden: {
  parents: string[];
  spouses: string[];
  children: string[];
}): string | null {
  const parts: string[] = [];
  if (hidden.parents.length > 0) {
    parts.push(`${hidden.parents.length} parent${hidden.parents.length === 1 ? "" : "s"}`);
  }
  if (hidden.spouses.length > 0) {
    parts.push(`${hidden.spouses.length} spouse${hidden.spouses.length === 1 ? "" : "s"}`);
  }
  if (hidden.children.length > 0) {
    parts.push(`${hidden.children.length} child${hidden.children.length === 1 ? "" : "ren"}`);
  }
  return parts.length > 0 ? `${parts.join(", ")} not shown` : null;
}

// --- "View both families" ------------------------------------------------
//
// family-chart's own hierarchy traces exactly one person's blood line —
// confirmed by real testing, not just reading the source: adding a real
// (test-only) shared child of a couple and centering on that child made
// family-chart natively render BOTH parents' full ancestries, correctly
// laid out with zero collisions, for free. That's because a shared child's
// own two parents are both "real" ancestors from the hierarchy's point of
// view — there's no such thing as an "in-law" to family-chart, just
// parents. A hand-rolled supplementary overlay (tried across several
// earlier sessions) was fighting to reimplement, badly, something
// family-chart already does correctly.
//
// So: build a synthetic "child" of any couple, in memory only, purely to
// serve as family-chart's main/focus — never written to Supabase, not a
// real person, invisible in the rendered tree (see setOnCardUpdate below).
// This reuses family-chart's real, collision-free ancestry+sibling layout
// instead of re-deriving it.
const SYNTHETIC_ANCHOR_ID = "__couple-view-anchor__";
// How long a single card-body click waits before actually recentering,
// giving a following second click on the same person time to arrive and
// turn it into a double-click (open the dossier) instead — see
// setOnCardClick and pendingCardClickRef's own comment for why this is
// tracked ourselves rather than via a native dblclick listener. Long
// enough that a real double-click reliably lands within it; short enough
// that a single click doesn't feel laggy.
const DOUBLE_CLICK_WINDOW_MS = 300;
// The normal single-person-centering default: shallow enough that a big
// tree doesn't render hundreds of distant ancestors/descendants at once,
// deep enough to show great-grandparents/great-grandchildren without any
// extra clicks. Either direction can be extended to FULL_DEPTH per-view —
// see expandedAncestry/expandedProgeny below — by clicking that person's
// own mini-tree badge, without changing this default for anyone else.
const DEFAULT_ANCESTRY_DEPTH = 2;
const DEFAULT_PROGENY_DEPTH = 2;
// Effectively "as deep as recorded data goes" — used both for "view both
// families" (full native blood-line tracing for both spouses, unaffected
// by the shallow default above) and for badge-triggered expansion in
// whichever direction a mini-tree badge signals more hidden relatives.
const FULL_DEPTH = 25;

function buildSyntheticAnchor(
  parent1Id: string,
  parent2Id: string,
): F3Data[number] {
  return {
    id: SYNTHETIC_ANCHOR_ID,
    data: { "first name": "", dates: "" },
    rels: { parents: [parent1Id, parent2Id], spouses: [], children: [] },
  } as unknown as F3Data[number];
}

function buildTreeData(
  people: Person[],
  unions: UnionRow[],
  unionChildren: UnionChild[],
  coupleView: { parent1Id: string; parent2Id: string } | null,
): F3Data {
  const base = toF3Data(people, unions, unionChildren);
  if (!coupleView) return base;
  return [
    ...base,
    buildSyntheticAnchor(coupleView.parent1Id, coupleView.parent2Id),
  ] as unknown as F3Data;
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
  onOpenDossier,
  onAttachToTree,
  onDeletePerson,
  highlightPersonId,
  heightClassName = "h-[75vh]",
}: {
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  onPersonClick?: (person: Person) => void;
  onOpenDossier?: (person: Person) => void;
  // Only meaningful for the "not yet connected" loose-people list below
  // the chart — there's no family-chart card for them to attach these
  // actions to, so they get their own small buttons instead. Optional
  // because embedded uses (e.g. the document-review three-pane workspace)
  // don't offer either.
  onAttachToTree?: (person: Person) => void;
  onDeletePerson?: (person: Person) => void;
  highlightPersonId?: string | null;
  // Lets embedded uses (e.g. the document-review three-pane workspace,
  // which needs the tree to fit a pane rather than dominate the page the
  // way the standalone /tree page does) size the canvas without touching
  // the default.
  heightClassName?: string;
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
  const onOpenDossierRef = useRef(onOpenDossier);
  onOpenDossierRef.current = onOpenDossier;
  const peopleByIdRef = useRef(new Map<string, Person>());
  peopleByIdRef.current = new Map(people.map((p) => [p.id, p]));
  const unionsRef = useRef(unions);
  unionsRef.current = unions;
  const getSpousesRef = useRef<SpousesLookup>(() => []);
  getSpousesRef.current = buildSpousesLookup(unions);
  // family-chart's own mini-tree badge only knows a single flattened
  // boolean ("something is hidden") — it can't tell a hidden parent from a
  // hidden spouse from a hidden child, and its fixed top-of-card position
  // doesn't correspond to any of those directions either. Recomputed every
  // render straight from unions/union_children (see buildRelativesLookup's
  // own comment for why this must NOT be read off family-chart's rendered
  // per-node d.data.rels instead), consulted in setAfterUpdate below to
  // compute the real answer ourselves — see applyMiniTreeTooltips.
  const relativesByPersonIdRef = useRef<RelativesLookup>(new Map());
  relativesByPersonIdRef.current = buildRelativesLookup(unions, unionChildren);

  // The couple currently being viewed via "view both families" (see the
  // section above) — null means normal single-person navigation. Read via
  // a ref inside the click handler (registered once at chart creation),
  // which needs the latest value at click time, not creation time.
  const [coupleView, setCoupleView] = useState<{
    parent1Id: string;
    parent2Id: string;
  } | null>(null);
  const coupleViewRef = useRef(coupleView);
  coupleViewRef.current = coupleView;
  // Tracks the previous render's coupleView so the data-sync effect below
  // can tell "just entered" (force main to the synthetic anchor, fit the
  // view) apart from "already in couple view, data changed for some other
  // reason" (leave main and pan/zoom alone).
  const prevCoupleViewRef = useRef<typeof coupleView>(null);
  // Set by clicking a person's mini-tree badge (see applyMiniTreeTooltips)
  // to bump that direction's depth to FULL_DEPTH for the current view —
  // reset back to the shallow DEFAULT_*_DEPTH whenever a card body click
  // actually recenters onto someone new (see setOnCardClick and the
  // highlightPersonId effect below), so the shallow default is what greets
  // every newly-centered person regardless of what was expanded before.
  // Read by the data-sync effect below, which applies these alongside
  // coupleView (a couple view always uses FULL_DEPTH for both regardless
  // of these flags — see that effect's own comment).
  const [expandedAncestry, setExpandedAncestry] = useState(false);
  const [expandedProgeny, setExpandedProgeny] = useState(false);
  // Single-click recenters, double-click opens the dossier — both live on
  // the same card body, so single-click's own action is delayed briefly
  // (see setOnCardClick below) to give a possible second click time to
  // arrive and cancel it, rather than recentering AND then opening the
  // dossier on every double-click. Deliberately NOT implemented as a native
  // dblclick listener on the card element: a button click that also
  // changes the tree (e.g. ⚭ both-families, which calls setCoupleView and
  // triggers an immediate re-render) can rebuild the card's whole DOM
  // subtree between a double-click's two constituent clicks, so the
  // second click lands on a freshly-created element the button's own
  // stopPropagation guard was never attached to — the browser still
  // recognizes it as a "dblclick" (same new target for both halves) and
  // it bubbles straight to the card with nothing to stop it (confirmed by
  // real testing, not assumed). Tracking by person id + timing here
  // instead sidesteps that entirely: family-chart's own click listener
  // lives on .card, which every action button's stopPropagation already
  // keeps button clicks from ever reaching, so this only ever fires for
  // genuine card-body clicks regardless of what re-renders happen between
  // them.
  const pendingCardClickRef = useRef<{ id: string; timer: number } | null>(
    null,
  );
  // "View in tree" from the document-matching review queue (see
  // documents-view.tsx): a person id to recenter on and briefly pulse.
  // Applied via setAfterUpdate below rather than immediately after calling
  // updateTree() — family-chart's card repositioning runs via a d3
  // .transition(), which hasn't applied its first interpolated frame yet
  // in the same synchronous tick that updateTree() returns in. Adding the
  // pulse class right away would apply it to the card's pre-recenter
  // position, not where it's actually about to land.
  const pendingHighlightRef = useRef<string | null>(null);

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
      // Shallow by default in both directions — see DEFAULT_ANCESTRY_DEPTH/
      // DEFAULT_PROGENY_DEPTH's own comment. Either direction can go to
      // FULL_DEPTH for the current view: automatically for both while
      // "view both families" is active, or per-direction by clicking a
      // person's own mini-tree badge — see the data-sync effect below,
      // which raises these dynamically based on coupleView/expandedAncestry/
      // expandedProgeny.
      .setAncestryDepth(DEFAULT_ANCESTRY_DEPTH)
      .setProgenyDepth(DEFAULT_PROGENY_DEPTH)
      // family-chart's own documented option (calculateTree's
      // show_siblings_of_main) for exactly the "stable row" this app
      // needs: main's siblings, laid out alongside them, natively — no
      // custom sibling-rendering required. Confirmed via source
      // (setupSiblings) this only adds bare sibling cards (no spouse/
      // children of their own), which is fine; recentering onto any one
      // of them keeps the same sibling group in view, since they share
      // the same parents. Also what makes "view both families" show a
      // couple's real children alongside the synthetic anchor: the
      // synthetic anchor's rels.parents matches theirs exactly, so
      // family-chart's own sibling lookup finds them for free.
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
    //
    // Custom onSelect instead of family-chart's default (which would just
    // call updateMainId + updateTree on its own): this is a third way main
    // can change, alongside a card-body click and "view in tree", and
    // needs the exact same reset back to the shallow default depth — left
    // out here, a previous badge-triggered expansion would silently carry
    // over onto whoever gets searched for next.
    f3Chart.setPersonDropdown(
      (d: { data: { "first name": string } }) => d.data["first name"],
      {
        onSelect: (personId: string) => {
          setExpandedAncestry(false);
          setExpandedProgeny(false);
          f3Chart.updateMainId(personId);
          f3Chart.updateTree({ initial: false });
        },
      },
    );

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
    // family-chart's own default click behavior, nothing more. Double-
    // clicking it opens the dossier instead: the single click's own
    // recenter is delayed by DOUBLE_CLICK_WINDOW_MS so a genuine second
    // click on the same person, arriving within that window, can cancel it
    // and open the dossier instead of recentering AND then also opening
    // the dossier on every double-click. See pendingCardClickRef's own
    // comment for why this is tracked by person id + timing here rather
    // than as a native dblclick listener.
    //
    // Exception: is_ancestry cards (main's own ancestors, up to whatever
    // depth is currently in effect — or, while viewing a couple, that
    // couple itself, since they're the synthetic anchor's own immediate
    // "parents"). Recentering onto one discards the stable row that was
    // the point of being here — explored by clicking a sibling or the
    // couple's own real children instead.
    f3Card.setOnCardClick((e: MouseEvent, d: TreeDatum) => {
      if (d.data.id === SYNTHETIC_ANCHOR_ID) return; // shouldn't be reachable — card is hidden, see setOnCardUpdate

      const pending = pendingCardClickRef.current;
      if (pending && pending.id === d.data.id) {
        window.clearTimeout(pending.timer);
        pendingCardClickRef.current = null;
        const person = peopleByIdRef.current.get(d.data.id);
        if (person) onOpenDossierRef.current?.(person);
        return;
      }

      const timer = window.setTimeout(() => {
        pendingCardClickRef.current = null;
        if (d.is_ancestry) return;
        if (coupleViewRef.current) setCoupleView(null);
        // A real recenter always lands back on the shallow default depth
        // in both directions, regardless of what a mini-tree badge had
        // expanded for the person being left.
        setExpandedAncestry(false);
        setExpandedProgeny(false);
        f3Card.onCardClickDefault(e, d);
      }, DOUBLE_CLICK_WINDOW_MS);
      pendingCardClickRef.current = { id: d.data.id, timer };
    });

    // setOnCardUpdate is called every time a card's DOM is (re)rendered,
    // right after its base markup is set — the supported hook for
    // attaching extra elements without reimplementing the card template
    // ourselves. Every button stops propagation so it doesn't also trigger
    // the card's re-center click above.
    f3Card.setOnCardUpdate(function (this: HTMLElement, d: TreeDatum) {
      // The synthetic couple-view anchor is a rendering trick, not a
      // person anyone should see — hide its card entirely. Layout math
      // (calculateTree) runs on the data before any DOM exists, so hiding
      // this one card doesn't disturb where everything else around it
      // gets positioned.
      if (d.data.id === SYNTHETIC_ANCHOR_ID) {
        this.style.display = "none";
        return;
      }

      const cardEl = this.querySelector<HTMLElement>(".card");
      if (!cardEl) return;

      // family-chart doesn't stamp the underlying person id onto the DOM
      // anywhere itself (card_cont is keyed internally by a "tid", not
      // exposed as an attribute) — added here so "view in tree" can find
      // the right card by id rather than by name text, which breaks the
      // moment two people share a name (e.g. this app's three different
      // "Anthony Ciampa" records).
      cardEl.setAttribute("data-person-id", d.data.id);

      // Per-card actions (add/both-families — editing a person's core
      // details moved into the dossier's own identity form, deleting into
      // the dossier's "Delete this person", and opening the dossier itself
      // into a double-click on the card body, handled entirely in
      // setOnCardClick above, so family-chart's native edit form, this
      // menu's old ✎ button, and its old 🗂 button are all gone) used to be
      // permanent icons pinned to the card's corners — with several cards
      // on screen at once that read as cluttered. They now live behind a
      // single "..." toggle in one consistent corner (top-right), revealed
      // as a flyout on hover or tap; see the .card-actions-menu rules in
      // globals.css for the reveal mechanics (:hover for desktop,
      // :focus-within so tapping the real <button> on touch/keyboard works
      // too, since hover never fires there). Every action button below
      // still calls stopPropagation() first so it doesn't also trigger the
      // card's own re-center click.
      const menuWrapper = document.createElement("div");
      menuWrapper.className = "card-actions-menu";

      const toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.className = "card-actions-toggle";
      toggleButton.textContent = "⋯";
      toggleButton.setAttribute(
        "aria-label",
        `Actions for ${d.data.data["first name"]}`,
      );
      toggleButton.addEventListener("click", (e) => {
        e.stopPropagation();
      });
      menuWrapper.appendChild(toggleButton);

      const flyout = document.createElement("div");
      flyout.className = "card-actions-flyout";

      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "card-action-btn card-action-add";
      addButton.textContent = "+";
      addButton.setAttribute(
        "aria-label",
        `Add to ${d.data.data["first name"]}'s record`,
      );
      addButton.addEventListener("click", (e) => {
        e.stopPropagation();
        const person = peopleByIdRef.current.get(d.data.id);
        if (person) onPersonClickRef.current?.(person);
      });
      flyout.appendChild(addButton);

      // "View both families" — offered on any card with at least one
      // recorded spouse; picks the first if there happen to be more than
      // one (multiple marriages), consistent with how the rest of this
      // component doesn't yet offer a way to choose between them.
      //
      // Doubles as the exit: a couple with no OTHER real children (like
      // Tom & Maxine) has nothing in the sibling row, so every visible
      // card ends up is_ancestry — and is_ancestry cards deliberately
      // don't recenter on click (see setOnCardClick), which would leave
      // no way at all to leave couple view by clicking anything. Clicking
      // this same button again on the couple that's currently being
      // viewed exits instead of re-entering.
      const spouseIds = getSpousesRef.current(d.data.id);
      if (spouseIds.length > 0) {
        const spouseId = spouseIds[0];
        const isViewingThisCouple =
          !!coupleViewRef.current &&
          ((coupleViewRef.current.parent1Id === d.data.id &&
            coupleViewRef.current.parent2Id === spouseId) ||
            (coupleViewRef.current.parent2Id === d.data.id &&
              coupleViewRef.current.parent1Id === spouseId));
        const familiesButton = document.createElement("button");
        familiesButton.type = "button";
        familiesButton.className = "card-action-btn card-action-families";
        familiesButton.textContent = isViewingThisCouple ? "✕" : "⚭";
        familiesButton.setAttribute(
          "aria-label",
          isViewingThisCouple
            ? "Exit both-families view"
            : `View both families for ${d.data.data["first name"]}`,
        );
        familiesButton.style.background = isViewingThisCouple
          ? "var(--female-color, #a97b52)"
          : "var(--male-color, #5c7360)";
        familiesButton.addEventListener("click", (e) => {
          e.stopPropagation();
          if (isViewingThisCouple) setCoupleView(null);
          else setCoupleView({ parent1Id: d.data.id, parent2Id: spouseId });
        });
        flyout.appendChild(familiesButton);
      }

      menuWrapper.appendChild(flyout);
      cardEl.appendChild(menuWrapper);
    });

    // Figures out, per rendered card that has family-chart's own mini-tree
    // badge, exactly which real relatives (by category) aren't part of the
    // current view, sets that as the badge's title/aria-label, and wires
    // up a click on the badge to reveal them: bumps ancestryDepth and/or
    // progenyDepth to FULL_DEPTH (see the data-sync effect, which reacts to
    // expandedAncestry/expandedProgeny) for whichever direction(s) this
    // specific badge is signaling, without recentering. A badge signaling
    // ONLY a hidden spouse (no hidden parents or children — spouses aren't
    // gated by either depth setting, so there's nothing for this to
    // expand) deliberately leaves the click alone to bubble through to the
    // card's own recenter handler, same as before this feature existed.
    //
    // Must run on the same delay as the highlight-pulse below, not
    // synchronously at the top of setAfterUpdate — this was the actual bug
    // behind an early wrong reading (Laurie showing "1 spouse not shown"
    // instead of the real 2 spouses + 2 children): d3's exit transition for
    // cards leaving the previous view hasn't necessarily removed them from
    // the DOM yet when setAfterUpdate first fires, so an immediate
    // querySelectorAll("[data-person-id]") over-counts "currently shown" by
    // including not-yet-removed outgoing cards, silently deflating the
    // hidden-relatives diff.
    const applyMiniTreeTooltips = () => {
      const renderedIds = new Set(
        Array.from(container.querySelectorAll<HTMLElement>(".card[data-person-id]"))
          .map((el) => el.getAttribute("data-person-id"))
          .filter((id): id is string => !!id),
      );
      const badges = container.querySelectorAll<HTMLElement>("div.mini-tree");
      badges.forEach((badge) => {
        const cardEl = badge.closest<HTMLElement>(".card[data-person-id]");
        const personId = cardEl?.getAttribute("data-person-id");
        const rels = personId ? relativesByPersonIdRef.current.get(personId) : undefined;
        if (!rels) return;
        const hidden = {
          parents: rels.parents.filter((id) => !renderedIds.has(id)),
          spouses: rels.spouses.filter((id) => !renderedIds.has(id)),
          children: rels.children.filter((id) => !renderedIds.has(id)),
        };
        const description = describeHiddenRelatives(hidden);
        if (!description) return;
        badge.setAttribute("title", description);
        badge.setAttribute("aria-label", description);

        const hasHiddenAncestors = hidden.parents.length > 0;
        const hasHiddenDescendants = hidden.children.length > 0;
        badge.addEventListener("click", (e) => {
          if (!hasHiddenAncestors && !hasHiddenDescendants) return;
          e.stopPropagation();
          if (hasHiddenAncestors) setExpandedAncestry(true);
          if (hasHiddenDescendants) setExpandedProgeny(true);
        });
      });
    };

    // See pendingHighlightRef's own comment above for why this waits for
    // the real transition instead of applying the pulse immediately —
    // applyMiniTreeTooltips needs the exact same wait, see its own comment.
    f3Chart.setAfterUpdate((props?: { transition_time?: number }) => {
      window.setTimeout(applyMiniTreeTooltips, (props?.transition_time ?? 0) + 50);
      const id = pendingHighlightRef.current;
      if (!id) return;
      pendingHighlightRef.current = null;
      const transitionTime = props?.transition_time ?? 0;
      window.setTimeout(() => {
        const el = container.querySelector<HTMLElement>(
          `[data-person-id="${id}"]`,
        );
        if (!el) return;
        el.classList.add("f3-highlight-pulse");
        window.setTimeout(() => el.classList.remove("f3-highlight-pulse"), 2400);
      }, transitionTime + 50);
    });

    f3Chart.updateTree({ initial: true });
    chartRef.current = f3Chart;

    return () => {
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasConnected]);

  // The container's width changes whenever the dossier pane docks/undocks
  // beside it (see tree-view.tsx's flex layout) — the SVG itself is CSS
  // width:100%/height:100% so it visually resizes for free, but the tree's
  // current pan/zoom transform was computed for the old width and needs an
  // explicit re-fit, or it reads as off-center/partly clipped in the new
  // space. tree_position: "fit" reads the container's CURRENT
  // getBoundingClientRect() at call time (confirmed via family-chart's own
  // source), so this re-fits to whatever size the container is right now
  // without touching data, main, coupleView, or expanded ancestry/progeny —
  // unlike the previous approach (keying FamilyTree on dossier-open state
  // to force a full remount for this same re-fit), which reset all of it as
  // a side effect. Debounced via rAF: ResizeObserver can fire more than
  // once per real layout change, and ties the fit to the frame the new
  // size actually lands in rather than a somewhat-arbitrary delay.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        chartRef.current?.updateTree({ initial: false, tree_position: "fit" });
      });
    });
    observer.observe(container);
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [hasConnected]);

  // "View in tree" support: recenter on the requested person and queue a
  // brief highlight pulse for their card (applied once the real transition
  // settles — see setAfterUpdate above). Declared after the chart-creation
  // effect so chartRef.current is already populated by the time this runs
  // on initial mount.
  useEffect(() => {
    if (!highlightPersonId || !chartRef.current) return;
    if (!touched.has(highlightPersonId)) return; // not part of any recorded relationship, nothing to center on
    pendingHighlightRef.current = highlightPersonId;
    // Same shallow default every other recenter lands on — see
    // setOnCardClick's own reset for why this shouldn't inherit whatever
    // was expanded for whoever was previously centered.
    setExpandedAncestry(false);
    setExpandedProgeny(false);
    chartRef.current.updateMainId(highlightPersonId);
    chartRef.current.updateTree({ initial: false, tree_position: "fit" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightPersonId]);

  // Keep the chart's data in sync with new saves via family-chart's own
  // updateData(), instead of tearing down and recreating the chart (the
  // previous approach). updateData() only resets the focused/main person if
  // that person no longer exists in the new data — otherwise it's left
  // alone, so adding a second child to Joe and Adriana while viewing them
  // keeps them in focus instead of resetting to the tree's root person.
  //
  // Also reacts to coupleView: entering "view both families" needs the
  // synthetic anchor added to the data, both depths raised to FULL_DEPTH so
  // BOTH parents' full lines (and their real children/descendants) actually
  // render exactly as before this default-depth feature existed, and main
  // forced to the synthetic anchor (only on the transition into couple view
  // — once already there, a data change for some unrelated reason shouldn't
  // re-fit the view). Exiting is simpler: the click that exits already
  // recentered onto a real person via onCardClickDefault, so this just
  // needs to drop the synthetic node and the depth cap back to normal
  // without touching main.
  //
  // Also reacts to expandedAncestry/expandedProgeny: set by clicking a
  // person's mini-tree badge (see applyMiniTreeTooltips above), each
  // independently raises its own direction to FULL_DEPTH without touching
  // main or the other direction. coupleView takes priority in both
  // directions over these — "view both families" is meant to show
  // everything regardless of what was or wasn't expanded beforehand.
  useEffect(() => {
    if (!chartRef.current) return;
    const enteringCoupleView = !!coupleView && !prevCoupleViewRef.current;
    const data = buildTreeData(connected, unions, unionChildren, coupleView);
    chartRef.current.setAncestryDepth(
      coupleView || expandedAncestry ? FULL_DEPTH : DEFAULT_ANCESTRY_DEPTH,
    );
    chartRef.current.setProgenyDepth(
      coupleView || expandedProgeny ? FULL_DEPTH : DEFAULT_PROGENY_DEPTH,
    );
    chartRef.current.updateData(data);
    if (enteringCoupleView) {
      chartRef.current.updateMainId(SYNTHETIC_ANCHOR_ID);
    }
    chartRef.current.updateTree({
      initial: false,
      tree_position: enteringCoupleView ? "fit" : "inherit",
    });
    prevCoupleViewRef.current = coupleView;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, unions, unionChildren, coupleView, expandedAncestry, expandedProgeny]);

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
          className={`f3 f3-cont ${heightClassName} w-full overflow-hidden rounded-lg`}
        />
      )}

      {unplacedPeople.length > 0 && (
        <div className="mt-10 border-t border-gray-200 pt-6 dark:border-gray-800">
          <h2 className="mb-3 text-sm font-medium text-gray-500">
            Not yet connected to the tree
          </h2>
          <ul className="flex flex-wrap gap-2">
            {unplacedPeople.map((p) => (
              <li
                key={p.id}
                className="flex min-w-[8rem] flex-col overflow-hidden rounded border border-gray-300 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900"
              >
                <button
                  type="button"
                  onClick={() => onPersonClick?.(p)}
                  className="flex flex-col items-center px-3 py-2 text-center text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-gray-500">
                    {p.birth_estimate ?? "?"}
                    {" – "}
                    {p.death_estimate ?? ""}
                  </span>
                </button>
                {/* Loose people have no family-chart card to attach these
                    to, and there are typically few of them at once — small
                    always-visible buttons here rather than the on-tree
                    cards' hover-reveal "..." overflow, which exists
                    specifically to declutter many cards visible at once. */}
                <div className="flex border-t border-gray-200 text-xs dark:border-gray-800">
                  {onAttachToTree && (
                    <button
                      type="button"
                      onClick={() => onAttachToTree(p)}
                      title="Add to tree"
                      aria-label={`Add ${p.name} to the tree`}
                      className="flex-1 border-r border-gray-200 py-1 text-gray-500 hover:bg-gray-50 hover:text-gray-800 dark:border-gray-800 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                    >
                      🔗
                    </button>
                  )}
                  {onOpenDossier && (
                    <button
                      type="button"
                      onClick={() => onOpenDossier(p)}
                      title="Open case file"
                      aria-label={`Open case file for ${p.name}`}
                      className="flex-1 border-r border-gray-200 py-1 text-gray-500 hover:bg-gray-50 hover:text-gray-800 dark:border-gray-800 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                    >
                      🗂
                    </button>
                  )}
                  {onDeletePerson && (
                    <button
                      type="button"
                      onClick={() => onDeletePerson(p)}
                      title="Delete"
                      aria-label={`Delete ${p.name}`}
                      className="flex-1 py-1 text-gray-500 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                    >
                      🗑
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

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
// Matches the depth family-chart used before per-person ancestryDepth was
// capped to 1 for normal navigation (see the chart setup below) — full
// real depth, effectively "as deep as recorded data goes."
const COUPLE_VIEW_ANCESTRY_DEPTH = 25;

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
  highlightPersonId,
  heightClassName = "h-[75vh]",
}: {
  people: Person[];
  unions: UnionRow[];
  unionChildren: UnionChild[];
  onPersonClick?: (person: Person) => void;
  onOpenDossier?: (person: Person) => void;
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
      // Capped to 1 (immediate parents only) for normal navigation: with
      // showSiblingsOfMain below, main is meant to be a person like Scott
      // (not one of his parents), so their own full blood ancestry going
      // up would otherwise auto-render both parents' entire chains,
      // uncollapsible. Full-depth ancestry for BOTH a couple's lines at
      // once is available instead via the explicit "view both families"
      // action — see the data-sync effect below, which raises this
      // dynamically while a synthetic couple-anchor is main.
      .setAncestryDepth(1)
      .setProgenyDepth(25)
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
    // Exception: is_ancestry cards (with ancestryDepth capped to 1 for
    // normal navigation, this is exactly main's two immediate parents —
    // or, while viewing a couple, that couple itself, since they're the
    // synthetic anchor's own immediate "parents"). Recentering onto one
    // discards the stable row that was the point of being here — explored
    // by clicking a sibling or the couple's own real children instead.
    f3Card.setOnCardClick((e: MouseEvent, d: TreeDatum) => {
      if (d.data.id === SYNTHETIC_ANCHOR_ID) return; // shouldn't be reachable — card is hidden, see setOnCardUpdate
      if (d.is_ancestry) return;
      if (coupleViewRef.current) setCoupleView(null);
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

      // All four per-card actions (edit/add/both-families/dossier) used to
      // be permanent icons pinned to the card's four corners — with
      // several cards on screen at once that read as cluttered. They now
      // live behind a single "..." toggle in one consistent corner
      // (top-right), revealed as a flyout on hover or tap; see the
      // .card-actions-menu rules in globals.css for the reveal mechanics
      // (:hover for desktop, :focus-within so tapping the real <button>
      // on touch/keyboard works too, since hover never fires there).
      // Every action button below still calls stopPropagation() first so
      // it doesn't also trigger the card's own re-center click.
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

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "card-action-btn card-action-edit";
      editButton.textContent = "✎";
      editButton.setAttribute(
        "aria-label",
        `Edit or delete ${d.data.data["first name"]}`,
      );
      editButton.addEventListener("click", (e) => {
        e.stopPropagation();
        f3EditTree.openFormWithId(d.data.id);
      });
      flyout.appendChild(editButton);

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

      // Case-file dossier — a full read view of this person (summary +
      // Facts/Stories tabs), separate from both the card's own click
      // (recenter) and the "+" button (the add-to-record forms above).
      const dossierButton = document.createElement("button");
      dossierButton.type = "button";
      dossierButton.className = "card-action-btn card-action-dossier";
      dossierButton.textContent = "🗂";
      dossierButton.setAttribute(
        "aria-label",
        `Open case file for ${d.data.data["first name"]}`,
      );
      dossierButton.addEventListener("click", (e) => {
        e.stopPropagation();
        const person = peopleByIdRef.current.get(d.data.id);
        if (person) onOpenDossierRef.current?.(person);
      });
      flyout.appendChild(dossierButton);

      menuWrapper.appendChild(flyout);
      cardEl.appendChild(menuWrapper);
    });

    // See pendingHighlightRef's own comment above for why this waits for
    // the real transition instead of applying the pulse immediately.
    f3Chart.setAfterUpdate((props?: { transition_time?: number }) => {
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

  // "View in tree" support: recenter on the requested person and queue a
  // brief highlight pulse for their card (applied once the real transition
  // settles — see setAfterUpdate above). Declared after the chart-creation
  // effect so chartRef.current is already populated by the time this runs
  // on initial mount.
  useEffect(() => {
    if (!highlightPersonId || !chartRef.current) return;
    if (!touched.has(highlightPersonId)) return; // not part of any recorded relationship, nothing to center on
    pendingHighlightRef.current = highlightPersonId;
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
  // synthetic anchor added to the data, ancestryDepth raised so BOTH
  // parents' full lines actually render, and main forced to the synthetic
  // anchor (only on the transition into couple view — once already there,
  // a data change for some unrelated reason shouldn't re-fit the view).
  // Exiting is simpler: the click that exits already recentered onto a
  // real person via onCardClickDefault, so this just needs to drop the
  // synthetic node and the depth cap back to normal without touching main.
  useEffect(() => {
    if (!chartRef.current) return;
    const enteringCoupleView = !!coupleView && !prevCoupleViewRef.current;
    const data = buildTreeData(connected, unions, unionChildren, coupleView);
    chartRef.current.setAncestryDepth(
      coupleView ? COUPLE_VIEW_ANCESTRY_DEPTH : 1,
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
  }, [people, unions, unionChildren, coupleView]);

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

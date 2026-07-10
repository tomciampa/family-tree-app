"use client";

import { useEffect, useRef } from "react";
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
    });

    f3Chart.updateTree({ initial: true });
    chartRef.current = f3Chart;

    return () => {
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasConnected]);

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
        // family-chart hardcodes some SVG stroke/fill colors (e.g.
        // connector lines) as inline attributes rather than CSS variables,
        // so they can't be retargeted for a light theme without fighting
        // the library's own rendering. Easiest to give it its own dark
        // viewport, as its authors designed and tested it, rather than
        // override piecemeal.
        <div
          ref={containerRef}
          className="f3 h-[75vh] w-full overflow-hidden rounded-lg"
          style={{ backgroundColor: "rgb(33, 33, 33)" }}
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

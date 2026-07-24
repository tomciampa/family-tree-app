import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";
import { anchorNameFromFactValue } from "@/lib/suggested-connections";
import { genealogicalDistance } from "@/lib/genealogical-distance";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;
type Fact = Tables<"facts">;
type Anecdote = Tables<"anecdotes">;

export type GapSeverity = "critical" | "major" | "minor";

export type PersonGap = {
  personId: string;
  personName: string;
  // "self" for the anchor person themselves, otherwise a label like
  // "maternal grandmother", "father", "sibling", "spouse", "child" — the
  // exact wording of an existing relation fact when one names the anchor
  // directly (e.g. "Paternal Grandfather", preserving its real casing), or
  // a generic fallback ("parent", "grandparent", "sibling", "spouse",
  // "child") when no such fact exists to read a precise label from.
  relationToAnchor: string;
  // Each concrete thing found missing, e.g. "not connected to the tree",
  // "birth date", "occupation", "only one personal account recorded so
  // far". Structural items (birth date/death date/occupation/birthplace)
  // are a found-it/didn't-find-it check — closed for good once any single
  // fact records it, regardless of who. The personal-account item is a
  // richness count instead (see subjectiveAccountCount in computeGaps) —
  // it never fully closes the way a structural field does, it just
  // fades out gradually as more accounts accumulate. Stage 2/3 read these
  // directly rather than re-deriving them.
  missing: string[];
  // The worst individual gap for this person — "not connected" or
  // genuinely nothing recorded on either dimension is critical; thin on
  // *both* the structural and subjective dimensions at once is major; a
  // single missing structural field, or thin-but-not-empty subjective
  // richness, on an otherwise-documented person is minor.
  severity: GapSeverity;
  detail: string;
};

// Only the exact bookkeeping pattern confirmInterviewBatch writes
// ("<anchor>'s <relation>, per interview") is excluded from a person's
// "substantive" fact count — it records a connection, not anything
// actually learned about the person. Document-sourced relation-
// descriptive facts (e.g. "Recipient Of Letter", "Grandmother Of The
// Letter Writer") usually carry real content of their own and are kept.
function isBookkeepingFact(fact: Fact): boolean {
  return anchorNameFromFactValue(fact.value) !== null;
}

// Word-boundary matches so "Birthplace" never satisfies the "birth date"
// check (a single run-together word, not "birth" followed by a boundary)
// and vice versa.
const BIRTH_DATE_FIELD = /\bbirth\b/i;
const DEATH_DATE_FIELD = /\bdeath\b/i;
const OCCUPATION_FIELD = /\boccupation\b/i;
const BIRTHPLACE_FIELD = /\bbirth\s*place\b/i;

// Structural/factual vs. subjective/anecdotal is the core distinction this
// module now draws: birth date, death date, occupation, and birthplace
// each have one ground truth, so once *anyone's* fact records one, that
// specific gap is closed for good — asking a different relative the same
// factual question afterward has no benefit. Personality, memories, and
// stories are the opposite: multiple people's perspectives are all
// independently valuable, so one person's account should never fully
// close this the way one occupation fact does — see subjectiveAccountCount
// below, which tracks *how many* accounts exist (with real but gradual
// diminishing returns) rather than a single found-it/didn't-find-it flag.
// A fact only counts as "structural" if it matches one of the four
// patterns above; every other non-bookkeeping fact (plus every anecdote)
// is treated as a subjective/anecdotal account.
function isStructuralFact(fact: Fact): boolean {
  return (
    BIRTH_DATE_FIELD.test(fact.field) ||
    DEATH_DATE_FIELD.test(fact.field) ||
    OCCUPATION_FIELD.test(fact.field) ||
    BIRTHPLACE_FIELD.test(fact.field)
  );
}

// Field text a relation fact must contain to count as directly naming
// that specific relationship — matched as a substring, case-insensitively,
// since real field text varies in wording/casing across sources (e.g.
// "Maternal Grandmother" from an interview vs "Grandmother Of The Letter
// Writer" from a document).
const RELATION_FIELD_KEYWORDS = {
  parent: ["mother", "father"],
  grandparent: ["grandmother", "grandfather"],
  sibling: ["brother", "sister", "sibling"],
  spouse: ["spouse", "husband", "wife"],
  child: ["son", "daughter", "child"],
} as const;

function touchedIds(unions: UnionRow[], unionChildren: UnionChild[]): Set<string> {
  const ids = new Set<string>();
  for (const u of unions) {
    if (u.parent1_id) ids.add(u.parent1_id);
    if (u.parent2_id) ids.add(u.parent2_id);
  }
  for (const uc of unionChildren) ids.add(uc.child_id);
  return ids;
}

// The pure analysis, taking already-fetched rows — kept separate from the
// DB-fetching findGaps() below so it's directly testable/reusable, same
// split as suggested-connections.ts uses.
export function computeGaps(
  personId: string,
  people: Person[],
  unions: UnionRow[],
  unionChildren: UnionChild[],
  facts: Fact[],
  anecdotes: Anecdote[] = [],
  // Stage 5: gap people this exact interviewee has already been asked
  // about and gave no real information on (see interview_gap_no_info /
  // transcribeInterviewSegments). Scoped narrowly to personId alone by the
  // caller (findGaps) — this must never be a global "resolved" set, since
  // a different interviewee should still see the same gap person normally.
  noInfoGapPersonIds: Set<string> = new Set(),
): PersonGap[] {
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const anchor = peopleById.get(personId);
  if (!anchor) return [];

  const factsByPerson = new Map<string, Fact[]>();
  for (const f of facts) {
    if (!f.person_id) continue;
    const list = factsByPerson.get(f.person_id) ?? [];
    list.push(f);
    factsByPerson.set(f.person_id, list);
  }
  const factsFor = (id: string) => factsByPerson.get(id) ?? [];

  const anecdotesByPerson = new Map<string, Anecdote[]>();
  for (const a of anecdotes) {
    if (!a.person_id) continue;
    const list = anecdotesByPerson.get(a.person_id) ?? [];
    list.push(a);
    anecdotesByPerson.set(a.person_id, list);
  }
  const anecdotesFor = (id: string) => anecdotesByPerson.get(id) ?? [];

  // Finds a fact ON candidateId whose value names `namedPersonName` as the
  // anchor of a "<name>'s <relation>, per interview" fact, and whose field
  // matches one of `keywords`. Returns the fact's own field text
  // (preserving real casing) if found, else null — conservative by
  // construction, same as findSuggestedConnections: no match means no
  // guess, not a fallback guess.
  function directRelationLabel(
    candidateId: string,
    namedPersonName: string,
    keywords: readonly string[],
  ): string | null {
    for (const f of factsFor(candidateId)) {
      const named = anchorNameFromFactValue(f.value);
      if (!named || named.toLowerCase() !== namedPersonName.toLowerCase()) continue;
      if (keywords.some((k) => f.field.toLowerCase().includes(k))) return f.field;
    }
    return null;
  }

  function unionAsChild(id: string): UnionRow | null {
    const uc = unionChildren.find((u) => u.child_id === id);
    if (!uc) return null;
    return unions.find((u) => u.id === uc.union_id) ?? null;
  }

  function parentsOf(id: string): string[] {
    const u = unionAsChild(id);
    if (!u) return [];
    return [u.parent1_id, u.parent2_id].filter((x): x is string => !!x);
  }

  function siblingsOf(id: string): string[] {
    const u = unionAsChild(id);
    if (!u) return [];
    return unionChildren
      .filter((uc) => uc.union_id === u.id && uc.child_id !== id)
      .map((uc) => uc.child_id);
  }

  function unionsAsParent(id: string): UnionRow[] {
    return unions.filter((u) => u.parent1_id === id || u.parent2_id === id);
  }

  function spousesOf(id: string): string[] {
    const result = new Set<string>();
    for (const u of unionsAsParent(id)) {
      if (u.parent1_id && u.parent1_id !== id) result.add(u.parent1_id);
      if (u.parent2_id && u.parent2_id !== id) result.add(u.parent2_id);
    }
    return [...result];
  }

  function childrenOf(id: string): string[] {
    const unionIds = new Set(unionsAsParent(id).map((u) => u.id));
    return unionChildren.filter((uc) => unionIds.has(uc.union_id)).map((uc) => uc.child_id);
  }

  // Candidates to evaluate: the anchor themselves, plus every relative in
  // scope, each with a best-effort relation label. A person reachable two
  // ways (e.g. a double first cousin — not expected in real data, but
  // cheap to guard) keeps only the first label found.
  const candidates = new Map<string, string>();
  candidates.set(personId, "self");

  for (const parentId of parentsOf(personId)) {
    if (!candidates.has(parentId)) {
      candidates.set(
        parentId,
        directRelationLabel(parentId, anchor.name, RELATION_FIELD_KEYWORDS.parent) ?? "parent",
      );
    }
    // Grandparents: prefer a relation fact naming the anchor directly
    // (e.g. Hugo's own "Maxine Dubois's maternal grandfather, per
    // interview" fact) — this is how real interview-sourced grandparents
    // are actually labeled. Only if that's absent, fall back to deriving
    // "maternal"/"paternal" + "grandmother"/"grandfather" by chaining two
    // mother/father facts (parent's role, then grandparent's role relative
    // to that parent) — and if even that can't be resolved, a plain
    // "grandparent" rather than guessing.
    const parent = peopleById.get(parentId);
    for (const grandparentId of parentsOf(parentId)) {
      if (candidates.has(grandparentId)) continue;
      const direct = directRelationLabel(
        grandparentId,
        anchor.name,
        RELATION_FIELD_KEYWORDS.grandparent,
      );
      if (direct) {
        candidates.set(grandparentId, direct);
        continue;
      }
      const parentRole = parent
        ? directRelationLabel(parentId, anchor.name, RELATION_FIELD_KEYWORDS.parent)
        : null;
      const grandparentRole = parent
        ? directRelationLabel(grandparentId, parent.name, RELATION_FIELD_KEYWORDS.parent)
        : null;
      if (parentRole && grandparentRole) {
        const side = parentRole.toLowerCase().includes("mother") ? "maternal" : "paternal";
        const role = grandparentRole.toLowerCase().includes("mother")
          ? "grandmother"
          : "grandfather";
        candidates.set(grandparentId, `${side} ${role}`);
      } else {
        candidates.set(grandparentId, "grandparent");
      }
    }
  }

  for (const siblingId of siblingsOf(personId)) {
    if (!candidates.has(siblingId)) {
      candidates.set(
        siblingId,
        directRelationLabel(siblingId, anchor.name, RELATION_FIELD_KEYWORDS.sibling) ?? "sibling",
      );
    }
  }

  for (const spouseId of spousesOf(personId)) {
    if (!candidates.has(spouseId)) {
      candidates.set(
        spouseId,
        directRelationLabel(spouseId, anchor.name, RELATION_FIELD_KEYWORDS.spouse) ?? "spouse",
      );
    }
  }

  for (const childId of childrenOf(personId)) {
    if (!candidates.has(childId)) {
      candidates.set(
        childId,
        directRelationLabel(childId, anchor.name, RELATION_FIELD_KEYWORDS.child) ?? "child",
      );
    }
  }

  const gaps: PersonGap[] = [];

  for (const [id, relationToAnchor] of candidates) {
    const person = peopleById.get(id);
    if (!person) continue;

    const missing: string[] = [];
    let severity: GapSeverity = "minor";

    const substantiveFacts = factsFor(id).filter((f) => !isBookkeepingFact(f));
    const structuralFacts = substantiveFacts.filter(isStructuralFact);
    const subjectiveFacts = substantiveFacts.filter((f) => !isStructuralFact(f));
    // Every non-bookkeeping fact that isn't one of the four structural
    // fields, plus every anecdote, counts as one independent "account" of
    // this person — the number that matters for the subjective/anecdotal
    // side, not a found-it/didn't-find-it flag.
    const subjectiveAccountCount = subjectiveFacts.length + anecdotesFor(id).length;

    const hasBirthDate =
      !!person.birth_estimate || structuralFacts.some((f) => BIRTH_DATE_FIELD.test(f.field));
    const hasDeathDate =
      !!person.death_estimate || structuralFacts.some((f) => DEATH_DATE_FIELD.test(f.field));
    const hasOccupation = structuralFacts.some((f) => OCCUPATION_FIELD.test(f.field));
    const hasBirthplace = structuralFacts.some((f) => BIRTHPLACE_FIELD.test(f.field));
    const hasAnyStructural = hasBirthDate || hasDeathDate || hasOccupation || hasBirthplace;

    // "Thin overall documentation" (critical/major) requires BOTH
    // dimensions to be genuinely empty — someone with real structural
    // facts already on record (e.g. occupation + birthplace) but zero
    // personal accounts yet isn't thinly documented the same way someone
    // with neither is; that's exactly what the subjective note below is
    // for instead, at a lower severity.
    if (!hasAnyStructural && subjectiveAccountCount === 0) {
      missing.push("no facts recorded at all");
      severity = "critical";
    } else if (!hasAnyStructural && subjectiveAccountCount <= 1) {
      missing.push(
        `virtually undocumented — no confirmed birth date, death date, occupation, or birthplace, and only ${subjectiveAccountCount === 0 ? "no personal account" : "one personal account"} recorded`,
      );
      severity = "major";
    }

    // Subjective/anecdotal richness note — independent of the block
    // above, and on its own never raises severity past "minor". Real but
    // gradual diminishing returns: 0 or 1 accounts is still clearly worth
    // asking about, 2 is a lower-priority reminder that more perspectives
    // are still welcome, and 3+ stops being flagged at all — several
    // people have already given their own account. Unlike a structural
    // fact, this never fully "closes" the way "occupation" does the
    // moment anyone records it — there's always room for one more
    // person's memory.
    if (subjectiveAccountCount === 0) {
      missing.push("no personal account recorded yet (personality, memories, stories)");
    } else if (subjectiveAccountCount === 1) {
      missing.push("only one personal account recorded so far — more perspectives would still help");
    } else if (subjectiveAccountCount === 2) {
      missing.push("only a couple of personal accounts recorded — additional perspectives still welcome");
    }

    if (!hasBirthDate) missing.push("birth date");
    if (!hasDeathDate) missing.push("death date");
    if (!hasOccupation) missing.push("occupation");
    if (!hasBirthplace) missing.push("birthplace");

    if (missing.length === 0) continue;

    gaps.push({
      personId: id,
      personName: person.name,
      relationToAnchor,
      missing,
      severity,
      detail: `${person.name} (${relationToAnchor}): missing ${missing.join(", ")}.`,
    });
  }

  // Loose people referenced as a relative of the anchor but never wired
  // into a real union — e.g. someone from an interview extraction whose
  // own "Maxine Dubois's maternal grandfather, per interview" fact exists,
  // but who was never actually connected via unions/union_children.
  // Limitation: this only catches facts naming the anchor directly, not
  // one naming an intermediate relative (e.g. a loose person tied to the
  // anchor's parent rather than the anchor) — conservative by construction,
  // same reasoning as findSuggestedConnections.
  const touched = touchedIds(unions, unionChildren);
  const allKeywords = Object.values(RELATION_FIELD_KEYWORDS).flat();
  for (const person of people) {
    if (touched.has(person.id) || candidates.has(person.id)) continue;
    const label = directRelationLabel(person.id, anchor.name, allKeywords);
    if (!label) continue;

    gaps.push({
      personId: person.id,
      personName: person.name,
      relationToAnchor: label,
      missing: ["not connected to the tree (only referenced via an interview relation fact)"],
      severity: "critical",
      detail: `${person.name} (${label}): referenced as ${anchor.name}'s ${label.toLowerCase()} but never actually connected via a union — not_connected.`,
    });
  }

  // Stage 5: drop anyone this exact interviewee was already specifically
  // asked about and gave no real information on — narrowly, by personId
  // alone, never by removing the person from anyone else's gap list.
  return gaps.filter((g) => !noInfoGapPersonIds.has(g.personId));
}

export async function findGaps(personId: string): Promise<PersonGap[]> {
  const supabase = await createClient();

  const [
    { data: people },
    { data: unions },
    { data: unionChildren },
    { data: facts },
    { data: anecdotes },
    { data: noInfoRows },
  ] = await Promise.all([
    supabase.from("people").select("*"),
    supabase.from("unions").select("*"),
    supabase.from("union_children").select("*"),
    supabase.from("facts").select("*"),
    supabase.from("anecdotes").select("*"),
    // Scoped to this exact interviewee only — see computeGaps's
    // noInfoGapPersonIds doc comment for why that scoping matters.
    supabase
      .from("interview_gap_no_info")
      .select("gap_person_id")
      .eq("interviewee_person_id", personId),
  ]);

  return computeGaps(
    personId,
    people ?? [],
    unions ?? [],
    unionChildren ?? [],
    facts ?? [],
    anecdotes ?? [],
    new Set((noInfoRows ?? []).map((r) => r.gap_person_id)),
  );
}

export type RankedPersonGap = PersonGap & {
  // Hops from the interviewee (see genealogicalDistance) — null means
  // beyond genealogicalDistance's own search cap, not literally infinite.
  distance: number | null;
};

const SEVERITY_RANK: Record<GapSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

// Severity tier first, distance as a tiebreaker only within the same
// tier — not a single blended score. A blended score (e.g. severity
// weight minus a per-hop penalty) can let enough closeness numerically
// outweigh a real severity difference depending on how the weights land,
// which is exactly backwards for this use case: a major gap two hops away
// (an almost-undocumented grandparent) should always surface before a
// trivial one-hop gap (a parent merely missing an exact date) — not just
// usually, depending on tuning. A strict lexicographic sort makes that
// true by construction, and is far easier to explain than "why is this
// blend constant 0.4 and not 0.5".
function compareRankedGaps(a: RankedPersonGap, b: RankedPersonGap): number {
  const severityDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (severityDelta !== 0) return severityDelta;
  const aDist = a.distance ?? Infinity;
  const bDist = b.distance ?? Infinity;
  return aDist - bDist;
}

// Stage 2: combines Stage 1's gap list for an interviewee with each gap
// person's genealogical distance from that same interviewee, then sorts
// severity-first / distance-second (see compareRankedGaps). Still pure
// ranking logic — no UI, no interview wiring.
export async function rankGapsByProximity(intervieweePersonId: string): Promise<RankedPersonGap[]> {
  const gaps = await findGaps(intervieweePersonId);

  const ranked = await Promise.all(
    gaps.map(async (gap) => ({
      ...gap,
      distance: await genealogicalDistance(intervieweePersonId, gap.personId),
    })),
  );

  return ranked.sort(compareRankedGaps);
}

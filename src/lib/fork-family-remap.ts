import type { Json } from "@/lib/supabase/database.types";
import type { CandidateWithMatch, CandidateResolution } from "@/app/documents/actions";
import type { InterviewExtraction, InterviewCandidateFact, InterviewCandidateAnecdote } from "@/app/interviews/actions";

export type IdMap = Record<string, string>;

// fork_family() (see the Stage 3 migration) deliberately does not remap
// the ids embedded inside documents.candidate_people — walking arbitrary
// nested JSON correctly in PL/pgSQL is exactly the kind of thing that's
// easy to get subtly wrong and hard to verify, so it returns full old->new
// id maps instead and leaves this to real, type-checked TypeScript.
//
// candidate_people has exactly two shapes in this schema: a plain
// CandidateWithMatch[] (document extraction — confirmed against real
// production rows) or { people, facts, anecdotes } (interview segment
// extraction, InterviewExtraction — also confirmed against real rows,
// including that its own `people` array uses the identical
// CandidateWithMatch shape once matched). Dispatches on Array.isArray,
// the same way this codebase's other candidate_people readers already do.
export function remapCandidatePeople(
  raw: Json,
  personIdMap: IdMap,
  factIdMap: IdMap,
  anecdoteIdMap: IdMap,
  warnings: string[],
  context: string,
): Json {
  if (Array.isArray(raw)) {
    const remapped = remapPeople(raw as unknown as CandidateWithMatch[], personIdMap, factIdMap, warnings, context);
    return remapped as unknown as Json;
  }

  if (raw !== null && typeof raw === "object") {
    const extraction = raw as unknown as InterviewExtraction;
    const people = remapPeople(
      (extraction.people ?? []) as CandidateWithMatch[],
      personIdMap,
      factIdMap,
      warnings,
      context,
    );
    const facts = (extraction.facts ?? []).map((fact, i) => remapWrittenFact(fact, factIdMap, warnings, `${context}.facts[${i}]`));
    const anecdotes = (extraction.anecdotes ?? []).map((anecdote, i) =>
      remapWrittenAnecdote(anecdote, anecdoteIdMap, warnings, `${context}.anecdotes[${i}]`),
    );
    return { ...extraction, people, facts, anecdotes } as unknown as Json;
  }

  warnings.push(`${context}: candidate_people had an unrecognized shape (${typeof raw}) — left unchanged`);
  return raw;
}

// Every id embedded in a source family's candidate_people is created by
// this app's own extraction/confirmation code, always scoped to that same
// family — so every one of these ids is expected to be a key in the maps
// fork_family() returns. A miss here means a genuine data anomaly (e.g. a
// fact deleted after extraction but before this fork) rather than a bug
// in this remap, and must never leave a stale old-family id sitting in
// the new family's data where it would silently resolve to nothing —
// dropped and logged as a warning instead.
function remapPeople(
  people: CandidateWithMatch[],
  personIdMap: IdMap,
  factIdMap: IdMap,
  warnings: string[],
  context: string,
): CandidateWithMatch[] {
  return people.map((person, i) => {
    const personContext = `${context}.people[${i}]`;
    const next: CandidateWithMatch = { ...person };

    if (next.matches?.length) {
      next.matches = next.matches.flatMap((match) => {
        const newPersonId = personIdMap[match.personId];
        if (newPersonId === undefined) {
          warnings.push(`${personContext}.matches: no mapping for person ${match.personId} — match suggestion dropped`);
          return [];
        }
        return [{ ...match, personId: newPersonId }];
      });
    }

    if (next.resolution) {
      next.resolution = remapResolution(next.resolution, personIdMap, factIdMap, warnings, personContext);
    }

    return next;
  });
}

// A resolution with a correctly-remapped personId but a dangling old
// factId (or vice versa) is exactly the kind of subtle, hard-to-spot
// corruption that's worse than just re-surfacing this one candidate for
// a human to redo — so if ANY id present on the resolution fails to map,
// the whole resolution is dropped, reverting that candidate to
// "unresolved" (which surfaces naturally on the new family's own
// pending-review dashboard) rather than writing a half-remapped one.
function remapResolution(
  resolution: CandidateResolution,
  personIdMap: IdMap,
  factIdMap: IdMap,
  warnings: string[],
  context: string,
): CandidateResolution | undefined {
  const next: CandidateResolution = { action: resolution.action };

  if (resolution.personId !== undefined) {
    const newPersonId = personIdMap[resolution.personId];
    if (newPersonId === undefined) {
      warnings.push(
        `${context}.resolution.personId: no mapping for person ${resolution.personId} — resolution dropped, candidate reverted to unresolved`,
      );
      return undefined;
    }
    next.personId = newPersonId;
  }

  if (resolution.factId !== undefined) {
    const newFactId = factIdMap[resolution.factId];
    if (newFactId === undefined) {
      warnings.push(
        `${context}.resolution.factId: no mapping for fact ${resolution.factId} — resolution dropped, candidate reverted to unresolved`,
      );
      return undefined;
    }
    next.factId = newFactId;
  }

  return next;
}

function remapWrittenFact(
  fact: InterviewCandidateFact,
  factIdMap: IdMap,
  warnings: string[],
  context: string,
): InterviewCandidateFact {
  if (!fact.written) return fact;
  const newFactId = factIdMap[fact.written.factId];
  if (newFactId === undefined) {
    warnings.push(`${context}.written.factId: no mapping for fact ${fact.written.factId} — written marker dropped`);
    const rest = { ...fact };
    delete rest.written;
    return rest;
  }
  return { ...fact, written: { factId: newFactId } };
}

function remapWrittenAnecdote(
  anecdote: InterviewCandidateAnecdote,
  anecdoteIdMap: IdMap,
  warnings: string[],
  context: string,
): InterviewCandidateAnecdote {
  if (!anecdote.written) return anecdote;
  const newAnecdoteId = anecdoteIdMap[anecdote.written.anecdoteId];
  if (newAnecdoteId === undefined) {
    warnings.push(`${context}.written.anecdoteId: no mapping for anecdote ${anecdote.written.anecdoteId} — written marker dropped`);
    const rest = { ...anecdote };
    delete rest.written;
    return rest;
  }
  return { ...anecdote, written: { anecdoteId: newAnecdoteId } };
}

// Storage paths are `${familyId}/${uuid}-${filename}` everywhere in this
// app (document uploads, interview recordings) — fork_family()'s own SQL
// computes each copied documents/photos row's new file_path the identical
// way: swap everything before the first "/" for the new family id, keep
// the uuid-filename suffix as-is. Recomputing it here means the storage-
// copy step doesn't need the RPC to return path pairs at all — it can
// independently derive the destination from the source path it already
// has.
export function newFilePathFor(oldFilePath: string, newFamilyId: string): string {
  const slashIndex = oldFilePath.indexOf("/");
  const suffix = slashIndex >= 0 ? oldFilePath.slice(slashIndex + 1) : oldFilePath;
  return `${newFamilyId}/${suffix}`;
}

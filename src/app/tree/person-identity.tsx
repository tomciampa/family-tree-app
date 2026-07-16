"use client";

import { useState, useTransition } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import {
  updatePersonIdentity,
  parseFactsIntoStandardFields,
  addFact,
  type PersonIdentityFields,
} from "./actions";
import { STANDARD_FIELD_KEYS } from "./constants";

type Person = Tables<"people">;
type Fact = Tables<"facts">;

const NOT_RECORDED = "not recorded";
const STANDARD_LABELS = STANDARD_FIELD_KEYS.map(([, label]) => label);

// Case-insensitive EXACT match on field name — deliberately not fuzzy.
// A merged fact like Vincenzo Ciampa's single "Death" fact (see
// fact-list.tsx's comment on findFactByField) does NOT satisfy "Death
// Date" or "Death Place" here; it still shows up in the full fact list
// below, just isn't hoisted into this standardized section, since a
// merged blob can't be reliably split into clean date/place slots without
// guessing at its prose.
function findFactValue(facts: Fact[], fieldName: string): string | null {
  const match = facts.find(
    (f) => f.field.trim().toLowerCase() === fieldName.toLowerCase(),
  );
  return match ? match.value : null;
}

// Only a bare 4-digit year counts as "cleanly parseable" here — genealogy
// dates are often partial ("abt. 1870", "March 1870, Newark") and running
// them through Date.parse() risks silently misreading day/month order or
// finding a bogus date from an unrelated number in the string. A missing
// year on either side means age is omitted entirely, not guessed at.
function extractYear(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

const inputClassName =
  "rounded border border-[#c9b896] bg-[#fffdf8] px-2 py-1 text-sm text-[#2b2015]";
const labelClassName = "flex flex-col gap-1 text-xs text-[#6b5c45]";

// Facts whose field name doesn't already exactly match one of the seven
// standardized slots are the ones that might have unparsed info buried in
// their prose (e.g. Vincenzo Ciampa's single merged "Death" fact) — these
// are the candidates offered to "Parse into standardized fields" below.
// A fact whose field is already, say, "Occupation" needs no re-parsing.
function findCandidateFacts(facts: Fact[]): Fact[] {
  const standardLower = new Set(STANDARD_LABELS.map((l) => l.toLowerCase()));
  return facts.filter((f) => !standardLower.has(f.field.trim().toLowerCase()));
}

// The parsed fields get attributed back to whatever fact(s) they were
// derived from, not invented as a new source — same source_type as the
// original(s), source_ref noting they were parsed rather than directly
// transcribed, and the source document carried over only when every
// candidate fact points at the same one (otherwise there's no single
// document to attribute all of them to).
function deriveSourceInfo(candidateFacts: Fact[]) {
  const sourceType = candidateFacts[0]?.source_type ?? "secondhand";
  const refs = Array.from(
    new Set(candidateFacts.map((f) => f.source_ref).filter((r): r is string => !!r)),
  );
  const sourceRef =
    refs.length > 0 ? `Parsed from: ${refs.join(", ")}` : "Parsed from existing fact";
  const documentIds = Array.from(
    new Set(candidateFacts.map((f) => f.document_id).filter((d): d is string => !!d)),
  );
  const documentId = documentIds.length === 1 ? documentIds[0] : null;
  return { sourceType, sourceRef, documentId };
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-[#6b5c45]">
        {label}
      </dt>
      <dd className={`text-sm ${value ? "" : "italic text-[#6b5c45]"}`}>
        {value ?? NOT_RECORDED}
      </dd>
    </div>
  );
}

export function PersonIdentitySection({
  person,
  facts,
}: {
  person: Person;
  facts: Fact[];
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState(person.first_name ?? "");
  const [preferredName, setPreferredName] = useState(
    person.preferred_name ?? "",
  );
  const [lastName, setLastName] = useState(person.last_name ?? "");
  const [marriedName, setMarriedName] = useState(person.married_name ?? "");
  const [gender, setGender] = useState(person.gender ?? "");
  const [aliases, setAliases] = useState(person.aliases ?? "");

  // "Parse into standardized fields": a separate review flow from the
  // identity edit form above, since it proposes AI-derived values a
  // person must confirm rather than something they typed themselves —
  // same don't-auto-write principle as the document candidate-match
  // review queue.
  const [parseStatus, setParseStatus] = useState<
    "idle" | "loading" | "review"
  >("idle");
  const [parseError, setParseError] = useState<string | null>(null);
  const [reviewRows, setReviewRows] = useState<
    { key: string; label: string; value: string; included: boolean }[]
  >([]);
  const [isSavingParsed, startSavingParsed] = useTransition();

  function cancelEdit() {
    setIsEditing(false);
    setError(null);
    setFirstName(person.first_name ?? "");
    setPreferredName(person.preferred_name ?? "");
    setLastName(person.last_name ?? "");
    setMarriedName(person.married_name ?? "");
    setGender(person.gender ?? "");
    setAliases(person.aliases ?? "");
  }

  function handleSave(e: { preventDefault: () => void }) {
    e.preventDefault();
    const fields: PersonIdentityFields = {
      firstName,
      preferredName,
      lastName,
      marriedName,
      gender,
      aliases,
    };
    startTransition(async () => {
      const result = await updatePersonIdentity(person.id, fields);
      if (result?.error) {
        setError(result.error);
        return;
      }
      setIsEditing(false);
    });
  }

  const birthDate = findFactValue(facts, "birth date");
  const birthPlace = findFactValue(facts, "birth place");
  const deathDate = findFactValue(facts, "death date");
  const deathPlace = findFactValue(facts, "death place");
  const causeOfDeath = findFactValue(facts, "cause of death");
  const occupation = findFactValue(facts, "occupation");
  const placesLived = findFactValue(facts, "places lived");

  const birthYear = extractYear(birthDate);
  const deathYear = extractYear(deathDate);
  const ageAtDeath =
    birthYear !== null && deathYear !== null ? deathYear - birthYear : null;

  const slotValues: Record<(typeof STANDARD_FIELD_KEYS)[number][0], string | null> = {
    birthDate,
    birthPlace,
    deathDate,
    deathPlace,
    causeOfDeath,
    occupation,
    placesLived,
  };
  const candidateFacts = findCandidateFacts(facts);
  const hasEmptySlot = STANDARD_FIELD_KEYS.some(([key]) => !slotValues[key]);
  const canOfferParse =
    parseStatus === "idle" && candidateFacts.length > 0 && hasEmptySlot;

  function handleParse() {
    setParseStatus("loading");
    setParseError(null);
    startSavingParsed(async () => {
      const result = await parseFactsIntoStandardFields(
        candidateFacts.map((f) => ({ field: f.field, value: f.value })),
      );
      if ("error" in result) {
        setParseError(result.error);
        setParseStatus("idle");
        return;
      }
      const rows = STANDARD_FIELD_KEYS.filter(
        ([key]) => !slotValues[key] && result.parsed[key]?.trim(),
      ).map(([key, label]) => ({
        key,
        label,
        value: (result.parsed[key] as string).trim(),
        included: true,
      }));
      if (rows.length === 0) {
        setParseError(
          "Nothing new found in the existing facts for the empty slots.",
        );
        setParseStatus("idle");
        return;
      }
      setReviewRows(rows);
      setParseStatus("review");
    });
  }

  function cancelParse() {
    setParseStatus("idle");
    setParseError(null);
    setReviewRows([]);
  }

  function handleSaveParsed() {
    const toSave = reviewRows.filter((r) => r.included && r.value.trim());
    if (toSave.length === 0) {
      cancelParse();
      return;
    }
    const { sourceType, sourceRef, documentId } = deriveSourceInfo(candidateFacts);
    startSavingParsed(async () => {
      for (const row of toSave) {
        const result = await addFact(
          person.id,
          row.label,
          row.value.trim(),
          sourceType,
          sourceRef,
          documentId,
        );
        if (result?.error) {
          setParseError(result.error);
          return;
        }
      }
      cancelParse();
    });
  }

  return (
    <div className="flex flex-col gap-4 border-b border-[#c9b896] pb-5">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.2em] text-[#6b5c45]">
          Standardized
        </p>
        <div className="flex items-center gap-3">
          {canOfferParse && (
            <button
              type="button"
              onClick={handleParse}
              className="text-xs text-[#6b5c45] underline hover:text-[#2b2015]"
            >
              Parse into standardized fields
            </button>
          )}
          {parseStatus === "loading" && (
            <span className="text-xs text-[#6b5c45]">Parsing…</span>
          )}
          {!isEditing && (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="text-xs text-[#6b5c45] underline hover:text-[#2b2015]"
            >
              Edit identity
            </button>
          )}
        </div>
      </div>

      {parseError && <p className="text-sm text-red-600">{parseError}</p>}

      {parseStatus === "review" && (
        <div className="flex flex-col gap-3 rounded border border-[#c9b896] bg-[#fffdf8] p-3">
          <p className="text-xs text-[#6b5c45]">
            Parsed from existing facts — review before saving. The original
            fact is left untouched either way.
          </p>
          {reviewRows.map((row, i) => (
            <label key={row.key} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={row.included}
                onChange={(e) =>
                  setReviewRows((rows) =>
                    rows.map((r, idx) =>
                      idx === i ? { ...r, included: e.target.checked } : r,
                    ),
                  )
                }
                className="mt-1"
              />
              <span className="flex flex-1 flex-col gap-1">
                <span className="text-xs uppercase tracking-wide text-[#6b5c45]">
                  {row.label}
                </span>
                <input
                  value={row.value}
                  onChange={(e) =>
                    setReviewRows((rows) =>
                      rows.map((r, idx) =>
                        idx === i ? { ...r, value: e.target.value } : r,
                      ),
                    )
                  }
                  className={inputClassName}
                />
              </span>
            </label>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSaveParsed}
              disabled={isSavingParsed}
              className="rounded border border-[#c9b896] bg-[#efe6d2] px-3 py-1.5 text-sm text-[#2b2015] hover:bg-[#e3d7ba] disabled:opacity-50"
            >
              {isSavingParsed ? "Saving…" : "Save selected"}
            </button>
            <button
              type="button"
              onClick={cancelParse}
              disabled={isSavingParsed}
              className="rounded px-3 py-1.5 text-sm text-[#6b5c45] hover:text-[#2b2015]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isEditing ? (
        <form onSubmit={handleSave} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className={labelClassName}>
              First name
              <input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className={inputClassName}
              />
            </label>
            <label className={labelClassName}>
              Preferred name
              <input
                value={preferredName}
                onChange={(e) => setPreferredName(e.target.value)}
                className={inputClassName}
              />
            </label>
            <label className={labelClassName}>
              Last name
              <input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className={inputClassName}
              />
            </label>
            <label className={labelClassName}>
              Married name
              <input
                value={marriedName}
                onChange={(e) => setMarriedName(e.target.value)}
                className={inputClassName}
              />
            </label>
            <label className={labelClassName}>
              Gender
              <input
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className={inputClassName}
              />
            </label>
            <label className={labelClassName}>
              Aliases
              <input
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                className={inputClassName}
              />
            </label>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isPending}
              className="rounded border border-[#c9b896] bg-[#efe6d2] px-3 py-1.5 text-sm text-[#2b2015] hover:bg-[#e3d7ba] disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded px-3 py-1.5 text-sm text-[#6b5c45] hover:text-[#2b2015]"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Row label="First name" value={person.first_name} />
          <Row label="Preferred name" value={person.preferred_name} />
          <Row label="Last name" value={person.last_name} />
          <Row label="Married name" value={person.married_name} />
          <Row label="Gender" value={person.gender} />
          <Row label="Aliases" value={person.aliases} />
        </dl>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Row label="Birth date" value={birthDate} />
        <Row label="Birth place" value={birthPlace} />
        <Row label="Death date" value={deathDate} />
        <Row label="Death place" value={deathPlace} />
        <Row label="Cause of death" value={causeOfDeath} />
        {ageAtDeath !== null && (
          <Row label="Age at death" value={String(ageAtDeath)} />
        )}
        <Row label="Occupation" value={occupation} />
        <Row label="Places lived" value={placesLived} />
      </dl>
    </div>
  );
}

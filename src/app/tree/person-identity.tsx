"use client";

import { useState, useTransition } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import {
  updatePersonName,
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

// The parsed fields get attributed back to the ONE fact they were derived
// from, not invented as a new source — same source_type, source_ref
// noting it was parsed rather than directly transcribed, and the same
// source document. Scoped to a single fact deliberately: blending
// several facts into one parse call means a result can't be traced back
// to which one it actually came from, and — worse — the model can lift a
// detail from a fact about a genuinely different person's life (e.g. an
// ancestor mentioned in the same document set) and attribute it to this
// person instead. One fact in, one attribution out.
function deriveSourceInfo(sourceFact: Fact) {
  return {
    sourceType: sourceFact.source_type,
    sourceRef: sourceFact.source_ref
      ? `Parsed from: ${sourceFact.source_ref}`
      : "Parsed from existing fact",
    documentId: sourceFact.document_id,
  };
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
  // The one field used everywhere else in the app (tree cards, search,
  // this dossier's own header) — editing it here, alongside the
  // standardized identity fields, is what replaced family-chart's native
  // edit form as the only way to fix a typo in it.
  const [name, setName] = useState(person.name);
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
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    null,
  );
  const [isSavingParsed, startSavingParsed] = useTransition();

  function cancelEdit() {
    setIsEditing(false);
    setError(null);
    setName(person.name);
    setFirstName(person.first_name ?? "");
    setPreferredName(person.preferred_name ?? "");
    setLastName(person.last_name ?? "");
    setMarriedName(person.married_name ?? "");
    setGender(person.gender ?? "");
    setAliases(person.aliases ?? "");
  }

  function handleSave(e: { preventDefault: () => void }) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const fields: PersonIdentityFields = {
      firstName,
      preferredName,
      lastName,
      marriedName,
      gender,
      aliases,
    };
    startTransition(async () => {
      if (name.trim() !== person.name) {
        const nameResult = await updatePersonName(person.id, name);
        if (nameResult?.error) {
          setError(nameResult.error);
          return;
        }
      }
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
  const selectedCandidate =
    candidateFacts.find((f) => f.id === selectedCandidateId) ??
    candidateFacts[0] ??
    null;

  function handleParse() {
    if (!selectedCandidate) return;
    setParseStatus("loading");
    setParseError(null);
    startSavingParsed(async () => {
      const result = await parseFactsIntoStandardFields([
        { field: selectedCandidate.field, value: selectedCandidate.value },
      ]);
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
          `Nothing new found in "${selectedCandidate.field}" for the empty slots.`,
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
    if (toSave.length === 0 || !selectedCandidate) {
      cancelParse();
      return;
    }
    const { sourceType, sourceRef, documentId } = deriveSourceInfo(selectedCandidate);
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

      {canOfferParse && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[#6b5c45]">
          <span>Parse</span>
          {/* Scoped to exactly one fact at a time — see deriveSourceInfo's
              comment for why blending several facts into one parse call
              is a real correctness risk, not just a style choice. */}
          {candidateFacts.length > 1 ? (
            <select
              value={selectedCandidate?.id ?? ""}
              onChange={(e) => setSelectedCandidateId(e.target.value)}
              className="rounded border border-[#c9b896] bg-[#fffdf8] px-1.5 py-0.5 text-xs text-[#2b2015]"
            >
              {candidateFacts.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.field}
                </option>
              ))}
            </select>
          ) : (
            <span className="font-medium text-[#2b2015]">
              &quot;{selectedCandidate?.field}&quot;
            </span>
          )}
          <span>into standardized fields</span>
          <button
            type="button"
            onClick={handleParse}
            className="rounded border border-[#c9b896] bg-[#efe6d2] px-2 py-0.5 text-xs text-[#2b2015] hover:bg-[#e3d7ba]"
          >
            Parse
          </button>
        </div>
      )}
      {parseStatus === "loading" && (
        <p className="text-xs text-[#6b5c45]">Parsing…</p>
      )}

      {parseError && <p className="text-sm text-red-600">{parseError}</p>}

      {parseStatus === "review" && (
        <div className="flex flex-col gap-3 rounded border border-[#c9b896] bg-[#fffdf8] p-3">
          <p className="text-xs text-[#6b5c45]">
            Parsed from &quot;{selectedCandidate?.field}&quot; — review before
            saving. The original fact is left untouched either way.
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
          <label className={labelClassName}>
            Name (used everywhere — tree cards, search)
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className={`${inputClassName} font-medium`}
            />
          </label>
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

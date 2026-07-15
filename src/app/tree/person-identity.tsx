"use client";

import { useState, useTransition } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import { updatePersonIdentity, type PersonIdentityFields } from "./actions";

type Person = Tables<"people">;
type Fact = Tables<"facts">;

const NOT_RECORDED = "not recorded";

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

  return (
    <div className="flex flex-col gap-4 border-b border-[#c9b896] pb-5">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.2em] text-[#6b5c45]">
          Standardized
        </p>
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

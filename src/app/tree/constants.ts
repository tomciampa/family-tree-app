export const FACT_SOURCE_TYPES = [
  "document",
  "letter",
  "email",
  "chart",
  "conflict",
  "firsthand",
  "secondhand",
] as const;

// Standard slots the dossier's Facts tab standardized section (see
// person-identity.tsx) looks for by exact field name — kept in the same
// order they're displayed there. Lives here rather than in actions.ts
// because that file is "use server": every export from a "use server"
// module is treated as a server action reference on the client, which
// breaks for a plain data constant like this one (not a function).
//
// This is the ONE canonical source for these field-name strings. Every
// writer of a vital-details-shaped fact (document candidate confirmation's
// factFieldForRelation, interview extraction's fact schema) must import
// STANDARD_FIELD_LABEL/STANDARD_FIELD_LABELS from here rather than
// hardcoding its own guess at the label — three independent guesses is
// exactly how "Birth" (interview) vs "Birth Date" (this lookup) drifted
// apart and silently broke Vital Details for interview-derived facts.
export const STANDARD_FIELD_KEYS = [
  ["birthDate", "Birth Date"],
  ["birthPlace", "Birth Place"],
  ["deathDate", "Death Date"],
  ["deathPlace", "Death Place"],
  ["causeOfDeath", "Cause of Death"],
  ["occupation", "Occupation"],
  ["placesLived", "Places Lived"],
] as const;

export const STANDARD_FIELD_LABELS = STANDARD_FIELD_KEYS.map(([, label]) => label);

export const STANDARD_FIELD_LABEL = Object.fromEntries(STANDARD_FIELD_KEYS) as Record<
  (typeof STANDARD_FIELD_KEYS)[number][0],
  (typeof STANDARD_FIELD_KEYS)[number][1]
>;

export const FACT_SOURCE_TYPES = [
  "document",
  "letter",
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
export const STANDARD_FIELD_KEYS = [
  ["birthDate", "Birth Date"],
  ["birthPlace", "Birth Place"],
  ["deathDate", "Death Date"],
  ["deathPlace", "Death Place"],
  ["causeOfDeath", "Cause of Death"],
  ["occupation", "Occupation"],
  ["placesLived", "Places Lived"],
] as const;

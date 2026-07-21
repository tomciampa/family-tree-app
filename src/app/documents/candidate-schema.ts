import { z } from "zod";

// Split out from actions.ts (a "use server" file, which can only export
// async functions — not this schema object) so both document extraction
// and interview segment extraction (app/interviews/actions.ts) can import
// the exact same schema rather than each defining their own.
export const candidatePersonSchema = z.object({
  name: z.string().describe("The person's name as written in the document"),
  relation: z
    .string()
    .nullable()
    .describe(
      "This person's role in the document relative to its main subject, e.g. 'deceased', 'spouse', 'father', 'informant'",
    ),
  roleCategory: z
    .enum(["family", "administrative"])
    .describe(
      "'family' for anyone related to or personally connected with the document's subject (spouse, parent, child, sibling, etc.). 'administrative' for anyone present only in an official/procedural capacity — the informant, registrar, witness, clergy, notary, doctor who signed a certificate, etc. — who has no personal relation to the subject.",
    ),
  dates: z
    .string()
    .nullable()
    .describe("Any date(s) associated with this person in the document"),
  note: z
    .string()
    .nullable()
    .describe(
      "Any other disambiguating detail about this person, e.g. a patronymic like 'fu Luigi' (daughter of the late Luigi), a maiden name, or a place",
    ),
});

export type CandidatePerson = z.infer<typeof candidatePersonSchema>;

// Also split out (rather than left private in actions.ts) so interview
// batch confirmation (app/interviews/actions.ts) derives a fact's field
// label the exact same way document confirmation does, for whichever
// candidate person a fact/anecdote ends up attributed to.
export function factFieldForRelation(relation: string | null): string {
  if (!relation) return "Document";
  const r = relation.toLowerCase();
  if (r.includes("deceas")) return "Death";
  if (r.includes("birth") || r === "newborn") return "Birth";
  return relation.replace(/\b\w/g, (c) => c.toUpperCase());
}

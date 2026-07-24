import { generateObject } from "ai";
import { z } from "zod";
import { rankGapsByProximity, type RankedPersonGap } from "@/lib/gap-analysis";
import { classifyRelationType } from "@/lib/relation-classification";
import { INTERVIEW_PROMPTS, type InterviewPrompt } from "@/app/interviews/prompts";

// Same total length as today's fixed session — this should feel like the
// interview people already know, not a longer or more overwhelming one.
// One slot is always reserved for "Closing thoughts" (see below), so up to
// 5 slots are actually available for gap-driven or filler questions.
const TOTAL_PROMPT_COUNT = 6;
const MAX_GAP_QUESTIONS = TOTAL_PROMPT_COUNT - 1;

const CLOSING_LABEL = "Closing thoughts";

// Maps a gap's relation classification onto which *fixed* prompt topic it
// overlaps with, so that topic's generic fixed question can be dropped
// from the filler pool once a specific gap question already covers it —
// e.g. don't also ask the generic "What do you know about your
// grandparents" once Hugo and Gloria each already have their own specific
// question. Reuses classifyRelationType (documents/actions.ts) rather than
// re-deriving the same relation-string matching.
const FIXED_LABEL_BY_RELATION_TYPE: Partial<
  Record<NonNullable<ReturnType<typeof classifyRelationType>>, string>
> = {
  parent: "Parents",
  grandparent: "Grandparents",
  sibling: "Siblings",
  spouse: "Spouse",
  child: "Children",
};

// Plain templated fallback ("What do you know about Hugo, your maternal
// grandfather? We don't have much recorded about them.") — used only if
// AI generation fails or skips a specific person, never the primary path
// (see buildGapAwarePrompts's doc comment for why AI phrasing was chosen
// instead of always using this).
function templatePromptFor(gap: RankedPersonGap): string {
  return `What do you know about ${gap.personName}, your ${gap.relationToAnchor.toLowerCase()}? We don't have much recorded about them yet.`;
}

async function generateNaturalPrompts(
  gaps: RankedPersonGap[],
): Promise<Map<string, string>> {
  if (gaps.length === 0) return new Map();

  const schema = z.object({
    prompts: z
      .array(
        z.object({
          personId: z
            .string()
            .describe("Exactly one of the given person IDs — each used exactly once"),
          prompt: z
            .string()
            .describe("One warm, natural, spoken interview question for this specific person"),
        }),
      )
      .describe("One entry per person listed below, same order not required"),
  });

  try {
    const result = await generateObject({
      model: "anthropic/claude-sonnet-5",
      schema,
      messages: [
        {
          role: "user",
          content: [
            "This is a guided oral-history interview. Below is a list of specific relatives who have real, identified gaps in what's recorded about them so far.",
            "Write exactly one warm, natural, conversational interview question per person — tailored to what's actually missing about them (their name spelling, dates, places, occupation, personal memories, etc.), not a generic one-size-fits-all question. Match the tone of these existing questions from the same interview series:",
            `- "${INTERVIEW_PROMPTS[0].prompt}"`,
            `- "${INTERVIEW_PROMPTS[3].prompt}"`,
            "Never mention words like \"gap\", \"missing\", \"severity\", or \"database\" — the interviewee should just hear a natural question, never a hint that this came from a data analysis.",
            "",
            ...gaps.map(
              (g) =>
                `Person ID: ${g.personId}\nName: ${g.personName}\nRelation to the interviewee: ${g.relationToAnchor}\nWhat's missing about them: ${g.missing.join(", ")}`,
            ),
          ].join("\n\n"),
        },
      ],
    });
    return new Map(result.object.prompts.map((p) => [p.personId, p.prompt]));
  } catch {
    // Falls through to templatePromptFor per-gap below — narration failing
    // to generate should degrade the wording, never block the interview.
    return new Map();
  }
}

// Stage 3: turns Stage 2's ranked gap list into real InterviewPrompt
// objects, in the exact shape record-interview-flow.tsx already consumes
// (INTERVIEW_PROMPTS) — still no wiring into the recording flow itself,
// that's Stage 4.
//
// Phrasing: investigated both a templated approach ("What do you know
// about Hugo, your maternal grandfather? We don't have much recorded
// about them.") and AI-generated phrasing per gap, the same comparison
// made for Phase 3's interview summaries. Chose AI-generated for the same
// reason: a real session asks 3-5 of these back-to-back, and a fixed
// template repeated with just the name/relation swapped in reads
// noticeably more robotic over several questions in a row than it does as
// a single one-off line — and unlike the summary case, these are read
// aloud to the interviewee (Phase 1 narration), where flat, repetitive
// phrasing is more noticeable than in a written summary. The template is
// kept as a per-gap fallback if generation fails or skips someone, so a
// bad AI response degrades wording, never blocks the interview.
//
// Fallback rule: counts only gaps at "major" or "critical" severity
// (never "self", and never "minor") as gap-worthy — that's the same
// severity bar Stage 2 already treats as gap-worthy for ranking. If that
// count is zero (a first interview with no data yet, or a genuinely
// well-documented family), this returns INTERVIEW_PROMPTS completely
// unchanged — not a shorter or different version of it — so the feature
// can only ever help, never produce a worse or emptier interview than
// what exists today.
//
// In-between case (a few real gaps, not enough to fill a session):
// blended, not a shorter session. A session that's suddenly 2 or 3
// questions long would read as broken/incomplete to someone used to the
// existing 6-question interview, and "Closing thoughts" in particular is
// an evergreen, open-ended question with no natural gap-based
// replacement — there's no version of this feature that should ever drop
// it. So real gap questions fill as many slots as they earn (highest
// priority first, capped at MAX_GAP_QUESTIONS), and the *original* fixed
// questions fill whatever's left over — skipping any fixed topic a gap
// question already covers more specifically (see
// FIXED_LABEL_BY_RELATION_TYPE), so nobody gets asked about their
// grandparents twice in the same session. Every session still ends on
// Closing thoughts.
export async function buildGapAwarePrompts(
  intervieweePersonId: string,
): Promise<InterviewPrompt[]> {
  const ranked = await rankGapsByProximity(intervieweePersonId);

  // "self" is excluded — the whole interview is already about the
  // interviewee, so a gap-question specifically targeting them doesn't
  // fit the same "ask about a relative" shape every other prompt (fixed
  // or gap-based) has.
  const qualifying = ranked.filter(
    (g) => g.relationToAnchor !== "self" && (g.severity === "critical" || g.severity === "major"),
  );

  if (qualifying.length === 0) {
    return INTERVIEW_PROMPTS;
  }

  const selected = qualifying.slice(0, MAX_GAP_QUESTIONS);
  const naturalPrompts = await generateNaturalPrompts(selected);

  const gapPrompts: InterviewPrompt[] = selected.map((gap) => ({
    label: `${gap.personName} (${gap.relationToAnchor})`,
    prompt: naturalPrompts.get(gap.personId) ?? templatePromptFor(gap),
    gapPersonId: gap.personId,
  }));

  const coveredFixedLabels = new Set(
    selected
      .map((g) => {
        const relType = classifyRelationType(g.relationToAnchor);
        return relType ? FIXED_LABEL_BY_RELATION_TYPE[relType] : undefined;
      })
      .filter((label): label is string => !!label),
  );

  const remainingSlots = MAX_GAP_QUESTIONS - gapPrompts.length;
  const filler = INTERVIEW_PROMPTS.filter(
    (p) => p.label !== CLOSING_LABEL && !coveredFixedLabels.has(p.label),
  ).slice(0, remainingSlots);

  const closing = INTERVIEW_PROMPTS.find((p) => p.label === CLOSING_LABEL);

  return [...gapPrompts, ...filler, ...(closing ? [closing] : [])];
}

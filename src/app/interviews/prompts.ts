export type InterviewPrompt = {
  label: string;
  prompt: string;
};

// First-draft wording, ordered oldest generation first — the interviewee's
// parents (and their parents, if known) are the knowledge likeliest to be
// lost soonest, so those come before the interviewee's own generation and
// below. Expect to refine actual phrasing once real answers come back.
export const INTERVIEW_PROMPTS: InterviewPrompt[] = [
  {
    label: "Parents",
    prompt:
      "Let's start with your parents. What were their names, where were they born, what did they do for work, and is there a memory of them that stands out to you?",
  },
  {
    label: "Grandparents",
    prompt:
      "What do you know about your grandparents — their names, where they were from, or anything you remember or were told about them?",
  },
  {
    label: "Siblings",
    prompt:
      "Tell me about your siblings — who are they, and what was it like growing up together?",
  },
  {
    label: "Spouse",
    prompt:
      "Tell me about your spouse. How did the two of you meet, and what's the story of how you got together?",
  },
  {
    label: "Children",
    prompt:
      "Tell me about your children — their names, and something about each of them you'd want remembered.",
  },
  {
    label: "Closing thoughts",
    prompt:
      "Is there a story or memory of your own you've always wanted to make sure gets remembered?",
  },
];

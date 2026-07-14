import type { Tables } from "@/lib/supabase/database.types";

type Anecdote = Tables<"anecdotes">;

// See fact-list.tsx for why there are two variants sharing one component.
const THEME = {
  plain: {
    container:
      "mb-4 flex flex-col gap-3 border-b border-gray-200 pb-4 dark:border-gray-800",
    item: "border-l-2 border-gray-300 pl-3 text-sm italic text-gray-700 dark:border-gray-600 dark:text-gray-300",
    attribution: "mt-1 block text-xs not-italic text-gray-500",
    empty: null,
  },
  archival: {
    container: "flex flex-col gap-4",
    item: "border-l-2 border-[#a97b52] pl-3 text-sm italic text-[#2b2015]",
    attribution: "mt-1 block text-xs not-italic text-[#6b5c45]",
    empty: "text-sm italic text-[#6b5c45]",
  },
} as const;

export function AnecdoteList({
  anecdotes,
  theme = "plain",
}: {
  anecdotes: Anecdote[];
  theme?: keyof typeof THEME;
}) {
  const t = THEME[theme];

  if (anecdotes.length === 0) {
    return t.empty ? <p className={t.empty}>No stories recorded yet.</p> : null;
  }

  return (
    <div className={t.container}>
      {anecdotes.map((anecdote) => (
        <div key={anecdote.id} className={t.item}>
          &ldquo;{anecdote.story_text}&rdquo;
          {anecdote.who_told_it && (
            <span className={t.attribution}>
              — recorded from {anecdote.who_told_it}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

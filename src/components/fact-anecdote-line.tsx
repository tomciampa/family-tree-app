// Shared display atom for a single extracted fact/anecdote line, used by
// any review surface backed by the { people, facts, anecdotes } extraction
// shape (documents, email-notes; interview-review.tsx keeps its own
// pre-existing copy for now — see document-extraction-schema.ts's own
// comment on why this shape is shared). Previously duplicated near-
// verbatim per page (the exact drift risk this app has hit more than
// once — see the factFieldForRelation/AboutRef history) rather than
// extracted, once a document-extraction feature needed a second real
// caller beyond email-notes.
export function FactAnecdoteLine({
  included,
  already,
  label,
  children,
}: {
  included: boolean;
  already: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <p
      className={`text-[11px] ${
        already
          ? "text-[color:var(--color-text-tertiary)]"
          : included
            ? "text-[color:var(--color-text-secondary)]"
            : "text-[color:var(--color-text-tertiary)]"
      }`}
    >
      <span className="text-[color:var(--color-text-secondary)]">{label}</span> — {children}
      {already && <span className="italic"> · saved</span>}
      {!already && !included && <span className="italic"> · will be skipped for now</span>}
    </p>
  );
}

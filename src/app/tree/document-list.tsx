import { sourceBadgeClassName } from "./fact-list";

export type PersonDocument = {
  personId: string;
  id: string;
  filename: string | null;
  documentType: string | null;
  viewUrl: string | null;
};

// See fact-list.tsx for why there are two variants sharing one component.
const THEME = {
  plain: {
    container:
      "mb-4 flex flex-col gap-2 border-b border-gray-200 pb-4 dark:border-gray-800",
    heading: "text-xs font-medium uppercase tracking-wide text-gray-500",
    link: "underline hover:text-gray-500",
    badge: sourceBadgeClassName,
    empty: null,
  },
  archival: {
    container: "flex flex-col gap-3",
    heading: "text-xs font-medium uppercase tracking-wide text-[#6b5c45]",
    link: "underline decoration-[#a97b52] hover:text-[#a97b52]",
    badge:
      "rounded border border-[#c9b896] bg-[#efe6d2] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#6b5c45]",
    empty: "text-sm italic text-[#6b5c45]",
  },
} as const;

export function DocumentList({
  documents,
  theme = "plain",
  showHeading = true,
}: {
  documents: PersonDocument[];
  theme?: keyof typeof THEME;
  showHeading?: boolean;
}) {
  const t = THEME[theme];

  if (documents.length === 0) {
    return t.empty ? (
      <p className={t.empty}>No documents linked yet.</p>
    ) : null;
  }

  return (
    <div className={t.container}>
      {showHeading && <p className={t.heading}>Documents</p>}
      {documents.map((doc) => (
        <div key={doc.id} className="flex items-center justify-between gap-2 text-sm">
          {doc.viewUrl ? (
            <a
              href={doc.viewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={t.link}
            >
              {doc.filename ?? "View document"}
            </a>
          ) : (
            <span>{doc.filename ?? "Document"}</span>
          )}
          {doc.documentType && <span className={t.badge}>{doc.documentType}</span>}
        </div>
      ))}
    </div>
  );
}

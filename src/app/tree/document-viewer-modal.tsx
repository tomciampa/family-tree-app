"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getDocumentForViewer } from "./actions";
import { splitWithHighlight } from "@/lib/documents";

type ViewerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      viewUrl: string | null;
      transcriptionRaw: string | null;
      documentType: string | null;
      filename: string | null;
      kind: string | null;
    };

// A true blocking modal, not another docked pane — this is a "stop and
// look at the source" moment (verifying a fact against its actual
// document), not a workspace surface meant to sit open alongside the
// tree/dossier the way PersonDossier does. Closable via the ✕ button,
// clicking the backdrop, or Escape.
export function DocumentViewerModal({
  documentId,
  highlightText,
  onClose,
}: {
  documentId: string;
  highlightText: string | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const transcriptionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getDocumentForViewer(documentId).then((result) => {
      if (cancelled) return;
      if ("error" in result) {
        setState({ status: "error", message: result.error });
        return;
      }
      setState({ status: "ready", ...result });
    });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const transcriptionParts = useMemo(() => {
    if (state.status !== "ready") return [];
    return splitWithHighlight(state.transcriptionRaw ?? "", highlightText);
  }, [state, highlightText]);

  useEffect(() => {
    if (state.status !== "ready") return;
    transcriptionRef.current
      ?.querySelector("mark")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [state, transcriptionParts]);

  const isImage =
    state.status === "ready" && (state.documentType?.startsWith("image/") ?? false);
  const isPdf = state.status === "ready" && state.documentType === "application/pdf";

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/60 p-6 sm:p-10"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)] shadow-[var(--shadow-4)]">
        <div className="flex items-start justify-between gap-4 border-b border-[color:var(--color-border)] px-6 py-4">
          <div>
            <p className="text-[length:var(--font-size-caption)] uppercase tracking-[0.2em] text-[color:var(--color-text-secondary)]">
              Source Document
            </p>
            {/* The one thing this header exists to make instantly
                legible: is this an official record or a personal
                account? Large, bold, bordered like a stamp — deliberately
                heavier than any other text in the dossier, since reading
                it shouldn't require reading closely. */}
            <h2 className="mt-1 inline-block rounded-[var(--radius-sm)] border border-[color:var(--color-accent)] bg-[color:var(--color-accent-subtle)] px-3 py-1 text-lg font-bold uppercase tracking-wide text-[color:var(--color-accent)]">
              {state.status === "ready" ? (state.kind ?? "Document") : "…"}
            </h2>
            {state.status === "ready" && state.filename && (
              <p className="mt-1 text-[length:var(--font-size-caption)] text-[color:var(--color-text-secondary)]">{state.filename}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)]"
          >
            Close ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {state.status === "loading" && (
            <p className="text-sm text-[color:var(--color-text-secondary)]">Loading…</p>
          )}
          {state.status === "error" && (
            <p className="text-sm text-[color:var(--color-error)]">{state.message}</p>
          )}
          {state.status === "ready" && (
            <div className="flex flex-col gap-5">
              {state.viewUrl && isImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={state.viewUrl}
                  alt={state.filename ?? "Document"}
                  className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)]"
                />
              )}
              {state.viewUrl && isPdf && (
                <embed
                  src={state.viewUrl}
                  type="application/pdf"
                  className="h-[50vh] w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)]"
                />
              )}
              {state.viewUrl && !isImage && !isPdf && (
                <a
                  href={state.viewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-[color:var(--color-accent)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-accent-hover)]"
                >
                  Open original file ↗
                </a>
              )}
              {state.transcriptionRaw && (
                <div ref={transcriptionRef} className="flex flex-col gap-1">
                  <h3 className="text-[length:var(--font-size-caption)] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                    Transcription
                  </h3>
                  <pre className="whitespace-pre-wrap font-sans text-sm text-[color:var(--color-text-primary)]">
                    {transcriptionParts.map((part, i) =>
                      part.match ? (
                        <mark key={i} className="rounded-[var(--radius-xs)] bg-[color:var(--color-accent-subtle)] px-0.5 text-[color:var(--color-text-primary)]">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={i}>{part.text}</span>
                      ),
                    )}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { RecordInterviewFlow } from "./record-interview-flow";
import {
  transcribeInterviewSession,
  transcribeInterviewSegments,
  generateInterviewSummary,
  extractCandidatesFromSegment,
  matchCandidatesForSegment,
  type InterviewExtraction,
  type AboutRef,
} from "./actions";
import { DeleteInterviewButton } from "./delete-interview-button";

type Person = Tables<"people">;

export type SegmentRow = {
  id: string;
  parent_document_id: string | null;
  kind: string | null;
  audio_start_seconds: number | null;
  audio_end_seconds: number | null;
  transcription_raw: string | null;
  candidate_people: InterviewExtraction | null;
};

export type InterviewRow = {
  id: string;
  filename: string | null;
  file_path: string;
  recorded_at: string | null;
  interviewee_person_id: string | null;
  intervieweeName: string;
  playUrl: string | null;
  transcription_raw: string | null;
  interview_summary: string | null;
  segments: SegmentRow[];
};

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function InterviewsView({
  sessions,
  people,
  personSummaries,
  familyId,
  preferredVoiceURI,
  narrationEnabledDefault,
}: {
  sessions: InterviewRow[];
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  familyId: string;
  preferredVoiceURI?: string | null;
  narrationEnabledDefault?: boolean;
}) {
  const [isRecording, setIsRecording] = useState(false);
  // The session that just finished recording, so its InterviewItem knows
  // to auto-chain Transcribe → Extract → Match instead of waiting for
  // manual clicks — same pattern as documents' autoProcessIds. Only one
  // recording can finish at a time, so a single id (not a set) is enough.
  const [autoProcessId, setAutoProcessId] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {isRecording ? (
        <RecordInterviewFlow
          people={people}
          personSummaries={personSummaries}
          familyId={familyId}
          preferredVoiceURI={preferredVoiceURI}
          narrationEnabledDefault={narrationEnabledDefault}
          onCancel={() => setIsRecording(false)}
          onSaved={(documentId) => {
            setIsRecording(false);
            setAutoProcessId(documentId);
            router.refresh();
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setIsRecording(true)}
          className="rounded-[var(--radius-lg)] border-2 border-dashed border-[color:var(--color-border)] p-6 text-center text-base font-medium transition-colors duration-[var(--duration-base)] hover:border-[color:var(--color-text-tertiary)]"
        >
          🎙️ Record a memory
        </button>
      )}

      <div className="flex flex-col gap-3">
        {sessions.length === 0 && (
          <p className="text-sm text-[color:var(--color-text-secondary)]">No recordings yet.</p>
        )}
        {sessions.map((s) => (
          <InterviewItem
            key={s.id}
            session={s}
            autoProcess={s.id === autoProcessId}
          />
        ))}
      </div>
    </div>
  );
}

function InterviewItem({
  session,
  autoProcess,
}: {
  session: InterviewRow;
  autoProcess: boolean;
}) {
  const [transcript, setTranscript] = useState(session.transcription_raw);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState(session.segments);
  const [isTranscribingSegments, setIsTranscribingSegments] = useState(false);
  const [isAutoTranscribing, setIsAutoTranscribing] = useState(false);
  // Reported up by each SegmentPanel while it's running its own auto
  // extract→match chain, so this item's header can show a single combined
  // "Processing…" state that covers the whole pipeline, not just the
  // transcribe step.
  const [processingSegmentIds, setProcessingSegmentIds] = useState<
    Set<string>
  >(new Set());
  // Auto-expanded for a freshly-recorded session so the person who just
  // stopped recording can actually watch the chain run, instead of a
  // collapsed row that just says "Processing…" for up to a minute or more.
  const [isExpanded, setIsExpanded] = useState(autoProcess);
  const [summary, setSummary] = useState(session.interview_summary);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const summaryRequestedRef = useRef(false);
  const autoTranscribeTriggered = useRef(false);

  const handleSegmentProcessingChange = useCallback(
    (segmentId: string, isProcessing: boolean) => {
      setProcessingSegmentIds((prev) => {
        const next = new Set(prev);
        if (isProcessing) next.add(segmentId);
        else next.delete(segmentId);
        return next;
      });
    },
    [],
  );

  // SegmentPanel owns its own extraction state locally (updated directly by
  // its own handleExtract/handleMatch/auto-chain) and never writes back
  // into this component's `segments` state — so `segments` alone is stale
  // for "has any segment been extracted yet" the moment extraction happens
  // without an intervening full remount. Segments report in here instead,
  // seeded from whatever's already extracted at initial load.
  const [extractedSegmentIds, setExtractedSegmentIds] = useState<Set<string>>(
    () =>
      new Set(
        session.segments.filter((s) => s.candidate_people).map((s) => s.id),
      ),
  );
  const handleSegmentExtractionChange = useCallback(
    (segmentId: string, hasExtraction: boolean) => {
      setExtractedSegmentIds((prev) => {
        const next = new Set(prev);
        if (hasExtraction) next.add(segmentId);
        else next.delete(segmentId);
        return next;
      });
    },
    [],
  );

  async function runAutoTranscribe() {
    setIsAutoTranscribing(true);
    setError(null);
    const result = await transcribeInterviewSegments(session.id);
    setIsAutoTranscribing(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    const transcriptById = new Map(result.segments.map((s) => [s.id, s.transcript]));
    setSegments((prev) =>
      prev.map((seg) => ({
        ...seg,
        transcription_raw: transcriptById.get(seg.id) ?? seg.transcription_raw,
      })),
    );
  }

  useEffect(() => {
    // Guarded on there being an untranscribed segment so this only fires
    // for a genuinely fresh recording, not an older session that happens
    // to remount — those still rely on the manual buttons below. Extract
    // and Match then auto-chain per segment inside SegmentPanel itself,
    // once that segment's own transcript shows up.
    if (
      autoProcess &&
      !autoTranscribeTriggered.current &&
      segments.some((s) => !s.transcription_raw)
    ) {
      autoTranscribeTriggered.current = true;
      void runAutoTranscribe();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoProcess]);

  const isProcessingPipeline = isAutoTranscribing || processingSegmentIds.size > 0;

  async function handleTranscribe() {
    setIsTranscribing(true);
    setError(null);
    const result = await transcribeInterviewSession(session.id);
    setIsTranscribing(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setTranscript(result.transcript);
  }

  async function handleTranscribeSegments() {
    setIsTranscribingSegments(true);
    setError(null);
    const result = await transcribeInterviewSegments(session.id);
    setIsTranscribingSegments(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    const transcriptById = new Map(result.segments.map((s) => [s.id, s.transcript]));
    setSegments((prev) =>
      prev.map((seg) => ({
        ...seg,
        transcription_raw: transcriptById.get(seg.id) ?? seg.transcription_raw,
      })),
    );
  }

  const hasUntranscribedSegments = segments.some((s) => !s.transcription_raw);
  const hasExtraction = extractedSegmentIds.size > 0;

  // Backfills the one-line summary the first time this recording is fully
  // transcribed and rendered — covers both a freshly-transcribed interview
  // and an older one transcribed before Phase 3 existed, with no separate
  // manual "Generate summary" step needed either way. summaryRequestedRef
  // guards against firing twice (e.g. a second render before the request
  // resolves) — the DB-level idempotency in generateInterviewSummary itself
  // is the real backstop, this just avoids a redundant in-flight request.
  useEffect(() => {
    if (summary || summaryRequestedRef.current) return;
    if (segments.length === 0 || hasUntranscribedSegments) return;
    summaryRequestedRef.current = true;
    queueMicrotask(async () => {
      setIsSummarizing(true);
      const result = await generateInterviewSummary(session.id);
      setIsSummarizing(false);
      if (!("error" in result)) setSummary(result.summary);
    });
  }, [summary, segments.length, hasUntranscribedSegments, session.id]);

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] px-4 py-3 text-sm shadow-[var(--shadow-1)]">
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium">
          Interview with {session.intervieweeName}
        </span>
        <span className="flex items-center gap-3">
          <span className="text-xs text-[color:var(--color-text-secondary)]">
            {session.recorded_at
              ? new Date(session.recorded_at).toLocaleDateString()
              : ""}
          </span>
          {/* On this list page, deleteInterview's own revalidatePath("/interviews")
              already refreshes the list — no client-side navigation needed. */}
          <DeleteInterviewButton
            parentDocumentId={session.id}
            intervieweeName={session.intervieweeName}
            onDeleted={() => {}}
          />
        </span>
      </div>

      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="flex items-center justify-between gap-3 text-left text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
      >
        <span className="flex-1">
          {summary ??
            (isProcessingPipeline
              ? "Processing…"
              : isSummarizing
                ? "Summarizing…"
                : "Recorded conversation — click to view")}
        </span>
        <span className="shrink-0 text-xs text-[color:var(--color-text-tertiary)]">
          {isExpanded ? "▲ Hide" : "▼ Show"}
        </span>
      </button>

      {isExpanded && (
        <>
          {hasExtraction && (
            <Link
              href={`/interviews/${session.id}`}
              className="self-start text-xs font-medium text-[color:var(--color-accent)] underline transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-accent-hover)]"
            >
              Review & confirm →
            </Link>
          )}
          {session.playUrl ? (
            <audio controls preload="none" src={session.playUrl} className="w-full">
              Your browser doesn&apos;t support audio playback.
            </audio>
          ) : (
            <p className="text-xs text-[color:var(--color-error)]">
              Recording unavailable right now — try reloading the page.
            </p>
          )}

          {transcript ? (
            <p className="whitespace-pre-wrap border-t border-[color:var(--color-border-subtle)] pt-2 text-[color:var(--color-text-secondary)]">
              {transcript}
            </p>
          ) : (
            <button
              type="button"
              onClick={handleTranscribe}
              disabled={isTranscribing}
              className="self-start rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
            >
              {isTranscribing ? "Transcribing…" : "Transcribe"}
            </button>
          )}

          {segments.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-[color:var(--color-border-subtle)] pt-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                  Answers ({segments.length})
                </span>
                {hasUntranscribedSegments && (
                  <button
                    type="button"
                    onClick={handleTranscribeSegments}
                    disabled={isTranscribingSegments || isAutoTranscribing}
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
                  >
                    {isTranscribingSegments || isAutoTranscribing
                      ? "Transcribing…"
                      : "Transcribe answers"}
                  </button>
                )}
              </div>
              {segments.map((seg) => (
                <SegmentPanel
                  key={seg.id}
                  segment={seg}
                  intervieweeName={session.intervieweeName}
                  autoProcess={autoProcess}
                  onProcessingChange={handleSegmentProcessingChange}
                  onExtractionChange={handleSegmentExtractionChange}
                />
              ))}
            </div>
          )}

          {error && <p className="text-xs text-[color:var(--color-error)]">{error}</p>}
        </>
      )}
    </div>
  );
}

function aboutLabel(aboutRef: AboutRef, intervieweeName: string): string {
  if (aboutRef.type === "interviewee") return intervieweeName;
  if (aboutRef.type === "person") return aboutRef.name;
  return `${aboutRef.raw} (unresolved)`;
}

// Stage 4 scope is extraction + matching only — this shows the raw
// candidates so results can be verified, not a confirm/resolve workspace
// (that's Stage 5, same as documents/[id]/document-review.tsx was for the
// document pipeline).
function SegmentPanel({
  segment,
  intervieweeName,
  autoProcess,
  onProcessingChange,
  onExtractionChange,
}: {
  segment: SegmentRow;
  intervieweeName: string;
  autoProcess: boolean;
  onProcessingChange: (segmentId: string, isProcessing: boolean) => void;
  onExtractionChange: (segmentId: string, hasExtraction: boolean) => void;
}) {
  const [extraction, setExtraction] = useState(segment.candidate_people);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isMatching, setIsMatching] = useState(false);
  const [isAutoProcessing, setIsAutoProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTriggered = useRef(false);

  useEffect(() => {
    onProcessingChange(segment.id, isAutoProcessing);
  }, [isAutoProcessing, segment.id, onProcessingChange]);

  useEffect(() => {
    onExtractionChange(segment.id, !!extraction);
  }, [extraction, segment.id, onExtractionChange]);

  async function handleExtract() {
    setIsExtracting(true);
    setError(null);
    const result = await extractCandidatesFromSegment(segment.id);
    setIsExtracting(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setExtraction(result.extraction);
  }

  async function handleMatch() {
    setIsMatching(true);
    setError(null);
    const result = await matchCandidatesForSegment(segment.id);
    setIsMatching(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setExtraction(result.extraction);
  }

  async function runAutoProcess() {
    setError(null);
    setIsAutoProcessing(true);
    const extracted = await extractCandidatesFromSegment(segment.id);
    if ("error" in extracted) {
      setError(extracted.error);
      setIsAutoProcessing(false);
      return;
    }
    setExtraction(extracted.extraction);

    const hasFamily = extracted.extraction.people.some(
      (p) => p.roleCategory === "family",
    );
    if (hasFamily) {
      const matched = await matchCandidatesForSegment(segment.id);
      if ("error" in matched) {
        setError(matched.error);
        setIsAutoProcessing(false);
        return;
      }
      setExtraction(matched.extraction);
    }
    setIsAutoProcessing(false);
  }

  useEffect(() => {
    // Fires once this segment's own transcript shows up (written by the
    // parent InterviewItem's auto-transcribe step) — decoupled from that
    // step's own timing, so each segment starts extracting the moment its
    // transcript is ready rather than waiting for every other segment too.
    // Guarded on candidate_people being null so an older segment that
    // happens to remount never re-triggers.
    if (
      autoProcess &&
      !autoTriggered.current &&
      segment.transcription_raw &&
      !segment.candidate_people
    ) {
      autoTriggered.current = true;
      void runAutoProcess();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoProcess, segment.transcription_raw]);

  const people = extraction?.people ?? [];
  const facts = extraction?.facts ?? [];
  const anecdotes = extraction?.anecdotes ?? [];
  const hasMatches = people.some((p) => "matchStatus" in p);

  return (
    <div className="rounded-[var(--radius-sm)] bg-[color:var(--color-bg-surface-alt)] px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-[color:var(--color-text-secondary)]">
          {segment.kind ?? "Segment"}
          {segment.audio_start_seconds != null && segment.audio_end_seconds != null && (
            <span className="font-normal text-[color:var(--color-text-tertiary)]">
              {" "}
              ({formatSeconds(segment.audio_start_seconds)}–
              {formatSeconds(segment.audio_end_seconds)})
            </span>
          )}
        </p>
        {segment.transcription_raw && (
          <div className="flex items-center gap-1.5">
            {isAutoProcessing && (
              <span className="flex items-center gap-1 text-[11px] font-medium text-[color:var(--color-warning-subtle-fg)]">
                <span
                  aria-hidden
                  className="h-2 w-2 animate-spin rounded-full border-2 border-current border-t-transparent"
                />
                Processing…
              </span>
            )}
            {!extraction && (
              <button
                type="button"
                onClick={handleExtract}
                disabled={isExtracting || isAutoProcessing}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
              >
                {isExtracting ? "Extracting…" : "Extract"}
              </button>
            )}
            {extraction && !hasMatches && people.length > 0 && (
              <button
                type="button"
                onClick={handleMatch}
                disabled={isMatching || isAutoProcessing}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
              >
                {isMatching ? "Matching…" : "Match"}
              </button>
            )}
          </div>
        )}
      </div>

      {segment.transcription_raw && (
        <p className="mt-0.5 whitespace-pre-wrap text-[color:var(--color-text-secondary)]">
          {segment.transcription_raw}
        </p>
      )}

      {error && <p className="mt-1 text-[11px] text-[color:var(--color-error)]">{error}</p>}

      {extraction && (
        <div className="mt-2 flex flex-col gap-2 border-t border-[color:var(--color-border-subtle)] pt-2 text-[11px]">
          {people.length > 0 && (
            <div>
              <p className="font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">People</p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {people.map((p, i) => (
                  <li key={i}>
                    <span className="font-medium">{p.name}</span>
                    {p.relation && <span className="text-[color:var(--color-text-secondary)]"> · {p.relation}</span>}
                    {"matchStatus" in p && (
                      <span
                        className={
                          p.matchStatus === "high_confidence"
                            ? "ml-1 text-[color:var(--color-success-subtle-fg)]"
                            : p.matchStatus === "multiple_matches"
                              ? "ml-1 text-[color:var(--color-warning-subtle-fg)]"
                              : "ml-1 text-[color:var(--color-text-secondary)]"
                        }
                      >
                        {p.matchStatus === "high_confidence" && p.matches[0]
                          ? `→ matches ${p.matches[0].personName} (${Math.round(p.matches[0].score * 100)}%)`
                          : p.matchStatus === "multiple_matches"
                            ? `→ ${p.matches.length} possible matches`
                            : "→ no match (new person)"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {facts.length > 0 && (
            <div>
              <p className="font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">Facts</p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {facts.map((f, i) => (
                  <li key={i}>
                    <span className="text-[color:var(--color-text-secondary)]">{aboutLabel(f.aboutRef, intervieweeName)}</span>
                    {" — "}
                    <span className="font-medium">{f.field}:</span> {f.value}
                    {f.confidence && <span className="text-[color:var(--color-text-secondary)]"> ({f.confidence})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {anecdotes.length > 0 && (
            <div>
              <p className="font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">Anecdotes</p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {anecdotes.map((a, i) => (
                  <li key={i}>
                    <span className="text-[color:var(--color-text-secondary)]">{aboutLabel(a.aboutRef, intervieweeName)}</span>
                    {" — "}
                    {a.storyText}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

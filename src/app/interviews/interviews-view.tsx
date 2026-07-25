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
  extraction_error: string | null;
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
  // Ordered ids of segments still waiting for their auto extract→match
  // turn — only the front of this queue is ever told to run. Segments
  // used to each fire their own auto-chain the instant their transcript
  // showed up, which meant a batch transcription (writing every segment's
  // transcript in one update) fired every segment's extraction
  // concurrently. That thundering herd against the AI Gateway was the
  // real cause of a 2026-07-24 incident where 5 of 6 segments in one
  // interview silently never got extracted — only whichever segment's
  // request happened to win the race succeeded. Processing the queue one
  // id at a time, only advancing once the active segment reports settled
  // (success or failure), makes every segment get a real, isolated turn.
  const [autoQueue, setAutoQueue] = useState<string[]>([]);
  const activeAutoSegmentId = autoQueue[0] ?? null;

  const handleSegmentAutoSettled = useCallback((segmentId: string) => {
    setAutoQueue((prev) =>
      prev[0] === segmentId ? prev.slice(1) : prev.filter((id) => id !== segmentId),
    );
  }, []);

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
    // Seed the serial auto-process queue in segment order (already sorted
    // by audio_start_seconds from the initial fetch) — only segments that
    // just got a transcript and don't already have extraction results.
    setAutoQueue(
      session.segments
        .filter((seg) => transcriptById.has(seg.id) && !seg.candidate_people)
        .map((seg) => seg.id),
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
                  shouldAutoRun={autoProcess && seg.id === activeAutoSegmentId}
                  onProcessingChange={handleSegmentProcessingChange}
                  onExtractionChange={handleSegmentExtractionChange}
                  onAutoSettled={handleSegmentAutoSettled}
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
  shouldAutoRun,
  onProcessingChange,
  onExtractionChange,
  onAutoSettled,
}: {
  segment: SegmentRow;
  intervieweeName: string;
  shouldAutoRun: boolean;
  onProcessingChange: (segmentId: string, isProcessing: boolean) => void;
  onExtractionChange: (segmentId: string, hasExtraction: boolean) => void;
  onAutoSettled: (segmentId: string) => void;
}) {
  const [extraction, setExtraction] = useState(segment.candidate_people);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isMatching, setIsMatching] = useState(false);
  const [isAutoProcessing, setIsAutoProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Seeded from the DB column, not just local state — this is what makes a
  // failed segment durably distinguishable from one that was never
  // attempted: it survives a reload, unlike `error` above.
  const [extractionError, setExtractionError] = useState(segment.extraction_error);
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
      setExtractionError(result.error);
      return;
    }
    setExtraction(result.extraction);
    setExtractionError(null);
  }

  async function handleMatch() {
    setIsMatching(true);
    setError(null);
    const result = await matchCandidatesForSegment(segment.id);
    setIsMatching(false);
    if ("error" in result) {
      setError(result.error);
      setExtractionError(result.error);
      return;
    }
    setExtraction(result.extraction);
    setExtractionError(null);
  }

  // Shared by the serialized auto-chain (triggered once this segment
  // reaches the front of the parent's queue) and the manual Retry button
  // for a previously-failed segment — same one-attempt extract→match
  // sequence either way. Always reports back to the parent when it's done
  // so the queue can advance; that's a harmless no-op if this segment
  // isn't actually the queue's current entry (e.g. a manual retry).
  async function runAutoProcess() {
    setError(null);
    setIsAutoProcessing(true);
    const extracted = await extractCandidatesFromSegment(segment.id);
    if ("error" in extracted) {
      setError(extracted.error);
      setExtractionError(extracted.error);
      setIsAutoProcessing(false);
      onAutoSettled(segment.id);
      return;
    }
    setExtraction(extracted.extraction);
    setExtractionError(null);

    const hasFamily = extracted.extraction.people.some(
      (p) => p.roleCategory === "family",
    );
    if (hasFamily) {
      const matched = await matchCandidatesForSegment(segment.id);
      if ("error" in matched) {
        setError(matched.error);
        setExtractionError(matched.error);
        setIsAutoProcessing(false);
        onAutoSettled(segment.id);
        return;
      }
      setExtraction(matched.extraction);
      setExtractionError(null);
    }
    setIsAutoProcessing(false);
    onAutoSettled(segment.id);
  }

  useEffect(() => {
    // Fires once this segment reaches the front of the parent's serial
    // auto-process queue (see InterviewItem's autoQueue) — deliberately
    // one segment at a time now, not the moment each segment's own
    // transcript shows up, since firing on transcript alone is what let
    // every segment in a batch-transcribed session start extracting
    // concurrently (the actual cause of the 2026-07-24 silent-failure
    // incident). Guarded on candidate_people being null so an older
    // segment that happens to remount never re-triggers; the stale-entry
    // branch below still reports settled so the queue can't get stuck
    // behind a segment that (for whatever reason) doesn't need running.
    if (!shouldAutoRun || autoTriggered.current) return;
    autoTriggered.current = true;
    if (segment.transcription_raw && !segment.candidate_people) {
      void runAutoProcess();
    } else {
      onAutoSettled(segment.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoRun, segment.transcription_raw]);

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
            {!extraction && !extractionError && (
              <button
                type="button"
                onClick={handleExtract}
                disabled={isExtracting || isAutoProcessing}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
              >
                {isExtracting ? "Extracting…" : "Extract"}
              </button>
            )}
            {!extraction && extractionError && (
              <>
                <span className="text-[11px] font-medium text-[color:var(--color-error-subtle-fg)]">
                  Extraction failed
                </span>
                <button
                  type="button"
                  onClick={runAutoProcess}
                  disabled={isExtracting || isAutoProcessing}
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-error)] px-2 py-0.5 text-[11px] text-[color:var(--color-error)] transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-error-subtle-bg)] disabled:opacity-50"
                >
                  {isExtracting || isAutoProcessing ? "Retrying…" : "Retry"}
                </button>
              </>
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

      {(error ?? extractionError) && (
        <p className="mt-1 text-[11px] text-[color:var(--color-error)]">{error ?? extractionError}</p>
      )}

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

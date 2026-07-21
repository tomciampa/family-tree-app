"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { RecordInterviewFlow } from "./record-interview-flow";
import {
  transcribeInterviewSession,
  transcribeInterviewSegments,
  extractCandidatesFromSegment,
  matchCandidatesForSegment,
  type InterviewExtraction,
  type AboutRef,
} from "./actions";

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
}: {
  sessions: InterviewRow[];
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  familyId: string;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const router = useRouter();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {isRecording ? (
        <RecordInterviewFlow
          people={people}
          personSummaries={personSummaries}
          familyId={familyId}
          onCancel={() => setIsRecording(false)}
          onSaved={() => {
            setIsRecording(false);
            router.refresh();
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setIsRecording(true)}
          className="rounded-lg border-2 border-dashed border-gray-300 p-6 text-center text-base font-medium hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600"
        >
          🎙️ Record a memory
        </button>
      )}

      <div className="flex flex-col gap-3">
        {sessions.length === 0 && (
          <p className="text-sm text-gray-500">No recordings yet.</p>
        )}
        {sessions.map((s) => (
          <InterviewItem key={s.id} session={s} />
        ))}
      </div>
    </div>
  );
}

function InterviewItem({ session }: { session: InterviewRow }) {
  const [transcript, setTranscript] = useState(session.transcription_raw);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState(session.segments);
  const [isTranscribingSegments, setIsTranscribingSegments] = useState(false);

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

  return (
    <div className="flex flex-col gap-2 rounded border border-gray-200 px-4 py-3 text-sm dark:border-gray-800">
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium">
          Interview with {session.intervieweeName}
        </span>
        <span className="text-xs text-gray-500">
          {session.recorded_at
            ? new Date(session.recorded_at).toLocaleDateString()
            : ""}
        </span>
      </div>
      {session.playUrl ? (
        <audio controls preload="none" src={session.playUrl} className="w-full">
          Your browser doesn&apos;t support audio playback.
        </audio>
      ) : (
        <p className="text-xs text-red-500">
          Recording unavailable right now — try reloading the page.
        </p>
      )}

      {transcript ? (
        <p className="whitespace-pre-wrap border-t border-gray-100 pt-2 text-gray-700 dark:border-gray-800 dark:text-gray-300">
          {transcript}
        </p>
      ) : (
        <button
          type="button"
          onClick={handleTranscribe}
          disabled={isTranscribing}
          className="self-start rounded border border-gray-300 px-2 py-1 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
        >
          {isTranscribing ? "Transcribing…" : "Transcribe"}
        </button>
      )}

      {segments.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-gray-100 pt-2 dark:border-gray-800">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Answers ({segments.length})
            </span>
            {hasUntranscribedSegments && (
              <button
                type="button"
                onClick={handleTranscribeSegments}
                disabled={isTranscribingSegments}
                className="rounded border border-gray-300 px-2 py-1 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
              >
                {isTranscribingSegments ? "Transcribing…" : "Transcribe answers"}
              </button>
            )}
          </div>
          {segments.map((seg) => (
            <SegmentPanel key={seg.id} segment={seg} intervieweeName={session.intervieweeName} />
          ))}
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}
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
}: {
  segment: SegmentRow;
  intervieweeName: string;
}) {
  const [extraction, setExtraction] = useState(segment.candidate_people);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isMatching, setIsMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const people = extraction?.people ?? [];
  const facts = extraction?.facts ?? [];
  const anecdotes = extraction?.anecdotes ?? [];
  const hasMatches = people.some((p) => "matchStatus" in p);

  return (
    <div className="rounded bg-gray-50 px-2 py-1.5 dark:bg-gray-900/40">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
          {segment.kind ?? "Segment"}
          {segment.audio_start_seconds != null && segment.audio_end_seconds != null && (
            <span className="font-normal text-gray-400 dark:text-gray-500">
              {" "}
              ({formatSeconds(segment.audio_start_seconds)}–
              {formatSeconds(segment.audio_end_seconds)})
            </span>
          )}
        </p>
        {segment.transcription_raw && (
          <div className="flex gap-1">
            {!extraction && (
              <button
                type="button"
                onClick={handleExtract}
                disabled={isExtracting}
                className="rounded border border-gray-300 px-2 py-0.5 text-[11px] hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
              >
                {isExtracting ? "Extracting…" : "Extract"}
              </button>
            )}
            {extraction && !hasMatches && people.length > 0 && (
              <button
                type="button"
                onClick={handleMatch}
                disabled={isMatching}
                className="rounded border border-gray-300 px-2 py-0.5 text-[11px] hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
              >
                {isMatching ? "Matching…" : "Match"}
              </button>
            )}
          </div>
        )}
      </div>

      {segment.transcription_raw && (
        <p className="mt-0.5 whitespace-pre-wrap text-gray-700 dark:text-gray-300">
          {segment.transcription_raw}
        </p>
      )}

      {error && <p className="mt-1 text-[11px] text-red-500">{error}</p>}

      {extraction && (
        <div className="mt-2 flex flex-col gap-2 border-t border-gray-200 pt-2 text-[11px] dark:border-gray-800">
          {people.length > 0 && (
            <div>
              <p className="font-medium uppercase tracking-wide text-gray-500">People</p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {people.map((p, i) => (
                  <li key={i}>
                    <span className="font-medium">{p.name}</span>
                    {p.relation && <span className="text-gray-500"> · {p.relation}</span>}
                    {"matchStatus" in p && (
                      <span
                        className={
                          p.matchStatus === "high_confidence"
                            ? "ml-1 text-green-700 dark:text-green-400"
                            : p.matchStatus === "multiple_matches"
                              ? "ml-1 text-amber-700 dark:text-amber-400"
                              : "ml-1 text-gray-500"
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
              <p className="font-medium uppercase tracking-wide text-gray-500">Facts</p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {facts.map((f, i) => (
                  <li key={i}>
                    <span className="text-gray-500">{aboutLabel(f.aboutRef, intervieweeName)}</span>
                    {" — "}
                    <span className="font-medium">{f.field}:</span> {f.value}
                    {f.confidence && <span className="text-gray-500"> ({f.confidence})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {anecdotes.length > 0 && (
            <div>
              <p className="font-medium uppercase tracking-wide text-gray-500">Anecdotes</p>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {anecdotes.map((a, i) => (
                  <li key={i}>
                    <span className="text-gray-500">{aboutLabel(a.aboutRef, intervieweeName)}</span>
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

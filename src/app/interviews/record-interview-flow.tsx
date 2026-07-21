"use client";

import { useEffect, useRef, useState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { PersonSearch } from "@/components/person-search";
import { createClient } from "@/lib/supabase/client";
import { addFirstPerson } from "@/app/tree/actions";
import { createInterviewSession, createInterviewSegments } from "./actions";
import { INTERVIEW_PROMPTS } from "./prompts";

type Person = Tables<"people">;

function pickSupportedMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Step 1 (pick who's being interviewed) reuses PersonSearch — the same
// search UI the document-matching review workspace uses — plus a "create
// new person" option built the same way document-review.tsx builds one
// around it, since there's no separate combined search+create component,
// just PersonSearch shared across each caller's own thin wrapper. Step 2
// is a deliberately minimal MediaRecorder wrapper: request mic access,
// start/stop, big obvious recording indicator — the person on the other
// end of the mic is often an elderly relative, not a technical user.
export function RecordInterviewFlow({
  people,
  personSummaries,
  familyId,
  onCancel,
  onSaved,
}: {
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  familyId: string;
  onCancel: () => void;
  onSaved: (documentId: string) => void;
}) {
  const [step, setStep] = useState<"pick" | "record">("pick");

  // Step 1 state
  const [mode, setMode] = useState<"search" | "create">("search");
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [isCreatingPerson, setIsCreatingPerson] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  // Step 2 state
  const [intervieweeId, setIntervieweeId] = useState<string | null>(null);
  const [intervieweeName, setIntervieweeName] = useState<string>("");
  const [recordingStatus, setRecordingStatus] = useState<
    "idle" | "recording" | "paused" | "saving" | "error"
  >("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [promptIndex, setPromptIndex] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Mirrors of promptIndex/elapsedSeconds that recorder.onstop's closure
  // (fixed at startRecording() time) and click handlers can read
  // synchronously, plus the boundary list itself — segment start/end times
  // come from whatever the on-screen timer reads at the moment of a "Next
  // question" click or Stop, exactly as the state display shows.
  const promptIndexRef = useRef(0);
  const segmentStartRef = useRef(0);
  const segmentsRef = useRef<{ label: string; startSeconds: number; endSeconds: number }[]>([]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function handleContinueFromPick() {
    setPickError(null);
    if (mode === "search") {
      if (!selectedPersonId) {
        setPickError("Search for and select who's being interviewed.");
        return;
      }
      const person = people.find((p) => p.id === selectedPersonId);
      setIntervieweeId(selectedPersonId);
      setIntervieweeName(person?.name ?? "this person");
      setStep("record");
      return;
    }

    const trimmed = newName.trim();
    if (!trimmed) {
      setPickError("Enter a name for the new person.");
      return;
    }
    setIsCreatingPerson(true);
    const result = await addFirstPerson(trimmed);
    setIsCreatingPerson(false);
    if ("error" in result) {
      setPickError(result.error);
      return;
    }
    setIntervieweeId(result.personId);
    setIntervieweeName(trimmed);
    setStep("record");
  }

  async function startRecording() {
    setRecordError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setRecordError("Recording isn't supported in this browser.");
      setRecordingStatus("error");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        void saveRecording(mimeType || recorder.mimeType || "audio/webm");
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setElapsedSeconds(0);
      promptIndexRef.current = 0;
      segmentStartRef.current = 0;
      segmentsRef.current = [];
      setPromptIndex(0);
      timerRef.current = setInterval(() => {
        setElapsedSeconds((s) => s + 1);
      }, 1000);
      setRecordingStatus("recording");
    } catch {
      setRecordError(
        "Microphone access was denied or unavailable — please allow microphone access and try again.",
      );
      setRecordingStatus("error");
    }
  }

  function handleNextQuestion() {
    if (promptIndexRef.current >= INTERVIEW_PROMPTS.length - 1) return;
    segmentsRef.current.push({
      label: INTERVIEW_PROMPTS[promptIndexRef.current].label,
      startSeconds: segmentStartRef.current,
      endSeconds: elapsedSeconds,
    });
    segmentStartRef.current = elapsedSeconds;
    promptIndexRef.current += 1;
    setPromptIndex(promptIndexRef.current);
  }

  // MediaRecorder's own pause()/resume() excludes paused wall-clock time
  // from the encoded audio entirely (verified: a 3s-record / 5s-paused /
  // 7s-record take produced a ~10s file, not ~15s) — stopping our own
  // elapsedSeconds timer in lockstep keeps it in sync with the real
  // recording position, so segment boundaries stay accurate across a
  // pause with no extra math. For stepping away mid-session (a bathroom
  // break, a phone call) — not for resuming a session days later, which
  // is a bigger feature.
  function handlePause() {
    if (timerRef.current) clearInterval(timerRef.current);
    mediaRecorderRef.current?.pause();
    setRecordingStatus("paused");
  }

  function handleResume() {
    mediaRecorderRef.current?.resume();
    timerRef.current = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    setRecordingStatus("recording");
  }

  // For a spoken self-correction the interviewee would rather just redo
  // than leave for the transcript to sort out — moves the current
  // answer's start point up to now, so whatever was said since the last
  // boundary is simply never included in any segment's [start, end)
  // window. The audio itself isn't (can't be) trimmed — MediaRecorder has
  // no way to un-encode what's already been captured — but the abandoned
  // attempt becomes invisible to transcription/extraction either way,
  // which is what actually matters.
  function handleRedoAnswer() {
    segmentStartRef.current = elapsedSeconds;
  }

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    // Close out whichever prompt was current when Stop was pressed — the
    // same boundary mechanism "Next question" uses, just triggered by Stop
    // instead.
    segmentsRef.current.push({
      label: INTERVIEW_PROMPTS[promptIndexRef.current].label,
      startSeconds: segmentStartRef.current,
      endSeconds: elapsedSeconds,
    });
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  async function saveRecording(mimeType: string) {
    setRecordingStatus("saving");
    if (!intervieweeId) {
      setRecordError("Missing interviewee — please start over.");
      setRecordingStatus("error");
      return;
    }

    const blob = new Blob(chunksRef.current, { type: mimeType });
    const ext = extensionForMimeType(mimeType);
    const storagePath = `${familyId}/${crypto.randomUUID()}-interview.${ext}`;
    const displayName = `Interview with ${intervieweeName} — ${new Date().toLocaleDateString()}.${ext}`;

    // Uploaded directly from the browser, not through a Server Action —
    // recordings can run well past next.config.ts's 10MB Server Action
    // body limit, and the "documents" bucket already allows any
    // authenticated user to write here (same RLS policy general document
    // uploads use).
    const supabase = createClient();
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, blob, { contentType: mimeType || undefined });
    if (uploadError) {
      setRecordError(`Couldn't save the recording: ${uploadError.message}`);
      setRecordingStatus("error");
      return;
    }

    const result = await createInterviewSession({
      filePath: storagePath,
      filename: displayName,
      mimeType,
      intervieweePersonId: intervieweeId,
    });
    if ("error" in result) {
      setRecordError(`Couldn't save the recording: ${result.error}`);
      setRecordingStatus("error");
      return;
    }

    const segmentsResult = await createInterviewSegments({
      parentDocumentId: result.documentId,
      filePath: storagePath,
      mimeType,
      segments: segmentsRef.current,
    });
    if ("error" in segmentsResult) {
      // The session itself saved fine — surface this but don't block
      // finishing, since the recording (the thing that can't be redone) is
      // already safe.
      setRecordError(`Recording saved, but segments couldn't be saved: ${segmentsResult.error}`);
      setRecordingStatus("error");
      return;
    }

    onSaved(result.documentId);
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-gray-300 p-6 dark:border-gray-700">
      {step === "pick" && (
        <>
          <h2 className="text-lg font-semibold">Who&apos;s being interviewed?</h2>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="interviewee-mode"
              checked={mode === "search"}
              onChange={() => setMode("search")}
            />
            Search for an existing person
          </label>
          {mode === "search" && (
            <div className="ml-6">
              <PersonSearch
                people={people}
                personSummaries={personSummaries}
                selectedId={selectedPersonId}
                onSelect={setSelectedPersonId}
              />
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="interviewee-mode"
              checked={mode === "create"}
              onChange={() => setMode("create")}
            />
            This is a new person
          </label>
          {mode === "create" && (
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Full name"
              className="ml-6 rounded border border-gray-300 px-2 py-1 text-sm text-black dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
          )}

          {pickError && <p className="text-sm text-red-500">{pickError}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleContinueFromPick}
              disabled={isCreatingPerson}
              className="rounded border border-gray-300 px-3 py-2 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-600"
            >
              {isCreatingPerson ? "Saving…" : "Continue"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {step === "record" && (
        <>
          <h2 className="text-lg font-semibold">
            Recording an interview with {intervieweeName}
          </h2>

          {recordingStatus !== "saving" && (
            <div className="rounded border border-gray-200 bg-gray-50 p-4 text-center dark:border-gray-800 dark:bg-gray-900/40">
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Question {promptIndex + 1} of {INTERVIEW_PROMPTS.length} —{" "}
                {INTERVIEW_PROMPTS[promptIndex].label}
              </p>
              <p className="mt-1 text-lg font-medium">
                {INTERVIEW_PROMPTS[promptIndex].prompt}
              </p>
            </div>
          )}

          <div className="flex flex-col items-center gap-3 py-6">
            {recordingStatus === "recording" || recordingStatus === "paused" ? (
              <>
                <div className="flex items-center gap-3">
                  <span
                    className={`h-4 w-4 rounded-full ${
                      recordingStatus === "recording"
                        ? "animate-pulse bg-red-600"
                        : "bg-amber-500"
                    }`}
                  />
                  <span className="text-2xl font-semibold tabular-nums">
                    {formatElapsed(elapsedSeconds)}
                  </span>
                </div>
                <p className="text-sm text-gray-500">
                  {recordingStatus === "recording" ? "Recording…" : "Paused"}
                </p>
                <div className="flex flex-wrap justify-center gap-3">
                  {recordingStatus === "recording" ? (
                    <button
                      type="button"
                      onClick={handlePause}
                      className="rounded border border-gray-300 px-4 py-3 text-base font-medium hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600"
                    >
                      Pause
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleResume}
                      className="rounded bg-green-700 px-4 py-3 text-base font-medium text-white hover:bg-green-800"
                    >
                      Resume
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleRedoAnswer}
                    className="rounded border border-gray-300 px-4 py-3 text-base font-medium hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600"
                  >
                    Redo this answer
                  </button>
                  {promptIndex < INTERVIEW_PROMPTS.length - 1 && (
                    <button
                      type="button"
                      onClick={handleNextQuestion}
                      className="rounded border border-gray-300 px-4 py-3 text-base font-medium hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600"
                    >
                      Next question
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={stopRecording}
                    className="rounded bg-red-600 px-6 py-3 text-base font-medium text-white hover:bg-red-700"
                  >
                    Stop Recording
                  </button>
                </div>
              </>
            ) : recordingStatus === "saving" ? (
              <p className="text-base text-gray-500">Saving recording…</p>
            ) : (
              <button
                type="button"
                onClick={startRecording}
                className="rounded bg-green-700 px-6 py-3 text-base font-medium text-white hover:bg-green-800"
              >
                Start Recording
              </button>
            )}
          </div>

          {recordError && <p className="text-sm text-red-500">{recordError}</p>}

          <button
            type="button"
            onClick={onCancel}
            disabled={
              recordingStatus === "recording" ||
              recordingStatus === "paused" ||
              recordingStatus === "saving"
            }
            className="self-start text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50 dark:hover:text-gray-300"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

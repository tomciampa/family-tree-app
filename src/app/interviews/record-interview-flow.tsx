"use client";

import { useEffect, useRef, useState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { PersonSearch } from "@/components/person-search";
import { createClient } from "@/lib/supabase/client";
import { addFirstPerson } from "@/app/tree/actions";
import { createInterviewSession } from "./actions";

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
    "idle" | "recording" | "saving" | "error"
  >("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
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

          <div className="flex flex-col items-center gap-3 py-6">
            {recordingStatus === "recording" ? (
              <>
                <div className="flex items-center gap-3">
                  <span className="h-4 w-4 animate-pulse rounded-full bg-red-600" />
                  <span className="text-2xl font-semibold tabular-nums">
                    {formatElapsed(elapsedSeconds)}
                  </span>
                </div>
                <p className="text-sm text-gray-500">Recording…</p>
                <button
                  type="button"
                  onClick={stopRecording}
                  className="rounded bg-red-600 px-6 py-3 text-base font-medium text-white hover:bg-red-700"
                >
                  Stop Recording
                </button>
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
            disabled={recordingStatus === "recording" || recordingStatus === "saving"}
            className="self-start text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50 dark:hover:text-gray-300"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { PersonSearch } from "@/components/person-search";
import { createClient } from "@/lib/supabase/client";
import { addFirstPerson } from "@/app/tree/actions";
import { createInterviewSession, createInterviewSegments } from "./actions";
import { INTERVIEW_PROMPTS } from "./prompts";
import { getVoicesAsync, pickPreferredVoice } from "@/lib/speech-voices";

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

// Speaks a prompt aloud via the browser's built-in Web Speech API, then
// calls onDone once speech finishes — never before, so recording never
// starts/resumes while the device's own voice is still playing (it would
// otherwise bleed into the recording). Falls back to calling onDone
// immediately if speech synthesis isn't available or errors out, so
// narration failing never blocks the interview.
function speakPromptText(
  text: string,
  onDone: () => void,
  voice?: SpeechSynthesisVoice | null,
) {
  if (
    typeof window === "undefined" ||
    typeof window.speechSynthesis === "undefined" ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    onDone();
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) utterance.voice = voice;
    utterance.onend = () => onDone();
    utterance.onerror = () => onDone();
    window.speechSynthesis.speak(utterance);
  } catch {
    onDone();
  }
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
  preferredVoiceURI,
  narrationEnabledDefault,
  onCancel,
  onSaved,
}: {
  people: Person[];
  personSummaries: Record<string, PersonSummary>;
  familyId: string;
  preferredVoiceURI?: string | null;
  narrationEnabledDefault?: boolean;
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
  // True whenever a prompt is being read aloud — before the very first
  // recording start, or during the pause/resume window around advancing to
  // a new question. Recording is never running while this is true.
  const [isSpeaking, setIsSpeaking] = useState(false);
  // Whether prompts get spoken at all. Initialized from the signed-in
  // user's Settings preference, but changeable right here for this session
  // only (see the toggle below the prompt box) — the person actually being
  // interviewed is often not the account holder, so a one-off in-session
  // change shouldn't silently overwrite their saved Settings choice.
  const [narrationEnabled, setNarrationEnabled] = useState(narrationEnabledDefault ?? true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Mirrors of promptIndex that recorder.onstop's closure (fixed at
  // startRecording() time) and click handlers can read synchronously, plus
  // the boundary list itself.
  const promptIndexRef = useRef(0);
  const segmentStartRef = useRef(0);
  const segmentsRef = useRef<{ label: string; startSeconds: number; endSeconds: number }[]>([]);

  // Sub-second-precision recording clock, tracked separately from the
  // once-per-second elapsedSeconds display state — that display timer is
  // fine for the on-screen "1:23" readout, but is too coarse to use as the
  // actual stored segment boundary (a boundary can only be as precise as
  // whatever produced it, and a 1Hz integer can be off by up to ~999ms from
  // the true click instant — enough to misattribute a word at a segment
  // edge even though pause()/resume() themselves fire right on time,
  // verified separately). preciseElapsedRef holds accumulated *actively
  // recording* seconds as of the last freeze; activeSinceRef holds the
  // performance.now() timestamp recording last (re)started, or null while
  // paused/not yet started — mirroring exactly when pause()/resume() are
  // actually called, narration gaps included.
  const preciseElapsedRef = useRef(0);
  const activeSinceRef = useRef<number | null>(null);

  function getPreciseElapsedSeconds(): number {
    if (activeSinceRef.current === null) return preciseElapsedRef.current;
    return preciseElapsedRef.current + (performance.now() - activeSinceRef.current) / 1000;
  }

  // Call immediately before every mediaRecorder.pause() (manual pause,
  // narration-wait pause, or final stop) so the frozen total lines up with
  // the instant capture actually halts.
  function freezeElapsedTracking(): number {
    const elapsed = getPreciseElapsedSeconds();
    preciseElapsedRef.current = elapsed;
    activeSinceRef.current = null;
    return elapsed;
  }

  // Call immediately after every mediaRecorder.start()/resume().
  function resumeElapsedTracking() {
    activeSinceRef.current = performance.now();
  }

  // Speaks a prompt if narration is on, otherwise calls onDone immediately
  // — the single place that decides whether there's anything to wait for.
  // Every call site (start/next-question/repeat) goes through this rather
  // than calling speakPromptText directly, so "narration off" only has to
  // be handled once.
  function narrateOrSkip(text: string, onDone: () => void) {
    if (!narrationEnabled) {
      onDone();
      return;
    }
    setIsSpeaking(true);
    speakPromptText(
      text,
      () => {
        setIsSpeaking(false);
        onDone();
      },
      voiceRef.current,
    );
  }

  // Shared by handleNextQuestion's two branches (narration on/off) — the
  // boundary bookkeeping itself doesn't depend on whether anything gets
  // spoken, only on what precise-elapsed value gets passed in.
  function pushSegmentBoundary(boundary: number) {
    segmentsRef.current.push({
      label: INTERVIEW_PROMPTS[promptIndexRef.current].label,
      startSeconds: segmentStartRef.current,
      endSeconds: boundary,
    });
    segmentStartRef.current = boundary;
  }

  // Resolved once up front (voices can take a moment to load — see
  // getVoicesAsync) rather than re-fetched before every single prompt, so
  // narration doesn't stall waiting on the voice list mid-interview.
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    let cancelled = false;
    getVoicesAsync().then((voices) => {
      if (cancelled) return;
      voiceRef.current = pickPreferredVoice(voices, preferredVoiceURI);
    });
    return () => {
      cancelled = true;
    };
  }, [preferredVoiceURI]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
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
      mediaRecorderRef.current = recorder;
      setElapsedSeconds(0);
      promptIndexRef.current = 0;
      segmentStartRef.current = 0;
      segmentsRef.current = [];
      preciseElapsedRef.current = 0;
      activeSinceRef.current = null;
      setPromptIndex(0);

      // Don't start capturing yet if narration is on — read the first
      // prompt aloud first, and only start the recorder once narration
      // finishes, so the narration itself is never captured in the
      // recording. With narration off there's nothing to wait for, so
      // capture starts immediately.
      narrateOrSkip(INTERVIEW_PROMPTS[0].prompt, () => {
        recorder.start();
        resumeElapsedTracking();
        timerRef.current = setInterval(() => {
          setElapsedSeconds((s) => s + 1);
        }, 1000);
        setRecordingStatus("recording");
      });
    } catch {
      setRecordError(
        "Microphone access was denied or unavailable — please allow microphone access and try again.",
      );
      setRecordingStatus("error");
    }
  }

  function handleNextQuestion() {
    if (promptIndexRef.current >= INTERVIEW_PROMPTS.length - 1) return;

    // With narration off there's nothing to pause the recorder for — the
    // boundary is just the live precise-clock reading (no freeze needed,
    // since recording never actually stops), and the next prompt's
    // capture continues immediately with no gap at all.
    if (!narrationEnabled) {
      pushSegmentBoundary(getPreciseElapsedSeconds());
      promptIndexRef.current += 1;
      setPromptIndex(promptIndexRef.current);
      return;
    }

    // Freeze the precise clock right alongside the actual pause() call
    // below (not the 1Hz display timer) so the stored boundary matches the
    // true instant capture stops, down to sub-second precision.
    pushSegmentBoundary(freezeElapsedTracking());
    promptIndexRef.current += 1;
    setPromptIndex(promptIndexRef.current);

    // Same pause()/resume() mechanism as the manual Pause/Resume controls
    // below — pause while the new prompt is read aloud, then resume once
    // narration finishes, so segment boundaries and the elapsed timer stay
    // in lockstep with what's actually being encoded.
    if (timerRef.current) clearInterval(timerRef.current);
    mediaRecorderRef.current?.pause();
    narrateOrSkip(INTERVIEW_PROMPTS[promptIndexRef.current].prompt, () => {
      mediaRecorderRef.current?.resume();
      resumeElapsedTracking();
      timerRef.current = setInterval(() => {
        setElapsedSeconds((s) => s + 1);
      }, 1000);
    });
  }

  // "Repeat question" doesn't advance the prompt or touch segment
  // boundaries — it just re-reads whatever prompt is currently showing. If
  // actively recording, pause/resume around it the same way advancing does;
  // if the user had already paused manually, leave that pause alone (don't
  // auto-resume just because narration finished) — and if recording hasn't
  // started yet, there's nothing to pause. A no-op when narration is off
  // (the button itself is hidden in that case — there's nothing to repeat
  // aloud), kept as a defensive guard rather than relied on.
  function handleRepeatQuestion() {
    if (!narrationEnabled) return;
    const text = INTERVIEW_PROMPTS[promptIndexRef.current]?.prompt;
    if (!text) return;
    if (recordingStatus === "recording") {
      freezeElapsedTracking();
      if (timerRef.current) clearInterval(timerRef.current);
      mediaRecorderRef.current?.pause();
      narrateOrSkip(text, () => {
        mediaRecorderRef.current?.resume();
        resumeElapsedTracking();
        timerRef.current = setInterval(() => {
          setElapsedSeconds((s) => s + 1);
        }, 1000);
      });
    } else {
      narrateOrSkip(text, () => {});
    }
  }

  // MediaRecorder's own pause()/resume() excludes paused wall-clock time
  // from the encoded audio entirely (verified: a 3s-record / 5s-paused /
  // 7s-record take produced a ~10s file, not ~15s) — freezing/resuming our
  // own precise clock in lockstep keeps it in sync with the real recording
  // position, so segment boundaries stay accurate across a pause with no
  // extra math. For stepping away mid-session (a bathroom break, a phone
  // call) — not for resuming a session days later, which is a bigger
  // feature.
  function handlePause() {
    freezeElapsedTracking();
    if (timerRef.current) clearInterval(timerRef.current);
    mediaRecorderRef.current?.pause();
    setRecordingStatus("paused");
  }

  function handleResume() {
    mediaRecorderRef.current?.resume();
    resumeElapsedTracking();
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
    segmentStartRef.current = getPreciseElapsedSeconds();
  }

  function stopRecording() {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setIsSpeaking(false);
    if (timerRef.current) clearInterval(timerRef.current);
    // Close out whichever prompt was current when Stop was pressed — the
    // same boundary mechanism "Next question" uses, just triggered by Stop
    // instead.
    const boundary = freezeElapsedTracking();
    segmentsRef.current.push({
      label: INTERVIEW_PROMPTS[promptIndexRef.current].label,
      startSeconds: segmentStartRef.current,
      endSeconds: boundary,
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
    <div className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface)] p-6 font-[family-name:var(--font-family-base)] text-[color:var(--color-text-primary)] shadow-[var(--shadow-2)]">
      {step === "pick" && (
        <>
          <h2 className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
            Who&apos;s being interviewed?
          </h2>

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
              className="ml-6 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-page)] px-2 py-1 text-sm text-[color:var(--color-text-primary)]"
            />
          )}

          {pickError && <p className="text-sm text-[color:var(--color-error)]">{pickError}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleContinueFromPick}
              disabled={isCreatingPerson}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-2 text-sm transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
            >
              {isCreatingPerson ? "Saving…" : "Continue"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-[var(--radius-sm)] px-3 py-2 text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)]"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {step === "record" && (
        <>
          <h2 className="text-[length:var(--font-size-heading-3)] leading-[var(--line-height-heading-3)] font-semibold">
            Recording an interview with {intervieweeName}
          </h2>

          {/* A visible override for whoever's actually being interviewed to
              flip in the moment, without needing to leave for Settings —
              this only changes narration for this recording session, it
              never overwrites the signed-in user's saved preference. */}
          <label className="flex items-center gap-2 self-start text-sm text-[color:var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={narrationEnabled}
              onChange={(e) => setNarrationEnabled(e.target.checked)}
            />
            🔊 Read questions aloud
          </label>

          {recordingStatus !== "saving" && (
            <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-bg-surface-alt)] p-4 text-center">
              <p className="text-xs uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                Question {promptIndex + 1} of {INTERVIEW_PROMPTS.length} —{" "}
                {INTERVIEW_PROMPTS[promptIndex].label}
              </p>
              <p className="mt-1 text-lg font-medium">
                {INTERVIEW_PROMPTS[promptIndex].prompt}
              </p>
              {narrationEnabled && (
                <button
                  type="button"
                  onClick={handleRepeatQuestion}
                  disabled={isSpeaking}
                  className="mt-2 text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)] disabled:opacity-50"
                >
                  🔊 Repeat question
                </button>
              )}
            </div>
          )}

          <div className="flex flex-col items-center gap-3 py-6">
            {recordingStatus === "recording" || recordingStatus === "paused" ? (
              <>
                <div className="flex items-center gap-3">
                  <span
                    className={`h-4 w-4 rounded-full ${
                      isSpeaking
                        ? "bg-[color:var(--color-text-secondary)]"
                        : recordingStatus === "recording"
                          ? "animate-pulse bg-[color:var(--color-error)]"
                          : "bg-[color:var(--color-warning)]"
                    }`}
                  />
                  <span className="text-2xl font-semibold tabular-nums">
                    {formatElapsed(elapsedSeconds)}
                  </span>
                </div>
                <p className="text-sm text-[color:var(--color-text-secondary)]">
                  {isSpeaking
                    ? "🔊 Speaking question…"
                    : recordingStatus === "recording"
                      ? "Recording…"
                      : "Paused"}
                </p>
                <div className="flex flex-wrap justify-center gap-3">
                  {recordingStatus === "recording" ? (
                    <button
                      type="button"
                      onClick={handlePause}
                      disabled={isSpeaking}
                      className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-4 py-3 text-base font-medium transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
                    >
                      Pause
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleResume}
                      disabled={isSpeaking}
                      className="rounded-[var(--radius-sm)] bg-[color:var(--color-success)] px-4 py-3 text-base font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:opacity-90 disabled:opacity-50"
                    >
                      Resume
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleRedoAnswer}
                    disabled={isSpeaking}
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-4 py-3 text-base font-medium transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
                  >
                    Redo this answer
                  </button>
                  {promptIndex < INTERVIEW_PROMPTS.length - 1 && (
                    <button
                      type="button"
                      onClick={handleNextQuestion}
                      disabled={isSpeaking}
                      className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-4 py-3 text-base font-medium transition-colors duration-[var(--duration-base)] hover:bg-[color:var(--color-bg-surface-hover)] disabled:opacity-50"
                    >
                      Next question
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={stopRecording}
                    className="rounded-[var(--radius-sm)] bg-[color:var(--color-error)] px-6 py-3 text-base font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:opacity-90"
                  >
                    Stop Recording
                  </button>
                </div>
              </>
            ) : recordingStatus === "saving" ? (
              <p className="text-base text-[color:var(--color-text-secondary)]">Saving recording…</p>
            ) : isSpeaking ? (
              <p className="text-base text-[color:var(--color-text-secondary)]">🔊 Speaking question…</p>
            ) : (
              <button
                type="button"
                onClick={startRecording}
                className="rounded-[var(--radius-sm)] bg-[color:var(--color-success)] px-6 py-3 text-base font-medium text-[color:var(--color-text-on-accent)] transition-colors duration-[var(--duration-base)] hover:opacity-90"
              >
                Start Recording
              </button>
            )}
          </div>

          {recordError && <p className="text-sm text-[color:var(--color-error)]">{recordError}</p>}

          <button
            type="button"
            onClick={onCancel}
            disabled={
              recordingStatus === "recording" ||
              recordingStatus === "paused" ||
              recordingStatus === "saving" ||
              isSpeaking
            }
            className="self-start text-sm text-[color:var(--color-text-secondary)] transition-colors duration-[var(--duration-base)] hover:text-[color:var(--color-text-primary)] disabled:opacity-50"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

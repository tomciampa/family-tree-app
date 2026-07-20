"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Tables } from "@/lib/supabase/database.types";
import type { PersonSummary } from "@/lib/family";
import { RecordInterviewFlow } from "./record-interview-flow";

type Person = Tables<"people">;

export type InterviewRow = {
  id: string;
  filename: string | null;
  file_path: string;
  recorded_at: string | null;
  interviewee_person_id: string | null;
  intervieweeName: string;
  playUrl: string | null;
};

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
          <div
            key={s.id}
            className="flex flex-col gap-2 rounded border border-gray-200 px-4 py-3 text-sm dark:border-gray-800"
          >
            <div className="flex items-center justify-between gap-4">
              <span className="font-medium">
                Interview with {s.intervieweeName}
              </span>
              <span className="text-xs text-gray-500">
                {s.recorded_at
                  ? new Date(s.recorded_at).toLocaleDateString()
                  : ""}
              </span>
            </div>
            {s.playUrl ? (
              <audio controls preload="none" src={s.playUrl} className="w-full">
                Your browser doesn&apos;t support audio playback.
              </audio>
            ) : (
              <p className="text-xs text-red-500">
                Recording unavailable right now — try reloading the page.
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
